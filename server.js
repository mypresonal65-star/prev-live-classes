const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8085;
const WORKER_TARGET = process.env.WORKER_TARGET || 'https://video-play-api.newstreamcp.workers.dev/api';

process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught Exception:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled Rejection:', reason);
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4'
};

const BLOCKED_FILES = new Set([
  'server.js',
  'sync_worker_to_supabase.js',
  'supabase_schema.sql',
  'package.json',
  'render.yaml',
  'admin-old.html',
  'admin.html.bak',
  'login.html.bak',
  'style.css.bak',
  'scratch_admin_old.txt'
]);

// ===== 👥 REAL-TIME ONLINE STUDENTS PRESENCE ENGINE =====
const activeStudentsMap = new Map();
const PRESENCE_TIMEOUT_MS = 45000; // 45 seconds timeout (students ping every 10-15s)
const ADMIN_EMAILS_SET = new Set(['stackbyujjwal@gmail.com', 'mj5000500@gmail.com']);

function pruneInactiveStudents() {
  const now = Date.now();
  for (const [email, user] of activeStudentsMap.entries()) {
    if (now - (user.lastSeen || 0) > PRESENCE_TIMEOUT_MS) {
      activeStudentsMap.delete(email);
    }
  }
}

function getCleanOnlineStudents() {
  pruneInactiveStudents();
  const list = [];
  for (const user of activeStudentsMap.values()) {
    const em = (user.email || '').toLowerCase().trim();
    if (!em || ADMIN_EMAILS_SET.has(em) || user.role === 'admin') continue;
    list.push({
      email: em,
      name: user.name || em.split('@')[0],
      role: 'student',
      page: user.page || 'portal',
      lastSeen: user.lastSeen
    });
  }
  return list;
}

// ===== 🛡️ HLS STREAM ENCRYPTION & SECURE PROXY VAULT =====
const STREAM_SECRET = process.env.STREAM_SECRET || 'spider_classes_master_vault_key_2026';
const KEY_BUFFER = crypto.createHash('sha256').update(STREAM_SECRET).digest();
const IV_BUFFER = Buffer.alloc(16, 0);

function encryptStreamUrl(url, expMinutes = 180) {
  const exp = Date.now() + (expMinutes * 60 * 1000);
  const payload = JSON.stringify({ u: url, e: exp });
  const cipher = crypto.createCipheriv('aes-256-cbc', KEY_BUFFER, IV_BUFFER);
  let enc = cipher.update(payload, 'utf8', 'base64');
  enc += cipher.final('base64');
  return Buffer.from(enc).toString('base64url');
}

function decryptStreamUrl(token) {
  try {
    const enc = Buffer.from(token, 'base64url').toString('utf8');
    const decipher = crypto.createDecipheriv('aes-256-cbc', KEY_BUFFER, IV_BUFFER);
    let dec = decipher.update(enc, 'base64', 'utf8');
    dec += decipher.final('utf8');
    const parsed = JSON.parse(dec);
    if (!parsed || !parsed.u) return null;
    if (parsed.e && Date.now() > parsed.e) return null; // Expired token
    return parsed.u;
  } catch (err) {
    return null;
  }
}

// 🛡️ SSRF Mitigation: Block private networks, loopbacks, and cloud metadata
function isSafeUpstreamUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '169.254.169.254' ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      return false;
    }
    // Block private IPv4 subnets (127.x, 10.x, 192.168.x, 172.16-31.x)
    if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  // Global CORS & Standard Security Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Health check endpoint for Render / Uptime monitoring
  const cleanReqUrl = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (cleanReqUrl === '/healthz' || cleanReqUrl === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', uptime: Math.round(process.uptime()), service: 'spider-classes' }));
  }

  // 🛡️ API: Generate Secure Stream Proxy Token (Hides real .m3u8 upstream from client)
  if (req.url.startsWith('/api/secure-stream-token')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const rawUrl = u.searchParams.get('url');
      if (!rawUrl || !isSafeUpstreamUrl(rawUrl)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing or disallowed stream URL' }));
      }
      const token = encryptStreamUrl(rawUrl, 180);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ 
        success: true,
        secureStreamUrl: `/stream-proxy.bin?t=${token}`
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // 🛡️ STREAM PROXY: Relays .m3u8 manifests and chunks with zero leak of original URL
  if (req.url.startsWith('/stream-proxy.bin') || req.url.startsWith('/stream-proxy')) {
    try {
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const token = u.searchParams.get('t');
      if (!token) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Access Denied: Missing stream token');
      }

      const targetUrl = decryptStreamUrl(token);
      if (!targetUrl || !isSafeUpstreamUrl(targetUrl)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Access Denied: Invalid or disallowed stream target');
      }

      const upstreamRes = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SpiderStreamer/2.0',
          'Referer': targetUrl
        }
      });

      if (!upstreamRes.ok) {
        res.writeHead(upstreamRes.status, { 'Content-Type': 'text/plain' });
        return res.end('Upstream stream error: ' + upstreamRes.status);
      }

      const contentType = upstreamRes.headers.get('content-type') || '';
      const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') || 
                     contentType.includes('mpegurl') || 
                     contentType.includes('application/x-mpegURL');

      if (isM3u8) {
        const text = await upstreamRes.text();
        const lines = text.split(/\r?\n/);
        const rewritten = lines.map(line => {
          const trimmed = line.trim();
          if (!trimmed) return line;
          if (trimmed.startsWith('#')) {
            return trimmed.replace(/URI=["']([^"']+)["']/g, (_, uri) => {
              try {
                const resolved = new URL(uri, targetUrl).href;
                if (!isSafeUpstreamUrl(resolved)) return _;
                return `URI="/stream-proxy.bin?t=${encryptStreamUrl(resolved, 180)}"`;
              } catch(e) { return _; }
            });
          }
          try {
            const resolved = new URL(trimmed, targetUrl).href;
            if (!isSafeUpstreamUrl(resolved)) return line;
            return `/stream-proxy.bin?t=${encryptStreamUrl(resolved, 180)}`;
          } catch(e) {
            return line;
          }
        }).join('\n');

        res.writeHead(200, {
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
          'Pragma': 'no-cache',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(rewritten);
      } else {
        // Binary media segment (.ts, .m4s, .aac, .mp4 chunk)
        const arrayBuf = await upstreamRes.arrayBuffer();
        res.writeHead(200, {
          'Content-Type': contentType || 'video/mp2t',
          'Cache-Control': 'private, max-age=120',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(Buffer.from(arrayBuf));
      }
    } catch(err) {
      console.error('Stream proxy error:', err.message);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      return res.end('Proxy streaming failed: ' + err.message);
    }
  }

  // ===== 👥 PRESENCE: STUDENT ONLINE HEARTBEAT =====
  if (req.url === '/api-local/heartbeat' || req.url === '/api/presence/heartbeat') {
    if (req.method === 'POST') {
      try {
        let totalLength = 0;
        const bodyChunks = [];
        const MAX_PAYLOAD = 32 * 1024;
        for await (const chunk of req) {
          totalLength += chunk.length;
          if (totalLength > MAX_PAYLOAD) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Payload too large' }));
          }
          bodyChunks.push(chunk);
        }
        const bodyStr = Buffer.concat(bodyChunks).toString('utf8');
        const parsed = JSON.parse(bodyStr || '{}');
        const email = (parsed.email || '').toLowerCase().trim();
        const role = (parsed.role || 'student').toLowerCase().trim();

        if (email && !ADMIN_EMAILS_SET.has(email) && role !== 'admin') {
          activeStudentsMap.set(email, {
            email: email,
            name: (parsed.name || email.split('@')[0]).trim(),
            role: 'student',
            page: parsed.page || 'portal',
            lastSeen: Date.now()
          });
        }
        const onlineUsers = getCleanOnlineStudents();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify({ success: true, count: onlineUsers.length, users: onlineUsers }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    }
  }

  // ===== 👥 PRESENCE: GET ONLINE STUDENTS LIST =====
  if (
    req.url === '/api-local/online-students' ||
    req.url === '/api/presence/active-users' ||
    req.url === '/api/active-users/list' ||
    req.url === '/api/active-users' ||
    req.url === '/api/active-users/'
  ) {
    const list = getCleanOnlineStudents();
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(JSON.stringify({
      success: true,
      activeCount: list.length,
      count: list.length,
      users: list
    }));
  }

  // ===== 👥 PRESENCE: STUDENT LOGOUT / DISCONNECT =====
  if (req.url === '/api-local/logout-student' || req.url === '/api/presence/leave') {
    if (req.method === 'POST') {
      try {
        const bodyChunks = [];
        for await (const chunk of req) bodyChunks.push(chunk);
        const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8') || '{}');
        const email = (parsed.email || '').toLowerCase().trim();
        if (email) activeStudentsMap.delete(email);
      } catch (e) {}
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify({ success: true }));
    }
  }

  // Local shared storage for chapter playlists mapping across all browsers
  if (req.url === '/api-local/chapter-playlists') {
    const configPath = path.join(__dirname, 'chapter_playlists.json');
    if (req.method === 'GET') {
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(content || '{}');
        }
      } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end('{}');
    }
    if (req.method === 'POST') {
      try {
        let totalLength = 0;
        const bodyChunks = [];
        const MAX_PAYLOAD = 512 * 1024; // 512KB limit
        for await (const chunk of req) {
          totalLength += chunk.length;
          if (totalLength > MAX_PAYLOAD) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Payload too large (max 512KB)' }));
          }
          bodyChunks.push(chunk);
        }
        const bodyStr = Buffer.concat(bodyChunks).toString('utf8');
        const parsed = JSON.parse(bodyStr);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ success: false, error: 'Invalid playlist mapping JSON structure' }));
        }
        fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, error: 'Malformed JSON: ' + e.message }));
      }
    }
  }

  // ===== 📢 TELEGRAM BOT CONFIGURATION API =====
  if (req.url === '/api-local/telegram-config') {
    const tgConfigPath = path.join(__dirname, 'telegram_config.json');
    if (req.method === 'GET') {
      try {
        if (fs.existsSync(tgConfigPath)) {
          const content = fs.readFileSync(tgConfigPath, 'utf8');
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          return res.end(content || '{}');
        }
      } catch (e) {}
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end('{}');
    }
    if (req.method === 'POST') {
      try {
        let totalLength = 0;
        const bodyChunks = [];
        for await (const chunk of req) {
          totalLength += chunk.length;
          if (totalLength > 100 * 1024) {
            res.writeHead(413, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: false, error: 'Payload too large' }));
          }
          bodyChunks.push(chunk);
        }
        const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
        fs.writeFileSync(tgConfigPath, JSON.stringify(parsed, null, 2), 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    }
  }

  // ===== 📢 TELEGRAM BOT MESSAGE DISPATCH PROXY =====
  if (req.url === '/api-local/send-telegram' && req.method === 'POST') {
    try {
      let totalLength = 0;
      const bodyChunks = [];
      for await (const chunk of req) {
        totalLength += chunk.length;
        if (totalLength > 200 * 1024) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, description: 'Payload too large' }));
        }
        bodyChunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(bodyChunks).toString('utf8') || '{}');
      const token = (data.token || '').trim();
      const chatId = (data.chatId || '').trim();
      const text = data.text || '';
      const threadId = data.message_thread_id || data.threadId || data.topicId || null;

      if (!token || !chatId || !text) {
        res.writeHead(400, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify({ ok: false, description: 'Missing token, chatId or text' }));
      }

      const postPayload = {
        chat_id: chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: false
      };
      if (threadId && !isNaN(Number(threadId)) && Number(threadId) > 0) {
        postPayload.message_thread_id = Number(threadId);
      }
      if (data.reply_markup) {
        postPayload.reply_markup = data.reply_markup;
      }

      const postData = JSON.stringify(postPayload);

      const tgReq = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      }, (tgRes) => {
        let respData = '';
        tgRes.on('data', (d) => { respData += d; });
        tgRes.on('end', () => {
          res.writeHead(tgRes.statusCode, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(respData);
        });
      });

      tgReq.on('error', (e) => {
        res.writeHead(500, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        res.end(JSON.stringify({ ok: false, description: e.message }));
      });

      tgReq.write(postData);
      tgReq.end();
      return;
    } catch (e) {
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      return res.end(JSON.stringify({ ok: false, description: e.message }));
    }
  }

  // ===== 👥 CLOUDFLARE USERS & NAMES BRIDGING JUGAD =====
  if (req.url === '/api/users' || req.url.startsWith('/api/users?')) {
    const metaPath = path.join(__dirname, 'students_metadata.json');
    let namesMap = {};
    try {
      if (fs.existsSync(metaPath)) {
        namesMap = JSON.parse(fs.readFileSync(metaPath, 'utf8') || '{}');
      }
    } catch (e) {}

    if (req.method === 'GET') {
      try {
        const proxyRes = await fetch(WORKER_TARGET + '/users', {
          method: 'GET',
          headers: { 'Origin': 'null', 'Content-Type': 'application/json' }
        });
        const cfData = await proxyRes.json();
        if (cfData && Array.isArray(cfData.users)) {
          cfData.users = cfData.users.map(u => {
            const em = (u.email || '').toLowerCase().trim();
            const realName = namesMap[em] || u.name;
            return {
              ...u,
              name: realName || (em.split('@')[0])
            };
          });
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify(cfData));
      } catch (err) {
        // Fallback to standard proxy below
      }
    }

    if (req.method === 'POST') {
      try {
        const bodyChunks = [];
        for await (const chunk of req) bodyChunks.push(chunk);
        const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8') || '{}');
        const em = (parsed.email || '').toLowerCase().trim();
        const nm = (parsed.name || '').trim();
        if (em && nm) {
          namesMap[em] = nm;
          try { fs.writeFileSync(metaPath, JSON.stringify(namesMap, null, 2), 'utf8'); } catch (e) {}
        }
        // Forward to Cloudflare Worker (best-effort)
        fetch(WORKER_TARGET + '/users', {
          method: 'POST',
          headers: { 'Origin': 'null', 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: em })
        }).catch(() => {});

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify({ success: true, message: 'Student profile synced with Cloudflare', name: nm, email: em }));
      } catch (err) {
        // Fallback to standard proxy below
      }
    }

    if (req.method === 'DELETE') {
      try {
        const bodyChunks = [];
        for await (const chunk of req) bodyChunks.push(chunk);
        const parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8') || '{}');
        const em = (parsed.email || '').toLowerCase().trim();
        let targetWorkerId = parsed.userId;

        // 1. Remove from local students_metadata.json
        if (em && namesMap[em]) {
          delete namesMap[em];
          try { fs.writeFileSync(metaPath, JSON.stringify(namesMap, null, 2), 'utf8'); } catch (e) {}
        }

        // 2. If targetWorkerId is not a Worker ID (usr_...) or missing, lookup by email from Worker
        if ((!targetWorkerId || !targetWorkerId.startsWith('usr_')) && em) {
          try {
            const listRes = await fetch(WORKER_TARGET + '/users', {
              method: 'GET',
              headers: { 'Origin': 'null', 'Content-Type': 'application/json' }
            });
            const listData = await listRes.json();
            if (listData && Array.isArray(listData.users)) {
              const matched = listData.users.find(u => (u.email || '').toLowerCase().trim() === em);
              if (matched && matched.id) {
                targetWorkerId = matched.id;
              }
            }
          } catch (e) {}
        }

        // 3. Delete from Worker /users
        if (targetWorkerId && targetWorkerId.startsWith('usr_')) {
          await fetch(WORKER_TARGET + '/users', {
            method: 'DELETE',
            headers: { 'Origin': 'null', 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: targetWorkerId })
          }).catch(() => {});
        }

        // 4. Delete from Worker /allowed-emails
        if (em) {
          fetch(WORKER_TARGET + '/allowed-emails', {
            method: 'DELETE',
            headers: { 'Origin': 'null', 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: em })
          }).catch(() => {});
        }

        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        });
        return res.end(JSON.stringify({ success: true, message: 'Student deleted from Worker and metadata' }));
      } catch (err) {
        // Fallback to standard proxy below
      }
    }
  }

  // Proxy /api/* requests to Cloudflare Worker with Origin: null
  if (req.url.startsWith('/api/')) {
    const targetUrl = WORKER_TARGET + req.url.substring(4);
    try {
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const bodyBuffer = Buffer.concat(bodyChunks);

      const fetchOptions = {
        method: req.method,
        headers: {
          'Origin': 'null',
          'Content-Type': req.headers['content-type'] || 'application/json'
        }
      };
      if (req.method !== 'GET' && req.method !== 'HEAD' && bodyBuffer.length > 0) {
        fetchOptions.body = bodyBuffer;
      }

      const proxyRes = await fetch(targetUrl, fetchOptions);
      const data = await proxyRes.arrayBuffer();

      res.writeHead(proxyRes.status, {
        'Content-Type': proxyRes.headers.get('content-type') || 'application/json'
      });
      return res.end(Buffer.from(data));
    } catch (err) {
      console.error('Proxy error:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'Proxy failed: ' + err.message }));
    }
  }

  // 🛡️ Serve static files with strict root containment and sensitive file guards
  let decodedPath = '';
  try {
    decodedPath = decodeURIComponent(req.url.split('?')[0]);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request');
  }

  if (decodedPath === '/' || decodedPath === '') decodedPath = '/index.html';

  const resolvedDir = path.resolve(__dirname);
  let candidatePath = path.resolve(resolvedDir, '.' + decodedPath);

  // Strictly verify candidatePath is contained within resolvedDir (Path Traversal Defense)
  if (!candidatePath.startsWith(resolvedDir + path.sep) && candidatePath !== resolvedDir) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Access Denied');
  }

  // Support clean URLs without .html extension (e.g. /player -> /player.html)
  if (!fs.existsSync(candidatePath) && fs.existsSync(candidatePath + '.html')) {
    candidatePath = candidatePath + '.html';
  }

  const baseName = path.basename(candidatePath).toLowerCase();
  const ext = path.extname(candidatePath).toLowerCase();

  // Block hidden files, system files, and unallowed file extensions
  if (
    baseName.startsWith('.') ||
    BLOCKED_FILES.has(baseName) ||
    ext === '.bak' ||
    ext === '.sql' ||
    ext === '.env' ||
    ext === '.yaml' ||
    ext === '.yml' ||
    ext === '.bat' ||
    ext === '.sh' ||
    !MIME_TYPES[ext]
  ) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }

  fs.stat(candidatePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN'
    });
    fs.createReadStream(candidatePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Spider Classes Server running on port ${PORT}`);
});
