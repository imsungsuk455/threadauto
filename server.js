const express = require('express');
const path = require('path');
const { ensureDirectories, log } = require('./src/utils');
const scheduler = require('./src/scheduler');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 3000;

// 필요한 디렉토리 생성
ensureDirectories();

// 미들웨어
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// API 라우트
app.use('/api', apiRoutes);

// SPA 폴백
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 서버 시작
app.listen(PORT, () => {
    log('INFO', `🚀 Threads Auto 서버 시작: http://localhost:${PORT}`);

    // 기존 예약 복원
    scheduler.restoreSchedules();
});

// 종료 처리
process.on('SIGINT', () => {
    log('INFO', '서버 종료 중...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('INFO', '서버 종료 중...');
    process.exit(0);
});
