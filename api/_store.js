const crypto = require('crypto');

// Secret untuk signing token admin. Bisa diganti via Environment Variable di Vercel.
const TOKEN_SECRET = process.env.ADMIN_SECRET || 'egaa-scrape-default-secret-key-2026';

// In-memory store.
// Catatan: data reset saat Vercel cold start. Untuk permanen, gunakan Vercel KV.
const state = {
  bannedIPs: {},
  attempts: {},
  logs: [],
  notifications: [],
  settings: {
    protectionEnabled: true,
    maxAttempts: 3,
    notifyOnAttempt: true
  }
};

function getClientIP(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function pushNotification(type, message, ip, extra) {
  const notif = {
    id: 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    ip: ip || null,
    time: new Date().toISOString(),
    type,
    message,
    read: false,
    extra: extra || null
  };
  state.notifications.unshift(notif);
  if (state.notifications.length > 500) state.notifications.length = 500;
  return notif;
}

function pushLog(ip, userAgent, url, action) {
  const log = {
    id: 'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
    ip,
    userAgent: userAgent || '',
    url: url || '',
    action,
    time: new Date().toISOString()
  };
  state.logs.unshift(log);
  if (state.logs.length > 2000) state.logs.length = 2000;
  return log;
}

// ============ SIGNED TOKEN (stateless, tahan cold start) ============
function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function signToken(payload, ttlMs) {
  const exp = Date.now() + (ttlMs || 7 * 24 * 60 * 60 * 1000);
  const body = { exp, ...payload };
  const json = JSON.stringify(body);
  const data = base64url(json);
  const sig = base64url(crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest());
  return data + '.' + sig;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  const expected = base64url(crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest());
  if (sig !== expected) return null;
  try {
    const payload = JSON.parse(base64urlDecode(data));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = {
  state,
  getClientIP,
  pushNotification,
  pushLog,
  signToken,
  verifyToken,
  TOKEN_SECRET
};
