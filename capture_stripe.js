const puppeteer = require('puppeteer-core');
const http = require('http');

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
        const ws = await getWSEndpoint();
        const browser = await puppeteer.connect({ browserWSEndpoint: ws });
        const pages = await browser.pages();
        const page = pages.find(p => p.url().includes('pay.openai.com') || p.url().includes('stripe.com')) || pages[0];

        console.log('🔄 开始给页面挂载底层网络监听器（Netwok Sniffer）...');

        let stripeError = null;

        // 拦截网络日志
        page.on('response', async (response) => {
            const url = response.url();
            // 抓取 Stripe 核心支付接口（无论是 /confirm 还是 /payment_methods 都能抓到）
            if (url.includes('api.stripe.com') || url.includes('/confirm') || url.includes('payment')) {
                try {
                    const status = response.status();
                    const body = await response.json();
                    
                    if (body && body.error) {
                        stripeError = body.error;
                        console.log(`\n🔥 [核心线索] 成功拦截到 Stripe 真实接口状态码 ${status}。隐藏的拒卡真实原因为:`);
                        console.log(JSON.stringify(stripeError, null, 2));
                    }
                } catch(e) {}
            }
        });

        console.log('👉 监听器已就绪。');
        
        // 我们尝试替您再点一下页面底部的支付/订阅按钮，重新触发一次发包
        try {
            // Hosted 页面常见的确认按钮 selector
            const sumbitBtn = await page.$('button.SubmitButton');
            if (sumbitBtn) {
                console.log('👆 已找到订阅按钮，正在触发点击自动发包...');
                await sumbitBtn.click();
            } else {
                console.log('⚠️ 没有自动定位到按钮，麻烦您在浏览器上【手动再点一次支付】，脚本正在录制您的数据包...');
            }
        } catch(e){}

        // 等待几秒钟让网络请求一来一回
        console.log('⏳ 正在等待拦截日志...');
        await new Promise(r => setTimeout(r, 6000));

        if (!stripeError) {
             console.log('🤔 未在此期间捕捉到新的 Stripe 明确带有 error 字段的 JSON 报错，您可以再重试一次。');
        }

        await browser.disconnect();
    } catch(e) {
        console.error('❌ 脚本错误:', e);
    }
})();
