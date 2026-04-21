const crypto = require('crypto');
const db = require('../db');

const DEFAULT_GATEWAY_URL = 'https://openapi.alipay.com/gateway.do';
const DEFAULT_CHARSET = 'utf-8';
const DEFAULT_SIGN_TYPE = 'RSA2';
const DEFAULT_VERSION = '1.0';
const DEFAULT_METHOD = 'alipay.trade.page.pay';

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row?.value ?? fallback;
}

function getConfigValue(envKey, settingKey, fallback = '') {
  const envValue = process.env[envKey];
  if (envValue != null && String(envValue).trim()) {
    return String(envValue).trim();
  }

  return String(getSetting(settingKey, fallback) || fallback).trim();
}

function normalizeScalar(value) {
  if (Array.isArray(value)) {
    return normalizeScalar(value[0]);
  }

  return value == null ? '' : String(value);
}

function normalizeKeyBody(value) {
  return normalizeScalar(value)
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function wrapPem(value, label) {
  const normalized = normalizeScalar(value).trim();
  if (!normalized) {
    return '';
  }

  if (normalized.includes('BEGIN')) {
    return normalized;
  }

  const body = normalizeKeyBody(normalized);
  if (!body) {
    return '';
  }

  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

function getAlipayConfig() {
  const appId = getConfigValue('ALIPAY_APP_ID', 'alipay_app_id');
  const appPrivateKey = wrapPem(
    getConfigValue('ALIPAY_PRIVATE_KEY', 'alipay_private_key'),
    'PRIVATE KEY'
  );
  const alipayPublicKey = wrapPem(
    getConfigValue('ALIPAY_PUBLIC_KEY', 'alipay_public_key'),
    'PUBLIC KEY'
  );
  const appPublicKey = wrapPem(
    getConfigValue('ALIPAY_APP_PUBLIC_KEY', 'alipay_app_public_key'),
    'PUBLIC KEY'
  );
  const gatewayUrl = getConfigValue('ALIPAY_GATEWAY_URL', 'alipay_gateway_url', DEFAULT_GATEWAY_URL);

  return {
    appId,
    appPrivateKey,
    alipayPublicKey,
    appPublicKey,
    gatewayUrl: gatewayUrl || DEFAULT_GATEWAY_URL,
    charset: DEFAULT_CHARSET,
    signType: DEFAULT_SIGN_TYPE,
    version: DEFAULT_VERSION,
    ready: Boolean(appId && appPrivateKey && alipayPublicKey),
  };
}

function isAlipayPagePayReady() {
  return getAlipayConfig().ready;
}

function formatTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    '-',
    pad(date.getMonth() + 1),
    '-',
    pad(date.getDate()),
    ' ',
    pad(date.getHours()),
    ':',
    pad(date.getMinutes()),
    ':',
    pad(date.getSeconds()),
  ].join('');
}

function buildSignContent(params) {
  return Object.keys(params)
    .filter(key => key !== 'sign')
    .sort()
    .map(key => [key, normalizeScalar(params[key])])
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function buildQueryString(params) {
  return Object.keys(params)
    .sort()
    .map(key => [key, normalizeScalar(params[key])])
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function signParams(params, appPrivateKey) {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(buildSignContent(params), 'utf8');
  signer.end();
  return signer.sign(appPrivateKey, 'base64');
}

function buildPagePayUrl({
  orderNo,
  amountText,
  subject,
  notifyUrl,
  returnUrl,
  passbackParams = '',
  timeoutExpress = '30m',
}) {
  const config = getAlipayConfig();
  if (!config.ready) {
    return '';
  }

  const bizContent = {
    out_trade_no: normalizeScalar(orderNo),
    product_code: 'FAST_INSTANT_TRADE_PAY',
    total_amount: normalizeScalar(amountText),
    subject: normalizeScalar(subject || 'ChatGPT Team CDK'),
    timeout_express: normalizeScalar(timeoutExpress),
  };

  if (normalizeScalar(passbackParams)) {
    bizContent.passback_params = normalizeScalar(passbackParams);
  }

  const params = {
    app_id: config.appId,
    method: DEFAULT_METHOD,
    format: 'JSON',
    charset: config.charset,
    sign_type: config.signType,
    timestamp: formatTimestamp(),
    version: config.version,
    notify_url: normalizeScalar(notifyUrl),
    return_url: normalizeScalar(returnUrl),
    biz_content: JSON.stringify(bizContent),
  };

  const sign = signParams(params, config.appPrivateKey);
  return `${config.gatewayUrl}?${buildQueryString({ ...params, sign })}`;
}

function verifyNotifySignature(payload = {}) {
  const config = getAlipayConfig();
  if (!config.ready) {
    return { valid: false, reason: 'config_not_ready', config };
  }

  const sign = normalizeScalar(payload.sign).trim();
  const signType = normalizeScalar(payload.sign_type).trim().toUpperCase();
  if (!sign) {
    return { valid: false, reason: 'missing_sign', config };
  }

  if (signType && signType !== DEFAULT_SIGN_TYPE) {
    return { valid: false, reason: 'unsupported_sign_type', config };
  }

  const params = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'sign' || key === 'sign_type') {
      continue;
    }
    const normalized = normalizeScalar(value);
    if (normalized === '') {
      continue;
    }
    params[key] = normalized;
  }

  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(buildSignContent(params), 'utf8');
    verifier.end();
    const valid = verifier.verify(config.alipayPublicKey, sign, 'base64');
    return { valid, reason: valid ? '' : 'signature_mismatch', config, params };
  } catch (error) {
    return { valid: false, reason: error.message, config, params };
  }
}

module.exports = {
  getAlipayConfig,
  isAlipayPagePayReady,
  buildPagePayUrl,
  verifyNotifySignature,
};
