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

function buildInviteResultFromInvite(invite = {}) {
  const accountEmail = normalizeText(invite.account_email);
  const workspaceName = normalizeText(invite.workspace_name);
  const workspaceId = normalizeText(invite.workspace_id);
  const message = normalizeText(invite.message)
    || `Team invite sent${accountEmail ? ` by ${accountEmail}` : ''}`;

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
  const message = normalizeText(result.message)
    || (workspaceName
      ? `Team invite sent, please check email and accept invite (${workspaceName})`
      : 'Team invite sent, please check email and accept invite');
  const resultJson = JSON.stringify(result);

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

    if (task.cdk_id) {
      db.prepare(`
        UPDATE cdk_cards
        SET status = 'used',
            assigned_email = ?,
            used_at = COALESCE(used_at, datetime('now')),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(task.account_email || '', task.cdk_id);
    }

    const inviteId = Number(result.invite_id || result.inviteId || 0);
    const remoteInviteId = normalizeText(result.remote_invite_id || result.remoteInviteId);
    const workspaceId = normalizeText(result.workspace_id || result.workspaceId);
    const targetEmail = normalizeEmail(task.account_email);

    if (inviteId > 0) {
      db.prepare(`
        UPDATE invites
        SET cdk_task_id = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND LOWER(target_email) = LOWER(?)
          AND (COALESCE(cdk_task_id, '') = '' OR cdk_task_id = ?)
      `).run(normalizedTaskId, inviteId, targetEmail, normalizedTaskId);
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
        db.prepare(`
          UPDATE invites
          SET cdk_task_id = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizedTaskId, matches[0].id);
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
        db.prepare(`
          UPDATE invites
          SET cdk_task_id = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(normalizedTaskId, matches[0].id);
      }
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
    sourceBinding,
  };
}

function reconcileCdkTeamTaskSuccess(taskId, options = {}) {
  const invite = findSuccessfulInviteForTask(taskId);
  if (!invite) {
    return { reconciled: false, reason: 'success_invite_not_found' };
  }

  const result = completeCdkTeamTask(
    taskId,
    buildInviteResultFromInvite(invite),
    { source: options.source || 'invite_record_reconcile' }
  );

  return {
    reconciled: Boolean(result.completed),
    invite,
    ...result,
  };
}

module.exports = {
  completeCdkTeamTask,
  scheduleCdkTeamTaskCompletionRetry,
  reconcileCdkTeamTaskSuccess,
  findSuccessfulInviteForTask,
  buildInviteResultFromInvite,
  bindTaskSourceToWorkspaceRows,
};
