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

        // 移除了 checkout_ui_mode 字段，测试官方是否会返回标准 Hosted 结账 URL
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
            }
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
        return { responseData: d }; //把完整响应返回给节点层打印分析
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
    
    console.log('🔄 再次执行获取结账数据...');
    const result = await chatPage.evaluate(userScript);
    
    if (result && result.error) {
        console.error('❌ ' + result.error);
    } else if (result && result.responseData) {
        console.log('✅ 后端完整返回结果:');
        console.log(JSON.stringify(result.responseData, null, 2));

        const d = result.responseData;
        let finalUrl = null;
        
        // 如果官方本来就直接返回了独立结账地址 url (通常是 pay.openai.com)
        if (d.url) {
             finalUrl = d.url;
             console.log('🎯 成功获得官方直接返回的充值跳转链接！');
        } else if (d.url === undefined && d.checkout_session_id) {
             console.log('⚠️ 官方还是只给了 ID，说明默认可能依然是不带 URL 的，我们提取到了:', d.checkout_session_id);
             // 按照 OpenAI 常规的 Stripe Checkout 前缀进行拼接实验
             finalUrl = "https://pay.openai.com/c/pay/" + d.checkout_session_id; 
        }

        if (finalUrl) {
            console.log('🚀 准备帮您跳转到:', finalUrl);
            await chatPage.goto(finalUrl, { waitUntil: 'domcontentloaded' });
            console.log('🏁 跳转执行完毕，请看您的浏览器！停留 URL 为: ' + chatPage.url());
        }
    }

    await browser.disconnect();
  } catch(e) {
    console.error('❌ 执行失败:', e);
  }
})();
