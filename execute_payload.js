const puppeteer = require('puppeteer-core');
const http = require('http');

const userScript = `
(async function() {
    try {
        // 1. 获取会话信息
        const res = await fetch("/api/auth/session");
        const t = await res.json();

        // 2. 检查是否已登录
        if (!t.accessToken) {
            alert("请先登录 ChatGPT！");
            return;
        }

        // 3. 构建请求载荷
        const p = {
            plan_name: "chatgptteamplan",
            team_plan_data: {
                workspace_name: "Fangmu",
                price_interval: "month",
                seat_quantity: 5
            },
            promo_campaign: {
                promo_campaign_id: "team-1-month-free",
                is_coupon_from_query_param: true
            },
            checkout_ui_mode: "custom"
        };

        // 4. 发送支付/结账请求
        const r = await fetch("https://chatgpt.com/backend-api/payments/checkout", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + t.accessToken,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(p)
        });

        // 5. 处理响应
        const d = await r.json();
        if (d.checkout_session_id) {
            // 跳转短链接
            window.location.href = "https://chatgpt.com/checkout/openai_llc/" + d.checkout_session_id;
        } else {
            alert("提取失败：" + (d.detail || JSON.stringify(d)));
        }
    } catch (e) {
        alert("发生错误：" + e);
    }
})();
`;

function getWSEndpoint() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json/version', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data).webSocketDebuggerUrl));
    }).on('error', reject);
  });
}

(async () => {
  try {
    const browserWSEndpoint = await getWSEndpoint();
    const browser = await puppeteer.connect({ browserWSEndpoint });
    const pages = await browser.pages();
    const chatPage = pages.find(p => p.url().includes('chatgpt.com')) || pages[0];
    
    // 监听可能被触发的 alert，防止脚本卡死，并且把 alert 内容打印到这里供我分析
    chatPage.on('dialog', async dialog => {
        console.log('【页面弹窗拦截】:', dialog.message());
        await dialog.accept(); 
    });

    console.log('🔄 开始向页面注入执行您提供的 Checkout 提取代码...');
    await chatPage.evaluate(userScript);
    console.log('✅ 代码注入成功！正在等待执行结果 (等待3秒看有没有发生跳转或弹窗报错)...');

    // 稍微等待一会，让 fetch 执行并触发 alert 或是 redirect 
    await new Promise(r => setTimeout(r, 3000));
    
    // 获取最终的 url
    const finalUrl = chatPage.url();
    if (finalUrl.includes('checkout')) {
         console.log('🚀 页面已成功发生跳转，当前 URL 为:', finalUrl);
    } else {
         console.log('ℹ️ 页面未跳转，当前 URL 依然是:', finalUrl);
    }

    await browser.disconnect();
  } catch(e) {
    console.error('❌ 执行失败:', e);
  }
})();
