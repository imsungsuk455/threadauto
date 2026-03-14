const auth = require('./auth');
const accounts = require('./accounts');
const { log } = require('./utils');

async function testAccount(accountId) {
    const account = accounts.getAccount(accountId);
    if (!account) return { overall: 'error', message: '계정 정보를 찾을 수 없습니다.' };

    log('INFO', `API 토큰 테스트 시작: @${account.username} (${accountId})`);

    const results = {
        accountId,
        username: account.username,
        timestamp: new Date().toISOString(),
        steps: [],
        overall: 'pending',
    };

    try {
        results.steps.push({ step: 1, name: '토큰 형식 검사', status: 'running' });
        if (!account.accessToken) {
            results.steps[0].status = 'fail';
            results.steps[0].message = '토큰 정보 없음';
            results.overall = 'error';
            return results;
        }
        results.steps[0].status = 'pass';
        results.steps[0].message = '토큰이 확인됨';

        results.steps.push({ step: 2, name: '토큰 유효성 테스트 (Graph API /me)', status: 'running' });
        const res = await auth.checkSession(account.accessToken);

        if (res.valid) {
            results.steps[1].status = 'pass';
            results.steps[1].message = res.message;
            results.overall = 'pass';
        } else {
            results.steps[1].status = 'fail';
            results.steps[1].message = res.message;
            results.overall = 'session_expired';
        }

    } catch (error) {
        log('ERROR', `테스트 오류: ${error.message}`);
        results.overall = 'error';
        results.error = error.message;
    }

    log('INFO', `테스트 완료: ${account.username} → ${results.overall}`);
    return results;
}

module.exports = { testAccount };
