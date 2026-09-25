const { state } = require('./_store');
const { put, del } = require('@vercel/blob');

// Pastikan playlist selalu ada
if (!state.playlist) state.playlist = [];

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '6gb'
    }
  }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ===== GET: list lagu =====
  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      total: state.playlist.length,
      playlist: state.playlist
    });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  if (req.method === 'POST') {
    const { action } = body;

    // ===== UPLOAD FILE ke Vercel Blob =====
    if (action === 'upload') {
      const { fileName, fileType, fileBase64 } = body;
      if (!fileName || !fileBase64) {
        return res.status(400).json({ success: false, error: 'File tidak lengkap.' });
      }
      try {
        // Decode base64 ke Buffer
        let base64Data = fileBase64;
        if (base64Data.indexOf(',') !== -1) {
          base64Data = base64Data.split(',')[1];
        }
        const buffer = Buffer.from(base64Data, 'base64');

        // Upload ke Vercel Blob
        const blob = await put('music/' + Date.now() + '-' + fileName, buffer, {
          access: 'public',
          contentType: fileType || 'audio/mpeg',
          addRandomSuffix: true
        });

        return res.status(200).json({
          success: true,
          url: blob.url,
          size: buffer.length,
          fileName: fileName
        });
      } catch(e) {
        console.error('Blob upload error:', e);
        return res.status(500).json({
          success: false,
          error: 'Gagal upload ke Blob: ' + e.message
        });
      }
    }

    // ===== ADD LAGU =====
    if (action === 'add') {
      const song = body.song;
      if (!song || !song.title || !song.uploader || !song.cover || !song.audioUrl) {
        return res.status(400).json({ success: false, error: 'Data tidak lengkap.' });
      }
      const newSong = {
        id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title: String(song.title).slice(0, 200),
        uploader: String(song.uploader).slice(0, 100),
        creator: String(song.creator || '-').slice(0, 200),
        cover: String(song.cover).slice(0, 5000),
        audioUrl: String(song.audioUrl).slice(0, 10000),
        audioType: song.audioType || 'url',
        audioBlobPath: song.audioBlobPath || null,
        createdAt: new Date().toISOString(),
        playCount: 0
      };
      state.playlist.unshift(newSong);
      if (state.playlist.length > 200) state.playlist.length = 200;
      return res.status(200).json({ success: true, song: newSong, total: state.playlist.length });
    }

    // ===== UPDATE =====
    if (action === 'update') {
      const idx = state.playlist.findIndex(function(s){ return s.id === body.id; });
      if (idx === -1) return res.status(404).json({ success: false, error: 'Lagu tidak ditemukan.' });
      const s = body.song || {};
      if (s.title) state.playlist[idx].title = String(s.title).slice(0, 200);
      if (s.uploader) state.playlist[idx].uploader = String(s.uploader).slice(0, 100);
      if (s.creator) state.playlist[idx].creator = String(s.creator).slice(0, 200);
      if (s.cover) state.playlist[idx].cover = String(s.cover).slice(0, 5000);
      if (s.audioUrl) state.playlist[idx].audioUrl = String(s.audioUrl).slice(0, 10000);
      return res.status(200).json({ success: true, song: state.playlist[idx] });
    }

    // ===== DELETE =====
    if (action === 'delete') {
      const song = state.playlist.find(function(s){ return s.id === body.id; });
      // Hapus file dari Blob kalau ada
      if (song && song.audioBlobPath) {
        try { await del(song.audioBlobPath); } catch(e){ console.warn('Gagal hapus blob:', e.message); }
      }
      const before = state.playlist.length;
      state.playlist = state.playlist.filter(function(s){ return s.id !== body.id; });
      return res.status(200).json({ success: true, removed: before - state.playlist.length });
    }

    // ===== PLAY COUNT =====
    if (action === 'play') {
      const pIdx = state.playlist.findIndex(function(s){ return s.id === body.id; });
      if (pIdx !== -1) state.playlist[pIdx].playCount = (state.playlist[pIdx].playCount || 0) + 1;
      return res.status(200).json({ success: true });
    }

    // ===== REPLACE ALL =====
    if (action === 'replace_all') {
      if (Array.isArray(body.playlist)) state.playlist = body.playlist.slice(0, 200);
      return res.status(200).json({ success: true, total: state.playlist.length });
    }

    return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
};
