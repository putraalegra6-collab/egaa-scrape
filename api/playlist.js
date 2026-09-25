const { state } = require('./_store');
const { put, del, handleUpload } = require('@vercel/blob');

if (!state.playlist) state.playlist = [];

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '6mb'
    }
  }
};

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ===== GET =====
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

  // ===== HANDLE UPLOAD (client upload ke Blob) =====
  if (req.method === 'POST' && body.type === 'blob.generate-client-token') {
    try {
      const { token } = await handleUpload({
        body: body,
        request: req,
        onBeforeGenerateToken: async (pathname) => {
          return {
            allowedContentTypes: [
              'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/aac',
              'audio/x-m4a', 'audio/webm', 'video/mp4', 'video/webm',
              'image/jpeg', 'image/png', 'image/webp', 'image/gif'
            ],
            maximumSizeInBytes: 1024 * 1024 * 1024, // 1GB
            addRandomSuffix: true
          };
        },
        onUploadCompleted: async ({ blob }) => {
          console.log('Blob uploaded:', blob.url);
        }
      });
      return res.status(200).json({ token });
    } catch (error) {
      console.error('Token error:', error);
      return res.status(400).json({ error: error.message });
    }
  }

  // ===== ADD =====
  if (body.action === 'add') {
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
      createdAt: new Date().toISOString(),
      playCount: 0
    };
    state.playlist.unshift(newSong);
    if (state.playlist.length > 200) state.playlist.length = 200;
    return res.status(200).json({ success: true, song: newSong, total: state.playlist.length });
  }

  // ===== UPDATE =====
  if (body.action === 'update') {
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
  if (body.action === 'delete') {
    const song = state.playlist.find(function(s){ return s.id === body.id; });
    if (song && song.audioUrl && song.audioUrl.indexOf('blob.vercel-storage.com') !== -1) {
      try { await del(song.audioUrl); } catch(e){ console.warn('Gagal hapus blob:', e.message); }
    }
    const before = state.playlist.length;
    state.playlist = state.playlist.filter(function(s){ return s.id !== body.id; });
    return res.status(200).json({ success: true, removed: before - state.playlist.length });
  }

  // ===== PLAY =====
  if (body.action === 'play') {
    const pIdx = state.playlist.findIndex(function(s){ return s.id === body.id; });
    if (pIdx !== -1) state.playlist[pIdx].playCount = (state.playlist[pIdx].playCount || 0) + 1;
    return res.status(200).json({ success: true });
  }

  // ===== REPLACE ALL =====
  if (body.action === 'replace_all') {
    if (Array.isArray(body.playlist)) state.playlist = body.playlist.slice(0, 200);
    return res.status(200).json({ success: true, total: state.playlist.length });
  }

  return res.status(400).json({ success: false, error: 'Action tidak dikenal.' });
};
