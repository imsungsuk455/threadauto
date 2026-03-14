const axios = require('axios');
const cheerio = require('cheerio');
const { v4: uuidv4 } = require('uuid');
const { log, readJSON, writeJSON, PATHS } = require('./utils');

/**
 * Phase 1 — 수집기 (Collector)
 * API 및 경량 파서를 통해 데이터를 수집하고 파이프라인 큐에 적재
 */

// ===== 파이프라인 큐 관리 =====

function loadQueue() {
    return readJSON(PATHS.pipelineQueue) || { items: [] };
}

function saveQueue(data) {
    return writeJSON(PATHS.pipelineQueue, data);
}

function addToQueue(item) {
    const queue = loadQueue();
    queue.items.push(item);
    saveQueue(queue);
    return item;
}

function createQueueItem(type, sourceData, options = {}) {
    return {
        id: uuidv4(),
        type,                               // 'affiliate', 'rss', 'crawl'
        status: 'pending',                  // pending → processed → published / failed
        sourceData,                         // 수집된 원본 데이터
        processedContent: null,             // 가공 후 콘텐츠
        mediaUrls: options.mediaUrls || [], // 미디어 URL 목록
        affiliateLink: options.affiliateLink || null,
        accountId: options.accountId || null,
        retryCount: 0,
        maxRetries: 3,
        errorMessage: null,
        collectedAt: new Date().toISOString(),
        processedAt: null,
        publishedAt: null,
    };
}

/**
 * URL에서 미디어(og:image, video)만 경량 추출하는 공통 모듈 (무거운 크롤링 배제)
 */
async function extractMediaFromHTML(url) {
    if (!url) return [];

    // 뽐뿌 등 일부 사이트의 http -> https 리다이렉트 대응 (Meta Refresh 대응)
    if (url.includes('ppomppu.co.kr') && url.startsWith('http:')) {
        url = url.replace('http:', 'https:');
    }

    try {
        const iconv = require('iconv-lite');
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            timeout: 10000,
            maxRedirects: 3,
            responseType: 'arraybuffer' // EUC-KR 대응을 위해 바이너리로 받음
        });

        // 인코딩 감지 및 디코딩 (뽐뿌 등 EUC-KR 대응)
        const contentType = response.headers['content-type'] || '';
        let html;
        if (contentType.includes('euc-kr') || contentType.includes('ms949')) {
            html = iconv.decode(response.data, 'euc-kr');
        } else {
            html = iconv.decode(response.data, 'utf-8');
            // 만약 유효하지 않은 문자(UTF-8 깨짐)가 많으면 EUC-KR로 재시도 가능
            if (html.includes('') || html.includes('')) {
                const checkEuc = iconv.decode(response.data, 'euc-kr');
                if (checkEuc.includes('이미지') || checkEuc.includes('게시판')) {
                    html = checkEuc;
                }
            }
        }

        const $ = cheerio.load(html);
        const medias = [];

        // 1. SPA(리액트 등) 렌더링된 __PRELOADED_STATE__ (JSON) 추출
        const preloadedMatch = html.match(/window\.__PRELOADED_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/);
        if (preloadedMatch && preloadedMatch[1]) {
            try {
                const state = JSON.parse(preloadedMatch[1]);
                const extractFromObj = (obj) => {
                    if (typeof obj === 'string') {
                        if (obj.match(/^https?:\/\/.*?\.(?:mp4|jpg|jpeg|png|gif|webp)(\?.*)?$/i) ||
                            (obj.includes('phinf.pstatic.net') && obj.length > 20)) {
                            if (!obj.includes('icon') && !obj.includes('logo') && !obj.includes('data-')) {
                                if (!medias.includes(obj)) medias.push(obj);
                            }
                        }
                    } else if (Array.isArray(obj)) {
                        obj.forEach(extractFromObj);
                    } else if (obj !== null && typeof obj === 'object') {
                        Object.values(obj).forEach(extractFromObj);
                    }
                };
                extractFromObj(state);
            } catch (err) { }
        }

        // 2. og:image 추출
        const ogImage = $('meta[property="og:image"]').attr('content');
        if (ogImage && ogImage.startsWith('http')) {
            if (!medias.includes(ogImage)) medias.push(ogImage);
        }

        // 3. 정적 HTML img 태그 (뽐뿌 등 게시판 대응)
        $('img').each((i, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
            if (src && src.length > 20) {
                // 특정 키워드 제외 (UI 요소 등)
                const trash = ['logo', 'icon', 'banner', 'dot.gif', 'dot03.gif', 'lazyloading', 'drag_img', 'thumbsdown', 'sharing_icon', 'bookmark_icon', 'shadow'];
                if (trash.some(t => src.toLowerCase().includes(t))) return;

                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) {
                    const urlObj = new URL(url);
                    src = urlObj.origin + src;
                }

                if (src.startsWith('http') && !medias.includes(src)) {
                    medias.push(src);
                }
            }
        });

        // 4. 비디오 태그
        $('video, source').each((i, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src');
            if (src && !src.startsWith('data:')) {
                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) {
                    const urlObj = new URL(url);
                    src = urlObj.origin + src;
                }
                if (!medias.includes(src)) medias.push(src);
            }
        });

        // 결과 중 비디오(mp4)를 우선순위로 정렬
        medias.sort((a, b) => {
            if (a.includes('.mp4') && !b.includes('.mp4')) return -1;
            if (!a.includes('.mp4') && b.includes('.mp4')) return 1;
            return 0;
        });

        return medias.slice(0, 15);
    } catch (e) {
        log('WARN', `미디어 경량 추출 실패 (${url}): ${e.message}`);
        return [];
    }
}

// ===== 1. 제휴 콘텐츠 수집 (API 방식) =====

/**
 * 쿠팡 파트너스 OpenAPI를 통한 상품 정보 수집
 * @param {Object} params - { keyword, categoryId, limit }
 */
async function collectCoupangProducts({ keyword, categoryId, limit = 5 }) {
    const config = loadPipelineConfig();
    const { coupangAccessKey, coupangSecretKey, coupangPartnerId } = config;

    if (!coupangAccessKey || !coupangSecretKey) {
        // API 키 없으면 URL 기반 크롤링 폴백
        log('WARN', '쿠팡 파트너스 API 키가 없습니다. URL 크롤링으로 대체합니다.');
        return { success: false, message: '쿠팡 파트너스 API 키를 설정해주세요. (파이프라인 설정)' };
    }

    try {
        // 쿠팡 파트너스 API: 상품 검색
        // https://developers.coupangcorp.com/hc/ko/articles/360033977853
        const timestamp = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
        const path = `/v2/providers/affiliate_open_api/apis/openapi/products/search`;
        const query = `keyword=${encodeURIComponent(keyword)}&limit=${limit}`;

        // HMAC 서명 생성
        const crypto = require('crypto');
        const message = `GET\n${timestamp}\n${path}\n${query}`;
        const signature = crypto.createHmac('sha256', coupangSecretKey)
            .update(message).digest('hex');

        const authorization = `CEA algorithm=HmacSHA256, access-key=${coupangAccessKey}, signed-date=${timestamp}, signature=${signature}`;

        const res = await axios.get(`https://api-gateway.coupang.com${path}?${query}`, {
            headers: { Authorization: authorization },
            timeout: 10000,
        });

        const products = (res.data?.data?.productData || []).map(p => ({
            productName: p.productName,
            price: p.productPrice,
            originalPrice: p.originalPrice || p.productPrice,
            imageUrl: p.productImage,
            affiliateLink: p.productUrl,
            rating: p.rating || 0,
            reviewCount: p.reviewCount || 0,
            platform: 'coupang',
        }));

        const items = [];
        for (const product of products) {
            const item = createQueueItem('affiliate', {
                title: product.productName,
                bodyText: `${product.productName} - ${product.price}원`,
                description: `쿠팡 파트너스 상품: ${product.productName}`,
                platform: 'coupang',
                product,
            }, {
                mediaUrls: product.imageUrl ? [product.imageUrl] : [],
                affiliateLink: product.affiliateLink,
            });
            items.push(addToQueue(item));
        }

        log('INFO', `쿠팡 상품 ${items.length}건 수집 완료 (키워드: ${keyword})`);
        return { success: true, count: items.length, items };
    } catch (error) {
        log('ERROR', `쿠팡 API 수집 실패: ${error.message}`);
        return { success: false, message: `쿠팡 API 오류: ${error.message}` };
    }
}

/**
 * 네이버 브랜드커넥트 API를 통한 상품 정보 수집
 * @param {Object} params - { keyword, display }
 */
async function collectNaverProducts({ keyword, display = 5, customLink = null }) {
    const config = loadPipelineConfig();
    const { naverClientId, naverClientSecret } = config;

    if (!naverClientId || !naverClientSecret) {
        log('WARN', '네이버 API 키가 없습니다.');
        return { success: false, message: '네이버 API 키를 설정해주세요. (파이프라인 설정)' };
    }

    try {
        const res = await axios.get('https://openapi.naver.com/v1/search/shop.json', {
            params: { query: keyword, display, sort: 'sim' },
            headers: {
                'X-Naver-Client-Id': naverClientId,
                'X-Naver-Client-Secret': naverClientSecret,
            },
            timeout: 10000,
        });

        const itemsRaw = res.data?.items || [];
        if (itemsRaw.length === 0) {
            log('WARN', `네이버 검색 결과가 없습니다. (키워드: ${keyword})`);
            return { success: false, message: '검색 결과가 없습니다. 키워드를 변경해 보세요.' };
        }

        const products = itemsRaw.map(p => ({
            productName: p.title.replace(/<[^>]*>/g, ''),  // HTML 태그 제거
            price: parseInt(p.lprice) || 0,
            imageUrl: p.image,
            affiliateLink: customLink || p.link, // customLink가 있으면 쇼핑 제휴 링크 대신 사용 (매우 중요)
            naverDetailUrl: p.link, // 심층 수집을 위한 원본 상세 페이지 주소
            mallName: p.mallName,
            category: p.category1,
            platform: 'naver',
        }));

        const items = [];
        for (const product of products) {
            let finalMedia = [product.imageUrl];

            // 1. 상세 페이지(링크)에서 추가 미디어 경량 추출 (og:image / 동영상 위주)
            let extraMedias = [];
            if (product.naverDetailUrl) {
                extraMedias = await extractMediaFromHTML(product.naverDetailUrl);
                for (const em of extraMedias) {
                    if (finalMedia.length >= 5) break;
                    if (!finalMedia.includes(em)) finalMedia.push(em);
                }
            }

            // 1-2. 보호 시스템(Bot Block 490/429)으로 인해 미디어를 전혀 못 가져왔을 경우 대비
            // 가볍고 안전한 네이버 이미지 검색 API(OpenAPI)를 활용하여 추가 상품 이미지를 확보합니다.
            if (finalMedia.length < 5) {
                try {
                    const imgRes = await axios.get('https://openapi.naver.com/v1/search/image.json', {
                        params: { query: product.productName, display: 5, sort: 'sim', filter: 'large' },
                        headers: {
                            'X-Naver-Client-Id': naverClientId,
                            'X-Naver-Client-Secret': naverClientSecret,
                        },
                        timeout: 5000,
                    });

                    const imgItems = imgRes.data?.items || [];
                    for (const img of imgItems) {
                        if (finalMedia.length >= 5) break;
                        if (img.link && !finalMedia.includes(img.link)) {
                            finalMedia.push(img.link);
                        }
                    }
                    log('INFO', `이미지 API 캐치 성공 (추가된 미디어 개수: ${finalMedia.length})`);
                } catch (imgError) {
                    log('WARN', `이미지 백업 검색 실패: ${imgError.message}`);
                }
            }

            // 2. 그래도 5장이 안 되면, 검색된 다른 유사 상품 이미지로 채우기 (최후의 수단)
            for (const other of products) {
                if (finalMedia.length >= 5) break;
                if (other.imageUrl && !finalMedia.includes(other.imageUrl)) {
                    finalMedia.push(other.imageUrl);
                }
            }

            const item = createQueueItem('affiliate', {
                title: product.productName,
                bodyText: `${product.productName} - ${product.price}원 (${product.mallName})`,
                description: `네이버 쇼핑: ${product.productName}`,
                platform: 'naver',
                product,
            }, {
                mediaUrls: finalMedia,
                affiliateLink: product.affiliateLink,
            });
            items.push(addToQueue(item));
        }

        log('INFO', `네이버 상품 ${items.length}건 수집 완료 (키워드: ${keyword})`);
        return { success: true, count: items.length, items };
    } catch (error) {
        let errorDetail = error.message;
        if (error.response && error.response.data) {
            errorDetail += ` - 상세: ${JSON.stringify(error.response.data)}`;
        }
        log('ERROR', `네이버 API 수집 실패: ${errorDetail}`);
        return { success: false, message: `네이버 API 오류: ${errorDetail}` };
    }
}

/**
 * 네이버 뉴스/블로그 검색 API를 통한 정보 수집
 * @param {Object} params - { keyword, display, type: 'news'|'blog' }
 */
async function collectNaverSearch({ keyword, display = 5, type = 'news' }) {
    const config = loadPipelineConfig();
    const { naverClientId, naverClientSecret } = config;

    if (!naverClientId || !naverClientSecret) {
        return { success: false, message: '네이버 API 키를 설정해주세요.' };
    }

    try {
        const endpoint = `https://openapi.naver.com/v1/search/${type}.json`;
        const res = await axios.get(endpoint, {
            params: { query: keyword, display, sort: 'sim' },
            headers: {
                'X-Naver-Client-Id': naverClientId,
                'X-Naver-Client-Secret': naverClientSecret,
            },
            timeout: 10000,
        });

        const itemsRaw = res.data?.items || [];
        const items = [];

        for (const raw of itemsRaw) {
            const title = raw.title.replace(/<[^>]*>/g, '').trim();
            const description = raw.description.replace(/<[^>]*>/g, '').trim();
            const link = raw.link;

            // 상세 페이지에서 이미지 추출 시도 (크롤링 병행)
            let mediaUrls = [];
            try {
                const aiGen = require('./ai-generator');
                const crawlRes = await aiGen.crawlUrl(link);
                if (crawlRes.success && crawlRes.data.images) {
                    // 고해상도 이미지 필터링 등 필요시 추가 가능
                    mediaUrls = crawlRes.data.images.map(img => img.src).slice(0, 5);
                }
            } catch (e) {
                log('WARN', `상세 페이지 미디어 추출 실패: ${link}`);
            }

            // 이미지가 부족하면 이미지 검색으로 보충
            if (mediaUrls.length === 0) {
                try {
                    const aiGen = require('./ai-generator');
                    const imgSearch = await aiGen.searchProductMedia('naver-image', title.substring(0, 20));
                    if (imgSearch.success && imgSearch.media) {
                        mediaUrls = imgSearch.media.map(m => m.src).slice(0, 5);
                    }
                } catch (e) { }
            }

            const item = createQueueItem(type === 'news' ? 'rss' : 'crawl', {
                title,
                bodyText: description,
                description,
                sourceUrl: link,
                platform: 'naver-search',
            }, { mediaUrls });

            items.push(addToQueue(item));
        }

        log('INFO', `네이버 ${type} ${items.length}건 수집 완료 (키워드: ${keyword})`);
        return { success: true, count: items.length, items };
    } catch (error) {
        log('ERROR', `네이버 ${type} 검색 실패: ${error.message}`);
        return { success: false, message: `네이버 검색 오류: ${error.message}` };
    }
}

// ===== 2. RSS 피드 수집 =====

/**
 * RSS 피드에서 최신 글을 수집하여 큐에 적재
 * @param {Object} params - { feedUrl, limit }
 */
async function collectFromRSS({ feedUrl, limit = 10 }) {
    log('INFO', `RSS 피드 수집 시작: ${feedUrl}`);

    try {
        const axios = require('axios');
        const Parser = require('rss-parser');
        const parser = new Parser({
            timeout: 15000,
        });

        // 1. Axios로 먼저 XML 데이터 가져오기 (400, 404 방지 및 헤더 설정)
        const response = await axios.get(feedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            timeout: 10000,
            validateStatus: (status) => status < 500 // 404 등도 일단 받아서 로그 확인
        });

        if (response.status !== 200) {
            throw new Error(`Status code ${response.status}`);
        }

        let xmlData = response.data;

        // MBC 등 일부 언론사에서 RSS 대신 일반웹페이지(HTML 오류페이지)를 반환하는 경우 차단
        if (typeof xmlData === 'string' && (xmlData.trim().toLowerCase().startsWith('<!doctype html') || xmlData.trim().toLowerCase().startsWith('<html'))) {
            throw new Error('RSS 피드가 아닌 일반 웹페이지(HTML)가 반환되었습니다. 해당 언론사에서 RSS 지원을 중단했거나 접근을 차단했을 수 있습니다.');
        }

        // 2. XML 정리: 문법 오류 및 인코딩 보정
        if (typeof xmlData === 'string') {
            // 한글 깨짐 방지: XML 선언에서 encoding="euc-kr"을 utf-8로 강제 변경 (이미 axios가 utf8로 가져왔을 가능성 대비)
            xmlData = xmlData.replace(/encoding=["']euc-kr["']/i, 'encoding="utf-8"');

            // 1) 제어 문자 제거 (파싱 방해 요소)
            xmlData = xmlData.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

            // 2) 값이 없는 속성 보정 (예: <img ... disabled > -> disabled="")
            xmlData = xmlData.replace(/<([a-zA-Z0-9:]+)([^>]*)\s+([a-zA-Z0-9_-]+)(?=\s|>)/g, (match, tag, before, attr) => {
                const fullMatch = match.trim();
                if (!fullMatch.includes(`${attr}=`)) {
                    return `<${tag}${before} ${attr}=""`;
                }
                return match;
            });

            // 3) 잘못된 종료 태그 보정 (예: </br>, </hr> -> <br/>, <hr/>)
            xmlData = xmlData.replace(/<\/br>/gi, '<br/>').replace(/<\/hr>/gi, '<hr/>');

            // 4) HTML 특수문자가 XML 태그와 혼동되는 경우 방지 (CDATA 영역 밖의 & 보정)
            // 주의: 모든 &를 보정하면 안되므로 XML 엔티티를 제외한 &만 보정
            xmlData = xmlData.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[a-fA-F0-9]+);)/g, '&amp;');
        }

        const feed = await parser.parseString(xmlData);
        const entries = (feed.items || []).slice(0, limit);

        if (entries.length === 0) {
            return { success: false, message: 'RSS 피드에서 항목을 찾을 수 없습니다.' };
        }

        const items = [];
        for (const entry of entries) {
            // 본문에서 이미지 URL 추출 (있을 경우)
            let mediaUrls = [];
            if (entry.enclosure && entry.enclosure.url) {
                mediaUrls.push(entry.enclosure.url);
            }
            // 2. content에서 이미지 추출 (정교한 필터링 및 중복 제거)
            const content = entry['content:encoded'] || entry.content || entry.summary || '';
            const imgMatches = content.match(/<img[^>]+src=["']([^"']+)["']/gi) || [];

            // 중복 체크 도우미 함수 (파일명 기반)
            const getFilename = (u) => {
                if (!u) return '';
                try {
                    const parts = u.split('/');
                    const lastPart = parts[parts.length - 1];
                    return lastPart.split('?')[0].split('#')[0].toLowerCase();
                } catch (e) { return u; }
            };

            for (const match of imgMatches) {
                let src = match.match(/src=["']([^"']+)["']/i)?.[1];
                if (!src || src.includes('data:image')) continue;
                if (mediaUrls.length >= 5) break;

                const newFn = getFilename(src);
                const isDuplicate = mediaUrls.some(existing => getFilename(existing) === newFn);
                const isInvalid = /logo|icon|banner|button|footer|header|ad-|spacer|pixel/i.test(src);

                if (!isInvalid && !isDuplicate && newFn.length > 3) {
                    mediaUrls.push(src);
                }
            }

            // [심화] 이미지가 부족하거나 더 다양한 선택지를 위해 네이버 이미지 검색(OpenAPI) 보충
            if (mediaUrls.length < 5 && entry.title) {
                try {
                    const aiGenerator = require('./ai-generator');
                    // 제목에서 불필요한 관용구 제거하여 검색 정확도 향상
                    const cleanTitle = entry.title.replace(/\[.*?\]/g, '').replace(/[^\w\s가-힣]/g, ' ').trim();
                    const searchQuery = cleanTitle.substring(0, 30);

                    log('INFO', `RSS 이미지 보충(Naver API): ${searchQuery}`);

                    // 업데이트된 ai-generator의 naver-image (공식 API) 호출
                    const searchRes = await aiGenerator.searchProductMedia('naver-image', searchQuery);

                    if (searchRes.success && searchRes.media) {
                        for (const m of searchRes.media) {
                            if (mediaUrls.length >= 5) break;
                            const newFn = getFilename(m.src);
                            // 기존 이미지들과 파일명 중복 체크
                            if (!mediaUrls.some(existing => getFilename(existing) === newFn)) {
                                mediaUrls.push(m.src);
                            }
                        }
                    }
                } catch (err) {
                    log('WARN', `이미지 보충 검색 중 오류: ${err.message}`);
                }
            }

            // HTML 태그 제거하여 텍스트 추출
            const bodyText = content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 3000);
            const sourceUrl = entry.link || feedUrl;

            const item = createQueueItem('rss', {
                title: entry.title || '',
                bodyText,
                description: entry.contentSnippet || entry.summary || '',
                sourceUrl,
                pubDate: entry.pubDate || entry.isoDate || null,
                author: entry.creator || entry.author || '',
                feedTitle: feed.title || '',
            }, { mediaUrls });

            items.push(addToQueue(item));
        }

        log('INFO', `RSS 피드 ${items.length}건 수집 완료: ${feed.title || feedUrl}`);
        return { success: true, count: items.length, feedTitle: feed.title || '', items };
    } catch (error) {
        log('ERROR', `RSS 수집 실패: ${error.message}`);
        return { success: false, message: `RSS 수집 오류: ${error.message}` };
    }
}

// ===== 3. 경량 HTML 파싱 (크롤링 대체) =====

/**
 * URL에서 텍스트와 미디어 링크만 경량 추출 (cheerio 사용)
 * 기존 crawlUrl 에서 유지하되 최적화
 * @param {Object} params - { url }
 */
async function collectFromUrl({ url }) {
    log('INFO', `URL 수집 시작: ${url}`);

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            },
            timeout: 15000,
            maxRedirects: 5,
            // 메모리 효율: 큰 바이너리 응답 방지
            maxContentLength: 5 * 1024 * 1024,
        });

        const $ = cheerio.load(response.data);

        // 불필요한 요소 제거
        $('script, style, nav, footer, header, iframe, noscript, .ads, .advertisement').remove();

        // 1. 메타 정보 추출 (가장 정확한 경우가 많음)
        const ogTitle = $('meta[property="og:title"]').attr('content');
        const ogDesc = $('meta[property="og:description"]').attr('content');
        const ogImage = $('meta[property="og:image"]').attr('content');
        const metaDesc = $('meta[name="description"]').attr('content');

        // 2. 제목 추출 순서 최적화
        let title = ogTitle ||
            $('title').text().trim() ||
            $('h1').first().text().trim() || '';

        // "네이버 : 로그인" 등 불필요한 타이틀 제거
        if (title.includes('로그인') && ogTitle) title = ogTitle;

        // 3. 본문 추출 (본문이 비어있으면 메타 설명으로 대체)
        let bodyRaw = '';
        const articleEl = $('article').first();
        if (articleEl.length) bodyRaw = articleEl.text();
        else if ($('main').first().length) bodyRaw = $('main').first().text();
        else {
            // 특정 클래스나 아이디 우선 검색 (네이버 등 대응)
            bodyRaw = $('.article_body, .se-viewer, .se-main-container, #content, #main-content').text() || $('body').text();
        }

        let bodyText = bodyRaw.replace(/\s+/g, ' ').trim();

        // 중요: 본문이 너무 짧거나 없는 경우 메타 설명을 본문으로 사용 (브랜드커넥트 등 렌더링 페이지 대응)
        if (bodyText.length < 50) {
            bodyText = ogDesc || metaDesc || bodyText;
        }
        bodyText = bodyText.substring(0, 3000);

        // 4. 이미지 추출 (최대 10개) - 강화된 헬퍼 사용
        let mediaUrls = await extractMediaFromHTML(url);

        // 검색 기반 이미지 보충 (부족하거나 다양성을 원할 경우)
        if (mediaUrls.length < 6 && title) {
            try {
                const aiGenerator = require('./ai-generator');
                const cleanTitle = title.replace(/\[.*?\]/g, '').replace(/[^\w\s가-힣]/g, ' ').trim();
                const searchQuery = cleanTitle.substring(0, 25);

                log('INFO', `URL 수집 이미지 보충 검색(다양성 확보): ${searchQuery}`);

                // Naver-style DDG 검색 (실제 리뷰 사진 위주)
                const searchRes = await aiGenerator.searchProductMedia('naver-image', searchQuery);
                if (searchRes.success && searchRes.media) {
                    searchRes.media.forEach(m => {
                        if (mediaUrls.length < 5 && !mediaUrls.some(existing => existing.includes(m.src.split('/').pop().split('?')[0]))) {
                            mediaUrls.push(m.src);
                        }
                    });
                }
            } catch (err) { }
        }

        const item = createQueueItem('crawl', {
            title: title || '수집된 콘텐츠',
            bodyText,
            description: ogDesc || metaDesc || '',
            sourceUrl: url,
        }, { mediaUrls });

        // 5. 하이브리드 수집 (네이버 쇼핑 연동 강화)
        // 네이버 브랜드커넥트나 상품 판매 페이지인 경우, 제목으로 쇼핑 검색을 수행하여 더 정확한 정보를 가져옴
        if (title && (url.includes('naver') || url.includes('brandconnect'))) {
            log('INFO', `네이버 쇼핑 API를 통한 데이터 강화 시도: ${title}`);
            const config = loadPipelineConfig();
            if (config.naverClientId && config.naverClientSecret) {
                try {
                    const searchRes = await axios.get('https://openapi.naver.com/v1/search/shop.json', {
                        params: { query: title, display: 1, sort: 'sim' },
                        headers: {
                            'X-Naver-Client-Id': config.naverClientId,
                            'X-Naver-Client-Secret': config.naverClientSecret,
                        },
                        timeout: 5000,
                    });

                    const shopItem = searchRes.data?.items?.[0];
                    if (shopItem) {
                        const cleanShopTitle = shopItem.title.replace(/<[^>]*>/g, '');
                        log('INFO', `쇼핑 API 데이터로 강화됨: ${cleanShopTitle}`);

                        // 기존 데이터 교체 (쇼핑 API 데이터가 훨씬 깨끗함)
                        item.sourceData.title = cleanShopTitle;
                        item.sourceData.price = parseInt(shopItem.lprice) || 0;
                        item.sourceData.mallName = shopItem.mallName;

                        // 원본 링크는 사용자가 준 브랜드커넥트 링크로 유지 (매우 중요)
                        item.affiliateLink = url;

                        // 이미지가 부족하거나 화질이 구릴 수 있으므로 쇼핑 API 이미지 추가
                        if (shopItem.image && !item.mediaUrls.includes(shopItem.image)) {
                            item.mediaUrls.unshift(shopItem.image); // 최상단에 추가
                        }
                    }
                } catch (err) {
                    log('WARN', `쇼핑 데이터 강화 중 오류 (무시하고 진행): ${err.message}`);
                }
            }
        }

        const saved = addToQueue(item);
        log('INFO', `URL 수집 완료: 제목="${item.sourceData.title}", 본문=${bodyText.length}자, 미디어=${item.mediaUrls.length}개`);
        return { success: true, item: saved };
    } catch (error) {
        log('ERROR', `URL 수집 실패: ${error.message}`);
        return { success: false, message: `URL 수집 오류: ${error.message}` };
    }
}

// ===== 파이프라인 설정 =====

function loadPipelineConfig() {
    return readJSON(PATHS.pipelineConfig) || {
        coupangAccessKey: '',
        coupangSecretKey: '',
        coupangPartnerId: '',
        naverClientId: '',
        naverClientSecret: '',
        defaultRssFeeds: [],
        savedRssFeeds: [],
        savedThreadsAccounts: [],
        savedTiktokAccounts: [],
    };
}

function savePipelineConfig(config) {
    return writeJSON(PATHS.pipelineConfig, config);
}

/**
 * HTML 본문에서 고화질 미디어 URL들을 추출하는 헬퍼 함수
 */
async function extractMediaFromHTML(url) {
    try {
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            timeout: 10000
        });
        const $ = cheerio.load(response.data);
        const medias = [];

        // 1. OG 이미지 우선
        const ogImg = $('meta[property="og:image"]').attr('content');
        if (ogImg) medias.push(ogImg);

        // 2. 본문 이미지 정밀 파싱
        $('.article_body img, .se-main-container img, article img, main img').each((i, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';
            if (src && src.length > 20 && !src.includes('data:image') && !src.includes('icon')) {
                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) {
                    try {
                        const u = new URL(url);
                        src = u.origin + src;
                    } catch (e) { }
                }

                // 고해상도 변환 (특정 플랫폼 대응)
                if (src.includes('post-phinf.pstatic.net')) { // 네이버 블로그
                    src = src.split('?')[0] + '?type=w1600';
                }

                if (!medias.includes(src)) medias.push(src);
            }
        });

        const isDuplicate = (newUrl, list) => {
            const getFilename = (u) => u.split('/').pop().split('?')[0].split('#')[0];
            const newFn = getFilename(newUrl);
            if (!newFn || newFn.length < 4) return true;
            return list.some(existing => getFilename(existing) === newFn);
        };
        const isInvalid = (u) => /logo|icon|banner|button|footer|header|ad-|spacer|pixel/i.test(u);

        // 3. 만약 여전히 부족하면 전체 img 태그 뒤지기
        if (medias.length < 5) {
            $('img').each((i, el) => {
                if (medias.length >= 10) return false;
                let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || '';

                if (src && src.length > 30 && !isInvalid(src)) {
                    if (src.startsWith('//')) src = 'https:' + src;
                    else if (src.startsWith('/')) {
                        try {
                            const u = new URL(url);
                            src = u.origin + src;
                        } catch (e) { }
                    }

                    if (!isDuplicate(src, medias)) {
                        medias.push(src);
                    }
                }
            });
        }

        return medias;
    } catch (e) {
        log('WARN', `미디어 추출 실패 (${url}): ${e.message}`);
        return [];
    }
}

// ===== 큐 조회 함수 =====

function getQueueItems(status = null) {
    const queue = loadQueue();
    if (!status) return queue.items;
    return queue.items.filter(item => item.status === status);
}

function getQueueItem(id) {
    const queue = loadQueue();
    return queue.items.find(item => item.id === id) || null;
}

function updateQueueItem(id, updates) {
    const queue = loadQueue();
    const idx = queue.items.findIndex(item => item.id === id);
    if (idx === -1) return null;
    queue.items[idx] = { ...queue.items[idx], ...updates };
    saveQueue(queue);
    return queue.items[idx];
}

function deleteQueueItem(id) {
    const queue = loadQueue();
    const idx = queue.items.findIndex(item => item.id === id);
    if (idx === -1) return false;
    queue.items.splice(idx, 1);
    saveQueue(queue);
    return true;
}

function clearQueue(status = null) {
    let queue = loadQueue();
    if (status) {
        queue.items = queue.items.filter(item => item.status !== status);
    } else {
        queue.items = [];
    }
    saveQueue(queue);
    return true;
}

function getQueueStats() {
    const items = getQueueItems();
    return {
        total: items.length,
        pending: items.filter(i => i.status === 'pending').length,
        processed: items.filter(i => i.status === 'processed').length,
        published: items.filter(i => i.status === 'published').length,
        failed: items.filter(i => i.status === 'failed').length,
    };
}

module.exports = {
    // 수집 함수
    collectCoupangProducts,
    collectNaverProducts,
    collectFromRSS,
    collectFromUrl,
    // 큐 관리
    loadQueue, saveQueue, addToQueue, createQueueItem,
    getQueueItems, getQueueItem, updateQueueItem, deleteQueueItem, clearQueue,
    getQueueStats,
    // 설정
    loadPipelineConfig, savePipelineConfig,
};
