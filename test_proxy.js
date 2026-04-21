const fetch = require('node-fetch');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const proxyUrlStr = 'http://t74p1119186-region-US-st-Texas-city-Austin-sid-jfsBXy6i-t-1:ismd2kxe@us2.cliproxy.io:3010';
const socksUrlStr = 'socks5://t74p1119186-region-US-st-Texas-city-Austin-sid-jfsBXy6i-t-1:ismd2kxe@us2.cliproxy.io:3010';

async function testHttp() {
    console.log('Testing HTTP proxy...');
    const agent = new HttpsProxyAgent(proxyUrlStr);
    try {
        const res = await fetch('https://api.ipify.org?format=json', { agent, timeout: 5000 });
        console.log('HTTP:', await res.json());
    } catch(e) {
        console.error('HTTP Proxy failed:', e.message);
    }
}

async function testSocks() {
    console.log('Testing SOCKS proxy...');
    const agent = new SocksProxyAgent(socksUrlStr);
    try {
        const res = await fetch('https://api.ipify.org?format=json', { agent, timeout: 5000 });
        console.log('SOCKS:', await res.json());
    } catch(e) {
        console.error('SOCKS Proxy failed:', e.message);
    }
}

async function main() {
   await testHttp();
   await testSocks();
}

main();
