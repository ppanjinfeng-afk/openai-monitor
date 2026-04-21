const express = require('express');
const db = require('../db');
const autoCheckout = require('../services/auto-checkout');

const router = express.Router();

function normalizeValue(value) {
  return String(value || '').trim();
}

function extractSessionId(input) {
  const raw = normalizeValue(input);
  if (!raw) return '';
  const match = raw.match(/\b(cs_(?:live|test)_[A-Za-z0-9_-]+)\b/i);
  return match ? match[1] : '';
}

function normalizeCheckoutLink(input, sessionId) {
  const raw = normalizeValue(input);
  if (!raw || !sessionId) return '';
  
  if (/^https?:\/\//i.test(raw) && raw.includes(sessionId)) {
    return raw;
  }
  
  return `https://chatgpt.com/checkout/openai_llc/${sessionId}`;
}

function getSourceDomain(input) {
  const raw = normalizeValue(input);
  if (!raw || !/^https?:\/\//i.test(raw)) return '';
  try {
    const url = new URL(raw);
    return url.hostname || '';
  } catch (err) {
    return '';
  }
}

function normalizeRedeemCode(code) {
  const compact = normalizeValue(code)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (!compact) return '';
  return compact.match(/.{1,4}/g).join('-');
}

function maskRedeemCode(code) {
  const normalized = normalizeRedeemCode(code);
  if (!normalized) return '';

  const plain = normalized.replace(/-/g, '');
  if (plain.length <= 8) {
    return normalized;
  }

  return `${plain.slice(0, 4)}-${'*'.repeat(Math.max(4, plain.length - 8))}-${plain.slice(-4)}`;
}

function determineToolType({ sessionId, redeemCodeMasked }) {
  if (sessionId && redeemCodeMasked) return 'checkout_and_code';
  if (sessionId) return 'checkout';
  if (redeemCodeMasked) return 'redeem_code';
  return 'unknown';
}

function determineStatus({ rawInput, sessionId, redeemCodeMasked }) {
  if (sessionId) return 'parsed';
  if (redeemCodeMasked && !rawInput) return 'code_only';
  if (redeemCodeMasked) return 'partial';
  return 'invalid';
}

function buildSummary(search = '') {
  const whereSql = search
    ? `
      WHERE raw_input LIKE @search
         OR normalized_link LIKE @search
         OR session_id LIKE @search
         OR redeem_code_masked LIKE @search
         OR note LIKE @search
    `
    : '';

  const params = search ? { search: `%${search}%` } : {};

  return db.prepare(`
    SELECT
      COUNT(*) AS total_records,
      SUM(CASE WHEN status = 'parsed' THEN 1 ELSE 0 END) AS parsed_links,
      SUM(CASE WHEN tool_type IN ('redeem_code', 'checkout_and_code') THEN 1 ELSE 0 END) AS code_entries,
      SUM(CASE WHEN status IN ('invalid', 'partial') THEN 1 ELSE 0 END) AS risky_entries
    FROM checkout_tools_history
    ${whereSql}
  `).get(params);
}

router.get('/', (req, res) => {
  const search = normalizeValue(req.query.search);
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const params = {};
  let whereSql = '';

  if (search) {
    whereSql = `
      WHERE raw_input LIKE @search
         OR normalized_link LIKE @search
         OR session_id LIKE @search
         OR redeem_code_masked LIKE @search
         OR note LIKE @search
         OR source_domain LIKE @search
    `;
    params.search = `%${search}%`;
  }

  const items = db.prepare(`
    SELECT *
    FROM checkout_tools_history
    ${whereSql}
    ORDER BY COALESCE(last_used_at, updated_at, created_at) DESC, id DESC
    LIMIT @limit
  `).all({ ...params, limit });

  res.json({
    summary: buildSummary(search),
    items,
    filters: { search, limit },
  });
});

router.post('/parse', (req, res) => {
  const rawInput = normalizeValue(req.body.input);
  const note = normalizeValue(req.body.note);
  const rawRedeemCode = normalizeValue(req.body.redeem_code);
  const redeemCodeMasked = maskRedeemCode(rawRedeemCode);
  const mode = normalizeValue(req.body.mode) || 'api';
  const ccNumber = normalizeValue(req.body.cc_number);
  const ccExp = normalizeValue(req.body.cc_exp);
  const ccCvv = normalizeValue(req.body.cc_cvv);
  const ccNeeds3ds = req.body.cc_needs_3ds ? 1 : 0;

  if (!rawInput && !redeemCodeMasked && mode === 'api') {
    return res.status(400).json({ error: '请先输入结账链接、cs_id 或卡密' });
  }
  if (!rawInput && mode === 'card') {
    return res.status(400).json({ error: '信用卡模式下必须输入结账链接或 cs_id' });
  }

  const sessionId = extractSessionId(rawInput);
  const normalizedLink = normalizeCheckoutLink(rawInput, sessionId);
  const sourceDomain = getSourceDomain(rawInput);
  const toolType = determineToolType({ sessionId, redeemCodeMasked });
  const status = determineStatus({ rawInput, sessionId, redeemCodeMasked });

  const insert = db.prepare(`
    INSERT INTO checkout_tools_history (
      tool_type,
      raw_input,
      normalized_link,
      session_id,
      redeem_code_masked,
      redeem_code_raw,
      source_domain,
      status,
      note,
      checkout_mode,
      card_number_raw,
      card_exp_raw,
      card_cvv_raw,
      card_needs_3ds,
      last_action,
      last_used_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, datetime('now'))
  `);

  const result = insert.run(
    toolType,
    rawInput,
    normalizedLink,
    sessionId,
    redeemCodeMasked,
    rawRedeemCode,
    sourceDomain,
    status,
    note,
    mode,
    ccNumber,
    ccExp,
    ccCvv,
    ccNeeds3ds
  );

  const item = db.prepare('SELECT * FROM checkout_tools_history WHERE id = ?').get(result.lastInsertRowid);

  return res.json({
    message:
      status === 'parsed'
        ? '链接已解析并保存'
        : status === 'code_only'
          ? '卡密已保存'
          : '已保存，但链接未识别出有效的 cs_id',
    item,
  });
});

router.post('/:id(\\d+)/touch', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const action = normalizeValue(req.body.action) || 'view';
  const item = db.prepare('SELECT * FROM checkout_tools_history WHERE id = ?').get(id);

  if (!item) {
    return res.status(404).json({ error: '记录不存在' });
  }

  db.prepare(`
    UPDATE checkout_tools_history
    SET last_action = ?,
        last_used_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(action, id);

  return res.json({
    message: '记录已更新',
    item: db.prepare('SELECT * FROM checkout_tools_history WHERE id = ?').get(id),
  });
});

router.delete('/:id(\\d+)', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = db.prepare('DELETE FROM checkout_tools_history WHERE id = ?').run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: '记录不存在' });
  }

  return res.json({ message: '记录已删除' });
});

router.post('/:id(\\d+)/autosub', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  
  try {
    // Start the async process
    autoCheckout.runAutoSub(id).catch(err => {
      console.error(`[Route] Error in background autosub for ${id}:`, err);
    });
    
    return res.json({ message: '自动订阅流程已启动，请关注结果' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/:id(\\d+)/autosub_verify', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const verifyCode = normalizeValue(req.body.verify_code);
  
  if (!verifyCode) return res.status(400).json({ error: '请输入验证码' });

  try {
    autoCheckout.submitSms(id, verifyCode).catch(err => {
      console.error(`[Route] Error verifying sms for ${id}:`, err);
    });
    return res.json({ message: '验证码已提交，继续扣款流程...' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
