const db = require('../db');
const fetch = require('node-fetch');
const autoCheckout = require('./auto-checkout');

/**
 * CDK Redemption Worker
 * Handles the async processing of CDK redemption tasks.
 * Flow: accessToken → create checkout session → auto-pay via Stripe
 */
class CdkWorker {
  constructor() {
    this.processing = new Set(); // Track in-flight task IDs
  }

  /**
   * Process a CDK redemption task
   */
  async processTask(taskId) {
    if (this.processing.has(taskId)) {
      console.log(`[CDK Worker] Task ${taskId} already processing, skipping`);
      return;
    }
    this.processing.add(taskId);

    try {
      const task = db.prepare('SELECT * FROM cdk_tasks WHERE id = ?').get(taskId);
      if (!task) throw new Error('Task not found');

      this.updateTask(taskId, 'PROCESSING', '任务正在执行中');
      console.log(`[CDK Worker] Processing task ${taskId} for ${task.account_email}`);

      // Step 1: Parse the session JSON and extract accessToken
      let sessionData;
      try {
        sessionData = JSON.parse(task.session_json);
      } catch (e) {
        throw new Error('Session JSON 解析失败，请确保粘贴了完整的 JSON 数据');
      }

      const accessToken = sessionData.accessToken || sessionData.access_token;
      if (!accessToken) {
        throw new Error('Session JSON 中未找到 accessToken');
      }

      console.log(`[CDK Worker] AccessToken extracted (${accessToken.substring(0, 20)}...)`);

      // Step 2: Use accessToken to initiate a ChatGPT Plus subscription
      // We need to create a checkout session via OpenAI's API
      this.updateTask(taskId, 'PROCESSING', '正在创建结账会话...');

      const checkoutSession = await this.createCheckoutSession(accessToken);
      
      if (!checkoutSession || !checkoutSession.sessionId) {
        throw new Error('无法创建结账会话，请检查账号状态');
      }

      console.log(`[CDK Worker] Checkout session created: ${checkoutSession.sessionId}`);
      
      // Store checkout session ID
      db.prepare('UPDATE cdk_tasks SET checkout_session_id = ? WHERE id = ?')
        .run(checkoutSession.sessionId, taskId);

      // Step 3: Find an available card and execute payment via auto-checkout
      this.updateTask(taskId, 'PROCESSING', '正在执行自动付款...');

      // Create a temporary checkout_tools_history entry for auto-checkout
      const historyResult = db.prepare(`
        INSERT INTO checkout_tools_history (
          tool_type, raw_input, normalized_link, session_id,
          status, note, checkout_mode, autosub_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        'cdk_checkout',
        checkoutSession.checkoutUrl || '',
        checkoutSession.checkoutUrl || '',
        checkoutSession.sessionId,
        'parsed',
        `CDK兑换: ${task.cdk_code} → ${task.account_email}`,
        'card',
        'pending'
      );

      const historyId = historyResult.lastInsertRowid;

      // Use the first available card from settings, or try to get from the system
      const cardInfo = await this.getAvailableCard();
      
      if (cardInfo) {
        // Update the history entry with card info
        db.prepare(`
          UPDATE checkout_tools_history 
          SET card_number_raw = ?, card_exp_raw = ?, card_cvv_raw = ?
          WHERE id = ?
        `).run(cardInfo.number, cardInfo.expiry, cardInfo.cvv, historyId);

        // Execute the payment
        try {
          await autoCheckout.runAutoSub(historyId);
          
          // Check result
          const result = db.prepare('SELECT * FROM checkout_tools_history WHERE id = ?').get(historyId);
          
          if (result.autosub_status === 'success') {
            this.completeTask(taskId, 'SUCCESS', '兑换成功', result.card_last4);
          } else {
            throw new Error(result.autosub_error || '付款处理失败');
          }
        } catch (payErr) {
          throw new Error(`付款失败: ${payErr.message}`);
        }
      } else {
        throw new Error('没有可用的信用卡，请先在结账工具中配置信用卡');
      }

    } catch (err) {
      console.error(`[CDK Worker] Task ${taskId} failed:`, err.message);
      this.failTask(taskId, err.message);
    } finally {
      this.processing.delete(taskId);
    }
  }

  /**
   * Create an OpenAI checkout session using the user's accessToken
   */
  async createCheckoutSession(accessToken) {
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

    try {
      // Try to initiate a Plus subscription via OpenAI's internal API  
      const res = await fetch('https://api.openai.com/dashboard/billing/subscribe', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': UA,
        },
        body: JSON.stringify({
          plan_id: 'chatgpt-plus',
          billing_cycle: 'monthly',
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.checkout_url || data.session_id) {
          const sessionId = data.session_id || this.extractSessionId(data.checkout_url);
          return {
            sessionId,
            checkoutUrl: data.checkout_url || `https://chatgpt.com/checkout/openai_llc/${sessionId}`,
          };
        }
      }

      // Fallback: Try the ChatGPT payment endpoint
      console.log('[CDK Worker] Primary endpoint failed, trying fallback...');
      
      const res2 = await fetch('https://chatgpt.com/backend-api/payments/checkout', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': UA,
          'Origin': 'https://chatgpt.com',
          'Referer': 'https://chatgpt.com/',
        },
        body: JSON.stringify({
          plan_id: 'chatgpt-plus-plan',
        })
      });

      if (res2.ok) {
        const data2 = await res2.json();
        const url = data2.url || data2.checkout_url || '';
        const sid = data2.session_id || this.extractSessionId(url);
        if (sid) {
          return { sessionId: sid, checkoutUrl: url };
        }
      }

      // Fallback 2: Try subscription upgrade
      const res3 = await fetch('https://chatgpt.com/backend-api/payments/subscription', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': UA,
          'Origin': 'https://chatgpt.com',
          'Referer': 'https://chatgpt.com/',
        },
        body: JSON.stringify({
          plan: 'plus',
          is_monthly: true,
        })
      });

      if (res3.ok) {
        const data3 = await res3.json();
        const url = data3.url || data3.checkout_url || data3.redirect_url || '';
        const sid = data3.session_id || this.extractSessionId(url);
        if (sid) {
          return { sessionId: sid, checkoutUrl: url };
        }
      }

      throw new Error('所有结账端点均失败，请手动获取 checkout session');
    } catch (err) {
      if (err.message.includes('所有结账端点')) throw err;
      throw new Error(`创建结账会话失败: ${err.message}`);
    }
  }

  /**
   * Extract cs_ session ID from a URL
   */
  extractSessionId(url) {
    if (!url) return '';
    const match = url.match(/\b(cs_(?:live|test)_[A-Za-z0-9_-]+)\b/i);
    return match ? match[1] : '';
  }

  /**
   * Get the default card configured in the system
   */
  async getAvailableCard() {
    // Look for the most recent successful card used in checkout_tools_history
    const lastCard = db.prepare(`
      SELECT card_number_raw, card_exp_raw, card_cvv_raw 
      FROM checkout_tools_history 
      WHERE checkout_mode = 'card' 
        AND card_number_raw != '' 
        AND autosub_status = 'success'
      ORDER BY updated_at DESC 
      LIMIT 1
    `).get();

    if (lastCard && lastCard.card_number_raw) {
      return {
        number: lastCard.card_number_raw,
        expiry: lastCard.card_exp_raw,
        cvv: lastCard.card_cvv_raw,
      };
    }

    // Also check for any card with pending status
    const anyCard = db.prepare(`
      SELECT card_number_raw, card_exp_raw, card_cvv_raw 
      FROM checkout_tools_history 
      WHERE checkout_mode = 'card' 
        AND card_number_raw != ''
      ORDER BY updated_at DESC 
      LIMIT 1
    `).get();

    if (anyCard && anyCard.card_number_raw) {
      return {
        number: anyCard.card_number_raw,
        expiry: anyCard.card_exp_raw,
        cvv: anyCard.card_cvv_raw,
      };
    }

    // Check settings for default card
    const defaultCard = db.prepare("SELECT value FROM settings WHERE key = 'default_card_info'").get();
    if (defaultCard && defaultCard.value) {
      try {
        return JSON.parse(defaultCard.value);
      } catch (e) {}
    }

    return null;
  }

  updateTask(taskId, status, message) {
    db.prepare(`
      UPDATE cdk_tasks 
      SET status = ?, status_message = ?, updated_at = datetime('now') 
      WHERE id = ?
    `).run(status, message, taskId);
  }

  completeTask(taskId, status, message, cardLast4) {
    db.prepare(`
      UPDATE cdk_tasks 
      SET status = ?, status_message = ?, card_last4 = ?,
          completed_at = datetime('now'), updated_at = datetime('now') 
      WHERE id = ?
    `).run(status, message, cardLast4 || '', taskId);

    // Mark the CDK as used
    const task = db.prepare('SELECT cdk_id FROM cdk_tasks WHERE id = ?').get(taskId);
    if (task && task.cdk_id) {
      db.prepare(`
        UPDATE cdk_cards 
        SET status = 'used', used_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `).run(task.cdk_id);
    }
  }

  failTask(taskId, errorMessage) {
    db.prepare(`
      UPDATE cdk_tasks 
      SET status = 'FAILED', status_message = '兑换失败', 
          error_message = ?, updated_at = datetime('now') 
      WHERE id = ?
    `).run(errorMessage, taskId);
  }
}

module.exports = new CdkWorker();
