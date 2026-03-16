const path = require('path');
const { readJSON, writeJSON, PATHS, log, ensureDirectories } = require('./utils');
const { uploadPost } = require('./uploader');
const { runFull } = require('./pipeline');
const { verifyAccessToken } = require('./auth');

async function runGhaTasks() {
    ensureDirectories();
    log('INFO', '🚀 GitHub Actions 예약 업로드 체크 시작');

    // THREADS_USER_ID 가 없으면 토큰을 통해 자동 조회
    if (process.env.THREADS_ACCESS_TOKEN && !process.env.THREADS_USER_ID) {
        log('INFO', 'THREADS_USER_ID 가 없어 토큰으로 자동 조회를 시도합니다...');
        const authInfo = await verifyAccessToken(process.env.THREADS_ACCESS_TOKEN);
        if (authInfo.success) {
            process.env.THREADS_USER_ID = authInfo.threadsUserId;
            process.env.THREADS_USERNAME = authInfo.username;
            log('INFO', `계정 정보 자동 조회 성공: @${authInfo.username} (${authInfo.threadsUserId})`);
        } else {
            log('ERROR', `계정 정보 조회 실패: ${authInfo.message}`);
        }
    }

    const data = readJSON(PATHS.schedules);
    if (!data || !data.schedules || data.schedules.length === 0) {
        log('INFO', '등록된 예약이 없습니다.');
        return;
    }

    const schedules = data.schedules;
    const now = new Date();
    let updated = false;

    // 실행 대상 예약 필터링 (pending/active 상태이면서 시간이 지남)
    const targetSchedules = schedules
        .filter(s => (s.status === 'pending' || s.status === 'active') && s.scheduleType === 'once')
        .filter(s => {
            if (!s.dateTime) return false;
            let scheduledDate = new Date(s.dateTime);
            // 날짜 문자열에 타임존 정보 (Z 또는 +) 가 없으면 한국 시간 (+09:00) 으로 처리
            if (!s.dateTime.includes('Z') && !s.dateTime.includes('+')) {
                scheduledDate = new Date(s.dateTime + '+09:00');
            }
            return scheduledDate <= now;
        })
        // 가장 오래된 예약이 먼저 오도록 정렬
        .sort((a, b) => {
            const dateA = a.dateTime.includes('Z') || a.dateTime.includes('+') ? new Date(a.dateTime) : new Date(a.dateTime + '+09:00');
            const dateB = b.dateTime.includes('Z') || b.dateTime.includes('+') ? new Date(b.dateTime) : new Date(b.dateTime + '+09:00');
            return dateA - dateB;
        });

    if (targetSchedules.length > 0) {
        // 이번 회차에는 가장 오래된 것 1 개만 처리 (도배 방지)
        const schedule = targetSchedules[0];
        log('INFO', `⏳ 예약 실행 대상 발견: ${schedule.id} (${schedule.dateTime})`);
        log('INFO', `남은 대기 작업 수: ${targetSchedules.length - 1}`);

        // 경로 변환 로직 추가 (로컬 절대 경로 -> GHA 상대 경로)
        if (schedule.imagePath) {
            const fixPath = (p) => {
                if (p && typeof p === 'string') {
                    // Windows 경로 변환 (C:\Users\...\thread auto\...)
                    if (p.includes('\\thread auto\\')) {
                        const relativePart = p.split('\\thread auto\\')[1].replace(/\\/g, '/');
                        const newPath = path.join(PATHS.root, relativePart);
                        log('INFO', `경로 변환 (Windows): ${p} -> ${newPath}`);
                        return newPath;
                    }
                    // Unix 스타일 경로지만 uploads 가 포함된 경우
                    if (p.includes('/uploads/') && !p.startsWith('http')) {
                        const newPath = path.join(PATHS.root, p.replace(/^\//, ''));
                        log('INFO', `경로 변환 (Unix): ${p} -> ${newPath}`);
                        return newPath;
                    }
                }
                return p;
            };

            if (Array.isArray(schedule.imagePath)) {
                schedule.imagePath = schedule.imagePath.map(fixPath);
            } else {
                schedule.imagePath = fixPath(schedule.imagePath);
            }
        }

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

    if (updated) {
        writeJSON(PATHS.schedules, { schedules });
        log('INFO', '예약 상태 정보 업데이트 완료.');
    } else {
        log('INFO', '실행할 예약 대상이 없습니다.');
    }
}

// 스크립트 실행 (단독 실행 시에만)
if (require.main === module) {
    runGhaTasks()
        .then(() => log('INFO', 'GitHub Actions Task finished.'))
        .catch(err => {
            log('ERROR', `Runner Error: ${err.message}`);
            process.exit(1);
        });
}

// 다른 모듈에서 import 가능하도록 export
module.exports = { runGhaTasks };
