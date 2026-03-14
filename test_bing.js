const axios = require('axios');
const cheerio = require('cheerio');

async function testBingImage(query) {
    try {
        const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC3`;
        const res = await axios.get(searchUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36' }
        });

        const $ = cheerio.load(res.data);
        const media = [];

        $('.mimg').each((i, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src') || '';
            if (src && src.startsWith('http')) {
                media.push(src);
            }
        });

        console.log("Bing Method 1 count:", media.length);
        console.log("Sample URLs:", media.slice(0, 3));

        const regex = /murl&quot;:&quot;(.*?)&quot;/g;
        let match;
        const regexMedia = [];
        while ((match = regex.exec(res.data)) !== null) {
            regexMedia.push(match[1]);
        }

        console.log("Bing Regex count:", regexMedia.length);
        console.log("Sample URLs:", regexMedia.slice(0, 3));

    } catch (e) {
        console.error(e.message);
    }
}

testBingImage('연예뉴스 아이유');
testBingImage('이재명 대표');
