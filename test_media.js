const axios = require('axios');
const cheerio = require('cheerio');

async function test() {
    // 예시: 네이버 스마트스토어 상품 페이지
    const url = 'https://smartstore.naver.com/thefame/products/5677940191';
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
            }
        });
        const $ = cheerio.load(res.data);
        console.log('Title:', $('title').text());

        // 움짤(GIF) 찾기
        const gifs = [];
        $('img').each((i, el) => {
            const src = $(el).attr('src') || $(el).attr('data-src') || '';
            if (src.toLowerCase().includes('.gif')) {
                gifs.push(src);
            }
        });
        console.log('GIFs found:', gifs.length);
        if (gifs.length > 0) console.log('Sample GIF:', gifs[0]);

        // 비디오 소스 찾기
        const videos = [];
        $('video, source').each((i, el) => {
            const src = $(el).attr('src') || $(el).attr('data-src') || '';
            if (src.includes('.mp4') || src.includes('.mov')) {
                videos.push(src);
            }
        });
        console.log('Videos found:', videos.length);

    } catch (e) {
        console.log('Error:', e.message);
    }
}
test();
