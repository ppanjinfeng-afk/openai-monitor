const express = require('express');
const db = require('../db');
const workspaceSync = require('../services/workspace-sync');
const memberOverflowRebalance = require('../services/member-overflow-rebalance');
const { categoryLabel, classifyFailure } = require('../services/failure-utils');

const router = express.Router();

function getInviteCooldownMinutes() {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('invite_cooldown_minutes');
  return Math.max(0, parseInt(row?.value || '5', 10) || 0);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeEmailList(values = []) {
  const seen = new Set();
  const emails = [];
  for (const value of Array.isArray(values) ? values : []) {
    const email = normalizeEmail(value);
    if (!email || seen.has(email)) {
      continue;
    }
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

function normalizeInviteLocked(value) {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  const normalized = String(value ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'lock', 'locked'].includes(normalized) ? 1 : 0;
}

function parseDateValue(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-]\d\d:\d\d)$/i.test(normalized);
  const date = new Date(hasTimezone ? normalized : `${normalized}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toShanghaiDateKey(value) {
  const date = parseDateValue(value);
  if (!date) {
    return '';
  }

  return date.toLocaleDateString('sv-SE', {
    timeZone: 'Asia/Shanghai',
  });
}

function normalizeSortField(sort) {
  const value = String(sort || 'health').trim().toLowerCase();
  if (['health', 'remaining', 'members', 'updated', 'name'].includes(value)) {
    return value;
  }
  return 'health';
}

function buildWorkspaceWhereClause({ search, status, capacity }) {
  const conditions = [];
  const params = [];

  if (search) {
    conditions.push(`
      (
        w.workspace_name LIKE ?
        OR w.workspace_id LIKE ?
        OR a.email LIKE ?
        OR COALESCE(a.label, '') LIKE ?
      )
    `);
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (status !== 'all') {
    conditions.push('w.sync_status = ?');
    params.push(status);
  }

  if (capacity === 'available') {
    conditions.push('w.projected_remaining_seats > 1');
  } else if (capacity === 'warning') {
    conditions.push('w.projected_remaining_seats = 1');
  } else if (capacity === 'full') {
    conditions.push('w.projected_remaining_seats = 0');
  } else if (capacity === 'over') {
    conditions.push('w.projected_remaining_seats < 0');
  }

  return {
    whereSql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function buildWorkspaceOrderBy(sort, direction) {
  const normalizedSort = normalizeSortField(sort);
  const normalizedDirection = String(direction || 'desc').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const orderMap = {
    health: `w.health_score ${normalizedDirection}, w.updated_at DESC`,
    remaining: `w.projected_remaining_seats ${normalizedDirection}, w.health_score DESC`,
    members: `w.member_count ${normalizedDirection}, w.occupied_seats ${normalizedDirection}`,
    updated: `w.updated_at ${normalizedDirection}, w.health_score DESC`,
    name: `w.workspace_name ${normalizedDirection}, w.account_id ASC`,
  };

  return orderMap[normalizedSort] || orderMap.health;
}

function buildRecommendationRows(email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return [];
  }

  const cooldownMinutes = getInviteCooldownMinutes();
  return db.prepare(`
    SELECT
      w.*,
      a.email AS account_email,
      a.label AS account_label,
      CASE
        WHEN COALESCE(w.invite_locked, 0) = 1 OR COALESCE(w.auto_invite_locked, 0) = 1 THEN 'locked'
        WHEN EXISTS (
          SELECT 1
          FROM workspace_members wm
          WHERE wm.workspace_id = w.workspace_id
            AND LOWER(wm.email) = LOWER(?)
            AND COALESCE(wm.deactivated_time, '') = ''
        ) THEN 'member'
        WHEN EXISTS (
          SELECT 1
          FROM workspace_pending_invites wp
          WHERE wp.workspace_id = w.workspace_id
            AND LOWER(wp.email) = LOWER(?)
        ) THEN 'pending'
        WHEN EXISTS (
          SELECT 1
          FROM invites i
          WHERE i.account_id = w.account_id
            AND COALESCE(i.workspace_id, '') = COALESCE(w.workspace_id, '')
            AND LOWER(i.target_email) = LOWER(?)
            AND i.updated_at >= datetime('now', ?)
        ) THEN 'cooldown'
        WHEN w.projected_remaining_seats <= 0 THEN 'full'
        ELSE 'available'
      END AS recommendation_state
    FROM workspaces w
    JOIN accounts a ON w.account_id = a.id
    WHERE a.status = 'active'
      AND a.access_token IS NOT NULL
      AND a.access_token != ''
    ORDER BY
      CASE recommendation_state
        WHEN 'available' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'member' THEN 2
        WHEN 'cooldown' THEN 3
        WHEN 'locked' THEN 4
        ELSE 5
      END ASC,
      w.health_score DESC,
      w.projected_remaining_seats DESC,
      w.workspace_name ASC
  `).all(normalizedEmail, normalizedEmail, normalizedEmail, `-${cooldownMinutes} minutes`);
}

router.get('/', (req, res) => {
  const { search = '', page = 1, limit = 50, status = 'all', capacity = 'all', sort = 'health', direction = 'desc' } = req.query;
  const { whereSql, params } = buildWorkspaceWhereClause({ search, status, capacity });
  const orderBy = buildWorkspaceOrderBy(sort, direction);
  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM workspaces w
    JOIN accounts a ON w.account_id = a.id
    ${whereSql}
  `).get(...params);

  const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
  const rows = db.prepare(`
    SELECT
      w.*,
      a.email AS account_email,
      a.label AS account_label,
      a.status AS account_status
    FROM workspaces w
    JOIN accounts a ON w.account_id = a.id
    ${whereSql}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit, 10), offset);

  res.json({
    workspaces: rows,
    total: Number(countRow?.count || 0),
    page: parseInt(page, 10),
    limit: parseInt(limit, 10),
    filters: {
      search,
      status,
      capacity,
      sort: normalizeSortField(sort),
      direction: String(direction || 'desc').trim().toLowerCase() === 'asc' ? 'asc' : 'desc',
    },
  });
});

router.post('/sync', async (req, res) => {
  try {
    const results = await workspaceSync.syncAllWorkspaceSnapshots();
    const rebalance = await memberOverflowRebalance.rebalanceOverflowMembers();
    res.json({
      summary: workspaceSync.summarizeWorkspaceSync(results),
      rebalance,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rebalance-overflow', async (req, res) => {
  try {
    const result = await memberOverflowRebalance.rebalanceOverflowMembers({
      limitWorkspaces: req.body?.limit_workspaces || req.body?.limitWorkspaces || 20,
    });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:id(\\d+)/sync', async (req, res) => {
  try {
    const result = await workspaceSync.syncWorkspaceByRowId(parseInt(req.params.id, 10));
    if (!result.success) {
      return res.status(500).json({ error: result.message });
    }
    const rebalance = await memberOverflowRebalance.rebalanceOverflowMembers();
    return res.json({
      ...result,
      rebalance,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:id(\\d+)/lock', (req, res) => {
  const workspaceId = parseInt(req.params.id, 10);
  const existing = db.prepare(`
    SELECT w.*
    FROM workspaces w
    WHERE w.id = ?
    LIMIT 1
  `).get(workspaceId);

  if (!existing) {
    return res.status(404).json({ error: 'Workspace not found' });
  }

  const inviteLocked = normalizeInviteLocked(req.body?.invite_locked ?? req.body?.inviteLocked);
  db.prepare(`
    UPDATE workspaces
    SET invite_locked = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(inviteLocked, workspaceId);

  const workspace = db.prepare(`
    SELECT
      w.*,
      a.email AS account_email,
      a.label AS account_label,
      a.status AS account_status
    FROM workspaces w
    JOIN accounts a ON w.account_id = a.id
    WHERE w.id = ?
    LIMIT 1
  `).get(workspaceId);

  return res.json({
    message: inviteLocked
      ? '该空间已锁定，不再参与邀请分配'
      : (Number(workspace?.auto_invite_locked || 0) === 1
        ? '已取消手动锁定，但当前空间仍因满员保持自动锁定'
        : '该空间已解锁，可重新参与邀请分配'),
    workspace,
  });
});

router.get('/:id(\\d+)/export', (req, res) => {
  try {
    const result = workspaceSync.exportWorkspaceCsv(parseInt(req.params.id, 10));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.filename)}"`);
    res.send(`\ufeff${result.csv}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/member-search', (req, res) => {
  const query = String(req.query.query || '').trim();
  if (!query) {
    return res.json({ items: [] });
  }

  const items = db.prepare(`
    SELECT
      wm.*,
      w.id AS workspace_row_id,
      w.workspace_name,
      w.plan_type,
      a.email AS account_email
    FROM workspace_members wm
    JOIN workspaces w ON w.workspace_id = wm.workspace_id AND w.account_id = wm.account_id
    JOIN accounts a ON a.id = wm.account_id
    WHERE wm.email LIKE ?
       OR wm.name LIKE ?
    ORDER BY wm.email ASC, w.workspace_name ASC
    LIMIT 200
  `).all(`%${query}%`, `%${query}%`);

  res.json({ items });
});

router.get('/recommend', (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const rows = buildRecommendationRows(email).map(row => ({
    ...row,
    recommendation_label:
      row.recommendation_state === 'available' ? '可邀请' :
      row.recommendation_state === 'pending' ? '待接受' :
      row.recommendation_state === 'member' ? '已在团内' :
      row.recommendation_state === 'cooldown' ? '冷却中' :
      '已满',
  }));

  res.json({
    email,
    cooldown_minutes: getInviteCooldownMinutes(),
    items: rows,
  });
});

router.get('/audit', (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const memberships = db.prepare(`
    SELECT
      wm.*,
      w.id AS workspace_row_id,
      w.workspace_name,
      w.plan_type,
      a.email AS account_email
    FROM workspace_members wm
    JOIN workspaces w ON w.workspace_id = wm.workspace_id AND w.account_id = wm.account_id
    JOIN accounts a ON a.id = wm.account_id
    WHERE LOWER(wm.email) = LOWER(?)
    ORDER BY w.workspace_name ASC
  `).all(email);

  const pendingInvites = db.prepare(`
    SELECT
      wp.*,
      w.id AS workspace_row_id,
      w.workspace_name,
      w.plan_type,
      a.email AS account_email
    FROM workspace_pending_invites wp
    JOIN workspaces w ON w.workspace_id = wp.workspace_id AND w.account_id = wp.account_id
    JOIN accounts a ON a.id = wp.account_id
    WHERE LOWER(wp.email) = LOWER(?)
    ORDER BY w.workspace_name ASC
  `).all(email);

  const inviteHistory = db.prepare(`
    SELECT
      i.*,
      a.email AS account_email
    FROM invites i
    JOIN accounts a ON a.id = i.account_id
    WHERE LOWER(i.target_email) = LOWER(?)
    ORDER BY i.updated_at DESC
    LIMIT 200
  `).all(email);

  res.json({
    email,
    summary: {
      memberships: memberships.length,
      pending: pendingInvites.length,
      history: inviteHistory.length,
    },
    recommendations: buildRecommendationRows(email),
    memberships,
    pending_invites: pendingInvites,
    invite_history: inviteHistory,
  });
});

router.post('/batch-audit', (req, res) => {
  const emails = normalizeEmailList(req.body?.emails || []).slice(0, 200);
  if (emails.length === 0) {
    return res.status(400).json({ error: 'At least one email is required' });
  }

  const placeholders = emails.map(() => '?').join(', ');

  const memberships = db.prepare(`
    SELECT
      wm.*,
      w.id AS workspace_row_id,
      w.workspace_name,
      w.plan_type,
      a.email AS account_email
    FROM workspace_members wm
    JOIN workspaces w ON w.workspace_id = wm.workspace_id AND w.account_id = wm.account_id
    JOIN accounts a ON a.id = wm.account_id
    WHERE LOWER(wm.email) IN (${placeholders})
    ORDER BY wm.email ASC, w.workspace_name ASC
  `).all(...emails);

  const pendingInvites = db.prepare(`
    SELECT
      wp.*,
      w.id AS workspace_row_id,
      w.workspace_name,
      w.plan_type,
      a.email AS account_email
    FROM workspace_pending_invites wp
    JOIN workspaces w ON w.workspace_id = wp.workspace_id AND w.account_id = wp.account_id
    JOIN accounts a ON a.id = wp.account_id
    WHERE LOWER(wp.email) IN (${placeholders})
    ORDER BY wp.email ASC, w.workspace_name ASC
  `).all(...emails);

  const inviteHistory = db.prepare(`
    SELECT
      i.*,
      a.email AS account_email
    FROM invites i
    JOIN accounts a ON a.id = i.account_id
    WHERE LOWER(i.target_email) IN (${placeholders})
    ORDER BY i.updated_at DESC
    LIMIT 500
  `).all(...emails);

  const emailSummaries = emails.map(email => ({
    email,
    memberships: memberships.filter(item => normalizeEmail(item.email) === email).length,
    pending: pendingInvites.filter(item => normalizeEmail(item.email) === email).length,
    history: inviteHistory.filter(item => normalizeEmail(item.target_email) === email).length,
    removable_memberships: memberships.filter(item =>
      normalizeEmail(item.email) === email &&
      !item.is_owner &&
      item.account_id &&
      item.user_id
    ).length,
  }));

  return res.json({
    emails,
    summary: {
      emails: emails.length,
      memberships: memberships.length,
      pending: pendingInvites.length,
      history: inviteHistory.length,
      removable_memberships: memberships.filter(item => !item.is_owner && item.account_id && item.user_id).length,
    },
    email_summaries: emailSummaries,
    memberships,
    pending_invites: pendingInvites,
    invite_history: inviteHistory,
  });
});

router.get('/member-cleanup', (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const itemTypeRaw = String(req.query.item_type || 'all').trim().toLowerCase();
  const itemType = ['all', 'member', 'pending'].includes(itemTypeRaw) ? itemTypeRaw : 'all';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '').trim())
    ? String(req.query.date || '').trim()
    : '';

  const memberItems = db.prepare(`
    SELECT
      'member' AS item_type,
      wm.account_id,
      a.email AS account_email,
      w.id AS workspace_row_id,
      wm.workspace_id,
      w.workspace_name,
      w.plan_type,
      wm.user_id,
      wm.account_user_id,
      wm.email,
      wm.name,
      wm.role,
      wm.seat_type,
      wm.is_owner,
      wm.deactivated_time,
      wm.joined_at,
      '' AS invited_at,
      '' AS remote_invite_id
    FROM workspace_members wm
    JOIN workspaces w ON w.workspace_id = wm.workspace_id AND w.account_id = wm.account_id
    JOIN accounts a ON a.id = wm.account_id
    WHERE COALESCE(wm.deactivated_time, '') = ''
  `).all();

  const pendingItems = db.prepare(`
    SELECT
      'pending' AS item_type,
      wp.account_id,
      a.email AS account_email,
      w.id AS workspace_row_id,
      wp.workspace_id,
      w.workspace_name,
      w.plan_type,
      '' AS user_id,
      '' AS account_user_id,
      wp.email,
      '' AS name,
      '' AS role,
      '' AS seat_type,
      0 AS is_owner,
      '' AS deactivated_time,
      '' AS joined_at,
      wp.invited_at,
      wp.remote_invite_id
    FROM workspace_pending_invites wp
    JOIN workspaces w ON w.workspace_id = wp.workspace_id AND w.account_id = wp.account_id
    JOIN accounts a ON a.id = wp.account_id
  `).all();

  let items = [...memberItems, ...pendingItems];

  if (itemType !== 'all') {
    items = items.filter(item => item.item_type === itemType);
  }

  if (search) {
    items = items.filter(item => {
      const haystack = [
        item.email,
        item.name,
        item.account_email,
        item.workspace_name,
        item.workspace_id,
        item.role,
      ].map(value => String(value || '').toLowerCase());
      return haystack.some(value => value.includes(search));
    });
  }

  if (date) {
    items = items.filter(item => {
      const timeValue = item.item_type === 'member' ? item.joined_at : item.invited_at;
      return toShanghaiDateKey(timeValue) === date;
    });
  }

  items.sort((left, right) => {
    const leftTime = parseDateValue(left.item_type === 'member' ? left.joined_at : left.invited_at)?.getTime() || 0;
    const rightTime = parseDateValue(right.item_type === 'member' ? right.joined_at : right.invited_at)?.getTime() || 0;
    if (rightTime !== leftTime) {
      return rightTime - leftTime;
    }

    const emailCompare = String(left.email || '').localeCompare(String(right.email || ''));
    if (emailCompare !== 0) {
      return emailCompare;
    }

    return String(left.workspace_name || left.workspace_id || '').localeCompare(String(right.workspace_name || right.workspace_id || ''));
  });

  return res.json({
    filters: {
      search,
      item_type: itemType,
      date,
    },
    summary: {
      total: items.length,
      members: items.filter(item => item.item_type === 'member').length,
      pending: items.filter(item => item.item_type === 'pending').length,
      removable_members: items.filter(item => item.item_type === 'member' && !Number(item.is_owner || 0) && item.account_id && item.user_id).length,
      revocable_pending: items.filter(item => item.item_type === 'pending' && item.account_id && item.email).length,
    },
    items,
  });
});

router.get('/dashboard', (req, res) => {
  const alerts = [];

  const syncErrors = db.prepare(`
    SELECT w.*, a.email AS account_email
    FROM workspaces w
    JOIN accounts a ON a.id = w.account_id
    WHERE w.sync_status = 'error'
    ORDER BY w.updated_at DESC
    LIMIT 10
  `).all();
  for (const item of syncErrors) {
    alerts.push({
      type: 'sync_error',
      title: `${item.workspace_name || item.workspace_id} 同步失败`,
      detail: item.sync_message || '未知错误',
      workspace_id: item.workspace_id,
      workspace_name: item.workspace_name,
      account_email: item.account_email,
      severity: 'high',
    });
  }

  const quotaAlerts = db.prepare(`
    SELECT w.*, a.email AS account_email
    FROM workspaces w
    JOIN accounts a ON a.id = w.account_id
    WHERE w.projected_remaining_seats <= 0
    ORDER BY w.projected_remaining_seats ASC, w.health_score ASC
    LIMIT 10
  `).all();
  for (const item of quotaAlerts) {
    alerts.push({
      type: item.projected_remaining_seats < 0 ? 'over_quota' : 'full_quota',
      title: `${item.workspace_name || item.workspace_id} 名额预警`,
      detail: item.projected_remaining_seats < 0
        ? `已超额 ${Math.abs(item.projected_remaining_seats)}`
        : '已无剩余预占名额',
      workspace_id: item.workspace_id,
      workspace_name: item.workspace_name,
      account_email: item.account_email,
      severity: item.projected_remaining_seats < 0 ? 'high' : 'medium',
    });
  }

  const risky = db.prepare(`
    SELECT w.*, a.email AS account_email
    FROM workspaces w
    JOIN accounts a ON a.id = w.account_id
    WHERE w.health_score < 65
    ORDER BY w.health_score ASC
    LIMIT 10
  `).all();
  for (const item of risky) {
    alerts.push({
      type: 'health',
      title: `${item.workspace_name || item.workspace_id} 健康分较低`,
      detail: `健康分 ${item.health_score} / 100，最近错误 ${item.recent_error_count}`,
      workspace_id: item.workspace_id,
      workspace_name: item.workspace_name,
      account_email: item.account_email,
      severity: item.health_score < 40 ? 'high' : 'medium',
    });
  }

  const logRows = db.prepare(`
    SELECT status, message
    FROM check_logs
    WHERE checked_at >= datetime('now', '-7 days')
      AND status IN ('error', 'invalid_credentials', 'rate_limited', 'banned')
    ORDER BY checked_at DESC
    LIMIT 1000
  `).all();
  const inviteRows = db.prepare(`
    SELECT status, message, failure_category
    FROM invites
    WHERE updated_at >= datetime('now', '-7 days')
      AND (
        status = 'error'
        OR COALESCE(failure_category, '') != ''
      )
    ORDER BY updated_at DESC
    LIMIT 1000
  `).all();

  const counts = new Map();
  for (const row of logRows) {
    const category = classifyFailure(row.message, row.status);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  for (const row of inviteRows) {
    const category = row.failure_category || classifyFailure(row.message, row.status);
    counts.set(category, (counts.get(category) || 0) + 1);
  }

  const failure_categories = Array.from(counts.entries())
    .filter(([category, count]) => category && count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({
      category,
      label: categoryLabel(category),
      count,
    }));

  const summaryRow = db.prepare(`
    SELECT
      COUNT(*) AS total_workspaces,
      SUM(CASE WHEN sync_status = 'error' THEN 1 ELSE 0 END) AS sync_errors,
      SUM(CASE WHEN projected_remaining_seats < 0 THEN 1 ELSE 0 END) AS over_quota,
      SUM(CASE WHEN projected_remaining_seats = 0 THEN 1 ELSE 0 END) AS full_quota,
      SUM(CASE WHEN projected_remaining_seats = 1 THEN 1 ELSE 0 END) AS warning_quota,
      SUM(CASE WHEN projected_remaining_seats > 1 THEN 1 ELSE 0 END) AS healthy_quota,
      SUM(CASE WHEN health_score < 65 THEN 1 ELSE 0 END) AS risky_workspaces
    FROM workspaces
  `).get() || {};

  res.json({
    alerts: alerts.slice(0, 20),
    failure_categories,
    summary: {
      total_workspaces: Number(summaryRow.total_workspaces || 0),
      sync_errors: Number(summaryRow.sync_errors || 0),
      quota_alerts: quotaAlerts.length,
      risky_workspaces: Number(summaryRow.risky_workspaces || 0),
      over_quota: Number(summaryRow.over_quota || 0),
      full_quota: Number(summaryRow.full_quota || 0),
      warning_quota: Number(summaryRow.warning_quota || 0),
      healthy_quota: Number(summaryRow.healthy_quota || 0),
    },
  });
});

module.exports = router;
