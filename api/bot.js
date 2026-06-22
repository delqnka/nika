const crypto = require('node:crypto');

const STAR = '<svg class="star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
const REPO       = 'delqnka/nika';
const MEDIA_BASE = process.env.R2_PUBLIC_URL || 'https://media.portretino.com';

// ── R2 (Cloudflare S3 API) — AWS Signature V4 ────────────────────────────────

function _hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function _hash(data)      { return crypto.createHash('sha256').update(data).digest('hex'); }

function _r2Sign(method, key, body, contentType) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket    = process.env.R2_BUCKET;
  if (!accountId || !accessKey || !secretKey || !bucket) {
    throw new Error('R2 env vars not configured (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET)');
  }
  const host    = `${accountId}.r2.cloudflarestorage.com`;
  const region  = 'auto';
  const service = 's3';
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);
  const payloadHash = body ? _hash(body) : 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const canonicalUri = `/${bucket}/${encodeURIComponent(key).replace(/%2F/g, '/')}`;
  const headers = { 'host': host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  const sortedNames    = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map(n => `${n}:${headers[n]}\n`).join('');
  const signedHeaders    = sortedNames.join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope  = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign     = ['AWS4-HMAC-SHA256', amzDate, credentialScope, _hash(canonicalRequest)].join('\n');
  const kDate    = _hmac('AWS4' + secretKey, dateStamp);
  const kRegion  = _hmac(kDate, region);
  const kService = _hmac(kRegion, service);
  const kSigning = _hmac(kService, 'aws4_request');
  const signature = _hmac(kSigning, stringToSign).toString('hex');
  const Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `https://${host}${canonicalUri}`, headers: { ...headers, Authorization } };
}

async function r2Put(key, body, contentType = 'application/octet-stream') {
  const { url, headers } = _r2Sign('PUT', key, body, contentType);
  const res = await fetch(url, { method: 'PUT', headers, body });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`R2 PUT ${key} failed ${res.status}: ${t.substring(0, 200)}`);
  }
  return `${MEDIA_BASE}/${key}`;
}

async function r2Delete(key) {
  const { url, headers } = _r2Sign('DELETE', key);
  const res = await fetch(url, { method: 'DELETE', headers });
  if (!res.ok && res.status !== 404) {
    const t = await res.text();
    throw new Error(`R2 DELETE ${key} failed ${res.status}: ${t.substring(0, 200)}`);
  }
}

// Extract bare key from a media URL (or pass-through if already bare)
function r2KeyFromUrl(src) {
  if (!src) return src;
  const i = src.lastIndexOf('/');
  return i === -1 ? src : src.substring(i + 1);
}


async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function ghGet(ghToken, path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json' }
  });
  return res.json();
}

async function ghPut(ghToken, path, content, sha, message) {
  await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) })
  });
}

async function ghDelete(ghToken, path, sha, message) {
  await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    method: 'DELETE',
    headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha })
  });
}

async function listGalleryFiles(ghToken) {
  const f = await ghGet(ghToken, 'gallery.json');
  if (!f?.content) return [];
  const names = JSON.parse(Buffer.from(f.content, 'base64').toString('utf-8'));
  return names.map(name => ({ name }));
}

// ── HTML builders ────────────────────────────────────────────────────────────

function buildReviewCard(author, text) {
  const initial = [...author][0].toUpperCase();
  const stars = Array(5).fill(STAR).join('\n            ');
  return `
        <article class="rev-card rev d2" role="listitem" itemscope itemtype="https://schema.org/Review">
          <div class="stars" aria-label="5 от 5 звезди">
            ${stars}
          </div>
          <blockquote class="rev-text" itemprop="reviewBody">
            "${text}"
          </blockquote>
          <div class="rev-author">
            <div class="rev-av" aria-hidden="true">${initial}</div>
            <div>
              <div class="rev-name" itemprop="author">${author}</div>
              <div class="rev-date">току-що</div>
            </div>
          </div>
        </article>`;
}

function buildSliderItem(beforeFile, afterFile, caption) {
  const SVG_L = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>';
  const SVG_R = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
  return `
        <div class="ba-item rev">
          <div class="ba-slider" aria-label="Сравнение преди и след — ${caption}">
            <img class="ba-img" src="${MEDIA_BASE}/${beforeFile}" alt="Преди — ${caption}" loading="lazy" width="600" height="450">
            <img class="ba-img ba-after" src="${MEDIA_BASE}/${afterFile}" alt="След — ${caption}" loading="lazy" width="600" height="450">
            <div class="ba-div"></div>
            <div class="ba-handle">
              ${SVG_L}
              ${SVG_R}
            </div>
            <span class="ba-lbl ba-lbl-b" aria-hidden="true">Преди</span>
            <span class="ba-lbl ba-lbl-a" aria-hidden="true">След</span>
          </div>
          <div class="ba-cap">${caption}</div>
        </div>`;
}

function buildVideoItem(filename) {
  return `
          <div class="vid-item rev">
            <div class="vid-thumb"><canvas class="vid-thumb-img"></canvas><div class="vid-play-circle"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div></div>
            <video class="vid" playsinline muted loop controls preload="metadata" aria-label="Видео от почистване">
              <source src="${MEDIA_BASE}/${filename}" type="video/mp4">
            </video>
          </div>`;
}

// ── HTML parsers ─────────────────────────────────────────────────────────────

// Returns [{index, author, text, fullBlock}]
function extractReviews(html) {
  const reviews = [];
  const regex = /<article[^>]+class="rev-card[^"]*"[^>]*>[\s\S]*?<\/article>/g;
  let match, i = 1;
  while ((match = regex.exec(html)) !== null) {
    const block = match[0];
    const authorMatch = block.match(/itemprop="author">\s*([^<]+)\s*<\/div>/);
    const textMatch = block.match(/<blockquote[^>]*>\s*"([^"]{1,80})/);
    if (authorMatch) {
      reviews.push({
        index: i++,
        author: authorMatch[1].trim(),
        text: textMatch ? textMatch[1].trim() : '',
        fullBlock: block
      });
    }
  }
  return reviews;
}

// Returns [{index, caption, fullBlock, beforeKey, afterKey}]
function extractSliders(html) {
  const sliders = [];
  const regex = /<div class="ba-item[^"]*"[^>]*>[\s\S]*?<div class="ba-cap">([^<]*)<\/div>\s*<\/div>/g;
  let match, i = 1;
  while ((match = regex.exec(html)) !== null) {
    const block = match[0];
    const imgs = [...block.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => r2KeyFromUrl(m[1]));
    sliders.push({
      index: i++,
      caption: match[1].trim(),
      fullBlock: block,
      beforeKey: imgs[0] || null,
      afterKey:  imgs[1] || null
    });
  }
  return sliders;
}

// Returns [{index, src, filename}] — src is the full URL in HTML, filename is the bare key
function extractVideoSources(html) {
  const regex = /<source src="([^"]+)"\s+type="video\/mp4">/g;
  const videos = [];
  let match, i = 1;
  while ((match = regex.exec(html)) !== null) {
    videos.push({ index: i++, src: match[1], filename: r2KeyFromUrl(match[1]) });
  }
  return videos;
}

// Парсира телефон → {local: "088 923 2706", intl: "+359889232706"} или null
function parsePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  let local;
  if (digits.startsWith('359') && digits.length === 12) {
    local = '0' + digits.substring(3);
  } else if (digits.startsWith('0') && digits.length === 10) {
    local = digits;
  } else {
    return null;
  }
  const intl = '+359' + local.substring(1);
  const localFmt = local.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3');
  return { local: localFmt, intl };
}

// Изтегля файл от Telegram и връща Buffer
async function downloadTgFile(token, fileId) {
  const info = await tg(token, 'getFile', { file_id: fileId });
  const path = info.result?.file_path;
  if (!path) return null;
  const buf = Buffer.from(await (await fetch(`https://api.telegram.org/file/bot${token}/${path}`)).arrayBuffer());
  return buf;
}

// Добавя снимка в gallery.json
async function addToGallery(GH, filename) {
  let sha = null, photos = [];
  const f = await ghGet(GH, 'gallery.json');
  if (f?.content) { photos = JSON.parse(Buffer.from(f.content, 'base64').toString('utf-8')); sha = f.sha; }
  photos.push(filename);
  await ghPut(GH, 'gallery.json', JSON.stringify(photos, null, 2), sha, `Gallery add: ${filename}`);
}

// Премахва снимка от gallery.json
async function removeFromGallery(GH, filename) {
  const f = await ghGet(GH, 'gallery.json');
  if (!f?.content) return;
  const photos = JSON.parse(Buffer.from(f.content, 'base64').toString('utf-8')).filter(p => p !== filename);
  await ghPut(GH, 'gallery.json', JSON.stringify(photos, null, 2), f.sha, `Gallery remove: ${filename}`);
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  // Reject anything not coming from Telegram with the configured secret.
  // Set the same value via: setWebhook?url=...&secret_token=<TG_WEBHOOK_SECRET>
  const SECRET = process.env.TG_WEBHOOK_SECRET;
  if (SECRET && req.headers['x-telegram-bot-api-secret-token'] !== SECRET) {
    return res.status(401).json({ ok: false });
  }

  const BOT     = process.env.TELEGRAM_TOKEN;
  const GH      = process.env.GITHUB_TOKEN;
  const ALLOWED = Number(process.env.ALLOWED_CHAT_ID);

  const msg = req.body?.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId = msg.chat.id;
  const text   = (msg.text || msg.caption || '').trim();

  // Silent ignore for unauthorized chats — no outbound Telegram API call.
  if (chatId !== ALLOWED) {
    return res.status(200).json({ ok: true });
  }

  const reply = (t) => tg(BOT, 'sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML' });

  try {

    // ══════════════════════════════════════════════════════════════════════════
    // ПРЕДИ/СЛЕД СЛАЙДЕРИ
    // ══════════════════════════════════════════════════════════════════════════

    // Стъпка 1: изпрати снимка с надпис /преди Описание
    if (msg.photo && /^\/(преди|predi)/i.test(text)) {
      const caption = text.replace(/^\/(преди|predi)\s*/i, '').trim() || 'Преди и след';
      const photo   = msg.photo[msg.photo.length - 1];
      const buf     = await downloadTgFile(BOT, photo.file_id);

      if (!buf) {
        await reply('❌ Не успях да изтегля снимката. Опитай пак.');
        return res.status(200).json({ ok: true });
      }

      const filename = `ba_${Date.now()}_before.jpg`;
      await r2Put(filename, buf, 'image/jpeg');

      // Запази pending state в GitHub
      const pendingData = JSON.stringify({ beforeFile: filename, caption });
      const existing = await ghGet(GH, 'ba_pending.json').catch(() => null);
      await ghPut(GH, 'ba_pending.json', pendingData, existing?.sha || null, 'Save pending before/after state');

      await reply(
        `✅ Снимката <b>"преди"</b> е запазена!\n📁 <code>${filename}</code>\n\nСега изпрати снимката <b>"след"</b> с надпис:\n/след\n\n` +
        `Слайдерът ще се казва: <b>${caption}</b>`
      );
    }

    // Стъпка 2: изпрати снимка с надпис /след
    else if (msg.photo && /^\/(след|sled)/i.test(text)) {
      const pendingFile = await ghGet(GH, 'ba_pending.json');

      if (!pendingFile || pendingFile.message) {
        await reply('⚠️ Първо изпрати снимката "преди" с надпис /преди Описание');
        return res.status(200).json({ ok: true });
      }

      const pending  = JSON.parse(Buffer.from(pendingFile.content, 'base64').toString('utf-8'));
      const photo    = msg.photo[msg.photo.length - 1];
      const buf      = await downloadTgFile(BOT, photo.file_id);

      if (!buf) {
        await reply('❌ Не успях да изтегля снимката. Опитай пак.');
        return res.status(200).json({ ok: true });
      }

      const afterFile = `ba_${Date.now()}_after.jpg`;
      await r2Put(afterFile, buf, 'image/jpeg');

      // Добави слайдера в index.html
      const htmlFile = await ghGet(GH, 'index.html');
      let html = Buffer.from(htmlFile.content, 'base64').toString('utf-8');
      const slider = buildSliderItem(pending.beforeFile, afterFile, pending.caption);

      // Вмъкни преди затварящия </div> на ba-wrap (маркирано от <!-- СНИМКИ -->)
      html = html.replace(
        '\n      </div>\n\n      <!-- СНИМКИ -->',
        '\n' + slider + '\n\n      </div>\n\n      <!-- СНИМКИ -->'
      );

      await ghPut(GH, 'index.html', html, htmlFile.sha, `Add before/after slider: ${pending.caption}`);

      // Изтрий pending state
      await ghDelete(GH, 'ba_pending.json', pendingFile.sha, 'Clear pending before/after state');

      await reply(
        `✅ Слайдерът е добавен!\n\n📸 <b>${pending.caption}</b>\nПреди: <code>${pending.beforeFile}</code>\nСлед: <code>${afterFile}</code>\n\nСайтът се обновява след ~1 мин.\nВиж всички: /слайдери`
      );
    }

    // /слайдери — списък
    else if (/^\/(слайдери|slajderi)$/i.test(text)) {
      const file = await ghGet(GH, 'index.html');
      const html = Buffer.from(file.content, 'base64').toString('utf-8');
      const sliders = extractSliders(html);

      if (sliders.length === 0) {
        await reply('🖼 Няма слайдери.');
      } else {
        const list = sliders.map(s => `${s.index}. <b>${s.caption}</b>`).join('\n');
        await reply(`🖼 <b>Слайдери преди/след (${sliders.length}):</b>\n\n${list}\n\nЗа изтриване: /изтрий_слайдер 1`);
      }

      // Покажи и дали има незавършен pending
      const pending = await ghGet(GH, 'ba_pending.json').catch(() => null);
      if (pending && !pending.message) {
        const p = JSON.parse(Buffer.from(pending.content, 'base64').toString('utf-8'));
        await reply(`⏳ Имаш незавършен слайдер:\n<b>${p.caption}</b>\nИзпрати снимката "след" с надпис /след\n\nИли отмени с /отмени_слайдер`);
      }
    }

    // /изтрий_слайдер N
    else if (/^\/(изтрий_слайдер|iztrii_slajder)/i.test(text)) {
      const num = parseInt(text.replace(/^\/(изтрий_слайдер|iztrii_slajder)\s*/i, '').trim());

      if (isNaN(num)) {
        await reply('⚠️ Пиши номера:\n/изтрий_слайдер 1\n\nВиж списъка с /слайдери');
        return res.status(200).json({ ok: true });
      }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      const sliders = extractSliders(html);
      const slider = sliders[num - 1];

      if (!slider) {
        await reply(`❌ Няма слайдер с номер ${num}. Виж с /слайдери`);
        return res.status(200).json({ ok: true });
      }

      html = html.replace(slider.fullBlock, '');
      await ghPut(GH, 'index.html', html, file.sha, `Delete slider: ${slider.caption}`);
      if (slider.beforeKey) await r2Delete(slider.beforeKey).catch(() => {});
      if (slider.afterKey)  await r2Delete(slider.afterKey).catch(() => {});
      await reply(`🗑 Слайдерът <b>${slider.caption}</b> е изтрит.\nСайтът се обновява след ~1 мин.`);
    }

    // /преименувай_слайдер N | Нов надпис
    else if (/^\/(преименувай_слайдер|preimenovaj_slajder)/i.test(text)) {
      const body  = text.replace(/^\/(преименувай_слайдер|preimenovaj_slajder)\s*/i, '').trim();
      const parts = body.split('|').map(s => s.trim());
      const num   = parseInt(parts[0]);
      const newCaption = parts.slice(1).join('|').trim();

      if (isNaN(num) || !newCaption) {
        await reply('⚠️ Формат:\n/преименувай_слайдер 1 | Нов надпис\n\nВиж номерата с /слайдери');
        return res.status(200).json({ ok: true });
      }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      const sliders = extractSliders(html);
      const slider = sliders[num - 1];

      if (!slider) {
        await reply(`❌ Няма слайдер с номер ${num}. Виж с /слайдери`);
        return res.status(200).json({ ok: true });
      }

      const updated = slider.fullBlock.replace(
        `<div class="ba-cap">${slider.caption}</div>`,
        `<div class="ba-cap">${newCaption}</div>`
      );
      html = html.replace(slider.fullBlock, updated);
      await ghPut(GH, 'index.html', html, file.sha, `Rename slider: ${slider.caption} → ${newCaption}`);
      await reply(`✅ Надписът е сменен!\n<b>${slider.caption}</b> → <b>${newCaption}</b>\n\nСайтът се обновява след ~1 мин.`);
    }

    // /отмени_слайдер — изчиства pending state
    else if (/^\/(отмени_слайдер|otmeni_slajder)/i.test(text)) {
      const pending = await ghGet(GH, 'ba_pending.json');
      if (!pending || pending.message) {
        await reply('ℹ️ Няма незавършен слайдер за отмяна.');
      } else {
        await ghDelete(GH, 'ba_pending.json', pending.sha, 'Cancel pending before/after');
        await reply('✅ Незавършеният слайдер е отменен.');
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ОТЗИВИ
    // ══════════════════════════════════════════════════════════════════════════

    else if (/^\/(отзив|otziv)/i.test(text)) {
      const body = text.replace(/^\/(отзив|otziv)\s*/i, '');
      const [author, ...rest] = body.split('|').map(s => s.trim());
      const reviewText = rest.join('|').trim();

      if (!author || !reviewText) {
        await reply('⚠️ Формат:\n/отзив Иван И. | Страхотна работа!');
        return res.status(200).json({ ok: true });
      }

      const file = await ghGet(GH, 'index.html');
      const html = Buffer.from(file.content, 'base64').toString('utf-8');
      const card = buildReviewCard(author, reviewText);
      const updated = html.replace(
        '\n      </div>\n\n      <div class="g-badge rev">',
        card + '\n\n      </div>\n\n      <div class="g-badge rev">'
      );

      await ghPut(GH, 'index.html', updated, file.sha, `Add review from ${author}`);
      await reply(`✅ Отзивът от <b>${author}</b> е добавен!\nСайтът се обновява след ~1 мин.`);
    }

    else if (/^\/(отзиви|otzivi)$/i.test(text)) {
      const file = await ghGet(GH, 'index.html');
      const html = Buffer.from(file.content, 'base64').toString('utf-8');
      const reviews = extractReviews(html);

      if (reviews.length === 0) {
        await reply('📝 Няма отзиви.');
      } else {
        const list = reviews.map(r => `${r.index}. <b>${r.author}</b>\n   "${r.text}..."`).join('\n\n');
        await reply(`📝 <b>Отзиви (${reviews.length}):</b>\n\n${list}\n\nЗа изтриване: /изтрий_отзив 1`);
      }
    }

    else if (/^\/(изтрий_отзив|iztrii_otziv)/i.test(text)) {
      const num = parseInt(text.replace(/^\/(изтрий_отзив|iztrii_otziv)\s*/i, '').trim());

      if (isNaN(num)) {
        await reply('⚠️ Пиши номера:\n/изтрий_отзив 1\n\nВиж списъка с /отзиви');
        return res.status(200).json({ ok: true });
      }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      const reviews = extractReviews(html);
      const review = reviews[num - 1];

      if (!review) {
        await reply(`❌ Няма отзив с номер ${num}. Виж с /отзиви`);
        return res.status(200).json({ ok: true });
      }

      html = html.replace(review.fullBlock, '');
      await ghPut(GH, 'index.html', html, file.sha, `Delete review from ${review.author}`);
      await reply(`🗑 Отзивът от <b>${review.author}</b> е изтрит.\nСайтът се обновява след ~1 мин.`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ══════════════════════════════════════════════════════════════════════════
    // СНИМКИ
    // ══════════════════════════════════════════════════════════════════════════

    // /снимка_услуга N — смяна/добавяне на снимка към услуга
    else if (msg.photo && /^\/(снимка_услуга|snimka_usluga)/i.test(text)) {
      const num = parseInt(text.replace(/^\/(снимка_услуга|snimka_usluga)\s*/i, '').trim());
      if (isNaN(num)) {
        await reply('⚠️ Изпрати снимката с надпис:\n/снимка_услуга [номер]\n\nПример: /снимка_услуга 1\nВиж номерата с /услуги');
        return res.status(200).json({ ok: true });
      }
      const sf = await ghGet(GH, 'services.json');
      const services = JSON.parse(Buffer.from(sf.content, 'base64').toString('utf-8'));
      const svc = services[num - 1];
      if (!svc) { await reply(`❌ Няма услуга ${num}. Виж с /услуги`); return res.status(200).json({ ok: true }); }

      const buf = await downloadTgFile(BOT, msg.photo[msg.photo.length - 1].file_id);
      if (!buf) { await reply('❌ Не успях да изтегля снимката.'); return res.status(200).json({ ok: true }); }

      const filename = `svc_${svc.id}_${Date.now()}.jpg`;
      await r2Put(filename, buf, 'image/jpeg');
      const oldPhoto = svc.photo;
      svc.photo = filename;
      await ghPut(GH, 'services.json', JSON.stringify(services, null, 2), sf.sha, `Update photo: ${svc.name}`);
      if (oldPhoto && oldPhoto !== filename) await r2Delete(oldPhoto).catch(() => {});
      await reply(`✅ Снимката на <b>${svc.name}</b> е обновена!\nСайтът се обновява след ~1 мин.`);
    }

    // Обикновена снимка (без специален надпис) → галерия на сайта
    else if (msg.photo && !/^\/(преди|predi|след|sled)/i.test(text)) {
      const photo    = msg.photo[msg.photo.length - 1];
      const buf      = await downloadTgFile(BOT, photo.file_id);
      if (!buf) { await reply('❌ Не успях да изтегля снимката.'); return res.status(200).json({ ok: true }); }
      const filename = `gallery_${Date.now()}.jpg`;
      await r2Put(filename, buf, 'image/jpeg');
      await addToGallery(GH, filename);
      await reply(`✅ Снимката е качена и се вижда на сайта!\n📁 <code>${filename}</code>\n\nЗа списък: /галерия\nЗа изтриване: /изтрий [число]`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ВИДЕА
    // ══════════════════════════════════════════════════════════════════════════

    else if (msg.video || msg.document?.mime_type?.startsWith('video/')) {
      const mediaObj = msg.video || msg.document;
      const buf      = await downloadTgFile(BOT, mediaObj.file_id);

      if (!buf) {
        await reply('❌ Файлът е твърде голям (макс. 20 MB). Компресирай видеото и изпрати пак.');
        return res.status(200).json({ ok: true });
      }

      const filename = `video_${Date.now()}.mp4`;
      await r2Put(filename, buf, 'video/mp4');

      const htmlFile = await ghGet(GH, 'index.html');
      let html = Buffer.from(htmlFile.content, 'base64').toString('utf-8');
      const card = buildVideoItem(filename);
      // Insert before the "Виж още" button — works whether vid-row is empty or not
      html = html.replace(
        '\n        <div style="text-align:center;margin-top:1.25rem;">',
        '\n' + card + '\n        <div style="text-align:center;margin-top:1.25rem;">'
      );
      await ghPut(GH, 'index.html', html, htmlFile.sha, `Add video ${filename}`);
      await reply(`✅ Видеото е качено и добавено!\n📁 <code>${filename}</code>\n\nСайтът се обновява след ~1 мин.\nЗа списък: /видеа\nЗа изтриване: /изтрий_видео [число]`);
    }

    else if (/^\/(видеа|videа|videa)$/i.test(text)) {
      const file = await ghGet(GH, 'index.html');
      const html = Buffer.from(file.content, 'base64').toString('utf-8');
      const videos = extractVideoSources(html);

      if (videos.length === 0) {
        await reply('📹 Няма видеа.');
      } else {
        const list = videos.map(v => `${v.index}. <code>${v.filename}</code>`).join('\n');
        await reply(`📹 <b>Видеа (${videos.length}):</b>\n\n${list}\n\nЗа изтриване: /изтрий_видео 1`);
      }
    }

    else if (/^\/(изтрий_видео|iztrii_video)/i.test(text)) {
      const num = parseInt(text.replace(/^\/(изтрий_видео|iztrii_video)\s*/i, '').trim());
      if (isNaN(num)) { await reply('⚠️ /изтрий_видео 1\n\nВиж с /видеа'); return res.status(200).json({ ok: true }); }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      const videos = extractVideoSources(html);
      const video = videos[num - 1];
      if (!video) { await reply(`❌ Няма видео ${num}. Виж с /видеа`); return res.status(200).json({ ok: true }); }

      // Find the exact vid-item block using div depth counting
      const srcIdx = html.indexOf(`<source src="${video.src}"`);
      if (srcIdx === -1) { await reply('❌ Видеото не е намерено в HTML.'); return res.status(200).json({ ok: true }); }
      const itemStart = html.lastIndexOf('<div class="vid-item', srcIdx);
      if (itemStart === -1) { await reply('❌ Грешка при намиране на блока.'); return res.status(200).json({ ok: true }); }

      let depth = 0, j = itemStart, itemEnd = -1;
      while (j < html.length) {
        if (html[j] === '<') {
          if (html.startsWith('<div', j) && (html[j+4] === ' ' || html[j+4] === '>')) {
            depth++; j += 4;
          } else if (html.startsWith('</div>', j)) {
            depth--; j += 6;
            if (depth === 0) { itemEnd = j; break; }
          } else { j++; }
        } else { j++; }
      }

      if (itemEnd === -1) { await reply('❌ Грешка при изтриване.'); return res.status(200).json({ ok: true }); }
      const actualStart = itemStart > 0 && html[itemStart - 1] === '\n' ? itemStart - 1 : itemStart;
      html = html.substring(0, actualStart) + html.substring(itemEnd);
      await ghPut(GH, 'index.html', html, file.sha, `Delete video ${video.filename}`);
      await r2Delete(video.filename).catch(() => {});
      await reply(`🗑 Видео <code>${video.filename}</code> е изтрито.\nСайтът се обновява след ~1 мин.`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ЦЕНИ / ОПИСАНИЯ / УСЛУГИ
    // ══════════════════════════════════════════════════════════════════════════

    // ── /услуги — списък ────────────────────────────────────────────────────
    else if (/^\/(услуги|uslugi)$/i.test(text)) {
      const sf = await ghGet(GH, 'services.json');
      const services = JSON.parse(Buffer.from(sf.content, 'base64').toString('utf-8'));

      if (!services.length) {
        await reply('📋 Няма услуги.\n\nДобави с: /нова_услуга Полиране | 80 | Описание...');
      } else {
        const list = services.map((s, i) => {
          const price = s.price ? `${s.price} €` : 'без цена';
          return `${i + 1}. <b>${s.name}</b> — ${price}`;
        }).join('\n');
        await reply(
          `🔧 <b>Услуги (${services.length}):</b>\n\n${list}\n\n` +
          `✏️ /редактирай_услуга 1 | цена | 55\n` +
          `✏️ /редактирай_услуга 1 | описание | Нов текст\n` +
          `✏️ /редактирай_услуга 1 | наименование | Ново Наименование\n` +
          `➕ /нова_услуга Полиране | 80 | Описание\n` +
          `🗑 /изтрий_услуга 1`
        );
      }
    }

    // ── /редактирай_услуга N | поле | стойност ──────────────────────────────
    else if (/^\/(редактирай_услуга|redaktiraj_usluga)/i.test(text)) {
      const body  = text.replace(/^\/(редактирай_услуга|redaktiraj_usluga)\s*/i, '');
      const parts = body.split('|').map(s => s.trim());
      const num   = parseInt(parts[0]);
      const field = (parts[1] || '').toLowerCase();
      const value = parts.slice(2).join('|').trim();

      if (isNaN(num) || !field || !value) {
        await reply(
          '⚠️ Формат:\n/редактирай_услуга [номер] | [поле] | [стойност]\n\n' +
          'Полета: наименование, цена, описание\n\n' +
          'Примери:\n/редактирай_услуга 1 | цена | 55\n' +
          '/редактирай_услуга 1 | описание | Дълбоко почистване...\n' +
          '/редактирай_услуга 1 | наименование | Пране на седалки Pro\n\n' +
          'Виж номерата с /услуги'
        );
        return res.status(200).json({ ok: true });
      }

      const sf = await ghGet(GH, 'services.json');
      const services = JSON.parse(Buffer.from(sf.content, 'base64').toString('utf-8'));
      const svc = services[num - 1];

      if (!svc) {
        await reply(`❌ Няма услуга с номер ${num}. Виж с /услуги`);
        return res.status(200).json({ ok: true });
      }

      const isName  = /^(наименование|name|ime|наим)$/.test(field);
      const isPrice = /^(цена|cena|price)$/.test(field);
      const isDesc  = /^(описание|opisanie|desc)$/.test(field);

      if (!isName && !isPrice && !isDesc) {
        await reply('⚠️ Непознато поле. Използвай: наименование, цена, описание');
        return res.status(200).json({ ok: true });
      }

      if (isPrice) {
        const eur = parseFloat(value);
        if (isNaN(eur)) { await reply('⚠️ Цената трябва да е число в евро.'); return res.status(200).json({ ok: true }); }
        const bgn = Math.round(eur * 1.95583);
        svc.price = eur;
        await ghPut(GH, 'services.json', JSON.stringify(services, null, 2), sf.sha, `Update price: ${svc.name}`);
        await reply(`✅ Цената на <b>${svc.name}</b> е обновена!\n${eur} € (≈ ${bgn} лв.)\n\nСайтът се обновява след ~1 мин.`);
      } else if (isDesc) {
        svc.desc = value;
        await ghPut(GH, 'services.json', JSON.stringify(services, null, 2), sf.sha, `Update description: ${svc.name}`);
        await reply(`✅ Описанието на <b>${svc.name}</b> е обновено!\nСайтът се обновява след ~1 мин.`);
      } else {
        const oldName = svc.name;
        svc.name = value;
        await ghPut(GH, 'services.json', JSON.stringify(services, null, 2), sf.sha, `Rename: ${oldName} → ${value}`);
        await reply(`✅ Услугата е преименувана!\n<b>${oldName}</b> → <b>${value}</b>\n\nСайтът се обновява след ~1 мин.`);
      }
    }

    // ── /нова_услуга Наименование | цена | описание ─────────────────────────
    else if (/^\/(нова_услуга|nova_usluga)/i.test(text)) {
      const body  = text.replace(/^\/(нова_услуга|nova_usluga)\s*/i, '');
      const parts = body.split('|').map(s => s.trim());
      const name  = parts[0];
      const price = parseFloat(parts[1]);
      const desc  = parts.slice(2).join('|').trim();

      if (!name || isNaN(price)) {
        await reply('⚠️ Формат:\n/нова_услуга Наименование | цена | Описание\n\nПример:\n/нова_услуга Полиране | 80 | Защитно полиране на купето.');
        return res.status(200).json({ ok: true });
      }

      const bgn  = Math.round(price * 1.95583);
      const id   = 'svc_' + Date.now();
      const sf   = await ghGet(GH, 'services.json');
      const services = JSON.parse(Buffer.from(sf.content, 'base64').toString('utf-8'));
      services.push({ id, name, price, desc });
      await ghPut(GH, 'services.json', JSON.stringify(services, null, 2), sf.sha, `Add service: ${name}`);
      const newNum = services.length;
      await reply(`✅ Услугата е добавена!\n<b>${name}</b> — ${price} € (≈ ${bgn} лв.)\n\n📸 <b>Добави снимка:</b> изпрати снимка с надпис:\n<code>/снимка_услуга ${newNum}</code>\n\nСайтът се обновява след ~1 мин.\nВиж всички с /услуги`);
    }

    // ── /изтрий_услуга N ────────────────────────────────────────────────────
    else if (/^\/(изтрий_услуга|iztrii_usluga)/i.test(text)) {
      const num = parseInt(text.replace(/^\/(изтрий_услуга|iztrii_usluga)\s*/i, '').trim());
      if (isNaN(num)) { await reply('⚠️ /изтрий_услуга [номер]\n\nВиж с /услуги'); return res.status(200).json({ ok: true }); }

      const sf = await ghGet(GH, 'services.json');
      const services = JSON.parse(Buffer.from(sf.content, 'base64').toString('utf-8'));
      const svc = services[num - 1];
      if (!svc) { await reply(`❌ Няма услуга ${num}. Виж с /услуги`); return res.status(200).json({ ok: true }); }

      services.splice(num - 1, 1);
      await ghPut(GH, 'services.json', JSON.stringify(services, null, 2), sf.sha, `Delete service: ${svc.name}`);
      if (svc.photo) await r2Delete(svc.photo).catch(() => {});
      await reply(`🗑 <b>${svc.name}</b> е изтрита.\nСайтът се обновява след ~1 мин.`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ТЕКСТОВЕ И КОНТАКТИ
    // ══════════════════════════════════════════════════════════════════════════

    else if (/^\/(телефон|telefon)/i.test(text)) {
      const raw = text.replace(/^\/(телефон|telefon)\s*/i, '').trim();
      const phone = parsePhone(raw);

      if (!phone) {
        await reply('⚠️ Формат:\n/телефон 088 654 3210\n\nИли с код:\n/телефон +359886543210');
        return res.status(200).json({ ok: true });
      }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      const currentIntlMatch = html.match(/href="tel:(\+\d+)"/);
      if (!currentIntlMatch) { await reply('❌ Не намерих текущия телефон.'); return res.status(200).json({ ok: true }); }
      const currentIntl = currentIntlMatch[1];
      const currentLocal = '0' + currentIntl.substring(4);
      const currentLocalFmt = currentLocal.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1 $2 $3');

      html = html
        .replace(new RegExp(currentIntl.replace('+', '\\+'), 'g'), phone.intl)
        .replace(new RegExp(currentLocalFmt, 'g'), phone.local);

      await ghPut(GH, 'index.html', html, file.sha, `Update phone to ${phone.local}`);
      await reply(`✅ Телефонът е обновен!\n<b>${phone.local}</b>\n\nСайтът се обновява след ~1 мин.`);
    }

    else if (/^\/(заглавие|zaglavie)/i.test(text)) {
      const newH1 = text.replace(/^\/(заглавие|zaglavie)\s*/i, '').trim();
      if (!newH1) { await reply('⚠️ /заглавие Чист интериор.<br><em>Без компромис.</em>'); return res.status(200).json({ ok: true }); }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      html = html.replace(/(<h1 class="hero-h1">)([\s\S]*?)(<\/h1>)/, `$1\n        ${newH1}\n      $3`);
      await ghPut(GH, 'index.html', html, file.sha, 'Update hero heading');
      await reply(`✅ Заглавието е обновено!\nСайтът се обновява след ~1 мин.`);
    }

    else if (/^\/(слоган|slogan)/i.test(text)) {
      const newP = text.replace(/^\/(слоган|slogan)\s*/i, '').trim();
      if (!newP) { await reply('⚠️ /слоган Текст под заглавието...'); return res.status(200).json({ ok: true }); }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      html = html.replace(/(<p class="hero-p">)([\s\S]*?)(<\/p>)/, `$1\n        ${newP}\n      $3`);
      await ghPut(GH, 'index.html', html, file.sha, 'Update hero paragraph');
      await reply(`✅ Слоганът е обновен!\nСайтът се обновява след ~1 мин.`);
    }

    else if (/^\/(таг|tag)/i.test(text)) {
      const newTag = text.replace(/^\/(таг|tag)\s*/i, '').trim();
      if (!newTag) { await reply('⚠️ /таг Варна и Варненско'); return res.status(200).json({ ok: true }); }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      html = html.replace(
        /(<div class="hero-tag">[\s\S]*?<span class="hero-dot"><\/span>\s*)([\s\S]*?)(\s*<\/div>)/,
        `$1\n        ${newTag}\n      $3`
      );
      await ghPut(GH, 'index.html', html, file.sha, `Update hero tag: ${newTag}`);
      await reply(`✅ Тагът е обновен на "<b>${newTag}</b>"!\nСайтът се обновява след ~1 мин.`);
    }

    else if (/^\/(соц|soc)/i.test(text)) {
      const body = text.replace(/^\/(соц|soc)\s*/i, '');
      const [platformRaw, ...rest] = body.split('|').map(s => s.trim());
      const url = rest.join('|').trim();
      const domainMap = {
        'facebook': /href="https?:\/\/[^"]*facebook\.com[^"]*"/g,
        'fb':       /href="https?:\/\/[^"]*facebook\.com[^"]*"/g,
        'instagram': /href="https?:\/\/[^"]*instagram\.com[^"]*"/g,
        'ig':        /href="https?:\/\/[^"]*instagram\.com[^"]*"/g,
        'tiktok': /href="https?:\/\/[^"]*tiktok\.com[^"]*"/g,
        'tt':     /href="https?:\/\/[^"]*tiktok\.com[^"]*"/g
      };
      const regex = domainMap[platformRaw?.toLowerCase()];

      if (!regex || !url) {
        await reply('⚠️ Формат:\n/соц facebook | https://...\n\nПлатформи: facebook, instagram, tiktok');
        return res.status(200).json({ ok: true });
      }

      const file = await ghGet(GH, 'index.html');
      let html = Buffer.from(file.content, 'base64').toString('utf-8');
      const count = (html.match(regex) || []).length;
      html = html.replace(regex, `href="${url}"`);
      await ghPut(GH, 'index.html', html, file.sha, `Update ${platformRaw} link`);
      await reply(`✅ ${platformRaw} линкът е обновен! (${count} места)\n<code>${url}</code>\n\nСайтът се обновява след ~1 мин.`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // ГАЛЕРИЯ
    // ══════════════════════════════════════════════════════════════════════════

    else if (/^\/(галерия|galeriya)/i.test(text)) {
      const files = await listGalleryFiles(GH);
      if (files.length === 0) {
        await reply('📂 Няма качени снимки засега.');
      } else {
        const list = files.map((f, i) => `${i + 1}. <code>${f.name}</code>`).join('\n');
        await reply(`📸 <b>Снимки в галерията (${files.length}):</b>\n\n${list}\n\nЗа изтриване: /изтрий 1`);
      }
    }

    else if (/^\/(изтрий|iztrii)\s+\d/i.test(text)) {
      const num = parseInt(text.replace(/^\/(изтрий|iztrii)\s*/i, '').trim());
      if (isNaN(num)) { await reply('⚠️ /изтрий 1\n\nВиж с /галерия'); return res.status(200).json({ ok: true }); }

      const files = await listGalleryFiles(GH);
      const file  = files[num - 1];
      if (!file) { await reply(`❌ Няма снимка ${num}. Виж с /галерия`); return res.status(200).json({ ok: true }); }

      await r2Delete(file.name).catch(() => {});
      await removeFromGallery(GH, file.name);
      await reply(`🗑 Снимка <code>${file.name}</code> е изтрита.\nСайтът се обновява след ~1 мин.`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // HELP
    // ══════════════════════════════════════════════════════════════════════════

    else if (/^\/(start|help|старт|помощ)/i.test(text)) {
      await reply(
        '🔧 <b>Команди за KOZR LAB:</b>\n\n' +

        '━━ СЛАЙДЕРИ ПРЕДИ/СЛЕД ━━\n' +
        '1️⃣ Изпрати снимка с надпис: /преди Задни седалки\n' +
        '2️⃣ Изпрати втора снимка с надпис: /след\n' +
        '📋 Виж: /слайдери\n' +
        '✏️ /преименувай_слайдер 1 | Нов надпис\n' +
        '🗑 Изтрий: /изтрий_слайдер 1\n' +
        '❌ Отмени незавършен: /отмени_слайдер\n\n' +

        '━━ ОТЗИВИ ━━\n' +
        '📝 /отзив Иван И. | Страхотна работа!\n' +
        '📋 /отзиви  🗑 /изтрий_отзив 1\n\n' +

        '━━ УСЛУГИ ━━\n' +
        '📋 Виж всички: /услуги\n' +
        '✏️ /редактирай_услуга 1 | цена | 55\n' +
        '✏️ /редактирай_услуга 1 | описание | Нов текст\n' +
        '✏️ /редактирай_услуга 1 | наименование | Ново Наименование\n' +
        '🖼 Смени снимка: изпрати снимка с надпис /снимка_услуга 1\n' +
        '➕ /нова_услуга Полиране | 80 | Описание\n' +
        '🗑 /изтрий_услуга 1\n\n' +

        '━━ ТЕКСТОВЕ ━━\n' +
        '🔤 /заглавие Нов текст на заглавието\n' +
        '💬 /слоган Идваме при вас с оборудване\n' +
        '📍 /таг Варна и Варненско\n\n' +

        '━━ КОНТАКТИ ━━\n' +
        '📞 /телефон 088 654 3210\n' +
        '🔗 /соц facebook | https://...\n' +
        '   (facebook, instagram, tiktok)\n\n' +

        '━━ МЕДИЯ ━━\n' +
        '📸 Изпрати снимка (без надпис) → галерия\n' +
        '📂 /галерия  🗑 /изтрий 1\n' +
        '📹 Изпрати видео (макс 20MB) → видео секция\n' +
        '📋 /видеа  🗑 /изтрий_видео 1'
      );
    }

    else {
      await reply('Не разпознавам командата. Пиши /help за всички команди.');
    }

  } catch (err) {
    console.error(err);
    await reply('❌ Нещо се обърка. Опитай пак.');
  }

  return res.status(200).json({ ok: true });
};
