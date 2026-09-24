const archiver = require('archiver');
const { URL } = require('url');

function safeName(str) {
  return String(str || 'file').replace(/[^a-z0-9._-]/gi, '_').slice(0, 150);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  let data = req.body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = null; }
  }

  if (!data || !data.url) {
    return res.status(400).json({ success: false, error: 'Data scrape tidak ada.' });
  }

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
    let modTxt = 'ANALISA MODULE JAVASCRIPT\n=========================\n\n';
    data.assetModules.forEach((m, i) => {
      modTxt += `[${i + 1}] ${m.url}\n    Type    : ${m.type}\n    Size    : ${m.size} bytes\n    Exports : ${m.exportCount}\n`;
      if (m.imports.length) {
        modTxt += `    Imports :\n`;
        m.imports.forEach(imp => (modTxt += `      - ${imp}\n`));
      }
      modTxt += '\n';
    });
    L('asset-modules.txt', modTxt);
  }

  if (data.downloadedAssets && data.downloadedAssets.length) {
    L('downloaded-assets.json', JSON.stringify(data.downloadedAssets, null, 2));
  }

  // API Analysis
  if (data.apiAnalyses && data.apiAnalyses.length) {
    L('api-analyses.json', JSON.stringify(data.apiAnalyses, null, 2));
  }

  // Generated module file
  if (data.generatedModule && data.generatedModule.code) {
    const fileName = data.generatedModule.fileName || 'api-module.js';
    archive.append(data.generatedModule.code, { name: 'modules/' + fileName });
    archive.append(data.generatedModule.code, { name: fileName });
  }

  const info = `COPY WEBSITE - HASIL SALINAN
========================================

URL        : ${data.url}
Waktu      : ${new Date().toISOString()}
Scraper    : Copy Website

STATISTIK
----------------------------------------
Total Link            : ${data.stats?.totalLinks || 0}
Total Gambar          : ${data.stats?.totalImages || 0}
Total Heading         : ${data.stats?.totalHeadings || 0}
Total Paragraf        : ${data.stats?.totalParagraphs || 0}
Total Tabel           : ${data.stats?.totalTables || 0}
Total Form            : ${data.stats?.totalForms || 0}
Total Script          : ${data.stats?.totalScripts || 0}
Total Stylesheet      : ${data.stats?.totalStylesheets || 0}
Total Iframe          : ${data.stats?.totalIframes || 0}
Total Font            : ${data.stats?.totalFonts || 0}
Asset Terdownload     : ${data.stats?.downloadedAssets || 0}
Endpoint Terdeteksi   : ${data.stats?.detectedEndpoints || 0}
Base URL Terdeteksi   : ${data.stats?.detectedBaseUrls || 0}
Ukuran HTML           : ${data.stats?.htmlSize || 0} bytes

STRUKTUR FILE
----------------------------------------
website/index.html              - HTML asli
website/content.txt             - Text content
website/assets/                 - Asset inline
data/data.json                  - Semua data
data/meta.json                  - Metadata
data/stats.json                 - Statistik
lists/links.txt                 - Daftar link
lists/links.json                - Link JSON
lists/images.txt                - Daftar gambar
lists/images.json               - Gambar JSON
lists/scripts.txt               - Daftar script
lists/stylesheets.txt           - Stylesheet
lists/iframes.txt               - Iframe
lists/headings.txt              - Heading
lists/tables.json               - Tabel
lists/forms.json                - Form
lists/asset-modules.json        - Analisa import/export
lists/asset-modules.txt         - Analisa readable
lists/api-analyses.json         - Analisa API endpoint
${data.generatedModule && data.generatedModule.code ? 'modules/' + (data.generatedModule.fileName || 'api-module.js') + '  - Module JS auto-generated\n' : ''}
`;
  archive.append(info, { name: 'INFO.txt' });

  await archive.finalize();
};
