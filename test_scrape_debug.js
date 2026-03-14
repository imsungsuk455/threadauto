const scraper = require('./src/threads-scraper');

async function test() {
    console.log('Testing @today_fun_clip...');
    const result = await scraper.scrapeThreadsByUser('today_fun_clip', 5);
    console.log('Result:', JSON.stringify(result, null, 2));
}

test();
