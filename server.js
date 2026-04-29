const express = require('express');
const compression = require('compression');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const PUBLIC_HOSTS = new Set(
  (process.env.PUBLIC_HOSTS || 'penqda.com,www.penqda.com')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
);
const ACTIVATION_ONLY_PUBLIC_HOSTS = new Set(
  (process.env.ACTIVATION_ONLY_PUBLIC_HOSTS || 'panqda.com,www.panqda.com')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean)
);
const ALL_PUBLIC_HOSTS = new Set([...PUBLIC_HOSTS, ...ACTIVATION_ONLY_PUBLIC_HOSTS]);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const publicRateBuckets = new Map();
const adminSessions = new Map();
const ADMIN_SESSION_COOKIE = 'openai_monitor_admin_session';
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const publicDir = path.join(__dirname, 'public');
const maintenancePagePath = path.join(__dirname, 'public', 'maintenance.html');
const activationOnlyPagePath = path.join(__dirname, 'public', 'activation-only.html');
const getSettingValueStmt = db.prepare('SELECT value FROM settings WHERE key = ?');

function isPublicHost(req) {
  const hostname = String(req.hostname || '').toLowerCase();
  return ALL_PUBLIC_HOSTS.has(hostname);
}

function isActivationOnlyPublicHost(req) {
  const hostname = String(req.hostname || '').toLowerCase();
  return ACTIVATION_ONLY_PUBLIC_HOSTS.has(hostname);
}

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return true;
  }

  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return ALL_PUBLIC_HOSTS.has(hostname) || LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function getSettingValue(key, fallback = '') {
  const row = getSettingValueStmt.get(key);
  return row ? row.value : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getAdminBasicAuthConfig() {
  const user = String(process.env.ADMIN_BASIC_AUTH_USER || getSettingValue('admin_basic_auth_user', '')).trim();
  const pass = String(process.env.ADMIN_BASIC_AUTH_PASS || getSettingValue('admin_basic_auth_pass', '')).trim();
  const enabled = parseBoolean(
    process.env.ADMIN_BASIC_AUTH_ENABLED ?? getSettingValue('admin_basic_auth_enabled', user && pass ? 'true' : 'false'),
    Boolean(user && pass)
  );

  return {
    enabled,
    user,
    pass,
  };
}

function isLoopbackRequest(req) {
  const remoteAddress = String(req.socket?.remoteAddress || req.ip || '').trim().toLowerCase();
  return LOOPBACK_IPS.has(remoteAddress) || remoteAddress.startsWith('::ffff:127.0.0.1');
}

function isInternalBypassRequest(req) {
  if (!isLoopbackRequest(req)) {
    return false;
  }

  return String(req.get('x-openai-monitor-internal') || '').trim() === '1';
}

function setStaticCacheHeaders(res, filePath) {
  const relativePath = path.relative(publicDir, filePath).replace(/\\/g, '/').toLowerCase();
  const extension = path.extname(relativePath);

  if (extension === '.html') {
    res.setHeader('Cache-Control', 'no-store');
    return;
  }

  if (relativePath.startsWith('js/') || relativePath.startsWith('css/')) {
    res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
    return;
  }

  if (relativePath.startsWith('assets/')) {
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return;
  }

  res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeAdminNextPath(value = '/') {
  const raw = String(value || '/').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/admin-login')) {
    return '/';
  }

  return raw || '/';
}

function parseCookies(header = '') {
  return String(header || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const splitIndex = part.indexOf('=');
      if (splitIndex < 0) {
        return accumulator;
      }

      const key = decodeURIComponent(part.slice(0, splitIndex).trim());
      const value = decodeURIComponent(part.slice(splitIndex + 1).trim());
      accumulator[key] = value;
      return accumulator;
    }, {});
}

function appendSetCookie(res, value) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', value);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, value]);
    return;
  }

  res.setHeader('Set-Cookie', [existing, value]);
}

function getAdminSessionToken(req) {
  const cookies = parseCookies(req.get('cookie') || '');
  return String(cookies[ADMIN_SESSION_COOKIE] || '').trim();
}

function clearExpiredAdminSessions() {
  const now = Date.now();
  for (const [token, session] of adminSessions.entries()) {
    if (!session || session.expiresAt <= now) {
      adminSessions.delete(token);
    }
  }
}

function hasValidAdminSession(req) {
  clearExpiredAdminSessions();
  const token = getAdminSessionToken(req);
  if (!token) {
    return false;
  }

  const session = adminSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return false;
  }

  session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  return true;
}

function createAdminSession(username) {
  clearExpiredAdminSessions();
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, {
    username,
    expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
  });
  return token;
}

function setAdminSessionCookie(res, token) {
  appendSetCookie(res, `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearAdminSessionCookie(res) {
  appendSetCookie(res, `${ADMIN_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function renderAdminLoginPage({ errorMessage = '', nextPath = '/' } = {}) {
  const safeNextPath = escapeHtml(normalizeAdminNextPath(nextPath));
  const safeErrorMessage = errorMessage ? `<div class="admin-login-error">${escapeHtml(errorMessage)}</div>` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>后台登录</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0b1220;
      --panel: rgba(15, 23, 42, 0.92);
      --border: rgba(148, 163, 184, 0.22);
      --accent: #4f8cff;
      --text: #e5eefc;
      --muted: #9fb0cb;
      --danger-bg: rgba(239, 68, 68, 0.14);
      --danger-border: rgba(248, 113, 113, 0.32);
      --danger-text: #fecaca;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        radial-gradient(circle at top, rgba(79, 140, 255, 0.18), transparent 36%),
        linear-gradient(180deg, #0b1220 0%, #111c33 100%);
      color: var(--text);
    }

    .admin-login-card {
      width: min(100%, 420px);
      padding: 28px;
      border-radius: 20px;
      background: var(--panel);
      border: 1px solid var(--border);
      box-shadow: 0 28px 60px rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(10px);
    }

    h1 {
      margin: 0 0 10px;
      font-size: 30px;
      line-height: 1.1;
    }

    p {
      margin: 0 0 22px;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.6;
    }

    label {
      display: block;
      margin-bottom: 8px;
      font-size: 14px;
      font-weight: 600;
    }

    input {
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(15, 23, 42, 0.84);
      color: var(--text);
      padding: 14px 16px;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      margin-bottom: 16px;
    }

    input:focus {
      border-color: rgba(79, 140, 255, 0.78);
      box-shadow: 0 0 0 4px rgba(79, 140, 255, 0.16);
    }

    button {
      width: 100%;
      border: none;
      border-radius: 14px;
      background: linear-gradient(135deg, #4f8cff, #3f75ff);
      color: #fff;
      padding: 14px 16px;
      font-size: 15px;
      font-weight: 700;
      cursor: pointer;
    }

    .admin-login-error {
      margin-bottom: 16px;
      border: 1px solid var(--danger-border);
      background: var(--danger-bg);
      color: var(--danger-text);
      border-radius: 12px;
      padding: 12px 14px;
      font-size: 14px;
    }

    .admin-login-hint {
      margin-top: 16px;
      font-size: 13px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <form class="admin-login-card" method="post" action="/admin-login" autocomplete="off">
    <h1>后台登录</h1>
    <p>每次新开浏览器访问后台都需要先验证账号密码。</p>
    ${safeErrorMessage}
    <input type="hidden" name="next" value="${safeNextPath}">
    <label for="username">账号</label>
    <input id="username" name="username" type="text" autocomplete="username" required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">登录后台</button>
    <div class="admin-login-hint">关闭浏览器后，会话会失效，需要重新登录。</div>
  </form>
</body>
</html>`;
}

function enforceAdminSessionAuth(req, res, next) {
  if (req.isPublicHost || isInternalBypassRequest(req)) {
    return next();
  }

  const config = getAdminBasicAuthConfig();
  if (!config.enabled || !config.user || !config.pass) {
    return next();
  }

  if (req.path === '/admin-login' || req.path === '/admin-logout') {
    return next();
  }

  if (hasValidAdminSession(req)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  return res.redirect(302, `/admin-login?next=${encodeURIComponent(normalizeAdminNextPath(req.originalUrl || req.url || '/'))}`);
}

function isPublicTunnelEnabled() {
  return getSettingValue('public_tunnel_enabled', 'true') !== 'false';
}

function sendPublicMaintenance(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.path.startsWith('/api/')) {
    return res.status(503).json({ error: '站点维护中，请稍后再试' });
  }

  return res.status(503).sendFile(maintenancePagePath);
}

function getClientKey(req) {
  return String(
    req.get('cf-connecting-ip')
      || req.get('x-forwarded-for')?.split(',')[0]
      || req.ip
      || req.socket?.remoteAddress
      || 'unknown'
  ).trim();
}

function getPublicRateLimit(req) {
  const pathOnly = req.path;

  if (req.method === 'POST' && pathOnly === '/api/payments/orders') {
    return { windowMs: 10 * 60 * 1000, max: 10 };
  }

  if (req.method === 'POST' && pathOnly === '/api/payments/orders/batch') {
    return { windowMs: 10 * 60 * 1000, max: 4 };
  }

  if (req.method === 'GET' && /^\/api\/payments\/orders\/[^/]+$/.test(pathOnly)) {
    return { windowMs: 5 * 60 * 1000, max: 120 };
  }

  if (req.method === 'GET' && /^\/api\/payments\/status\/[^/]+$/.test(pathOnly)) {
    return { windowMs: 5 * 60 * 1000, max: 120 };
  }

  if (req.method === 'POST' && pathOnly === '/api/payments/query-by-email') {
    return { windowMs: 10 * 60 * 1000, max: 20 };
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/verify') {
    return { windowMs: 10 * 60 * 1000, max: 25 };
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/submit-team') {
    return { windowMs: 10 * 60 * 1000, max: 10 };
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/submit-team-batch') {
    return { windowMs: 10 * 60 * 1000, max: 5 };
  }

  if (req.method === 'POST' && (
    pathOnly === '/api/payments/alipay/notify'
    || pathOnly === '/api/payments/alipay/notify/'
  )) {
    return { windowMs: 10 * 60 * 1000, max: 120 };
  }

  if (req.method === 'GET' && /^\/api\/cdk\/query\/[^/]+$/.test(pathOnly)) {
    return { windowMs: 5 * 60 * 1000, max: 120 };
  }

  return null;
}

function enforcePublicRateLimit(req, res, next) {
  if (!req.isPublicHost) {
    return next();
  }

  const limit = getPublicRateLimit(req);
  if (!limit) {
    return next();
  }

  const now = Date.now();
  const key = `${getClientKey(req)}:${req.method}:${req.path}`;
  let bucket = publicRateBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + limit.windowMs };
  }

  bucket.count += 1;
  publicRateBuckets.set(key, bucket);

  if (publicRateBuckets.size > 2000) {
    for (const [bucketKey, value] of publicRateBuckets.entries()) {
      if (value.resetAt <= now) {
        publicRateBuckets.delete(bucketKey);
      }
    }
  }

  res.setHeader('X-RateLimit-Limit', String(limit.max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit.max - bucket.count)));
  res.setHeader('Retry-After', String(Math.ceil(Math.max(0, bucket.resetAt - now) / 1000)));

  if (bucket.count > limit.max) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }

  return next();
}

function isAllowedActivationOnlyPublicRequest(req) {
  const pathOnly = req.path;
  const isReadMethod = req.method === 'GET' || req.method === 'HEAD';

  if (isReadMethod && ['/', '/join', '/join.html', '/favicon.ico'].includes(pathOnly)) {
    return true;
  }

  if (isReadMethod && pathOnly.startsWith('/assets/')) {
    return true;
  }

  if (isReadMethod && pathOnly === '/api/payments/product') {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/verify') {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/submit-team') {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/submit-team-batch') {
    return true;
  }

  if (isReadMethod && /^\/api\/cdk\/query\/[^/]+$/.test(pathOnly)) {
    return true;
  }

  return false;
}

function isAllowedPublicRequest(req) {
  if (req.isActivationOnlyPublicHost) {
    return isAllowedActivationOnlyPublicRequest(req);
  }

  const pathOnly = req.path;
  const isReadMethod = req.method === 'GET' || req.method === 'HEAD';

  if (isReadMethod && ['/', '/buy', '/join', '/buy.html', '/join.html', '/favicon.ico'].includes(pathOnly)) {
    return true;
  }

  if (isReadMethod && pathOnly.startsWith('/assets/')) {
    return true;
  }

  if (isReadMethod && pathOnly === '/api/payments/product') {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/payments/orders') {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/payments/orders/batch') {
    return true;
  }

  if (isReadMethod && /^\/api\/payments\/orders\/[^/]+$/.test(pathOnly)) {
    return true;
  }

  if (isReadMethod && /^\/api\/payments\/status\/[^/]+$/.test(pathOnly)) {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/payments/query-by-email') {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/payments/webhook/generic') {
    return true;
  }

  if (req.method === 'POST' && (
    pathOnly === '/api/payments/alipay/notify'
    || pathOnly === '/api/payments/alipay/notify/'
  )) {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/verify') {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/submit-team') {
    return true;
  }

  if (req.method === 'POST' && pathOnly === '/api/cdk/submit-team-batch') {
    return true;
  }

  if (isReadMethod && /^\/api\/cdk\/query\/[^/]+$/.test(pathOnly)) {
    return true;
  }

  return false;
}

// Middleware
app.use(cors({
  origin(origin, callback) {
    callback(null, isAllowedCorsOrigin(origin) ? origin || false : false);
  },
}));
app.use(compression({ threshold: 1024 }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  req.isPublicHost = isPublicHost(req) && isLoopbackRequest(req);
  req.isActivationOnlyPublicHost = isActivationOnlyPublicHost(req) && isLoopbackRequest(req);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(enforceAdminSessionAuth);
app.use(enforcePublicRateLimit);
app.use((req, res, next) => {
  if (!req.isPublicHost) {
    return next();
  }

  if (!isPublicTunnelEnabled()) {
    return sendPublicMaintenance(req, res);
  }

  if (req.isActivationOnlyPublicHost) {
    const isReadMethod = req.method === 'GET' || req.method === 'HEAD';
    if (isReadMethod && ['/', '/join', '/join.html'].includes(req.path)) {
      res.setHeader('Cache-Control', 'no-store');
      return res.sendFile(activationOnlyPagePath);
    }
    if (isReadMethod && ['/buy', '/buy.html'].includes(req.path)) {
      return res.redirect(302, '/');
    }
  }

  if (req.path === '/') {
    return res.redirect(302, '/buy');
  }

  if (!isAllowedPublicRequest(req)) {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({ error: 'Not found' });
    }
    return res.status(404).send('Not found');
  }

  return next();
});

app.get('/admin-login', (req, res) => {
  if (req.isPublicHost) {
    return res.status(404).send('Not found');
  }

  const config = getAdminBasicAuthConfig();
  const nextPath = normalizeAdminNextPath(req.query.next || '/');
  if (!config.enabled || !config.user || !config.pass) {
    return res.redirect(302, nextPath);
  }

  if (hasValidAdminSession(req)) {
    return res.redirect(302, nextPath);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).send(renderAdminLoginPage({ nextPath }));
});

app.post('/admin-login', (req, res) => {
  if (req.isPublicHost) {
    return res.status(404).send('Not found');
  }

  const config = getAdminBasicAuthConfig();
  const nextPath = normalizeAdminNextPath(req.body.next || req.query.next || '/');
  if (!config.enabled || !config.user || !config.pass) {
    return res.redirect(302, nextPath);
  }

  const submittedUser = String(req.body.username || '').trim();
  const submittedPass = String(req.body.password || '');
  if (
    timingSafeEqualText(submittedUser, config.user)
    && timingSafeEqualText(submittedPass, config.pass)
  ) {
    const sessionToken = createAdminSession(config.user);
    setAdminSessionCookie(res, sessionToken);
    return res.redirect(302, nextPath);
  }

  res.setHeader('Cache-Control', 'no-store');
  return res.status(401).send(renderAdminLoginPage({
    errorMessage: '账号或密码错误，请重新输入。',
    nextPath,
  }));
});

app.get('/admin-logout', (req, res) => {
  const sessionToken = getAdminSessionToken(req);
  if (sessionToken) {
    adminSessions.delete(sessionToken);
  }
  clearAdminSessionCookie(res);
  return res.redirect(302, '/admin-login');
});

app.use(express.static(publicDir, {
  etag: true,
  lastModified: true,
  setHeaders: setStaticCacheHeaders,
}));

// API Routes
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/checks', require('./routes/checks'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/system', require('./routes/system'));
app.use('/api/invites', require('./routes/invites'));
app.use('/api/members', require('./routes/members'));
app.use('/api/workspaces', require('./routes/workspaces'));
app.use('/api/checkout-tools', require('./routes/checkout-tools'));
app.use('/api/cdk', require('./routes/cdk'));
app.use('/api/payments', require('./routes/payments'));

// CDK purchase page
app.get('/buy', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'buy.html'));
});

// Team invitation redemption page
app.get('/join', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'join.html'));
});

// CDK Redemption page (customer-facing, standalone)
app.get('/redeem', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'redeem.html'));
});

app.use('/api/store', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.get(['/shop', '/activate', '/store-admin', '/shop.html', '/activate.html', '/store-admin.html'], (req, res) => {
  res.status(404).send('Not found');
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, BIND_HOST, () => {
  console.log(`\n🚀 OpenAI Monitor running at http://${BIND_HOST}:${PORT}\n`);

  // Start the scheduler
  const scheduler = require('./services/scheduler');
  const telegramControl = require('./services/telegram-control');
  scheduler.startScheduler();
  telegramControl.startTelegramControl({
    baseUrl: `http://127.0.0.1:${PORT}`,
  }).catch(err => {
    console.error('[TelegramControl] Failed to start:', err.message);
  });
});
