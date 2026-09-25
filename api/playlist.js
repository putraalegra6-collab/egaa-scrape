const { state } = require('./_store');

if (!state.playlist) state.playlist = [];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ success: true, playlist: state.playlist });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  if (req.method === 'POST') {
    const { action } = body;

    if (action === 'add') {
      const song = body.song;
      if (!song || !song.title || !song.uploader || !song.cover || !song.audioUrl) {
        return res.status(400).json({ success: false, error: 'Data lagu tidak lengkap.' });
      }
      var newSong = {
        id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        title: String(song.title).slice(0, 200),
        uploader: String(song.uploader).slice(0, 100),
        creator: String(song.creator || '-').slice(0, 200),
        cover: String(song.cover).slice(0, 3000),
        audioUrl: String(song.audioUrl).slice(0, 5000),
        audioType: song.audioType || 'url',
        createdAt: new Date().toISOString(),
        playCount: 0
      };
      state.playlist.unshift(newSong);
      if (state.playlist.length > 500) state.playlist.length = 500;
      return res.status(200).json({ success: true, song: newSong });
    }

    if (action === 'update') {
      var idx = state.playlist.findIndex(function(s){ return s.id === body.id; });
      if (idx === -1) return res.status(404).json({ success: false, error: 'Lagu tidak ditemukan.' });
      var s = body.song || {};
      if (s.title) state.playlist[idx].title = String(s.title).slice(0, 200);
      if (s.uploader) state.playlist[idx].uploader = String(s.uploader).slice(0, 100);
      if (s.creator) state.playlist[idx].creator = String(s.creator).slice(0, 200);
      if (s.cover) state.playlist[idx].cover = String(s.cover).slice(0, 3000);
      if (s.audioUrl) state.playlist[idx].audioUrl = String(s.audioUrl).slice(0, 5000);
      return res.status(200).json({ success: true, song: state.playlist[idx] });
    }

    if (action === 'delete') {
      state.playlist = state.playlist.filter(function(s){ return s.id !== body.id; });
      return res.status(200).json({ success: true });
    }

    if (action === 'play') {
      var pIdx = state.playlist.findIndex(function(s){ return s.id === body.id; });
      if (pIdx !== -1) state.playlist[pIdx].playCount = (state.playlist[pIdx].playCount || 0) + 1;
      return res.status(200).json({ success: true });
    }

    if (action === 'replace_all') {
      if (Array.isArray(body.playlist)) state.playlist = body.playlist.slice(0, 500);
      return res.status(200).json({ success: true, count: state.playlist.length });
    }

    return res.status(400).json({ success: false, error: 'Action tidak dikenal.' });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed' });
};
