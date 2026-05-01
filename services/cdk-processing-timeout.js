const db = require('../db');
const { reconcileCdkTeamTaskSuccess } = require('./cdk-team-task-sync');

const PROCESSING_TIMEOUT_MINUTES = Math.max(
  1,
  Number(process.env.CDK_PROCESSING_TIMEOUT_MINUTES || 10)
);
const RECENT_RECONCILE_DAYS = 2;

function secondsSinceSql(alias, preferredColumn = 'updated_at') {
  const prefix = alias ? `${alias}.` : '';
  const timestampSql = `COALESCE(
        NULLIF(${prefix}${preferredColumn}, ''),
        NULLIF(${prefix}created_at, ''),
        '1970-01-01 00:00:00'
      )`;

  return `
    CASE
      WHEN ${timestampSql} > datetime('now', '+1 hour')
        THEN (strftime('%s', 'now', 'localtime') - strftime('%s', ${timestampSql}))
      ELSE (strftime('%s', 'now') - strftime('%s', ${timestampSql}))
    END
  `;
}

function releaseStaleProcessingCdks(options = {}) {
  const log = Boolean(options.log);
  let reconciledTasks = 0;

  try {
    reconciledTasks = reconcileSuccessfulTeamInvites({ log });
  } catch (err) {
    console.error('[CDK Timeout] Reconcile failed, continue stale release:', err.message);
  }

  const timeoutSeconds = PROCESSING_TIMEOUT_MINUTES * 60;
  const timeoutMessage = `处理超过 ${PROCESSING_TIMEOUT_MINUTES} 分钟未完成，已释放 CDK，可重新提交激活`;

  const release = db.transaction(() => {
    const taskResult = db.prepare(`
      UPDATE cdk_tasks
      SET status = 'FAILED',
          status_message = '处理超时',
          error_message = ?,
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE UPPER(COALESCE(status, '')) IN ('PENDING', 'PROCESSING')
        AND ${secondsSinceSql('cdk_tasks')} >= ?
        AND NOT EXISTS (
          SELECT 1
          FROM cdk_tasks success_task
          WHERE success_task.cdk_id = cdk_tasks.cdk_id
            AND success_task.task_type = 'team_invite'
            AND success_task.status = 'SUCCESS'
        )
    `).run(timeoutMessage, timeoutSeconds);

    const cardResult = db.prepare(`
      UPDATE cdk_cards
      SET status = 'unused',
          assigned_email = '',
          updated_at = datetime('now')
      WHERE status = 'processing'
        AND NOT EXISTS (
          SELECT 1
          FROM cdk_tasks success_task
          WHERE success_task.cdk_id = cdk_cards.id
            AND success_task.task_type = 'team_invite'
            AND success_task.status = 'SUCCESS'
        )
        AND (
          ${secondsSinceSql('cdk_cards')} >= ?
          OR EXISTS (
            SELECT 1
            FROM cdk_tasks stale_task
            WHERE stale_task.cdk_id = cdk_cards.id
              AND UPPER(COALESCE(stale_task.status, '')) IN ('PENDING', 'PROCESSING')
              AND ${secondsSinceSql('stale_task')} >= ?
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM cdk_tasks active_task
          WHERE active_task.cdk_id = cdk_cards.id
            AND UPPER(COALESCE(active_task.status, '')) IN ('PENDING', 'PROCESSING')
            AND ${secondsSinceSql('active_task')} < ?
        )
    `).run(timeoutSeconds, timeoutSeconds, timeoutSeconds);

    return {
      timedOutTasks: taskResult.changes,
      releasedCards: cardResult.changes,
      reconciledTasks,
      timeoutMinutes: PROCESSING_TIMEOUT_MINUTES,
    };
  });

  const result = release();
  if (log && (result.timedOutTasks || result.releasedCards || result.reconciledTasks)) {
    console.log(
      `[CDK Timeout] Reconciled ${result.reconciledTasks} successful invite task(s), released ${result.releasedCards} stale processing CDK(s), marked ${result.timedOutTasks} task(s) as failed`
    );
  }

  return result;
}

function reconcileSuccessfulTeamInvites(options = {}) {
  const log = Boolean(options.log);
  let tasks = [];

  try {
    tasks = db.prepare(`
      SELECT t.*
      FROM cdk_tasks t
      LEFT JOIN cdk_cards c ON c.id = t.cdk_id
      WHERE t.task_type = 'team_invite'
        AND UPPER(COALESCE(t.status, '')) IN ('FAILED', 'PENDING', 'PROCESSING')
        AND COALESCE(c.status, '') IN ('unused', 'processing', '')
        AND ${secondsSinceSql('t')} <= ?
      ORDER BY datetime(COALESCE(NULLIF(t.updated_at, ''), t.created_at)) DESC
      LIMIT 200
    `).all(RECENT_RECONCILE_DAYS * 24 * 60 * 60);
  } catch (err) {
    console.error('[CDK Timeout] Failed to load reconcile candidates:', err.message);
    return 0;
  }

  let reconciled = 0;
  const reconciledCardIds = new Set();
  for (const task of tasks) {
    if (task.cdk_id && reconciledCardIds.has(task.cdk_id)) {
      continue;
    }

    try {
      const result = reconcileCdkTeamTaskSuccess(task.id, {
        source: 'processing_timeout_reconcile',
      });
      if (result.reconciled) {
        reconciled += 1;
        if (task.cdk_id) {
          reconciledCardIds.add(task.cdk_id);
        }
      }
    } catch (err) {
      if (log) {
        console.error(`[CDK Timeout] Failed to reconcile task ${task.id}:`, err.message);
      }
    }
  }

  return reconciled;
}

module.exports = {
  PROCESSING_TIMEOUT_MINUTES,
  releaseStaleProcessingCdks,
  reconcileSuccessfulTeamInvites,
};
