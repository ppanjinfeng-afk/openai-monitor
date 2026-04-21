const db = require('../db');
const fetch = require('node-fetch');

function getConfig() {
  const token = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('telegram_bot_token');
  const chatId = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('telegram_chat_id');
  const enabled = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('alerts_enabled');
  return {
    token: token?.value || '',
    chatId: chatId?.value || '',
    enabled: enabled?.value === 'true',
  };
}

async function sendMessage(text, parseMode = 'HTML', options = {}) {
  const config = getConfig();
  const chatId = options.chatId || config.chatId;
  const force = Boolean(options.force);

  if ((!force && !config.enabled) || !config.token || !chatId) {
    console.log('[Telegram] Not configured or disabled, skipping:', text);
    return false;
  }

  try {
    const url = `https://api.telegram.org/bot${config.token}/sendMessage`;
    const payload = {
      chat_id: chatId,
      text,
    };

    if (parseMode) {
      payload.parse_mode = parseMode;
    }

    if (options.replyMarkup && typeof options.replyMarkup === 'object') {
      payload.reply_markup = options.replyMarkup;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('[Telegram] Send failed:', data.description);
      return false;
    }
    console.log('[Telegram] Message sent successfully');
    return true;
  } catch (err) {
    console.error('[Telegram] Error:', err.message);
    return false;
  }
}

async function alertBanned(account) {
  const text = `🚫 <b>账号封号告警</b>\n\n`
    + `📧 邮箱: <code>${account.email}</code>\n`
    + `🏷️ 标签: ${account.label || '无'}\n`
    + `⏰ 检测时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  return sendMessage(text);
}

async function alertRecovered(account) {
  const text = `✅ <b>账号恢复正常</b>\n\n`
    + `📧 邮箱: <code>${account.email}</code>\n`
    + `🏷️ 标签: ${account.label || '无'}\n`
    + `⏰ 恢复时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
  return sendMessage(text);
}

async function alertInviteFull(account) {
  const text = `📵 <b>邀请名额已满</b>\n\n`
    + `📧 邮箱: <code>${account.email}</code>\n`
    + `🏷️ 标签: ${account.label || '无'}\n`
    + `👥 已邀请: ${account.invited_count}/${account.invite_total}`;
  return sendMessage(text);
}

async function alertInvalidCredentials(account) {
  const text = `⚠️ <b>登录凭证无效</b>\n\n`
    + `📧 邮箱: <code>${account.email}</code>\n`
    + `🏷️ 标签: ${account.label || '无'}\n`
    + `🔐 邮箱或密码可能已经变更`;
  return sendMessage(text);
}

async function sendDailySummary(stats) {
  const text = `📊 <b>每日监控汇总</b>\n\n`
    + `📅 日期: ${new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`
    + `━━━━━━━━\n`
    + `📍 总账号: ${stats.total}\n`
    + `✅ 活跃: ${stats.active}\n`
    + `🚫 封号类: ${stats.banned}\n`
    + `⚠️ 令牌无效: ${stats.invalid}\n`
    + `🔐 无密码: ${stats.noPassword || 0}\n`
    + `❌ 未知: ${stats.unknown}\n`
    + `━━━━━━━━\n`
    + `👥 邀请名额使用: ${stats.invitesUsed}/${stats.invitesTotal}\n`
    + `📈 名额使用率: ${stats.invitesTotal > 0 ? Math.round(stats.invitesUsed / stats.invitesTotal * 100) : 0}%`;
  return sendMessage(text);
}

async function sendTestMessage() {
  const text = `🔂 <b>测试消息</b>\n\n这是来自 OpenAI 账号监控平台的测试消息。\n✅ Telegram 通知配置成功。`;
  return sendMessage(text, 'HTML', { force: true });
}

module.exports = {
  sendMessage,
  alertBanned,
  alertRecovered,
  alertInviteFull,
  alertInvalidCredentials,
  sendDailySummary,
  sendTestMessage,
  getConfig,
};
