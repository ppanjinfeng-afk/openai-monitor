const db = require('../db');
const { markDuplicateTeamCdkTaskUntracked } = require('./cdk-team-dedupe');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').trim();
}

function parseJsonSafely(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

const completionRetryTimers = new Map();

function buildTeamInviteSuccessMessage(context = {}) {
  const targetEmail = normalizeText(
    context.target_email
    || context.targetEmail
    || context.email
    || context.recipient_email
    || context.recipientEmail
  );
  const workspaceName = normalizeText(
    context.workspace_name
    || context.workspaceName
    || context.workspace_id
    || context.workspaceId
  );
  const target = targetEmail ? `至 ${targetEmail}` : '';
  const workspace = workspaceName ? `（${workspaceName}）` : '';

  return `Team 邀请已发送${target}${workspace}，请检查邮箱并接受邀请`;
}

function localizeTeamInviteSuccessMessage(message, context = {}) {
  const text = normalizeText(message);
  const englishSuccess = /^(team invite sent|invite sent successfully|invite resent successfully|invite already pending)/i;

  if (!text || englishSuccess.test(text)) {
    return buildTeamInviteSuccessMessage(context);
  }

  return text.replace(/\s*\(fallback account:\s*([^)]+)\)/i, '（备用账号：$1）');
}

function buildInviteResultFromInvite(invite = {}) {
  const accountEmail = normalizeText(invite.account_email);
  const workspaceName = normalizeText(invite.workspace_name);
  const workspaceId = normalizeText(invite.workspace_id);
  const message = localizeTeamInviteSuccessMessage(invite.message, {
    target_email: invite.target_email,
    account_email: accountEmail,
    workspace_name: workspaceName,
    workspace_id: workspaceId,
  });

  return {
    success: true,
    reconciled_from_invite: true,
    message,
    used_account: accountEmail,
    used_account_id: invite.account_id || null,
    requested_account_id: invite.requested_account_id || invite.account_id || null,
    fallback_from_account_id: invite.fallback_from_account_id || null,
    remote_invite_id: normalizeText(invite.remote_invite_id),
    delivery_type: normalizeText(invite.delivery_type) || 'send',
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    cdk_task_id: normalizeText(invite.cdk_task_id),
    plan_type: normalizeText(invite.plan_type),
    status: normalizeText(invite.status),
  };
}

function loadSuccessfulInviteById(inviteId, taskId, targetEmail) {
  const normalizedInviteId = Number(inviteId || 0);
  if (!normalizedInviteId) {
    return null;
  }

  return db.prepare(`
    SELECT
      i.*,
      a.email AS account_email,
      a.label AS account_label
    FROM invites i
    LEFT JOIN accounts a ON a.id = i.account_id
    WHERE i.id = ?
      AND LOWER(i.target_email) = LOWER(?)
      AND COALESCE(i.status, '') IN ('sent', 'accepted')
      AND COALESCE(i.failure_category, '') = ''
      AND (COALESCE(i.cdk_task_id, '') = '' OR i.cdk_task_id = ?)
    LIMIT 1
  `).get(normalizedInviteId, targetEmail, taskId);
}

function loadUniqueSuccessfulInviteByRemote(remoteInviteId, taskId, targetEmail, workspaceId = '', accountId = null) {
  const normalizedRemoteId = normalizeText(remoteInviteId);
  if (!normalizedRemoteId) {
    return null;
  }

  const params = {
    remoteInviteId: normalizedRemoteId,
    taskId,
    targetEmail,
    workspaceId: normalizeText(workspaceId),
    accountId: accountId == null ? null : Number(accountId),
  };
  const matches = db.prepare(`
    SELECT
      i.*,
      a.email AS account_email,
      a.label AS account_label
    FROM invites i
    LEFT JOIN accounts a ON a.id = i.account_id
    WHERE COALESCE(i.remote_invite_id, '') = @remoteInviteId
      AND LOWER(i.target_email) = LOWER(@targetEmail)
      AND COALESCE(i.status, '') IN ('sent', 'accepted')
      AND COALESCE(i.failure_category, '') = ''
      AND (COALESCE(i.cdk_task_id, '') = '' OR i.cdk_task_id = @taskId)
      AND (@workspaceId = '' OR COALESCE(i.workspace_id, '') = @workspaceId)
      AND (@accountId IS NULL OR i.account_id = @accountId)
    ORDER BY datetime(COALESCE(NULLIF(i.updated_at, ''), i.created_at)) DESC
    LIMIT 2
  `).all(params);

  return matches.length === 1 ? matches[0] : null;
}

function findSuccessfulInviteForTask(taskOrId) {
  const task = typeof taskOrId === 'object' && taskOrId
    ? taskOrId
    : db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskOrId);

  if (!task) {
    return null;
  }

  const targetEmail = normalizeEmail(task.account_email);
  if (!targetEmail) {
    return null;
  }

  const linkedInvite = db.prepare(`
    SELECT
      i.*,
      a.email AS account_email,
      a.label AS account_label
    FROM invites i
    LEFT JOIN accounts a ON a.id = i.account_id
    WHERE i.cdk_task_id = ?
      AND COALESCE(i.status, '') IN ('sent', 'accepted')
      AND COALESCE(i.failure_category, '') = ''
    ORDER BY datetime(COALESCE(NULLIF(i.updated_at, ''), i.created_at)) DESC
    LIMIT 1
  `).get(task.id);

  if (linkedInvite) {
    return linkedInvite;
  }

  const storedResult = parseJsonSafely(task.invite_result_json);
  const inviteId = storedResult.invite_id || storedResult.inviteId;
  const remoteInviteId = storedResult.remote_invite_id || storedResult.remoteInviteId;
  const workspaceId = storedResult.workspace_id || storedResult.workspaceId;
  const usedAccountId = storedResult.used_account_id || storedResult.account_id;

  const inviteById = loadSuccessfulInviteById(inviteId, task.id, targetEmail);
  if (inviteById) {
    return inviteById;
  }

  const exactRemoteInvite = loadUniqueSuccessfulInviteByRemote(
    remoteInviteId,
    task.id,
    targetEmail,
    workspaceId,
    usedAccountId || null
  );
  if (exactRemoteInvite) {
    return exactRemoteInvite;
  }

  const workspaceRemoteInvite = loadUniqueSuccessfulInviteByRemote(
    remoteInviteId,
    task.id,
    targetEmail,
    workspaceId
  );
  if (workspaceRemoteInvite) {
    return workspaceRemoteInvite;
  }

  const uniqueRemoteInvite = loadUniqueSuccessfulInviteByRemote(remoteInviteId, task.id, targetEmail);
  if (uniqueRemoteInvite) {
    return uniqueRemoteInvite;
  }

  return null;
}

function getTaskCdkIdentity(task = {}) {
  const cdkCode = getTaskCdkCode(task);
  if (cdkCode) {
    return `code:${cdkCode.toLowerCase()}`;
  }

  const cdkId = Number(task.cdk_id || 0);
  return cdkId > 0 ? `id:${cdkId}` : '';
}

function canUseEmailTimeFallbackForTask(task = {}, targetEmail = '', createdAt = '') {
  const currentCdkIdentity = getTaskCdkIdentity(task);
  if (!currentCdkIdentity || !targetEmail || !createdAt) {
    return false;
  }

  const nearbyTasks = db.prepare(`
    SELECT
      t.id,
      t.cdk_id,
      COALESCE(NULLIF(TRIM(t.cdk_code), ''), c.code, '') AS cdk_code
    FROM cdk_tasks t
    LEFT JOIN cdk_cards c ON c.id = t.cdk_id
    WHERE t.task_type = 'team_invite'
      AND LOWER(t.account_email) = LOWER(@targetEmail)
      AND UPPER(COALESCE(t.status, '')) IN ('FAILED', 'PENDING', 'PROCESSING')
      AND datetime(COALESCE(NULLIF(t.created_at, ''), NULLIF(t.updated_at, ''), '1970-01-01 00:00:00'))
        BETWEEN datetime(@createdAt, '-30 minutes') AND datetime(@createdAt, '+30 minutes')
    ORDER BY datetime(COALESCE(NULLIF(t.created_at, ''), NULLIF(t.updated_at, ''), '1970-01-01 00:00:00')) DESC,
             t.id DESC
    LIMIT 20
  `).all({ targetEmail, createdAt });

  const nearbyTaskIdentities = new Set(
    nearbyTasks
      .map(getTaskCdkIdentity)
      .filter(Boolean)
  );

  return nearbyTasks.length > 0
    && nearbyTasks.some(row => normalizeText(row.id) === normalizeText(task.id))
    && nearbyTaskIdentities.size === 1
    && nearbyTaskIdentities.has(currentCdkIdentity);
}

function findSuccessfulPendingInviteForTask(taskOrId) {
  const task = typeof taskOrId === 'object' && taskOrId
    ? taskOrId
    : db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskOrId);

  if (!task) {
    return null;
  }

  const targetEmail = normalizeEmail(task.account_email);
  if (!targetEmail) {
    return null;
  }

  const storedResult = parseJsonSafely(task.invite_result_json);
  const workspaceId = normalizeText(storedResult.workspace_id || storedResult.workspaceId);
  const remoteInviteId = normalizeText(storedResult.remote_invite_id || storedResult.remoteInviteId);
  const usedAccountId = storedResult.used_account_id || storedResult.account_id || null;
  const params = {
    taskId: normalizeText(task.id),
    targetEmail,
    workspaceId,
    remoteInviteId,
    accountId: usedAccountId == null ? null : Number(usedAccountId),
    createdAt: normalizeText(task.created_at),
  };

  const selectPendingSql = `
    SELECT
      wp.*,
      a.email AS account_email,
      a.label AS account_label,
      w.workspace_name AS workspace_name,
      w.plan_type AS plan_type
    FROM workspace_pending_invites wp
    LEFT JOIN accounts a ON a.id = wp.account_id
    LEFT JOIN workspaces w ON w.account_id = wp.account_id
      AND w.workspace_id = wp.workspace_id
  `;

  const linkedPending = db.prepare(`
    ${selectPendingSql}
    WHERE LOWER(wp.email) = LOWER(@targetEmail)
      AND COALESCE(wp.source_cdk_task_id, '') = @taskId
    ORDER BY datetime(COALESCE(NULLIF(wp.invited_at, ''), NULLIF(wp.last_synced_at, ''), '1970-01-01 00:00:00')) DESC,
             wp.id DESC
    LIMIT 1
  `).get(params);

  if (linkedPending) {
    return linkedPending;
  }

  if (remoteInviteId || workspaceId || usedAccountId) {
    const contextualMatches = db.prepare(`
      ${selectPendingSql}
      WHERE LOWER(wp.email) = LOWER(@targetEmail)
        AND (@remoteInviteId = '' OR COALESCE(wp.remote_invite_id, '') = @remoteInviteId)
        AND (@workspaceId = '' OR wp.workspace_id = @workspaceId)
        AND (@accountId IS NULL OR wp.account_id = @accountId)
        AND (
          @createdAt = ''
          OR (
            COALESCE(NULLIF(wp.invited_at, ''), NULLIF(wp.last_synced_at, ''), '') != ''
            AND datetime(COALESCE(NULLIF(wp.invited_at, ''), NULLIF(wp.last_synced_at, '')))
              >= datetime(@createdAt, '-30 minutes')
          )
        )
      ORDER BY
        CASE WHEN @remoteInviteId != '' AND COALESCE(wp.remote_invite_id, '') = @remoteInviteId THEN 0 ELSE 1 END,
        CASE WHEN @workspaceId != '' AND wp.workspace_id = @workspaceId THEN 0 ELSE 1 END,
        datetime(COALESCE(NULLIF(wp.invited_at, ''), NULLIF(wp.last_synced_at, ''), '1970-01-01 00:00:00')) DESC,
        wp.id DESC
      LIMIT 2
    `).all(params);

    return contextualMatches.length === 1 ? contextualMatches[0] : null;
  }

  if (!canUseEmailTimeFallbackForTask(task, targetEmail, params.createdAt)) {
    return null;
  }

  return db.prepare(`
    ${selectPendingSql}
    WHERE LOWER(wp.email) = LOWER(@targetEmail)
      AND COALESCE(NULLIF(wp.invited_at, ''), NULLIF(wp.last_synced_at, ''), '') != ''
      AND datetime(COALESCE(NULLIF(wp.invited_at, ''), NULLIF(wp.last_synced_at, '')))
        >= datetime(@createdAt, '-30 minutes')
    ORDER BY datetime(COALESCE(NULLIF(wp.invited_at, ''), NULLIF(wp.last_synced_at, ''), '1970-01-01 00:00:00')) DESC,
             wp.id DESC
    LIMIT 1
  `).get(params) || null;
}

function buildInviteResultFromPendingInvite(pending = {}, task = {}) {
  const workspaceId = normalizeText(pending.workspace_id);
  const workspaceName = normalizeText(pending.workspace_name) || workspaceId;
  const accountEmail = normalizeText(pending.account_email);
  const targetEmail = normalizeText(task.account_email || pending.email);
  const message = localizeTeamInviteSuccessMessage('', {
    target_email: targetEmail,
    workspace_name: workspaceName,
  });

  return {
    success: true,
    reconciled_from_pending_invite: true,
    message,
    used_account: accountEmail,
    used_account_id: pending.account_id || null,
    requested_account_id: pending.account_id || null,
    remote_invite_id: normalizeText(pending.remote_invite_id),
    delivery_type: 'pending_invite_reconcile',
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    cdk_task_id: normalizeText(task.id),
    plan_type: normalizeText(pending.plan_type),
    status: 'sent',
    invited_at: normalizeText(pending.invited_at),
  };
}

function findSuccessfulMemberForTask(taskOrId) {
  const task = typeof taskOrId === 'object' && taskOrId
    ? taskOrId
    : db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskOrId);

  if (!task) {
    return null;
  }

  const targetEmail = normalizeEmail(task.account_email);
  if (!targetEmail) {
    return null;
  }

  const storedResult = parseJsonSafely(task.invite_result_json);
  const workspaceId = normalizeText(storedResult.workspace_id || storedResult.workspaceId);
  const usedAccountId = storedResult.used_account_id || storedResult.account_id || null;
  const params = {
    taskId: normalizeText(task.id),
    targetEmail,
    workspaceId,
    accountId: usedAccountId == null ? null : Number(usedAccountId),
    createdAt: normalizeText(task.created_at),
  };

  const selectMemberSql = `
    SELECT
      wm.*,
      a.email AS account_email,
      a.label AS account_label,
      w.workspace_name AS workspace_name,
      w.plan_type AS plan_type
    FROM workspace_members wm
    LEFT JOIN accounts a ON a.id = wm.account_id
    LEFT JOIN workspaces w ON w.account_id = wm.account_id
      AND w.workspace_id = wm.workspace_id
  `;

  const linkedMember = db.prepare(`
    ${selectMemberSql}
    WHERE LOWER(wm.email) = LOWER(@targetEmail)
      AND COALESCE(wm.deactivated_time, '') = ''
      AND COALESCE(wm.source_cdk_task_id, '') = @taskId
    ORDER BY datetime(COALESCE(NULLIF(wm.joined_at, ''), NULLIF(wm.last_synced_at, ''), '1970-01-01 00:00:00')) DESC,
             wm.id DESC
    LIMIT 1
  `).get(params);

  if (linkedMember) {
    return linkedMember;
  }

  if (workspaceId || usedAccountId) {
    const contextualMatches = db.prepare(`
      ${selectMemberSql}
      WHERE LOWER(wm.email) = LOWER(@targetEmail)
        AND COALESCE(wm.deactivated_time, '') = ''
        AND (@workspaceId = '' OR wm.workspace_id = @workspaceId)
        AND (@accountId IS NULL OR wm.account_id = @accountId)
        AND (
          @createdAt = ''
          OR (
            COALESCE(NULLIF(wm.joined_at, ''), NULLIF(wm.last_synced_at, ''), '') != ''
            AND datetime(COALESCE(NULLIF(wm.joined_at, ''), NULLIF(wm.last_synced_at, '')))
              >= datetime(@createdAt, '-30 minutes')
          )
        )
      ORDER BY
        CASE WHEN @workspaceId != '' AND wm.workspace_id = @workspaceId THEN 0 ELSE 1 END,
        datetime(COALESCE(NULLIF(wm.joined_at, ''), NULLIF(wm.last_synced_at, ''), '1970-01-01 00:00:00')) DESC,
        wm.id DESC
      LIMIT 2
    `).all(params);

    return contextualMatches.length === 1 ? contextualMatches[0] : null;
  }

  if (!params.createdAt) {
    return null;
  }

  if (!canUseEmailTimeFallbackForTask(task, targetEmail, params.createdAt)) {
    return null;
  }

  const uniqueRecentMembers = db.prepare(`
    ${selectMemberSql}
    WHERE LOWER(wm.email) = LOWER(@targetEmail)
      AND COALESCE(wm.deactivated_time, '') = ''
      AND COALESCE(NULLIF(wm.joined_at, ''), NULLIF(wm.last_synced_at, ''), '') != ''
      AND datetime(COALESCE(NULLIF(wm.joined_at, ''), NULLIF(wm.last_synced_at, '')))
        >= datetime(@createdAt, '-30 minutes')
    ORDER BY
      datetime(COALESCE(NULLIF(wm.joined_at, ''), NULLIF(wm.last_synced_at, ''), '1970-01-01 00:00:00')) DESC,
      wm.id DESC
    LIMIT 2
  `).all(params);

  return uniqueRecentMembers.length === 1 ? uniqueRecentMembers[0] : null;
}

function buildInviteResultFromMember(member = {}, task = {}) {
  const workspaceId = normalizeText(member.workspace_id);
  const workspaceName = normalizeText(member.workspace_name) || workspaceId;
  const accountEmail = normalizeText(member.account_email);
  const targetEmail = normalizeText(task.account_email || member.email);
  const message = localizeTeamInviteSuccessMessage('', {
    target_email: targetEmail,
    workspace_name: workspaceName,
  });

  return {
    success: true,
    reconciled_from_member: true,
    message,
    used_account: accountEmail,
    used_account_id: member.account_id || null,
    requested_account_id: member.account_id || null,
    remote_member_id: normalizeText(member.user_id),
    remote_account_user_id: normalizeText(member.account_user_id),
    delivery_type: 'member_reconcile',
    workspace_id: workspaceId,
    workspace_name: workspaceName,
    cdk_task_id: normalizeText(task.id),
    plan_type: normalizeText(member.plan_type),
    status: 'accepted',
    member_joined_at: normalizeText(member.joined_at),
  };
}

function findFirstSuccessfulTaskForSameCdk(task) {
  let cdkCode = normalizeText(task.cdk_code);
  if (!cdkCode && task.cdk_id) {
    const card = db.prepare('SELECT code FROM cdk_cards WHERE id = ?').get(task.cdk_id);
    cdkCode = normalizeText(card?.code);
  }

  if (!task.cdk_id && !cdkCode) {
    return null;
  }

  return db.prepare(`
    SELECT existing.*
    FROM cdk_tasks existing
    LEFT JOIN cdk_cards existing_card ON existing_card.id = existing.cdk_id
    WHERE existing.task_type = 'team_invite'
      AND existing.status = 'SUCCESS'
      AND existing.id != @taskId
      AND (
        (@cdkId IS NOT NULL AND existing.cdk_id = @cdkId)
        OR (
          @cdkCode != ''
          AND LOWER(TRIM(COALESCE(NULLIF(TRIM(existing.cdk_code), ''), existing_card.code, ''))) = LOWER(TRIM(@cdkCode))
        )
      )
    ORDER BY datetime(COALESCE(NULLIF(existing.completed_at, ''), existing.updated_at, existing.created_at)) ASC,
             datetime(existing.created_at) ASC,
             existing.id ASC
    LIMIT 1
  `).get({
    taskId: task.id,
    cdkId: task.cdk_id ?? null,
    cdkCode,
  });
}

function getTaskCdkCode(task = {}) {
  let cdkCode = normalizeText(task.cdk_code);
  if (!cdkCode && task.cdk_id) {
    const card = db.prepare('SELECT code FROM cdk_cards WHERE id = ?').get(task.cdk_id);
    cdkCode = normalizeText(card?.code);
  }
  return cdkCode;
}

function markCdkCardUsedForTask(task = {}) {
  const cdkId = Number(task.cdk_id || 0);
  const cdkCode = getTaskCdkCode(task);
  const assignedEmail = task.account_email || '';

  if (cdkId > 0) {
    const changes = db.prepare(`
      UPDATE cdk_cards
      SET status = 'used',
          assigned_email = ?,
          used_at = COALESCE(used_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(assignedEmail, cdkId).changes;

    return { changes, cdkId, cdkCode };
  }

  if (!cdkCode) {
    return { changes: 0, cdkId: null, cdkCode: '' };
  }

  const card = db.prepare('SELECT id FROM cdk_cards WHERE code = ?').get(cdkCode);
  if (!card?.id) {
    return { changes: 0, cdkId: null, cdkCode };
  }

  if (task.id) {
    db.prepare(`
      UPDATE cdk_tasks
      SET cdk_id = ?
      WHERE id = ?
        AND cdk_id IS NULL
    `).run(card.id, task.id);
  }

  const changes = db.prepare(`
    UPDATE cdk_cards
    SET status = 'used',
        assigned_email = ?,
        used_at = COALESCE(used_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(assignedEmail, card.id).changes;

  return { changes, cdkId: card.id, cdkCode };
}

function resolveInviteAccountId(result = {}, workspaceId = '') {
  const directId = Number(
    result.used_account_id
    || result.account_id
    || result.requested_account_id
    || 0
  );
  if (directId > 0) {
    return directId;
  }

  const accountEmail = normalizeText(result.used_account || result.account_email);
  if (accountEmail) {
    const account = db.prepare('SELECT id FROM accounts WHERE LOWER(email) = LOWER(?) LIMIT 1').get(accountEmail);
    if (account?.id) {
      return Number(account.id);
    }
  }

  const normalizedWorkspaceId = normalizeText(workspaceId || result.workspace_id || result.workspaceId);
  if (normalizedWorkspaceId) {
    const workspace = db.prepare(`
      SELECT account_id
      FROM workspaces
      WHERE workspace_id = ?
      ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC
      LIMIT 1
    `).get(normalizedWorkspaceId);

    if (workspace?.account_id) {
      return Number(workspace.account_id);
    }
  }

  return null;
}

function ensureInviteRecordForCompletedTask(task = {}, result = {}, message = '') {
  const targetEmail = normalizeEmail(task.account_email || result.target_email || result.email);
  const workspaceId = normalizeText(result.workspace_id || result.workspaceId);
  const accountId = resolveInviteAccountId(result, workspaceId);

  if (!accountId || !targetEmail || !workspaceId) {
    return { changed: 0, reason: 'missing_invite_identity' };
  }

  const taskId = normalizeText(task.id || result.cdk_task_id || result.cdkTaskId);
  const status = normalizeText(result.status) === 'accepted' || result.reconciled_from_member
    ? 'accepted'
    : 'sent';
  const workspaceName = normalizeText(result.workspace_name || result.workspaceName);
  const remoteInviteId = normalizeText(result.remote_invite_id || result.remoteInviteId);
  const deliveryType = normalizeText(result.delivery_type) || (status === 'accepted' ? 'member_reconcile' : 'send');
  const requestedAccountId = Number(result.requested_account_id || accountId) || accountId;
  const fallbackFromAccountId = result.fallback_from_account_id || null;
  const inviteMessage = normalizeText(message || result.message)
    || buildTeamInviteSuccessMessage({ target_email: targetEmail, workspace_name: workspaceName || workspaceId });
  const existing = db.prepare(`
    SELECT id
    FROM invites
    WHERE (
        COALESCE(cdk_task_id, '') = @taskId
        OR (
          account_id = @accountId
          AND LOWER(target_email) = LOWER(@targetEmail)
          AND COALESCE(workspace_id, '') = @workspaceId
        )
        OR (
          @remoteInviteId != ''
          AND COALESCE(remote_invite_id, '') = @remoteInviteId
          AND LOWER(target_email) = LOWER(@targetEmail)
        )
      )
    ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC, id DESC
    LIMIT 1
  `).get({
    taskId,
    accountId,
    targetEmail,
    workspaceId,
    remoteInviteId,
  });

  if (existing?.id) {
    const changes = db.prepare(`
      UPDATE invites
      SET account_id = ?,
          requested_account_id = COALESCE(?, requested_account_id),
          fallback_from_account_id = COALESCE(?, fallback_from_account_id),
          status = ?,
          message = ?,
          remote_invite_id = COALESCE(NULLIF(?, ''), remote_invite_id),
          delivery_type = ?,
          workspace_id = ?,
          workspace_name = ?,
          failure_category = '',
          cdk_task_id = COALESCE(NULLIF(cdk_task_id, ''), ?),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      accountId,
      requestedAccountId,
      fallbackFromAccountId,
      status,
      inviteMessage,
      remoteInviteId,
      deliveryType,
      workspaceId,
      workspaceName,
      taskId,
      existing.id
    ).changes;

    return { changed: changes, id: existing.id };
  }

  const insertInfo = db.prepare(`
    INSERT INTO invites (
      account_id,
      requested_account_id,
      fallback_from_account_id,
      target_email,
      status,
      message,
      remote_invite_id,
      delivery_type,
      workspace_id,
      workspace_name,
      failure_category,
      cdk_task_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
  `).run(
    accountId,
    requestedAccountId,
    fallbackFromAccountId,
    targetEmail,
    status,
    inviteMessage,
    remoteInviteId,
    deliveryType,
    workspaceId,
    workspaceName,
    taskId
  );

  return { changed: 1, id: Number(insertInfo.lastInsertRowid) };
}

function buildTaskSourceIdentity(task = {}) {
  const taskId = normalizeText(task.id);
  const cdkCode = getTaskCdkCode(task);
  const cdkId = task.cdk_id == null ? null : Number(task.cdk_id);

  if (!taskId || (!cdkId && !cdkCode)) {
    return null;
  }

  return {
    source_cdk_task_id: taskId,
    source_cdk_id: cdkId || null,
    source_cdk_code: cdkCode,
  };
}

function bindTaskSourceToWorkspaceRows(task = {}, inviteResult = {}) {
  const source = buildTaskSourceIdentity(task);
  if (!source) {
    return { pendingUpdated: 0, membersUpdated: 0 };
  }

  const workspaceId = normalizeText(inviteResult.workspace_id || inviteResult.workspaceId);
  const targetEmail = normalizeEmail(task.account_email || inviteResult.email || inviteResult.target_email);
  const remoteInviteId = normalizeText(inviteResult.remote_invite_id || inviteResult.remoteInviteId);

  if (!workspaceId || !targetEmail) {
    return { pendingUpdated: 0, membersUpdated: 0 };
  }

  let pendingUpdated = 0;
  if (remoteInviteId) {
    pendingUpdated = db.prepare(`
      UPDATE workspace_pending_invites
      SET source_cdk_task_id = ?,
          source_cdk_id = ?,
          source_cdk_code = ?,
          last_synced_at = COALESCE(last_synced_at, datetime('now'))
      WHERE workspace_id = ?
        AND LOWER(email) = LOWER(?)
        AND COALESCE(remote_invite_id, '') = ?
    `).run(
      source.source_cdk_task_id,
      source.source_cdk_id,
      source.source_cdk_code,
      workspaceId,
      targetEmail,
      remoteInviteId
    ).changes;

    if (pendingUpdated === 0) {
      const remoteMatches = db.prepare(`
        SELECT rowid AS row_id
        FROM workspace_pending_invites
        WHERE LOWER(email) = LOWER(?)
          AND COALESCE(remote_invite_id, '') = ?
          AND (COALESCE(source_cdk_task_id, '') = '' OR source_cdk_task_id = ?)
        ORDER BY datetime(COALESCE(NULLIF(last_synced_at, ''), NULLIF(invited_at, ''), '1970-01-01 00:00:00')) DESC,
                 rowid DESC
        LIMIT 2
      `).all(targetEmail, remoteInviteId, source.source_cdk_task_id);

      if (remoteMatches.length === 1) {
        pendingUpdated = db.prepare(`
          UPDATE workspace_pending_invites
          SET source_cdk_task_id = ?,
              source_cdk_id = ?,
              source_cdk_code = ?,
              last_synced_at = COALESCE(last_synced_at, datetime('now'))
          WHERE rowid = ?
        `).run(
          source.source_cdk_task_id,
          source.source_cdk_id,
          source.source_cdk_code,
          remoteMatches[0].row_id
        ).changes;
      }
    }
  } else {
    pendingUpdated = db.prepare(`
      UPDATE workspace_pending_invites
      SET source_cdk_task_id = ?,
          source_cdk_id = ?,
          source_cdk_code = ?,
          last_synced_at = COALESCE(last_synced_at, datetime('now'))
      WHERE workspace_id = ?
        AND LOWER(email) = LOWER(?)
        AND (COALESCE(source_cdk_task_id, '') = '' OR source_cdk_task_id = ?)
    `).run(
      source.source_cdk_task_id,
      source.source_cdk_id,
      source.source_cdk_code,
      workspaceId,
      targetEmail,
      source.source_cdk_task_id
    ).changes;
  }

  const membersUpdated = db.prepare(`
    UPDATE workspace_members
    SET source_cdk_task_id = ?,
        source_cdk_id = ?,
        source_cdk_code = ?,
        last_synced_at = COALESCE(last_synced_at, datetime('now'))
    WHERE workspace_id = ?
      AND LOWER(email) = LOWER(?)
      AND COALESCE(deactivated_time, '') = ''
      AND (COALESCE(source_cdk_task_id, '') = '' OR source_cdk_task_id = ?)
  `).run(
    source.source_cdk_task_id,
    source.source_cdk_id,
    source.source_cdk_code,
    workspaceId,
    targetEmail,
    source.source_cdk_task_id
  ).changes;

  return { pendingUpdated, membersUpdated };
}

function safelyBindTaskSourceToWorkspaceRows(task = {}, inviteResult = {}, options = {}) {
  try {
    return bindTaskSourceToWorkspaceRows(task, inviteResult);
  } catch (err) {
    const taskId = normalizeText(task.id || inviteResult.cdk_task_id || inviteResult.cdkTaskId);
    const source = normalizeText(options.source);
    console.error(
      `[CDK Team Sync] Source binding failed${taskId ? ` for task ${taskId}` : ''}${source ? ` (${source})` : ''}:`,
      err.message
    );
    return {
      pendingUpdated: 0,
      membersUpdated: 0,
      error: err.message,
    };
  }
}

function scheduleCdkTeamTaskCompletionRetry(taskId, inviteResult = {}, options = {}) {
  const normalizedTaskId = normalizeText(taskId);
  if (!normalizedTaskId) {
    return { scheduled: false, reason: 'missing_task_id' };
  }

  if (completionRetryTimers.has(normalizedTaskId)) {
    return { scheduled: false, reason: 'already_scheduled' };
  }

  const attempts = Math.max(1, Math.min(Number(options.attempts || 6) || 6, 20));
  const delayMs = Math.max(1000, Math.min(Number(options.delayMs || 5000) || 5000, 60000));
  const source = normalizeText(options.source) || 'completion_retry';
  let attempt = 0;

  const finish = () => {
    completionRetryTimers.delete(normalizedTaskId);
  };

  const run = () => {
    attempt += 1;

    try {
      const task = db.prepare('SELECT status FROM cdk_tasks WHERE id = ?').get(normalizedTaskId);
      if (!task) {
        finish();
        return;
      }

      if (normalizeText(task.status).toUpperCase() === 'SUCCESS') {
        finish();
        return;
      }

      const result = completeCdkTeamTask(normalizedTaskId, inviteResult, {
        source: `${source}_${attempt}`,
      });

      if (result.completed || result.reason === 'cdk_already_completed') {
        finish();
        return;
      }

      if (attempt >= attempts) {
        console.error(
          `[CDK Team Sync] Task ${normalizedTaskId} still not completed after ${attempts} retries: ${result.reason || 'unknown'}`
        );
        finish();
        return;
      }
    } catch (err) {
      if (attempt >= attempts) {
        console.error(
          `[CDK Team Sync] Task ${normalizedTaskId} completion retry exhausted:`,
          err.message
        );
        finish();
        return;
      }

      console.error(
        `[CDK Team Sync] Task ${normalizedTaskId} completion retry failed (${attempt}/${attempts}):`,
        err.message
      );
    }

    const timer = setTimeout(run, delayMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    completionRetryTimers.set(normalizedTaskId, timer);
  };

  const timer = setTimeout(run, delayMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  completionRetryTimers.set(normalizedTaskId, timer);

  return { scheduled: true, attempts, delayMs };
}

function completeCdkTeamTask(taskId, inviteResult = {}, options = {}) {
  const normalizedTaskId = normalizeText(taskId);
  if (!normalizedTaskId) {
    return { completed: false, reason: 'missing_task_id' };
  }

  const task = db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(normalizedTaskId);
  if (!task) {
    return { completed: false, reason: 'task_not_found' };
  }

  if (normalizeText(task.task_type) && normalizeText(task.task_type) !== 'team_invite') {
    return { completed: false, reason: 'not_team_invite_task' };
  }

  if (normalizeText(task.status).toUpperCase() === 'SUCCESS') {
    const existingInviteResult = parseJsonSafely(task.invite_result_json);
    const sourceBinding = safelyBindTaskSourceToWorkspaceRows(
      task,
      { ...existingInviteResult, ...inviteResult },
      { source: options.source || 'already_success' }
    );

    return {
      completed: true,
      alreadyCompleted: true,
      task,
      inviteResult: existingInviteResult,
      sourceBinding,
    };
  }

  const existingSuccess = findFirstSuccessfulTaskForSameCdk(task);
  if (existingSuccess) {
    markDuplicateTeamCdkTaskUntracked(task, existingSuccess, {
      source: options.source || 'cdk_task_sync_duplicate',
      inviteResult,
    });

    return {
      completed: false,
      reason: 'cdk_already_completed',
      task,
      existingTask: existingSuccess,
    };
  }

  const result = {
    ...parseJsonSafely(task.invite_result_json),
    ...inviteResult,
    success: true,
    ...buildTaskSourceIdentity(task),
    cdk_task_sync_source: options.source || 'unknown',
    cdk_task_synced_at: new Date().toISOString(),
  };
  const workspaceName = normalizeText(result.workspace_name || result.workspaceName || result.workspace_id || result.workspaceId);
  const message = localizeTeamInviteSuccessMessage(result.message, {
    ...result,
    target_email: task.account_email,
    account_email: task.account_email,
    workspace_name: workspaceName,
  });
  result.message = message;
  const resultJson = JSON.stringify(result);
  let inviteLinkChanges = 0;
  let ensuredInviteRecord = null;

  const complete = db.transaction(() => {
    db.prepare(`
      UPDATE cdk_tasks
      SET status = 'SUCCESS',
          status_message = ?,
          error_message = '',
          invite_result_json = ?,
          completed_at = COALESCE(completed_at, datetime('now')),
          updated_at = datetime('now')
      WHERE id = ?
    `).run(message, resultJson, normalizedTaskId);

    markCdkCardUsedForTask(task);

    const inviteId = Number(result.invite_id || result.inviteId || 0);
    const remoteInviteId = normalizeText(result.remote_invite_id || result.remoteInviteId);
    const workspaceId = normalizeText(result.workspace_id || result.workspaceId);
    const targetEmail = normalizeEmail(task.account_email);

    if (inviteId > 0) {
      inviteLinkChanges += db.prepare(`
        UPDATE invites
        SET cdk_task_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND LOWER(target_email) = LOWER(?)
          AND (COALESCE(cdk_task_id, '') = '' OR cdk_task_id = ?)
      `).run(normalizedTaskId, inviteId, targetEmail, normalizedTaskId).changes;
    } else if (remoteInviteId) {
      const matches = db.prepare(`
        SELECT id
        FROM invites
        WHERE remote_invite_id = ?
          AND LOWER(target_email) = LOWER(?)
          AND COALESCE(status, '') IN ('sent', 'accepted')
          AND (COALESCE(cdk_task_id, '') = '' OR cdk_task_id = ?)
        ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC
        LIMIT 2
      `).all(remoteInviteId, targetEmail, normalizedTaskId);

      if (matches.length === 1) {
        inviteLinkChanges += db.prepare(`
          UPDATE invites
          SET cdk_task_id = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizedTaskId, matches[0].id).changes;
      }
    } else if (workspaceId && targetEmail) {
      const matches = db.prepare(`
        SELECT id
        FROM invites
        WHERE workspace_id = ?
          AND LOWER(target_email) = LOWER(?)
          AND COALESCE(status, '') IN ('sent', 'accepted')
          AND COALESCE(cdk_task_id, '') = ''
        ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC
        LIMIT 2
      `).all(workspaceId, targetEmail);

      if (matches.length === 1) {
        inviteLinkChanges += db.prepare(`
          UPDATE invites
          SET cdk_task_id = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizedTaskId, matches[0].id).changes;
      }
    }

    if (inviteLinkChanges === 0) {
      ensuredInviteRecord = ensureInviteRecordForCompletedTask(task, result, message);
    }
  });

  complete();
  const sourceBinding = safelyBindTaskSourceToWorkspaceRows(task, result, {
    source: options.source || 'complete_task',
  });

  return {
    completed: true,
    task,
    inviteResult: result,
    ensuredInviteRecord,
    sourceBinding,
  };
}

function reconcileCdkTeamTaskSuccess(taskId, options = {}) {
  const task = typeof taskId === 'object' && taskId
    ? taskId
    : db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskId);

  if (!task) {
    return { reconciled: false, reason: 'task_not_found' };
  }

  const invite = findSuccessfulInviteForTask(task);
  if (invite) {
    const result = completeCdkTeamTask(
      task.id,
      buildInviteResultFromInvite(invite),
      { source: options.source || 'invite_record_reconcile' }
    );

    return {
      reconciled: Boolean(result.completed),
      invite,
      ...result,
    };
  }

  const pendingInvite = findSuccessfulPendingInviteForTask(task);
  if (pendingInvite) {
    const result = completeCdkTeamTask(
      task.id,
      buildInviteResultFromPendingInvite(pendingInvite, task),
      { source: options.source || 'pending_invite_reconcile' }
    );

    return {
      reconciled: Boolean(result.completed),
      pendingInvite,
      ...result,
    };
  }

  const member = findSuccessfulMemberForTask(task);
  if (!member) {
    return { reconciled: false, reason: 'success_invite_pending_or_member_not_found' };
  }

  const result = completeCdkTeamTask(
    task.id,
    buildInviteResultFromMember(member, task),
    { source: options.source || 'member_record_reconcile' }
  );

  return {
    reconciled: Boolean(result.completed),
    member,
    ...result,
  };
}

module.exports = {
  completeCdkTeamTask,
  scheduleCdkTeamTaskCompletionRetry,
  reconcileCdkTeamTaskSuccess,
  findSuccessfulInviteForTask,
  findSuccessfulPendingInviteForTask,
  findSuccessfulMemberForTask,
  buildInviteResultFromInvite,
  buildInviteResultFromPendingInvite,
  buildInviteResultFromMember,
  buildTeamInviteSuccessMessage,
  localizeTeamInviteSuccessMessage,
  bindTaskSourceToWorkspaceRows,
};
