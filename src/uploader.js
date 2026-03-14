const axios = require('axios');
const accounts = require('./accounts');
const { log, readJSON, writeJSON, PATHS, formatTimestamp } = require('./utils');

const THREADS_API_BASE = 'https://graph.threads.net/v1.0';

/**
 * 게시물 업로드 (공식 Threads API)
 * imagePath: 단일 문자열(URL/로컬경로) 또는 배열(다중 URL)
 */
async function uploadPost(accountId, content, imagePath = null) {
    log('INFO', `API 업로드 시작 (계정 ID: ${accountId})`);

    // 시스템 업로드 가능 상태 확인
    const uploadCheck = accounts.canUpload(accountId);
    if (!uploadCheck.allowed) {
        return { success: false, message: uploadCheck.reason };
    }

    const account = accounts.getAccount(accountId);
    if (!account || !account.accessToken || !account.threadsUserId) {
        return { success: false, message: 'API 토큰 정보가 없는 계정입니다. 계정을 다시 등록해주세요.' };
    }

    try {
        let finalContainerId = null;
        let mediaType = 'TEXT';
        
        // 1. 미디어 판단 및 컨테이너 유형 결정
        const isMultiple = Array.isArray(imagePath);
        const hasMedia = imagePath && (isMultiple ? imagePath.length > 0 : true);

        if (!hasMedia) {
            // TEXT 업로드
            const res = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads`, null, {
                params: {
                    media_type: 'TEXT',
                    text: content,
                    access_token: account.accessToken
                }
            });
            finalContainerId = res.data?.id;
        } else if (isMultiple && imagePath.length > 1) {
            // CAROUSEL 업로드 (다중 미디어)
            mediaType = 'CAROUSEL';
            log('INFO', `Carousel 업로드 진행 (${imagePath.length}개 항목)`);
            
            const childIds = [];
            for (const url of imagePath) {
                if (childIds.length >= 10) {
                    log('WARN', 'Carousel 항목이 10개를 초과하여 나머지는 제외되었습니다.');
                    break;
                }
                
                if (!url.startsWith('http')) {
                    log('WARN', `로컬 경로는 Carousel에서 지원되지 않습니다: ${url}`);
                    continue;
                }

                const isVideo = url.toLowerCase().match(/\.(mp4|mov)/i) || url.toLowerCase().includes('video') || url.toLowerCase().includes('_v.');
                const childRes = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads`, null, {
                    params: {
                        media_type: isVideo ? 'VIDEO' : 'IMAGE',
                        [isVideo ? 'video_url' : 'image_url']: url,
                        is_carousel_item: true,
                        access_token: account.accessToken
                    }
                });
                if (childRes.data?.id) childIds.push(childRes.data.id);
            }

            if (childIds.length === 0) throw new Error('Carousel 아이템 생성에 실패했습니다.');

            // Child processing wait (Polling)
            log('INFO', 'Carousel 아이템 처리 대기 중...');
            for (const cId of childIds) {
                await waitForMediaProcessing(accountId, cId);
            }

            const carouselRes = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads`, null, {
                params: {
                    media_type: 'CAROUSEL',
                    children: childIds.join(','),
                    text: content,
                    access_token: account.accessToken
                }
            });
            finalContainerId = carouselRes.data?.id;
        } else {
            // 단일 미디어 업로드
            const singlePath = isMultiple ? imagePath[0] : imagePath;
            if (singlePath && typeof singlePath === 'string' && singlePath.startsWith('http')) {
                const isVideo = singlePath.toLowerCase().match(/\.(mp4|mov)/i) || singlePath.toLowerCase().includes('video') || singlePath.toLowerCase().includes('_v.');
                mediaType = isVideo ? 'VIDEO' : 'IMAGE';
                
                const res = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads`, null, {
                    params: {
                        media_type: mediaType,
                        [isVideo ? 'video_url' : 'image_url']: singlePath,
                        text: content,
                        access_token: account.accessToken
                    }
                });
                finalContainerId = res.data?.id;
            } else {
                // 로컬 이미지 (Multer 등으로 저장된 경로)
                log('WARN', '로컬 이미지는 공개 URL이 아니면 공식 API에서 지원하지 않습니다.');
                mediaType = 'TEXT';
                
                // 일단 텍스트로만이라도 발행
                const res = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads`, null, {
                    params: {
                        media_type: 'TEXT',
                        text: content,
                        access_token: account.accessToken
                    }
                });
                finalContainerId = res.data?.id;
            }
        }

        if (!finalContainerId) throw new Error('컨테이너 ID를 받아오지 못했습니다.');

        // 2. 미디어 처리 대기 (폴링)
        if (mediaType !== 'TEXT') {
            log('INFO', `${mediaType} 처리 상태 폴링 시작...`);
            await waitForMediaProcessing(accountId, finalContainerId);
        }

        // 3. Publish (실제 게시)
        let publishRes;
        const publishParams = {
            creation_id: finalContainerId,
            access_token: account.accessToken
        };

        try {
            publishRes = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads_publish`, null, { params: publishParams });
        } catch (publishErr) {
            log('WARN', `Publish 오류 발생, 5초 후 재시도... (${publishErr.message})`);
            await new Promise(r => setTimeout(r, 5000));
            publishRes = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads_publish`, null, { params: publishParams });
        }

        const mediaId = publishRes.data?.id;
        if (!mediaId) throw new Error('Publish에 실패하여 게시물 ID를 받지 못했습니다.');

        accounts.incrementUploadCount(accountId);

        log('INFO', `업로드 최종 완료 (Media ID: ${mediaId}, 타입: ${mediaType})`);

        const result = {
            success: true,
            message: `게시물 업로드 성공! (${mediaType})`,
            accountUsername: account.username,
            mediaId: mediaId,
            contentPreview: content.substring(0, 50),
            timestamp: formatTimestamp(),
        };

        if (mediaType === 'TEXT' && hasMedia) {
            result.warning = '로컬 이미지는 공식 API에서 지원되지 않아 텍스트만 발행되었습니다. 이미지를 포함하려면 공개 URL이나 터널링이 필요합니다.';
        }

        addToHistory({
            type: 'upload',
            accountId,
            accountUsername: account.username,
            content: content.substring(0, 200),
            hasImage: hasMedia,
            status: 'success',
            mediaId,
            timestamp: new Date().toISOString(),
        });

        return result;

    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        log('ERROR', `API 업로드 실패: ${errorMsg}`);

        addToHistory({
            type: 'upload',
            accountId,
            accountUsername: account?.username || accountId,
            content: content.substring(0, 200),
            hasImage: !!imagePath,
            status: 'failed',
            error: errorMsg,
            timestamp: new Date().toISOString(),
        });

        if (errorMsg.includes('Error validating access token') || errorMsg.includes('has expired')) {
            accounts.updateAccount(accountId, { status: 'expired' });
        }

        return { success: false, message: `업로드 실패: ${errorMsg}` };
    }
}


function addToHistory(entry) {
    const data = readJSON(PATHS.history) || { history: [] };
    data.history.unshift(entry);
    if (data.history.length > 500) data.history = data.history.slice(0, 500);
    writeJSON(PATHS.history, data);
}

function getHistory(limit = 50) {
    const data = readJSON(PATHS.history) || { history: [] };
    return data.history.slice(0, limit);
}

/**
 * 게시물에 댓글 달기 (제휴마케팅 링크용)
 */
async function replyToThread(accountId, threadId, commentText) {
    log('INFO', `댓글 달기 시작 (게시물: ${threadId})`);

    const account = accounts.getAccount(accountId);
    if (!account || !account.accessToken || !account.threadsUserId) {
        return { success: false, message: 'API 토큰 정보가 없는 계정입니다.' };
    }

    try {
        // 1. Reply 컨테이너 생성
        const createRes = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads`, null, {
            params: {
                media_type: 'TEXT',
                text: commentText,
                reply_to_id: threadId,
                access_token: account.accessToken
            }
        });

        const containerId = createRes.data?.id;
        if (!containerId) throw new Error('Reply 컨테이너 생성 실패');

        // 2. Publish
        const publishRes = await axios.post(`${THREADS_API_BASE}/${account.threadsUserId}/threads_publish`, null, {
            params: {
                creation_id: containerId,
                access_token: account.accessToken
            }
        });

        const replyId = publishRes.data?.id;
        if (!replyId) throw new Error('Reply Publish 실패');

        log('INFO', `댓글 달기 완료 (Reply ID: ${replyId})`);

        addToHistory({
            type: 'reply',
            accountId,
            accountUsername: account.username,
            content: commentText.substring(0, 200),
            parentThreadId: threadId,
            status: 'success',
            replyId,
            timestamp: new Date().toISOString(),
        });

        return { success: true, replyId, message: '댓글이 성공적으로 게시되었습니다!' };
    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        log('ERROR', `댓글 달기 실패: ${errorMsg}`);

        addToHistory({
            type: 'reply',
            accountId,
            accountUsername: account?.username || accountId,
            content: commentText.substring(0, 200),
            parentThreadId: threadId,
            status: 'failed',
            error: errorMsg,
            timestamp: new Date().toISOString(),
        });

        return { success: false, message: `댓글 달기 실패: ${errorMsg}` };
    }
}
/**
 * Meta 미디어 컨테이너 처리 완료 대기 (폴링)
 */
async function waitForMediaProcessing(accountId, containerId) {
    const account = accounts.getAccount(accountId);
    let attempts = 0;
    const maxAttempts = 30; // 최대 60초 대기

    log('INFO', `미디어 상태 확인 시작: ${containerId}`);

    while (attempts < maxAttempts) {
        try {
            const res = await axios.get(`${THREADS_API_BASE}/${containerId}`, {
                params: {
                    fields: 'status,error_message',
                    access_token: account.accessToken
                }
            });

            const { status, error_message } = res.data;
            log('DEBUG', `미디어 ${containerId} 상태: ${status}`);

            if (status === 'FINISHED') return true;
            if (status === 'ERROR') throw new Error(error_message || '미디어 처리 중 오류가 발생했습니다.');

        } catch (e) {
            if (e.response?.data?.error?.message) {
                log('ERROR', `상태 확인 API 오류: ${e.response.data.error.message}`);
                throw new Error(e.response.data.error.message);
            }
            log('WARN', `상태 확인 중 오류 (재시도): ${e.message}`);
        }

        await new Promise(r => setTimeout(r, 2000));
        attempts++;
    }

    throw new Error('미디어 처리 대기 시간이 초과되었습니다.');
}

module.exports = { uploadPost, addToHistory, getHistory, replyToThread };
