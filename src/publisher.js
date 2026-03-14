const axios = require('axios');
const { log } = require('./utils');
const accounts = require('./accounts');
const { uploadPost, replyToThread, addToHistory } = require('./uploader');
const { getQueueItems, updateQueueItem } = require('./collector');

/**
 * Phase 3 — 발행기 (Publisher)
 * 가공 완료된 콘텐츠를 Threads API로 발행
 * 미디어는 URL 직접 전달 우선, 부득이 시 인메모리 버퍼 처리
 */

// ===== 미디어 URL 유효성 확인 (HEAD 요청) =====

async function isMediaUrlAccessible(url) {
    try {
        const res = await axios.head(url, {
            timeout: 5000,
            maxRedirects: 3,
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ThreadsBot/1.0)',
            },
        });
        const contentType = res.headers['content-type'] || '';
        return contentType.startsWith('image/') || contentType.startsWith('video/');
    } catch {
        return false;
    }
}

// ===== 미디어 URL → 인메모리 버퍼 처리 (디스크 I/O 없음) =====

async function fetchMediaToBuffer(url) {
    try {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: 50 * 1024 * 1024, // 50MB
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ThreadsBot/1.0)',
            },
        });
        return {
            buffer: Buffer.from(res.data),
            contentType: res.headers['content-type'] || 'application/octet-stream',
            size: res.data.byteLength,
        };
    } catch (error) {
        log('WARN', `미디어 버퍼 다운로드 실패: ${url} - ${error.message}`);
        return null;
    }
}

// ===== 단일 항목 발행 =====

async function publishItem(item, accountId = null) {
    const targetAccountId = accountId || item.accountId;

    if (!targetAccountId) {
        return { success: false, message: '발행할 계정이 지정되지 않았습니다.' };
    }

    const content = item.processedContent;
    if (!content) {
        return { success: false, message: '가공된 콘텐츠가 없습니다. 먼저 가공을 실행해주세요.' };
    }

    try {
        // 미디어 URL 처리: URL 직접 전달 우선
        let mediaUrls = item.mediaUrls || [];
        const validMediaUrls = [];

        for (const url of mediaUrls) {
            const accessible = await isMediaUrlAccessible(url);
            if (accessible) {
                validMediaUrls.push(url);
            } else {
                log('WARN', `미디어 URL 접근 불가, 건너뜀: ${url}`);
                // 인메모리 버퍼 폴백은 Threads API가 URL만 받으므로,
                // 접근 불가한 URL은 건너뜁니다 (Threads API는 공개 URL만 지원)
            }
        }

        // 업로드 실행 (기존 uploader.js 활용)
        let imagePath = null;
        if (validMediaUrls.length > 1) {
            imagePath = validMediaUrls.slice(0, 10); // Carousel 최대 10개
        } else if (validMediaUrls.length === 1) {
            imagePath = validMediaUrls[0];
        }

        const result = await uploadPost(targetAccountId, content, imagePath);

        if (result.success) {
            // 제휴 링크가 있으면 댓글로 달기
            if (item.affiliateLink && result.mediaId) {
                log('INFO', `제휴 링크 댓글 추가: ${item.affiliateLink}`);
                await new Promise(r => setTimeout(r, 2000)); // 게시물 안정화 대기

                const linkComment = `🔗 자세한 정보 보기\n${item.affiliateLink}`;
                const replyResult = await replyToThread(targetAccountId, result.mediaId, linkComment);

                if (!replyResult.success) {
                    log('WARN', `제휴 링크 댓글 실패: ${replyResult.message}`);
                }
            }

            // 큐 업데이트
            updateQueueItem(item.id, {
                status: 'published',
                publishedAt: new Date().toISOString(),
                publishResult: {
                    mediaId: result.mediaId,
                    accountUsername: result.accountUsername,
                },
            });

            log('INFO', `발행 완료: ${item.id} → 미디어 ID: ${result.mediaId}`);
            return { success: true, item: item, mediaId: result.mediaId };
        } else {
            throw new Error(result.message);
        }

    } catch (error) {
        log('ERROR', `발행 실패 [${item.id}]: ${error.message}`);

        const retryCount = (item.retryCount || 0) + 1;
        const maxRetries = item.maxRetries || 3;

        updateQueueItem(item.id, {
            status: retryCount >= maxRetries ? 'failed' : 'processed', // 재시도 가능하면 processed로 복원
            retryCount,
            errorMessage: `발행 실패 (시도 ${retryCount}/${maxRetries}): ${error.message}`,
        });

        return { success: false, itemId: item.id, message: error.message, retryCount };
    }
}

// ===== 일괄 발행 =====

async function publishAllProcessed(accountId) {
    const processedItems = getQueueItems('processed');

    if (processedItems.length === 0) {
        log('INFO', '발행할 항목이 없습니다.');
        return { success: true, published: 0, failed: 0, message: '발행할 항목이 없습니다.' };
    }

    if (!accountId) {
        return { success: false, message: '발행할 계정을 선택해주세요.' };
    }

    log('INFO', `발행 시작: ${processedItems.length}건 (계정: ${accountId})`);

    let published = 0;
    let failed = 0;
    const results = [];

    for (const item of processedItems) {
        const result = await publishItem(item, accountId);
        results.push(result);

        if (result.success) {
            published++;
        } else {
            failed++;
        }

        // 게시물 간 간격 (API 레이트 리밋 + 자연스러운 게시 패턴)
        if (processedItems.indexOf(item) < processedItems.length - 1) {
            const delay = 5000 + Math.random() * 5000; // 5~10초
            await new Promise(r => setTimeout(r, delay));
        }
    }

    log('INFO', `발행 완료: 성공 ${published}건, 실패 ${failed}건`);
    return { success: true, published, failed, total: processedItems.length, results };
}

// ===== 실패 항목 재시도 =====

async function retryFailedItem(itemId, accountId) {
    const { getQueueItem } = require('./collector');
    const item = getQueueItem(itemId);

    if (!item) return { success: false, message: '항목을 찾을 수 없습니다.' };
    if (item.status !== 'failed') return { success: false, message: '실패 상태의 항목만 재시도할 수 있습니다.' };

    // 가공이 안 된 상태이면 먼저 가공부터
    if (!item.processedContent) {
        const { processItem } = require('./processor');
        const processResult = await processItem(item);
        if (!processResult.success) return processResult;
        // 가공 후 다시 조회
        const updatedItem = getQueueItem(itemId);
        return await publishItem(updatedItem, accountId);
    }

    // 가공은 되어 있으니 발행 재시도
    // retryCount를 리셋하지 않음 (누적)
    return await publishItem(item, accountId);
}

module.exports = {
    publishItem,
    publishAllProcessed,
    retryFailedItem,
    isMediaUrlAccessible,
    fetchMediaToBuffer,
};
