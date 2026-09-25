const { state } = require('./_store');

// In-memory playlist
if (!state.playlist) state.playlist = [];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET: list semua lagu
  if (req.method === 'GET') {
    return res.status(200).json({ success: true, playlist: state.playlist });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // POST: tambah / edit lagu
  if (req.method === 'POST') {
    const { action, song } = body;

    if (action === 'add') {
      if (!song || !song.title || !song.uploader || !song.cover || !song.audioUrl) {
        return res.status(400).json({ success: false, error: 'Data lagu tidak lengkap.' });
      }
      var newSong = {
        id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title: String(song.title).slice(0, 200),
        uploader: String(song.uploader).slice(0, 100),
        creator: String(song.creator || '-').slice(0, 200),
        cover: String(song.cover).slice(0, 1000),
        audioUrl: String(song.audioUrl).slice(0, 2000),
        audioType: song.audioType || 'url',
        createdAt: new Date().toISOString(),
        playCount: 0
      };
      state.playlist.unshift(newSong);
      if (state.playlist.length > 500) state.playlist.length = 500;
      return res.status(200).json({ success: true, song: newSong });
    }

    if (action === 'update') {
      var id = body.id;
      var idx = state.playlist.findIndex(function(s){ return s.id === id; });
      if (idx === -1) return res.status(404).json({ success: false, error: 'Lagu tidak ditemukan.' });
      var existing = state.playlist[idx];
      ['title', 'uploader', 'creator', 'cover', 'audioUrl'].forEach(function(k){
        if (body.song && body.song[k]) existing[k] = String(body.song[k]).slice(0, 2000);
      });
      return res.status(200).json({ success: true, song: existing });
    }

    if (action === 'delete') {
      var did = body.id;
      state.playlist = state.playlist.filter(function(s){ return s.id !== did; });
      return res.status(200).json({ success: true });
    }

    if (action === 'play') {
      var pid = body.id;
      var pIdx = state.playlist.findIndex(function(s){ return s.id === pid; });
      if (pIdx !== -1) state.playlist[pIdx].playCount = (state.playlist[pIdx].playCount || 0) + 1;
      return res.status(200).json({ success: true });
    }

    if (action === 'replace_all') {
      // Import full playlist (untuk sync)
      if (Array.isArray(body.playlist)) {
        state.playlist = body.playlist.slice(0, 500);
      }
      return res.status(200).json({ success: true, count: state.playlist.length });
    }

    return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
};
