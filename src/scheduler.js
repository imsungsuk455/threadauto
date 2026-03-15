const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { log, readJSON, writeJSON, PATHS, formatTimestamp, gitSync } = require('./utils');
const { uploadPost, ensurePublicUrl } = require('./uploader');
const accounts = require('./accounts');
const axios = require('axios');

const activeJobs = new Map(); // scheduleId -> cron job

/**
 * 스케줄 데이터 로드
 */
function loadSchedules() {
    const data = readJSON(PATHS.schedules);
    return data ? data.schedules || [] : [];
}

function saveSchedules(schedules) {
    return writeJSON(PATHS.schedules, { schedules });
}

/**
 * 예약 추가
 */
function addSchedule({ accountId, content, imagePath, scheduleType, dateTime, cronExpression, repeatLabel }) {
    const schedules = loadSchedules();

    const schedule = {
        id: uuidv4(),
        accountId,
        content,
        imagePath: imagePath || null,
        scheduleType, // 'once' 또는 'repeat'
        dateTime: dateTime || null, // 1회성 예약 시간
        cronExpression: cronExpression || null, // 반복 예약 cron
        repeatLabel: repeatLabel || '', // 반복 레이블 (예: "매일 오전 9시")
        status: 'pending', // pending, active, completed, failed, cancelled
        createdAt: new Date().toISOString(),
        lastRun: null,
        runCount: 0,
    };

    schedules.push(schedule);
    saveSchedules(schedules);

    // GitHub Actions를 위한 로컬 변경사항 푸시 (썸네일 포함)
    gitSync(`Add schedule: ${schedule.id}`);

    // Cloudflare Worker와 동기화 (정밀 예약 업로드용)
    syncToCloudflare(schedule).catch(err => log('ERROR', `Cloudflare 동기화 실패: ${err.message}`));

    // GitHub Actions 환경이 아닐 때만 로컬 타이머 등록 (GHA은 별도 러너가 처리)
    const IS_GHA = process.env.GITHUB_ACTIONS === 'true';

    // cron job 등록
    if (!IS_GHA) {
        if (scheduleType === 'repeat' && cronExpression) {
            registerCronJob(schedule);
        } else if (scheduleType === 'once' && dateTime) {
            registerOnceJob(schedule);
        }
    }

    log('INFO', `예약 추가: ${schedule.id} (${scheduleType})`);
    return { success: true, schedule };
}

/**
 * 반복 예약 cron job 등록
 */
function registerCronJob(schedule) {
    if (!cron.validate(schedule.cronExpression)) {
        log('ERROR', `잘못된 cron 표현식: ${schedule.cronExpression}`);
        return;
    }

    const job = cron.schedule(schedule.cronExpression, async () => {
        log('INFO', `예약 실행: ${schedule.id}`);
        try {
            let result;
            if (schedule.isPipeline) {
                // 파이프라인 자동 실행
                const { runFull } = require('./pipeline');
                const pipelineConfig = require('./collector').loadPipelineConfig();

                const options = {
                    accountId: schedule.accountId,
                    urls: schedule.pipelineUrls || [],
                    rssFeeds: schedule.pipelineRss || pipelineConfig.defaultRssFeeds || [],
                    coupangKeyword: schedule.pipelineCoupangKeyword || null,
                    naverKeyword: schedule.pipelineNaverKeyword || null,
                };

                result = await runFull(options);
            } else {
                // 일반 게시물 예약
                result = await uploadPost(schedule.accountId, schedule.content, schedule.imagePath);
            }

            updateScheduleStatus(schedule.id, {
                status: 'active',
                lastRun: new Date().toISOString(),
                runCount: (schedule.runCount || 0) + 1,
            });
            log('INFO', `예약 완료: ${schedule.id} - ${result.success ? '성공' : '실패'}`);
        } catch (error) {
            log('ERROR', `예약 실패: ${error.message}`);
            updateScheduleStatus(schedule.id, { status: 'failed', lastRun: new Date().toISOString() });
        }
    }, { timezone: 'Asia/Seoul' });

    activeJobs.set(schedule.id, job);
    updateScheduleStatus(schedule.id, { status: 'active' });
    log('INFO', `Cron job 등록: ${schedule.id} (${schedule.cronExpression})`);
}

/**
 * 1회성 예약 등록
 */
function registerOnceJob(schedule) {
    const targetTime = new Date(schedule.dateTime);
    const now = new Date();
    const delay = targetTime.getTime() - now.getTime();

    if (delay <= 0) {
        log('WARN', `이미 지난 시간입니다: ${schedule.dateTime}`);
        updateScheduleStatus(schedule.id, { status: 'failed' });
        return;
    }

    const timer = setTimeout(async () => {
        log('INFO', `1회성 예약 실행: ${schedule.id}`);
        try {
            const result = await uploadPost(schedule.accountId, schedule.content, schedule.imagePath);
            updateScheduleStatus(schedule.id, {
                status: 'completed',
                lastRun: new Date().toISOString(),
                runCount: 1,
            });
            log('INFO', `1회성 업로드 완료: ${schedule.id} - ${result.success ? '성공' : '실패'}`);
        } catch (error) {
            log('ERROR', `1회성 업로드 실패: ${error.message}`);
            updateScheduleStatus(schedule.id, { status: 'failed', lastRun: new Date().toISOString() });
        }
        activeJobs.delete(schedule.id);
    }, delay);

    activeJobs.set(schedule.id, { stop: () => clearTimeout(timer) });
    updateScheduleStatus(schedule.id, { status: 'active' });
    log('INFO', `1회성 예약 등록: ${schedule.id} (${schedule.dateTime})`);
}

/**
 * 예약 상태 업데이트
 */
function updateScheduleStatus(id, updates) {
    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === id);
    if (idx !== -1) {
        schedules[idx] = { ...schedules[idx], ...updates };
        saveSchedules(schedules);
    }
}

/**
 * 예약 삭제
 */
function deleteSchedule(id) {
    const job = activeJobs.get(id);
    if (job) {
        job.stop();
        activeJobs.delete(id);
    }

    const schedules = loadSchedules();
    const idx = schedules.findIndex(s => s.id === id);
    if (idx === -1) return { success: false, message: '예약을 찾을 수 없습니다.' };

    schedules.splice(idx, 1);
    saveSchedules(schedules);
    log('INFO', `예약 삭제: ${id}`);
    return { success: true, message: '예약이 삭제되었습니다.' };
}

/**
 * 예약 목록 조회
 */
function getSchedules() {
    return loadSchedules();
}

/**
 * 서버 시작 시 기존 활성 예약 복원
 */
function restoreSchedules() {
    const schedules = loadSchedules();
    let restored = 0;

    for (const schedule of schedules) {
        if (schedule.status === 'active' || schedule.status === 'pending') {
            if (schedule.scheduleType === 'repeat' && schedule.cronExpression) {
                registerCronJob(schedule);
                restored++;
            } else if (schedule.scheduleType === 'once' && schedule.dateTime) {
                const targetTime = new Date(schedule.dateTime);
                if (targetTime > new Date()) {
                    registerOnceJob(schedule);
                    restored++;
                } else {
                    updateScheduleStatus(schedule.id, { status: 'completed' });
                }
            }
        }
    }

    log('INFO', `예약 복원 완료: ${restored}개`);
}

/**
 * Cloudflare Worker로 예약 정보 전송
 */
async function syncToCloudflare(schedule) {
    const config = readJSON(PATHS.cloudflareConfig);
    if (!config || !config.workerUrl || !config.apiSecret) {
        log('INFO', 'Cloudflare 설정이 없어 Worker 동기화를 건너뜁니다.');
        return;
    }

    log('INFO', `Cloudflare Worker로 예약 전송 중: ${schedule.id}`);

    try {
        const account = accounts.getAccount(schedule.accountId);
        if (!account) throw new Error('계정 정보를 찾을 수 없습니다.');

        // 미디어 경로가 로컬인 경우 공용 URL로 변환
        let publicImagePath = schedule.imagePath;
        if (schedule.imagePath) {
            if (Array.isArray(schedule.imagePath)) {
                publicImagePath = await Promise.all(schedule.imagePath.map(p => ensurePublicUrl(p)));
            } else {
                publicImagePath = await ensurePublicUrl(schedule.imagePath);
            }
        }

        const payload = {
            ...schedule,
            imagePath: publicImagePath,
            accessToken: account.accessToken,
            threadsUserId: account.threadsUserId
        };

        const res = await axios.post(`${config.workerUrl}/add-schedule`, payload, {
            headers: {
                'Authorization': `Bearer ${config.apiSecret}`,
                'Content-Type': 'application/json'
            }
        });

        if (res.data && res.data.success) {
            log('INFO', `✅ Cloudflare Worker 예약 등록 완료: ${schedule.id}`);
        }
    } catch (e) {
        const msg = e.response?.data || e.message;
        throw new Error(`Worker API 오류: ${msg}`);
    }
}

module.exports = { addSchedule, deleteSchedule, getSchedules, restoreSchedules };
