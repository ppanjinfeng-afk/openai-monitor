const db = require('../db');
const fetch = require('node-fetch');
const crypto = require('crypto');
const http = require('http');
const telegram = require('./telegram');

// OpenAI OAuth constants (same as Codex CLI)
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OAUTH_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
const OAUTH_AUDIENCE = 'https://api.openai.com/v1';
const OAUTH_SCOPES = 'openid profile email offline_access';

const STATUS = {
  ACTIVE: 'active',
  BANNED: 'banned',
  INVALID_CREDENTIALS: 'invalid_credentials',
  RATE_LIMITED: 'rate_limited',
  ERROR: 'error',
  UNKNOWN: 'unknown',
  NO_PASSWORD: 'no_password',
};

const PRESERVED_TRANSIENT_STATUSES = new Set([
  STATUS.ACTIVE,
  STATUS.BANNED,
  STATUS.INVALID_CREDENTIALS,
  STATUS.RATE_LIMITED,
]);

const INVITE_FAILURE_WINDOW_HOURS = 24;
const INVITE_DEGRADED_THRESHOLD = 3;
const INVITE_SEVERE_DEGRADED_THRESHOLD = 5;
const INVITE_PAUSE_REASON_BANNED = '检测到封号，系统已自动暂停邀请';
const INVITE_PAUSE_REASON_DEGRADED = '检测到坏号，系统已自动暂停邀请';
const BAN_TEXT_HINTS = [
  'banned',
  'deactivated',
  'suspended',
  'disabled',
  'terminated',
  'violation',
  'violat',
  'restricted',
  'forbidden',
  'account disabled',
  'account suspended',
  'account deactivated',
  '封禁',
  '封号',
  '停用',
  '禁用',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isBanLikeText(value) {
  const text = String(value || '').trim().toLowerCase();
  return BAN_TEXT_HINTS.some(keyword => text.includes(keyword));
}

async function readResponseDetails(res) {
  const text = await res.text().catch(() => '');
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {}
  }

  return {
    text,
    json,
    message: (json?.error?.message || json?.error_description || json?.message || text || '').trim(),
  };
}

function normalizeCheckResult(account, result) {
  if (!result?.transient) {
    return result;
  }

  if (!PRESERVED_TRANSIENT_STATUSES.has(account.status)) {
    return result;
  }

  return {
    ...result,
    status: account.status,
    message: `上游检查接口临时异常，已保留原状态：${result.message}`,
  };
}

function getRecentBanEvidence(accountId) {
  const logs = db.prepare(`
    SELECT status, message
    FROM check_logs
    WHERE account_id = ?
    ORDER BY datetime(checked_at) DESC, id DESC
    LIMIT 5
  `).all(accountId);

  return logs.some(log =>
    String(log.status || '') === STATUS.BANNED
    || isBanLikeText(log.message)
  );
}

function finalizeCheckResult(account, rawResult) {
  const result = normalizeCheckResult(account, rawResult);

  if (result?.status === STATUS.INVALID_CREDENTIALS) {
    if (isBanLikeText(result.message)) {
      return {
        ...result,
        status: STATUS.BANNED,
        message: result.message || '检测到封号特征，已自动归类为封号',
      };
    }

    if (account.status === STATUS.BANNED && getRecentBanEvidence(account.id)) {
      return {
        ...result,
        status: STATUS.BANNED,
        message: '令牌无效，但该账号已有封号证据，已保留封号归类',
      };
    }
  }

  return result;
}

function getRecentInviteFailureStats(accountId) {
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN failure_category = 'invite_not_materialized' THEN 1 ELSE 0 END), 0) AS materialize_failures,
      COALESCE(SUM(CASE WHEN failure_category IN ('revoke_failed', 'resend_failed') THEN 1 ELSE 0 END), 0) AS retry_failures,
      COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS invite_successes
    FROM invites
    WHERE account_id = ?
      AND updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
  `).get(accountId);
}

function syncInvitePauseState(account, result) {
  const currentPaused = Number(account.invite_paused || 0) === 1;
  const currentReason = String(account.invite_pause_reason || '').trim();
  const isSystemInvitePause =
    currentReason === INVITE_PAUSE_REASON_BANNED
    || currentReason === INVITE_PAUSE_REASON_DEGRADED
    || currentReason.includes('封号')
    || currentReason.includes('坏号');
  const inviteStats = getRecentInviteFailureStats(account.id);
  const materializeFailures = Number(inviteStats.materialize_failures || 0);
  const inviteSuccesses = Number(inviteStats.invite_successes || 0);
  const hasBadInviteEvidence =
    (materializeFailures >= INVITE_DEGRADED_THRESHOLD && inviteSuccesses === 0)
    || materializeFailures >= INVITE_SEVERE_DEGRADED_THRESHOLD;

  let nextPaused = currentPaused;
  let nextReason = currentReason;

  if (result.status === STATUS.BANNED) {
    nextPaused = true;
    nextReason = INVITE_PAUSE_REASON_BANNED;
  } else if (hasBadInviteEvidence) {
    nextPaused = true;
    nextReason = INVITE_PAUSE_REASON_DEGRADED;
  } else if (
    currentPaused
    && isSystemInvitePause
    && result.status === STATUS.ACTIVE
  ) {
    nextPaused = false;
    nextReason = '';
  }

  if (nextPaused !== currentPaused || nextReason !== currentReason) {
    db.prepare(`
      UPDATE accounts
      SET invite_paused = ?,
          invite_pause_reason = ?,
          invite_paused_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(nextPaused ? 1 : 0, nextReason, nextPaused ? 1 : 0, account.id);

    db.prepare(`INSERT INTO check_logs (account_id, status, message) VALUES (?, ?, ?)`)
      .run(
        account.id,
        result.status,
        nextPaused ? `[invite-paused] ${nextReason}` : '[invite-resumed] 封号状态解除，已恢复邀请'
      );
  }

  return {
    invite_paused: nextPaused ? 1 : 0,
    invite_pause_reason: nextReason,
  };
}

async function checkWithTokenWithRetry(accessToken) {
  const maxAttempts = 3;
  let lastTransientFailure = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch('https://api.openai.com/v1/me', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (res.status === 200) {
        return { status: STATUS.ACTIVE, message: '令牌有效，账号正常' };
      }

      if (res.status === 401) {
        const body = await readResponseDetails(res);
        if (isBanLikeText(body.message)) {
          return { status: STATUS.BANNED, message: body.message || '账号已被封禁' };
        }
        return { status: null, message: body.message || 'token_expired' };
      }

      if (res.status === 403) {
        const body = await readResponseDetails(res);
        if (isBanLikeText(body.message)) {
          return { status: STATUS.BANNED, message: body.message || '账号已被封禁' };
        }
        return { status: STATUS.BANNED, message: '访问被拒绝，账号可能已被封禁 (403)' };
      }

      if (res.status === 429) {
        const body = await readResponseDetails(res);
        return { status: STATUS.RATE_LIMITED, message: body.message || '请求限流，稍后重试' };
      }

      if (res.status === 404 || res.status >= 500) {
        lastTransientFailure = {
          status: STATUS.ERROR,
          transient: true,
          message: `OpenAI 检查接口临时返回 HTTP ${res.status}`,
        };

        if (attempt < maxAttempts) {
          await sleep(600 * attempt);
          continue;
        }

        return lastTransientFailure;
      }

      return { status: STATUS.ERROR, message: `HTTP ${res.status}` };
    } catch (err) {
      lastTransientFailure = {
        status: STATUS.ERROR,
        transient: true,
        message: `OpenAI 检查接口网络异常: ${err.message}`,
      };

      if (attempt < maxAttempts) {
        await sleep(600 * attempt);
        continue;
      }
    }
  }

  return lastTransientFailure || { status: STATUS.ERROR, message: '检查接口未知异常' };
}

// ===== PKCE helpers =====
function generateCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function generateState() {
  return crypto.randomBytes(16).toString('hex');
}

// ===== OAuth Token-based check (for accounts that already have tokens) =====
async function checkWithToken(accessToken) {
  return checkWithTokenWithRetry(accessToken);
}

// ===== Refresh token =====
async function refreshAccessToken(refreshToken) {
  try {
    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (res.status === 200) {
      const data = (await readResponseDetails(res)).json || {};
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_in: data.expires_in,
      };
    }

    const body = await readResponseDetails(res);
    return { error: body.message || `HTTP ${res.status}` };
  } catch (err) {
    return { error: err.message };
  }
}

// ===== Main check account logic =====
async function checkAccount(account) {
  if (!account.password && !account.access_token) {
    return { status: STATUS.NO_PASSWORD, message: '未配置密码且无令牌' };
  }

  if (account.access_token) {
    const tokenResult = await checkWithToken(account.access_token);

    if (tokenResult.status !== null) {
      return tokenResult;
    }

    if (account.refresh_token) {
      console.log(`[Checker] Token expired for ${account.email}, refreshing...`);
      const refreshed = await refreshAccessToken(account.refresh_token);

      if (!refreshed.error) {
        db.prepare(`
          UPDATE accounts
          SET access_token = ?, refresh_token = ?, updated_at = datetime('now')
          WHERE id = ?
        `).run(refreshed.access_token, refreshed.refresh_token, account.id);

        const newResult = await checkWithToken(refreshed.access_token);
        if (newResult.status !== null) {
          return newResult;
        }
      } else {
        console.log(`[Checker] Refresh failed for ${account.email}: ${refreshed.error}`);
        if (isBanLikeText(refreshed.error)) {
          return { status: STATUS.BANNED, message: '刷新令牌失败，账号可能已被封禁' };
        }
      }
    }
  }

  if (!account.password) {
    return { status: STATUS.INVALID_CREDENTIALS, message: '令牌已失效，请重新授权' };
  }

  return attemptDirectLogin(account);
}

// ===== Direct login attempt via OpenAI auth API =====
async function attemptDirectLogin(account) {
  try {
    const sessionRes = await fetch('https://auth.openai.com/api/auth/csrf', {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    let csrfToken = '';
    if (sessionRes.status === 200) {
      const data = await sessionRes.json().catch(() => ({}));
      csrfToken = data.csrfToken || '';
    }

    const signInRes = await fetch('https://auth.openai.com/api/auth/callback/login-web', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Origin: 'https://auth.openai.com',
        Referer: 'https://auth.openai.com/',
      },
      body: new URLSearchParams({
        username: account.email,
        password: account.password,
        csrfToken,
        callbackUrl: '/',
        json: 'true',
      }).toString(),
      redirect: 'manual',
    });

    const statusCode = signInRes.status;
    const responseText = await signInRes.text().catch(() => '');
    const responseLower = responseText.toLowerCase();

    if (statusCode === 200 || statusCode === 302 || statusCode === 303) {
      try {
        const data = JSON.parse(responseText);
        if (data.url && !data.url.includes('error')) {
          return { status: STATUS.ACTIVE, message: '登录成功，账号正常' };
        }
        if (data.error) {
          if (isBanLikeText(`${data.error} ${responseText}`)) {
            return { status: STATUS.BANNED, message: '账号已被封禁' };
          }
          return { status: STATUS.INVALID_CREDENTIALS, message: data.error };
        }
      } catch {
        const location = signInRes.headers.get('location') || '';
        if (location.includes('error')) {
          return { status: STATUS.INVALID_CREDENTIALS, message: '登录失败' };
        }
        return { status: STATUS.ACTIVE, message: '登录成功（重定向）' };
      }

      return { status: STATUS.ACTIVE, message: '登录响应正常' };
    }

    if (statusCode === 401 || statusCode === 400) {
      if (isBanLikeText(responseText)) {
        return { status: STATUS.BANNED, message: '账号已被封禁' };
      }
      if (responseLower.includes('wrong') || responseLower.includes('invalid') || responseLower.includes('incorrect')) {
        return { status: STATUS.INVALID_CREDENTIALS, message: '邮箱或密码错误' };
      }
      return { status: STATUS.INVALID_CREDENTIALS, message: `登录失败 (${statusCode})` };
    }

    if (statusCode === 403) {
      if (isBanLikeText(responseText)) {
        return { status: STATUS.BANNED, message: '账号已被封禁 (403)' };
      }
      return { status: STATUS.BANNED, message: '访问被拒绝' };
    }

    if (statusCode === 429) {
      return { status: STATUS.RATE_LIMITED, message: '登录请求过于频繁' };
    }

    return { status: STATUS.ERROR, message: `HTTP ${statusCode}: 未知响应` };
  } catch (err) {
    return { status: STATUS.ERROR, message: `登录出错: ${err.message}` };
  }
}

// ===== OAuth Authorization (browser-based, for initial token acquisition) =====
function buildAuthorizationUrl(codeChallenge, state, loginHint) {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    audience: OAUTH_AUDIENCE,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login',
  });

  if (loginHint) {
    params.append('login_hint', loginHint);
  }

  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCodeForTokens(code, codeVerifier) {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      code,
      redirect_uri: OAUTH_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (res.status === 200) {
    return (await readResponseDetails(res)).json || {};
  }

  const body = await readResponseDetails(res);
  throw new Error(body.message || `HTTP ${res.status}`);
}

function startOAuthFlow(loginHint) {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const authUrl = buildAuthorizationUrl(codeChallenge, state, loginHint);

  return { authUrl, codeVerifier, state };
}

function waitForOAuthCallback(codeVerifier, state, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://localhost:19275');

      if (url.pathname !== '/callback') {
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h2>授权失败</h2><p>${error}</p><p>可以关闭此页面</p></body></html>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body><h2>状态不匹配</h2><p>可以关闭此页面</p></body></html>');
        server.close();
        reject(new Error('State mismatch'));
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(code, codeVerifier);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="background:#0a0e17;color:#f0f4f8;font-family:Inter,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh"><div style="text-align:center"><h2>授权成功</h2><p>令牌已保存，可以关闭此页面</p></div></body></html>');
        server.close();
        resolve(tokens);
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h2>令牌交换失败</h2><p>${err.message}</p></body></html>`);
        server.close();
        reject(err);
      }
    });

    server.listen(19275, () => {
      console.log('[OAuth] Callback server listening on port 19275');
    });

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout'));
    }, timeout);
  });
}

// ===== Account check orchestration =====
async function checkSingleAccount(accountId) {
  const account = db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(accountId);
  if (!account) {
    throw new Error('Account not found');
  }

  const rawResult = await checkAccount(account);
  const result = finalizeCheckResult(account, rawResult);
  const oldStatus = account.status;
  const now = new Date().toISOString();

  db.prepare(`UPDATE accounts SET status = ?, last_checked = ?, updated_at = ? WHERE id = ?`)
    .run(result.status, now, now, account.id);

  const pauseState = syncInvitePauseState(account, result);

  db.prepare(`INSERT INTO check_logs (account_id, status, message) VALUES (?, ?, ?)`)
    .run(account.id, result.status, result.message);

  if (oldStatus !== result.status && oldStatus !== 'unknown') {
    if (result.status === STATUS.BANNED) {
      await telegram.alertBanned(account);
    } else if (result.status === STATUS.INVALID_CREDENTIALS) {
      await telegram.alertInvalidCredentials(account);
    } else if (result.status === STATUS.ACTIVE && (oldStatus === STATUS.BANNED || oldStatus === STATUS.INVALID_CREDENTIALS)) {
      await telegram.alertRecovered(account);
    }
  }

  return {
    ...account,
    status: result.status,
    message: result.message,
    last_checked: now,
    invite_paused: pauseState.invite_paused,
    invite_pause_reason: pauseState.invite_pause_reason,
  };
}

async function checkAllAccounts() {
  const accounts = db.prepare(`SELECT * FROM accounts`).all();
  const results = [];
  let newBans = 0;
  let recovered = 0;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    try {
      const rawResult = await checkAccount(account);
      const result = finalizeCheckResult(account, rawResult);
      const oldStatus = account.status;
      const now = new Date().toISOString();

      db.prepare(`UPDATE accounts SET status = ?, last_checked = ?, updated_at = ? WHERE id = ?`)
        .run(result.status, now, now, account.id);

      const pauseState = syncInvitePauseState(account, result);

      db.prepare(`INSERT INTO check_logs (account_id, status, message) VALUES (?, ?, ?)`)
        .run(account.id, result.status, result.message);

      if (oldStatus !== result.status && oldStatus !== 'unknown') {
        if (result.status === STATUS.BANNED) {
          await telegram.alertBanned(account);
          newBans++;
        } else if (result.status === STATUS.INVALID_CREDENTIALS) {
          await telegram.alertInvalidCredentials(account);
        } else if (result.status === STATUS.ACTIVE && (oldStatus === STATUS.BANNED || oldStatus === STATUS.INVALID_CREDENTIALS)) {
          await telegram.alertRecovered(account);
          recovered++;
        }
      }

      results.push({
        id: account.id,
        email: account.email,
        ...result,
        invite_paused: pauseState.invite_paused,
        invite_pause_reason: pauseState.invite_pause_reason,
      });

      if (i < accounts.length - 1) {
        const delay = 2000 + Math.random() * 3000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (err) {
      results.push({ id: account.id, email: account.email, status: STATUS.ERROR, message: err.message });
    }
  }

  console.log(`[Checker] Checked ${accounts.length} accounts. New bans: ${newBans}, Recovered: ${recovered}`);
  return results;
}

function getStats() {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) AS banned,
      SUM(CASE WHEN status = 'invalid_credentials' THEN 1 ELSE 0 END) AS invalid,
      SUM(CASE WHEN status = 'no_password' THEN 1 ELSE 0 END) AS noPassword,
      SUM(CASE WHEN status IN ('unknown', 'error', 'rate_limited') THEN 1 ELSE 0 END) AS unknown,
      COALESCE(SUM(invited_count), 0) AS invitesUsed,
      COALESCE(SUM(invite_total), 0) AS invitesTotal
    FROM accounts
  `).get();

  return {
    total: row.total,
    active: row.active,
    banned: row.banned,
    invalid: row.invalid,
    noPassword: row.noPassword,
    unknown: row.unknown,
    invitesUsed: row.invitesUsed,
    invitesTotal: row.invitesTotal,
  };
}

module.exports = {
  checkSingleAccount,
  checkAllAccounts,
  getStats,
  startOAuthFlow,
  exchangeCodeForTokens,
  waitForOAuthCallback,
  checkWithToken,
  refreshAccessToken,
  STATUS,
};
