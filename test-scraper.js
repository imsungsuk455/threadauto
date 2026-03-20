const threadsScraper = require('./src/threads-scraper');
const { log } = require('./src/utils');

async function test() {
    console.log('Testing Threads Scraper with limit 10...');
    const result = await threadsScraper.scrapeThreadsByUser('battleofwin45', 10);
    console.log(`Success: ${result.success}`);
    console.log(`Count: ${result.threads.length}`);
    if (result.threads.length > 0) {
        console.log(`First thread ID: ${result.threads[0].id}`);
    }
}

test();
