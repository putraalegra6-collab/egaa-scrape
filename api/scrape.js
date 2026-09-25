const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { state, getClientIP, pushLog } = require('./_store');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROTECTED_DOMAINS = ['egaa-copywebsite.vercel.app', 'egaa-scrape.vercel.app'];

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
    timeout: 25000,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'id-ID,id;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      ...(referer ? { 'Referer': referer } : {})
    },
    maxRedirects: 5,
    responseType: 'text',
    validateStatus: (s) => s >= 200 && s < 400,
    decompress: true
  });
  return res.data;
}
function isProtectedUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PROTECTED_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch { return false; }
}
function extractApiEndpoints(jsContent, sourceUrl) {
  const found = [];
  const baseUrls = new Set();
  const baseUrlPatterns = [
    /(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*=\s*['"`](https?:\/\/[^'"`\s]+)['"`]/g,
    /['"`](https?:\/\/api\.[^'"`\s]+)['"`]/g,
    /['"`](https?:\/\/(?:[a-z0-9-]+\.)?(?:api|backend|server|data)\.[^'"`\s]{3,})['"`]/g
  ];
  baseUrlPatterns.forEach(re => {
    let m;
    while ((m = re.exec(jsContent))) {
      const u = m[2] || m[1];
      if (u && u.length < 200) baseUrls.add(u);
    }
  });
  const fetchRegex = /fetch\s*\(\s*(?:`([^`]+)`|['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))/g;
  const fetchCalls = [];
  let fm;
  while ((fm = fetchRegex.exec(jsContent))) {
    const raw = fm[1] || fm[2] || fm[3] || '';
    if (raw) fetchCalls.push(raw);
  }
  const axiosRegex = /axios\.(get|post|put|delete|patch)\s*\(\s*(?:`([^`]+)`|['"]([^'"]+)['"])/g;
  const axiosCalls = [];
  let am;
  while ((am = axiosRegex.exec(jsContent))) {
    axiosCalls.push({ method: am[1].toUpperCase(), url: am[2] || am[3] });
  }
  const pathRegex = /['"`](\/(?:api|v\d+|rest|graphql|auth|user|data|search|list|pack|login|register)[^'"`\s]{0,80})['"`]/g;
  const paths = new Set();
  let pm;
  while ((pm = pathRegex.exec(jsContent))) {
    const p = pm[1];
    if (p.length < 120) paths.add(p);
  }
  const allEndpoints = new Set();
  fetchCalls.forEach(u => allEndpoints.add(u));
  axiosCalls.forEach(c => allEndpoints.add(c.url));
  paths.forEach(p => allEndpoints.add(p));
  allEndpoints.forEach(u => {
    found.push({
      url: u,
      method: axiosCalls.find(c => c.url === u)?.method || 'GET',
      type: u.startsWith('http') ? 'absolute' : 'relative',
      resolved: u.startsWith('http') ? u : (() => {
        try { return new URL(u, sourceUrl).href; } catch { return u; }
      })()
    });
  });
  return {
    sourceFile: sourceUrl,
    baseUrls: [...baseUrls],
    endpoints: found
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || '';

  if (state.bannedIPs && state.bannedIPs[clientIP]) {
    return res.status(403).json({ success: false, banned: true, error: 'Akses diblokir.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  let { url, deep = true } = body || {};
  if (!url) return res.status(400).json({ success: false, error: 'URL wajib diisi.' });
  url = normalizeUrl(url);

  if (state.settings.protectionEnabled && isProtectedUrl(url)) {
    if (!state.attempts[clientIP]) state.attempts[clientIP] = { count: 0, firstSeen: new Date().toISOString(), urls: [] };
    state.attempts[clientIP].count++;
    pushLog(clientIP, userAgent, url, 'attempt_protected');
    return res.status(403).json({ success: false, blocked: true, error: 'Domain ini dilindungi.' });
  }

  pushLog(clientIP, userAgent, url, 'scrape_start');

  try {
    const html = await fetchText(url);
    const $ = cheerio.load(html);

    const title = $('title').first().text().trim() || '-';
    const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '-';
    const keywords = $('meta[name="keywords"]').attr('content') || '-';
    const ogImage = $('meta[property="og:image"]').attr('content') || '';
    const favicon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || '';

    const scripts = [];
    const stylesheets = [];
    const images = [];
    const videos = [];
    const audios = [];
    const fonts = [];
    const iframes = [];
    const metaTags = [];
    const linkTags = [];

    $('meta').each((i, el) => metaTags.push(el.attribs || {}));
    $('link').each((i, el) => linkTags.push(el.attribs || {}));

    $('script').each((i, el) => {
      const src = $(el).attr('src');
      const type = $(el).attr('type') || '';
      if (src) {
        const full = absUrl(url, src);
        if (full) scripts.push({ url: full, type: type.includes('module') ? 'module' : 'external', content: null });
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
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy') || $(el).attr('data-original');
      const srcset = $(el).attr('srcset');
      if (src) {
        const full = absUrl(url, src);
        if (full) images.push({ url: full, alt: $(el).attr('alt') || '' });
      }
      if (srcset) {
        srcset.split(',').forEach(s => {
          const part = s.trim().split(' ')[0];
          const full = absUrl(url, part);
          if (full && !images.find(x => x.url === full)) images.push({ url: full, alt: $(el).attr('alt') || '' });
        });
      }
    });

    $('video, source').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const full = absUrl(url, src);
      if (full && !videos.includes(full)) videos.push(full);
    });
    $('audio').each((i, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      const full = absUrl(url, src);
      if (full && !audios.includes(full)) audios.push(full);
    });

    $('iframe').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
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

    // Semantic tags
    const semantic = {};
    ['section', 'article', 'nav', 'header', 'footer', 'aside', 'main'].forEach(tag => {
      const arr = [];
      $(tag).each((i, el) => {
        const t = $(el).text().trim().slice(0, 200);
        const id = $(el).attr('id') || '';
        const cls = $(el).attr('class') || '';
        if (t || id || cls) arr.push({ id, class: cls, preview: t });
      });
      if (arr.length) semantic[tag] = arr;
    });

    // SVG inline
    const svgs = [];
    $('svg').each((i, el) => {
      const content = $.html(el);
      if (content && content.length < 5000) svgs.push(content);
    });

    // Data attributes
    const dataAttrs = [];
    $('[data-*]').each((i, el) => {
      if (i > 50) return;
      const attribs = el.attribs || {};
      const datas = {};
      Object.keys(attribs).forEach(k => {
        if (k.startsWith('data-')) datas[k] = attribs[k];
      });
      if (Object.keys(datas).length) dataAttrs.push({ tag: el.tagName, data: datas });
    });

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

    const downloadedAssets = [];
    const assetModules = [];
    const apiAnalyses = [];

    if (deep) {
      const maxAssets = 100;

      // ALL external JS
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
          assetModules.push({ url: s.url, type: s.type, size: s.size, imports: [...new Set(imports)], exportCount, filename: fileFromUrl(s.url) });
          const apiInfo = extractApiEndpoints(content, s.url);
          if (apiInfo.endpoints.length > 0 || apiInfo.baseUrls.length > 0) apiAnalyses.push(apiInfo);
          downloadedAssets.push({ url: s.url, filename: fileFromUrl(s.url), size: s.size });
        } catch (e) { s.content = null; s.error = e.message; }
      }

      // ALL external CSS
      const cssToFetch = stylesheets.slice(0, maxAssets);
      for (const s of cssToFetch) {
        try {
          const content = await fetchText(s.url, url);
          s.content = content;
          s.size = Buffer.byteLength(content, 'utf8');
          downloadedAssets.push({ url: s.url, filename: fileFromUrl(s.url), size: s.size });
        } catch (e) { s.content = null; s.error = e.message; }
      }

      // Inline scripts api analysis
      scripts.filter(s => s.type === 'inline').forEach(s => {
        if (s.content) {
          const apiInfo = extractApiEndpoints(s.content, url);
          if (apiInfo.endpoints.length > 0 || apiInfo.baseUrls.length > 0) apiAnalyses.push(apiInfo);
        }
      });
    }

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
      totalVideos: videos.length,
      totalAudios: audios.length,
      totalMetaTags: metaTags.length,
      totalSVGs: svgs.length,
      downloadedAssets: downloadedAssets.length,
      htmlSize: Buffer.byteLength(html, 'utf8')
    };

    pushLog(clientIP, userAgent, url, 'scrape_success');

    res.status(200).json({
      success: true,
      scrapedBy: 'Copy Website',
      url,
      meta: { title, description, keywords, ogImage, favicon },
      metaTags,
      linkTags,
      headings,
      paragraphs: paragraphs.slice(0, 500),
      links: links.slice(0, 2000),
      images: images.slice(0, 500),
      videos: videos.slice(0, 100),
      audios: audios.slice(0, 100),
      tables: tables.slice(0, 30),
      forms: forms.slice(0, 30),
      scripts: scripts.map(s => ({
        url: s.url, type: s.type,
        size: s.size || (s.content ? Buffer.byteLength(s.content, 'utf8') : 0),
        contentPreview: s.content ? s.content.slice(0, 50000) : null,
        content: s.content || null
      })),
      stylesheets: stylesheets.map(s => ({
        url: s.url,
        size: s.size || (s.content ? Buffer.byteLength(s.content, 'utf8') : 0),
        content: s.content || null
      })),
      inlineStyles,
      iframes,
      fonts,
      semantic,
      svgs: svgs.slice(0, 50),
      dataAttrs: dataAttrs.slice(0, 100),
      assetModules,
      downloadedAssets,
      apiAnalyses,
      stats,
      rawHtml: html,
      bodyText: bodyText.slice(0, 100000)
    });
  } catch (err) {
    pushLog(clientIP, userAgent, url, 'scrape_error:' + err.message);
    res.status(500).json({ success: false, error: 'Gagal copy: ' + err.message });
  }
};
