const archiver = require('archiver');
const { URL } = require('url');
const { getClientIP, pushLog } = require('./_store');

function safeName(str) {
  return String(str || 'file').replace(/[^a-z0-9._-]/gi, '_').slice(0, 150);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || '';

  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }

  if (!data || !data.url) {
    return res.status(400).json({ success: false, error: 'Data scrape tidak ada.' });
  }

  pushLog(clientIP, userAgent, data.url, 'download_zip');

  const hostname = safeName(new URL(data.url).hostname || 'website');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="copy-website-${hostname}-${timestamp}.zip"`
  );

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    try { res.status(500).end(); } catch {}
  });
  archive.pipe(res);

  archive.append(data.rawHtml || '', { name: 'website/index.html' });
  archive.append(JSON.stringify(data, null, 2), { name: 'data/data.json' });
  archive.append(JSON.stringify(data.meta || {}, null, 2), { name: 'data/meta.json' });
  archive.append(JSON.stringify(data.stats || {}, null, 2), { name: 'data/stats.json' });
  archive.append(data.bodyText || '', { name: 'website/content.txt' });

  if (data.inlineStyles && data.inlineStyles.length) {
    archive.append(data.inlineStyles.join('\n\n/* --- */\n\n'), {
      name: 'website/assets/inline-styles.css'
    });
  }

  const L = (name, content) => archive.append(content, { name: 'lists/' + name });

  L('links.txt', (data.links || []).map(l => `${l.text}\t${l.href}`).join('\n'));
  L('links.json', JSON.stringify(data.links || [], null, 2));
  L('images.txt', (data.images || []).map(i => `${i.alt}\t${i.url}`).join('\n'));
  L('images.json', JSON.stringify(data.images || [], null, 2));
  L('scripts.txt', (data.scripts || []).map(s => `${s.type}\t${s.url || '(inline)'}`).join('\n'));
  L('stylesheets.txt', (data.stylesheets || []).map(s => s.url).join('\n'));
  L('iframes.txt', (data.iframes || []).join('\n'));
  L('tables.json', JSON.stringify(data.tables || [], null, 2));
  L('forms.json', JSON.stringify(data.forms || [], null, 2));

  let headingsTxt = '';
  ['h1','h2','h3','h4','h5','h6'].forEach(t => {
    const arr = (data.headings && data.headings[t]) || [];
    if (arr.length) {
      headingsTxt += `\n=== ${t.toUpperCase()} (${arr.length}) ===\n`;
      arr.forEach(h => (headingsTxt += `- ${h}\n`));
    }
  });
  L('headings.txt', headingsTxt);

  if (data.assetModules && data.assetModules.length) {
    L('asset-modules.json', JSON.stringify(data.assetModules, null, 2));
  }
  if (data.downloadedAssets && data.downloadedAssets.length) {
    L('downloaded-assets.json', JSON.stringify(data.downloadedAssets, null, 2));
  }

  const info = `COPY WEBSITE - HASIL SALINAN
========================================

URL        : ${data.url}
Waktu      : ${new Date().toISOString()}

STATISTIK
----------------------------------------
Total Link       : ${data.stats?.totalLinks || 0}
Total Gambar     : ${data.stats?.totalImages || 0}
Total Heading    : ${data.stats?.totalHeadings || 0}
Total Script     : ${data.stats?.totalScripts || 0}
Total Style      : ${data.stats?.totalStylesheets || 0}
Asset Download   : ${data.stats?.downloadedAssets || 0}
Ukuran HTML      : ${data.stats?.htmlSize || 0} bytes
`;
  archive.append(info, { name: 'INFO.txt' });

  await archive.finalize();
};
