/* simple IG resolver on Playwright */
const express = require('express');
const morgan = require('morgan');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 10000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // ОБЯЗАТЕЛЬНО задай в Render
const PROXY_URL = process.env.PROXY_URL || '';   // опционально: http://user:pass@host:port
const NAV_TIMEOUT = Number(process.env.NAV_TIMEOUT || 30000);
const NETWORK_IDLE_MS = Number(process.env.NETWORK_IDLE_MS || 1500);

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(morgan('tiny'));

// простая авторизация
app.use((req, res, next) => {
  const auth = req.get('authorization') || req.get('Authorization') || '';
  if (!AUTH_TOKEN) return res.status(500).json({ error: 'Server is not configured (missing AUTH_TOKEN)' });
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== AUTH_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// health
app.get('/health', (_, res) => res.json({ ok: true }));

// основная ручка
app.post('/ig', async (req, res) => {
  try {
    const target = (req.body && req.body.url || '').trim();
    if (!target) return res.status(400).json({ error: 'Missing url' });
    if (!/^https?:\/\/(www\.)?instagram\.com\//i.test(target)) {
      return res.status(400).json({ error: 'Only instagram.com links are supported' });
    }

    const out = await resolveInstagram(target);
    if (!out.length) return res.status(404).json({ media: [] });
    return res.json({ media: out });
  } catch (e) {
    console.error('[IG] error:', e.message);
    return res.status(502).json({ error: 'Resolver failed', detail: String(e.message || e) });
  }
});

async function resolveInstagram(url) {
  // опции запуска браузера
  const launchOpts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage'
    ],
    timeout: NAV_TIMEOUT
  };
  if (PROXY_URL) launchOpts.proxy = { server: PROXY_URL };

  const browser = await chromium.launch(launchOpts);
  let context;
  try {
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT);

    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    if (!resp || !resp.ok()) {
      // иногда IG отдаёт 302/redirect — продолжим, всё равно возьмём контент
      // но если прям ошибка:
      // console.warn('goto status', resp && resp.status());
    }

    // дождёмся затишья сети
    await page.waitForTimeout(NETWORK_IDLE_MS);

    // собираем мета-теги
    const metas = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('meta'));
      const pick = (prop) =>
        all.find(m => (m.getAttribute('property')||'').toLowerCase() === prop || (m.getAttribute('name')||'').toLowerCase() === prop);
      const video = pick('og:video') || pick('og:video:secure_url');
      const image = pick('og:image');
      return {
        video: video ? video.getAttribute('content') : '',
        image: image ? image.getAttribute('content') : ''
      };
    });

    const html = await page.content();

    const found = new Set();
    const push = (url, type) => {
      if (!url) return;
      // убираем экранирование \/ → /
      const clean = url.replace(/\\u0026/g, '&').replace(/\\\//g, '/').trim();
      if (!clean) return;
      if (found.has(clean)) return;
      found.add(clean);
      out.push({ url: clean, type, quality: '' });
    };

    const out = [];

    // 1) og:video / og:image
    push(metas.video, 'video');
    push(metas.image, 'image');

    // 2) видео в JSON: "video_url":"https://..."
    const rxVid = /"video_url"\s*:\s*"([^"]+)"/ig;
    let m;
    while ((m = rxVid.exec(html))) push(m[1], 'video');

    // 3) картинки в JSON: "display_url":"https://..." или "thumbnail_src"
    const rxImg1 = /"display_url"\s*:\s*"([^"]+)"/ig;
    while ((m = rxImg1.exec(html))) push(m[1], 'image');
    const rxImg2 = /"thumbnail_src"\s*:\s*"([^"]+)"/ig;
    while ((m = rxImg2.exec(html))) push(m[1], 'image');

    return out;
  } finally {
    try { if (context) await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log(`IG service listening on ${PORT}`);
});
