const fetch = require('node-fetch');
const db = require('../db');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { SocksProxyAgent } = require('socks-proxy-agent');
puppeteer.use(StealthPlugin());

/**
 * Service to handle card redemption and protocol-based headless API checkout.
 */
class AutoCheckoutService {
  getProxyDetails() {
    // Generate an 8 character random string for the session id to ensure rotating IP
    const rs = Math.random().toString(36).substring(2, 10);
    // Replace sid-(random) - using the nationwide US proxy per user configuration
    const baseProxy = 'socks5://t74p1119186-region-US-sid-7XQNpXFS-t-1:ismd2kxe@us2.cliproxy.io:3010';
    const proxyUrl = baseProxy.replace(/sid-[a-zA-Z0-9]+/, `sid-${rs}`);
    return {
       agent: new SocksProxyAgent(proxyUrl),
       url: proxyUrl
    };
  }

  /**
   * Redeems a virtual card from the provided API.
   */
  async redeemCard(code) {
    console.log(`[AutoCheckout] Redeeming node-card for key: ${code}`);

    const baseUrl = 'https://yyl.ncet.top/shop/shop'; // 根据文档，也可以是 sd.ncet.top/shop/shop
    
    // Step 1: Submit code for redemption
    const redeemRes = await fetch(`${baseUrl}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, quantity: 1 })
    });

    const redeemData = await redeemRes.json();
    
    // Check if initialization was successful
    if (!redeemRes.ok || (redeemData.code !== 1 && redeemData.code !== 200 && !redeemData.orderNo)) {
      throw new Error(`Redemption failed: ${redeemData.msg || JSON.stringify(redeemData)}`);
    }

    const orderNo = redeemData.data?.orderNo || redeemData.orderNo;
    if (!orderNo) {
      throw new Error(`Redemption failed: missing orderNo in response.`);
    }

    console.log(`[AutoCheckout] Redemption order created. OrderNo: ${orderNo}, waiting for card provision...`);

    // Step 2: Poll for order status until cards are provisioned
    let maxPolls = 15; // 30 seconds max 
    let finalOrderData = null;

    for (let i = 0; i < maxPolls; i++) {
      await new Promise(r => setTimeout(r, 2000)); // sleep 2 seconds

      const statusRes = await fetch(`${baseUrl}/redeem/order-status/${orderNo}`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }
      });

      const text = await statusRes.text();
      let statusData;
      try {
        statusData = JSON.parse(text);
      } catch (e) {
        throw new Error(`Failed to parse order status response HTTP ${statusRes.status}. Body: ${text.slice(0,200)}`);
      }

      console.log(`[AutoCheckout] Polled status: HTTP ${statusRes.status}, statusValue: ${statusData.data?.status ?? statusData.status}`);

      const statusValue = statusData.data?.status ?? statusData.status;

      if (statusValue === 2 || (statusData.data?.cards && statusData.data?.cards.length > 0)) {
        finalOrderData = statusData;
        break;
      }
      
      if (statusValue === -1 || statusValue === 3) {
         throw new Error(`Redemption failed with final status: ${statusValue} - ${JSON.stringify(statusData)}`);
      }
    }

    if (!finalOrderData) {
      throw new Error(`Timeout waiting for card provision. Order status polling expired.`);
    }

    const cards = finalOrderData.data?.cards || finalOrderData.cards || [];
    if (cards.length === 0) {
      throw new Error(`Redemption successful but no cards returned in order: ${JSON.stringify(finalOrderData)}`);
    }

    const card = cards[0];
    
    console.log(`[AutoCheckout] Raw card keys:`, Object.keys(card).join(', '));
    console.log(`[AutoCheckout] Full raw card:`, JSON.stringify(card));
    
    // Parse cardData which might contain the CVV and full formatting
    if (card.cardData && typeof card.cardData === 'string') {
       try {
          const cData = JSON.parse(card.cardData);
          if (cData.cvv) card.cardPassword = cData.cvv;
          if (cData.expiry) card.expiry = cData.expiry;
       } catch (e) {
          // If not proper JSON, try splitting
          if (card.cardData.includes('|')) {
             const parts = card.cardData.split('|');
             if (parts.length >= 4) {
                card.cardNumber = parts[0];
                card.expiry = parts[1] + parts[2];
                card.cardPassword = parts[3];
             }
          }
       }
    }

    const ccNum = String(card.cardNumber || card.card_no || card.card_number || '').replace(/\s/g, '');
    const cvvNum = String(card.cardPassword || card.cvv || card.cvc || '').trim();
    
    // Extract expiry month and year (Format could be MMYY, MM/YY, MM/YYYY, etc)
    const expiryStr = String(card.expiry || card.expire || '');
    let month = '';
    let year = '';

    // Remove any slashes or spaces
    const cleanExpiry = expiryStr.replace(/[^\d]/g, '');

    if (cleanExpiry.length >= 4) {
      month = cleanExpiry.substring(0, 2);
      year = cleanExpiry.substring(2);
      if (year.length === 2) {
         year = `20${year}`;
      }
    }

    console.log(`[AutoCheckout] Card retrieved successfully: ****${ccNum.slice(-4)}`);

    if (!ccNum || !cvvNum || !month || !year) {
      console.error(`[AutoCheckout] Invalid card info extracted. Details: length=${ccNum.length}, M/Y=${month}/${year}, CVV=${cvvNum.length ? 'yes' : 'no'}`);
    }
    
    return {
      number: ccNum,
      cvv: cvvNum,
      expiryMonth: month,
      expiryYear: year
    };
  }

  /**
   * 自动抓取 3DS 验证码
   */
  async pollForOTP(cardLast4, maxAttempts = 60) { // 增加到 5 分钟 (60 * 5s)
    console.log(`[AutoCheckout] Polling for OTP for card ending in ${cardLast4} (Max ${maxAttempts} attempts)...`);
    
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        const res = await fetch('https://clist.node-card.com/?raw=1');
        const list = await res.json();
        
        console.log(`[AutoCheckout] OTP Poll attempt ${i}/${maxAttempts}...`);

        if (Array.isArray(list)) {
          // 找 5 分钟内最新的该卡验证码 (增加时间窗口到 5 分钟)
          const match = list.find(item => {
            const itemTime = new Date(`${item.date} ${item.time}`).getTime();
            const now = Date.now();
            // 允许时间偏差，只要是 5 分钟内的码都算
            return item.card_tail === cardLast4 && (Math.abs(now - itemTime) < 300000); 
          });
          
          if (match) {
            console.log(`[AutoCheckout] ✅ Match found! OTP: ${match.otp} (Received at: ${match.time})`);
            return match.otp;
          }
        }
      } catch (err) {
        console.warn(`[AutoCheckout] OTP Poll Warning (Attempt ${i}):`, err.message);
      }
      
      await new Promise(r => setTimeout(r, 5000));
    }
    
    throw new Error(`Timeout waiting for 3DS OTP code. 5分钟内未在 clist.node-card.com 收到卡号 ${cardLast4} 的验证码。请确认卡片状态或稍后再试。`);
  }

  /**
   * 使用 Puppeteer 处理 3DS 挑战页面
   */
  async handle3DSChallenge(challengeUrl, cardLast4) {
    console.log(`[AutoCheckout] [3DS] 准备处理验证页面: ${challengeUrl}`);
    const browser = await puppeteer.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    try {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // 导航到 3DS 页面
      console.log(`[AutoCheckout] [3DS] 正在加载页面...`);
      await page.goto(challengeUrl, { waitUntil: 'networkidle2', timeout: 90000 });
      
      // 等待 20 秒，看看是否是免验证码流程 (3DS2 Frictionless/Fingerprinting)
      console.log(`[AutoCheckout] [3DS] 验证页面已加载，检测是否需要验证码...`);
      await new Promise(r => setTimeout(r, 20000)); 

      // 检查是否出现了验证码输入框
      const needsOTP = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
        return inputs.some(i => 
          i.placeholder?.toLowerCase().includes('otp') || 
          i.id?.toLowerCase().includes('otp') || 
          i.id?.toLowerCase().includes('code') || 
          i.name?.toLowerCase().includes('password') ||
          i.name?.toLowerCase().includes('code') ||
          i.type === 'text' || i.type === 'tel'
        );
      });

      if (!needsOTP) {
        console.log(`[AutoCheckout] [3DS] 未检测到输入框，判定为免密验证 (Frictionless Flow) 或者是背景指纹识别。`);
        // 等待一下让它的指纹识别逻辑跑完
        await new Promise(r => setTimeout(r, 10000));
        return true; 
      }

      console.log(`[AutoCheckout] [3DS] 检测到验证码输入框，开始从平台拉取验证码...`);
      
      // 等待 3DS 码
      const otp = await this.pollForOTP(cardLast4);
      
      console.log(`[AutoCheckout] [3DS] 获得验证码 ${otp}，准备填入...`);
      
      // 在页面中寻找输入框并输入
      const inputResult = await page.evaluate((code) => {
        const inputs = Array.from(document.querySelectorAll('input, select, textarea'));
        const otpInput = inputs.find(i => 
          i.placeholder?.toLowerCase().includes('otp') || 
          i.id?.toLowerCase().includes('otp') || 
          i.id?.toLowerCase().includes('code') || 
          i.name?.toLowerCase().includes('password') ||
          i.name?.toLowerCase().includes('code') ||
          i.type === 'text' || i.type === 'tel'
        );
        
        if (otpInput) {
          otpInput.focus();
          otpInput.value = code;
          otpInput.dispatchEvent(new Event('input', { bubbles: true }));
          otpInput.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true, id: otpInput.id || otpInput.name };
        }
        return { success: false, totalInputs: inputs.length };
      }, otp);
      
      if (!inputResult.success) {
        console.warn(`[AutoCheckout] [3DS] ❌ 无法找到验证码输入框 (页面总输入项: ${inputResult.totalInputs})`);
        return false;
      }
      
      console.log(`[AutoCheckout] [3DS] 已填入输入框 (${inputResult.id})，正在点击提交...`);
      
      // 寻找提交按钮
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], a.button'));
        const subBtn = buttons.find(b => 
          b.innerText?.toLowerCase().includes('verify') || 
          b.innerText?.toLowerCase().includes('submit') || 
          b.innerText?.toLowerCase().includes('confirm') ||
          b.innerText?.toLowerCase().includes('ok') ||
          b.value?.toLowerCase().includes('submit')
        );
        if (subBtn) {
           subBtn.click();
           return true;
        }
        return false;
      });
      
      console.log(`[AutoCheckout] [3DS] 验证码已提交。等待 10 秒确认跳转...`);
      await new Promise(r => setTimeout(r, 10000)); 
      
      return true;
    } catch (err) {
      console.error(`[AutoCheckout] [3DS] 挑战处理异常:`, err.message);
      return false;
    } finally {
      await browser.close();
      console.log(`[AutoCheckout] [3DS] 浏览器已关闭。`);
    }
  }

  /**
   * Generates a random US address locally instead of browser automation.
   */
  async generateAddress() {
    console.log(`[AutoCheckout] Generating local US address...`);
    const states = [{s:'CA', z:'90001'}, {s:'OR', z:'97001'}, {s:'DE', z:'19701'}]; // Tax free usually DE or OR
    const stateObj = states[Math.floor(Math.random() * states.length)];
    const streetNum = Math.floor(1000 + Math.random() * 9000);
    return {
      name: 'OpenAI User',
      phone: `555${Math.floor(1000000 + Math.random() * 8999999)}`,
      street: `${streetNum} Main St`,
      city: 'Portland',
      state: stateObj.s,
      zip: stateObj.z
    };
  }

  /**
   * 纯协议代付：直接调 Stripe API 完成 OpenAI Custom Checkout Session。
   * 使用 OpenAI 的 pk_live key + Stripe Custom Checkout confirm 端点。
   */
  async executeBinding(historyId, checkoutUrl, cardInfo, addressInfo, sessionId) {
    console.log(`[Protocol] 开始协议代付: session=${sessionId}`);
    this.updateStatus(historyId, 'binding');

    // OpenAI 的 Stripe publishable key (从 chatgpt.com checkout 页面抓取)
    const OPENAI_STRIPE_PK = 'pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n';
    const STRIPE_VERSION = '2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1';
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36';

    try {
      const { agent, url: proxyUrl } = this.getProxyDetails();
      console.log(`[Protocol] 使用住宅动态代理拉取: ${proxyUrl.replace(/:[^:@]+@/, ':***@')}`);

      // 先快速查一下当前拉到的真实出口IP，给用户展示
      try {
        const ipRes = await fetch('https://api.ipify.org?format=json', { agent, timeout: 5000 });
        const ipData = await ipRes.json();
        console.log(`[Protocol] 🌍 成功拉取节点，当前动态住宅出口真实 IP 为: ${ipData.ip}`);
      } catch (ipErr) {
        console.warn(`[Protocol] ⚠️ 节点 IP 验证响应超时，跳过显示继续走主流程... (${ipErr.message})`);
      }

      // ========== Step 1: 初始化 Elements Session (获取 session 配置) ==========
      console.log(`[Protocol] Step 1/3: 初始化 Stripe Elements Session...`);
      
      const elementsParams = new URLSearchParams();
      elementsParams.append('client_betas[0]', 'custom_checkout_server_updates_1');
      elementsParams.append('client_betas[1]', 'custom_checkout_manual_approval_1');
      elementsParams.append('deferred_intent[mode]', 'subscription');
      elementsParams.append('deferred_intent[amount]', '0');
      elementsParams.append('deferred_intent[currency]', 'usd');
      elementsParams.append('deferred_intent[setup_future_usage]', 'off_session');
      elementsParams.append('deferred_intent[payment_method_types][0]', 'card');
      elementsParams.append('currency', 'usd');
      elementsParams.append('key', OPENAI_STRIPE_PK);
      elementsParams.append('_stripe_version', STRIPE_VERSION);
      elementsParams.append('elements_init_source', 'custom_checkout');
      elementsParams.append('referrer_host', 'chatgpt.com');
      // 使用 UUID 格式的 stripe_js_id，与真实浏览器一致
      const uuidV4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
      elementsParams.append('stripe_js_id', uuidV4());
      elementsParams.append('locale', 'zh');
      elementsParams.append('type', 'deferred_intent');
      elementsParams.append('checkout_session_id', sessionId);

      const elementsRes = await fetch(`https://api.stripe.com/v1/elements/sessions?${elementsParams.toString()}`, {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Referer': 'https://js.stripe.com/',
          'Origin': 'https://js.stripe.com',
        },
        agent
      });

      const elementsData = await elementsRes.json();
      
      if (!elementsRes.ok || elementsData.error) {
        const errMsg = elementsData.error?.message || `Elements Session 初始化失败 (HTTP ${elementsRes.status})`;
        throw new Error(`Session 初始化失败: ${errMsg}`);
      }
      
      // 深度搜索金额
      const cs = elementsData.checkout_session || {};
      const es = elementsData.elements_session || {};
      const order = elementsData.order || {};
      
      console.log(`[Protocol] Elements Session 所有顶层键:`, Object.keys(elementsData).join(', '));
      if (Object.keys(order).length > 0) {
        console.log(`[Protocol] order 数据详情:`, JSON.stringify(order));
      }
      
      const clientSecret = elementsData.checkout_session?.client_secret 
        || elementsData.client_secret 
        || elementsData.elements_session?.client_secret;
      console.log(`[Protocol] Client Secret 存在: ${!!clientSecret}`);
      
      let totalAmount = cs.total?.total?.amount
        || cs.total?.amount
        || cs.amount_total 
        || cs.amount_subtotal
        || es.amount
        || order.amount
        || order.amount_total
        || order.total?.amount
        || elementsData.amount_total
        || 0;
        
      // 如果从 order 里拿到了非 0 金额，且之前是 0，更新它
      console.log(`[Protocol] 初步提取金额: ${totalAmount}`);
        
      // 这里的 0 通常是因为 OpenAI 的 Custom Checkout 是 $0 试用 (Setup Intent)
      if (totalAmount === 0 && checkoutUrl.includes('openai')) {
        console.log(`[Protocol] 检测到 $0 套餐 (可能为 Business 试用/代付校验)`);
      }
      
      const currency = cs.currency || order.currency || elementsData.currency || 'usd';
      console.log(`[Protocol] Elements Session 初始化完成, 使用金额: ${totalAmount} ${currency}`);

      // ========== Step 2: 创建 PaymentMethod ==========
      console.log(`[Protocol] Step 2/3: 创建卡片 Token (****${cardInfo.number.slice(-4)})...`);
      
      // 生成 Stripe.js 指纹参数 (模拟真实浏览器环境)
      const generateId = () => {
        const chars = '0123456789abcdef';
        let id = '';
        for (let i = 0; i < 32; i++) id += chars[Math.floor(Math.random() * chars.length)];
        return id;
      };
      const guid = generateId();
      const muid = generateId();
      const sid = generateId();
      
      const tokenBody = new URLSearchParams();
      tokenBody.append('card[number]', cardInfo.number);
      tokenBody.append('card[exp_month]', cardInfo.expiryMonth);
      tokenBody.append('card[exp_year]', cardInfo.expiryYear);
      tokenBody.append('card[cvc]', cardInfo.cvv);
      tokenBody.append('card[name]', addressInfo.name || 'OpenAI User');
      tokenBody.append('card[address_line1]', addressInfo.street || '');
      tokenBody.append('card[address_city]', addressInfo.city || '');
      tokenBody.append('card[address_state]', addressInfo.state || '');
      tokenBody.append('card[address_zip]', addressInfo.zip || '');
      tokenBody.append('card[address_country]', 'US');
      tokenBody.append('key', OPENAI_STRIPE_PK);
      tokenBody.append('_stripe_version', STRIPE_VERSION);
      tokenBody.append('payment_user_agent', 'stripe.js/b291ad7843; stripe-js-v3/b291ad7843; custom-checkout; checkout');
      tokenBody.append('time_on_page', String(30000 + Math.floor(Math.random() * 60000)));
      tokenBody.append('guid', guid);
      tokenBody.append('muid', muid);
      tokenBody.append('sid', sid);
      tokenBody.append('pasted_fields', 'number');
      
      const tokenRes = await fetch('https://api.stripe.com/v1/tokens', {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://js.stripe.com/',
          'Origin': 'https://js.stripe.com',
          'Accept': 'application/json',
        },
        body: tokenBody.toString(),
        agent
      });

      const tokenData = await tokenRes.json();
      
      if (!tokenRes.ok || tokenData.error) {
        const errMsg = tokenData.error?.message || tokenData.error?.code || '创建卡片 Token 失败';
        throw new Error(`卡片验证失败: ${errMsg}`);
      }
      
      const tokenId = tokenData.id;
      console.log(`[Protocol] Token: ${tokenId} (card: ${tokenData.card?.brand} ****${tokenData.card?.last4})`);

      // ========== Step 3: 确认 Custom Checkout Session ==========
      console.log(`[Protocol] Step 3/3: 确认 Custom Checkout Session 扣款...`);
      
      // 提取 email：从 elements session 获取，或从 checkout 记录生成
      const customerEmail = elementsData.checkout_session?.customer_email 
        || elementsData.checkout_session?.customer?.email
        || addressInfo.email
        || `${(addressInfo.name || 'user').toLowerCase().replace(/\s+/g, '.')}${Math.floor(Math.random() * 999)}@gmail.com`;
      console.log(`[Protocol] 使用 email: ${customerEmail}`);
      
      const confirmBody = new URLSearchParams();
      confirmBody.append('payment_method_data[type]', 'card');
      confirmBody.append('payment_method_data[card][token]', tokenId);
      confirmBody.append('payment_method_data[billing_details][name]', addressInfo.name || 'OpenAI User');
      confirmBody.append('payment_method_data[billing_details][email]', customerEmail);
      confirmBody.append('payment_method_data[billing_details][address][line1]', addressInfo.street || '');
      confirmBody.append('payment_method_data[billing_details][address][city]', addressInfo.city || '');
      confirmBody.append('payment_method_data[billing_details][address][state]', addressInfo.state || '');
      confirmBody.append('payment_method_data[billing_details][address][postal_code]', addressInfo.zip || '');
      confirmBody.append('payment_method_data[billing_details][address][country]', 'US');
      confirmBody.append('payment_method_data[billing_details][phone]', addressInfo.phone || '');
      confirmBody.append('expected_amount', String(totalAmount));
      confirmBody.append('return_url', 'https://chatgpt.com/checkout');
      confirmBody.append('key', OPENAI_STRIPE_PK);
      confirmBody.append('_stripe_version', STRIPE_VERSION);

      const confirmRes = await fetch(`https://api.stripe.com/v1/payment_pages/${sessionId}/confirm`, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://js.stripe.com/',
          'Origin': 'https://js.stripe.com',
        },
        body: confirmBody.toString(),
        agent
      });

      const confirmData = await confirmRes.json();
      // 打印完整 confirm 响应，以便分析 $0 试用到底缺什么
      console.log(`[Protocol] Confirm response: HTTP ${confirmRes.status}`);
      console.log(`[Protocol] Confirm 完整数据:`, JSON.stringify(confirmData));
      
      const paymentStatus = confirmData.payment_status || '';
      const sessionStatus = confirmData.status || '';
      const setupIntent = confirmData.setup_intent || confirmData.checkout_session?.setup_intent;
      const subscription = confirmData.subscription || confirmData.checkout_session?.subscription;
      
      const setupSucceeded = setupIntent && setupIntent.status === 'succeeded';
      const setupRequiresAction = setupIntent && (setupIntent.status === 'requires_action' || setupIntent.status === 'requires_confirmation');
      const cardLast4 = cardInfo.number.slice(-4);
      
      // 检查是否需要 3D Secure 验证
      if (setupRequiresAction || confirmData.next_action) {
        console.log(`[Protocol] 检测到 3DS 验证需求，使用 Puppeteer + Stripe.js 处理...`);
        
        const siClientSecret = setupIntent?.client_secret;
        if (!siClientSecret) {
          console.error(`[Protocol] 无法获取 SetupIntent client_secret，跳过 3DS`);
        } else {
          console.log(`[Protocol] SetupIntent: ${setupIntent.id}, status=${setupIntent.status}`);
          console.log(`[Protocol] 启动 Puppeteer 处理 3DS...`);
          
          const browser3ds = await puppeteer.launch({ 
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
          });
          
          try {
            const page = await browser3ds.newPage();
            await page.setUserAgent(UA);
            
            // Stripe.js 在 live mode 下要求 HTTPS origin
            // 先导航到一个 HTTPS 页面，再注入 Stripe.js
            console.log(`[Protocol] 导航到 HTTPS 页面...`);
            await page.goto('https://chatgpt.com/favicon.ico', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            
            // 注入 Stripe.js 脚本
            console.log(`[Protocol] 注入 Stripe.js...`);
            await page.addScriptTag({ url: 'https://js.stripe.com/v3/' });
            await new Promise(r => setTimeout(r, 2000)); // 等待 Stripe.js 初始化
            
            const stripeResult = await page.evaluate(async (pk, clientSecret) => {
              return new Promise((resolve) => {
                // Stripe.js 已经在这个页面上，直接初始化
                try {
                  const stripe = Stripe(pk);
                  
                  stripe.handleNextAction({ clientSecret })
                    .then(result => {
                      if (result.error) {
                        resolve({ status: 'error', error: result.error.message, code: result.error.code });
                      } else {
                        resolve({ 
                          status: 'done', 
                          setupIntentStatus: result.setupIntent?.status || 'unknown',
                          setupIntentId: result.setupIntent?.id 
                        });
                      }
                    })
                    .catch(err => {
                      resolve({ status: 'exception', error: err.message });
                    });
                  
                  // 超时保护 (5 分钟)
                  setTimeout(() => {
                    resolve({ status: 'timeout', error: '3DS 处理超时 (5分钟)' });
                  }, 300000);
                } catch(e) {
                  resolve({ status: 'init_error', error: e.message });
                }
              });
            }, OPENAI_STRIPE_PK, siClientSecret).catch(err => {
              return { status: 'page_error', error: err.message };
            });
            
            // stripeResult 直接包含了 handleNextAction 的结果
            // 翻译常见 Stripe 错误为中文
            const translateError = (msg, code) => {
              const map = {
                'card_declined': '银行拒绝了此卡',
                'insufficient_funds': '卡余额不足',
                'expired_card': '卡已过期',
                'incorrect_cvc': 'CVV 安全码错误',
                'processing_error': '处理错误，请重试',
                'authentication_required': '需要额外身份验证',
                'setup_intent_authentication_failure': '3DS 身份验证失败',
              };
              const translated = map[code] || '';
              const msgMap = {
                'Your card has been declined.': '银行拒绝了此卡',
                'Your card has insufficient funds.': '卡余额不足',
                'Your card has expired.': '卡已过期',
                'Your card\'s security code is incorrect.': 'CVV 安全码错误',
              };
              const translatedMsg = msgMap[msg] || msg;
              return translated ? `${translated} (${translatedMsg})` : translatedMsg;
            };
            
            console.log(`[Protocol] Stripe.js 3DS 结果:`, JSON.stringify(stripeResult));
            
            if (stripeResult.status === 'done') {
              console.log(`[Protocol] ✅ 3DS 验证成功! SetupIntent: ${stripeResult.setupIntentId}, 状态: ${stripeResult.setupIntentStatus}`);
            } else if (stripeResult.status === 'error') {
              const zhError = translateError(stripeResult.error, stripeResult.code);
              console.error(`[Protocol] ❌ 3DS 验证失败: ${zhError} (原始错误码: ${stripeResult.code})`);
            } else if (stripeResult.status === 'timeout') {
              console.error(`[Protocol] ⏰ 3DS 处理超时 (5分钟内未完成)`);
            } else {
              console.error(`[Protocol] ❌ 3DS 处理异常: ${stripeResult.error}`);
            }
            
          } catch (threeDSErr) {
            console.error(`[Protocol] Puppeteer 3DS 处理异常: ${threeDSErr.message}`);
          } finally {
            await browser3ds.close();
            console.log(`[Protocol] 3DS 浏览器已关闭`);
          }
        }
        
        // 最终状态检查
        console.log(`[Protocol] 执行最终状态检查...`);
        await new Promise(r => setTimeout(r, 3000)); // 等待 Stripe 更新状态
        const finalRes = await fetch(`https://api.stripe.com/v1/elements/sessions?${elementsParams.toString()}`, {
          method: 'GET',
          headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://js.stripe.com/' },
          agent
        });
        const finalData = await finalRes.json();
        const finalSetup = finalData.checkout_session?.setup_intent || finalData.elements_session?.setup_intent;
        const finalStatus = finalData.checkout_session?.payment_status || finalData.checkout_session?.status;
        
        console.log(`[Protocol] 最终检查: setup=${finalSetup?.status}, payment=${finalStatus}`);
        
        if (finalSetup?.status === 'succeeded' || finalStatus === 'paid' || finalStatus === 'complete') {
          console.log(`[Protocol] ✅ 3DS 验证完成后，最终检查通过!`);
          return finalData;
        } else {
          console.warn(`[Protocol] 3DS 流程后状态仍为: ${finalSetup?.status || finalStatus}`);
        }
      }

      // 真正成功的判定：
      // 1. 支付状态已支付 (paid)
      // 2. 整个 Session 已完成 (complete)
      // 3. 针对 $0 试用/Setup Intent：SetupIntent 已成功 (succeeded)
      const isActuallyPaid = paymentStatus === 'paid' || sessionStatus === 'complete' || setupSucceeded;
      
      if (!confirmRes.ok || confirmData.error || !isActuallyPaid) {
        const errObj = confirmData.error || {};
        let errMsg = errObj.message || errObj.code || '';
        
        if (!isActuallyPaid && !errMsg) {
           errMsg = `支付未完成 (状态: ${paymentStatus || sessionStatus || 'unknown'})`;
        }
        
        const errCode = errObj.code || '';
        const declineCode = errObj.decline_code || '';
        
        console.error(`[Protocol] 扣款失败: code=${errCode}, decline=${declineCode}, msg=${errMsg}`);
        
        if (errCode === 'card_declined') throw new Error(`拒卡 (${declineCode}): ${errMsg}`);
        if (declineCode === 'insufficient_funds') throw new Error(`余额不足: ${errMsg}`);
        if (errCode === 'authentication_required') throw new Error('需要 3D Secure 验证，此卡需要浏览器环境过验证码');
        if (errCode === 'expired_card') throw new Error(`卡已过期: ${errMsg}`);
        if (errCode === 'incorrect_cvc') throw new Error(`CVV 错误: ${errMsg}`);
        throw new Error(`协议代付失败: ${errMsg || '未知错误'}`);
      }

      console.log(`[Protocol] ✅ 协议代付成功! 订阅: ${subscription?.id || 'new'}`);
      return confirmData;

    } catch (err) {
      if (this.addLog) this.addLog(`[Protocol] 协议代付最终失败: ${err.message}`, 'error');
      else console.error(`[Protocol] 协议代付最终失败:`, err.message);
      throw err;
    }
  }

  /**
   * Main entry point for the auto-checkout flow.
   */
  async runAutoSub(historyId) {
    const item = db.prepare('SELECT * FROM checkout_tools_history WHERE id = ?').get(historyId);
    if (!item) throw new Error('History record not found.');

    const maxRetries = 3;
    let attempt = 1;
    let success = false;
    let lastErr = null;

    while (attempt <= maxRetries && !success) {
      if (attempt > 1) {
         console.log(`[AutoCheckout] 自动代付遭遇失败，尝试第 ${attempt}/${maxRetries} 次重试充值过程 (带换代理IP)...`);
         // 休眠一会儿再试
         await new Promise(r => setTimeout(r, 8000));
      }

      try {
        this.updateStatus(historyId, 'redeeming');
        
        // 每次重试时重新判断卡片（因为如果是卡密模式可以不换，但至少代理会换）
        let cardInfo = { number: '', expiryMonth: '', expiryYear: '', cvv: '' };

        if (item.checkout_mode === 'card') {
          // --- 手工信用卡直录模式：从数据库读取用户手动输入的卡号 ---
          // ... 忽略日志避免刷屏
          const expiry = String(item.card_exp_raw || '');
          const month = expiry.includes('/') ? expiry.split('/')[0].padStart(2, '0') : expiry.slice(0, 2);
          const yearRaw = expiry.includes('/') ? expiry.split('/')[1] : expiry.slice(2);
          const year = yearRaw ? (yearRaw.length === 2 ? `20${yearRaw}` : yearRaw) : '';

          cardInfo = {
            number: (item.card_number_raw || '').replace(/[\s-]/g, ''),
            expiryMonth: month,
            expiryYear: year,
            cvv: item.card_cvv_raw || ''
          };
        } else {
          // --- 卡商 API 模式：通过卡密兑换获取卡信息 ---
          const codeToUse = item.redeem_code_raw || (item.raw_input.includes('cs_') ? '' : item.raw_input);
          if (codeToUse) {
            // 目前同一个 code 调用 redeem 多次（新平台可能会直接返回历史记录卡片），也可以选择通过 status 来捞卡
            cardInfo = await this.redeemCard(codeToUse); 
          } else {
            console.warn(`[AutoCheckout] No redeem code provided. Running API in direct topup mode.`);
          }
        }
        
        // --- 两种模式共用：生成地址 + 纯协议提交 ---
        this.updateStatus(historyId, 'generating_address');
        await new Promise(r => setTimeout(r, 1500));
        const addressInfo = await this.generateAddress(); // 地址生成也会换
        
        const isValidUrl = item.raw_input && /^https?:\/\//i.test(item.raw_input) && item.raw_input.includes('cs_');
        const checkoutUrl = isValidUrl ? item.raw_input : item.normalized_link;
        const sessionId = item.session_id;
        
        // 每次 executeBinding 进去都会调用 getProxyDetails 获取新的袜子代理
        const result = await this.executeBinding(historyId, checkoutUrl, cardInfo, addressInfo, sessionId);
        
        // Final update
        db.prepare(`
          UPDATE checkout_tools_history
          SET autosub_status = 'success',
              card_last4 = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).run(cardInfo.number ? cardInfo.number.slice(-4) : 'N/A', historyId);
        
        success = true;
        
      } catch (err) {
        lastErr = err;
        console.error(`[AutoCheckout] 第 ${attempt} 次尝试失败:`, err.message);
        const errMsg = err.message || '';
        
        // 关键失败判断：如果是以下几种“绝对死卡”情况，就不用重试了，直接抛出。
        // （例如余额不足，或者卡号位数错误）
        if (errMsg.includes('卡已过期') || errMsg.includes('余额不足') || errMsg.includes('CVV')) {
           console.log(`[AutoCheckout] 检测到卡片硬伤 (${errMsg})，跳过剩余重试。`);
           break;
        }
        this.updateStatus(historyId, `retrying_${attempt}`);
      }
      attempt++;
    }

    if (!success) {
       console.error(`[AutoCheckout] 所有重试均失败，标记记录。`);
       db.prepare(`
        UPDATE checkout_tools_history
        SET autosub_status = 'failed',
            autosub_error = ?,
            updated_at = datetime('now')
        WHERE id = ?
      `).run(lastErr ? lastErr.message : '所有重试耗尽', historyId);
       throw lastErr || new Error('Max retries exceeded');
    }
  }

  updateStatus(id, status) {
    db.prepare('UPDATE checkout_tools_history SET autosub_status = ? WHERE id = ?').run(status, id);
  }
}

module.exports = new AutoCheckoutService();

