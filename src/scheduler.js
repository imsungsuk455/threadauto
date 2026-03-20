const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { log, readJSON, writeJSON, PATHS, formatTimestamp } = require('./utils');
const { uploadPost, ensurePublicUrl } = require('./uploader');
const accounts = require('./accounts');
const axios = require('axios');

const activeJobs = new Map(); // scheduleId -> { stop: fn } or cron job

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
 * Cloudflare 설정 확인용 헬퍼
 */
function isCloudflareEnabled() {
    const config = readJSON(PATHS.cloudflareConfig);
    return !!(config && config.workerUrl && config.apiSecret);
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

    let finalDateTime = dateTime || null;
    if (finalDateTime && !finalDateTime.includes('Z') && !finalDateTime.includes('+')) {
        finalDateTime += "+09:00";
    }

    const schedule = {
        id: uuidv4(),
        accountId,
        threadsUserId: account.threadsUserId,
        content,
        imagePath: publicImagePath || null,
        scheduleType, // 'once' 또는 'repeat'
        dateTime: finalDateTime, // 1회성 예약 시간
        cronExpression: cronExpression || null, // 반복 예약 cron
        repeatLabel: repeatLabel || '',
        status: 'pending',
        createdAt: new Date().toISOString(),
        lastRun: null,
        runCount: 0,
    };

    schedules.push(schedule);
    saveSchedules(schedules);

    // 구동 모드에 따라 처리 주체 결정 (완전 분리)
    if (isCloudflareEnabled()) {
        log('INFO', `[Cloudflare 모드] Worker로 예약 전송: ${schedule.id}`);
        syncToCloudflare(schedule).catch(err => log('ERROR', `Cloudflare 동기화 실패: ${err.message}`));
    } else {
        log('INFO', `[로컬 모드] 로컬 타이머 등록: ${schedule.id}`);
        if (scheduleType === 'repeat' && cronExpression) {
            registerCronJob(schedule);
        } else if (scheduleType === 'once' && dateTime) {
            registerOnceJob(schedule);
        }
    }

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

    // 기존 작업이 있으면 정지
    const oldJob = activeJobs.get(schedule.id);
    if (oldJob && oldJob.stop) oldJob.stop();

    const job = cron.schedule(schedule.cronExpression, async () => {
        log('INFO', `로컬 예약 실행: ${schedule.id}`);
        try {
            const result = await uploadPost(schedule.accountId, schedule.content, schedule.imagePath);
            updateScheduleStatus(schedule.id, {
                status: 'active',
                lastRun: new Date().toISOString(),
                runCount: (schedule.runCount || 0) + 1,
            });
            log('INFO', `로컬 예약 완료: ${schedule.id} - ${result.success ? '성공' : '실패'}`);
        } catch (error) {
            log('ERROR', `로컬 예약 실패: ${error.message}`);
            updateScheduleStatus(schedule.id, { status: 'failed', lastRun: new Date().toISOString() });
        }
    }, { timezone: 'Asia/Seoul' });

    activeJobs.set(schedule.id, job);
    updateScheduleStatus(schedule.id, { status: 'active' });
}

/**
 * 1회성 예약 등록
 */
function registerOnceJob(schedule) {
    // 타임존 보정: ISO 형식이 아니고 타임존 정보가 없으면 +09:00(서울) 추가
    let dateTimeStr = schedule.dateTime;
    if (dateTimeStr && !dateTimeStr.includes('Z') && !dateTimeStr.includes('+')) {
        dateTimeStr += "+09:00";
    }

    const targetTime = new Date(dateTimeStr);
    const now = new Date();
    const delay = targetTime.getTime() - now.getTime();

    if (delay <= 0) {
        log('WARN', `이미 지난 시간입니다 (로컬): ${schedule.dateTime}`);
        updateScheduleStatus(schedule.id, { status: 'failed' });
        return;
    }

    const timer = setTimeout(async () => {
        log('INFO', `로컬 1회성 예약 실행: ${schedule.id}`);
        try {
            const result = await uploadPost(schedule.accountId, schedule.content, schedule.imagePath);
            updateScheduleStatus(schedule.id, {
                status: 'completed',
                lastRun: new Date().toISOString(),
                runCount: 1,
            });
            log('INFO', `로컬 1회성 성공: ${schedule.id}`);
        } catch (error) {
            log('ERROR', `로컬 1회성 실패: ${error.message}`);
            updateScheduleStatus(schedule.id, { status: 'failed', lastRun: new Date().toISOString() });
        }
        activeJobs.delete(schedule.id);
    }, delay);

    activeJobs.set(schedule.id, { stop: () => clearTimeout(timer) });
    updateScheduleStatus(schedule.id, { status: 'active' });
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
 * 서버 시작 시 기존 활성 예약 복원
 */
function restoreSchedules() {
    if (isCloudflareEnabled()) {
        log('INFO', '☁️ Cloudflare Worker 모드 활성화됨 (로컬 업로드는 중단됩니다)');
        // 로컬 타이머 모두 제거 (혹시 있다면)
        activeJobs.forEach(job => { if (job.stop) job.stop(); });
        activeJobs.clear();
        return;
    }
    
    log('INFO', '🏠 로컬 타임스케줄러 활성화 (기존 예약 복원 중...)');
    const schedules = loadSchedules();
    schedules.forEach(schedule => {
        if (schedule.status === 'active' || schedule.status === 'pending') {
            if (schedule.scheduleType === 'repeat' && schedule.cronExpression) {
                registerCronJob(schedule);
            } else if (schedule.scheduleType === 'once' && schedule.dateTime) {
                registerOnceJob(schedule);
            }
        }
    });
}

/**
 * Cloudflare Worker로 예약 정보 전송
 */
async function syncToCloudflare(schedule) {
    const config = readJSON(PATHS.cloudflareConfig);
    if (!config || !config.workerUrl || !config.apiSecret) return;

    try {
        const account = accounts.getAccount(schedule.accountId);
        if (!account) throw new Error('계정 정보 없음');

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
        log('ERROR', `Worker API 오류: ${e.message}`);
    }
}

module.exports = { addSchedule, deleteSchedule, getSchedules, restoreSchedules };
