const STAR = '<svg class="star" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
const REPO = 'delqnka/nika';

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
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/`, {
    headers: { Authorization: `token ${ghToken}`, Accept: 'application/vnd.github.v3+json' }
  });
  const all = await res.json();
  return Array.isArray(all) ? all.filter(f => f.name.startsWith('gallery_') && f.type === 'file') : [];
}

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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const BOT     = process.env.TELEGRAM_TOKEN;
  const GH      = process.env.GITHUB_TOKEN;
  const ALLOWED = Number(process.env.ALLOWED_CHAT_ID);

  const msg = req.body?.message;
  if (!msg) return res.status(200).json({ ok: true });

  const chatId = msg.chat.id;
  const text   = msg.text || msg.caption || '';

  const reply = (t) => tg(BOT, 'sendMessage', { chat_id: chatId, text: t, parse_mode: 'HTML' });

  if (chatId !== ALLOWED) {
    await reply('❌ Нямаш достъп.');
    return res.status(200).json({ ok: true });
  }

  try {

    // /отзив Иван И. | Страхотен резултат!
    if (/^\/(отзив|otziv)/i.test(text)) {
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

    // Снимка
    else if (msg.photo) {
      const photo    = msg.photo[msg.photo.length - 1];
      const fileInfo = await tg(BOT, 'getFile', { file_id: photo.file_id });
      const imgUrl   = `https://api.telegram.org/file/bot${BOT}/${fileInfo.result.file_path}`;
      const imgBuf   = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
      const filename = `gallery_${Date.now()}.jpg`;

      await ghPut(GH, filename, imgBuf, null, `Upload gallery image ${filename}`);
      await reply(`✅ Снимката е качена!\n📁 <code>${filename}</code>\n\nЗа да видиш всички снимки: /галерия\nЗа да изтриеш: /изтрий [число]`);
    }

    // /цена [услуга] | [цена]
    else if (/^\/(цена|cena)/i.test(text)) {
      const body = text.replace(/^\/(цена|cena)\s*/i, '');
      const [svcRaw, ...rest] = body.split('|').map(s => s.trim());
      const price = rest.join('|').trim();

      const map = {
        'седалки': 'sedalki', 'sedalki': 'sedalki',
        'мокет': 'moket', 'moket': 'moket',
        'багажник': 'bagajnik', 'bagajnik': 'bagajnik',
        'стелки': 'stelki', 'stelki': 'stelki'
      };
      const key = map[svcRaw?.toLowerCase()];
      const eur = parseFloat(price);

      if (!key || isNaN(eur)) {
        await reply(
          '⚠️ Формат: /цена [услуга] | [число в евро]\n\n' +
          'Услуги: седалки, мокет, багажник, стелки\n\n' +
          'Пример:\n/цена седалки | 50\n/цена мокет | 40'
        );
        return res.status(200).json({ ok: true });
      }

      const bgn = Math.round(eur * 1.95583);
      const file = await ghGet(GH, 'prices.json');
      const prices = JSON.parse(Buffer.from(file.content, 'base64').toString('utf-8'));
      prices[key] = eur;

      await ghPut(GH, 'prices.json', JSON.stringify(prices, null, 2), file.sha, `Update price: ${svcRaw} = ${eur} EUR`);
      await reply(`✅ Цената е обновена!\n<b>${svcRaw}</b>: ${eur} € (≈ ${bgn} лв.)\n\nСайтът се обновява след ~1 мин.`);
    }

    // /галерия — списък с всички качени снимки
    else if (/^\/(галерия|galeriya)/i.test(text)) {
      const files = await listGalleryFiles(GH);
      if (files.length === 0) {
        await reply('📂 Няма качени снимки засега.');
      } else {
        const list = files.map((f, i) => `${i + 1}. <code>${f.name}</code>`).join('\n');
        await reply(`📸 <b>Качени снимки (${files.length}):</b>\n\n${list}\n\nЗа да изтриеш: /изтрий 1`);
      }
    }

    // /изтрий 2 — изтрива снимка по номер
    else if (/^\/(изтрий|iztrii)/i.test(text)) {
      const num = parseInt(text.replace(/^\/(изтрий|iztrii)\s*/i, '').trim());

      if (isNaN(num)) {
        await reply('⚠️ Пиши номера на снимката:\n/изтрий 1\n\nВиж списъка с /галерия');
        return res.status(200).json({ ok: true });
      }

      const files = await listGalleryFiles(GH);
      const file  = files[num - 1];

      if (!file) {
        await reply(`❌ Няма снимка с номер ${num}. Виж списъка с /галерия`);
        return res.status(200).json({ ok: true });
      }

      await ghDelete(GH, file.name, file.sha, `Delete gallery image ${file.name}`);
      await reply(`🗑 Снимка <code>${file.name}</code> е изтрита.\nСайтът се обновява след ~1 мин.`);
    }

    // Видео файл
    else if (msg.video) {
      await reply('📹 За видео изпрати YouTube линк:\n/видео https://youtube.com/... | Описание');
    }

    else if (/^\/(видео|video)/i.test(text)) {
      const body = text.replace(/^\/(видео|video)\s*/i, '');
      const [url, ...rest] = body.split('|').map(s => s.trim());
      const desc = rest.join('|').trim() || 'Видео';

      if (!url) {
        await reply('⚠️ Формат:\n/видео https://youtube.com/... | Описание');
        return res.status(200).json({ ok: true });
      }

      await reply(`✅ Получих!\nURL: ${url}\nОписание: ${desc}\n\nФункцията за видео в сайта идва скоро.`);
    }

    else if (/^\/(start|help|старт|помощ)/i.test(text)) {
      await reply(
        '🔧 <b>Команди за сайта:</b>\n\n' +
        '📝 <b>Отзив:</b>\n/отзив Иван И. | Страхотна работа!\n\n' +
        '💰 <b>Цена (в евро):</b>\n/цена седалки | 50\n/цена мокет | 40\n/цена багажник | 30\n/цена стелки | 25\n\n' +
        '📸 <b>Качи снимка:</b>\nИзпрати снимка директно\n\n' +
        '📂 <b>Виж снимките:</b>\n/галерия\n\n' +
        '🗑 <b>Изтрий снимка:</b>\n/изтрий 1\n\n' +
        '📹 <b>Видео:</b>\n/видео https://youtube.com/... | Описание'
      );
    }

    else {
      await reply('Не разпознавам командата. Пиши /help.');
    }

  } catch (err) {
    console.error(err);
    await reply('❌ Нещо се обърка. Опитай пак.');
  }

  return res.status(200).json({ ok: true });
};
