const puppeteer = require('puppeteer-core');
const http = require('http');

const userScript = `
(async function() {
    try {
        const res = await fetch("/api/auth/session");
        const t = await res.json();

        if (!t.accessToken) {
            return { error: "请先登录 ChatGPT！" };
        }

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

        const r = await fetch("https://chatgpt.com/backend-api/payments/checkout", {
            method: "POST",
            headers: {
                Authorization: "Bearer " + t.accessToken,
                "Content-Type": "application/json"
            },
            body: JSON.stringify(p)
        });

        const d = await r.json();
        if (d.checkout_session_id) {
            // 返回需要跳转的真实URL，不在前端执行跳转
            return { url: "https://chatgpt.com/checkout/openai_llc/" + d.checkout_session_id };
        } else {
            return { error: "提取失败：" + (d.detail || JSON.stringify(d)) };
        }
    } catch (e) {
        return { error: "发生错误：" + e.toString() };
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
    
    console.log('🔄 再次执行获取结账 ID...');
    const result = await chatPage.evaluate(userScript);
    
    if (result && result.error) {
        console.error('❌ ' + result.error);
    } else if (result && result.url) {
        console.log('✅ 生成结账链接成功: ' + result.url);
        console.log('🚀 强制通过 Puppeteer 使用底层导航进行跳转 (绕过前端可能存在的路由拦截)...');
        
        // 使用 Puppeteer 发起硬导航，等同于在地址栏按回车，这会处理 302 重定向到 Stripe
        await chatPage.goto(result.url, { waitUntil: 'domcontentloaded' });
        
        // 打印最终落地页
        const finalUrl = chatPage.url();
        console.log('🏁 页面已彻底刷新/重定向完成，当前停留地址:');
        console.log(finalUrl);
    }

    await browser.disconnect();
  } catch(e) {
    console.error('❌ 执行失败:', e);
  }
})();
