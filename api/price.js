// Vercel serverless function (plain Node, no framework) — GET /api/price?url=<encoded product URL>
//
// Why this exists: bom-worksheet.html's Unit Cost auto-fill needs a part's price, but that price
// only exists on the *rendered* page (confirmed: a plain fetch of a McMaster product URL returns
// a full 200 OK page with zero price data in the HTML — it's loaded via a private client-side API
// call after the page's own JS runs, so this isn't fixable by changing where the fetch comes
// from). The only way to reach it is to actually render the page's JS, same as a real browser —
// hence a headless Chromium instance running inside this function.
//
// Response shape, always one of:
//   { ok: true,  price: "8.42" }
//   { ok: false, reason: "unsupported_domain" | "timeout" | "not_found" | "blocked" | "error" }
// Never throws an unhandled error back to the client.
'use strict';

// Same short list bom-worksheet.html's SUPPLIER_DOMAINS keys off of, duplicated here on purpose —
// this is the abuse guard that keeps this endpoint from becoming an arbitrary fetch-and-render
// proxy for any URL a caller feels like sending it. Keep these two lists in sync if either grows.
const ALLOWED_DOMAINS = [
  'mcmaster.com',
  'digikey.com',
  'mouser.com',
  'adafruit.com',
  'sparkfun.com',
  'grainger.com',
  'onlinemetals.com'
];

// Same 3-tier heuristic as the bookmarklet this replaces (bom-worksheet.html's old
// PRICE_BOOKMARKLET_SRC): schema.org JSON-LD price first (most reliable when present), then the
// first "$X.XX" near anything labeled "price", then the first "$X.XX" anywhere on the page.
// Runs inside the page via page.evaluate() against the fully-rendered DOM, not the raw HTML.
function findPriceInPage() {
  try {
    var scripts = document.getElementsByTagName('script');
    var ldjson = [];
    for (var si = 0; si < scripts.length; si++) {
      if ((scripts[si].getAttribute('type') || '').toLowerCase() === 'application/ld+json') ldjson.push(scripts[si]);
    }
    var walk = function (n) {
      if (!n || typeof n !== 'object') return null;
      if (Array.isArray(n)) { for (var i = 0; i < n.length; i++) { var r = walk(n[i]); if (r) return r; } return null; }
      if (n.price != null && !isNaN(parseFloat(n.price))) return parseFloat(n.price).toFixed(2);
      if (n.priceSpecification) { var r2 = walk(n.priceSpecification); if (r2) return r2; }
      if (n.offers) { var r3 = walk(n.offers); if (r3) return r3; }
      for (var k in n) { if (Object.prototype.hasOwnProperty.call(n, k)) { var v = walk(n[k]); if (v) return v; } }
      return null;
    };
    for (var i = 0; i < ldjson.length; i++) {
      var data; try { data = JSON.parse(ldjson[i].textContent); } catch (e) { continue; }
      var found = walk(data);
      if (found) return found;
    }
  } catch (e) {}
  try {
    var re = /\$\s?\d[\d,]*\.\d{2}/;
    var cands = document.querySelectorAll("[class*='price' i],[id*='price' i]");
    for (var j = 0; j < cands.length; j++) {
      var m = (cands[j].textContent || '').match(re);
      if (m) return m[0].replace(/[$,\s]/g, '');
    }
  } catch (e) {}
  try {
    var re2 = /\$\s?\d[\d,]*\.\d{2}/;
    var m2 = (document.body.innerText || document.body.textContent || '').match(re2);
    if (m2) return m2[0].replace(/[$,\s]/g, '');
  } catch (e) {}
  return null;
}

function isAllowedDomain(hostname) {
  var host = hostname.toLowerCase().replace(/^www\./, '');
  return ALLOWED_DOMAINS.some(function (d) { return host === d || host.endsWith('.' + d); });
}

// Cached across warm invocations of the same function instance — only the first request per
// container pays the download+extract cost of the chromium-pack.tar this repo's postinstall
// step produces (see scripts/make-chromium-pack.js).
let cachedExecutablePath = null;
let downloadPromise = null;

async function getExecutablePath(chromium, req) {
  if (cachedExecutablePath) return cachedExecutablePath;
  if (!downloadPromise) {
    const host = process.env.VERCEL_URL || req.headers.host;
    const packUrl = `https://${host}/chromium-pack.tar`;
    downloadPromise = chromium.executablePath(packUrl)
      .then((p) => { cachedExecutablePath = p; return p; })
      .catch((err) => { downloadPromise = null; throw err; });
  }
  return downloadPromise;
}

module.exports = async (req, res) => {
  const rawUrl = req.query && req.query.url;
  if (!rawUrl || typeof rawUrl !== 'string') {
    res.status(400).json({ ok: false, reason: 'error' });
    return;
  }

  let target;
  try {
    target = new URL(rawUrl);
    if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('bad protocol');
  } catch (e) {
    res.status(400).json({ ok: false, reason: 'error' });
    return;
  }

  if (!isAllowedDomain(target.hostname)) {
    res.status(200).json({ ok: false, reason: 'unsupported_domain' });
    return;
  }

  let browser = null;
  try {
    const chromium = require('@sparticuz/chromium-min');
    const puppeteer = require('puppeteer-core');
    const executablePath = await getExecutablePath(chromium, req);

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();

    let navigationFailed = false;
    try {
      await page.goto(target.toString(), { waitUntil: 'domcontentloaded', timeout: 6000 });
    } catch (e) {
      navigationFailed = true;
    }

    if (navigationFailed) {
      res.status(200).json({ ok: false, reason: 'timeout' });
      return;
    }

    // Short, bounded wait for price-bearing content to show up after the page's own JS runs —
    // deliberately not the whole remaining time budget, so a slow/blocked page fails fast
    // instead of eating the function's 10-second ceiling (this project is on Vercel's free
    // Hobby plan, which hard-caps function duration at 10s with no way to raise it).
    try {
      await page.waitForFunction(
        `(${findPriceInPage.toString()})() !== null`,
        { timeout: 3000 }
      );
    } catch (e) {
      // Not found within the budget isn't necessarily "blocked" — the page may just genuinely
      // not have a detectable price. Still try one real extraction below before giving up.
    }

    const price = await page.evaluate(findPriceInPage);

    if (price) {
      res.status(200).json({ ok: true, price: price });
    } else {
      res.status(200).json({ ok: false, reason: 'not_found' });
    }
  } catch (err) {
    const message = (err && err.message) || '';
    const looksBlocked = /403|forbidden|blocked|captcha/i.test(message);
    res.status(200).json({ ok: false, reason: looksBlocked ? 'blocked' : 'error' });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
};
