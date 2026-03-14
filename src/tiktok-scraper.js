const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
puppeteer.use(StealthPlugin());

const { log } = require('./utils');

/**
 * TikTok Scraper
 * Ported from Zeeshanahmad4/Tiktok-User-Video-Post-Scraper
 * Uses Puppeteer to scroll the user profile and extract video feeds.
 */
async function scrapeTiktokByUser(username, limit = 10) {
    const cleanUsername = username.startsWith('@') ? username.substring(1) : username;
    const url = `https://www.tiktok.com/@${cleanUsername}`;
    log('INFO', `Scraping TikTok for user via yt-dlp: ${cleanUsername}`);
    
    // 1. Try yt-dlp first (fastest and bypasses CAPTCHA usually)
    try {
        const cmd = `python -m yt_dlp --flat-playlist -j --playlist-items 1-${limit} "${url}" --no-warnings --quiet`;
        const { stdout } = await execPromise(cmd);
        
        if (stdout) {
            const lines = stdout.trim().split('\n');
            const videos = lines.map(line => {
                try {
                    const data = JSON.parse(line);
                    return {
                        id: data.id,
                        url: data.url || data.webpage_url,
                        author: data.uploader || cleanUsername,
                        content: data.description || data.title || '',
                        views: data.view_count ? data.view_count.toLocaleString() : '0',
                        mediaUrls: data.thumbnails ? [data.thumbnails[data.thumbnails.length - 1]?.url].filter(u => u) : [],
                        timestamp: data.timestamp ? new Date(data.timestamp * 1000).toISOString() : new Date().toISOString()
                    };
                } catch (e) { return null; }
            }).filter(v => v !== null);

            if (videos.length > 0) {
                log('INFO', `Found ${videos.length} TikTok videos for ${cleanUsername} via yt-dlp`);
                return { success: true, videos: videos };
            }
        }
    } catch (e) {
        log('WARN', `yt-dlp TikTok scrape failed: ${e.message}. Falling back to Puppeteer...`);
    }

    // 2. Fallback to Puppeteer
    log('INFO', `Scraping TikTok for user via Puppeteer: ${username}`);
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1366, height: 768 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });

        await page.goto(`${url}?langCountry=en`, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 5000));
        
        const isCaptcha = await page.evaluate(() => {
            return document.body.innerText.includes('Verify you are human') || 
                   document.body.innerText.includes('CAPTCHA') ||
                   document.body.innerText.includes('puzzle') ||
                   !!document.querySelector('#captcha-container') ||
                   !!document.querySelector('.captcha_verify_container');
        });
        if (isCaptcha) {
            log('WARN', 'Detected TikTok CAPTCHA or Verification screen in Puppeteer.');
        }
        
        const waitResult = await page.waitForSelector('[data-e2e="user-post-item-list"], [data-e2e="user-post-item"], a[href*="/video/"]', { timeout: 15000 }).catch(async () => {
             const noAccount = await page.evaluate(() => {
                 return document.body.innerText.includes('find this account') || 
                        document.body.innerText.includes('계정을 찾지 못했습니다');
             });
             if (noAccount) return 'NOT_FOUND';
             return 'TIMEOUT';
        });

        if (waitResult === 'NOT_FOUND') {
            await browser.close();
            return { success: false, message: 'TikTok 계정을 찾을 수 없습니다.' };
        }
        
        // Scroll logic (same as before)
        let previousHeight = 0;
        let matchCount = 0;
        const maxScrolls = 5;
        for (let i = 0; i < maxScrolls; i++) {
            const currentHeight = await page.evaluate('document.body.scrollHeight');
            if (previousHeight === currentHeight) {
                matchCount++;
                if (matchCount >= 2) break;
            } else { matchCount = 0; }
            previousHeight = currentHeight;
            await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        const videos = await page.evaluate((limitVal) => {
            const items = Array.from(document.querySelectorAll('[data-e2e="user-post-item"]'));
            const results = [];
            const seenIds = new Set();
            
            for (let i = 0; i < items.length; i++) {
                if (results.length >= limitVal) break;
                const item = items[i];
                const aTag = item.querySelector('a[href*="/video/"]');
                if (!aTag) continue;

                let videoUrl = aTag.href || '';
                const id = videoUrl.split('/video/')[1]?.split('?')[0];
                if (!id || seenIds.has(id)) continue;
                seenIds.add(id);

                const viewsEl = item.querySelector('[data-e2e="video-views"]');
                const imgEl = item.querySelector('img');

                results.push({
                    id: id,
                    url: videoUrl,
                    author: videoUrl.split('@')[1]?.split('/')[0] || 'unknown',
                    content: (imgEl && imgEl.alt) || aTag.title || '',
                    views: viewsEl ? viewsEl.innerText.trim() : '0',
                    mediaUrls: imgEl && imgEl.src ? [imgEl.src] : [],
                    timestamp: new Date().toISOString()
                });
            }
            return results;
        }, limit);

        await browser.close();
        return { success: true, videos: videos };

    } catch (e) {
        if (browser) await browser.close();
        log('ERROR', `TikTok Puppeteer fallback failed: ${e.message}`);
        return { success: false, message: e.message };
    }
}

async function scrapeTiktokByUrl(videoUrl) {
    log('INFO', `Scraping TikTok video via yt-dlp: ${videoUrl}`);
    
    // 1. Try yt-dlp first
    try {
        const cmd = `python -m yt_dlp -j "${videoUrl}" --no-warnings --quiet`;
        const { stdout } = await execPromise(cmd);
        if (stdout) {
            const data = JSON.parse(stdout);
            const videoData = {
                id: data.id,
                url: data.url || data.webpage_url || videoUrl,
                author: data.uploader || 'unknown',
                content: data.description || data.title || '',
                views: data.view_count ? data.view_count.toLocaleString() : '0',
                mediaUrls: data.thumbnails ? [data.thumbnails[data.thumbnails.length - 1]?.url].filter(u => u) : [],
                timestamp: data.timestamp ? new Date(data.timestamp * 1000).toISOString() : new Date().toISOString()
            };
            return { success: true, videos: [videoData] };
        }
    } catch (e) {
        log('WARN', `yt-dlp TikTok URL scrape failed: ${e.message}`);
    }

    // 2. Fallback to Puppeteer (minimal)
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox']
        });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36');
        
        await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        const videoData = await page.evaluate((url) => {
            const h1 = document.querySelector('h1[data-e2e="browse-video-desc"]');
            const authorEl = document.querySelector('[data-e2e="browse-username"], .tiktok-1c7urt-SpanUniqueId');
            const img = document.querySelector('img[mode="2"], img.tiktok-1itcwxg-ImgAvatar');
            
            return {
                id: url.split('/video/')[1]?.split('?')[0] || `tt_${Date.now()}`,
                url: url,
                author: authorEl ? authorEl.innerText : '',
                content: h1 ? h1.innerText : '',
                mediaUrls: img && img.src ? [img.src] : [],
                timestamp: new Date().toISOString()
            };
        }, videoUrl);
        
        await browser.close();
        return { success: true, videos: [videoData] };
    } catch (e) {
        if (browser) await browser.close();
        log('ERROR', `TikTok URL scraping failed: ${e.message}`);
        return { success: false, message: e.message };
    }
}

module.exports = {
    scrapeTiktokByUser,
    scrapeTiktokByUrl
};
