const db = require('../db');
const { withBrowserPage } = require('./browser');

let syncInFlight = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeConcurrency(value, fallback = 2, max = 4) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(1, Math.min(Math.floor(parsed), max));
}

function getQuotaSyncConcurrency() {
  return normalizeConcurrency(
    process.env.QUOTA_SYNC_CONCURRENCY || process.env.SYNC_CONCURRENCY,
    2,
    4
  );
}

function nowIso() {
  return new Date().toISOString();
}

function updateAccountQuotaSync(accountId, changes) {
  const entries = Object.entries(changes).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return;
  }

  const assignments = entries.map(([field]) => `${field} = ?`);
  const values = entries.map(([, value]) => value);
  assignments.push("updated_at = datetime('now')");
  values.push(accountId);

  db.prepare(`
    UPDATE accounts
    SET ${assignments.join(', ')}
    WHERE id = ?
  `).run(...values);
}

function summarizeQuotaResults(results = []) {
  const synced = results.filter(item => item.success).length;
  const failed = results.filter(item => item.success === false && !item.skipped).length;
  const skipped = results.filter(item => item.skipped).length;
  const overQuota = results.filter(item => item.success && item.overQuota).length;

  return {
    total: results.length,
    synced,
    failed,
    skipped,
    overQuota,
  };
}

async function withQuotaPage(work) {
  return withBrowserPage(work);
}

async function fetchQuotaUsage(page, account) {
  return page.evaluate(async ({ accessToken }) => {
    const isUuid = (value) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
    const normalizePlanType = (value) => String(value || '').trim().toLowerCase();
    const isWorkspacePlan = (value) => {
      const planType = normalizePlanType(value);
      if (!planType) {
        return false;
      }

      if (['free', 'plus', 'pro', 'personal', 'default'].includes(planType)) {
        return false;
      }

      return (
        planType.includes('team') ||
        planType.includes('business') ||
        planType.includes('enterprise') ||
        planType.includes('workspace')
      );
    };

    const getHeaders = (workspaceId, extraHeaders = {}) => {
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'OAI-Language': 'en-US',
      };

      if (workspaceId) {
        headers['ChatGPT-Account-Id'] = workspaceId;
      }

      return { ...headers, ...extraHeaders };
    };

    const parseResponse = async (response) => {
      const text = await response.text();
      try {
        return { text, data: JSON.parse(text) };
      } catch {
        return { text, data: null };
      }
    };

    const extractErrorMessage = (payload, fallbackText, status) => {
      const candidates = [
        payload?.error_description,
        payload?.message,
        payload?.detail,
        payload?.error?.message,
        payload?.error,
      ];

      for (const candidate of candidates) {
        if (candidate == null) {
          continue;
        }

        if (typeof candidate === 'string' && candidate.trim()) {
          return candidate.trim();
        }

        try {
          const json = JSON.stringify(candidate);
          if (json && json !== 'null') {
            return json;
          }
        } catch {}
      }

      return fallbackText || `HTTP ${status}`;
    };

    const fetchWorkspace = async () => {
      const response = await fetch(
        'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27?server_time=true',
        { headers: getHeaders(null) }
      );
      const parsed = await parseResponse(response);

      if (!response.ok) {
        return {
          success: false,
          message: `Failed to fetch workspaces (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
        };
      }

      const entries = Object.entries(parsed.data?.accounts || {});
      const workspaceEntry =
        entries.find(([accountId, details]) => details?.is_workspace && isUuid(accountId)) ||
        entries.find(([accountId, details]) => details?.is_personal === false && isUuid(accountId)) ||
        entries.find(([accountId, details]) => isUuid(accountId) && isWorkspacePlan(details?.account?.plan_type));

      if (!workspaceEntry) {
        return {
          success: false,
          message: 'No workspace account id found',
        };
      }

      return {
        success: true,
        workspaceId: workspaceEntry[0],
        workspace: workspaceEntry[1],
      };
    };

    const fetchUsers = async (workspaceId) => {
      const limit = 100;
      let offset = 0;
      let occupiedSeats = 0;
      let totalUsers = 0;

      while (true) {
        const response = await fetch(
          `https://chatgpt.com/backend-api/accounts/${workspaceId}/users?limit=${limit}&offset=${offset}&query=`,
          { headers: getHeaders(workspaceId) }
        );
        const parsed = await parseResponse(response);

        if (!response.ok) {
          return {
            success: false,
            message: `Failed to fetch users (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
          };
        }

        const items = Array.isArray(parsed.data?.items) ? parsed.data.items : [];
        const total = Number(parsed.data?.total || items.length || 0);

        totalUsers = total;
        occupiedSeats += items.filter(item => item?.seat_type === 'default' && !item?.deactivated_time).length;

        offset += items.length;
        if (items.length === 0 || offset >= total) {
          break;
        }
      }

      return { success: true, occupiedSeats, totalUsers };
    };

    const fetchPendingInvites = async (workspaceId) => {
      const limit = 100;
      let offset = 0;
      let totalInvites = 0;

      while (true) {
        const response = await fetch(
          `https://chatgpt.com/backend-api/accounts/${workspaceId}/invites?limit=${limit}&offset=${offset}&query=`,
          { headers: getHeaders(workspaceId) }
        );
        const parsed = await parseResponse(response);

        if (!response.ok) {
          return {
            success: false,
            message: `Failed to fetch invites (HTTP ${response.status}): ${extractErrorMessage(parsed.data, parsed.text, response.status)}`,
          };
        }

        const items = Array.isArray(parsed.data?.items) ? parsed.data.items : [];
        const total = Number(parsed.data?.total || items.length || 0);

        totalInvites = total;
        offset += items.length;
        if (items.length === 0 || offset >= total) {
          break;
        }
      }

      return { success: true, pendingInvites: totalInvites };
    };

    const workspaceResult = await fetchWorkspace();
    if (!workspaceResult.success) {
      return workspaceResult;
    }

    const usersResult = await fetchUsers(workspaceResult.workspaceId);
    if (!usersResult.success) {
      return usersResult;
    }

    const invitesResult = await fetchPendingInvites(workspaceResult.workspaceId);
    if (!invitesResult.success) {
      return invitesResult;
    }

    return {
      success: true,
      workspaceId: workspaceResult.workspaceId,
      workspaceName: workspaceResult.workspace?.account?.name || '',
      usedSeats: usersResult.occupiedSeats + invitesResult.pendingInvites,
      memberSeats: usersResult.occupiedSeats,
      totalUsers: usersResult.totalUsers,
      pendingInvites: invitesResult.pendingInvites,
      planType: workspaceResult.workspace?.account?.plan_type || '',
    };
  }, {
    accessToken: account.access_token,
  });
}

async function syncSingleAccountUsage(accountId, options = {}) {
  const account = typeof accountId === 'object'
    ? accountId
    : db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);

  if (!account) {
    throw new Error('Account not found');
  }

  if (!account.access_token || account.status !== 'active') {
    const message = '\u8df3\u8fc7\u540c\u6b65\uff1a\u8d26\u53f7\u672a\u5904\u4e8e\u6d3b\u8dc3\u72b6\u6001\u6216\u5c1a\u672a\u6388\u6743';
    updateAccountQuotaSync(account.id, {
      quota_sync_status: 'skipped',
      quota_sync_message: message,
      quota_last_synced_at: nowIso(),
    });

    return {
      success: false,
      skipped: true,
      accountId: account.id,
      email: account.email,
      message,
    };
  }

  updateAccountQuotaSync(account.id, {
    quota_sync_status: 'running',
    quota_sync_message: '\u540c\u6b65\u4e2d',
    quota_last_synced_at: nowIso(),
  });

  let result;

  try {
    const page = options.page;
    result = page
      ? await fetchQuotaUsage(page, account)
      : await withQuotaPage(async innerPage => fetchQuotaUsage(innerPage, account));
  } catch (err) {
    updateAccountQuotaSync(account.id, {
      quota_sync_status: 'error',
      quota_sync_message: err.message,
      quota_last_synced_at: nowIso(),
    });

    return {
      success: false,
      accountId: account.id,
      email: account.email,
      message: err.message,
    };
  }

  if (!result.success) {
    updateAccountQuotaSync(account.id, {
      quota_sync_status: 'error',
      quota_sync_message: result.message,
      quota_last_synced_at: nowIso(),
    });

    return {
      success: false,
      accountId: account.id,
      email: account.email,
      message: result.message,
    };
  }

  const inviteTotal = Number(account.invite_total || 0);
  const occupiedSeats = Number(result.memberSeats || 0);
  const pendingInvites = Number(result.pendingInvites || 0);
  const totalUsers = Number(result.totalUsers || 0);
  const reservedSeats = occupiedSeats + pendingInvites;
  const remainingSeats = inviteTotal - occupiedSeats;
  const projectedRemainingSeats = inviteTotal - reservedSeats;
  const overQuota = occupiedSeats > inviteTotal;
  const projectedOverQuota = reservedSeats > inviteTotal;
  const message = `\u540c\u6b65\u7ed3\u679c\uff1a\u6210\u5458\u603b\u6570=${totalUsers}\uff0c\u5360\u4f4d\u6210\u5458=${occupiedSeats}\uff0c\u5f85\u5904\u7406\u9080\u8bf7=${pendingInvites}\uff0c\u603b\u9884\u5360=${reservedSeats}`;

  updateAccountQuotaSync(account.id, {
    invited_count: occupiedSeats,
    quota_member_seats: occupiedSeats,
    quota_pending_invites: pendingInvites,
    quota_total_users: totalUsers,
    quota_workspace_id: result.workspaceId || '',
    quota_workspace_name: result.workspaceName || '',
    quota_plan_type: result.planType || '',
    quota_sync_status: 'success',
    quota_sync_message: message,
    quota_last_synced_at: nowIso(),
  });

  return {
    success: true,
    accountId: account.id,
    email: account.email,
    usedSeats: occupiedSeats,
    reservedSeats,
    memberSeats: occupiedSeats,
    pendingInvites,
    totalUsers,
    workspaceId: result.workspaceId,
    workspaceName: result.workspaceName,
    planType: result.planType,
    inviteTotal,
    remainingSeats,
    projectedRemainingSeats,
    overQuota,
    projectedOverQuota,
    message,
  };
}

async function syncAllAccountUsage() {
  if (syncInFlight) {
    return syncInFlight;
  }

  syncInFlight = (async () => {
    const accounts = db.prepare(`
      SELECT *
      FROM accounts
      WHERE status = 'active'
        AND access_token IS NOT NULL
        AND access_token != ''
      ORDER BY id ASC
    `).all();

    if (accounts.length === 0) {
      return [];
    }

    const results = [];
    let nextIndex = 0;
    const workerCount = Math.min(getQuotaSyncConcurrency(), accounts.length);

    const workers = Array.from({ length: workerCount }, () => withQuotaPage(async page => {
      while (true) {
        const account = accounts[nextIndex];
        nextIndex += 1;

        if (!account) {
          break;
        }

        try {
          const result = await syncSingleAccountUsage(account, { page });
          results.push(result);
        } catch (err) {
          results.push({
            success: false,
            accountId: account.id,
            email: account.email,
            message: err.message,
          });
        }

        await sleep(150);
      }
    }));

    await Promise.all(workers);

    const summary = summarizeQuotaResults(results);
    console.log(
      `[QuotaSync] Synced ${summary.synced}/${accounts.length} active accounts, failed ${summary.failed}, over quota ${summary.overQuota}`
    );
    return results;
  })();

  try {
    return await syncInFlight;
  } finally {
    syncInFlight = null;
  }
}

module.exports = {
  syncAllAccountUsage,
  syncSingleAccountUsage,
  summarizeQuotaResults,
};
