const { scrapeThreadsByUser } = require('./src/threads-scraper');
const { processItem } = require('./src/processor');
const { uploadPost } = require('./src/uploader');
const { log } = require('./src/utils');

async function runManualTest() {
    const accountId = 'e335a502-ec69-4266-a517-1b0c29a248e7'; // battleofwin45
    log('INFO', '🚀 수동 테스트 시작 (계정: battleofwin45)');

    try {
        // 1. 수집
        log('INFO', '1. @eattt.zin 계정에서 스레드 수집 중...');
        const scrapeResult = await scrapeThreadsByUser('eattt.zin', 1);
        if (!scrapeResult.success || scrapeResult.threads.length === 0) {
            throw new Error('수집 실패 또는 게시물 없음');
        }
        const thread = scrapeResult.threads[0];
        log('INFO', `게시물 발견: ${thread.url}`);

        // 2. 큐 항목 추가
        log('INFO', '2. 큐에 테스트 항목 추가 중...');
        const { createQueueItem, addToQueue } = require('./src/collector');
        const rawItem = createQueueItem('crawl', {
            title: `Threads: @${thread.author}`,
            bodyText: thread.content,
            sourceUrl: thread.url,
            author: thread.author,
            platform: 'threads'
        }, {
            mediaUrls: thread.mediaUrls || []
        });
        
        // ID 고정 (테스트용)
        rawItem.id = 'manual-test-item-' + Date.now();
        const item = addToQueue(rawItem);
        log('INFO', `큐에 추가됨: ${item.id}`);

        // 3. 가공
        log('INFO', '3. AI 콘텐츠 가공 중...');
        const processedItemResult = await processItem(item, { accountId });
        if (!processedItemResult.success) {
            throw new Error('AI 가공 실패: ' + processedItemResult.message);
        }
        const processedItem = processedItemResult.item;
        log('INFO', 'AI 가공 완료');

        // 4. 업로드
        log('INFO', '4. 스레드 업로드 시작...');
        const uploadResult = await uploadPost(accountId, processedItem.processedContent, (processedItem.mediaUrls || []).slice(0, 2));
        
        if (uploadResult.success) {
            log('INFO', `✅ 업로드 성공! Media ID: ${uploadResult.mediaId}`);
        } else {
            log('ERROR', `❌ 업로드 실패: ${uploadResult.message}`);
        }

    } catch (error) {
        log('ERROR', `❌ 테스트 중 오류 발생: ${error.message}`);
    }
}

runManualTest().then(() => console.log('Test finished.'));
