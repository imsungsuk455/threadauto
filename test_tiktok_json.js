const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function testJsonExtraction(username) {
    const url = `https://www.tiktok.com/@${username}`;
    console.log(`Checking ${url} for JSON data...`);
    
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
    
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    
    const content = await page.content();
    
    // Look for SIGI_STATE or __NEXT_DATA__
    const sigiMatch = content.match(/<script id="SIGI_STATE" type="application\/json">([\s\S]*?)<\/script>/);
    const nextMatch = content.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    
    if (sigiMatch) {
        console.log("Found SIGI_STATE JSON!");
        // console.log(sigiMatch[1].substring(0, 500));
    } else if (nextMatch) {
        console.log("Found __NEXT_DATA__ JSON!");
    } else {
        console.log("No JSON blob found in page source.");
        // Save screenshot to see what's happening
        await page.screenshot({ path: 'debug_source.png' });
    }
    
    await browser.close();
}

testJsonExtraction('mrbeast');
