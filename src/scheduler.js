const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { log, readJSON, writeJSON, PATHS, formatTimestamp } = require('./utils');
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
async function addSchedule({ accountId, content, imagePath, scheduleType, dateTime, cronExpression, repeatLabel }) {
    const schedules = loadSchedules();
    const account = accounts.getAccount(accountId);
    if (!account) throw new Error('계정을 찾을 수 없습니다.');

    // 로컬 이미지 경로를 공용 URL로 미리 변환
    let publicImagePath = imagePath;
    if (imagePath) {
        if (Array.isArray(imagePath)) {
            publicImagePath = await Promise.all(imagePath.map(p => ensurePublicUrl(p)));
        } else {
            publicImagePath = await ensurePublicUrl(imagePath);
        }
        log('INFO', `예약 미디어 경로 변환 완료: ${Array.isArray(publicImagePath) ? publicImagePath.length + '개' : '1개'}`);
    }

    const schedule = {
        id: uuidv4(),
        accountId,
        threadsUserId: account.threadsUserId, // 서버 OFF 시 매칭을 위한 고유 ID 추가
        content,
        imagePath: publicImagePath || null,
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

    // GitHub Actions를 더 이상 사용하지 않으므로 gitSync 호출 제거

    // Cloudflare Worker와 동기화 (정밀 예약 업로드용)
    syncToCloudflare(schedule).catch(err => log('ERROR', `Cloudflare 동기화 실패: ${err.message}`));

    log('INFO', `예약 추가 및 서버 전송 완료: ${schedule.id} (${scheduleType})`);
    return { success: true, schedule };
}

/**
 * 반복 예약 cron job 등록 (로컬 타이머용)
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
        if (job.stop) job.stop();
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
 * 서버 시작 시 환경 체크
 */
function restoreSchedules() {
    const config = readJSON(PATHS.cloudflareConfig);
    if (config && config.workerUrl && config.apiSecret) {
        log('INFO', '☁️ Cloudflare Worker 모드 활성화됨 (모든 예약은 Worker가 처리합니다)');
        return;
    }
    
    log('WARN', '⚠️ Cloudflare 설정이 없습니다. 로컬 서버가 켜져 있을 때만 예약이 처리됩니다.');
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

        const payload = {
            ...schedule,
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
