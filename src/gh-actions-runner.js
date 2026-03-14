const { readJSON, writeJSON, PATHS, log, ensureDirectories } = require('./utils');
const { uploadPost } = require('./uploader');
const { runFull } = require('./pipeline');

async function runGhaTasks() {
    ensureDirectories();
    log('INFO', '🚀 GitHub Actions 예약 업로드 체크 시작');
    
    const data = readJSON(PATHS.schedules);
    if (!data || !data.schedules || data.schedules.length === 0) {
        log('INFO', '등록된 예약이 없습니다.');
        return;
    }

    const schedules = data.schedules;
    const now = new Date();
    let updated = false;

    for (const schedule of schedules) {
        // 'pending' 또는 'active' 상태인 1회성 예약 확인
        if ((schedule.status === 'pending' || schedule.status === 'active') && schedule.scheduleType === 'once') {
            const targetTime = new Date(schedule.dateTime);
            
            // 예약 시간이 현재 시간보다 이전(이미 지남)이면 실행
            if (targetTime <= now) {
                log('INFO', `⏳ 예약 실행 대상 발견: ${schedule.id} (${schedule.dateTime})`);
                
                try {
                    let result;
                    if (schedule.isPipeline) {
                        log('INFO', '파이프라인 전체 실행 모드로 진행합니다.');
                        const options = {
                            accountId: schedule.accountId,
                            urls: schedule.pipelineUrls || [],
                            rssFeeds: schedule.pipelineRss || [],
                            coupangKeyword: schedule.pipelineCoupangKeyword || null,
                            naverKeyword: schedule.pipelineNaverKeyword || null,
                        };
                        result = await runFull(options);
                    } else {
                        log('INFO', '일반 게시물 단독 업로드로 진행합니다.');
                        result = await uploadPost(schedule.accountId, schedule.content, schedule.imagePath);
                    }

                    if (result.success || (result.phases && result.success !== false)) {
                        schedule.status = 'completed';
                        schedule.lastRun = now.toISOString();
                        schedule.runCount = (schedule.runCount || 0) + 1;
                        log('INFO', `✅ 예약 실행 완료: ${schedule.id}`);
                    } else {
                        schedule.status = 'failed';
                        schedule.errorMessage = result.message || '알 수 없는 오류';
                        log('ERROR', `❌ 예약 실행 실패: ${schedule.id} - ${schedule.errorMessage}`);
                    }
                } catch (error) {
                    schedule.status = 'failed';
                    schedule.errorMessage = error.message;
                    log('ERROR', `❌ 예약 실행 중 치명적 오류: ${error.message}`);
                }
                updated = true;
            }
        }
        // 반복 예약(repeat)의 경우 GHA의 자체 cron 설정과 맞추는 것이 좋으므로 
        // 여기서는 일단 1회성 예약 위주로 처리하거나, GHA 전용 플래그가 있는 경우만 처리하게 확장 가능합니다.
    }

    if (updated) {
        writeJSON(PATHS.schedules, { schedules });
        log('INFO', '예약 상태 정보 업데이트 완료.');
        
        // 주의: GHA에서 파일이 업데이트되어도 다시 Push하지 않으면 다음 실행 때 반영되지 않음
        // 워크플로우 파일에서 git commit & push를 수행하도록 구성해야 함
    } else {
        log('INFO', '실행할 예약 대상이 없습니다.');
    }
}

// 스크립트 실행
runGhaTasks()
    .then(() => log('INFO', 'GitHub Actions Task finished.'))
    .catch(err => {
        log('ERROR', `Runner Error: ${err.message}`);
        process.exit(1);
    });
