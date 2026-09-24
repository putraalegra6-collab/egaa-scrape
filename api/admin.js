const { state, getClientIP, pushLog, pushNotification, signToken, verifyToken } = require('./_store');

const ADMIN_PASSWORD = 'alegra123';

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
    const { password, remember } = body;
    pushLog(clientIP, userAgent, '', 'admin_login_attempt');

    if (String(password || '') !== ADMIN_PASSWORD) {
      pushLog(clientIP, userAgent, '', 'admin_login_failed');
      pushNotification('admin_login_failed', 'Percobaan login admin gagal', clientIP, null);
      return res.status(401).json({ success: false, error: 'Password salah.' });
    }

    const ttl = remember ? 30 * 24 * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
    const token = signToken({ ip: clientIP, remember: !!remember }, ttl);

    pushLog(clientIP, userAgent, '', 'admin_login_success');
    pushNotification('admin_login', 'Admin berhasil login', clientIP, null);

    return res.status(200).json({ success: true, token });
  }

  // === VERIFY ===
  if (action === 'verify') {
    const token = req.headers['x-admin-token'] || (body && body.token);
    const payload = verifyToken(token);
    return res.status(200).json({ success: true, valid: !!payload });
  }

  // === AUTH ===
  const token = req.headers['x-admin-token'] || (body && body.token);
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ success: false, error: 'Sesi tidak valid. Login ulang.' });

  if (action === 'logout') {
    pushLog(clientIP, userAgent, '', 'admin_logout');
    return res.status(200).json({ success: true });
  }

  // ============ STATS ============
  if (action === 'stats') {
    const logs = state.logs;
    const totalScrapes = logs.filter(l => l.action === 'scrape_success').length;
    const totalDownloads = logs.filter(l => l.action === 'download_zip').length;
    const totalErrors = logs.filter(l => l.action.startsWith('scrape_error')).length;
    const totalBlocked = logs.filter(l => l.action.startsWith('attempt_protected')).length;
    const totalLoginAttempts = logs.filter(l => l.action.startsWith('admin_login')).length;

    // Hitung user unik
    const uniqueIPs = new Set(logs.map(l => l.ip)).size;

    // Top user (paling sering pakai)
    const ipCount = {};
    logs.filter(l => l.action === 'scrape_success').forEach(l => {
      ipCount[l.ip] = (ipCount[l.ip] || 0) + 1;
    });
    const topUsers = Object.entries(ipCount)
      .map(([ip, count]) => ({ ip, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // Aktivitas 24 jam terakhir
    const now = Date.now();
    const last24h = logs.filter(l => now - new Date(l.time).getTime() < 24*60*60*1000);
    const scrapes24h = last24h.filter(l => l.action === 'scrape_success').length;

    // Website yang paling sering dicopy
    const siteCount = {};
    logs.filter(l => l.action === 'scrape_success' && l.url).forEach(l => {
      try {
        const host = new URL(l.url).hostname;
        siteCount[host] = (siteCount[host] || 0) + 1;
      } catch {}
    });
    const topSites = Object.entries(siteCount)
      .map(([host, count]) => ({ host, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    // Aktivitas 5 terbaru
    const recentActivity = logs.slice(0, 8).map(l => ({
      ip: l.ip, action: l.action, url: l.url, time: l.time
    }));

    // Timeline per jam (24 jam)
    const timeline = [];
    for (let i = 23; i >= 0; i--) {
      const start = now - i * 3600 * 1000;
      const end = start + 3600 * 1000;
      const count = logs.filter(l => {
        const t = new Date(l.time).getTime();
        return l.action === 'scrape_success' && t >= start && t < end;
      }).length;
      timeline.push({ hour: new Date(start).getHours(), count });
    }

    return res.status(200).json({
      success: true,
      stats: {
        totalScrapes, totalDownloads, totalErrors, totalBlocked, totalLoginAttempts,
        uniqueIPs, topUsers, topSites, recentActivity, timeline,
        scrapes24h,
        uptime: process.uptime()
      }
    });
  }

  // ============ HISTORY SALIN ============
  if (action === 'history') {
    const limit = Math.min(parseInt(body.limit) || 100, 500);
    const successLogs = state.logs
      .filter(l => l.action === 'scrape_success' && l.url)
      .slice(0, limit)
      .map(l => {
        let host = '';
        try { host = new URL(l.url).hostname; } catch {}
        return {
          id: l.id,
          ip: l.ip,
          url: l.url,
          host,
          userAgent: l.userAgent,
          time: l.time
        };
      });
    return res.status(200).json({ success: true, history: successLogs });
  }

  // ============ USERS (siapa saja yang pakai) ============
  if (action === 'users') {
    const ipMap = {};
    state.logs.forEach(l => {
      if (!ipMap[l.ip]) {
        ipMap[l.ip] = {
          ip: l.ip,
          userAgent: l.userAgent,
          firstSeen: l.time,
          lastSeen: l.time,
          totalScrapes: 0,
          totalDownloads: 0,
          totalErrors: 0,
          totalBlocked: 0,
          sites: {}
        };
      }
      const u = ipMap[l.ip];
      u.lastSeen = l.time;
      if (l.userAgent) u.userAgent = l.userAgent;
      if (l.action === 'scrape_success') {
        u.totalScrapes++;
        if (l.url) {
          try {
            const host = new URL(l.url).hostname;
            u.sites[host] = (u.sites[host] || 0) + 1;
          } catch {}
        }
      }
      if (l.action === 'download_zip') u.totalDownloads++;
      if (l.action.startsWith('scrape_error')) u.totalErrors++;
      if (l.action.startsWith('attempt_protected')) u.totalBlocked++;
    });

    const users = Object.values(ipMap).map(u => ({
      ...u,
      sites: Object.entries(u.sites).map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count)
    })).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));

    return res.status(200).json({ success: true, users });
  }

  // ============ LOGS ============
  if (action === 'logs') {
    const limit = Math.min(parseInt(body.limit) || 200, 1000);
    return res.status(200).json({ success: true, logs: state.logs.slice(0, limit) });
  }

  // ============ NOTIFIKASI ============
  if (action === 'notifications') {
    return res.status(200).json({ success: true, notifications: state.notifications.slice(0, 200) });
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

  if (action === 'clear_logs') {
    state.logs = [];
    pushLog(clientIP, userAgent, '', 'admin_clear_logs');
    return res.status(200).json({ success: true });
  }

  if (action === 'clear_history') {
    state.logs = state.logs.filter(l => l.action !== 'scrape_success');
    pushLog(clientIP, userAgent, '', 'admin_clear_history');
    return res.status(200).json({ success: true });
  }

  return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });
};
