const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { state, getClientIP, pushNotification, pushLog } = require('./_store');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Domain yang dilindungi (tidak boleh di-clone)
const PROTECTED_DOMAINS = [
  'egaa-scrape.vercel.app',
  'egaa-scrape.com'
];

function normalizeUrl(url) {
  if (!/^https?:\/\//i.test(url)) return 'https://' + url;
  return url;
}
function absUrl(base, u) {
  if (!u) return null;
  try { return new URL(u, base).href; } catch { return null; }
}
function safeName(str) {
  return String(str || 'file').replace(/[^a-z0-9._-]/gi, '_').slice(0, 150);
}
function fileFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const seg = p.split('/').filter(Boolean).pop() || 'index';
    return safeName(seg);
  } catch { return 'file'; }
}
async function fetchText(url, referer) {
  const res = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      ...(referer ? { 'Referer': referer } : {})
    },
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400
  });
  return res.data;
}

// Cek apakah URL termasuk domain yang dilindungi
function isProtectedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PROTECTED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || '';

  // Cek banned
  if (state.bannedIPs[clientIP]) {
    pushLog(clientIP, userAgent, '', 'blocked_banned_try');
    return res.status(403).json({
      success: false,
      error: 'Akses diblokir. IP kamu telah di-ban karena percobaan menyalin website ini.',
      banned: true
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  let { url, deep = true } = body || {};

  if (!url) return res.status(400).json({ success: false, error: 'URL wajib diisi.' });
  url = normalizeUrl(url);

  // === PROTEKSI: cek apakah target adalah website ini sendiri ===
  if (state.settings.protectionEnabled && isProtectedUrl(url)) {
    // Tambah counter
    const now = new Date().toISOString();
    if (!state.attempts[clientIP]) {
      state.attempts[clientIP] = {
        count: 0,
        firstSeen: now,
        lastSeen: now,
        userAgent,
        urls: []
      };
    }
    const att = state.attempts[clientIP];
    att.count += 1;
    att.lastSeen = now;
    att.userAgent = userAgent;
    if (!att.urls.includes(url)) att.urls.push(url);

    pushLog(clientIP, userAgent, url, 'attempt_protected_' + att.count);

    // Kirim notifikasi
    if (state.settings.notifyOnAttempt) {
      pushNotification(
        'clone_attempt',
        'Percobaan menyalin website terdeteksi (percobaan ke-' + att.count + ' dari ' + state.settings.maxAttempts + ')',
        clientIP,
        { url, userAgent, attemptCount: att.count }
      );
    }

    // Kalau sudah 3x, ban
    if (att.count >= state.settings.maxAttempts) {
      state.bannedIPs[clientIP] = {
        reason: 'Mencoba menyalin website ini ' + att.count + ' kali',
        bannedAt: now,
        bannedBy: 'system'
      };
      pushLog(clientIP, userAgent, url, 'auto_banned');
      pushNotification(
        'ip_banned',
        'IP di-ban otomatis karena mencoba menyalin website ' + att.count + ' kali',
        clientIP,
        { url, userAgent }
      );

      return res.status(403).json({
        success: false,
        banned: true,
        error: 'IP kamu telah diblokir permanen karena mencoba menyalin website ini ' + att.count + ' kali. Tidak bisa mencopy website ini.'
      });
    }

    const remaining = state.settings.maxAttempts - att.count;
    return res.status(403).json({
      success: false,
      blocked: true,
      attemptCount: att.count,
      remaining: remaining,
      error: 'Tidak bisa mencopy website ini. Peringatan ke-' + att.count + ' dari ' + state.settings.maxAttempts + '. ' +
        (remaining > 0
          ? 'Sisa ' + remaining + ' percobaan lagi sebelum IP kamu diblokir permanen.'
          : 'IP kamu akan segera diblokir.')
    });
  }

  // Log aktivitas scrape normal
  pushLog(clientIP, userAgent, url, 'scrape_start');

  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const title = $('title').first().text().trim() || '-';
    const description =
      $('meta[name="description"]').attr('content') ||
      $('meta[property="og:description"]').attr('content') || '-';
    const keywords = $('meta[name="keywords"]').attr('content') || '-';
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    const favicon =
      $('link[rel="icon"]').attr('href') ||
      $('link[rel="shortcut icon"]').attr('href') || '';

    const scripts = [];
    const stylesheets = [];
    const images = [];
    const fonts = [];
    const iframes = [];

    $('script').each((i, el) => {
      const src = $(el).attr('src');
      const type = $(el).attr('type') || '';
      if (src) {
        const full = absUrl(url, src);
        if (full) scripts.push({
          url: full,
          type: type.includes('module') ? 'module' : 'external',
          content: null
        });
      } else {
        const inline = $(el).html();
        if (inline && inline.trim()) scripts.push({ url: null, type: 'inline', content: inline });
      }
    });

    $('link').each((i, el) => {
      const rel = ($(el).attr('rel') || '').toLowerCase();
      const href = $(el).attr('href');
      if (!href) return;
      const full = absUrl(url, href);
      if (!full) return;
      if (rel.includes('stylesheet')) stylesheets.push({ url: full, content: null });
      else if (rel.includes('preload') || rel.includes('prefetch')) {
        const as = ($(el).attr('as') || '').toLowerCase();
        if (as === 'script') scripts.push({ url: full, type: 'preload', content: null });
        else if (as === 'style') stylesheets.push({ url: full, content: null });
        else if (as === 'font') fonts.push(full);
      }
    });

    $('img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy');
      if (!src) return;
      const full = absUrl(url, src);
      if (full) images.push({ url: full, alt: $(el).attr('alt') || '' });
    });

    $('iframe').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const full = absUrl(url, src);
      if (full) iframes.push(full);
    });

    const inlineStyles = [];
    $('style').each((i, el) => {
      const css = $(el).html();
      if (css && css.trim()) inlineStyles.push(css);
    });

    const headings = { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] };
    Object.keys(headings).forEach(tag => {
      $(tag).each((i, el) => {
        const t = $(el).text().trim();
        if (t) headings[tag].push(t);
      });
    });

    const paragraphs = [];
    $('p').each((i, el) => {
      const t = $(el).text().trim();
      if (t && t.length > 20) paragraphs.push(t);
    });

    const links = [];
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (href) {
        const full = absUrl(url, href);
        links.push({ text: text.slice(0, 150), href: full || href });
      }
    });

    const tables = [];
    $('table').each((i, el) => {
      const rows = [];
      $(el).find('tr').each((j, tr) => {
        const cells = [];
        $(tr).find('th, td').each((k, cell) => cells.push($(cell).text().trim()));
        if (cells.length) rows.push(cells);
      });
      if (rows.length) tables.push(rows);
    });

    const forms = [];
    $('form').each((i, el) => {
      const action = $(el).attr('action') || '';
      const method = ($(el).attr('method') || 'GET').toUpperCase();
      const inputs = [];
      $(el).find('input, select, textarea, button').each((j, inp) => {
        inputs.push({
          tag: inp.tagName,
          type: $(inp).attr('type') || '',
          name: $(inp).attr('name') || '',
          placeholder: $(inp).attr('placeholder') || ''
        });
      });
      forms.push({ action, method, inputs });
    });

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

    const downloadedAssets = [];
    const assetModules = [];

    if (deep) {
      const maxAssets = 40;
      const jsToFetch = scripts.filter(s => s.type !== 'inline' && s.url).slice(0, maxAssets);
      for (const s of jsToFetch) {
        try {
          const content = await fetchText(s.url, url);
          s.content = content;
          s.size = Buffer.byteLength(content, 'utf8');
          const imports = [];
          const importRegex = /import\s+(?:[\w*\s{},$]+\s+from\s+)?['"]([^'"]+)['"]/g;
          const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
          const exportRegex = /export\s+(?:default\s+|const\s+|function\s+|class\s+|\{)/g;
          let m;
          while ((m = importRegex.exec(content))) imports.push(m[1]);
          while ((m = requireRegex.exec(content))) imports.push(m[1]);
          const exportCount = (content.match(exportRegex) || []).length;
          assetModules.push({
            url: s.url,
            type: s.type,
            size: s.size,
            imports: [...new Set(imports)],
            exportCount,
            filename: fileFromUrl(s.url)
          });
          downloadedAssets.push({ url: s.url, filename: fileFromUrl(s.url), size: s.size });
        } catch (e) {
          s.content = null;
          s.error = e.message;
        }
      }
      const cssToFetch = stylesheets.slice(0, maxAssets);
      for (const s of cssToFetch) {
        try {
          const content = await fetchText(s.url, url);
          s.content = content;
          s.size = Buffer.byteLength(content, 'utf8');
          downloadedAssets.push({ url: s.url, filename: fileFromUrl(s.url), size: s.size });
        } catch (e) {
          s.content = null;
          s.error = e.message;
        }
      }
    }

    pushLog(clientIP, userAgent, url, 'scrape_success');

    const stats = {
      totalLinks: links.length,
      totalImages: images.length,
      totalHeadings: Object.values(headings).reduce((a, b) => a + b.length, 0),
      totalParagraphs: paragraphs.length,
      totalTables: tables.length,
      totalForms: forms.length,
      totalScripts: scripts.length,
      totalStylesheets: stylesheets.length,
      totalIframes: iframes.length,
      totalFonts: fonts.length,
      downloadedAssets: downloadedAssets.length,
      htmlSize: Buffer.byteLength(html, 'utf8')
    };

    res.status(200).json({
      success: true,
      scrapedBy: 'Copy Website',
      url,
      meta: { title, description, keywords, ogImage, favicon },
      headings,
      paragraphs: paragraphs.slice(0, 300),
      links: links.slice(0, 800),
      images: images.slice(0, 300),
      tables: tables.slice(0, 20),
      forms: forms.slice(0, 20),
      scripts: scripts.map(s => ({
        url: s.url,
        type: s.type,
        size: s.size || (s.content ? Buffer.byteLength(s.content, 'utf8') : 0),
        contentPreview: s.content ? s.content.slice(0, 5000) : null,
        contentLength: s.content ? s.content.length : 0
      })),
      stylesheets: stylesheets.map(s => ({
        url: s.url,
        size: s.size || (s.content ? Buffer.byteLength(s.content, 'utf8') : 0),
        contentPreview: s.content ? s.content.slice(0, 3000) : null
      })),
      inlineStyles,
      iframes,
      fonts,
      assetModules,
      downloadedAssets,
      stats,
      rawHtml: html,
      bodyText: bodyText.slice(0, 80000)
    });
  } catch (err) {
    pushLog(clientIP, userAgent, url, 'scrape_error:' + err.message);
    res.status(500).json({
      success: false,
      error: 'Gagal scrape: ' + err.message +
        '. Kemungkinan situs memblokir, timeout, atau URL tidak valid.'
    });
  }
};
