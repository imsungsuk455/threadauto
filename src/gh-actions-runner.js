const path = require('path');
const { readJSON, writeJSON, PATHS, log, ensureDirectories } = require('./utils');
const { uploadPost } = require('./uploader');
const { runFull } = require('./pipeline');
const { verifyAccessToken } = require('./auth');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

// dayjs 플러그인 설정
dayjs.extend(utc);
dayjs.extend(timezone);


async function runGhaTasks() {
    ensureDirectories();
    log('INFO', '🚀 GitHub Actions 예약 업로드 체크 시작');

    // THREADS_ACCESS_TOKEN 이 환경 변수에 있으면 해당 계정의 토큰을 메모리에서 업데이트
    if (process.env.THREADS_ACCESS_TOKEN) {
        log('INFO', '환경 변수 THREADS_ACCESS_TOKEN 발견. 계정 정보를 동기화합니다...');
        const authInfo = await verifyAccessToken(process.env.THREADS_ACCESS_TOKEN);
        if (authInfo.success) {
            const { updateAccountInMemory } = require('./accounts');
            updateAccountInMemory(authInfo.threadsUserId, {
                accessToken: process.env.THREADS_ACCESS_TOKEN,
                username: authInfo.username
            });
            log('INFO', `계정 토큰 로컬 업데이트 성공: @${authInfo.username}`);
            
            if (!process.env.THREADS_USER_ID) process.env.THREADS_USER_ID = authInfo.threadsUserId;
            if (!process.env.THREADS_USERNAME) process.env.THREADS_USERNAME = authInfo.username;
        } else {
            log('WARN', `환경 변수 토큰 검증 실패: ${authInfo.message}`);
        }
    }

    const data = readJSON(PATHS.schedules);
    if (!data || !data.schedules || data.schedules.length === 0) {
        log('INFO', '등록된 예약이 없습니다.');
        return;
    }

    const schedules = data.schedules;
    const nowKst = dayjs().tz('Asia/Seoul');
    let updated = false;

    // 실행 대상 예약 필터링 (pending/active 상태이면서 시간이 지남)
    const targetSchedules = schedules
        .filter(s => (s.status === 'pending' || s.status === 'active') && s.scheduleType === 'once')
        .filter(s => {
            if (!s.dateTime) return false;
            // 예약 시간을 KST 기준으로 파싱 (예: "2026-03-16T20:45")
            // 문자열에 타임존 정보가 있으면 그대로 파싱, 없으면 Asia/Seoul로 간주
            const scheduledTime = s.dateTime.includes('Z') || s.dateTime.includes('+') 
                ? dayjs(s.dateTime) 
                : dayjs.tz(s.dateTime, 'Asia/Seoul');
            
            return nowKst.isAfter(scheduledTime);
        })
        // 가장 오래된 예약이 먼저 오도록 정렬
        .sort((a, b) => {
            const dateA = a.dateTime.includes('Z') || a.dateTime.includes('+') ? dayjs(a.dateTime) : dayjs.tz(a.dateTime, 'Asia/Seoul');
            const dateB = b.dateTime.includes('Z') || b.dateTime.includes('+') ? dayjs(b.dateTime) : dayjs.tz(b.dateTime, 'Asia/Seoul');
            return dateA.valueOf() - dateB.valueOf();
        });

    if (targetSchedules.length > 0) {
        // 이번 회차에는 최대 3개까지 처리 (도배 방지 및 시간 내 완료 보장)
        const batchSize = Math.min(targetSchedules.length, 3);
        log('INFO', `⏳ 예약 실행 대상 ${batchSize}개 처리 시작 (총 대기: ${targetSchedules.length})`);

        for (let i = 0; i < batchSize; i++) {
            const schedule = targetSchedules[i];
            log('INFO', `[${i + 1}/${batchSize}] 처리 중: ${schedule.id} (${schedule.dateTime})`);

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
                schedule.lastRun = nowKst.toISOString();
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
