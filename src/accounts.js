const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { log, readJSON, writeJSON, PATHS, getDateString } = require('./utils');

let memoizedAccounts = null;

function loadAccounts(bypassCache = false) {
    if (memoizedAccounts && !bypassCache) return memoizedAccounts;
    
    let data = readJSON(PATHS.accounts);
    let accounts = data ? data.accounts || [] : [];

    // GitHub Actions 등을 위해 환경 변수에서 계정 정보를 가져오기 (파일이 비었거나 없는 경우)
    if (accounts.length === 0 && process.env.THREADS_ACCESS_TOKEN) {
        const tokens = process.env.THREADS_ACCESS_TOKEN.split(',').map(t => t.trim()).filter(t => t);
        
        tokens.forEach((token, index) => {
            accounts.push({
                id: `gha-account-${index}`,
                threadsUserId: `gha-user-id-${index}`, // 이후 auth 검증을 통해 실제 값으로 업데이트됨
                username: `gha_user_${index}`,
                displayName: `GHA Account ${index + 1}`,
                accessToken: token,
                status: 'active',
                createdAt: new Date().toISOString(),
                lastUpload: null,
                todayUploads: 0,
                dailyLimit: 250,
                totalUploads: 0,
                dailyResetDate: getDateString(),
            });
        });
    }

    memoizedAccounts = accounts;
    return accounts;
}

function updateAccountInMemory(threadsUserId, updates) {
    const accs = loadAccounts();
    let idx = accs.findIndex(a => a.threadsUserId === threadsUserId);
    
    // 매칭되는 ID가 없으면, 아직 실제 ID가 할당되지 않은 가상 계정(gha-account-X) 중 첫 번째를 선택
    if (idx === -1) {
        idx = accs.findIndex(a => a.id.startsWith('gha-account-') && a.threadsUserId.startsWith('gha-user-id-'));
    }

    if (idx !== -1) {
        accs[idx] = { ...accs[idx], ...updates };
        // 실제 threadsUserId로 업데이트
        if (threadsUserId) {
            accs[idx].threadsUserId = threadsUserId;
        }
    }
}



function saveAccounts(accounts) {
    return writeJSON(PATHS.accounts, { accounts });
}

/**
 * 계정 추가 (Access Token 기반)
 */
function addAccount(threadsUserId, username, displayName = '', accessToken) {
    const accounts = loadAccounts();

    // 중복 확인
    if (accounts.find(a => a.threadsUserId === threadsUserId || a.username === username)) {
        return { success: false, message: `이미 등록된 계정입니다: ${username} (${threadsUserId})` };
    }

    const account = {
        id: uuidv4(),
        threadsUserId,
        username,
        displayName: displayName || username,
        accessToken,
        status: 'active', // Token 인증 후 추가되므로 바로 active
        createdAt: new Date().toISOString(),
        lastUpload: null,
        todayUploads: 0,
        dailyLimit: 250, // 공식 API 제한 (보통 1일에 250회 등 넉넉함)
        totalUploads: 0,
        dailyResetDate: getDateString(),
    };

    accounts.push(account);
    saveAccounts(accounts);
    log('INFO', `API 계정 등록: @${username} (UID: ${threadsUserId})`);
    return { success: true, account };
}

function getAccounts() {
    const accounts = loadAccounts();
    const today = getDateString();
    let updated = false;
    accounts.forEach(a => {
        if (a.dailyResetDate !== today) {
            a.todayUploads = 0;
            a.dailyResetDate = today;
            updated = true;
        }
    });

    if (updated) saveAccounts(accounts);

    // 보안상 토큰 뒷부분 마스킹 (클라이언트 전달용도 포함이므로 여기서 직접 하거나 필터해서 호출)
    // 여기서는 일단 객체를 그대로 반환하되, 클라이언트 전달 시 api.js에서 마스킹하는 것이 좋음.
    return accounts;
}

function getAccount(id) {
    return loadAccounts().find(a => a.id === id);
}

function updateAccount(id, updates) {
    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.id === id);
    if (idx === -1) return { success: false, message: '계정을 찾을 수 없습니다.' };

    accounts[idx] = { ...accounts[idx], ...updates };
    saveAccounts(accounts);
    return { success: true, account: accounts[idx] };
}

function deleteAccount(id) {
    const accounts = loadAccounts();
    const idx = accounts.findIndex(a => a.id === id);
    if (idx === -1) return { success: false, message: '계정을 찾을 수 없습니다.' };

    const removed = accounts.splice(idx, 1)[0];
    saveAccounts(accounts);

    log('INFO', `계정 삭제: ${removed.username}`);
    return { success: true, message: `계정 삭제됨: @${removed.username}` };
}

function incrementUploadCount(id) {
    const accounts = loadAccounts();
    const account = accounts.find(a => a.id === id);
    if (!account) return false;

    const today = getDateString();
    if (account.dailyResetDate !== today) {
        account.todayUploads = 0;
        account.dailyResetDate = today;
    }

    account.todayUploads += 1;
    account.totalUploads += 1;
    account.lastUpload = new Date().toISOString();
    saveAccounts(accounts);
    return true;
}

function canUpload(id) {
    const account = getAccount(id);
    if (!account) return { allowed: false, reason: '계정을 찾을 수 없습니다.' };
    if (account.status !== 'active') return { allowed: false, reason: '토큰이 만료되었거나 비활성 계정입니다.' };

    const today = getDateString();
    const todayUploads = account.dailyResetDate === today ? account.todayUploads : 0;
    if (todayUploads >= account.dailyLimit) {
        return { allowed: false, reason: `일일 업로드 제한 (${account.dailyLimit}회) 도달` };
    }

    return { allowed: true, remaining: account.dailyLimit - todayUploads };
}

module.exports = {
    loadAccounts, getAccounts, getAccount,
    addAccount, updateAccount, deleteAccount,
    incrementUploadCount, canUpload, updateAccountInMemory,
};
