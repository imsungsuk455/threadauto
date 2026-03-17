const express = require('express');
const multer = require('multer');
const path = require('path');
const accounts = require('../src/accounts');
const auth = require('../src/auth');
const { uploadPost, getHistory, replyToThread } = require('../src/uploader');
const scheduler = require('../src/scheduler');
const tester = require('../src/tester');
const aiGen = require('../src/ai-generator');
const pipeline = require('../src/pipeline');
const collector = require('../src/collector');
const threadsScraper = require('../src/threads-scraper');
const tiktokScraper = require('../src/tiktok-scraper');
const { retryFailedItem } = require('../src/publisher');
const { log } = require('../src/utils');



const router = express.Router();

// 파일 업로드 설정
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// ===== 계정 API =====
router.get('/accounts', (req, res) => {
    try {
        const accs = accounts.getAccounts();
        res.json({ success: true, accounts: accs });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/accounts', async (req, res) => {
    try {
        const { accessToken } = req.body;
        if (!accessToken) return res.status(400).json({ success: false, message: 'Access Token 필수' });

        const tokenRes = await auth.verifyAccessToken(accessToken);
        if (!tokenRes.success) {
            return res.status(400).json({ success: false, message: tokenRes.message });
        }

        const result = accounts.addAccount(tokenRes.threadsUserId, tokenRes.username, tokenRes.displayName, accessToken);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/accounts/:id', (req, res) => {
    try {
        const result = accounts.deleteAccount(req.params.id);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 계정 테스트
router.post('/accounts/:id/test', async (req, res) => {
    try {
        const account = accounts.getAccount(req.params.id);
        if (!account) return res.status(404).json({ success: false, message: '계정 없음' });

        const result = await tester.testAccount(req.params.id);

        if (result.overall === 'pass') {
            accounts.updateAccount(req.params.id, { status: 'active' });
        } else if (result.overall === 'session_expired') {
            accounts.updateAccount(req.params.id, { status: 'expired' });
        }

        res.json({ success: true, result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== 업로드 API =====
router.post('/upload', upload.array('image'), async (req, res) => {
    try {
        const { accountId, content, imageUrl, replyContent } = req.body;
        if (!accountId || !content) {
            return res.status(400).json({ success: false, message: 'accountId와 content 필수' });
        }

        let mediaList = [];
        if (req.files && req.files.length > 0) {
            req.files.forEach(f => mediaList.push(f.path));
        }

        if (imageUrl) {
            const urls = typeof imageUrl === 'string' ? imageUrl.split(',').map(u => u.trim()).filter(u => u) : (Array.isArray(imageUrl) ? imageUrl : [imageUrl]);
            mediaList = mediaList.concat(urls);
        }

        const imagePath = mediaList.length > 1 ? mediaList : (mediaList[0] || null);
        const result = await uploadPost(accountId, content, imagePath);

        // 추가: 댓글 링크가 요청된 경우 실행
        if (result.success && result.mediaId && replyContent) {
            await replyToThread(accountId, result.mediaId, replyContent);
        }

        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== 히스토리 API =====
router.get('/history', (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const history = getHistory(limit);
        res.json({ success: true, history });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== 예약 API =====
router.get('/schedules', (req, res) => {
    try {
        const schedules = scheduler.getSchedules();
        res.json({ success: true, schedules });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/schedules', upload.array('image'), async (req, res) => {
    try {
        const data = { ...req.body };
        
        // 미디어 파일 처리
        let mediaList = [];
        if (req.files && req.files.length > 0) {
            req.files.forEach(f => mediaList.push(f.path));
        }

        if (req.body.imageUrl) {
            const urls = typeof req.body.imageUrl === 'string' 
                ? req.body.imageUrl.split(',').map(u => u.trim()).filter(u => u) 
                : (Array.isArray(req.body.imageUrl) ? req.body.imageUrl : [req.body.imageUrl]);
            mediaList = mediaList.concat(urls);
        }

        if (mediaList.length > 0) {
            data.imagePath = mediaList.length > 1 ? mediaList : mediaList[0];
        }

        const result = await scheduler.addSchedule(data);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/schedules/:id', (req, res) => {
    try {
        const result = scheduler.deleteSchedule(req.params.id);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== AI 공통 설정 API =====
router.get('/ai/config', (req, res) => {
    try {
        const config = aiGen.loadAIConfig();
        const masked = { ...config };
        if (masked.apiKey) {
            masked.apiKey = masked.apiKey.substring(0, 6) + '...' + masked.apiKey.substring(masked.apiKey.length - 4);
            masked.hasApiKey = true;
        } else {
            masked.hasApiKey = false;
        }
        res.json({ success: true, config: masked });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/config', (req, res) => {
    try {
        const { apiKey, model } = req.body;
        if (apiKey) aiGen.setApiKey(apiKey);
        if (model) {
            const config = aiGen.loadAIConfig();
            config.model = model;
            aiGen.saveAIConfig(config);
        }
        res.json({ success: true, message: 'AI 설정 저장 완료' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== AI 일반 생성 API =====
router.post('/ai/generate', async (req, res) => {
    try {
        const result = await aiGen.generateContent(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/variations', async (req, res) => {
    try {
        const result = await aiGen.generateVariations(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/ai/templates', (req, res) => {
    try {
        const templates = aiGen.getTemplates();
        res.json({ success: true, templates });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== AI 브랜드 모드 API =====
router.get('/ai/brand/personas', (req, res) => {
    try {
        const personas = aiGen.getPersonas();
        res.json({ success: true, personas });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/brand/personas', (req, res) => {
    try {
        const result = aiGen.addPersona(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/brand/personas/learn', async (req, res) => {
    try {
        const result = await aiGen.learnPersonaFromUrl(req.body.url);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.put('/ai/brand/personas/:id', (req, res) => {
    try {
        const result = aiGen.updatePersona(req.params.id, req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/ai/brand/personas/:id', (req, res) => {
    try {
        const result = aiGen.deletePersona(req.params.id);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/brand/generate', async (req, res) => {
    try {
        const result = await aiGen.generateBrandContent(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== AI 제휴마케팅 모드 API =====
router.get('/ai/affiliate/list', (req, res) => {
    try {
        const affiliates = aiGen.getAffiliates();
        res.json({ success: true, affiliates });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/affiliate/add', (req, res) => {
    try {
        const result = aiGen.addAffiliate(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/ai/affiliate/:id', (req, res) => {
    try {
        const result = aiGen.deleteAffiliate(req.params.id);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/affiliate/generate', async (req, res) => {
    try {
        const result = await aiGen.generateAffiliateContent(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 상품 URL 분석 (제휴 자동 등록용)
router.post('/ai/affiliate/crawl', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ success: false, message: 'URL 필수' });
        const result = await aiGen.crawlUrl(url);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 관련 미디어 검색 (Ali/Temu/1688)
router.post('/ai/affiliate/search-media', async (req, res) => {
    try {
        const { platform, query } = req.body;
        if (!platform || !query) return res.status(400).json({ success: false, message: '플랫폼과 검색어 필수' });
        const result = await aiGen.searchProductMedia(platform, query);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/affiliate/post', async (req, res) => {
    try {
        const { accountId, content, affiliateLink, linkText } = req.body;
        if (!accountId || !content) {
            return res.status(400).json({ success: false, message: 'accountId와 content 필수' });
        }

        // 1. 본문 게시
        const uploadResult = await uploadPost(accountId, content);
        if (!uploadResult.success) return res.json(uploadResult);

        // 2. 댓글에 링크 달기
        let replyResult = null;
        if (affiliateLink && uploadResult.mediaId) {
            const commentText = linkText || `🔗 ${affiliateLink}`;
            replyResult = await replyToThread(accountId, uploadResult.mediaId, commentText);
        }

        res.json({
            success: true,
            message: replyResult?.success
                ? '게시 + 댓글 링크 완료! 🎉'
                : '게시 완료! (댓글 링크 실패)',
            uploadResult,
            replyResult,
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== AI 크롤링 모드 API =====
router.post('/ai/crawl', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ success: false, message: 'URL을 입력하세요' });
        const result = await aiGen.crawlUrl(url);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/ai/crawl/generate', async (req, res) => {
    try {
        const result = await aiGen.crawlAndGenerate(req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== AI 자동 콘텐츠 생성 (파이프라인) API =====
router.get('/pipeline/status', (req, res) => {
    try {
        res.json({ success: true, ...pipeline.getStatus() });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/pipeline/queue', (req, res) => {
    try {
        const status = req.query.status || null;
        const items = collector.getQueueItems(status);
        res.json({ success: true, items });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/pipeline/queue', (req, res) => {
    try {
        const status = req.query.status || null;
        collector.clearQueue(status);
        res.json({ success: true, message: '대기열이 정리되었습니다.' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.delete('/pipeline/queue/:id', (req, res) => {
    try {
        const success = collector.deleteQueueItem(req.params.id);
        res.json({ success });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/pipeline/collect', async (req, res) => {
    try {
        const result = await pipeline.runCollect(req.body);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/pipeline/process-item/:id', async (req, res) => {
    try {
        const result = await pipeline.processItem(req.params.id, req.body);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/pipeline/process', async (req, res) => {
    try {
        const result = await pipeline.runProcess(req.body);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/pipeline/publish', async (req, res) => {
    try {
        const result = await pipeline.runPublish(req.body.accountId);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/pipeline/run', async (req, res) => {
    try {
        const result = await pipeline.runFull(req.body);
        res.json({ success: true, ...result });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/pipeline/retry/:id', async (req, res) => {
    try {
        const result = await retryFailedItem(req.params.id, req.body.accountId);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.get('/pipeline/config', (req, res) => {
    try {
        const config = collector.loadPipelineConfig();
        // 비밀번호 마스킹
        const masked = { ...config };
        if (masked.coupangSecretKey) masked.coupangSecretKey = '********';
        if (masked.naverClientSecret) masked.naverClientSecret = '********';
        res.json({ success: true, config: masked });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/pipeline/config', (req, res) => {
    try {
        const oldConfig = collector.loadPipelineConfig();
        const newConfig = { ...oldConfig, ...req.body };

        // 마스킹된 값이 오면 기존값 유지
        if (req.body.coupangSecretKey === '********') newConfig.coupangSecretKey = oldConfig.coupangSecretKey;
        if (req.body.naverClientSecret === '********') newConfig.naverClientSecret = oldConfig.naverClientSecret;

        collector.savePipelineConfig(newConfig);
        res.json({ success: true, message: '설정 저장 완료' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== 미디어 검색 API =====
router.get('/search-media', async (req, res) => {
    try {
        const { platform, query } = req.query;
        if (!platform || !query) return res.status(400).json({ success: false, message: 'platform, query 필수' });

        const aiGenerator = require('../src/ai-generator');
        const result = await aiGenerator.searchProductMedia(platform, query);
        res.json(result);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== 이미지 프록시 (CORS 썸네일 방지) =====
router.get('/proxy-image', async (req, res) => {
    try {
        const { url } = req.query;
        if (!url) return res.status(400).send('URL 필수');

        const axios = require('axios');
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        res.set('Content-Type', response.headers['content-type']);
        response.data.pipe(res);
    } catch (e) {
        res.status(500).send('프록시 오류');
    }
});

// ===== Meta API 콜백 (설정용) =====
router.get('/callback/deauth', (req, res) => {
    log('INFO', 'Meta 서비스 제거 콜백 수신');
    res.json({ status: 'ok' });
});

router.get('/callback/delete', (req, res) => {
    log('INFO', 'Meta 데이터 삭제 요청 콜백 수신');
    res.json({ status: 'ok', url: 'http://localhost:3000/' });
});

// ===== Threads Scraper API =====
router.post('/threads/scrape', async (req, res) => {
    try {
        const { type, input, limit } = req.body;
        if (!input) return res.status(400).json({ success: false, message: '입력값이 필요합니다' });

        let result;
        if (type === 'user') {
            result = await threadsScraper.scrapeThreadsByUser(input.replace('@', ''), limit);
        } else if (type === 'url') {
            result = await threadsScraper.scrapeThreadByUrl(input);
        } else {
            return res.status(400).json({ success: false, message: '지원하지 않는 수집 유형입니다' });
        }

        res.json(result);
    } catch (e) {
        log('ERROR', `Threads scrape API error: ${e.message}`);
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/threads/add-to-queue', async (req, res) => {
    try {
        const { thread } = req.body;
        if (!thread) return res.status(400).json({ success: false, message: '스레드 데이터가 없습니다' });

        const item = collector.createQueueItem('crawl', {
            title: `Threads: @${thread.author}`,
            bodyText: thread.content,
            description: `Threads 게시물 수집 (${thread.url})`,
            sourceUrl: thread.url,
            author: thread.author,
            platform: 'threads'
        }, {
            mediaUrls: thread.mediaUrls || []
        });

        collector.addToQueue(item);
        res.json({ success: true, message: '대기열에 추가되었습니다' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// ===== TikTok Scraper API =====
router.post('/tiktok/scrape', async (req, res) => {
    try {
        const { type, input, limit } = req.body;
        if (!input) return res.status(400).json({ success: false, message: '입력값이 필요합니다' });

        let result;
        if (type === 'user') {
            result = await tiktokScraper.scrapeTiktokByUser(input.replace('@', ''), limit);
        } else if (type === 'url') {
            result = await tiktokScraper.scrapeTiktokByUrl(input);
        } else {
            return res.status(400).json({ success: false, message: '지원하지 않는 타입입니다' });
        }

        res.json(result);
    } catch (e) {
        log('ERROR', `TikTok scrape API error: ${e.message}`);
        res.status(500).json({ success: false, message: e.message });
    }
});

router.post('/tiktok/add-to-queue', async (req, res) => {
    try {
        const { video } = req.body;
        if (!video) return res.status(400).json({ success: false, message: '비디오 데이터가 없습니다' });

        const item = collector.createQueueItem('crawl', {
            title: `TikTok: @${video.author}`,
            bodyText: video.content,
            description: `TikTok 게시물 크롤링 (${video.url})`,
            sourceUrl: video.url,
            author: video.author,
            platform: 'tiktok'
        }, {
            mediaUrls: video.mediaUrls || []
        });

        collector.addToQueue(item);
        res.json({ success: true, message: '대기열에 추가되었습니다' });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

module.exports = router;
