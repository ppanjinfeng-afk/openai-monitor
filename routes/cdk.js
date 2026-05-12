const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const cdkWorker = require('../services/cdk-worker');
const cdkTeamWorker = require('../services/cdk-team-worker');
const { createCdkCard } = require('../services/cdk-utils');
const {
  PRODUCT_TYPE: TEAM_PRODUCT_TYPE,
  getTeamActivationAvailability,
} = require('../services/team-stock');
const { refreshInventoryInBackground } = require('../services/inventory-sync');
const { releaseStaleProcessingCdks } = require('../services/cdk-processing-timeout');
const {
  reconcileCdkTeamTaskSuccess,
  localizeTeamInviteSuccessMessage,
} = require('../services/cdk-team-task-sync');

const router = express.Router();

/**
 * Generate a random CDK code (16 chars alphanumeric uppercase)
 */
function generateCdkCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  const bytes = crypto.randomBytes(16);
  for (let i = 0; i < 16; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}

/**
 * Generate a UUID v4 for task IDs
 */
function generateTaskId() {
  return crypto.randomBytes(16).toString('hex');
}

function generatePublicToken() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeTaskStatus(status) {
  return String(status || '').trim().toUpperCase();
}

function makeHttpError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function getLatestTeamTaskForCard(cardId) {
  return db.prepare(`
    SELECT *
    FROM cdk_tasks
    WHERE cdk_id = ?
      AND task_type = 'team_invite'
    ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC
    LIMIT 1
  `).get(cardId);
}

function getSuccessfulTeamTaskForCard(cardId) {
  return db.prepare(`
    SELECT *
    FROM cdk_tasks
    WHERE cdk_id = ?
      AND task_type = 'team_invite'
      AND status = 'SUCCESS'
    ORDER BY datetime(COALESCE(NULLIF(completed_at, ''), updated_at, created_at)) DESC
    LIMIT 1
  `).get(cardId);
}

function getActiveTeamTaskForCard(cardId) {
  return db.prepare(`
    SELECT *
    FROM cdk_tasks
    WHERE cdk_id = ?
      AND task_type = 'team_invite'
      AND UPPER(status) IN ('PENDING', 'PROCESSING')
    ORDER BY datetime(COALESCE(NULLIF(updated_at, ''), created_at)) DESC
    LIMIT 1
  `).get(cardId);
}

function markCardUsedFromTask(task) {
  if (!task?.cdk_id) {
    return;
  }
  db.prepare(`
    UPDATE cdk_cards
    SET status = 'used',
        assigned_email = COALESCE(NULLIF(assigned_email, ''), ?),
        used_at = COALESCE(used_at, datetime('now')),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(task.account_email || '', task.cdk_id);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function parseJsonSafely(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getDisplayTaskStatusMessage(task, inviteResult = null) {
  const message = task?.status_message || '';

  if (
    String(task?.task_type || '') === 'team_invite'
    && normalizeTaskStatus(task?.status) === 'SUCCESS'
  ) {
    return localizeTeamInviteSuccessMessage(message, {
      ...(inviteResult || {}),
      target_email: task.account_email,
      account_email: task.account_email,
    });
  }

  return message;
}

function getSubmittedTaskToken(req) {
  return String(req.query.token || req.get('x-task-token') || '').trim();
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function hasValidTaskToken(req, task) {
  const token = getSubmittedTaskToken(req);
  return Boolean(task?.task_token && token && safeEqual(token, task.task_token));
}

function isTeamInvitePlan(card) {
  return String(card?.plan_type || '').trim().toLowerCase() === TEAM_PRODUCT_TYPE;
}

function getTeamInventoryPayload(card) {
  if (!isTeamInvitePlan(card)) {
    return {
      activationAllowed: true,
      stockCount: null,
      activationStockCount: null,
      reservedCount: 0,
      heldCount: 0,
      reservationActive: false,
      orderHoldWindowMinutes: null,
      cdkReserveWindowMinutes: null,
      inventoryMessage: '',
    };
  }

  const inventory = getTeamActivationAvailability(card);
  return {
    activationAllowed: inventory.activationAllowed,
    stockCount: inventory.stockCount,
    activationStockCount: inventory.activationStockCount,
    reservedCount: inventory.reservedCount,
    heldCount: inventory.heldCount,
    reservationActive: inventory.reservationActive,
    orderHoldWindowMinutes: inventory.orderHoldWindowMinutes,
    cdkReserveWindowMinutes: inventory.cdkReserveWindowMinutes,
    inventoryMessage: inventory.inventoryMessage,
  };
}

function logCdkRouteError(context, err) {
  console.error(`[CDK Route] ${context}:`, err?.stack || err?.message || err);
}

function runCdkMaintenanceSafely(context) {
  try {
    return releaseStaleProcessingCdks();
  } catch (err) {
    logCdkRouteError(`${context} maintenance failed`, err);
    return null;
  }
}

function refreshInventorySafely(context) {
  try {
    refreshInventoryInBackground();
  } catch (err) {
    logCdkRouteError(`${context} inventory refresh failed`, err);
  }
}

function getTeamInventoryPayloadSafely(card, context) {
  try {
    return getTeamInventoryPayload(card);
  } catch (err) {
    logCdkRouteError(`${context} inventory check failed`, err);
    return {
      activationAllowed: false,
      stockCount: 0,
      activationStockCount: 0,
      reservedCount: 0,
      heldCount: 0,
      reservationActive: false,
      orderHoldWindowMinutes: null,
      cdkReserveWindowMinutes: null,
      inventoryMessage: '库存检查失败，请稍后重试或联系客服处理',
    };
  }
}

function createTeamInviteTask(cardCodeInput, emailInput) {
  const cardCode = String(cardCodeInput || '').trim().toUpperCase();
  const email = normalizeEmail(emailInput);

  if (!cardCode) {
    const err = new Error('缺少 CDK 卡密');
    err.statusCode = 400;
    throw err;
  }

  if (!email || !isValidEmail(email)) {
    const err = new Error('请输入有效的 ChatGPT 邮箱');
    err.statusCode = 400;
    throw err;
  }

  const preflightCard = db.prepare('SELECT * FROM cdk_cards WHERE code = ?').get(cardCode);
  if (preflightCard) {
    const latestTask = getLatestTeamTaskForCard(preflightCard.id);
    if (latestTask && normalizeTaskStatus(latestTask.status) === 'FAILED') {
      try {
        reconcileCdkTeamTaskSuccess(latestTask.id, { source: 'submit_preflight_reconcile' });
      } catch (err) {
        console.error(`[CDK Route] Failed to reconcile task ${latestTask.id} before submit:`, err.message);
      }
    }
  }

  const taskId = generateTaskId();
  const taskToken = generatePublicToken();

  const createTask = db.transaction(() => {
    const card = db.prepare('SELECT * FROM cdk_cards WHERE code = ?').get(cardCode);
    if (!card) {
      const err = new Error('CDK 不存在或已过期');
      err.statusCode = 400;
      throw err;
    }

    const successfulTask = getSuccessfulTeamTaskForCard(card.id);
    if (successfulTask || card.status === 'used') {
      if (successfulTask) {
        markCardUsedFromTask(successfulTask);
      }
      throw makeHttpError('CDK 已使用', 400);
    }

    const activeTask = getActiveTeamTaskForCard(card.id);
    if (activeTask) {
      const activeEmail = normalizeEmail(activeTask.account_email);
      if (activeEmail && activeEmail !== email) {
        throw makeHttpError('CDK 正在处理中，请稍后再试', 409);
      }

      const existingToken = activeTask.task_token || taskToken;
      if (!activeTask.task_token) {
        db.prepare(`
          UPDATE cdk_tasks
          SET task_token = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(existingToken, activeTask.id);
      }

      db.prepare(`
        UPDATE cdk_cards
        SET status = 'processing',
            assigned_email = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(activeTask.account_email || email, card.id);

      return {
        taskId: activeTask.id,
        taskToken: existingToken,
        cardCode,
        email: activeTask.account_email || email,
        reused: true,
      };
    }

    if (card.status !== 'unused') {
      throw makeHttpError(card.status === 'used' ? 'CDK 已使用' : 'CDK 当前不可用', 400);
    }

    const planType = String(card.plan_type || '').toLowerCase();
    if (planType.includes('plus') || planType.includes('pro')) {
      const err = new Error('该 CDK 是 Plus/Pro 充值卡，不支持 Team 邀请兑换');
      err.statusCode = 400;
      throw err;
    }

    const inventory = getTeamInventoryPayloadSafely(card, 'submit-team');
    if (!inventory.activationAllowed) {
      const err = new Error(inventory.inventoryMessage || '当前无库存，暂时无法激活此 CDK，请稍后再试');
      err.statusCode = 409;
      throw err;
    }

    db.prepare(`
      INSERT INTO cdk_tasks (
        id,
        cdk_id,
        cdk_code,
        task_type,
        account_email,
        task_token,
        status,
        status_message
      ) VALUES (?, ?, ?, 'team_invite', ?, ?, 'pending', 'Team 邀请任务已创建')
    `).run(taskId, card.id, cardCode, email, taskToken);

    db.prepare(`
      UPDATE cdk_cards
      SET status = 'processing',
          assigned_email = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).run(email, card.id);

    return {
      taskId,
      taskToken,
      cardCode,
      email,
    };
  });

  const created = createTask();

  if (!created.reused) {
    cdkTeamWorker.processTask(created.taskId).catch(err => {
      console.error('[CDK Route] Team background task error:', err.message);
    });
  }

  return created;
}

function detachCdkReferences(cardIds) {
  const ids = Array.from(new Set(
    (Array.isArray(cardIds) ? cardIds : [cardIds])
      .map(id => Number(id))
      .filter(id => Number.isInteger(id) && id > 0)
  ));

  if (ids.length === 0) {
    return { taskRefs: 0, orderRefs: 0, orderItemRefs: 0 };
  }

  const placeholders = ids.map(() => '?').join(',');
  const taskRefs = db.prepare(`
    UPDATE cdk_tasks
    SET cdk_id = NULL
    WHERE cdk_id IN (${placeholders})
  `).run(...ids).changes;
  const orderRefs = db.prepare(`
    UPDATE cdk_orders
    SET cdk_id = NULL
    WHERE cdk_id IN (${placeholders})
  `).run(...ids).changes;
  const orderItemRefs = db.prepare(`
    UPDATE cdk_order_items
    SET cdk_id = NULL
    WHERE cdk_id IN (${placeholders})
  `).run(...ids).changes;

  return { taskRefs, orderRefs, orderItemRefs };
}

// ============================================
// CDK Management APIs (Admin)
// ============================================

/**
 * GET /api/cdk/list — List all CDK cards with stats
 */
router.get('/list', (req, res) => {
  try {
    runCdkMaintenanceSafely('list');

    const status = req.query.status || 'all';
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim();

    let where = '';
    const params = {};

    if (status !== 'all') {
      where += ' AND status = @status';
      params.status = status;
    }
    if (search) {
      where += ' AND (code LIKE @search OR assigned_email LIKE @search)';
      params.search = `%${search}%`;
    }

    const items = db.prepare(`
      SELECT * FROM cdk_cards 
      WHERE 1=1 ${where}
      ORDER BY created_at DESC 
      LIMIT @limit
      OFFSET @offset
    `).all({ ...params, limit, offset });

    const total = db.prepare(`
      SELECT COUNT(*) AS count
      FROM cdk_cards
      WHERE 1=1 ${where}
    `).get(params);

    const summary = db.prepare(`
      SELECT 
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'unused' THEN 1 ELSE 0 END) AS unused,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used,
        SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired
      FROM cdk_cards
    `).get();

    res.json({
      items,
      summary,
      total: Number(total?.count || 0),
      page,
      limit,
    });
  } catch (err) {
    logCdkRouteError('list failed', err);
    res.status(500).json({
      error: 'CDK 功能台加载失败',
      message: err.message || 'Internal Server Error',
    });
  }
});

/**
 * POST /api/cdk/generate — Generate N CDK cards
 */
router.post('/generate', (req, res) => {
  const count = Math.min(100, Math.max(1, parseInt(req.body.count) || 1));
  const planType = req.body.plan_type || 'plus_monthly';

  const insert = db.prepare(`
    INSERT INTO cdk_cards (code, plan_type) VALUES (?, ?)
  `);

  const codes = [];
  const insertAll = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      if (planType === 'team_invite') {
        const card = createCdkCard({ planType, prefix: 'TEAM' });
        codes.push(card.code);
        continue;
      }

      let code;
      let attempts = 0;
      do {
        code = generateCdkCode();
        attempts++;
      } while (
        db.prepare('SELECT 1 FROM cdk_cards WHERE code = ?').get(code) && 
        attempts < 10
      );

      insert.run(code, planType);
      codes.push(code);
    }
  });

  insertAll();

  res.json({
    message: `成功生成 ${codes.length} 个 CDK`,
    codes,
    count: codes.length,
  });
});

/**
 * DELETE /api/cdk/:id — Delete a CDK card
 */
router.delete('/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id);
  const card = db.prepare('SELECT id FROM cdk_cards WHERE id = ?').get(id);
  if (!card) {
    return res.status(404).json({ error: '记录不存在' });
  }

  const remove = db.transaction(() => {
    const refs = detachCdkReferences([id]);
    const result = db.prepare('DELETE FROM cdk_cards WHERE id = ?').run(id);
    return { deleted: result.changes, ...refs };
  });

  const result = remove();
  res.json({
    message: '已删除',
    deleted: result.deleted,
    detachedTasks: result.taskRefs,
    detachedOrders: result.orderRefs,
    detachedOrderItems: result.orderItemRefs,
  });
});

/**
 * POST /api/cdk/batch-delete — Batch delete CDK cards by status
 */
router.post('/batch-delete', (req, res) => {
  const status = req.body.status;
  if (!status) return res.status(400).json({ error: '请指定要删除的状态' });

  const remove = db.transaction(() => {
    const cards = db.prepare('SELECT id FROM cdk_cards WHERE status = ?').all(status);
    const ids = cards.map(card => card.id);
    const refs = detachCdkReferences(ids);
    const result = db.prepare('DELETE FROM cdk_cards WHERE status = ?').run(status);
    return { deleted: result.changes, ...refs };
  });

  const result = remove();
  res.json({
    message: `已删除 ${result.deleted} 条记录`,
    deleted: result.deleted,
    detachedTasks: result.taskRefs,
    detachedOrders: result.orderRefs,
    detachedOrderItems: result.orderItemRefs,
  });
});

// ============================================
// CDK Redemption APIs (Customer-facing)
// ============================================

/**
 * POST /api/cdk/verify — Verify if a CDK code is valid
 */
router.post('/verify', (req, res) => {
  try {
  runCdkMaintenanceSafely('verify');
  refreshInventorySafely('verify');

  const cardCode = (req.body.cardCode || '').trim().toUpperCase();
  
  if (!cardCode || cardCode.length < 8) {
    return res.json({ 
      valid: false, 
      message: '卡密格式无效',
      cardStatus: '-1',
      isUsed: false,
      isProcessing: false,
      activationAllowed: false,
    });
  }

  const card = db.prepare('SELECT * FROM cdk_cards WHERE code = ?').get(cardCode);
  
  if (!card) {
    return res.json({ 
      valid: false, 
      message: '卡密不存在或已过期',
      cardStatus: '-1',
      isUsed: false,
      isProcessing: false,
      activationAllowed: false,
    });
  }

  if (card.status === 'used') {
    return res.json({ 
      valid: false, 
      message: '此卡密已被使用',
      cardStatus: '1',
      isUsed: true,
      isProcessing: false,
      activationAllowed: false,
    });
  }

  if (card.status === 'expired') {
    return res.json({ 
      valid: false, 
      message: '此卡密已过期',
      cardStatus: '2',
      isUsed: false,
      isProcessing: false,
      activationAllowed: false,
    });
  }

  if (card.status === 'processing') {
    return res.json({
      valid: false,
      message: '此 CDK 正在处理中，请稍后查询任务结果',
      cardStatus: '3',
      isUsed: false,
      isProcessing: true,
      activationAllowed: false,
      planType: card.plan_type,
    });
  }

  const inventory = getTeamInventoryPayloadSafely(card, 'verify');
  const planType = String(card.plan_type || '').toLowerCase();
  let message = '卡密有效，可以兑换';
  if (planType.includes('plus') || planType.includes('pro')) {
    message = '该 CDK 是 Plus/Pro 充值卡，不支持 Team 邀请兑换';
  } else if (!inventory.activationAllowed) {
    message = inventory.inventoryMessage || '当前无库存，暂时无法激活此 CDK，请稍后再试';
  } else if (inventory.reservationActive && Number(inventory.stockCount || 0) <= 0) {
    message = 'CDK 可用，当前前台库存已用完，但这张 CDK 仍在保留期内，可以继续激活';
  }

  res.json({ 
    valid: true, 
    message,
    cardStatus: '0',
    planType: card.plan_type,
    isUsed: false,
    isProcessing: false,
    activationAllowed: inventory.activationAllowed,
    stockCount: inventory.stockCount,
    activationStockCount: inventory.activationStockCount,
    reservedCount: inventory.reservedCount,
    heldCount: inventory.heldCount,
    reservationActive: inventory.reservationActive,
    orderHoldWindowMinutes: inventory.orderHoldWindowMinutes,
    cdkReserveWindowMinutes: inventory.cdkReserveWindowMinutes,
    inventoryMessage: inventory.inventoryMessage,
  });
  } catch (err) {
    logCdkRouteError('verify failed', err);
    return res.json({
      valid: false,
      message: 'CDK 验证失败，请稍后重试或联系客服处理',
      cardStatus: '-1',
      isUsed: false,
      isProcessing: false,
      activationAllowed: false,
      error: 'CDK_VERIFY_FAILED',
    });
  }
});

/**
 * POST /api/cdk/submit — Submit a redemption task
 */
router.post('/submit', (req, res) => {
  const cardCode = (req.body.cardCode || '').trim().toUpperCase();
  const tokenContent = (req.body.tokenContent || '').trim();

  if (!cardCode) {
    return res.status(400).json({ code: 400, msg: '缺少卡密' });
  }
  if (!tokenContent) {
    return res.status(400).json({ code: 400, msg: '缺少 AuthSession 数据' });
  }

  // Verify CDK
  const card = db.prepare('SELECT * FROM cdk_cards WHERE code = ?').get(cardCode);
  if (!card || card.status !== 'unused') {
    return res.status(400).json({ code: 400, msg: '卡密无效或已使用' });
  }

  // Parse session to extract email
  let email = '';
  try {
    const session = JSON.parse(tokenContent);
    email = session.user?.email || session.email || '';
  } catch (e) {
    return res.status(400).json({ code: 400, msg: 'Session JSON 格式错误' });
  }

  // Create task
  const taskId = generateTaskId();
  const taskToken = generatePublicToken();
  
  db.prepare(`
    INSERT INTO cdk_tasks (id, cdk_id, cdk_code, account_email, session_json, status, status_message)
    VALUES (?, ?, ?, ?, ?, 'pending', '任务已创建')
  `).run(taskId, card.id, cardCode, email, tokenContent);

  // Mark CDK as processing
  db.prepare(`
    UPDATE cdk_cards SET status = 'processing', assigned_email = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(email, card.id);

  // Start async processing
  cdkWorker.processTask(taskId).catch(err => {
    console.error(`[CDK Route] Background task error:`, err.message);
  });

  res.json({ 
    code: 200, 
    msg: '任务已提交',
    data: taskId
  });
});

/**
 * POST /api/cdk/submit-team - Submit a CDK task that sends a Team invite.
 */
router.post('/submit-team', async (req, res) => {
  runCdkMaintenanceSafely('submit-team');
  refreshInventorySafely('submit-team');

  const cardCode = (req.body.cardCode || '').trim().toUpperCase();
  const email = normalizeEmail(req.body.email);

  if (!cardCode) {
    return res.status(400).json({ code: 400, msg: '缺少 CDK 卡密' });
  }
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ code: 400, msg: '请输入有效的 ChatGPT 邮箱' });
  }

  try {
    const created = createTeamInviteTask(cardCode, email);

    return res.json({
      code: 200,
      msg: 'Team 邀请任务已提交',
      data: created.taskId,
      taskToken: created.taskToken,
    });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ code: err.statusCode || 500, msg: err.message });
  }
});

/**
 * GET /api/cdk/query/:taskId — Query task status
 */
router.post('/submit-team-batch', async (req, res) => {
  refreshInventorySafely('submit-team-batch');

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) {
    return res.status(400).json({ code: 400, msg: '请至少提供一条批量激活记录' });
  }

  if (items.length > 50) {
    return res.status(400).json({ code: 400, msg: '单次最多批量激活 50 条' });
  }

  const tasks = [];
  const errors = [];
  const seenCodes = new Set();

  items.forEach((item, index) => {
    const lineNumber = index + 1;
    const cardCode = String(item?.cardCode || item?.code || '').trim().toUpperCase();
    const email = normalizeEmail(item?.email);

    if (cardCode && seenCodes.has(cardCode)) {
      errors.push({
        lineNumber,
        cardCode,
        email,
        message: '批量列表中存在重复 CDK',
      });
      return;
    }

    if (cardCode) {
      seenCodes.add(cardCode);
    }

    try {
      const created = createTeamInviteTask(cardCode, email);
      tasks.push({
        lineNumber,
        cardCode: created.cardCode,
        email: created.email,
        taskId: created.taskId,
        taskToken: created.taskToken,
      });
    } catch (err) {
      errors.push({
        lineNumber,
        cardCode,
        email,
        message: err.message,
      });
    }
  });

  res.json({
    code: 200,
    msg: `批量提交完成，成功 ${tasks.length} 条，失败 ${errors.length} 条`,
    successCount: tasks.length,
    failCount: errors.length,
    tasks,
    errors,
  });
});

router.get('/query/:taskId', (req, res) => {
  runCdkMaintenanceSafely('query');

  const taskId = req.params.taskId;
  const task = db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskId);

  if (!task) {
    return res.status(404).json({ code: 404, taskStatus: 'NOT_FOUND', statusMessage: '任务不存在' });
  }

  if (req.isPublicHost && !hasValidTaskToken(req, task)) {
    return res.status(404).json({ code: 404, taskStatus: 'NOT_FOUND', statusMessage: '任务不存在' });
  }

  const publicHost = Boolean(req.isPublicHost);
  const inviteResult = parseJsonSafely(task.invite_result_json);

  res.json({
    code: 200,
    taskStatus: task.status,
    taskType: task.task_type || '',
    statusMessage: getDisplayTaskStatusMessage(task, inviteResult),
    errorMessage: publicHost && task.status === 'FAILED'
      ? '邀请失败，请联系客服处理'
      : (task.error_message || ''),
    accountEmail: task.account_email,
    cardLast4: publicHost ? '' : task.card_last4,
    inviteResult: publicHost ? null : inviteResult,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    completedAt: task.completed_at,
  });
});

/**
 * GET /api/cdk/tasks — List recent tasks (admin)
 */
router.get('/tasks', (req, res) => {
  runCdkMaintenanceSafely('tasks');

  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * limit;
  const tasks = db.prepare(`
    SELECT * FROM cdk_tasks 
    ORDER BY created_at DESC 
    LIMIT ?
    OFFSET ?
  `).all(limit, offset).map((task) => {
    const inviteResult = parseJsonSafely(task.invite_result_json);
    return {
      ...task,
      status_message: getDisplayTaskStatusMessage(task, inviteResult),
    };
  });

  const total = db.prepare('SELECT COUNT(*) AS count FROM cdk_tasks').get();

  res.json({
    tasks,
    total: Number(total?.count || 0),
    page,
    limit,
  });
});

/**
 * GET /api/cdk/trace?search=... - Trace one customer case across order/CDK/task/invite/logs.
 */
router.get('/trace', (req, res) => {
  const search = String(req.query.search || '').trim();
  if (!search) {
    return res.status(400).json({ error: 'search is required' });
  }

  const like = `%${search}%`;
  const orders = db.prepare(`
    SELECT *
    FROM cdk_orders
    WHERE order_no LIKE @like
       OR buyer_email LIKE @like
       OR cdk_code LIKE @like
       OR provider_trade_no LIKE @like
    ORDER BY updated_at DESC
    LIMIT 20
  `).all({ like });

  const cards = db.prepare(`
    SELECT *
    FROM cdk_cards
    WHERE code LIKE @like
       OR assigned_email LIKE @like
       OR buyer_email LIKE @like
       OR source_order_no LIKE @like
    ORDER BY updated_at DESC
    LIMIT 20
  `).all({ like });

  const tasks = db.prepare(`
    SELECT *
    FROM cdk_tasks
    WHERE id LIKE @like
       OR cdk_code LIKE @like
       OR account_email LIKE @like
       OR checkout_session_id LIKE @like
       OR status_message LIKE @like
       OR error_message LIKE @like
    ORDER BY updated_at DESC
    LIMIT 30
  `).all({ like }).map(task => ({
    ...task,
    invite_result: parseJsonSafely(task.invite_result_json),
  }));

  const emails = new Set();
  const addEmail = value => {
    const email = normalizeEmail(value);
    if (isValidEmail(email)) {
      emails.add(email);
    }
  };

  addEmail(search);
  orders.forEach(order => addEmail(order.buyer_email));
  cards.forEach(card => {
    addEmail(card.assigned_email);
    addEmail(card.buyer_email);
  });
  tasks.forEach(task => addEmail(task.account_email));

  const emailList = Array.from(emails);
  let invites = [];
  if (emailList.length > 0) {
    const placeholders = emailList.map(() => '?').join(',');
    invites = db.prepare(`
      SELECT
        i.*,
        a.email AS account_email,
        a.label AS account_label,
        req.email AS requested_account_email,
        fb.email AS fallback_from_account_email
      FROM invites i
      JOIN accounts a ON i.account_id = a.id
      LEFT JOIN accounts req ON i.requested_account_id = req.id
      LEFT JOIN accounts fb ON i.fallback_from_account_id = fb.id
      WHERE LOWER(i.target_email) IN (${placeholders})
      ORDER BY i.updated_at DESC
      LIMIT 50
    `).all(...emailList);
  } else {
    invites = db.prepare(`
      SELECT
        i.*,
        a.email AS account_email,
        a.label AS account_label,
        req.email AS requested_account_email,
        fb.email AS fallback_from_account_email
      FROM invites i
      JOIN accounts a ON i.account_id = a.id
      LEFT JOIN accounts req ON i.requested_account_id = req.id
      LEFT JOIN accounts fb ON i.fallback_from_account_id = fb.id
      WHERE i.target_email LIKE @like
         OR i.message LIKE @like
         OR i.remote_invite_id LIKE @like
      ORDER BY i.updated_at DESC
      LIMIT 50
    `).all({ like });
  }

  const accountIds = Array.from(new Set(invites.map(invite => invite.account_id).filter(Boolean)));
  let logs = db.prepare(`
    SELECT
      l.*,
      a.email,
      a.label
    FROM check_logs l
    LEFT JOIN accounts a ON l.account_id = a.id
    WHERE l.message LIKE @like
    ORDER BY l.checked_at DESC
    LIMIT 50
  `).all({ like });

  if (accountIds.length > 0) {
    const placeholders = accountIds.map(() => '?').join(',');
    const emailLogConditions = emailList.map(() => 'l.message LIKE ?').join(' OR ');
    const emailLogParams = emailList.map(email => `%${email}%`);
    const scopedLogWhere = emailLogConditions
      ? `OR ${emailLogConditions}`
      : '';
    const accountLogs = db.prepare(`
      SELECT
        l.*,
        a.email,
        a.label
      FROM check_logs l
      LEFT JOIN accounts a ON l.account_id = a.id
      WHERE l.account_id IN (${placeholders})
        AND (
          LOWER(l.message) LIKE '%failed%'
          OR LOWER(l.message) LIKE '%error%'
          OR l.message LIKE '%失败%'
          ${scopedLogWhere}
        )
      ORDER BY l.checked_at DESC
      LIMIT 50
    `).all(...accountIds, ...emailLogParams);
    const seen = new Set(logs.map(log => log.id));
    for (const log of accountLogs) {
      if (!seen.has(log.id)) {
        logs.push(log);
      }
    }
    logs = logs
      .sort((a, b) => String(b.checked_at || '').localeCompare(String(a.checked_at || '')))
      .slice(0, 80);
  }

  const latestTask = tasks[0] || null;
  const latestInvite = invites[0] || null;
  let diagnosis = '未找到完整链路，请换订单号、CDK、邮箱或任务 ID 搜索';
  if (latestTask?.status === 'SUCCESS' && latestInvite?.status === 'sent') {
    diagnosis = '系统已向 OpenAI 提交邀请，用户未收到邮件时优先检查垃圾箱、邮箱拼写、是否已是成员，以及远端邀请 ID';
  } else if (latestTask?.status === 'FAILED') {
    diagnosis = latestTask.error_message || latestTask.status_message || '激活任务失败，请查看任务错误';
  } else if (latestInvite?.status === 'accepted') {
    diagnosis = '邀请记录显示该邮箱已接受邀请；如果用户仍说不能用，请到工作区成员列表按邮箱搜索确认成员状态';
  } else if (latestInvite?.status === 'sent') {
    diagnosis = '邀请已发送但尚未接受；用户未收到邮件时检查垃圾箱、邮箱拼写、是否已有同工作区邀请，以及远端邀请 ID';
  } else if (latestTask?.status === 'PROCESSING' || latestTask?.status === 'pending') {
    diagnosis = '激活任务仍在处理或排队，可等待轮询完成；长时间不动时检查本机服务和可用 Team 账号';
  } else if (latestInvite?.status === 'error') {
    diagnosis = latestInvite.message || '邀请记录显示失败';
  } else if (orders.length > 0 && tasks.length === 0) {
    diagnosis = '订单/CDK 已生成，但还没有激活任务，用户可能尚未在 /join 提交邮箱';
  }

  res.json({
    search,
    diagnosis,
    emails: emailList,
    orders,
    cards,
    tasks,
    invites,
    logs,
  });
});

module.exports = router;
