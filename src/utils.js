const fs = require('fs');
const path = require('path');

// ===== 랜덤 딜레이 =====
function randomDelay(min = 1000, max = 3000) {
    return new Promise(resolve => {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        setTimeout(resolve, delay);
    });
}

// ===== 로깅 =====
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
let currentLogLevel = LOG_LEVELS.INFO;

function log(level, message, data = null) {
    if (LOG_LEVELS[level] < currentLogLevel) return;
    const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const prefix = { DEBUG: '🔍', INFO: '📋', WARN: '⚠️', ERROR: '❌' };
    const logLine = `[${timestamp}] ${prefix[level] || '📋'} ${message}`;
    console.log(logLine);
    if (data) console.log(JSON.stringify(data, null, 2));

    // 로그 파일에도 기록
    try {
        const logDir = path.join(__dirname, '..', 'data');
        if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
        const logFile = path.join(logDir, 'app.log');
        const fileLine = `[${timestamp}] [${level}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`;
        fs.appendFileSync(logFile, fileLine);
    } catch (e) { /* 로그 파일 기록 실패 무시 */ }
}

// ===== JSON 파일 읽기/쓰기 =====
function readJSON(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(content);
    } catch (e) {
        log('ERROR', `JSON 파일 읽기 실패: ${filePath}`, e.message);
        return null;
    }
}

function writeJSON(filePath, data) {
    try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        return true;
    } catch (e) {
        log('ERROR', `JSON 파일 쓰기 실패: ${filePath}`, e.message);
        return false;
    }
}

// ===== 타임스탬프 =====
function formatTimestamp(date = new Date()) {
    return date.toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function getDateString(date = new Date()) {
    return date.toISOString().split('T')[0];
}

// ===== 경로 헬퍼 =====
const PATHS = {
    root: path.join(__dirname, '..'),
    config: path.join(__dirname, '..', 'config'),
    data: path.join(__dirname, '..', 'data'),
    sessions: path.join(__dirname, '..', 'sessions'),
    uploads: path.join(__dirname, '..', 'uploads'),
    accounts: path.join(__dirname, '..', 'config', 'accounts.json'),
    schedules: path.join(__dirname, '..', 'data', 'schedules.json'),
    history: path.join(__dirname, '..', 'data', 'history.json'),
    aiConfig: path.join(__dirname, '..', 'data', 'ai-config.json'),
    brandPersonas: path.join(__dirname, '..', 'data', 'brand-personas.json'),
    affiliateConfig: path.join(__dirname, '..', 'data', 'affiliate-config.json'),
    pipelineQueue: path.join(__dirname, '..', 'data', 'pipeline-queue.json'),
    pipelineConfig: path.join(__dirname, '..', 'data', 'pipeline-config.json'),
};

// 필요한 폴더 생성
function ensureDirectories() {
    [PATHS.config, PATHS.data, PATHS.sessions, PATHS.uploads].forEach(dir => {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });
}

module.exports = {
    randomDelay,
    log,
    readJSON,
    writeJSON,
    formatTimestamp,
    getDateString,
    PATHS,
    ensureDirectories,
    LOG_LEVELS,
};
