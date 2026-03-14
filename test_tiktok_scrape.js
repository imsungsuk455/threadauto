const { scrapeTiktokByUser } = require('./src/tiktok-scraper');

async function test() {
    console.log('Testing TikTok scrape for user "mrbeast"...');
    const result = await scrapeTiktokByUser('mrbeast', 5);
    console.log('Result:', JSON.stringify(result, null, 2));
}

test().catch(err => {
    console.error('Test failed:', err);
});
