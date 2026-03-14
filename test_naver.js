const axios = require('axios');
const cheerio = require('cheerio');

async function testNaverImage(query) {
    try {
        const searchUrl = `https://search.naver.com/search.naver?where=image&query=${encodeURIComponent(query)}`;
        const res = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36' }
        });

        const $ = cheerio.load(res.data);
        const media = [];

        $('img._image._listImage').each((i, el) => {
            let src = $(el).attr('src') || $(el).attr('data-lazy-src') || '';
            if (src && src.startsWith('http')) {
                media.push(src);
            }
        });

        console.log("Method 1 (Selectors) count:", media.length);

        const regex = /"originalUrl":"(https:[^"]+)"/g;
        let match;
        const regexMedia = [];
        while ((match = regex.exec(res.data)) !== null) {
            regexMedia.push(match[1].replace(/\\/g, ''));
        }

        console.log("Method 2 (Regex) count:", regexMedia.length);

        // try to find any data-lazy-src
        const lazyMedia = [];
        $('img').each((i, el) => {
            let src = $(el).attr('data-lazy-src');
            if (src && src.startsWith('http')) {
                lazyMedia.push(src);
            }
        });
        console.log("Method 3 (attribute) count:", lazyMedia.length);

        console.log("Sample URLs:", regexMedia.slice(0, 3));

    } catch (e) {
        console.error(e.message);
    }
}

testNaverImage('아이유');
