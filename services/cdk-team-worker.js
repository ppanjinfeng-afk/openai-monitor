const db = require('../db');
const fetch = require('node-fetch');
const {
  completeCdkTeamTask,
  scheduleCdkTeamTaskCompletionRetry,
  reconcileCdkTeamTaskSuccess,
} = require('./cdk-team-task-sync');

const TEAM_INVITE_REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.CDK_TEAM_INVITE_TIMEOUT_MS || 300000)
);
const TEAM_WORKER_CONCURRENCY = Math.max(
  1,
  Math.min(Number(process.env.CDK_TEAM_WORKER_CONCURRENCY || 1) || 1, 5)
);

class CdkTeamWorker {
  constructor() {
    this.processing = new Set();
    this.queued = new Set();
    this.queue = [];
    this.activeCount = 0;
    this.concurrency = TEAM_WORKER_CONCURRENCY;
  }

  async processTask(taskId) {
    const normalizedTaskId = String(taskId || '').trim();
    if (!normalizedTaskId) {
      return;
    }

    if (this.processing.has(normalizedTaskId) || this.queued.has(normalizedTaskId)) {
      console.log(`[CDK Team Worker] Task ${normalizedTaskId} already queued/processing, skipping`);
      return;
    }

    this.queued.add(normalizedTaskId);
    this.queue.push(normalizedTaskId);
    this.drainQueue();
  }

  drainQueue() {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const taskId = this.queue.shift();
      this.queued.delete(taskId);
      this.activeCount += 1;

      this.runTask(taskId)
        .catch(err => {
          console.error(`[CDK Team Worker] Task ${taskId} crashed:`, err.message);
        })
        .finally(() => {
          this.activeCount -= 1;
          this.drainQueue();
        });
    }
  }

  async runTask(taskId) {
    if (this.processing.has(taskId)) {
      console.log(`[CDK Team Worker] Task ${taskId} already processing, skipping`);
      return;
    }

    this.processing.add(taskId);

    try {
      const task = db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskId);
      if (!task) {
        throw new Error('Task not found');
      }

      const email = String(task.account_email || '').trim();
      if (!email) {
        throw new Error('Target email is required');
      }

      this.updateTask(taskId, 'PROCESSING', '正在发送 Team 邀请...');

      const result = await this.sendAutoInvite(email, task);
      this.completeTask(taskId, result);
    } catch (err) {
      console.error(`[CDK Team Worker] Task ${taskId} failed:`, err.message);
      if (await this.tryReconcileBeforeFail(taskId, err.message)) {
        return;
      }
      this.failTask(taskId, err.message);
    } finally {
      this.processing.delete(taskId);
    }
  }

  shouldDelayReconcile(errorMessage) {
    const message = String(errorMessage || '').toLowerCase();
    return message.includes('timeout')
      || message.includes('abort')
      || message.includes('socket hang up')
      || message.includes('超时')
      || message.includes('超時');
  }

  async tryReconcileBeforeFail(taskId, errorMessage) {
    const immediate = reconcileCdkTeamTaskSuccess(taskId, {
      source: 'worker_failure_immediate_reconcile',
    });
    if (immediate.reconciled) {
      console.log(`[CDK Team Worker] Task ${taskId} reconciled as success from invite record`);
      return true;
    }

    if (!this.shouldDelayReconcile(errorMessage)) {
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, 15000));
    const delayed = reconcileCdkTeamTaskSuccess(taskId, {
      source: 'worker_failure_delayed_reconcile',
    });
    if (delayed.reconciled) {
      console.log(`[CDK Team Worker] Task ${taskId} reconciled as success after delayed invite check`);
      return true;
    }

    return false;
  }

  async sendAutoInvite(email, task = null) {
    const baseUrl = process.env.INTERNAL_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TEAM_INVITE_REQUEST_TIMEOUT_MS);
    let response;

    try {
      response = await fetch(`${baseUrl}/api/accounts/auto-invite`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-openai-monitor-internal': '1',
        },
        body: JSON.stringify({
          email,
          prefer_fresh_workspace: true,
          cdk_task_id: task?.id || '',
          cdk_id: task?.cdk_id || '',
          cdk_code: task?.cdk_code || '',
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`Team 邀请请求超时（${Math.round(TEAM_INVITE_REQUEST_TIMEOUT_MS / 1000)} 秒）`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    const raw = await response.text();
    let data = null;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new Error(data?.error || raw || `Invite request failed with HTTP ${response.status}`);
    }

    return data || {};
  }

  updateTask(taskId, status, message) {
    db.prepare(`
      UPDATE cdk_tasks
      SET status = ?, status_message = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(status, message, taskId);
  }

  completeTask(taskId, inviteResult) {
    try {
      const syncResult = completeCdkTeamTask(taskId, inviteResult, { source: 'worker_response' });
      if (!syncResult.completed && syncResult.reason !== 'cdk_already_completed') {
        const retry = scheduleCdkTeamTaskCompletionRetry(taskId, inviteResult, {
          source: 'worker_response_retry',
        });
        console.error(
          `[CDK Team Worker] Task ${taskId} invite succeeded but completion sync did not finish (${syncResult.reason || 'unknown'}); retry ${retry.scheduled ? 'scheduled' : retry.reason || 'skipped'}`
        );
      }
    } catch (err) {
      const retry = scheduleCdkTeamTaskCompletionRetry(taskId, inviteResult, {
        source: 'worker_response_retry',
      });
      console.error(
        `[CDK Team Worker] Task ${taskId} invite succeeded but completion sync failed; retry ${retry.scheduled ? 'scheduled' : retry.reason || 'skipped'}:`,
        err.message
      );
    }
    return;

    const task = db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskId);
    if (!task) {
      return;
    }

    const resultJson = JSON.stringify(inviteResult || {});
    const workspaceName = inviteResult.workspace_name || inviteResult.workspace_id || '';
    const message = workspaceName
      ? `Team 邀请已发送，请检查邮箱并接受邀请（${workspaceName}）`
      : 'Team 邀请已发送，请检查邮箱并接受邀请';

    const complete = db.transaction(() => {
      db.prepare(`
        UPDATE cdk_tasks
        SET status = 'SUCCESS',
            status_message = ?,
            error_message = '',
            invite_result_json = ?,
            completed_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(message, resultJson, taskId);

      db.prepare(`
        UPDATE cdk_cards
        SET status = 'used',
            assigned_email = ?,
            used_at = datetime('now'),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(task.account_email || '', task.cdk_id);
    });

    complete();
  }

  failTask(taskId, errorMessage) {
    const task = db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskId);
    if (task?.status === 'SUCCESS') {
      return;
    }

    const shouldHoldCdk = this.shouldDelayReconcile(errorMessage);
    const fail = db.transaction(() => {
      const taskResult = db.prepare(`
        UPDATE cdk_tasks
        SET status = 'FAILED',
            status_message = 'Team 邀请失败',
            error_message = ?,
            updated_at = datetime('now')
        WHERE id = ?
          AND status != 'SUCCESS'
      `).run(errorMessage, taskId);

      if (taskResult.changes > 0 && task?.cdk_id && !shouldHoldCdk) {
        db.prepare(`
          UPDATE cdk_cards
          SET status = 'unused',
              assigned_email = '',
              updated_at = datetime('now')
          WHERE id = ?
            AND status = 'processing'
        `).run(task.cdk_id);
      }
    });

    fail();
  }
}

module.exports = new CdkTeamWorker();
