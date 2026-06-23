// Verifies the live Hunt review favicon end-to-end in a clean (no-cache) Chrome.
// Run: NODE_PATH="<npx playwright node_modules>" node scripts/verify_favicon.js
// Proves a fresh browser resolves + fetches the tab favicon, independent of any
// stale local favicon cache. Leaves a screenshot of the rendered icon for review.
const { chromium } = require('playwright');

const SITE = 'https://agent-hunt-review.mshi.ca/';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext(); // fresh, empty cache
  const page = await context.newPage();

  const favReqs = [];
  page.on('response', (r) => {
    const u = r.url();
    if (/favicon|hunt-icon/i.test(u)) favReqs.push(`${r.status()} ${u}`);
  });

  await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });

  // What the document declares as its icon links.
  const links = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]',
    (els) => els.map((e) => ({ rel: e.getAttribute('rel'), type: e.getAttribute('type'), href: e.href })));

  // Resolve the SVG icon Chrome prefers and fetch it in-page.
  const svg = links.find((l) => (l.type || '').includes('svg')) || links[0];
  const fetched = await page.evaluate(async (href) => {
    const res = await fetch(href, { cache: 'no-store' });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type'), len: text.length, isSvg: text.trim().startsWith('<svg') };
  }, svg.href);

  // Visually confirm the icon renders (navigate straight to it and screenshot).
  await page.goto(svg.href, { waitUntil: 'load', timeout: 15000 });
  const shot = 'scripts/_favicon_rendered.png';
  await page.screenshot({ path: shot });

  console.log('DECLARED ICON LINKS:');
  for (const l of links) console.log(`  rel=${l.rel} type=${l.type} -> ${l.href}`);
  console.log('FAVICON NETWORK REQUESTS DURING PAGE LOAD:');
  if (favReqs.length === 0) console.log('  (none auto-requested in headless; fetch check below is authoritative)');
  for (const r of favReqs) console.log('  ' + r);
  console.log('PRIMARY SVG FETCH:', JSON.stringify(fetched));
  console.log('RENDERED SCREENSHOT:', shot);
  console.log('RESULT:', (fetched.status === 200 && fetched.isSvg) ? 'PASS - clean browser resolves a valid SVG favicon' : 'FAIL');

  await browser.close();
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
