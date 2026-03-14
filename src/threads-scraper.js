const axios = require('axios');
const cheerio = require('cheerio');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const { log } = require('./utils');

/**
 * Threads Scraper - Mimics the logic of Zeeshanahmad4/Threads-Scraper
 * Extracts public data from Threads.net without login.
 */

async function scrapeThreadsByUser(username, limit = 10) {
    const url = `https://www.threads.net/@${username}`;
    log('INFO', `Scraping threads for user: ${username}`);
    
    try {
        const res = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            }
        });

        const html = res.data;
        const $ = cheerio.load(html);
        
        // Threads often embeds data in several JSON blobs in script tags.
        // We look for patterns used in common scrapers.
        const threads = [];
        
        // Pattern 1: __PRELOADED_STATE__
        const preloadedMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
        if (preloadedMatch) {
            try {
                const state = JSON.parse(preloadedMatch[1]);
                // Navigate through state to find threads
                // This path changes often, but we can look for common keys
                extractThreadsFromObject(state, threads);
            } catch (e) {
                log('ERROR', `Failed to parse __PRELOADED_STATE__: ${e.message}`);
            }
        }
        
        // Pattern 2: __additionalDataLoaded
        const additionalMatch = html.match(/__additionalDataLoaded\s*\(\s*['"].*?['"]\s*,\s*(\{[\s\S]*?\})\s*\);/g);
        if (additionalMatch) {
            additionalMatch.forEach(match => {
                try {
                    const jsonStr = match.match(/__additionalDataLoaded\s*\(\s*['"].*?['"]\s*,\s*(\{[\s\S]*?\})\s*\);/)[1];
                    const data = JSON.parse(jsonStr);
                    extractThreadsFromObject(data, threads);
                } catch (e) {}
            });
        }

        // Pattern 3: Look for all JSON scripts
        $('script[type="application/json"]').each((i, el) => {
            try {
                const content = $(el).html();
                if (content.includes('thread_items') || content.includes('post_text') || content.includes('caption')) {
                    const data = JSON.parse(content);
                    extractThreadsFromObject(data, threads);
                }
            } catch (e) {}
        });

        // Deduplicate threads by ID
        const uniqueThreads = [];
        const seenIds = new Set();
        for (const t of threads) {
            if (!seenIds.has(t.id) && t.content) {
                uniqueThreads.push(t);
                seenIds.add(t.id);
            }
        }

        log('INFO', `Found ${uniqueThreads.length} threads for ${username}`);
        return { success: true, threads: uniqueThreads.slice(0, limit) };
    } catch (e) {
        log('ERROR', `Scraping failed: ${e.message}`);
        return { success: false, message: e.message };
    }
}

async function scrapeThreadByUrl(threadUrl) {
    log('INFO', `Scraping thread from URL: ${threadUrl}`);
    try {
        const res = await axios.get(threadUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1'
            }
        });
        
        const html = res.data;
        const $ = cheerio.load(html);
        const threads = [];
        
        // Pattern 1: __PRELOADED_STATE__
        const preloadedMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
        if (preloadedMatch) {
            try {
                const state = JSON.parse(preloadedMatch[1]);
                extractThreadsFromObject(state, threads);
            } catch (e) {}
        }

        // Pattern 2: __additionalDataLoaded
        const additionalMatch = html.match(/__additionalDataLoaded\s*\(\s*['"].*?['"]\s*,\s*(\{[\s\S]*?\})\s*\);/g);
        if (additionalMatch) {
            additionalMatch.forEach(match => {
                try {
                    const jsonStr = match.match(/__additionalDataLoaded\s*\(\s*['"].*?['"]\s*,\s*(\{[\s\S]*?\})\s*\);/)[1];
                    const data = JSON.parse(jsonStr);
                    extractThreadsFromObject(data, threads);
                } catch (e) {}
            });
        }

        // Pattern 3: Look for all JSON scripts (this is the most reliable one for Threads right now)
        $('script[type="application/json"]').each((i, el) => {
            try {
                const content = $(el).html();
                // We loosen the condition so we don't skip the actual thread
                if (content.includes('thread_items') || content.includes('post_text') || content.includes('caption') || content.includes('video_versions')) {
                    const data = JSON.parse(content);
                    extractThreadsFromObject(data, threads);
                }
            } catch (e) {}
        });

        // Aggressive fallback for single post URL if the structured object parsing failed
        if (threads.length === 0) {
            log('INFO', 'Aggressive HTML JSON parsing for single post to find media...');
            const aggressiveMedia = [];
            
            const findUrlsAggressive = (obj) => {
                if (!obj) return;
                if (typeof obj === 'string') {
                    if (obj.match(/^https?:\/\/.*?\.(?:jpg|jpeg|png|webp|gif|mp4|mov)(?:\?.*)?$/i)) {
                        if (!obj.includes('icon') && !obj.includes('avatar') && !obj.includes('profile') && obj.length > 50) {
                            aggressiveMedia.push(obj);
                        }
                    }
                } else if (Array.isArray(obj)) {
                    obj.forEach(findUrlsAggressive);
                } else if (typeof obj === 'object') {
                    Object.values(obj).forEach(findUrlsAggressive);
                }
            };

            $('script[type="application/json"]').each((i, el) => {
                try {
                    findUrlsAggressive(JSON.parse($(el).html()));
                } catch(e) {}
            });

            const uniqueMedia = [...new Set(aggressiveMedia)].filter(u => u.includes('instagram.com') || u.includes('fbcdn.net'));
            
            if (uniqueMedia.length > 0) {
                // Determine post content (often hidden in meta tags if not parsed by object)
                const title = $('meta[property="og:description"]').attr('content') || $('title').text() || `Threads 게시물 (${threadUrl})`;
                const ogImage = $('meta[property="og:image"]').attr('content');
                if (ogImage) uniqueMedia.unshift(ogImage);

                threads.push({
                    id: `parsed-${Date.now()}`,
                    content: title,
                    mediaUrls: [...new Set(uniqueMedia)],
                    author: 'unknown',
                    createdAt: new Date().toISOString(),
                    likeCount: 0,
                    replyCount: 0,
                    url: threadUrl
                });
            }
        }

        // Deduplicate
        const uniqueThreads = [];
        const seenIds = new Set();
        for (const t of threads) {
            if (!seenIds.has(t.id) && t.content) {
                uniqueThreads.push(t);
                seenIds.add(t.id);
            }
        }

        // Try yt-dlp for better media extraction if it's a single thread OR if standard logic missed the media
        if (uniqueThreads.length > 0) {
            const thread = uniqueThreads[0];
            if (!thread.mediaUrls || thread.mediaUrls.length === 0 || thread.mediaUrls.some(u => u.includes('mp4') === false)) {
                // We use yt-dlp to enrich the thread info (although yt-dlp doesn't natively support Threads yet)
                const ytMedia = await extractMediaWithYtDlp(threadUrl);
                if (ytMedia.length > 0) {
                    thread.mediaUrls = [...new Set([...thread.mediaUrls, ...ytMedia])];
                    log('INFO', `Enriched media with yt-dlp for ${threadUrl} (${ytMedia.length} items)`);
                }
            }
        }

        if (uniqueThreads.length === 0) {
           log('WARN', `No threads parsed via HTML JSON. yt-dlp fallback...`);
           // Full yt-dlp fallback if we couldn't parse the thread
           const ytMedia = await extractMediaWithYtDlp(threadUrl);
           if (ytMedia.length > 0) {
               uniqueThreads.push({
                   id: `yt-dlp-${Date.now()}`,
                   content: `(yt-dlp로 수집된 미디어 - ${threadUrl})`,
                   mediaUrls: ytMedia,
                   author: 'unknown',
                   createdAt: new Date().toISOString(),
                   likeCount: 0,
                   replyCount: 0,
                   url: threadUrl
               });
           }
        }

        return { success: true, threads: uniqueThreads.slice(0, 1) };
    } catch (e) {
        log('ERROR', `Scraping URL failed: ${e.message}`);
        return { success: false, message: e.message };
    }
}

/**
 * Extracts high-quality media using yt-dlp
 */
async function extractMediaWithYtDlp(url) {
    try {
        log('INFO', `Running yt-dlp for: ${url}`);
        // Use python -m yt_dlp if yt-dlp is not directly in path
        const cmd = `python -m yt_dlp -j "${url}" --no-warnings --quiet`;
        const { stdout } = await execPromise(cmd);
        if (!stdout) return [];
        
        const data = JSON.parse(stdout);
        const media = [];
        
        // yt-dlp returns the direct media URL in 'url' field for single media
        if (data.url) media.push(data.url);
        
        // For carousel/multi-media, look into entries
        if (data.entries) {
            data.entries.forEach(e => {
                if (e.url) media.push(e.url);
            });
        }
        
        // Fallback for images if video is processed
        if (data.thumbnails && media.length === 0) {
            const bestThumb = data.thumbnails[data.thumbnails.length - 1];
            if (bestThumb?.url) media.push(bestThumb.url);
        }

        return [...new Set(media)];
    } catch (e) {
        // Fallback: try direct yt-dlp command
        try {
            const { stdout } = await execPromise(`yt-dlp -j "${url}" --no-warnings --quiet`);
            const data = JSON.parse(stdout);
            const media = [];
            if (data.url) media.push(data.url);
            if (data.entries) data.entries.forEach(e => { if (e.url) media.push(e.url); });
            return [...new Set(media)];
        } catch (e2) {
            log('WARN', `yt-dlp enrichment failed: ${e2.message}`);
            return [];
        }
    }
}

/**
 * Helper to recursively find thread objects in a deep JSON structure
 */
function extractThreadsFromObject(obj, results) {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
        obj.forEach(item => extractThreadsFromObject(item, results));
        return;
    }

    // Pattern A: standard post object
    if (obj.post && (obj.post.caption || obj.post.text_post_app_info || obj.post.pk)) {
        const post = obj.post;
        results.push({
            id: post.id || post.pk,
            content: post.caption?.text || post.text_post_app_info?.text || '',
            mediaUrls: extractMediaUrls(post),
            author: post.user?.username || post.user?.full_name || 'unknown',
            createdAt: post.taken_at ? new Date(post.taken_at * 1000).toISOString() : null,
            likeCount: post.like_count || 0,
            replyCount: post.reply_count || 0,
            url: `https://www.threads.net/t/${post.code}`
        });
    }
    
    // Pattern B: thread_items list (alternative structure)
    if (obj.thread_items && Array.isArray(obj.thread_items)) {
        obj.thread_items.forEach(item => {
            if (item.post) extractThreadsFromObject({ post: item.post }, results);
        });
    }

    // Pattern C: direct post data if object looks like a post itself
    if (obj.caption && obj.pk && obj.user) {
         results.push({
            id: obj.id || obj.pk,
            content: obj.caption?.text || '',
            mediaUrls: extractMediaUrls(obj),
            author: obj.user.username || 'unknown',
            createdAt: obj.taken_at ? new Date(obj.taken_at * 1000).toISOString() : null,
            likeCount: obj.like_count || 0,
            replyCount: obj.reply_count || 0,
            url: `https://www.threads.net/t/${obj.code}`
        });
    }

    // Recurse
    Object.values(obj).forEach(val => {
        if (val && typeof val === 'object' && !val._visited) {
            // Avoid circular references although rare in this parsed JSON
            val._visited = true;
            extractThreadsFromObject(val, results);
            delete val._visited;
        }
    });
}

function extractMediaUrls(post) {
    const mediaMap = new Map(); // Use map to keep track of unique assets by their ID
    
    // 1. Specific known structures (highest priority/quality)
    const processMediaItem = (item) => {
        if (!item) return;
        
        // Handle image candidates - pick the first one (usually highest res)
        if (item.image_versions2?.candidates?.length > 0) {
            // Prefer candidates that are NOT heic if possible, or have dst-jpg param
            let bestImage = item.image_versions2.candidates.find(c => c.url.includes('dst-jpg'))?.url;
            if (!bestImage) {
                bestImage = item.image_versions2.candidates.find(c => !c.url.toLowerCase().includes('.heic'))?.url;
            }
            if (!bestImage) bestImage = item.image_versions2.candidates[0].url;

            if (bestImage && !bestImage.includes('static.cdninstagram.com')) {
                const assetId = extractAssetId(bestImage);
                if (assetId && !mediaMap.has(assetId)) mediaMap.set(assetId, bestImage);
            }
        }
        
        // Handle video versions - pick the first one
        if (item.video_versions?.length > 0) {
            const bestVideo = item.video_versions[0].url;
            if (bestVideo) {
                const assetId = extractAssetId(bestVideo);
                if (assetId && !mediaMap.has(assetId)) mediaMap.set(assetId, bestVideo);
            }
        }
    };

    processMediaItem(post);
    if (post.carousel_media) {
        post.carousel_media.forEach(processMediaItem);
    }

    // 2. Recursive fallback search for anything missed
    const findUrls = (obj) => {
        if (!obj) return;
        if (typeof obj === 'string') {
            if (obj.match(/^https?:\/\/.*?\.(?:jpg|jpeg|png|webp|gif|mp4|mov)(?:\?.*)?$/i)) {
                if (obj.includes('static.cdninstagram.com')) return;
                if (obj.includes('scontent') || obj.includes('fbcdn.net')) {
                    if (!obj.includes('icon') && !obj.includes('avatar') && !obj.includes('profile')) {
                        const assetId = extractAssetId(obj);
                        if (assetId && !mediaMap.has(assetId)) {
                             // Check if it's likely a thumbnail vs high-res
                             // Smaller variants usually have p150x150 or similar in URL
                             if (!obj.includes('150x150') && !obj.includes('s150x150')) {
                                 mediaMap.set(assetId, obj);
                             }
                        }
                    }
                }
            }
        } else if (Array.isArray(obj)) {
            obj.forEach(findUrls);
        } else if (typeof obj === 'object') {
            Object.values(obj).forEach(findUrls);
        }
    };
    
    findUrls(post);

    return Array.from(mediaMap.values());
}

/**
 * Extracts a unique ID from Meta CDN URLs to identify the same file across different sizes
 */
function extractAssetId(url) {
    try {
        // Meta CDN URLs often have the filename before the query params
        // e.g. .../filename.jpg?_nc_cat=...
        const parts = url.split('?')[0].split('/');
        const filename = parts[parts.length - 1];
        if (filename && filename.includes('_n.')) {
            // High res files often end with _n.jpg
            return filename;
        }
        // Fallback: look for ig_cache_key or other unique params
        const cacheKey = url.match(/ig_cache_key=([^&]+)/);
        if (cacheKey) return cacheKey[1];
        
        return filename || url;
    } catch (e) {
        return url;
    }
}

module.exports = {
    scrapeThreadsByUser,
    scrapeThreadByUrl
};
