const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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

// ============ API ENDPOINT EXTRACTOR ============
function extractApiEndpoints(jsContent, sourceUrl) {
  const found = [];

  // 1. Deteksi base URL / API host
  const baseUrlPatterns = [
    /(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*=\s*['"`](https?:\/\/[^'"`\s]+)['"`]/g,
    /['"`](https?:\/\/api\.[^'"`\s]+)['"`]/g,
    /['"`](https?:\/\/(?:[a-z0-9-]+\.)?(?:api|backend|server|data)\.[^'"`\s]{3,})['"`]/g
  ];
  const baseUrls = new Set();
  baseUrlPatterns.forEach(re => {
    let m;
    while ((m = re.exec(jsContent))) {
      const u = m[2] || m[1];
      if (u && u.length < 200) baseUrls.add(u);
    }
  });

  // 2. Deteksi fetch() calls
  const fetchRegex = /fetch\s*\(\s*(?:`([^`]+)`|['"]([^'"]+)['"]|([A-Za-z_$][\w$]*))/g;
  const fetchCalls = [];
  let fm;
  while ((fm = fetchRegex.exec(jsContent))) {
    const raw = fm[1] || fm[2] || fm[3] || '';
    if (raw) fetchCalls.push(raw);
  }

  // 3. Deteksi axios calls
  const axiosRegex = /axios\.(get|post|put|delete|patch)\s*\(\s*(?:`([^`]+)`|['"]([^'"]+)['"])/g;
  const axiosCalls = [];
  let am;
  while ((am = axiosRegex.exec(jsContent))) {
    axiosCalls.push({ method: am[1].toUpperCase(), url: am[2] || am[3] });
  }

  // 4. Deteksi path endpoint (relatif)
  const pathRegex = /['"`](\/(?:api|v\d+|rest|graphql|auth|user|data|search|list|pack|login|register)[^'"`\s]{0,80})['"`]/g;
  const paths = new Set();
  let pm;
  while ((pm = pathRegex.exec(jsContent))) {
    const p = pm[1];
    if (p.length < 120) paths.add(p);
  }

  // 5. Deteksi method yang dipakai di sekitar fetch
  const methodRegex = /method\s*:\s*['"](GET|POST|PUT|DELETE|PATCH)['"]/gi;
  const methods = new Set();
  let mm;
  while ((mm = methodRegex.exec(jsContent))) methods.add(mm[1].toUpperCase());

  // 6. Deteksi header custom
  const headerRegex = /headers\s*:\s*\{([^}]{0,500})\}/g;
  const headerSets = [];
  let hm;
  while ((hm = headerRegex.exec(jsContent))) {
    headerSets.push(hm[1].trim());
  }

  // 7. Deteksi pola token / auth
  const authRegex = /['"]?(Authorization|Bearer|api[_-]?key|x-api-key|token|access[_-]?token)['"]?\s*[:=]/gi;
  const authFields = new Set();
  let au;
  while ((au = authRegex.exec(jsContent))) authFields.add(au[1]);

  // Bangun list endpoint final
  const allEndpoints = new Set();
  fetchCalls.forEach(u => allEndpoints.add(u));
  axiosCalls.forEach(c => allEndpoints.add(c.url));
  paths.forEach(p => allEndpoints.add(p));

  const sourceHost = (() => {
    try { return new URL(sourceUrl).hostname; } catch { return ''; }
  })();

  allEndpoints.forEach(u => {
    found.push({
      url: u,
      method: axiosCalls.find(c => c.url === u)?.method || 'GET',
      type: u.startsWith('http') ? 'absolute' : 'relative',
      source: fileFromUrl(sourceUrl),
      resolved: u.startsWith('http') ? u : (() => {
        try { return new URL(u, sourceUrl).href; } catch { return u; }
      })()
    });
  });

  return {
    sourceFile: sourceUrl,
    baseUrls: [...baseUrls],
    endpoints: found,
    methods: [...methods],
    headerSets,
    authFields: [...authFields],
    hasAuth: authFields.size > 0,
    host: sourceHost
  };
}

// ============ GENERATOR: bikin file .js module ============
function generateApiModule(allApis, siteUrl) {
  const uniqueBaseUrls = new Set();
  const uniqueEndpoints = new Map();

  allApis.forEach(api => {
    api.baseUrls.forEach(b => uniqueBaseUrls.add(b));
    api.endpoints.forEach(e => {
      const key = e.method + ' ' + e.url;
      if (!uniqueEndpoints.has(key)) {
        uniqueEndpoints.set(key, e);
      }
    });
  });

  const baseUrlsArr = [...uniqueBaseUrls];
  const endpointsArr = [...uniqueEndpoints.values()];

  const siteHost = (() => {
    try { return new URL(siteUrl).hostname; } catch { return 'target'; }
  })();

  const siteName = siteHost
    .replace(/^www\./, '')
    .split('.')[0]
    .replace(/[^a-z0-9]/gi, ' ')
    .trim()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Target';

  const baseUrl = baseUrlsArr[0] || ('https://' + siteHost);

  let moduleCode = `/**
 * =============================================================
 *  NAME       : ${siteName} API Module
 *  GENERATED  : Auto-extracted by Copy Website
 *  SOURCE     : ${siteUrl}
 *  CREATED    : ${new Date().toISOString()}
 * =============================================================
 *  NOTE:
 *  File ini di-generate otomatis dari hasil analisis JavaScript
 *  website target. Endpoint dan struktur dapat berubah jika
 *  website melakukan update.
 * =============================================================
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SITE_URL = '${siteUrl}';
const SITE_HOST = '${siteHost}';

const BASE_URLS = ${JSON.stringify(baseUrlsArr, null, 2)};

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Content-Type': 'application/json'
};

/**
 * Daftar endpoint yang terdeteksi dari website target.
 */
export const ENDPOINTS = ${JSON.stringify(endpointsArr, null, 2)};

/**
 * Mengambil daftar base URL yang terdeteksi.
 */
export function getBaseUrls() {
  return BASE_URLS;
}

/**
 * Mengambil seluruh daftar endpoint yang terdeteksi.
 */
export function getEndpoints() {
  return ENDPOINTS;
}

/**
 * Request umum ke endpoint website.
 * @param {string} endpoint - path relatif atau absolute URL
 * @param {object} opts - { method, headers, body }
 */
export async function request(endpoint, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null
  } = opts;

  const url = endpoint.startsWith('http')
    ? endpoint
    : new URL(endpoint, SITE_URL).href;

  const finalHeaders = { ...DEFAULT_HEADERS, ...headers };

  const fetchOpts = {
    method: method.toUpperCase(),
    headers: finalHeaders
  };

  if (body && method.toUpperCase() !== 'GET') {
    fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(url, fetchOpts);

  if (!response.ok) {
    throw new Error(\`HTTP error dari \${SITE_HOST}! Status: \${response.status} \${response.statusText}\`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}
`;

  // Generate helper khusus kalau ada base URL API terdeteksi
  if (baseUrlsArr.length) {
    baseUrlsArr.forEach((base, idx) => {
      const name = base
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .replace(/[^a-z0-9]/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');

      moduleCode += `
/**
 * Request ke ${base}
 */
export async function request${name.charAt(0).toUpperCase() + name.slice(1)}(endpoint, opts = {}) {
  const base = '${base}';
  const url = endpoint.startsWith('http') ? endpoint : new URL(endpoint, base).href;
  return request(url, opts);
}
`;
    });
  }

  // Generate helper function untuk setiap endpoint yang terdeteksi
  endpointsArr.slice(0, 20).forEach((ep, idx) => {
    const funcName = 'callEndpoint' + (idx + 1);
    moduleCode += `
/**
 * ${ep.method} ${ep.url}
 */
export async function ${funcName}(body = null, headers = {}) {
  return request('${ep.url}', {
    method: '${ep.method}',
    headers,
    body
  });
}
`;
  });

  // CLI section
  moduleCode += `
// ============ CLI ============
const isDirectCall = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectCall) {
  const args = process.argv.slice(2);
  const action = args[0];

  if (!action || action === '--help' || action === '-h') {
    console.log(\`
${siteName} API Module (auto-generated)

Usage:
  node ${siteHost.split('.')[0]}.js list           - tampilkan semua endpoint
  node ${siteHost.split('.')[0]}.js request <url>  - panggil endpoint tertentu
  node ${siteHost.split('.')[0]}.js bases          - tampilkan base URL

Endpoints terdeteksi: \${ENDPOINTS.length}
\`);
    process.exit(0);
  }

  if (action === 'list') {
    console.log(JSON.stringify(ENDPOINTS, null, 2));
    process.exit(0);
  }

  if (action === 'bases') {
    console.log(JSON.stringify(BASE_URLS, null, 2));
    process.exit(0);
  }

  if (action === 'request') {
    const endpoint = args[1];
    if (!endpoint) {
      console.error('Usage: node ${siteHost.split('.')[0]}.js request <endpoint>');
      process.exit(1);
    }
    try {
      const result = await request(endpoint);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      console.error(JSON.stringify({ status: false, error: err.message }, null, 2));
      process.exit(1);
    }
    process.exit(0);
  }

  console.error('Perintah tidak dikenal. Gunakan --help.');
  process.exit(1);
}
`;

  return {
    code: moduleCode,
    siteName,
    fileName: siteHost.split('.')[0] + '.js',
    endpointCount: endpointsArr.length,
    baseUrlCount: baseUrlsArr.length
  };
}

// ============ MAIN HANDLER ============
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  let { url, deep = true } = body || {};

  if (!url) return res.status(400).json({ success: false, error: 'URL wajib diisi.' });
  url = normalizeUrl(url);

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
    const apiAnalyses = [];

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

          // Analisa API endpoint dari script ini
          const apiInfo = extractApiEndpoints(content, s.url);
          if (apiInfo.endpoints.length > 0 || apiInfo.baseUrls.length > 0) {
            apiAnalyses.push(apiInfo);
          }

          downloadedAssets.push({ url: s.url, filename: fileFromUrl(s.url), size: s.size });
        } catch (e) {
          s.content = null;
          s.error = e.message;
        }
      }

      // Analisa inline scripts juga
      scripts.filter(s => s.type === 'inline').forEach(s => {
        if (s.content) {
          const apiInfo = extractApiEndpoints(s.content, url);
          if (apiInfo.endpoints.length > 0 || apiInfo.baseUrls.length > 0) {
            apiAnalyses.push(apiInfo);
          }
        }
      });

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

    // Generate module file
    let generatedModule = null;
    if (apiAnalyses.length > 0) {
      try {
        generatedModule = generateApiModule(apiAnalyses, url);
      } catch (e) {
        generatedModule = { error: e.message, code: '', fileName: 'api-module.js', endpointCount: 0, baseUrlCount: 0 };
      }
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
      downloadedAssets: downloadedAssets.length,
      detectedEndpoints: generatedModule ? generatedModule.endpointCount : 0,
      detectedBaseUrls: generatedModule ? generatedModule.baseUrlCount : 0,
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
      apiAnalyses,
      generatedModule,
      stats,
      rawHtml: html,
      bodyText: bodyText.slice(0, 80000)
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: 'Gagal scrape: ' + err.message +
        '. Kemungkinan situs memblokir, timeout, atau URL tidak valid.'
    });
  }
};
