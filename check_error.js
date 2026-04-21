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

    console.log('🔄 正在扫描页面上的错误提示信息...');
    const errorDetails = await page.evaluate(() => {
        const errors = [];
        // 查找常见的错误提示元素（role=alert, 或者是红色的文本等）
        const alertElements = document.querySelectorAll('[role="alert"], .FieldError, .PaymentError, .Text-color--red, .Notice--error, [class*="error"], [id*="error"]');
        
        alertElements.forEach(el => {
            const text = el.innerText || el.textContent;
            if (text && text.trim().length > 0) {
                errors.push(text.trim());
            }
        });

        // 顺便把整个页面的纯文本也摘要一点，以防特殊 DOM 结构没抓到
        const bodyText = document.body.innerText.replace(/\n\s*\n/g, '\n');
        
        return {
            url: window.location.href,
            errors: [...new Set(errors)], // 去重
            snippet: bodyText.substring(0, 800)
        };
    });

    console.log("=== 🔍 诊断结果 ===");
    console.log("当前所处 URL:", errorDetails.url);
    if (errorDetails.errors.length > 0) {
        console.log("🔴 检测到的页面错误/警告文本有:");
        errorDetails.errors.forEach(err => console.log("  -", err));
    } else {
        console.log("⚠️ 没有抓取到带有 error 相关特征标签的文本。页面前部内容摘要为:");
        console.log(errorDetails.snippet);
    }
    
    await browser.disconnect();
  } catch(e) {
    console.error('❌ 执行失败:', e);
  }
})();
