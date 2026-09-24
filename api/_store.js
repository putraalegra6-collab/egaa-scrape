// In-memory store. Reset saat cold start Vercel.
// Untuk permanen, isi environment variable KV_REST_API_URL & KV_REST_API_TOKEN dari Vercel KV.

const state = {
  bannedIPs: {},        // { ip: { reason, bannedAt, bannedBy } }
  attempts: {},         // { ip: { count, firstSeen, lastSeen, userAgent, urls } }
  logs: [],             // array of { id, ip, userAgent, url, action, time }
  notifications: [],    // array of { id, ip, time, type, message, read }
  settings: {
    protectionEnabled: true,
    maxAttempts: 3,
    notifyOnAttempt: true
  }
};

// Optional Vercel KV
let kvClient = null;
async function getKV() {
  if (kvClient) return kvClient;
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const { createClient } = require('@vercel/kv');
      kvClient = createClient({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN
      });
      return kvClient;
    } catch (e) {
      return null;
    }
  }
  return null;
}

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

module.exports = {
  state,
  getKV,
  getClientIP,
  pushNotification,
  pushLog
};
