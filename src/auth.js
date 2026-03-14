const axios = require('axios');
const { log } = require('./utils');

const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

/**
 * Access Token 유효성 검증 및 계정 정보 조회 (공식 API)
 */
async function verifyAccessToken(accessToken) {
    log('INFO', 'Access Token 검증 시도...');

    try {
        // me 엔드포인트를 호출하여 사용자 ID와 username을 가져옵니다.
        const res = await axios.get(`${THREADS_API_BASE}/me?fields=id,username,name&access_token=${accessToken}`);
        const data = res.data;

        if (data && data.id) {
            log('INFO', `인증 성공: @${data.username} (ID: ${data.id})`);
            return {
                success: true,
                threadsUserId: data.id,
                username: data.username,
                displayName: data.name
            };
        } else {
            return { success: false, message: '유효하지 않은 응답 포맷입니다.' };
        }
    } catch (error) {
        log('ERROR', `인증 실패: ${error.response?.data?.error?.message || error.message}`);
        return { success: false, message: error.response?.data?.error?.message || 'Access Token이 유효하지 않습니다.' };
    }
}

/**
 * 세션(토큰) 유효성 확인용 (단순 프로필 조회)
 */
async function checkSession(accessToken) {
    if (!accessToken) return { valid: false, message: '토큰이 없습니다.' };

    try {
        await axios.get(`${THREADS_API_BASE}/me?fields=id&access_token=${accessToken}`);
        return { valid: true, message: '토큰이 유효합니다.' };
    } catch (error) {
        return { valid: false, message: '토큰이 만료되었거나 권한이 없습니다.' };
    }
}

module.exports = { verifyAccessToken, checkSession };
