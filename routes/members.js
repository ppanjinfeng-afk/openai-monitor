const express = require('express');
const db = require('../db');
const quotaSync = require('../services/quota-sync');
const workspaceMembers = require('../services/workspace-members');

const router = express.Router();

function getAccount(accountId) {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
}

function ensureAuthorizedAccount(accountId, res) {
  const account = getAccount(accountId);
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return null;
  }

  if (!account.access_token) {
    res.status(400).json({ error: '\u8be5\u8d26\u53f7\u5c1a\u672a\u6388\u6743\uff0c\u8bf7\u5148\u5b8c\u6210 OAuth' });
    return null;
  }

  return account;
}

function getWorkspaceHints(req) {
  return {
    workspaceId: String(req.query.workspace_id || req.body?.workspace_id || '').trim(),
    workspaceName: String(req.query.workspace_name || req.body?.workspace_name || '').trim(),
    planType: String(req.query.plan_type || req.body?.plan_type || '').trim(),
  };
}

function shouldSkipSync(req) {
  const value = String(req.query.skip_sync || req.body?.skip_sync || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function logAction(accountId, status, message) {
  db.prepare(`
    INSERT INTO check_logs (account_id, status, message)
    VALUES (?, ?, ?)
  `).run(accountId, status, message);
}

async function syncQuotaSnapshot(account) {
  try {
    const result = await quotaSync.syncSingleAccountUsage(account);
    if (!result.success && !result.skipped) {
      logAction(account.id, 'error', `[members-quota-sync] ${result.message}`);
      return null;
    }

    return {
      total_users: result.totalUsers,
      occupied_seats: result.usedSeats,
      reserved_seats: result.reservedSeats,
      member_seats: result.memberSeats,
      pending_invites: result.pendingInvites,
      remaining_seats: result.remainingSeats,
      projected_remaining_seats: result.projectedRemainingSeats,
    };
  } catch (err) {
    logAction(account.id, 'error', `[members-quota-sync] ${err.message}`);
    return null;
  }
}

router.get('/:accountId(\\d+)', async (req, res) => {
  const account = ensureAuthorizedAccount(req.params.accountId, res);
  if (!account) return;
  const workspaceHints = getWorkspaceHints(req);

  try {
    const result = await workspaceMembers.listMembers(account, {
      search: String(req.query.search || ''),
      ...workspaceHints,
    });

    if (!result.success) {
      return res.status(500).json({ error: result.message });
    }

    return res.json({
      account_id: account.id,
      account_email: account.email,
      workspace_id: result.workspaceId,
      workspace_name: result.workspaceName,
      plan_type: result.planType,
      total: result.total,
      members: result.members,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:accountId(\\d+)/:userId/detail', async (req, res) => {
  const account = ensureAuthorizedAccount(req.params.accountId, res);
  if (!account) return;
  const workspaceHints = getWorkspaceHints(req);

  try {
    const result = await workspaceMembers.getMemberDetail(account, req.params.userId, workspaceHints);
    if (!result.success) {
      const status = String(result.message || '').includes('\u672a\u627e\u5230') ? 404 : 500;
      return res.status(status).json({ error: result.message });
    }

    return res.json({
      account_id: account.id,
      account_email: account.email,
      workspace_id: result.workspaceId,
      workspace_name: result.workspaceName,
      plan_type: result.planType,
      member: result.member,
      detail: result.detail,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/:accountId(\\d+)/:userId', async (req, res) => {
  const account = ensureAuthorizedAccount(req.params.accountId, res);
  if (!account) return;
  const workspaceHints = getWorkspaceHints(req);

  const role = req.body.role;
  const seatType = req.body.seat_type;

  if (role === undefined && seatType === undefined) {
    return res.status(400).json({ error: '\u8bf7\u81f3\u5c11\u63d0\u4ea4\u4e00\u4e2a\u9700\u8981\u66f4\u65b0\u7684\u5b57\u6bb5' });
  }

  try {
    const result = await workspaceMembers.updateMember(account, req.params.userId, {
      role,
      seatType,
      ...workspaceHints,
    }, workspaceHints);

    if (!result.success) {
      return res.status(500).json({ error: result.message });
    }

    logAction(account.id, 'active', `[member-update] ${req.params.userId} role=${role || '-'} seat_type=${seatType || '-'}`);
    const quotaSyncResult = await syncQuotaSnapshot(account);

    return res.json({
      message: '\u6210\u5458\u6743\u9650\u5df2\u66f4\u65b0',
      quota_sync: quotaSyncResult,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.delete('/:accountId(\\d+)/:userId', async (req, res) => {
  const account = ensureAuthorizedAccount(req.params.accountId, res);
  if (!account) return;
  const workspaceHints = getWorkspaceHints(req);
  const skipSync = shouldSkipSync(req);

  try {
    const result = await workspaceMembers.removeMember(account, req.params.userId, workspaceHints);
    if (!result.success) {
      return res.status(500).json({ error: result.message });
    }

    logAction(account.id, 'active', `[member-remove] ${req.params.userId}`);
    const quotaSyncResult = skipSync ? null : await syncQuotaSnapshot(account);

    return res.json({
      message: '\u6210\u5458\u5df2\u79fb\u51fa\u5de5\u4f5c\u533a',
      skip_sync: skipSync,
      quota_sync: quotaSyncResult,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:accountId(\\d+)/:userId/logout', async (req, res) => {
  const account = ensureAuthorizedAccount(req.params.accountId, res);
  if (!account) return;
  const workspaceHints = getWorkspaceHints(req);

  try {
    const result = await workspaceMembers.logoutMember(account, req.params.userId, workspaceHints);
    if (!result.success) {
      return res.status(500).json({ error: result.message });
    }

    logAction(account.id, 'active', `[member-logout] ${req.params.userId}`);

    return res.json({
      message: '\u8be5\u6210\u5458\u5df2\u88ab\u4ece\u6240\u6709\u4f1a\u8bdd\u4e2d\u767b\u51fa',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:accountId(\\d+)/pending-invites/revoke', async (req, res) => {
  const account = ensureAuthorizedAccount(req.params.accountId, res);
  if (!account) return;
  const workspaceHints = getWorkspaceHints(req);
  const skipSync = shouldSkipSync(req);
  const email = String(req.body?.email || '').trim();

  if (!email) {
    return res.status(400).json({ error: '请提供待撤销的邮箱地址' });
  }

  try {
    const result = await workspaceMembers.revokePendingInvite(account, {
      email,
      remoteInviteId: String(req.body?.remote_invite_id || '').trim(),
      ...workspaceHints,
    }, workspaceHints);

    if (!result.success) {
      return res.status(500).json({ error: result.message });
    }

    logAction(account.id, 'active', `[pending-invite-revoke] ${email}`);
    const quotaSyncResult = skipSync ? null : await syncQuotaSnapshot(account);

    return res.json({
      message: result.found === false ? '待邀请已不存在，已按撤销处理' : '待邀请已撤销',
      found: result.found !== false,
      skip_sync: skipSync,
      quota_sync: quotaSyncResult,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
