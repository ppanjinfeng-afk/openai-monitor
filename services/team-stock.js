const db = require('../db');

const PRODUCT_TYPE = 'team_invite';
const ORDER_HOLD_WINDOW_MINUTES = Number(process.env.CDK_ORDER_HOLD_MINUTES || 10);
const CDK_RESERVE_WINDOW_MINUTES = Number(process.env.CDK_RESERVED_CDK_HOLD_MINUTES || 30);
const INVITE_FAILURE_WINDOW_HOURS = Number(process.env.CDK_INVITE_FAILURE_WINDOW_HOURS || 24);

const WORKSPACE_RESERVED_SEATS_SQL = `
  COALESCE((
    SELECT MAX(COALESCE(workspaces.occupied_seats, 0) + COALESCE(workspaces.pending_invites, 0))
    FROM workspaces
    WHERE workspaces.account_id = accounts.id
      AND workspaces.sync_status = 'success'
  ), 0)
`;

const PROJECTED_SEATS_SQL = `
  CASE
    WHEN quota_sync_status = 'success' THEN MAX(
      COALESCE(quota_member_seats, 0) + COALESCE(quota_pending_invites, 0),
      ${WORKSPACE_RESERVED_SEATS_SQL}
    )
    ELSE MAX(COALESCE(invited_count, 0), ${WORKSPACE_RESERVED_SEATS_SQL})
  END
`;

function getTeamProductStats(options = {}) {
  const excludeCardId = Number(options.excludeCardId || 0);

  const sold = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(item_count, 1)), 0) AS count
    FROM cdk_orders
    WHERE product_type = ?
      AND status = 'delivered'
  `).get(PRODUCT_TYPE);

  const capacity = db.prepare(`
    SELECT COALESCE(SUM(
      CASE
        WHEN invite_total - (${PROJECTED_SEATS_SQL}) > 0
          THEN invite_total - (${PROJECTED_SEATS_SQL})
        ELSE 0
      END
    ), 0) AS count
    FROM accounts
    WHERE status = 'active'
      AND COALESCE(access_token, '') != ''
      AND COALESCE(invite_paused, 0) = 0
      AND COALESCE((
        SELECT COUNT(*)
        FROM invites
        WHERE invites.account_id = accounts.id
          AND invites.failure_category = 'invite_not_materialized'
          AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
      ), 0) = 0
      AND COALESCE((
        SELECT COUNT(*)
        FROM invites
        WHERE invites.account_id = accounts.id
          AND invites.failure_category IN ('revoke_failed', 'resend_failed')
          AND invites.updated_at >= datetime('now', '-${INVITE_FAILURE_WINDOW_HOURS} hours')
      ), 0) = 0
  `).get();

  const reservedArgs = [
    PRODUCT_TYPE,
    `-${CDK_RESERVE_WINDOW_MINUTES} minutes`,
  ];
  const reservedWhere = excludeCardId > 0 ? 'AND id != ?' : '';
  if (excludeCardId > 0) {
    reservedArgs.push(excludeCardId);
  }

  const reserved = db.prepare(`
    SELECT COUNT(*) AS count
    FROM cdk_cards
    WHERE plan_type = ?
      AND status IN ('unused', 'processing')
      AND COALESCE(source_order_no, '') != ''
      AND updated_at >= datetime('now', ?)
      ${reservedWhere}
  `).get(...reservedArgs);

  const held = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(item_count, 1)), 0) AS count
    FROM cdk_orders
    WHERE product_type = ?
      AND status IN ('pending', 'paid')
      AND created_at >= datetime('now', ?)
  `).get(PRODUCT_TYPE, `-${ORDER_HOLD_WINDOW_MINUTES} minutes`);

  const soldCount = Number(sold?.count || 0);
  const rawCapacity = Number(capacity?.count || 0);
  const reservedCount = Number(reserved?.count || 0);
  const heldCount = Number(held?.count || 0);
  const stockCount = Math.max(0, rawCapacity - reservedCount - heldCount);

  return {
    soldCount,
    rawCapacity,
    reservedCount,
    heldCount,
    stockCount,
    orderHoldWindowMinutes: ORDER_HOLD_WINDOW_MINUTES,
    cdkReserveWindowMinutes: CDK_RESERVE_WINDOW_MINUTES,
  };
}

function cardHasRecentReservation(card) {
  const cardId = Number(card?.id || 0);
  if (!cardId) {
    return false;
  }

  const planType = String(card?.plan_type || '').trim().toLowerCase();
  const status = String(card?.status || '').trim().toLowerCase();
  if (planType !== PRODUCT_TYPE) {
    return false;
  }
  if (status !== 'unused' && status !== 'processing') {
    return false;
  }
  if (!String(card?.source_order_no || '').trim()) {
    return false;
  }

  const recent = db.prepare(`
    SELECT 1
    FROM cdk_cards
    WHERE id = ?
      AND updated_at >= datetime('now', ?)
    LIMIT 1
  `).get(cardId, `-${CDK_RESERVE_WINDOW_MINUTES} minutes`);

  return Boolean(recent);
}

function getTeamActivationAvailability(card) {
  const baseStats = getTeamProductStats();
  const reservationActive = cardHasRecentReservation(card);
  const effectiveStats = reservationActive && Number(card?.id || 0) > 0
    ? getTeamProductStats({ excludeCardId: card.id })
    : baseStats;

  const activationAllowed = effectiveStats.stockCount > 0;
  let inventoryMessage = '';

  if (!activationAllowed) {
    inventoryMessage = '当前无库存，暂时无法激活此 CDK，请稍后再试';
  } else if (reservationActive && baseStats.stockCount <= 0) {
    inventoryMessage = '当前可售库存已用完，但这张 CDK 仍在保留期内，可以继续激活';
  }

  return {
    ...baseStats,
    activationAllowed,
    activationStockCount: effectiveStats.stockCount,
    reservationActive,
    inventoryMessage,
  };
}

module.exports = {
  PRODUCT_TYPE,
  ORDER_HOLD_WINDOW_MINUTES,
  CDK_RESERVE_WINDOW_MINUTES,
  getTeamProductStats,
  getTeamActivationAvailability,
  cardHasRecentReservation,
};
