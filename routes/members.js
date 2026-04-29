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

function normalizeBatchMemberItem(item, index) {
  const accountId = Number(item?.account_id || item?.accountId || 0);
  const userId = String(item?.user_id || item?.userId || '').trim();

  return {
    clientIndex: Number.isFinite(Number(item?.client_index ?? item?.clientIndex))
      ? Number(item.client_index ?? item.clientIndex)
      : index,
    accountId,
    userId,
    email: String(item?.email || '').trim(),
    workspaceId: String(item?.workspace_id || item?.workspaceId || '').trim(),
    workspaceName: String(item?.workspace_name || item?.workspaceName || '').trim(),
    planType: String(item?.plan_type || item?.planType || '').trim(),
    workspaceRowId: Number(item?.workspace_row_id || item?.workspaceRowId || 0),
  };
}

function getBatchConcurrency(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(parsed), max));
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));

  return results;
}

function markMemberRemoved(accountId, userId, workspaceId = '') {
  if (workspaceId) {
    db.prepare(`
      UPDATE workspace_members
      SET deactivated_time = datetime('now'),
          last_synced_at = datetime('now')
      WHERE account_id = ?
        AND user_id = ?
        AND workspace_id = ?
    `).run(accountId, userId, workspaceId);
    return;
  }

  db.prepare(`
    UPDATE workspace_members
    SET deactivated_time = datetime('now'),
        last_synced_at = datetime('now')
    WHERE account_id = ?
      AND user_id = ?
  `).run(accountId, userId);
}

router.post('/batch-remove', async (req, res) => {
  const rawMembers = Array.isArray(req.body?.members) ? req.body.members : [];
  const maxItems = 300;
  const members = rawMembers.slice(0, maxItems).map(normalizeBatchMemberItem);
  const invalidResults = [];
  const validMembers = [];

  for (const member of members) {
    if (!member.accountId || !member.userId) {
      invalidResults.push({
        clientIndex: member.clientIndex,
        userId: member.userId,
        email: member.email,
        success: false,
        message: 'Missing account_id or user_id',
      });
    } else {
      validMembers.push(member);
    }
  }

  const workspaceConcurrency = getBatchConcurrency(
    req.body?.workspace_concurrency || process.env.MEMBER_REMOVAL_WORKSPACE_CONCURRENCY,
    2,
    4
  );
  const memberConcurrency = getBatchConcurrency(
    req.body?.member_concurrency || process.env.MEMBER_REMOVAL_MEMBER_CONCURRENCY,
    4,
    8
  );

  const groupsByWorkspace = new Map();
  for (const member of validMembers) {
    const groupKey = JSON.stringify([
      member.accountId,
      member.workspaceId,
      member.workspaceName,
      member.planType,
    ]);
    if (!groupsByWorkspace.has(groupKey)) {
      groupsByWorkspace.set(groupKey, []);
    }
    groupsByWorkspace.get(groupKey).push(member);
  }

  const groups = Array.from(groupsByWorkspace.values());
  const results = [...invalidResults];
  const workspaceRows = new Set();

  try {
    await runWithConcurrency(groups, workspaceConcurrency, async group => {
      const first = group[0];
      const account = getAccount(first.accountId);

      if (!account?.access_token) {
        for (const member of group) {
          results.push({
            clientIndex: member.clientIndex,
            userId: member.userId,
            email: member.email,
            accountId: member.accountId,
            workspaceRowId: member.workspaceRowId,
            success: false,
            message: 'Account is not authorized, cannot remove member',
          });
        }
        return;
      }

      const groupResult = await workspaceMembers.removeMembers(
        account,
        group.map(member => ({
          clientIndex: member.clientIndex,
          userId: member.userId,
          email: member.email,
        })),
        {
          workspaceId: first.workspaceId,
          workspaceName: first.workspaceName || first.workspaceId,
          planType: first.planType,
          concurrency: memberConcurrency,
        }
      );

      const resultItems = Array.isArray(groupResult.results) && groupResult.results.length > 0
        ? groupResult.results
        : group.map(member => ({
            clientIndex: member.clientIndex,
            userId: member.userId,
            email: member.email,
            success: false,
            message: groupResult.message || 'Remove member failed',
          }));

      const memberByIndex = new Map(group.map(member => [member.clientIndex, member]));
      for (const resultItem of resultItems) {
        const member = memberByIndex.get(resultItem.clientIndex) || group.find(item => item.userId === resultItem.userId);
        const normalizedResult = {
          ...resultItem,
          accountId: member?.accountId || first.accountId,
          workspaceRowId: member?.workspaceRowId || 0,
        };

        if (normalizedResult.success && member) {
          markMemberRemoved(member.accountId, member.userId, member.workspaceId);
          if (member.workspaceRowId) {
            workspaceRows.add(Number(member.workspaceRowId));
          }
          logAction(
            member.accountId,
            'active',
            `[member-batch-remove] ${member.email || member.userId} from ${member.workspaceName || member.workspaceId || '-'}`
          );
        }

        results.push(normalizedResult);
      }
    });

    results.sort((a, b) => Number(a.clientIndex || 0) - Number(b.clientIndex || 0));
    const removed = results.filter(item => item.success).length;
    const failed = results.length - removed;

    return res.json({
      success: failed === 0,
      removed,
      failed,
      results,
      workspace_row_ids: Array.from(workspaceRows),
      workspace_concurrency: workspaceConcurrency,
      member_concurrency: memberConcurrency,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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
