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

  const BOT = process.env.TELEGRAM_TOKEN;
  const GH  = process.env.GITHUB_TOKEN;
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
      const photo  = msg.photo[msg.photo.length - 1];
      const fileInfo = await tg(BOT, 'getFile', { file_id: photo.file_id });
      const imgUrl = `https://api.telegram.org/file/bot${BOT}/${fileInfo.result.file_path}`;
      const imgBuf = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
      const filename = `gallery_${Date.now()}.jpg`;

      await ghPut(GH, filename, imgBuf, null, `Upload gallery image ${filename}`);
      await reply(`✅ Снимката е качена!\n📁 ${filename}\n\nПиши ми ако искаш да я добавим в галерията на сайта.`);
    }

    // Видео
    else if (msg.video) {
      await reply('📹 За видео изпрати YouTube линк с командата:\n/видео https://youtube.com/... | Описание');
    }

    else if (/^\/(видео|video)/i.test(text)) {
      const body  = text.replace(/^\/(видео|video)\s*/i, '');
      const [url, ...rest] = body.split('|').map(s => s.trim());
      const desc = rest.join('|').trim() || 'Видео';

      if (!url) {
        await reply('⚠️ Формат:\n/видео https://youtube.com/... | Описание');
        return res.status(200).json({ ok: true });
      }

      await reply(`✅ Получих видеото!\nURL: ${url}\nОписание: ${desc}\n\nЩе го добавя в сайта скоро — функцията идва в следващата версия.`);
    }

    else if (/^\/(start|help|старт|помощ)/i.test(text)) {
      await reply(
        '🔧 <b>Команди за сайта:</b>\n\n' +
        '📝 <b>Отзив:</b>\n/отзив Иван И. | Страхотна работа!\n\n' +
        '📸 <b>Снимка:</b>\nИзпрати снимка директно\n\n' +
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
