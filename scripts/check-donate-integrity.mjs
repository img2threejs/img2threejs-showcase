import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const donatePath = path.join(root, 'public', 'donate.html');
const qrPath = path.join(root, 'public', 'momo-qr.png');
const cryptoQrPath = path.join(root, 'public', 'binance-pay-qr.png');
const sitemapPath = path.join(root, 'public', 'sitemap.xml');

const EXPECTED_QR_SHA256 = '854da1fbf588673f620998233427d118e499a1c9da4c20f0ddc1fc9352b540c9';
const EXPECTED_CRYPTO_QR_SHA256 = '8f285822e4dc9edfaf5b7f857dc369541abe2ef8ce8fcf0f5f50dea13ce010e4';
const PAYPAL_URL = 'https://www.paypal.com/paypalme/NguyenHoai545';
const KOFI_URL = 'https://ko-fi.com/iamnick';
const KOFI_QR_URL = 'https://storage.ko-fi.com/cdn/useruploads/O8A625YLSR/qrcode.png?v=635ec747-2db3-4f66-ab06-cca530f75325';
const BINANCE_PAY_URL = 'https://app.binance.com/uni-qr/Trcs9shL';
const DONATE_URL = 'https://img2threejs.io/donate.html';
const EXPECTED_HOSTS = ['img2threejs.io', 'www.img2threejs.io'];

const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
}

function openingTag(html, element, attribute, value) {
  const tags = html.match(new RegExp('<' + element + '\\b[^>]*>', 'gi')) || [];
  const attributePattern = new RegExp("\\b" + attribute + "=[\"']" + escapeRegExp(value) + "[\"']", 'i');
  return tags.find((tag) => attributePattern.test(tag));
}

function hasAttribute(tag, name, value) {
  return new RegExp("\\b" + name + "=[\"']" + escapeRegExp(value) + "[\"']", 'i').test(tag || '');
}

function valuesEqual(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

let donateHtml;
let sitemap;
let qr;
let cryptoQr;

try {
  [donateHtml, sitemap, qr, cryptoQr] = await Promise.all([
    readFile(donatePath, 'utf8'),
    readFile(sitemapPath, 'utf8'),
    readFile(qrPath),
    readFile(cryptoQrPath),
  ]);
} catch (error) {
  console.error('Donate integrity check could not read a required file: ' + error.message);
  process.exit(1);
}

const visibleHtml = donateHtml
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '');

check(
  /<p\b[^>]*class=["']payee-name["'][^>]*>\s*Nguyễn Hoài Nhớ\s*<\/p>/i.test(visibleHtml),
  'Payee must remain Nguyễn Hoài Nhớ in the visible payment details.',
);
for (const term of ['MoMo', 'VietQR', 'napas 247', 'any Vietnamese bank app']) {
  check(visibleHtml.includes(term), 'Required visible local payment copy is missing: ' + term);
}
check(visibleHtml.includes('Apache 2.0'), 'The page must visibly state that img2threejs is Apache 2.0.');

const localQrTag = openingTag(donateHtml, 'img', 'src', 'momo-qr.png');
check(Boolean(localQrTag), 'The local donation QR must use public/momo-qr.png.');
check(
  !hasAttribute(localQrTag, 'data-support-channel', 'paypal')
    && !hasAttribute(localQrTag, 'data-support-channel', 'kofi'),
  'The local QR must not be marked as an outbound analytics link.',
);

const qrHash = createHash('sha256').update(qr).digest('hex');
check(
  qrHash === EXPECTED_QR_SHA256,
  'public/momo-qr.png SHA-256 changed: expected ' + EXPECTED_QR_SHA256 + ', received ' + qrHash + '.',
);

for (const term of ['Crypto', 'Binance Pay', 'Img2Threejs']) {
  check(visibleHtml.includes(term), 'Required visible crypto payment copy is missing: ' + term);
}
check(!visibleHtml.includes('Nho podium'), 'The previous Binance nickname must not remain visible.');
const cryptoQrTag = openingTag(donateHtml, 'img', 'src', 'binance-pay-qr.png');
check(Boolean(cryptoQrTag), 'The crypto donation QR must use public/binance-pay-qr.png.');
check(hasAttribute(cryptoQrTag, 'loading', 'lazy'), 'The Binance Pay QR must remain lazy-loaded.');
check(
  !hasAttribute(cryptoQrTag, 'data-support-channel', 'paypal')
    && !hasAttribute(cryptoQrTag, 'data-support-channel', 'kofi'),
  'The Binance Pay QR must not be marked as an outbound analytics link.',
);
const binancePayTag = openingTag(donateHtml, 'a', 'href', BINANCE_PAY_URL);
check(Boolean(binancePayTag), 'The crypto QR must open the Binance Pay link encoded in the image.');
check(hasAttribute(binancePayTag, 'target', '_blank'), 'The Binance Pay link must open in a new tab.');
const cryptoQrHash = createHash('sha256').update(cryptoQr).digest('hex');
check(
  cryptoQrHash === EXPECTED_CRYPTO_QR_SHA256,
  'public/binance-pay-qr.png SHA-256 changed: expected '
    + EXPECTED_CRYPTO_QR_SHA256 + ', received ' + cryptoQrHash + '.',
);

const paypalTag = openingTag(donateHtml, 'a', 'href', PAYPAL_URL);
const kofiTag = openingTag(donateHtml, 'a', 'href', KOFI_URL);
for (const [name, tag, channel] of [
  ['PayPal', paypalTag, 'paypal'],
  ['Ko-fi', kofiTag, 'kofi'],
]) {
  check(Boolean(tag), name + ' support link is missing or has changed.');
  check(hasAttribute(tag, 'data-support-channel', channel), name + ' link must keep analytics channel ' + channel + '.');
  check(hasAttribute(tag, 'target', '_blank'), name + ' link must open in a separate tab.');
  check(
    /\brel=["'][^"']*\bnoopener\b[^"']*\bnoreferrer\b[^"']*["']/i.test(tag || ''),
    name + ' link must retain rel="noopener noreferrer".',
  );
}

const supportHrefs = (donateHtml.match(/<a\b[^>]*>/gi) || [])
  .map((tag) => (tag.match(/\bhref=["']([^"']+)["']/i) || [])[1])
  .filter((href) => href && (href.includes('paypal.com') || href.includes('ko-fi.com')));
check(
  valuesEqual(supportHrefs, [PAYPAL_URL, KOFI_URL]),
  'The only PayPal and Ko-fi anchors must be the approved support URLs.',
);

const kofiQrTag = openingTag(donateHtml, 'img', 'src', KOFI_QR_URL);
check(Boolean(kofiQrTag), 'The Ko-fi QR URL is missing or has changed.');
check(hasAttribute(kofiQrTag, 'loading', 'lazy'), 'The Ko-fi QR must remain lazy-loaded.');
check(hasAttribute(kofiQrTag, 'referrerpolicy', 'no-referrer'), 'The Ko-fi QR must retain a no-referrer policy.');

const homeTags = [...donateHtml.matchAll(/<a\b[^>]*\bdata-home-link\b[^>]*>/gi)].map((match) => match[0]);
check(homeTags.length >= 1, 'A marked Back to img2threejs link is required.');
check(
  homeTags.every((tag) => /\bhref=["']\.\/["']/i.test(tag)),
  'Every marked home link must point back to ./',
);
const privacyTag = (donateHtml.match(/<a\b[^>]*\bdata-privacy-link\b[^>]*>/i) || [])[0];
check(
  Boolean(privacyTag) && /\bhref=["']\.\/#\/privacy["']/i.test(privacyTag),
  'The donation page must link to the privacy and analytics route.',
);

check(
  /<link\b(?=[^>]*\brel=["']canonical["'])(?=[^>]*\bhref=["']https:\/\/img2threejs\.io\/donate\.html["'])[^>]*>/i.test(donateHtml),
  'Canonical URL must be https://img2threejs.io/donate.html.',
);
check(
  /<meta\b(?=[^>]*\bproperty=["']og:url["'])(?=[^>]*\bcontent=["']https:\/\/img2threejs\.io\/donate\.html["'])[^>]*>/i.test(donateHtml),
  'Open Graph URL must match the canonical donation URL.',
);
check(sitemap.includes('<loc>' + DONATE_URL + '</loc>'), 'public/sitemap.xml must include the donation page URL.');

const measurementIds = [...donateHtml.matchAll(/\bG-[A-Z0-9]+\b/g)].map((match) => match[0]);
check(
  valuesEqual([...new Set(measurementIds)], ['G-4MSYRF7901']),
  'The donation page must use only GA measurement ID G-4MSYRF7901.',
);
check(
  /var\s+GA_MEASUREMENT_ID\s*=\s*['"]G-4MSYRF7901['"]\s*;/m.test(donateHtml),
  'The GA measurement ID assignment is missing or changed.',
);

const hostsMatch = donateHtml.match(/var\s+HOSTS\s*=\s*\[([^\]]*)\]\s*;/m);
const hosts = hostsMatch
  ? [...hostsMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])
  : [];
check(
  valuesEqual(hosts, EXPECTED_HOSTS),
  'Analytics hosts must be exactly: ' + EXPECTED_HOSTS.join(', ') + '.',
);
check(
  /if\s*\(HOSTS\.indexOf\(location\.hostname\)\s*===\s*-1\)\s*return\s*;/m.test(donateHtml),
  'Analytics must fail closed outside the approved production hosts.',
);

check(
  /localStorage\.getItem\(['"]img2threejs:analytics-opt-out['"]\)\s*===\s*['"]1['"]/m.test(donateHtml),
  'Analytics must honor the shared img2threejs:analytics-opt-out key.',
);
check(
  /if\s*\(optedOut\s*\|\|\s*navigator\.webdriver\)\s*return\s*;/m.test(donateHtml),
  'Analytics must stop for opted-out visitors and automated browsers.',
);
check(
  /closest\(['"]a\[data-support-channel\]['"]\)/m.test(donateHtml),
  'Outbound analytics must be scoped to marked support links.',
);

const channelAttributes = [...donateHtml.matchAll(/\bdata-support-channel=["']([^"']+)["']/g)]
  .map((match) => match[1]);
check(
  valuesEqual(channelAttributes, ['paypal', 'kofi']),
  'Outbound support channels must be exactly paypal and kofi.',
);
check(
  /channel\s*!==\s*['"]paypal['"]\s*&&\s*channel\s*!==\s*['"]kofi['"]/m.test(donateHtml),
  'Analytics must whitelist only paypal and kofi channels.',
);
check(
  /(?:window\.)?gtag\(['"]event['"],\s*['"]support_click['"],\s*\{[\s\S]*?channel:\s*channel\s*,[\s\S]*?placement:\s*['"]donate_page['"][\s\S]*?\}\s*\)/m.test(donateHtml),
  'Outbound support clicks must emit support_click with placement donate_page and the selected channel.',
);

check(!/\.qr(?:-frame)?::after\b/i.test(donateHtml), 'QR scan overlays are not allowed.');
check(!/@keyframes\s+scan\b/i.test(donateHtml), 'QR scan animation is not allowed.');
check(!/animation(?:-name)?\s*:\s*scan\b/i.test(donateHtml), 'QR scan animation must remain removed.');

if (failures.length > 0) {
  console.error(
    'Donate integrity check failed with ' + failures.length + ' issue' + (failures.length === 1 ? '' : 's') + ':',
  );
  for (const failure of failures) console.error('- ' + failure);
  process.exit(1);
}

console.log('Donate integrity check passed.');
console.log('- Payee and local rails: Nguyễn Hoài Nhớ · MoMo · VietQR · napas 247');
console.log('- International methods: PayPal · Ko-fi · Binance Pay');
console.log('- Analytics: G-4MSYRF7901 · ' + EXPECTED_HOSTS.join(' · ') + ' · support_click/donate_page');
console.log('- public/momo-qr.png SHA-256: ' + qrHash);
console.log('- public/binance-pay-qr.png SHA-256: ' + cryptoQrHash);
