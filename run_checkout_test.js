const checkout = require('./services/auto-checkout');

async function test() {
    try {
        const historyId = -1; // mock
        const checkoutUrl = 'https://chatgpt.com/checkout/openai_llc/cs_live_a1xbgR6wcSvwIrfaXcFCDeLarh49wnOvxmROhz7C8wBkhm0Mtd7u3xXVY3';
        const sessionId = 'cs_live_a1xbgR6wcSvwIrfaXcFCDeLarh49wnOvxmROhz7C8wBkhm0Mtd7u3xXVY3';
        const code = 'J6XA-VCUS-Z75C-PH8A';

        // 1. redeemCard
        // Hack: temporarily remove updateStatus usage in binding if historyId=-1
        const originalUpdateStatus = checkout.updateStatus;
        checkout.updateStatus = () => {};

        console.log('--- Redeeming ---');
        // Let's first just dump what's retrieved
        const cardInfo = await checkout.redeemCard(code);
        console.log('Parsed card Info:', cardInfo);

        // 2. run auto checkout binding
        const addressInfo = await checkout.generateAddress();
        const result = await checkout.executeBinding(-1, checkoutUrl, cardInfo, addressInfo, sessionId);
        console.log('Result:', result);
        
        checkout.updateStatus = originalUpdateStatus;
        process.exit(0);
    } catch(e) {
        console.error(e);
        process.exit(1);
    }
}
test();
