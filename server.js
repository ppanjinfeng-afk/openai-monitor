const express = require('express');
const cors = require('cors');
const path = require('path');
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
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const publicRateBuckets = new Map();
const maintenancePagePath = path.join(__dirname, 'public', 'maintenance.html');
const getSettingValueStmt = db.prepare('SELECT value FROM settings WHERE key = ?');

function isPublicHost(req) {
  const hostname = String(req.hostname || '').toLowerCase();
  return PUBLIC_HOSTS.has(hostname);
}

function isAllowedCorsOrigin(origin) {
  if (!origin) {
    return true;
  }

  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return PUBLIC_HOSTS.has(hostname) || LOCAL_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

function getSettingValue(key, fallback = '') {
  const row = getSettingValueStmt.get(key);
  return row ? row.value : fallback;
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

function isAllowedPublicRequest(req) {
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
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  req.isPublicHost = isPublicHost(req);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(enforcePublicRateLimit);
app.use((req, res, next) => {
  if (!req.isPublicHost) {
    return next();
  }

  if (!isPublicTunnelEnabled()) {
    return sendPublicMaintenance(req, res);
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
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/checks', require('./routes/checks'));
app.use('/api/settings', require('./routes/settings'));
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
