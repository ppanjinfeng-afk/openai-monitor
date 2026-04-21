// extract_session_id.js

/**
 * 提取 Stripe Checkout Session ID (支持 cs_live_ 和 cs_test_)
 * @param {string} checkoutUrl - ChatGPT 返回的支付链接，例如 https://pay.openai.com/c/pay/cs_live_12345...
 * @returns {string} 提取到的 Session ID
 */
function extractSessionId(checkoutUrl) {
    if (!typeof checkoutUrl === 'string' || !checkoutUrl) {
        throw new Error("请提供有效的数字字符支付链接");
    }
    
    // 正则匹配 cs_live_ 或者 cs_test_ 后接一串大小写字母和数字的标识符
    const match = checkoutUrl.match(/(cs_(live|test)_[a-zA-Z0-9]+)/);
    
    if (match && match[1]) {
        return match[1];
    } else {
        throw new Error("未能从链接中找到 Session ID，请检查链接是否包含 cs_live_ 或 cs_test_");
    }
}

// 如果是通过命令行直接运行该文件，则执行测试逻辑
if (require.main === module) {
    // 优先读取命令行参数，否则使用默认的测试链接
    const sampleUrl = process.argv[2] || "https://pay.openai.com/c/pay/cs_live_a1z7TLqSwcT4p8tbSNb9xmqWjCmnOCadFpFszvl";
    
    console.log("🔗 正在解析链接:\n" + sampleUrl);
    console.log("--------------------------------------------------");
    
    try {
        const sessionId = extractSessionId(sampleUrl);
        console.log("✅ 成功抓取 Session ID :", sessionId);
    } catch (err) {
        console.error("❌ 提取失败 :", err.message);
    }
}

module.exports = { extractSessionId };
