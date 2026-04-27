const db = require('../db');
const fetch = require('node-fetch');

const TEAM_INVITE_REQUEST_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.CDK_TEAM_INVITE_TIMEOUT_MS || 120000)
);

class CdkTeamWorker {
  constructor() {
    this.processing = new Set();
  }

  async processTask(taskId) {
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
      this.failTask(taskId, err.message);
    } finally {
      this.processing.delete(taskId);
    }
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

    const fail = db.transaction(() => {
      db.prepare(`
        UPDATE cdk_tasks
        SET status = 'FAILED',
            status_message = 'Team 邀请失败',
            error_message = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(errorMessage, taskId);

      if (task?.cdk_id) {
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
