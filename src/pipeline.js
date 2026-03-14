const { log } = require('./utils');
const collector = require('./collector');
const { processAllPending } = require('./processor');
const { publishAllProcessed } = require('./publisher');

/**
 * 파이프라인 오케스트레이터
 * 수집 → 가공 → 발행 3단계를 독립적으로 또는 순차적으로 실행
 */

// ===== Phase 1: 수집 실행 =====

async function runCollect(options = {}) {
    log('INFO', '=== 파이프라인 Phase 1: 수집 시작 ===');

    const results = {
        phase: 'collect',
        startedAt: new Date().toISOString(),
        sources: [],
        totalCollected: 0,
        errors: [],
    };

    try {
        // RSS 피드 수집
        if (options.rssFeeds && options.rssFeeds.length > 0) {
            for (const feedUrl of options.rssFeeds) {
                try {
                    const res = await collector.collectFromRSS({ feedUrl, limit: options.rssLimit || 5 });
                    results.sources.push({ type: 'rss', url: feedUrl, ...res });
                    if (res.success) results.totalCollected += res.count;
                } catch (err) {
                    results.errors.push({ type: 'rss', url: feedUrl, error: err.message });
                }
            }
        }

        // URL 수집
        if (options.urls && options.urls.length > 0) {
            for (const url of options.urls) {
                try {
                    const res = await collector.collectFromUrl({ url });
                    results.sources.push({ type: 'crawl', url, ...res });
                    if (res.success) results.totalCollected += 1;
                } catch (err) {
                    results.errors.push({ type: 'crawl', url, error: err.message });
                }
            }
        }

        // 쿠팡 상품 수집
        if (options.coupangKeyword) {
            try {
                const res = await collector.collectCoupangProducts({
                    keyword: options.coupangKeyword,
                    limit: options.coupangLimit || 5,
                });
                results.sources.push({ type: 'coupang', keyword: options.coupangKeyword, ...res });
                if (res.success) results.totalCollected += res.count;
            } catch (err) {
                results.errors.push({ type: 'coupang', error: err.message });
            }
        }

        // 네이버 상품 수집
        if (options.naverKeyword) {
            try {
                const res = await collector.collectNaverProducts({
                    keyword: options.naverKeyword,
                    display: options.naverLimit || 5,
                    customLink: options.naverLink
                });
                results.sources.push({ type: 'naver', keyword: options.naverKeyword, ...res });
                if (res.success) results.totalCollected += res.count;
            } catch (err) {
                results.errors.push({ type: 'naver', error: err.message });
            }
        }
    } catch (error) {
        log('ERROR', `수집 단계 오류: ${error.message}`);
        results.errors.push({ type: 'system', error: error.message });
    }

    results.completedAt = new Date().toISOString();
    log('INFO', `=== 수집 완료: ${results.totalCollected}건 수집, ${results.errors.length}건 오류 ===`);
    return results;
}

// ===== Phase 2: 가공 실행 =====

async function runProcess(options = {}) {
    log('INFO', '=== 파이프라인 Phase 2: 가공 시작 ===');
    const result = await processAllPending(options);
    log('INFO', `=== 가공 완료: ${result.processed || 0}건 처리, ${result.failed || 0}건 실패 ===`);
    return { phase: 'process', ...result };
}

// ===== Phase 3: 발행 실행 =====

async function runPublish(accountId) {
    log('INFO', '=== 파이프라인 Phase 3: 발행 시작 ===');

    if (!accountId) {
        return { phase: 'publish', success: false, message: '발행할 계정을 선택해주세요.' };
    }

    const result = await publishAllProcessed(accountId);
    log('INFO', `=== 발행 완료: ${result.published || 0}건 게시, ${result.failed || 0}건 실패 ===`);
    return { phase: 'publish', ...result };
}

// ===== 전체 파이프라인 실행 =====

async function runFull(options = {}) {
    log('INFO', '========== 전체 파이프라인 실행 시작 ==========');

    const pipelineResult = {
        startedAt: new Date().toISOString(),
        phases: {},
        success: true,
    };

    // Phase 1: 수집
    try {
        pipelineResult.phases.collect = await runCollect(options);
    } catch (error) {
        log('ERROR', `파이프라인 수집 단계 실패: ${error.message}`);
        pipelineResult.phases.collect = { phase: 'collect', error: error.message };
        // 수집이 실패해도 기존 큐의 pending 항목으로 가공 가능
    }

    // Phase 2: 가공 (수집이 실패해도 기존 pending 있으면 실행)
    try {
        pipelineResult.phases.process = await runProcess(options);
    } catch (error) {
        log('ERROR', `파이프라인 가공 단계 실패: ${error.message}`);
        pipelineResult.phases.process = { phase: 'process', error: error.message };
    }

    // Phase 3: 발행 (가공된 항목이 있으면 실행)
    if (options.accountId) {
        try {
            pipelineResult.phases.publish = await runPublish(options.accountId);
        } catch (error) {
            log('ERROR', `파이프라인 발행 단계 실패: ${error.message}`);
            pipelineResult.phases.publish = { phase: 'publish', error: error.message };
        }
    } else {
        pipelineResult.phases.publish = { phase: 'publish', skipped: true, message: '계정 미지정으로 발행 건너뜀' };
    }

    pipelineResult.completedAt = new Date().toISOString();
    log('INFO', '========== 전체 파이프라인 실행 완료 ==========');
    return pipelineResult;
}

// ===== 파이프라인 상태 조회 =====

function getStatus() {
    const stats = collector.getQueueStats();
    return {
        queue: stats,
        timestamp: new Date().toISOString(),
    };
}

module.exports = {
    runCollect,
    runProcess,
    runPublish,
    runFull,
    processItem: async (id, options) => {
        const item = collector.getQueueItem(id);
        if (!item) throw new Error('항목을 찾을 수 없습니다.');
        const { processItem } = require('./processor');
        return await processItem(item, options);
    },
    getStatus,
};
