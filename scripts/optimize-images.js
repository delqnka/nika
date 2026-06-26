#!/usr/bin/env node
/*
 * Resize + re-encode hero/before-after/logo/service images and re-upload to R2.
 *
 * Usage:
 *   cd scripts && npm install
 *   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... R2_BUCKET=... \
 *     node optimize-images.js              # dry-run, prints planned sizes
 *   ... node optimize-images.js --apply    # actually overwrite + upload .webp variants
 *
 * For each entry it produces:
 *   - a re-encoded JPEG/PNG at the same key (so existing HTML keeps working)
 *   - a sibling .webp at the same path
 * Both are uploaded with Cache-Control: public, max-age=31536000, immutable.
 */

const crypto = require('node:crypto');
const sharp  = require('sharp');

const BUCKET     = process.env.R2_BUCKET;
const ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const ACCESS_KEY = process.env.R2_ACCESS_KEY_ID;
const SECRET_KEY = process.env.R2_SECRET_ACCESS_KEY;
const PUBLIC_URL = (process.env.R2_PUBLIC_URL || 'https://media.portretino.com').replace(/\/$/, '');
const KEY_PREFIX = 'compressed/';
const APPLY      = process.argv.includes('--apply');

if (!BUCKET || !ACCOUNT_ID || !ACCESS_KEY || !SECRET_KEY) {
  console.error('Missing R2 env vars (R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).');
  process.exit(1);
}

// key = filename inside compressed/, width = max target width in CSS px (we 2x for retina),
// quality = JPEG quality (webp uses same).
const TARGETS = [
  // Hero background — full-bleed, single LCP image. 1600 covers desktop comfortably.
  { key: 'background-nika.jpeg', width: 1600, quality: 72, fmt: 'jpeg' },

  // Before/after sliders — displayed at ~379x505 on mobile, ~600x450 on desktop.
  { key: 'img-0.jpeg', width: 1000, quality: 75, fmt: 'jpeg' },
  { key: 'img-1.jpeg', width: 1000, quality: 75, fmt: 'jpeg' },
  { key: 'img-4.jpeg', width: 1000, quality: 75, fmt: 'jpeg' },
  { key: 'img-5.jpeg', width: 1000, quality: 75, fmt: 'jpeg' },
  { key: 'ba_1781806459655_before.jpg', width: 1000, quality: 75, fmt: 'jpeg' },
  { key: 'ba_1781806492586_after.jpg',  width: 1000, quality: 75, fmt: 'jpeg' },
  { key: 'ba_1781805408699_before.jpg', width: 1000, quality: 75, fmt: 'jpeg' },
  { key: 'ba_1781805463432_after.jpg',  width: 1000, quality: 75, fmt: 'jpeg' },

  // Logo — rendered at 38–58px. PNG kept for transparency; tiny size.
  { key: 'kozr logo.png', width: 128, quality: 90, fmt: 'png' },

  // Service cards — displayed ~379x382.
  { key: 'svc_svc_1781802440104_1781858366246.jpg', width: 800, quality: 75, fmt: 'jpeg' },
  { key: 'svc_moket_1781856853718.jpg',   width: 800, quality: 75, fmt: 'jpeg' },
  { key: 'svc_sedalki_1781856709120.jpg', width: 800, quality: 75, fmt: 'jpeg' },
  { key: 'svc_bagajnik_1781856926138.jpg',width: 800, quality: 75, fmt: 'jpeg' },
  { key: 'svc_stelki_1781856951830.jpg',  width: 800, quality: 75, fmt: 'jpeg' },
];

const HOST = `${ACCOUNT_ID}.r2.cloudflarestorage.com`;
const REGION = 'auto';
const SERVICE = 's3';

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');

function sign(method, key, body, contentType, extraHeaders = {}) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);
  const payloadHash = body ? sha256(body) : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const canonicalUri = `/${BUCKET}/` + encodeURIComponent(key).replace(/%2F/g, '/');
  const headers = {
    host: HOST,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...extraHeaders,
  };
  if (contentType) headers['content-type'] = contentType;
  const names = Object.keys(headers).map((n) => n.toLowerCase()).sort();
  const canonHeaders = names.map((n) => `${n}:${headers[Object.keys(headers).find((k) => k.toLowerCase() === n)]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonRequest = [method, canonicalUri, '', canonHeaders, signedHeaders, payloadHash].join('\n');
  const credScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256(canonRequest)].join('\n');
  const kDate    = hmac('AWS4' + SECRET_KEY, dateStamp);
  const kRegion  = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');
  const auth = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${HOST}${canonicalUri}`, headers: { ...headers, Authorization: auth } };
}

async function r2Put(key, body, contentType) {
  const fullKey = KEY_PREFIX + key;
  const extra = { 'cache-control': 'public, max-age=31536000, immutable' };
  const { url, headers } = sign('PUT', fullKey, body, contentType, extra);
  const res = await fetch(url, { method: 'PUT', headers, body });
  if (!res.ok) throw new Error(`PUT ${fullKey} → ${res.status}: ${(await res.text()).substring(0, 200)}`);
}

async function download(key) {
  const url = `${PUBLIC_URL}/${KEY_PREFIX}${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function fmtBytes(n) { return (n / 1024).toFixed(1) + ' KiB'; }

(async () => {
  let totalBefore = 0, totalAfter = 0;
  for (const t of TARGETS) {
    process.stdout.write(`• ${t.key} … `);
    let original;
    try { original = await download(t.key); }
    catch (e) { console.log(`SKIP (${e.message})`); continue; }

    const pipeline = sharp(original).rotate().resize({ width: t.width, withoutEnlargement: true });

    const primary = t.fmt === 'png'
      ? await pipeline.clone().png({ quality: t.quality, compressionLevel: 9, palette: true }).toBuffer()
      : await pipeline.clone().jpeg({ quality: t.quality, mozjpeg: true }).toBuffer();

    const webp = await pipeline.clone().webp({ quality: t.quality }).toBuffer();
    const webpKey = t.key.replace(/\.(jpe?g|png)$/i, '.webp');

    totalBefore += original.length;
    totalAfter  += primary.length + webp.length;

    console.log(
      `${fmtBytes(original.length)} → ${fmtBytes(primary.length)} (${t.fmt}) + ${fmtBytes(webp.length)} (webp)`
    );

    if (APPLY) {
      const mime = t.fmt === 'png' ? 'image/png' : 'image/jpeg';
      await r2Put(t.key, primary, mime);
      await r2Put(webpKey, webp, 'image/webp');
    }
  }
  console.log('');
  console.log(`Total before: ${fmtBytes(totalBefore)}`);
  console.log(`Total after : ${fmtBytes(totalAfter)} (primary + webp combined)`);
  console.log(APPLY ? 'Uploaded.' : 'Dry-run. Add --apply to upload.');
})().catch((e) => { console.error(e); process.exit(1); });
