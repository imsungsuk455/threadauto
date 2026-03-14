const { scrapeThreadsByUser } = require('./src/threads-scraper');

async function test() {
    const result = await scrapeThreadsByUser('zuck', 15);
    console.log(JSON.stringify(result, null, 2));
}

test();
