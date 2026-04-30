const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { createCdkCard } = require('../services/cdk-utils');
const alipayPagePay = require('../services/alipay-page-pay');
const {
  PRODUCT_TYPE,
  ORDER_HOLD_WINDOW_MINUTES,
  CDK_RESERVE_WINDOW_MINUTES,
  getTeamProductStats,
} = require('../services/team-stock');
const { ensureInventoryFreshness, refreshInventoryInBackground } = require('../services/inventory-sync');

const router = express.Router();

const FALLBACK_PRICE_CENTS = Number(process.env.CDK_TEAM_PRICE_CENTS || 200);
const DEFAULT_CURRENCY = process.env.CDK_TEAM_CURRENCY || 'CNY';
const SUPPORTED_METHODS = new Set(['alipay', 'mock']);
const MAX_BATCH_ORDER_ITEMS = 20;
const ORDER_TAIL_LENGTH = 4;
const ORDER_INVENTORY_REFRESH_WAIT_MS = Math.max(
  500,
  Number.parseInt(process.env.ORDER_INVENTORY_REFRESH_WAIT_MS || '1500', 10) || 1500
);

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u3000/g, ' ')
    .replace(/[＠﹫]/g, '@')
    .replace(/[。．｡﹒]/g, '.')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isValidEmail(email) {
  return Boolean(normalizeEmail(email));
}

function expandBatchEmailEntry(entries, rawValue, lineNumber, quantityInput = 1) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return;
  }

  const quantity = Math.min(
    MAX_BATCH_ORDER_ITEMS + 1,
    Math.max(1, Number.parseInt(quantityInput, 10) || 1)
  );
  const email = normalizeEmail(raw);
  for (let index = 0; index < quantity; index += 1) {
    entries.push({
      line: lineNumber,
      raw: quantity > 1 ? `${raw} * ${quantity}` : raw,
      email,
    });
  }
}

function parseBatchBuyerEmailEntries(input) {
  const sourceItems = Array.isArray(input) ? input : [input];
  const entries = [];

  sourceItems.forEach((item, index) => {
    if (typeof item === 'string') {
      item.split(/\r?\n/).forEach((lineValue, lineIndex) => {
        lineValue.split(/[,，;；]+/).forEach(value => {
          const raw = String(value || '').trim();
          if (!raw) {
            return;
          }

          const lineNumber = Array.isArray(input) ? index + 1 : lineIndex + 1;
          const quantityMatch = raw.match(/^(.+?)\s*(?:\*|x|×)\s*(\d+)$/i);
          if (quantityMatch) {
            expandBatchEmailEntry(entries, quantityMatch[1], lineNumber, quantityMatch[2]);
            return;
          }

          expandBatchEmailEntry(entries, raw, lineNumber);
        });
      });
    } else if (item && typeof item === 'object') {
      expandBatchEmailEntry(
        entries,
        item.buyer_email || item.buyerEmail || item.email || '',
        index + 1,
        item.quantity || item.qty || item.count || 1
      );
    }
  });

  return entries.filter(entry => entry.raw);
}

function makeOrderNo() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `CDK${stamp}${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
}

function makePublicToken() {
  return crypto.randomBytes(24).toString('hex');
}

function getMockPayEnabled() {
  return process.env.ENABLE_MOCK_PAY === 'true';
}

function getPublicBaseUrl() {
  const configured = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  return 'https://penqda.com';
}

function isOfficialAlipayPagePayEnabled() {
  return alipayPagePay.isAlipayPagePayReady();
}

function getTeamPriceCents() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('cdk_team_price_cents');
  const configured = Number.parseInt(row?.value, 10);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  return FALLBACK_PRICE_CENTS;
}

function getAlipayOrderAmountCents(itemCount = 1) {
  return getTeamPriceCents() * Math.max(1, Number(itemCount || 1));
}

function buildProviderPayUrl(method, order) {
  if (method === 'alipay' && isOfficialAlipayPagePayEnabled()) {
    const publicBaseUrl = getPublicBaseUrl();
    const itemCount = Math.max(1, Number(order.item_count || 1));
    return alipayPagePay.buildPagePayUrl({
      orderNo: order.order_no,
      amountText: (Number(order.amount_cents || 0) / 100).toFixed(2),
      subject: itemCount > 1 ? `ChatGPT Team CDK x${itemCount}` : 'ChatGPT Team CDK',
      notifyUrl: `${publicBaseUrl}/api/payments/alipay/notify`,
      returnUrl: `${publicBaseUrl}/buy?orderNo=${encodeURIComponent(order.order_no)}&token=${encodeURIComponent(order.public_token || '')}`,
      passbackParams: order.public_token || '',
    });
  }

  const template = method === 'alipay' ? (process.env.ALIPAY_PAY_URL_TEMPLATE || '') : '';
  if (!template) {
    return '';
  }

  return template
    .replaceAll('{order_no}', encodeURIComponent(order.order_no))
    .replaceAll('{amount}', encodeURIComponent((order.amount_cents / 100).toFixed(2)))
    .replaceAll('{amount_cents}', encodeURIComponent(String(order.amount_cents)))
    .replaceAll('{currency}', encodeURIComponent(order.currency))
    .replaceAll('{email}', encodeURIComponent(order.buyer_email));
}

function getPaymentQrUrl(method) {
  if (method === 'alipay') {
    if (isOfficialAlipayPagePayEnabled()) {
      return '';
    }
    return process.env.ALIPAY_QR_URL || '/assets/pay/alipay-business-qr.jpg';
  }

  return '';
}

function getPaymentInstructions(order) {
  if (order.payment_method === 'alipay' && isOfficialAlipayPagePayEnabled()) {
    return [];
  }

  if (order.payment_method === 'alipay' && getPaymentQrUrl('alipay')) {
    const tail = getOrderTail(order.order_no);
    const amount = (Number(order.amount_cents || 0) / 100).toFixed(2);
    return [
      `请使用支付宝扫码支付 ${amount} 元。`,
      `付款备注填写：${tail}。`,
      `付款金额一定要 ${amount} 元，必须和页面显示完全一致，少付或多付都不会自动发激活码。`,
      '请确认金额和备注正确，备注错误会延迟发码。',
      '付款确认后，页面会自动显示 CDK。',
    ];
  }

  return [];
}

function isProviderConfigured(paymentMethod, payUrl) {
  return paymentMethod === 'mock' || Boolean(payUrl) || Boolean(getPaymentQrUrl(paymentMethod));
}

function getOrderCreatedMessage(paymentMethod, payUrl, count = 1) {
  const createdText = count > 1 ? `总订单已创建，共 ${count} 个 CDK` : '订单已创建';
  if (isProviderConfigured(paymentMethod, payUrl)) {
    return createdText;
  }

  return count > 1
    ? `${createdText}，但支付链接模板未配置。可通过支付平台回调 /api/payments/webhook/generic 完成自动发码。`
    : '订单已创建，但支付链接模板未配置。可通过支付平台回调 /api/payments/webhook/generic 完成自动发码。';
}

async function ensureInventoryBeforeOrder(label = 'order') {
  let timeoutId = null;
  const timeoutPromise = new Promise(resolve => {
    timeoutId = setTimeout(() => resolve({ timedOut: true }), ORDER_INVENTORY_REFRESH_WAIT_MS);
  });

  try {
    const result = await Promise.race([ensureInventoryFreshness(), timeoutPromise]);
    if (result?.timedOut) {
      console.warn(
        `[Payments] Inventory refresh before ${label} timed out after ${ORDER_INVENTORY_REFRESH_WAIT_MS}ms; continuing with current snapshot`
      );
      refreshInventoryInBackground();
    }
  } catch (err) {
    console.error(`[Payments] Inventory refresh before ${label} failed:`, err.message);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function getSubmittedOrderToken(req) {
  return String(req.query.token || req.get('x-order-token') || '').trim();
}

function getOrderItems(orderNo) {
  return db.prepare(`
    SELECT *
    FROM cdk_order_items
    WHERE order_no = ?
    ORDER BY item_index ASC, id ASC
  `).all(orderNo);
}

function ensureOrderItems(order, targetEmails = []) {
  const normalizedTargetEmails = Array.isArray(targetEmails)
    ? targetEmails.map(email => normalizeEmail(email)).filter(Boolean)
    : [];
  const expectedCount = Math.max(1, normalizedTargetEmails.length || Number(order?.item_count || 1));
  let items = getOrderItems(order.order_no);

  if (items.length >= expectedCount) {
    return items;
  }

  const insertItems = db.transaction(() => {
    for (let index = items.length; index < expectedCount; index += 1) {
      const targetEmail = normalizedTargetEmails[index]
        || (expectedCount === 1 ? normalizeEmail(order.buyer_email) : '');
      db.prepare(`
        INSERT INTO cdk_order_items (
          order_no,
          item_index,
          target_email,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))
      `).run(order.order_no, index + 1, targetEmail);
    }
  });
  insertItems();

  db.prepare(`
    UPDATE cdk_orders
    SET item_count = CASE WHEN item_count < ? THEN ? ELSE item_count END,
        updated_at = datetime('now')
    WHERE order_no = ?
  `).run(expectedCount, expectedCount, order.order_no);

  return getOrderItems(order.order_no);
}

function hasValidOrderToken(req, order) {
  const token = getSubmittedOrderToken(req);
  return Boolean(order?.public_token && token && safeEqual(token, order.public_token));
}

function getOrderTail(orderNo) {
  return String(orderNo || '').trim().slice(-ORDER_TAIL_LENGTH).toUpperCase();
}

function toPublicOrder(order, options = {}) {
  if (!order) {
    return null;
  }

  const includeCdk = Boolean(options.includeCdk);
  const includeToken = Boolean(options.includeToken);
  const includeReceipt = Boolean(options.includeReceipt);
  const orderItems = getOrderItems(order.order_no);
  const itemCount = Math.max(1, Number(order.item_count || orderItems.length || 1));
  const itemEmails = orderItems
    .map(item => normalizeEmail(item.target_email))
    .filter(Boolean);
  const itemCodes = includeCdk && order.status === 'delivered'
    ? orderItems.map(item => String(item.cdk_code || '').trim()).filter(Boolean)
    : [];
  const cdkCodes = itemCodes.length
    ? itemCodes
    : (includeCdk && order.status === 'delivered' && order.cdk_code ? [order.cdk_code] : []);
  const currentPriceCents = getTeamPriceCents();

  return {
    orderNo: order.order_no,
    orderToken: includeToken ? order.public_token : undefined,
    buyerEmail: order.buyer_email,
    productType: order.product_type,
    paymentMethod: order.payment_method,
    amountCents: order.amount_cents,
    amountText: `${(Number(order.amount_cents || 0) / 100).toFixed(2)} ${order.currency || DEFAULT_CURRENCY}`,
    baseAmountCents: currentPriceCents,
    baseAmountText: `${(currentPriceCents / 100).toFixed(2)} ${order.currency || DEFAULT_CURRENCY}`,
    itemCount,
    deliveredCount: order.status === 'delivered'
      ? cdkCodes.length
      : Number(order.delivered_count || 0),
    itemEmails,
    orderTail: getOrderTail(order.order_no),
    currency: order.currency,
    status: order.status,
    payUrl: order.pay_url || '',
    payQrUrl: getPaymentQrUrl(order.payment_method),
    paymentInstructions: getPaymentInstructions(order),
    cdkCode: cdkCodes[0] || '',
    cdkCodes,
    paidAmountCents: includeReceipt ? Number(order.paid_amount_cents || 0) : undefined,
    paidAmountText: includeReceipt && Number(order.paid_amount_cents || 0) > 0
      ? `${(Number(order.paid_amount_cents || 0) / 100).toFixed(2)} ${order.currency || DEFAULT_CURRENCY}`
      : '',
    payerName: includeReceipt ? order.payer_name || '' : undefined,
    matchStatus: includeReceipt ? order.match_status || '' : undefined,
    receiptRaw: includeReceipt ? order.receipt_raw || '' : undefined,
    paidAt: order.paid_at,
    deliveredAt: order.delivered_at,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

function createPendingOrder({ buyerEmail, paymentMethod, itemEmails = [] }) {
  const normalizedBuyerEmail = normalizeEmail(buyerEmail);
  const normalizedItemEmails = Array.isArray(itemEmails) && itemEmails.length
    ? itemEmails.map(email => normalizeEmail(email)).filter(Boolean)
    : [normalizedBuyerEmail];
  const itemCount = Math.max(1, normalizedItemEmails.length);
  const orderNo = makeOrderNo();
  const pendingOrder = {
    order_no: orderNo,
    public_token: makePublicToken(),
    buyer_email: normalizedBuyerEmail,
    product_type: PRODUCT_TYPE,
    payment_method: paymentMethod,
    amount_cents: paymentMethod === 'alipay'
      ? getAlipayOrderAmountCents(itemCount)
      : getTeamPriceCents() * itemCount,
    currency: DEFAULT_CURRENCY,
    item_count: itemCount,
  };
  const payUrl = paymentMethod === 'mock' ? '' : buildProviderPayUrl(paymentMethod, pendingOrder);
  const insertOrder = db.transaction(() => {
    const stats = getTeamProductStats();
    if (itemCount > stats.stockCount) {
      const err = new Error(
        stats.stockCount > 0
          ? `库存不足，当前仅剩 ${stats.stockCount} 个可售名额`
          : '当前库存不足，请稍后重试'
      );
      err.statusCode = 409;
      throw err;
    }

    db.prepare(`
      INSERT INTO cdk_orders (
        order_no,
        buyer_email,
        product_type,
        payment_method,
        amount_cents,
        currency,
        public_token,
        pay_url,
        item_count,
        delivered_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      pendingOrder.order_no,
      pendingOrder.buyer_email,
      pendingOrder.product_type,
      pendingOrder.payment_method,
      pendingOrder.amount_cents,
      pendingOrder.currency,
      pendingOrder.public_token,
      payUrl,
      pendingOrder.item_count
    );

    normalizedItemEmails.forEach((targetEmail, index) => {
      db.prepare(`
        INSERT INTO cdk_order_items (
          order_no,
          item_index,
          target_email,
          status,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, 'pending', datetime('now'), datetime('now'))
      `).run(pendingOrder.order_no, index + 1, targetEmail);
    });
  });
  insertOrder();

  return db.prepare('SELECT * FROM cdk_orders WHERE order_no = ?').get(orderNo);
}

function signPaymentPayload(orderNo, amountCents, currency = DEFAULT_CURRENCY) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET || '';
  if (!secret) {
    return '';
  }

  return crypto
    .createHmac('sha256', secret)
    .update(`${orderNo}:${amountCents}:${currency}`)
    .digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function deliverPaidOrder(orderNo, paymentInfo = {}) {
  const deliver = db.transaction(() => {
    const order = db.prepare('SELECT * FROM cdk_orders WHERE order_no = ?').get(orderNo);
    if (!order) {
      const err = new Error('Order not found');
      err.statusCode = 404;
      throw err;
    }

    if (order.status === 'delivered') {
      return order;
    }

    if (order.status !== 'pending' && order.status !== 'paid') {
      const err = new Error(`Order cannot be delivered from status ${order.status}`);
      err.statusCode = 409;
      throw err;
    }

    const items = ensureOrderItems(order);
    const deliveredItems = items.map(item => {
      if (item.cdk_code) {
        return item;
      }

      const cdk = createCdkCard({
        planType: PRODUCT_TYPE,
        buyerEmail: order.buyer_email,
        assignedEmail: item.target_email || '',
        sourceOrderNo: order.order_no,
        prefix: 'TEAM',
      });

      db.prepare(`
        UPDATE cdk_order_items
        SET cdk_id = ?,
            cdk_code = ?,
            status = 'delivered',
            updated_at = datetime('now')
        WHERE id = ?
      `).run(cdk.id, cdk.code, item.id);

      return {
        ...item,
        cdk_id: cdk.id,
        cdk_code: cdk.code,
        status: 'delivered',
      };
    });
    const primaryItem = deliveredItems[0];

    db.prepare(`
      UPDATE cdk_orders
      SET status = 'delivered',
          provider_trade_no = COALESCE(NULLIF(?, ''), provider_trade_no),
          paid_amount_cents = CASE WHEN ? > 0 THEN ? ELSE paid_amount_cents END,
          payer_name = COALESCE(NULLIF(?, ''), payer_name),
          listener_event_id = COALESCE(?, listener_event_id),
          match_status = COALESCE(NULLIF(?, ''), match_status),
          receipt_raw = COALESCE(NULLIF(?, ''), receipt_raw),
          cdk_id = ?,
          cdk_code = ?,
          item_count = CASE WHEN item_count < ? THEN ? ELSE item_count END,
          delivered_count = ?,
          paid_at = COALESCE(paid_at, datetime('now')),
          delivered_at = COALESCE(delivered_at, datetime('now')),
          updated_at = datetime('now')
      WHERE order_no = ?
    `).run(
      paymentInfo.providerTradeNo || '',
      Number(paymentInfo.paidAmountCents || 0),
      Number(paymentInfo.paidAmountCents || 0),
      paymentInfo.payerName || '',
      paymentInfo.listenerEventId || null,
      paymentInfo.matchStatus || '',
      paymentInfo.receiptRaw || '',
      primaryItem?.cdk_id || order.cdk_id || null,
      primaryItem?.cdk_code || order.cdk_code || '',
      deliveredItems.length,
      deliveredItems.length,
      deliveredItems.length,
      order.order_no
    );

    return db.prepare('SELECT * FROM cdk_orders WHERE order_no = ?').get(order.order_no);
  });

  return deliver();
}

function normalizeAmountCents(value) {
  if (value == null || value === '') {
    return 0;
  }

  if (typeof value === 'number' && Number.isInteger(value) && value > 100) {
    return value;
  }

  const normalized = String(value)
    .replace(/[^\d.]/g, '')
    .trim();
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) {
    return 0;
  }

  return Math.round(amount * 100);
}

router.get('/product', (req, res) => {
  refreshInventoryInBackground();
  const pagePayEnabled = isOfficialAlipayPagePayEnabled();
  const stats = getTeamProductStats();
  const priceCents = getTeamPriceCents();
  res.json({
    productType: PRODUCT_TYPE,
    title: 'ChatGPT Team 邀请 CDK',
    amountCents: priceCents,
    amountText: `${(priceCents / 100).toFixed(2)} ${DEFAULT_CURRENCY}`,
    baseAmountText: `${(priceCents / 100).toFixed(2)} ${DEFAULT_CURRENCY}`,
    currency: DEFAULT_CURRENCY,
    mockPayEnabled: getMockPayEnabled(),
    officialPagePayEnabled: pagePayEnabled,
    soldCount: stats.soldCount,
    stockCount: stats.stockCount,
    reservedCount: stats.reservedCount,
    heldCount: stats.heldCount,
    orderHoldWindowMinutes: ORDER_HOLD_WINDOW_MINUTES,
    cdkReserveWindowMinutes: CDK_RESERVE_WINDOW_MINUTES,
  });
});

router.get('/orders', (req, res) => {
  const status = String(req.query.status || 'all').trim();
  const search = String(req.query.search || '').trim();
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const offset = (page - 1) * limit;
  const params = {};
  const where = [];

  if (status && status !== 'all') {
    where.push('status = @status');
    params.status = status;
  }

  if (search) {
    where.push(`(
      order_no LIKE @search
      OR buyer_email LIKE @search
      OR cdk_code LIKE @search
      OR provider_trade_no LIKE @search
    )`);
    params.search = `%${search}%`;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM cdk_orders
    ${whereSql}
  `).get(params);

  const orders = db.prepare(`
    SELECT *
    FROM cdk_orders
    ${whereSql}
    ORDER BY created_at DESC
    LIMIT @limit
    OFFSET @offset
  `).all({ ...params, limit, offset });

  const summary = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM cdk_orders
  `).get();

  res.json({
    orders: orders.map(order => toPublicOrder(order, { includeCdk: true, includeReceipt: true })),
    summary,
    total: Number(total?.count || 0),
    page,
    limit,
  });
});

router.post('/orders', async (req, res) => {
  const buyerEmail = normalizeEmail(req.body.buyer_email || req.body.email);
  const paymentMethod = String(req.body.payment_method || req.body.method || 'alipay').toLowerCase();
  const itemCountRaw = Number.parseInt(
    req.body.item_count
      ?? req.body.itemCount
      ?? req.body.quantity
      ?? req.body.count
      ?? 1,
    10
  );
  const itemCount = Number.isInteger(itemCountRaw) ? itemCountRaw : 1;

  if (!isValidEmail(buyerEmail)) {
    return res.status(400).json({ error: '请输入接收邮箱' });
  }

  if (itemCount < 1 || itemCount > MAX_BATCH_ORDER_ITEMS) {
    return res.status(400).json({ error: `单次最多购买 ${MAX_BATCH_ORDER_ITEMS} 个 CDK` });
  }

  if (!SUPPORTED_METHODS.has(paymentMethod)) {
    return res.status(400).json({ error: '不支持的支付方式' });
  }

  if (paymentMethod === 'mock' && !getMockPayEnabled()) {
    return res.status(403).json({ error: '本地模拟支付未启用，请设置 ENABLE_MOCK_PAY=true' });
  }

  try {
    await ensureInventoryBeforeOrder('single order');

    const order = createPendingOrder({
      buyerEmail,
      paymentMethod,
      itemEmails: Array.from({ length: itemCount }, () => buyerEmail),
    });
    res.status(201).json({
      order: toPublicOrder(order, { includeToken: true, includeCdk: true }),
      providerConfigured: isProviderConfigured(order.payment_method, order.pay_url),
      message: getOrderCreatedMessage(order.payment_method, order.pay_url, Number(order.item_count || itemCount)),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/orders/batch', async (req, res) => {
  const buyerEmail = normalizeEmail(req.body.buyer_email || req.body.buyerEmail || req.body.email);
  const paymentMethod = String(req.body.payment_method || req.body.method || 'alipay').toLowerCase();
  const entries = parseBatchBuyerEmailEntries(
    req.body.buyer_emails
      ?? req.body.buyerEmails
      ?? req.body.emails
      ?? req.body.items
      ?? ''
  );

  if (!isValidEmail(buyerEmail)) {
    return res.status(400).json({ error: '请输入下单邮箱' });
  }

  if (!SUPPORTED_METHODS.has(paymentMethod)) {
    return res.status(400).json({ error: '不支持的支付方式' });
  }

  if (paymentMethod === 'mock' && !getMockPayEnabled()) {
    return res.status(403).json({ error: '本地模拟支付未启用，请设置 ENABLE_MOCK_PAY=true' });
  }

  if (!entries.length) {
    return res.status(400).json({ error: '请至少输入一个接收邮箱' });
  }

  if (entries.length > MAX_BATCH_ORDER_ITEMS) {
    return res.status(400).json({ error: `单次最多只能批量购买 ${MAX_BATCH_ORDER_ITEMS} 个 CDK` });
  }

  const invalidEntries = entries.filter(entry => !isValidEmail(entry.email));
  if (invalidEntries.length) {
    const invalidDetails = Array.from(new Set(
      invalidEntries.map(entry => `第 ${entry.line} 行 (${entry.raw})`)
    ));
    return res.status(400).json({
      error: `以下行邮箱格式不正确：${invalidDetails.join('，')}`,
    });
  }

  try {
    await ensureInventoryBeforeOrder('batch order');

    const order = createPendingOrder({
      buyerEmail,
      paymentMethod,
      itemEmails: entries.map(entry => entry.email),
    });

    res.status(201).json({
      order: toPublicOrder(order, { includeToken: true, includeCdk: true }),
      providerConfigured: isProviderConfigured(order.payment_method, order.pay_url),
      message: getOrderCreatedMessage(order.payment_method, order.pay_url, Number(order.item_count || entries.length || 1)),
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/alipay/notify', express.urlencoded({ extended: false }), (req, res) => {
  const verifyResult = alipayPagePay.verifyNotifySignature(req.body || {});
  if (!verifyResult.valid) {
    return res.status(400).type('text/plain').send('failure');
  }

  const config = verifyResult.config || alipayPagePay.getAlipayConfig();
  const appId = String(req.body.app_id || '').trim();
  const orderNo = String(req.body.out_trade_no || '').trim();
  const providerTradeNo = String(req.body.trade_no || '').trim();
  const tradeStatus = String(req.body.trade_status || '').trim().toUpperCase();
  const totalAmountCents = normalizeAmountCents(req.body.total_amount);

  if (!appId || appId !== config.appId || !orderNo || !providerTradeNo) {
    return res.status(400).type('text/plain').send('failure');
  }

  if (tradeStatus !== 'TRADE_SUCCESS' && tradeStatus !== 'TRADE_FINISHED') {
    return res.type('text/plain').send('success');
  }

  const order = db.prepare('SELECT * FROM cdk_orders WHERE order_no = ?').get(orderNo);
  if (!order) {
    return res.status(404).type('text/plain').send('failure');
  }

  if (order.payment_method !== 'alipay') {
    return res.status(409).type('text/plain').send('failure');
  }

  if (totalAmountCents <= 0 || Number(order.amount_cents || 0) !== totalAmountCents) {
    return res.status(409).type('text/plain').send('failure');
  }

  const passbackParams = String(req.body.passback_params || '').trim();
  if (passbackParams && passbackParams !== String(order.public_token || '').trim()) {
    return res.status(409).type('text/plain').send('failure');
  }

  try {
    deliverPaidOrder(orderNo, {
      providerTradeNo,
      paidAmountCents: totalAmountCents,
      payerName: String(req.body.buyer_logon_id || req.body.payer_logon_id || req.body.buyer_user_id || '').trim(),
      matchStatus: 'alipay_api_notify',
      receiptRaw: JSON.stringify(req.body || {}),
    });
    return res.type('text/plain').send('success');
  } catch {
    return res.status(500).type('text/plain').send('failure');
  }
});

function getOrderForPublicStatus(req, res, orderNo) {
  const order = db.prepare('SELECT * FROM cdk_orders WHERE order_no = ?').get(orderNo);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (req.isPublicHost && !hasValidOrderToken(req, order)) {
    return res.status(404).json({ error: 'Order not found' });
  }

  res.json({ order: toPublicOrder(order, { includeCdk: true }) });
}

router.get('/orders/:orderNo', (req, res) => {
  getOrderForPublicStatus(req, res, req.params.orderNo);
});

router.get('/status/:orderNo', (req, res) => {
  getOrderForPublicStatus(req, res, req.params.orderNo);
});

router.post('/query-by-email', (req, res) => {
  const buyerEmail = normalizeEmail(req.body.buyer_email || req.body.email);
  if (!isValidEmail(buyerEmail)) {
    return res.status(400).json({ error: '请输入下单邮箱' });
  }

  const orders = db.prepare(`
    SELECT *
    FROM cdk_orders
    WHERE buyer_email = ?
    ORDER BY created_at DESC
    LIMIT 10
  `).all(buyerEmail);

  res.json({
    orders: orders.map(order => toPublicOrder(order, { includeCdk: true, includeToken: true })),
  });
});

router.post('/orders/:orderNo/mock-pay', (req, res) => {
  if (!getMockPayEnabled()) {
    return res.status(403).json({ error: '本地模拟支付未启用，请设置 ENABLE_MOCK_PAY=true' });
  }

  try {
    const order = db.prepare('SELECT * FROM cdk_orders WHERE order_no = ?').get(req.params.orderNo);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    if (order.payment_method !== 'mock') {
      return res.status(409).json({ error: '该订单不是本地模拟支付订单' });
    }

    const delivered = deliverPaidOrder(req.params.orderNo, {
      providerTradeNo: `MOCK-${Date.now()}`,
    });

    res.json({ order: toPublicOrder(delivered, { includeCdk: true }) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/orders/:orderNo/manual-deliver', (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM cdk_orders WHERE order_no = ?').get(req.params.orderNo);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.payment_method !== 'alipay') {
      return res.status(409).json({ error: '只有支付宝扫码订单需要人工确认收款' });
    }

    const delivered = deliverPaidOrder(req.params.orderNo, {
      providerTradeNo: req.body.provider_trade_no || `MANUAL-${Date.now()}`,
    });

    res.json({ order: toPublicOrder(delivered, { includeCdk: true }) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

router.post('/webhook/generic', (req, res) => {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET || '';
  if (!secret) {
    return res.status(503).json({ error: 'PAYMENT_WEBHOOK_SECRET is not configured' });
  }

  const orderNo = String(req.body.order_no || req.body.orderNo || '').trim();
  const amountCents = Number(req.body.amount_cents || req.body.amountCents || 0);
  const currency = String(req.body.currency || DEFAULT_CURRENCY).trim() || DEFAULT_CURRENCY;
  const providerTradeNo = String(req.body.provider_trade_no || req.body.trade_no || '').trim();
  const signature = req.get('x-cdk-signature') || req.body.signature || '';

  if (!orderNo || !amountCents) {
    return res.status(400).json({ error: 'order_no and amount_cents are required' });
  }

  const expected = signPaymentPayload(orderNo, amountCents, currency);
  if (!safeEqual(signature, expected)) {
    return res.status(401).json({ error: 'Invalid payment webhook signature' });
  }

  const order = db.prepare('SELECT * FROM cdk_orders WHERE order_no = ?').get(orderNo);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (Number(order.amount_cents) !== amountCents || String(order.currency) !== currency) {
    return res.status(409).json({ error: 'Payment amount does not match order' });
  }

  try {
    const delivered = deliverPaidOrder(orderNo, { providerTradeNo });
    res.json({ ok: true, order: toPublicOrder(delivered, { includeCdk: true }) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
