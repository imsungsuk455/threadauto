async function test(options) {
    try {
        const response = await fetch('https://smartstore.naver.com/main/products/9238112837', options);
        console.log("Status:", response.status);
        if (response.ok) {
            const text = await response.text();
            console.log(text.substring(0, 500));
        }
    } catch (e) {
        console.error(e.message);
    }
}
test({ headers: { 'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)' } });
test({ headers: { 'User-Agent': 'Yeti/1.0 (+http://naver.me/bot)' } });
