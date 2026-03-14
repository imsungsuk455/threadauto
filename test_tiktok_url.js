const tiktokScraper = require('./src/tiktok-scraper');

async function testUrl() {
    const url = 'https://www.tiktok.com/@mrbeast/video/7606031409408478495';
    console.log(`Testing TikTok scrape for URL "${url}"...`);
    const result = await tiktokScraper.scrapeTiktokByUrl(url);
    console.log('Result:', JSON.stringify(result, null, 2));
}

testUrl();
