const { state, getClientIP, pushLog, pushNotification } = require('./_store');

const ADMIN_VERIFY_1 = 'ANGGA';
const ADMIN_VERIFY_2 = 'ega123';
const ADMIN_VERIFY_3 = 'alegra';

function verifyAdmin(v1, v2, v3) {
  return (
    String(v1 || '').toUpperCase() === ADMIN_VERIFY_1 &&
    String(v2 || '') === ADMIN_VERIFY_2 &&
    String(v3 || '') === ADMIN_VERIFY_3
  );
}

function makeToken() {
  return 'adm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
}
const activeTokens = {};
const TOKEN_TTL = 1000 * 60 * 60 * 24 * 7; // 7 hari

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Token');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { action } = body || {};
  const clientIP = getClientIP(req);
  const userAgent = req.headers['user-agent'] || '';

  // === LOGIN ===
  if (action === 'login') {
    const { v1, v2, v3, remember } = body;
    pushLog(clientIP, userAgent, '', 'admin_login_attempt');

    if (!verifyAdmin(v1, v2, v3)) {
      pushLog(clientIP, userAgent, '', 'admin_login_failed');
      pushNotification('admin_login_failed', 'Ada percobaan login admin gagal', clientIP, null);
      return res.status(401).json({ success: false, error: 'Verifikasi gagal. Periksa kembali data yang dimasukkan.' });
    }

    const token = makeToken();
    activeTokens[token] = {
      ip: clientIP,
      createdAt: Date.now(),
      remember: !!remember
    };
    pushLog(clientIP, userAgent, '', 'admin_login_success');
    pushNotification('admin_login', 'Admin berhasil login', clientIP, null);

    return res.status(200).json({
      success: true,
      token,
      expiresIn: TOKEN_TTL
    });
  }

  // === VERIFY TOKEN (untuk auto-login) ===
  if (action === 'verify') {
    const token = req.headers['x-admin-token'] || (body && body.token);
    if (!token || !activeTokens[token]) {
      return res.status(401).json({ success: false, valid: false });
    }
    const s = activeTokens[token];
    if (Date.now() - s.createdAt > TOKEN_TTL) {
      delete activeTokens[token];
      return res.status(401).json({ success: false, valid: false });
    }
    return res.status(200).json({ success: true, valid: true });
  }

  // === CEK TOKEN untuk semua aksi lain ===
  const token = req.headers['x-admin-token'] || (body && body.token);
  if (!token || !activeTokens[token]) {
    return res.status(401).json({ success: false, error: 'Sesi tidak valid. Login ulang.' });
  }
  const session = activeTokens[token];
  if (Date.now() - session.createdAt > TOKEN_TTL) {
    delete activeTokens[token];
    return res.status(401).json({ success: false, error: 'Sesi kadaluarsa. Login ulang.' });
  }

  // === LOGOUT ===
  if (action === 'logout') {
    delete activeTokens[token];
    pushLog(clientIP, userAgent, '', 'admin_logout');
    return res.status(200).json({ success: true });
  }

  // === STATS ===
  if (action === 'stats') {
    const totalScrapes = state.logs.filter(l => l.action === 'scrape_success').length;
    const totalDownloads = state.logs.filter(l => l.action === 'download_zip').length;
    const totalBlocked = state.logs.filter(l => l.action.startsWith('attempt_protected')).length;
    const unreadNotifs = state.notifications.filter(n => !n.read).length;
    const recentActivity = state.logs.slice(0, 5).map(l => ({
      ip: l.ip,
      action: l.action,
      url: l.url,
      time: l.time
    }));
    return res.status(200).json({
      success: true,
      stats: {
        totalScrapes,
        totalDownloads,
        totalBlocked,
        bannedCount: Object.keys(state.bannedIPs).length,
        uniqueIPs: new Set(state.logs.map(l => l.ip)).size,
        unreadNotifs,
        settings: state.settings,
        uptime: process.uptime(),
        recentActivity
      }
    });
  }

  if (action === 'logs') {
    const limit = Math.min(parseInt(body.limit) || 200, 1000);
    return res.status(200).json({ success: true, logs: state.logs.slice(0, limit) });
  }

  if (action === 'attempts') {
    const arr = Object.keys(state.attempts).map(ip => ({
      ip,
      ...state.attempts[ip]
    })).sort((a, b) => b.count - a.count);
    return res.status(200).json({ success: true, attempts: arr });
  }

  if (action === 'banned') {
    const arr = Object.keys(state.bannedIPs).map(ip => ({
      ip,
      ...state.bannedIPs[ip]
    }));
    return res.status(200).json({ success: true, banned: arr });
  }

  if (action === 'ban') {
    const { ip, reason } = body;
    if (!ip) return res.status(400).json({ success: false, error: 'IP wajib diisi.' });
    state.bannedIPs[ip] = {
      reason: reason || 'Di-ban manual oleh admin',
      bannedAt: new Date().toISOString(),
      bannedBy: 'admin'
    };
    pushLog(clientIP, userAgent, '', 'admin_ban:' + ip);
    pushNotification('ip_banned_manual', 'Admin mem-ban IP ' + ip, ip, { reason });
    return res.status(200).json({ success: true });
  }

  if (action === 'unban') {
    const { ip } = body;
    if (!ip) return res.status(400).json({ success: false, error: 'IP wajib diisi.' });
    delete state.bannedIPs[ip];
    pushLog(clientIP, userAgent, '', 'admin_unban:' + ip);
    pushNotification('ip_unbanned', 'Admin membuka ban IP ' + ip, ip, null);
    return res.status(200).json({ success: true });
  }

  if (action === 'reset_attempts') {
    const { ip } = body;
    if (ip) delete state.attempts[ip];
    else state.attempts = {};
    pushLog(clientIP, userAgent, '', 'admin_reset_attempts:' + (ip || 'all'));
    return res.status(200).json({ success: true });
  }

  if (action === 'notifications') {
    return res.status(200).json({
      success: true,
      notifications: state.notifications.slice(0, 200)
    });
  }

  if (action === 'mark_read') {
    const { id } = body;
    if (id) {
      const n = state.notifications.find(x => x.id === id);
      if (n) n.read = true;
    } else {
      state.notifications.forEach(n => n.read = true);
    }
    return res.status(200).json({ success: true });
  }

  if (action === 'update_settings') {
    const { protectionEnabled, maxAttempts, notifyOnAttempt } = body;
    if (typeof protectionEnabled === 'boolean') state.settings.protectionEnabled = protectionEnabled;
    if (typeof maxAttempts === 'number' && maxAttempts > 0) state.settings.maxAttempts = maxAttempts;
    if (typeof notifyOnAttempt === 'boolean') state.settings.notifyOnAttempt = notifyOnAttempt;
    pushLog(clientIP, userAgent, '', 'admin_update_settings');
    return res.status(200).json({ success: true, settings: state.settings });
  }

  if (action === 'clear_logs') {
    state.logs = [];
    pushLog(clientIP, userAgent, '', 'admin_clear_logs');
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });
};
