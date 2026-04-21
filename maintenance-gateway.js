const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const GATEWAY_PORT = Number(process.env.PUBLIC_GATEWAY_PORT || 3001);
const ORIGIN_HOST = process.env.PUBLIC_GATEWAY_ORIGIN_HOST || '127.0.0.1';
const ORIGIN_PORT = Number(process.env.PUBLIC_GATEWAY_ORIGIN_PORT || 3000);
const DB_PATH = path.join(__dirname, 'data', 'monitor.db');
const MAINTENANCE_PATH = path.join(__dirname, 'public', 'maintenance.html');
const MAINTENANCE_QQ = '1006267937';

const maintenanceHtml = fs.readFileSync(MAINTENANCE_PATH, 'utf8');
const db = new Database(DB_PATH, { readonly: true });
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');

function getSettingValue(key, fallback = '') {
  try {
    const row = getSettingStmt.get(key);
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

function isPublicTunnelEnabled() {
  return getSettingValue('public_tunnel_enabled', 'true') !== 'false';
}

function isApiRequest(req) {
  return String(req.url || '').startsWith('/api/');
}

function sendMaintenance(req, res) {
  if (isApiRequest(req)) {
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({
      error: '维护中',
      maintenance: true,
      qq: MAINTENANCE_QQ,
    }));
    return;
  }

  res.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(maintenanceHtml);
}

function proxyToOrigin(req, res) {
  const upstream = http.request({
    hostname: ORIGIN_HOST,
    port: ORIGIN_PORT,
    path: req.url,
    method: req.method,
    headers: {
      ...req.headers,
      host: req.headers.host || `${ORIGIN_HOST}:${ORIGIN_PORT}`,
      connection: 'close',
    },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on('error', () => {
    sendMaintenance(req, res);
  });

  req.on('aborted', () => {
    upstream.destroy();
  });

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  if (!isPublicTunnelEnabled()) {
    sendMaintenance(req, res);
    return;
  }

  proxyToOrigin(req, res);
});

server.listen(GATEWAY_PORT, '127.0.0.1', () => {
  console.log(`[MaintenanceGateway] listening at http://127.0.0.1:${GATEWAY_PORT} -> http://${ORIGIN_HOST}:${ORIGIN_PORT}`);
});
