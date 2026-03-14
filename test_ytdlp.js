const { scrapeThreadByUrl } = require('./src/threads-scraper');

async function test() {
    // Current high-engagement thread or video thread
    const url = 'https://www.threads.net/t/C4zS8Y-S_Rj'; 
    console.log('Testing URL scraper with yt-dlp enrichment...');
    const result = await scrapeThreadByUrl(url);
    console.log(JSON.stringify(result, null, 2));
}

test();
