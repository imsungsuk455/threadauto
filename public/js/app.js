// ===== State =====
let currentTab = 'dashboard';
let selectedTemplate = null;
let currentAIMode = 'brand';
let crawledData = null;
let selectedCrawlImages = []; // 다중 선택 지원을 위해 배열로 변경
let pipelineQueue = [];

// ===== API Helper =====
async function api(method, path, data = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (data && method !== 'GET') {
        options.body = JSON.stringify(data);
    }

    try {
        const res = await fetch(`/api${path}`, options);
        const contentType = res.headers.get('content-type');

        if (contentType && contentType.includes('application/json')) {
            return await res.json();
        } else {
            // JSON이 아닌 응답(주로 404 HTML이나 서버 오류 페이지) 처리
            const text = await res.text();
            console.error('Non-JSON response:', text);

            if (res.status === 404) {
                return { success: false, message: 'API 경로를 찾을 수 없습니다 (404). 서버를 재시작했는지 확인해주세요.' };
            }
            return { success: false, message: `서버 응답 오류 (${res.status}): JSON이 아닌 데이터가 반환되었습니다.` };
        }
    } catch (error) {
        console.error('API call failed:', error);
        return { success: false, message: '네트워크 또는 서버 연결 오류: ' + error.message };
    }
}

async function apiFormData(path, formData) {
    const res = await fetch(`/api${path}`, { method: 'POST', body: formData });
    return res.json();
}

// ===== Toast =====
function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || ''}</span> ${message}`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

// ===== Loading =====
function showLoading(text = '처리중...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-overlay').hidden = false;
}

function hideLoading() {
    document.getElementById('loading-overlay').hidden = true;
}

// ===== Tab Navigation =====
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        const tab = btn.dataset.tab;
        switchTab(tab);
    });
});

function switchTab(tab) {
    currentTab = tab;

    // Nav items
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');

    // Tab content
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    document.getElementById(`tab-${tab}`).classList.add('active');

    // Load data per tab
    switch (tab) {
        case 'dashboard': loadDashboard(); break;
        case 'pipeline': loadPipelineTab(); break;
        case 'upload': loadUploadTab(); break;
        case 'persona': loadPersonaTab(); break;
        case 'ai': loadAITab(); break;
        case 'accounts': loadAccounts(); break;
        case 'threads-scrape': loadThreadsScrapeTab(); break;
        case 'tiktok-scrape': loadTiktokScrapeTab(); break;
        case 'history': loadHistory(); break;
    }
}

// ===== Dashboard =====
async function loadDashboard() {
    try {
        const [accRes, histRes, schedRes, aiRes] = await Promise.all([
            api('GET', '/accounts'),
            api('GET', '/history?limit=10'),
            api('GET', '/schedules'),
            api('GET', '/ai/config'),
        ]);

        // Stats
        const accounts = accRes.accounts || [];
        document.getElementById('stat-accounts').textContent = accounts.length;

        const todayUploads = accounts.reduce((sum, a) => sum + (a.todayUploads || 0), 0);
        document.getElementById('stat-uploads-today').textContent = todayUploads;

        const activeSchedules = (schedRes.schedules || []).filter(s => s.status === 'active').length;
        document.getElementById('stat-schedules').textContent = activeSchedules;

        document.getElementById('stat-ai-status').textContent = aiRes.config?.hasApiKey ? '활성' : '미설정';

        // Recent activity
        const histEl = document.getElementById('recent-activity');
        const history = histRes.history || [];
        if (history.length === 0) {
            histEl.innerHTML = '<div class="empty-state">아직 활동 내역이 없습니다</div>';
        } else {
            histEl.innerHTML = history.slice(0, 8).map(h => `
                <div class="history-item">
                    <div class="history-icon ${h.status === 'success' ? 'success' : 'failed'}">
                        ${h.status === 'success' ? '✅' : '❌'}
                    </div>
                    <div class="history-info">
                        <div class="history-title">@${h.accountUsername || '?'}</div>
                        <div class="history-detail">${escapeHtml(h.content || '')}</div>
                    </div>
                    <div class="history-time">${formatTime(h.timestamp)}</div>
                </div>
            `).join('');
        }

        // Accounts overview
        const overviewEl = document.getElementById('accounts-overview');
        if (accounts.length === 0) {
            overviewEl.innerHTML = '<div class="empty-state">등록된 계정이 없습니다</div>';
        } else {
            overviewEl.innerHTML = accounts.map(a => `
                <div class="account-overview-item">
                    <span class="status-dot ${a.status === 'active' ? 'online' : ''}"></span>
                    <span class="account-overview-name">@${escapeHtml(a.username)}</span>
                    <span class="account-overview-uploads">${a.todayUploads || 0}/${a.dailyLimit || 10} 업로드</span>
                </div>
            `).join('');
        }
    } catch (e) {
        console.error('Dashboard load error:', e);
    }
}

// ===== Accounts =====
async function loadAccounts() {
    try {
        const res = await api('GET', '/accounts');
        const accounts = res.accounts || [];
        const listEl = document.getElementById('account-list');

        if (accounts.length === 0) {
            listEl.innerHTML = '<div class="empty-state">등록된 계정이 없습니다</div>';
            return;
        }

        listEl.innerHTML = accounts.map(a => `
            <div class="account-item">
                <div class="account-avatar">${(a.username || '?')[0].toUpperCase()}</div>
                <div class="account-info">
                    <div class="account-name">${escapeHtml(a.displayName || a.username)}</div>
                    <div class="account-username">@${escapeHtml(a.username)}</div>
                    <div class="account-meta">
                        <span>오늘: ${a.todayUploads || 0}/${a.dailyLimit || 10}</span>
                        <span>총: ${a.totalUploads || 0}회</span>
                    </div>
                </div>
                <span class="status-badge status-${a.status}">${getStatusLabel(a.status)}</span>
                <div class="account-actions">
                    <button class="btn btn-sm btn-secondary" onclick="testAccount('${a.id}')">토큰 테스트</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteAccount('${a.id}')">🗑️</button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        showToast('계정 목록 로드 실패', 'error');
    }
}

async function addAccount() {
    const accessToken = document.getElementById('add-access-token').value.trim();
    if (!accessToken) return showToast('Access Token을 입력하세요', 'warning');

    showLoading('토큰 인증 중...');
    const res = await api('POST', '/accounts', { accessToken });
    hideLoading();

    if (res.success) {
        const username = res.account ? res.account.username : '성공';
        showToast(`API 연동 성공: @${username}`, 'success');
        document.getElementById('add-access-token').value = '';
        loadAccounts();
    } else {
        showToast(res.message, 'error');
    }
}

async function testAccount(id) {
    showLoading('계정 테스트 중...');
    try {
        const res = await api('POST', `/accounts/${id}/test`);
        hideLoading();

        if (res.success && res.result) {
            const r = res.result;
            const statusMap = { pass: '✅ 정상', fail: '❌ 실패', warning: '⚠️ 경고', session_expired: '🔒 세션 만료', error: '❌ 오류' };
            showToast(`${statusMap[r.overall] || r.overall}`, r.overall === 'pass' ? 'success' : 'warning');
            loadAccounts();
        } else {
            showToast(res.message || '테스트 실패', 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('테스트 오류: ' + e.message, 'error');
    }
}

async function deleteAccount(id) {
    if (!confirm('이 계정을 삭제하시겠습니까?')) return;
    const res = await api('DELETE', `/accounts/${id}`);
    if (res.success) {
        showToast('계정 삭제됨', 'success');
        loadAccounts();
    } else {
        showToast(res.message, 'error');
    }
}

// ===== Upload =====
async function loadUploadTab() {
    const res = await api('GET', '/accounts');
    const select = document.getElementById('upload-account');
    const accounts = (res.accounts || []).filter(a => a.status === 'active');

    select.innerHTML = '<option value="">계정을 선택하세요</option>' +
        accounts.map(a => `<option value="${a.id}">@${escapeHtml(a.username)} (${a.todayUploads || 0}/${a.dailyLimit})</option>`).join('');

    // Init schedule datetime
    const dtInput = document.getElementById('schedule-datetime');
    if (dtInput) {
        const now = new Date();
        now.setMinutes(now.getMinutes() + 5);
        dtInput.min = now.toISOString().slice(0, 16);
        dtInput.value = now.toISOString().slice(0, 16);
    }

    loadScheduleList();
}

// Character count
document.getElementById('upload-content')?.addEventListener('input', function () {
    document.getElementById('upload-char-count').textContent = this.value.length;
});

// Image upload
document.getElementById('upload-image-area')?.addEventListener('click', () => {
    document.getElementById('upload-image').click();
});

document.getElementById('upload-image')?.addEventListener('change', function () {
    if (this.files && this.files.length > 0) {
        // 기존에 선택된 파일들이 있다면 합치기 (DataTransfer 활용)
        const currentFiles = window._uploadLocalFiles || [];
        const newFiles = Array.from(this.files);
        
        // 중복 체크 (파일명과 크기 기준 - 완벽하진 않으나 일반적인 상황 대응)
        const combined = [...currentFiles];
        newFiles.forEach(nf => {
            const exists = combined.some(cf => cf.name === nf.name && cf.size === nf.size);
            if (!exists) combined.push(nf);
        });
        
        window._uploadLocalFiles = combined;
        
        // input.files도 업데이트 (나중에 doUpload에서 input.files를 참조할 수 있으므로 동기화)
        const dt = new DataTransfer();
        combined.forEach(f => dt.items.add(f));
        this.files = dt.files;
    }
    refreshUploadPreview();
});

document.getElementById('upload-remove-image')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('upload-image').value = '';
    document.getElementById('upload-image-placeholder').hidden = false;
    document.getElementById('upload-image-preview').hidden = true;
});

async function doUpload() {
    const uploadMode = document.querySelector('input[name="upload-mode"]:checked').value;

    if (uploadMode === 'schedule') {
        await addSchedule();
        return;
    }

    const accountId = document.getElementById('upload-account').value;
    const content = document.getElementById('upload-content').value.trim();
    const remoteImageUrl = document.getElementById('upload-remote-image-url').value;
    const replyCheck = document.getElementById('upload-reply-check');
    const replyContent = document.getElementById('upload-reply-content').value.trim();

    if (!accountId) return showToast('계정을 선택하세요', 'warning');
    if (!content) return showToast('게시물 내용을 입력하세요', 'warning');

    const formData = new FormData();
    formData.append('accountId', accountId);
    formData.append('content', content);

    if (replyCheck.checked && replyContent) {
        formData.append('replyContent', replyContent);
    }

    const imageInput = document.getElementById('upload-image');
    if (imageInput.files && imageInput.files.length > 0) {
        for (let i = 0; i < imageInput.files.length; i++) {
            formData.append('image', imageInput.files[i]);
        }
    }
    
    if (window._designedThumbnailFile) {
        formData.append('image', window._designedThumbnailFile);
    }

    if (remoteImageUrl) {
        formData.append('imageUrl', remoteImageUrl);
    }

    showLoading('게시물 업로드 중...');
    try {
        const res = await apiFormData('/upload', formData);
        hideLoading();

        if (res.success) {
            showToast('게시물 업로드 성공! 🎉', 'success');
            document.getElementById('upload-content').value = '';
            document.getElementById('upload-char-count').textContent = '0';
            document.getElementById('upload-image').value = '';
            document.getElementById('upload-image-placeholder').hidden = false;
            document.getElementById('upload-image-preview').hidden = true;
            document.getElementById('upload-reply-check').checked = false;
            document.getElementById('upload-reply-content').value = '';
            document.getElementById('upload-reply-content').hidden = true;

            // 디자인 썸네일 초기화
            window._designedThumbnailFile = null;
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('업로드 오류: ' + e.message, 'error');
    }
}

function toggleUploadMode() {
    const mode = document.querySelector('input[name="upload-mode"]:checked').value;
    const scheduleContainer = document.getElementById('schedule-options-container');
    const btn = document.getElementById('btn-upload');

    if (mode === 'schedule') {
        scheduleContainer.hidden = false;
        btn.innerHTML = '<span class="btn-icon">📅</span> 예약 등록';
    } else {
        scheduleContainer.hidden = true;
        btn.innerHTML = '<span class="btn-icon">🚀</span> 업로드 실행';
    }
}

// ===== AI Content Generation =====
async function loadAITab() {
    try {
        const configRes = await api('GET', '/ai/config');
        const config = configRes.config || {};

        // API key status
        const statusDot = document.getElementById('ai-key-status');
        const statusText = document.getElementById('ai-key-status-text');
        if (config.hasApiKey) {
            statusDot.className = 'status-dot online';
            statusText.textContent = `API 키 설정됨 (${config.apiKey || '***'})`;
        } else {
            statusDot.className = 'status-dot';
            statusText.textContent = 'API 키가 설정되지 않았습니다';
        }

        // Model select
        if (config.model) {
            const select = document.getElementById('ai-model');
            const options = Array.from(select.options).map(o => o.value);
            if (options.includes(config.model)) {
                select.value = config.model;
                document.getElementById('custom-model-row').style.display = 'none';
            } else {
                select.value = 'custom';
                document.getElementById('ai-model-custom').value = config.model;
                document.getElementById('custom-model-row').style.display = 'flex';
            }
        }

        // Load sub-mode data
        loadPersonas();
        loadAffiliates();
    } catch (e) {
        console.error('AI tab load error:', e);
    }
}

// ===== AI Mode Sub-Tab Switching =====
function switchAIMode(mode) {
    currentAIMode = mode;
    document.querySelectorAll('.ai-mode-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.aimode === mode);
    });
    document.querySelectorAll('.ai-mode-content').forEach(el => {
        el.classList.toggle('active', el.id === `aimode-${mode}`);
    });
}

function toggleApiKeyVisibility() {
    const input = document.getElementById('ai-api-key');
    input.type = input.type === 'password' ? 'text' : 'password';
}

async function saveAIConfig() {
    const apiKey = document.getElementById('ai-api-key').value.trim();
    let model = document.getElementById('ai-model').value;
    if (model === 'custom') {
        model = document.getElementById('ai-model-custom').value.trim();
        if (!model) return showToast('커스텀 모델 아이디를 입력하세요', 'warning');
    }

    const data = {};
    if (apiKey) data.apiKey = apiKey;
    if (model) data.model = model;

    const res = await api('POST', '/ai/config', data);
    if (res.success) {
        showToast('AI 설정 저장 완료', 'success');
        document.getElementById('ai-api-key').value = '';
        loadAITab();
    } else {
        showToast(res.message, 'error');
    }
}

function checkCustomModel(val) {
    document.getElementById('custom-model-row').style.display = val === 'custom' ? 'flex' : 'none';
}

// ===== Brand Mode =====
async function loadPersonas() {
    try {
        const res = await api('GET', '/ai/brand/personas');
        const personas = res.personas || [];
        const listEl = document.getElementById('persona-list');
        const selectEl = document.getElementById('brand-persona-select');

        if (personas.length === 0) {
            listEl.innerHTML = '<div class="empty-state">등록된 페르소나가 없습니다</div>';
            selectEl.innerHTML = '<option value="">먼저 페르소나를 등록하세요</option>';
            return;
        }

        listEl.innerHTML = personas.map(p => `
            <div class="persona-item">
                <div class="persona-icon">🏢</div>
                <div class="persona-info">
                    <div class="persona-name">${escapeHtml(p.name)}</div>
                    <div class="persona-meta">톤: ${escapeHtml(p.tone || '미설정')} · 예시 ${(p.sampleTexts || []).length}개</div>
                </div>
                <div class="persona-actions">
                    <button class="btn btn-sm btn-danger" onclick="deletePersona('${p.id}')">🗑️</button>
                </div>
            </div>
        `).join('');

        selectEl.innerHTML = '<option value="">페르소나를 선택하세요</option>' +
            personas.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    } catch (e) {
        console.error('Load personas error:', e);
    }
}

// ===== Persona Management Workspace =====
async function loadPersonaTab() {
    renderPersonaListGrid();
}

async function renderPersonaListGrid() {
    try {
        const res = await api('GET', '/ai/brand/personas');
        const personas = res.personas || [];
        const listEl = document.getElementById('persona-list');

        if (personas.length === 0) {
            listEl.innerHTML = '<div class="empty-state">아직 등록된 페르소나가 없습니다. 스타일을 학습시켜보세요!</div>';
            return;
        }

        listEl.innerHTML = personas.map(p => `
            <div class="card persona-item-card" style="padding: 20px; border-left: 4px solid var(--primary-color);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
                    <div style="font-weight: 700; font-size: 18px;">👤 ${escapeHtml(p.name)}</div>
                    <div class="btn-group">
                        <button class="btn btn-sm btn-outline-primary" onclick="editPersona('${p.id}')" title="수정">✏️ 수정</button>
                        <button class="btn btn-sm btn-outline-danger" onclick="deletePersona('${p.id}')" title="삭제">🗑️</button>
                    </div>
                </div>
                <div style="font-size: 13px; color: var(--text-muted); line-height: 1.6;">
                    <div style="margin-bottom: 4px;"><strong>말투:</strong> ${escapeHtml(p.tone || '기본')}</div>
                    <div style="margin-bottom: 4px;"><strong>키워드:</strong> ${escapeHtml((p.keywords || []).join(', ') || '없음')}</div>
                    ${p.customInstructions ? `<div style="margin-bottom: 4px; color: var(--accent-purple-light);"><strong>커스텀 지시:</strong> ${escapeHtml(p.customInstructions)}</div>` : ''}
                    <div style="margin-top: 10px; padding: 10px; background: rgba(0,0,0,0.02); border-radius: 4px;">
                        <strong>스타일 예시:</strong><br>
                        ${escapeHtml((p.sampleTexts || [])[0] || '샘플 없음').substring(0, 120)}...
                    </div>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Render persona list error:', e);
    }
}

async function savePersona() {
    const editId = document.getElementById('persona-edit-id').value;
    const name = document.getElementById('persona-name').value.trim();
    const tone = document.getElementById('persona-tone').value.trim();
    const keywordsRaw = document.getElementById('persona-keywords').value.trim();
    const samplesRaw = document.getElementById('persona-samples').value.trim();
    const customInstructions = document.getElementById('persona-custom-instructions').value.trim();

    if (!name) return showToast('페르소나 이름을 입력하세요', 'warning');

    const keywords = keywordsRaw ? keywordsRaw.split(',').map(k => k.trim()).filter(k => k) : [];
    // 샘플 텍스트는 줄바꿈 또는 --- 로 구분
    const sampleTexts = samplesRaw ? samplesRaw.split(/\n|---/).map(s => s.trim()).filter(s => s) : [];

    showLoading(editId ? '페르소나 수정 중...' : '페르소나 전문가 학습 중...');
    
    let res;
    const payload = { name, tone, keywords, sampleTexts, customInstructions };
    
    if (editId) {
        res = await api('PUT', `/ai/brand/personas/${editId}`, payload);
    } else {
        res = await api('POST', '/ai/brand/personas', payload);
    }
    
    hideLoading();

    if (res.success) {
        showToast(editId ? `'${name}' 페르소나가 수정되었습니다.` : `'${name}' 페르소나가 성공적으로 학습되었습니다!`, 'success');
        resetPersonaForm();
        renderPersonaListGrid();
    } else {
        showToast(res.message, 'error');
    }
}

async function editPersona(id) {
    try {
        const res = await api('GET', '/ai/brand/personas');
        const persona = (res.personas || []).find(p => p.id === id);
        if (!persona) return showToast('페르소나를 찾을 수 없습니다.', 'error');

        document.getElementById('persona-edit-id').value = persona.id;
        document.getElementById('persona-name').value = persona.name || '';
        document.getElementById('persona-tone').value = persona.tone || '';
        document.getElementById('persona-keywords').value = (persona.keywords || []).join(', ');
        document.getElementById('persona-samples').value = (persona.sampleTexts || []).join('\n---\n');
        document.getElementById('persona-custom-instructions').value = persona.customInstructions || '';

        document.getElementById('btn-persona-save').innerHTML = '<span class="btn-icon">💾</span> 수정 내용 저장';
        document.getElementById('btn-persona-cancel').style.display = 'inline-block';
        
        // 상단으로 스크롤 이동
        const form = document.querySelector('.persona-form');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
    } catch (e) {
        console.error('Edit persona error:', e);
    }
}

function resetPersonaForm() {
    document.getElementById('persona-edit-id').value = '';
    document.getElementById('persona-name').value = '';
    document.getElementById('persona-tone').value = '';
    document.getElementById('persona-keywords').value = '';
    document.getElementById('persona-samples').value = '';
    document.getElementById('persona-learn-url').value = '';
    document.getElementById('persona-custom-instructions').value = '';
    
    document.getElementById('btn-persona-save').innerHTML = '<span class="btn-icon">✅</span> 페르소나 저장 및 적용';
    document.getElementById('btn-persona-cancel').style.display = 'none';
}

async function deletePersona(id) {
    if (!confirm('이 페르소나 스타일을 삭제하시겠습니까?')) return;
    const res = await api('DELETE', `/ai/brand/personas/${id}`);
    if (res.success) {
        showToast('페르소나 삭제됨', 'success');
        renderPersonaListGrid();
    }
}

async function learnPersonaFromUrl() {
    const url = document.getElementById('persona-learn-url').value.trim();
    if (!url) return showToast('분석할 링크를 입력하세요', 'warning');

    showLoading('AI가 스타일을 정밀 분석 중입니다... 🧠');
    try {
        const res = await api('POST', '/ai/brand/personas/learn', { url });
        hideLoading();

        if (res.success && res.persona) {
            const result = res.persona;
            if (result.tone) document.getElementById('persona-tone').value = result.tone;
            if (result.keywords && result.keywords.length) document.getElementById('persona-keywords').value = result.keywords.join(', ');
            if (result.sampleTexts && result.sampleTexts.length) {
                const current = document.getElementById('persona-samples').value;
                const newSample = result.sampleTexts.join('\n---\n');
                document.getElementById('persona-samples').value = current ? current + '\n---\n' + newSample : newSample;
            }
            showToast('스타일 분석 완료! 내용을 확인하고 저장하세요.', 'success');
        } else {
            showToast(res.message || '분석에 실패했습니다.', 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('분석 오류: ' + e.message, 'error');
    }
}

// ===== AI Generation Tab =====
async function loadAITab() {
    currentAIMode = 'affiliate';
    switchAIMode('affiliate');
    loadAIStatus();
}

async function loadAIStatus() {
    const aiRes = await api('GET', '/ai/config');
    const statusEl = document.getElementById('ai-key-status');
    const statusTextEl = document.getElementById('ai-key-status-text');

    if (aiRes.config?.hasApiKey) {
        statusEl.className = 'status-dot online';
        statusTextEl.textContent = 'AI 엔진 연결됨 (Gemini)';
    } else {
        statusEl.className = 'status-dot';
        statusTextEl.textContent = 'API 키를 설정해주세요';
    }
}

async function switchAIMode(mode) {
    currentAIMode = mode;
    document.querySelectorAll('.ai-mode-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.aimode === mode);
    });
    document.querySelectorAll('.ai-mode-content').forEach(c => {
        c.classList.toggle('active', c.id === `aimode-${mode}`);
    });

    loadPersonasForAISelect();
}

async function loadPersonasForAISelect() {
    try {
        const res = await api('GET', '/ai/brand/personas');
        const personas = res.personas || [];

        const affiliateSelect = document.getElementById('affiliate-persona-select');
        const brandSelect = document.getElementById('brand-persona-select-ai');
        const pipeSelect = document.getElementById('pipe-persona');

        const options = personas.map(p => `<option value="${p.id}">👤 ${escapeHtml(p.name)} 스타일</option>`).join('');

        const defaultOption = '<option value="">✨ 기본 스타일 (지정 안 함)</option>';

        if (affiliateSelect) affiliateSelect.innerHTML = defaultOption + options;
        if (brandSelect) brandSelect.innerHTML = '<option value="">페르소나를 선택하세요</option>' + options;
        if (pipeSelect) pipeSelect.innerHTML = defaultOption + options;

    } catch (e) {
        console.error('Load personas for select error:', e);
    }
}


// ===== Direct Affiliate Content Logic =====
async function generateAffiliateContentDirect() {
    const url = document.getElementById('affiliate-crawl-url').value.trim();
    const personaId = document.getElementById('affiliate-persona-select').value;
    const topic = document.getElementById('affiliate-topic').value.trim();

    if (!url) return showToast('상품 또는 제휴 URL을 입력하세요', 'warning');

    showLoading('상품 분석 및 홍보글 생성 중... 🚀');
    try {
        // 1. URL 크롤링
        const crawlRes = await api('POST', '/ai/affiliate/crawl', { url });
        if (!crawlRes.success) throw new Error('상품 정보를 가져오지 못했습니다: ' + crawlRes.message);

        const data = crawlRes.data;

        // 크롤링 결과 임시 필드에 저장 (미디어 검색 등을 위해)
        document.getElementById('affiliate-product').value = data.title || '';
        document.getElementById('affiliate-link').value = url;
        document.getElementById('affiliate-desc').value = data.description || (data.bodyText || '').substring(0, 300);
        // क्र롤링된 미디어가 있으면 가져오고, 없으면 빈 문자열
        let imageUrls = '';
        const mediaArr = [];
        if (data.images && data.images.length > 0) {
            data.images.slice(0, 5).forEach(m => mediaArr.push(m.src));
            imageUrls = mediaArr.join(',');
            document.getElementById('affiliate-image-urls').value = imageUrls;
        } else {
            document.getElementById('affiliate-image-urls').value = '';
        }

        // 플랫폼 자동 탐지
        let platform = 'other';
        if (url.includes('coupang')) platform = 'coupang-partners';
        else if (url.includes('naver')) platform = 'naver-brandconnect';
        else if (url.includes('aliexpress') || url.includes('ali')) platform = 'aliexpress';
        else if (url.includes('temu')) platform = 'temu';
        document.getElementById('affiliate-platform').value = platform;

        // 2. 임시 상품 등록
        const addRes = await api('POST', '/ai/affiliate/add', {
            platform,
            productName: data.title || '제휴 상품',
            link: url,
            description: data.description || (data.bodyText || '').substring(0, 500) || '',
            imageUrls
        });
        if (!addRes.success) throw new Error(addRes.message);

        const affiliateId = addRes.affiliate.id;

        // 3. 홍보글 생성
        const genRes = await api('POST', '/ai/affiliate/generate', { affiliateId, personaId, topic, language: 'ko' });
        hideLoading();

        if (genRes.success) {
            document.getElementById('affiliate-result-area').hidden = false;
            showAffiliateResult(genRes, mediaArr);
            showToast('홍보글 생성 완료!', 'success');
        } else {
            showToast(genRes.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('오류 발생: ' + e.message, 'error');
    }
}

async function generateBrandContent() {
    const personaId = document.getElementById('brand-persona-select-ai').value;
    const topic = document.getElementById('brand-topic-ai').value.trim();

    if (!personaId) return showToast('페르소나를 선택하세요', 'warning');
    if (!topic) return showToast('작성할 주제를 입력하세요', 'warning');

    showLoading('페르소나 맞춤 글 생성 중... ✨');
    try {
        const res = await api('POST', '/ai/brand/generate', { personaId, topic, language: 'ko' });
        hideLoading();

        if (res.success) {
            showResultCards('brand-result-area', 'brand-results', [res.content]);
            showToast('글 생성 완료!', 'success');
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('생성 오류: ' + e.message, 'error');
    }
}

async function searchMedia(platform) {
    const query = document.getElementById('affiliate-product').value.trim();
    if (!query) return showToast('상품명을 입력하거나 정보를 먼저 가져오세요', 'warning');

    const platformNames = { ddg: '구글/DuckDuckGo', pinterest: '핀터레스트', youtube: '유튜브' };
    showLoading(`${platformNames[platform] || platform}에서 미디어 검색 중... 🔍`);

    try {
        const res = await api('POST', '/ai/affiliate/search-media', { platform, query });
        hideLoading();

        if (res.success) {
            const resultsEl = document.getElementById('media-search-results');
            if (!res.media || res.media.length === 0) {
                resultsEl.innerHTML = '<div class="empty-state">검색 결과가 없습니다</div>';
                return;
            }

            resultsEl.innerHTML = res.media.map((m, idx) => `
                <div class="crawl-preview-media" onclick="selectMedia(this, '${escapeAttr(m.src)}')">
                    <img src="${m.src}" alt="media" onerror="this.parentElement.style.display='none'">
                    <div class="media-check">✓</div>
                </div>
            `).join('');

            showToast('검색 완료! 사용할 이미지를 선택하세요.', 'success');
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('검색 오류: ' + e.message, 'error');
    }
}

function selectMedia(el, url) {
    el.classList.toggle('selected');
    const selected = Array.from(document.querySelectorAll('#media-search-results .crawl-preview-media.selected'))
        .map(item => item.querySelector('img').src);

    document.getElementById('affiliate-image-urls').value = selected.join(',');
    showToast(`${selected.length}개의 미디어가 선택되었습니다.`, 'info');
}

async function generateAffiliateContentSimplified() {
    const productName = document.getElementById('affiliate-product').value.trim();
    const link = document.getElementById('affiliate-link').value.trim();
    const description = document.getElementById('affiliate-desc').value.trim();
    const personaId = document.getElementById('affiliate-persona-select').value;
    const topic = document.getElementById('affiliate-topic').value.trim();
    const platform = document.getElementById('affiliate-platform').value;

    if (!productName) return showToast('상품명을 입력하거나 정보를 먼저 가져오세요', 'warning');
    if (!link) return showToast('제휴 링크를 입력하세요', 'warning');

    // 임시로 상품을 등록하고 ID를 받아옴 (기존 API 활용을 위해)
    showLoading('홍보 콘텐츠 생성 중... 💰');
    try {
        const imageUrls = document.getElementById('affiliate-image-urls').value;
        // 1. 상품 등록 (백엔드에 임시로 저장)
        const addRes = await api('POST', '/ai/affiliate/add', { platform, productName, link, description, imageUrls });
        if (!addRes.success) throw new Error(addRes.message);

        const affiliateId = addRes.affiliate.id;

        // 2. 콘텐츠 생성
        const res = await api('POST', '/ai/affiliate/generate', { affiliateId, personaId, topic, language: 'ko' });
        hideLoading();

        if (res.success) {
            const mediaUrls = imageUrls ? imageUrls.split(',').filter(u => u) : [];
            showAffiliateResult(res, mediaUrls);
            showToast('홍보글 생성 완료!', 'success');
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('생성 오류: ' + e.message, 'error');
    }
}

async function generateAffiliateContent() { /* Redirect to simplified */ generateAffiliateContentSimplified(); }

function showAffiliateResult(res, mediaUrls = []) {
    const area = document.getElementById('affiliate-result-area');
    const container = document.getElementById('affiliate-results');
    area.hidden = false;

    const hasMedia = mediaUrls.length > 0;
    const firstMedia = hasMedia ? mediaUrls[0] : null;

    container.innerHTML = `
        <div class="ai-result-card">
            <div class="ai-result-meta">홍보글 · ${res.charCount}자 · ${res.platform || ''} · ${escapeHtml(res.productName || '')}</div>
            <div class="ai-result-content">${escapeHtml(res.content)}</div>
            ${firstMedia ? `
            <div style="margin:10px 0; position:relative; border-radius:8px; overflow:hidden; border:1px solid var(--border-color)">
                ${firstMedia.includes('.mp4') || firstMedia.includes('.mov') ?
                `<video src="${escapeAttr(firstMedia)}" style="width:100%; display:block;" controls autoplay muted loop></video>` :
                `<img src="${escapeAttr(firstMedia)}" style="width:100%; display:block;">`
            }
                ${mediaUrls.length > 1 ? `<div style="position:absolute; bottom:10px; right:10px; background:rgba(0,0,0,0.7); color:white; padding:4px 8px; border-radius:4px; font-size:12px;">+${mediaUrls.length - 1}개</div>` : ''}
            </div>` : ''}
            <div style="margin:10px 0; padding:8px 12px; background:rgba(245,158,11,0.1); border-radius:8px; font-size:12px; color:var(--accent-orange)">
                🔗 댓글 링크: ${escapeHtml(res.affiliateLink || '')}
            </div>
            <div class="ai-result-actions">
                <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${escapeAttr(res.content)}')">
                    📋 복사
                </button>
                <button class="btn btn-sm btn-primary" onclick="useAIContent('${escapeAttr(res.content)}', ${hasMedia ? JSON.stringify(mediaUrls).replace(/"/g, '&quot;') : 'null'})">
                    📤 업로드에 사용
                </button>
                <button class="btn btn-sm btn-success" onclick="postWithAffiliateLink('${escapeAttr(res.content)}', '${escapeAttr(res.affiliateLink || '')}')">
                    🚀 게시 + 댓글 링크
                </button>
            </div>
        </div>
    `;
}

async function postWithAffiliateLink(content, affiliateLink) {
    const accountSelect = document.getElementById('upload-account');
    if (!accountSelect) return showToast('업로드 탭에서 계정을 설정해주세요', 'warning');
    const accountId = accountSelect.value;
    if (!accountId) return showToast('업로드 탭에서 계정을 먼저 선택해주세요', 'warning');

    if (!confirm(`선택된 계정으로 홍보글을 게시하고 댓글에 링크를 달까요?\n\n링크: ${affiliateLink}`)) return;

    showLoading('게시 + 댓글 링크 진행 중... 🚀');
    try {
        const res = await api('POST', '/ai/affiliate/post', {
            accountId,
            content,
            affiliateLink,
            linkText: `🔗 자세한 정보는 여기서 확인하세요!\n${affiliateLink}`
        });
        hideLoading();

        if (res.success) {
            showToast(res.message, 'success');
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('게시 오류: ' + e.message, 'error');
    }
}

// ===== Crawl Mode =====
async function startCrawl() {
    const url = document.getElementById('crawl-url').value.trim();
    if (!url) return showToast('크롤링할 URL을 입력하세요', 'warning');

    showLoading('크롤링 중... 🕷️');
    try {
        const res = await api('POST', '/ai/crawl', { url });
        hideLoading();

        if (res.success) {
            crawledData = res.data;
            showCrawlPreview(res.data);
            showToast('크롤링 완료!', 'success');
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('크롤링 오류: ' + e.message, 'error');
    }
}

function showCrawlPreview(data) {
    const preview = document.getElementById('crawl-preview');
    preview.hidden = false;

    document.getElementById('crawl-title').textContent = data.title || '(제목 없음)';
    document.getElementById('crawl-desc').textContent = data.description || '';
    document.getElementById('crawl-body').textContent = (data.bodyText || '').substring(0, 500) + '...';

    const imagesEl = document.getElementById('crawl-images');
     if (data.images && data.images.length > 0) {
        imagesEl.innerHTML = data.images.slice(0, 15).map((m, idx) => {
            const isVideo = m.type === 'video' || (m.src && (m.src.includes('.mp4') || m.src.includes('.mov') || m.src.includes('youtube.com/embed')));
            const displayUrl = isVideo ? m.src : `/api/proxy-image?url=${encodeURIComponent(m.src)}`;
            
            return `
            <div class="crawl-preview-media ${idx === 0 ? 'selected' : ''}" 
                 onclick="toggleCrawlImage(this, '${escapeAttr(m.src)}')"
                 title="${escapeAttr(m.alt || '')}">
                ${isVideo ?
                    `<video src="${escapeAttr(m.src)}" muted loop onmouseover="this.play()" onmouseout="this.pause()"></video><span class="media-badge">VIDEO</span>` :
                    `<img src="${displayUrl}" alt="${escapeAttr(m.alt || '')}" onerror="this.style.display='none'">`
                }
                <div class="media-check">✓</div>
            </div>`;
        }).join('');
        selectedCrawlImages = [data.images[0].src]; // 기본적으로 첫 번째 이미지 선택
    } else {
        imagesEl.innerHTML = '<span style="font-size:12px;color:var(--text-muted)">추출된 미디어 없음</span>';
        selectedCrawlImages = [];
    }
}

function toggleCrawlImage(el, url) {
    if (el.classList.contains('selected')) {
        if (selectedCrawlImages.length <= 1) {
            return showToast('최소 한 개의 미디어는 선택되어야 합니다.', 'warning');
        }
        el.classList.remove('selected');
        selectedCrawlImages = selectedCrawlImages.filter(src => src !== url);
    } else {
        if (selectedCrawlImages.length >= 10) {
            return showToast('최대 10개까지만 선택 가능합니다.', 'warning');
        }
        el.classList.add('selected');
        selectedCrawlImages.push(url);
    }
    showToast(`미디어가 선택되었습니다. (총 ${selectedCrawlImages.length}개)`, 'info');
}

async function convertCrawledContent() {
    if (!crawledData) return showToast('먼저 크롤링을 실행하세요', 'warning');

    showLoading('Threads 게시물로 변환 중... ✨');
    try {
        const res = await api('POST', '/ai/crawl/generate', {
            url: crawledData.sourceUrl,
            language: 'ko'
        });
        hideLoading();

        if (res.success) {
            showCrawlResult(res.content, selectedCrawlImages);
            showToast('게시물 변환 완료!', 'success');
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('변환 오류: ' + e.message, 'error');
    }
}

function showCrawlResult(content, imageUrls) {
    const area = document.getElementById('crawl-result-area');
    const container = document.getElementById('crawl-results');
    area.hidden = false;

    const firstImage = Array.isArray(imageUrls) ? imageUrls[0] : imageUrls;
    const moreCount = Array.isArray(imageUrls) && imageUrls.length > 1 ? imageUrls.length - 1 : 0;

    container.innerHTML = `
        <div class="ai-result-card">
            <div class="ai-result-meta">변환 결과 · ${content.length}자 · 미디어 ${Array.isArray(imageUrls) ? imageUrls.length : (imageUrls ? 1 : 0)}개</div>
            <div class="ai-result-content">${escapeHtml(content)}</div>
            ${firstImage ? `
            <div style="margin-top:10px; position:relative; border-radius:8px; overflow:hidden; border:1px solid var(--border-color); background: #eee;">
                ${(firstImage.toLowerCase().includes('.mp4') || firstImage.toLowerCase().includes('.mov')) ?
                    `<video src="${escapeAttr(firstImage)}" style="width:100%; display:block;" controls muted></video>` :
                    `<img src="/api/proxy-image?url=${encodeURIComponent(firstImage)}" style="width:100%; display:block;">`
                }
                ${moreCount > 0 ? `<div style="position:absolute; bottom:10px; right:10px; background:rgba(0,0,0,0.7); color:white; padding:4px 8px; border-radius:4px; font-size:12px;">+${moreCount}장 더보기</div>` : ''}
            </div>` : ''}
            <div class="ai-result-actions">
                <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${escapeAttr(content)}')">
                    📋 복사
                </button>
                <button class="btn btn-sm btn-primary" onclick="useAIContent('${escapeAttr(content)}', ${JSON.stringify(imageUrls).replace(/"/g, '&quot;')})">
                    📤 업로드에 사용
                </button>
            </div>
        </div>
    `;
}

// ===== Shared Result Cards =====
function showResultCards(areaId, containerId, contents) {
    const area = document.getElementById(areaId);
    const container = document.getElementById(containerId);
    area.hidden = false;

    container.innerHTML = contents.map((content, i) => `
        <div class="ai-result-card">
            <div class="ai-result-meta">${contents.length > 1 ? `변형 ${i + 1}` : '생성 결과'} · ${content.length}자</div>
            <div class="ai-result-content">${escapeHtml(content)}</div>
            <div class="ai-result-actions">
                <button class="btn btn-sm btn-secondary" onclick="copyToClipboard('${escapeAttr(content)}')">
                    📋 복사
                </button>
                <button class="btn btn-sm btn-primary" onclick="useAIContent('${escapeAttr(content)}')">
                    📤 업로드에 사용
                </button>
            </div>
        </div>
    `).join('');
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('클립보드에 복사됨', 'success');
    }).catch(() => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
        showToast('클립보드에 복사됨', 'success');
    });
}

function useAIContent(content, imageUrl = null) {
    document.getElementById('upload-content').value = content;
    document.getElementById('upload-char-count').textContent = content.length;

    // 초기화
    window._designedThumbnailFile = null;
    const remoteInput = document.getElementById('upload-remote-image-url');

    if (imageUrl) {
        const urls = Array.isArray(imageUrl) ? imageUrl : [imageUrl];
        remoteInput.value = urls.join(',');
    } else {
        remoteInput.value = '';
    }

    refreshUploadPreview();
    switchTab('upload');
    showToast('업로드 탭에 콘텐츠가 입력되었습니다', 'info');
}

/**
 * 업로드 탭의 미디어 미리보기를 갱신합니다.
 * 디자인된 썸네일(blob) + 원격 이미지들을 합쳐서 보여줍니다.
 */
function refreshUploadPreview() {
    const remoteInput = document.getElementById('upload-remote-image-url');
    const placeholder = document.getElementById('upload-image-placeholder');
    const previewArea = document.getElementById('upload-image-preview');

    const remoteUrls = remoteInput.value ? remoteInput.value.split(',').filter(u => u) : [];
    const hasDesigned = !!window._designedThumbnailFile;
    const localFiles = window._uploadLocalFiles || [];
    const hasLocalFile = localFiles.length > 0;

    if (!hasDesigned && !hasLocalFile && remoteUrls.length === 0) {
        placeholder.hidden = false;
        previewArea.hidden = true;
        return;
    }

    placeholder.hidden = true;
    previewArea.hidden = false;

    // 미리보기 구성
    let html = '';
    const allMedias = [];

    // 1. 디자인된 썸네일
    if (hasDesigned) {
        allMedias.push({
            src: URL.createObjectURL(window._designedThumbnailFile),
            type: 'designed'
        });
    }

    // 2. 로컬 파일
    // input.files 대신 window._uploadLocalFiles 전역 변수 사용 (누적 관리용)
    for (let i = 0; i < localFiles.length; i++) {
        allMedias.push({
            src: URL.createObjectURL(localFiles[i]),
            type: 'file'
        });
    }
    // 3. 원격 URL들
    remoteUrls.forEach(url => {
        allMedias.push({
            src: url,
            type: 'remote'
        });
    });

    // 현재 미리보기에서 첫 번째 '디자인되지 않은' 이미지 저장 (썸네일 제작용)
    window._currentPreviewFirstMedia = allMedias.find(m => m.type !== 'designed')?.src;
    
    // 미디어가 생기면 썸네일 디자인 그룹 보이기 (현재는 항상 보이도록 설정됨)
    const thumbGroup = document.getElementById('upload-thumb-title-group');
    if (thumbGroup) thumbGroup.style.display = 'block';
    if (thumbGroup) thumbGroup.hidden = false;

    if (allMedias.length > 0) {
        html = `
            <div style="display: flex; flex-direction: column; gap: 12px; padding: 15px; background: #f9f9f9; border-radius: 8px; width: 100%; box-sizing: border-box;">
                <div class="threads-media-scroll" style="width: 100%; flex-wrap: nowrap; padding-bottom: 15px;">
                    ${allMedias.map((m, idx) => {
                        const srcLower = m.src.toLowerCase();
                        const isVideo = srcLower.includes('.mp4') || srcLower.includes('.mov') || srcLower.includes('video') || srcLower.includes('_v.');
                        let mediaHtml = '';
                        if (isVideo) {
                            mediaHtml = `<video src="${escapeAttr(m.src)}" style="width: 100%; height: 100%; object-fit: cover;"></video><span class="media-badge" style="position:absolute; top:4px; left:4px; background:rgba(0,0,0,0.6); color:white; font-size:9px; padding:1px 4px; border-radius:3px;">VIDEO</span>`;
                        } else {
                            // 프록시 적용 (로컬 생성 Blob인 경우는 제외)
                            const displayUrl = m.type === 'remote' ? `/api/proxy-image?url=${encodeURIComponent(m.src)}` : m.src;
                            mediaHtml = `<img src="${displayUrl}" style="width: 100%; height: 100%; object-fit: cover;">`;
                        }

                        return `
                        <div style="width: 120px; height: 120px; border-radius: 6px; overflow: hidden; border: ${idx === 0 ? '3px solid var(--primary-color)' : '1px solid var(--border-color)'}; position: relative; box-shadow: 0 2px 5px rgba(0,0,0,0.1); cursor: pointer;" onclick="window.open('${escapeAttr(m.src)}', '_blank')">
                            ${mediaHtml}
                            ${idx === 0 ? '<span style="position:absolute; bottom:0; left:0; right:0; background:var(--primary-color); color:white; font-size:10px; font-weight:bold; text-align:center; padding:2px 0;">MAIN</span>' : ''}
                            <button class="remove-btn" style="position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; line-height: 20px; font-size: 14px; background: rgba(255,0,0,0.8);" onclick="removeMediaByIndex(event, ${idx}, '${m.type}')">✕</button>
                        </div>
                        `;
                    }).join('')}
                    <div style="width: 120px; height: 120px; border: 2px dashed #ccc; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: #999; cursor: pointer; transition: 0.2s;" onmouseover="this.style.borderColor= 'var(--primary-color)'; this.style.color='var(--primary-color)'" onmouseout="this.style.borderColor='#ccc'; this.style.color='#999'" onclick="document.getElementById('upload-image').click()">
                        <div style="text-align: center;">
                            <div style="font-size: 24px; margin-bottom: 4px;">+</div>
                            <div style="font-size: 12px;">추가</div>
                        </div>
                    </div>
                </div>
                <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px solid #eee;">
                    <div style="font-size: 13px; font-weight: bold; color: var(--primary-color);">
                        ${hasDesigned ? '🎨 디자인 썸네일 포함 ' : ''}총 ${allMedias.length}개 미디어
                    </div>
                    <button class="btn btn-outline" style="padding: 4px 10px; font-size: 12px;" onclick="clearUploadImages(event)">전체 삭제</button>
                </div>
            </div>
        `;
        previewArea.innerHTML = html;
        previewArea.hidden = false;
        document.getElementById('upload-image-placeholder').hidden = true;
    } else {
        previewArea.hidden = true;
        document.getElementById('upload-image-placeholder').hidden = false;
    }
}

function removeMediaByIndex(e, index, type) {
    if (e) e.stopPropagation();

    const uploadImageInput = document.getElementById('upload-image');
    const hasDesigned = !!window._designedThumbnailFile;
    const localFiles = uploadImageInput.files;
    const numLocal = localFiles ? localFiles.length : 0;

    if (type === 'designed') {
        window._designedThumbnailFile = null;
    } else if (type === 'file') {
        const localFiles = window._uploadLocalFiles || [];
        if (localFiles.length > 0) {
            const hasDesigned = !!window._designedThumbnailFile;
            const fileIdxInLocal = hasDesigned ? index - 1 : index;
            
            // 전역 배열에서 삭제
            localFiles.splice(fileIdxInLocal, 1);
            window._uploadLocalFiles = localFiles;
            
            // input.files 동기화
            const dt = new DataTransfer();
            localFiles.forEach(f => dt.items.add(f));
            document.getElementById('upload-image').files = dt.files;
        }
    } else if (type === 'remote') {
        const remoteInput = document.getElementById('upload-remote-image-url');
        let urls = remoteInput.value ? remoteInput.value.split(',').filter(u => u) : [];

        // remote 인덱스 계산: 전체 index - (designed 갯수) - (local 갯수)
        const urlIndex = index - (hasDesigned ? 1 : 0) - numLocal;

        if (urlIndex >= 0 && urlIndex < urls.length) {
            urls.splice(urlIndex, 1);
            remoteInput.value = urls.join(',');
        }
    }

    refreshUploadPreview();
}

function clearUploadImages(e) {
    if (e) e.stopPropagation();
    document.getElementById('upload-image').value = '';
    document.getElementById('upload-remote-image-url').value = '';
    document.getElementById('upload-image-placeholder').hidden = false;
    document.getElementById('upload-image-preview').hidden = true;

    // 디자인된 썸네일 초기화
    window._designedThumbnailFile = null;
    window._uploadLocalFiles = [];

    // Restore original single image preview structure for next time
    document.getElementById('upload-image-preview').innerHTML = `
        <div class="preview-container">
            <img id="upload-preview-img" src="" alt="Preview">
            <button id="upload-remove-image" class="remove-btn" onclick="clearUploadImages(event)">✕</button>
        </div>
    `;
}

// ===== Schedule =====
// Schedule tab merged into upload - no separate loadScheduleTab needed

async function loadScheduleList() {
    const res = await api('GET', '/schedules');
    const schedules = res.schedules || [];
    const listEl = document.getElementById('schedule-list');

    if (schedules.length === 0) {
        listEl.innerHTML = '<div class="empty-state">등록된 예약이 없습니다</div>';
        return;
    }

    listEl.innerHTML = schedules.map(s => {
        const statusClass = { pending: 'status-pending', active: 'status-active', completed: 'status-active', failed: 'status-expired', cancelled: 'status-disabled' };
        const statusLabel = { pending: '대기중', active: '활성', completed: '완료', failed: '실패', cancelled: '취소' };
        const timeInfo = s.scheduleType === 'once'
            ? `📌 ${formatTime(s.dateTime)}`
            : `🔁 ${s.repeatLabel || s.cronExpression}`;

        return `
            <div class="schedule-item">
                <div class="schedule-info">
                    <div class="schedule-type">${timeInfo}</div>
                    <div class="schedule-content">${escapeHtml(s.content || '')}</div>
                    <div class="schedule-time">생성: ${formatTime(s.createdAt)} · 실행: ${s.runCount || 0}회</div>
                </div>
                <span class="status-badge ${statusClass[s.status] || ''}">${statusLabel[s.status] || s.status}</span>
                <button class="btn btn-sm btn-danger" onclick="deleteSchedule('${s.id}')">🗑️</button>
            </div>
        `;
    }).join('');
}

function toggleScheduleType() {
    const type = document.querySelector('input[name="schedule-type"]:checked').value;
    document.getElementById('schedule-once-options').hidden = type !== 'once';
    document.getElementById('schedule-repeat-options').hidden = type !== 'repeat';
}

function setCron(event, expression, label) {
    document.getElementById('schedule-cron').value = expression;
    document.getElementById('schedule-cron-label').textContent = label;

    document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    if (event && event.target) {
        event.target.classList.add('active');
    }
}

async function addSchedule() {
    const accountId = document.getElementById('upload-account').value;
    const content = document.getElementById('upload-content').value.trim();
    const scheduleType = document.querySelector('input[name="schedule-type"]:checked').value;
    const remoteImageUrl = document.getElementById('upload-remote-image-url').value;

    if (!accountId) return showToast('계정을 선택하세요', 'warning');
    if (!content) return showToast('게시물 내용을 입력하세요', 'warning');

    const formData = new FormData();
    formData.append('accountId', accountId);
    formData.append('content', content);
    formData.append('scheduleType', scheduleType);

    if (scheduleType === 'once') {
        const dateTime = document.getElementById('schedule-datetime').value;
        if (!dateTime) return showToast('예약 날짜/시간을 설정하세요', 'warning');
        formData.append('dateTime', dateTime);
    } else {
        const cronExpression = document.getElementById('schedule-cron').value.trim();
        const repeatLabel = document.getElementById('schedule-cron-label').textContent;
        if (!cronExpression) return showToast('Cron 표현식을 입력하세요', 'warning');
        formData.append('cronExpression', cronExpression);
        formData.append('repeatLabel', repeatLabel);
    }

    // 미디어 추가
    const imageInput = document.getElementById('upload-image');
    if (imageInput.files && imageInput.files.length > 0) {
        for (let i = 0; i < imageInput.files.length; i++) {
            formData.append('image', imageInput.files[i]);
        }
    }
    
    if (window._designedThumbnailFile) {
        formData.append('image', window._designedThumbnailFile);
    }

    if (remoteImageUrl) {
        formData.append('imageUrl', remoteImageUrl);
    }

    showLoading('예약 등록 중...');
    const res = await apiFormData('/schedules', formData);
    hideLoading();

    if (res.success) {
        showToast('예약 등록 완료! 📅', 'success');
        document.getElementById('upload-content').value = '';
        document.getElementById('upload-char-count').textContent = '0';
        clearUploadImages();
        loadScheduleList();
    } else {
        showToast(res.message, 'error');
    }
}

async function deleteSchedule(id) {
    if (!confirm('이 예약을 삭제하시겠습니까?')) return;
    const res = await api('DELETE', `/schedules/${id}`);
    if (res.success) {
        showToast('예약 삭제됨', 'success');
        loadScheduleList();
    } else {
        showToast(res.message, 'error');
    }
}

// ===== History =====
async function loadHistory() {
    try {
        const res = await api('GET', '/history?limit=50');
        const history = res.history || [];
        const listEl = document.getElementById('history-list');

        if (history.length === 0) {
            listEl.innerHTML = '<div class="empty-state">아직 히스토리가 없습니다</div>';
            return;
        }

        listEl.innerHTML = history.map(h => `
            <div class="history-item">
                <div class="history-icon ${h.status === 'success' ? 'success' : 'failed'}">
                    ${h.status === 'success' ? '✅' : '❌'}
                </div>
                <div class="history-info">
                    <div class="history-title">
                        @${escapeHtml(h.accountUsername || '?')}
                        ${h.hasImage ? ' 🖼️' : ''}
                        ${h.type === 'reply' ? ' 💬' : ''}
                    </div>
                    <div class="history-detail">${escapeHtml(h.content || '')}</div>
                    ${h.error ? `<div class="history-detail" style="color: var(--accent-red);">⚠️ ${escapeHtml(h.error)}</div>` : ''}
                </div>
                <div class="history-time">${formatTime(h.timestamp)}</div>
            </div>
        `).join('');
    } catch (e) {
        showToast('히스토리 로드 실패', 'error');
    }
}

// ===== Utilities =====
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '');
}

function formatTime(isoStr) {
    if (!isoStr) return '-';
    try {
        const d = new Date(isoStr);
        return d.toLocaleString('ko-KR', {
            timeZone: 'Asia/Seoul',
            month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch (e) {
        return isoStr;
    }
}

function getStatusLabel(status) {
    const labels = { active: '활성', pending: '대기중', expired: '만료', disabled: '비활성' };
    return labels[status] || status;
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
    hideLoading();
    loadDashboard();
});

// ==========================================
// 8. AI 자동 콘텐츠 생성 (기존 파이프라인) 관련 로직
// ==========================================

async function loadPipelineTab() {
    await Promise.all([
        loadPipelineQueue(),
        updatePipelineStatus(),
        loadPipelineConfig(),
        loadPipelineAccounts(),
        loadPipelinePersonas()
    ]);
}

async function loadPipelineAccounts() {
    try {
        const res = await api('GET', '/accounts');
        const select = document.getElementById('pipe-account');
        if (!select) return;
        const accounts = (res.accounts || []).filter(a => a.status === 'active');
        select.innerHTML = '<option value="">발행 계정 선택...</option>' +
            accounts.map(a => `<option value="${a.id}">@${escapeHtml(a.username)}</option>`).join('');
    } catch (e) {
        console.error('파이프라인 계정 로드 실패:', e);
    }
}

async function loadPipelinePersonas() {
    try {
        const res = await api('GET', '/ai/brand/personas');
        const select = document.getElementById('pipe-persona');
        if (!select) return;
        const personas = res.personas || [];
        select.innerHTML = '<option value="">적용할 페르소나 선택 (기본값)</option>' +
            personas.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
    } catch (e) {
        console.error('파이프라인 페르소나 로드 실패:', e);
    }
}

async function loadPipelineConfig() {
    try {
        const res = await api('GET', '/pipeline/config');
        if (res.success && res.config) {
            const cfg = res.config;
            if (document.getElementById('cfg-coupang-access')) document.getElementById('cfg-coupang-access').value = cfg.coupangAccessKey || '';
            if (document.getElementById('cfg-coupang-secret')) document.getElementById('cfg-coupang-secret').value = cfg.coupangSecretKey || '';
            if (document.getElementById('cfg-naver-id')) document.getElementById('cfg-naver-id').value = cfg.naverClientId || '';
            if (document.getElementById('cfg-naver-secret')) document.getElementById('cfg-naver-secret').value = cfg.naverClientSecret || '';
            if (document.getElementById('cfg-rss-feeds') && cfg.defaultRssFeeds) {
                document.getElementById('cfg-rss-feeds').value = cfg.defaultRssFeeds.join('\n');
            }
            if (cfg.savedRssFeeds) {
                renderSavedRssList(cfg.savedRssFeeds);
            }
        }
    } catch (e) {
        console.error('파이프라인 설정 로딩 실패:', e);
    }
}

async function savePipelineConfig() {
    const config = {
        coupangAccessKey: document.getElementById('cfg-coupang-access').value.trim(),
        coupangSecretKey: document.getElementById('cfg-coupang-secret').value.trim(),
        naverClientId: document.getElementById('cfg-naver-id').value.trim(),
        naverClientSecret: document.getElementById('cfg-naver-secret').value.trim(),
        defaultRssFeeds: document.getElementById('cfg-rss-feeds').value.split('\n').map(s => s.trim()).filter(s => s)
    };

    try {
        const res = await api('POST', '/pipeline/config', config);
        if (res.success) {
            showToast('설정이 저장되었습니다.', 'success');
        } else {
            showToast(res.message || '설정 저장 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

async function loadPipelineQueue() {
    try {
        const filter = document.getElementById('pipe-filter')?.value || 'all';
        const url = filter === 'all' ? '/pipeline/queue' : `/pipeline/queue?status=${filter}`;

        const res = await api('GET', url);
        if (res.success) {
            pipelineQueue = res.items;
            renderPipelineQueue();
        }
    } catch (e) {
        console.error('대기열 로딩 실패:', e);
    }
}

async function updatePipelineStatus() {
    try {
        const res = await api('GET', '/pipeline/status');
        if (res.success && res.queue) {
            const badge = document.getElementById('pipeline-pending-count');
            if (badge) {
                badge.textContent = `${res.queue.pending || 0}건`;
                if (res.queue.pending > 0) {
                    badge.classList.add('bg-danger', 'text-white');
                } else {
                    badge.classList.remove('bg-danger', 'text-white');
                }
            }
        }
    } catch (e) {
        console.error('파이프라인 상태 조회 실패:', e);
    }
}

function renderPipelineQueue() {
    const tbody = document.getElementById('pipeline-queue-list');
    if (!tbody) return;

    if (pipelineQueue.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">표시할 항목이 없습니다.</td></tr>';
        return;
    }

    tbody.innerHTML = pipelineQueue.map(item => {
        // 상태 뱃지
        const statusMap = {
            'pending': '<span class="badge bg-secondary text-white">수집됨</span>',
            'processed': '<span class="badge bg-primary text-white">가공됨</span>',
            'published': '<span class="badge bg-success text-white">발행 완료</span>',
            'failed': '<span class="badge bg-danger text-white">실패</span>'
        };
        const statusBadge = statusMap[item.status] || '<span class="badge bg-light">알 수 없음</span>';

        // 유형 뱃지
        const typeMap = {
            'coupang': '🔵 쿠팡',
            'naver': '🟢 네이버',
            'rss': '🟠 RSS',
            'crawl': '🌐 웹크롤'
        };
        const typeText = typeMap[item.type] || item.type;

        // 미디어 요약
        const mediaCount = item.mediaUrls ? item.mediaUrls.length : 0;
        const mediaInfo = mediaCount > 0 ? `이미지 ${mediaCount}장` : '-';

        // 날짜
        const dateStr = item.createdAt ? new Date(item.createdAt).toLocaleString('ko-KR') : '-';

        // 내용(툴팁)
        const displayTitle = item.sourceData?.title || '제목 없음';

        // 액션 버튼
        let actionBtn = '';
        if (item.status === 'pending') {
            actionBtn = `<button class="btn btn-sm btn-primary" onclick="processPipelineItem('${item.id}')">글 가공 ✍️</button>`;
        } else if (item.status === 'processed') {
            actionBtn = `<button class="btn btn-sm btn-success" onclick="editPipelineItem('${item.id}')">검토 및 수정 ↗️</button>`;
        } else if (item.status === 'failed') {
            actionBtn = `<button class="btn btn-sm btn-outline-danger" onclick="retryPipelineItem('${item.id}')">재시도</button>`;
        }
        actionBtn += ` <button class="btn btn-sm btn-outline-secondary" onclick="deletePipelineItem('${item.id}')">삭제</button>`;

        return `
            <tr>
                <td>${statusBadge}</td>
                <td><small>${typeText}</small></td>
                <td title="${displayTitle}"><div style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${displayTitle}</div></td>
                <td><small class="text-muted">${mediaInfo}</small></td>
                <td><small class="text-muted">${dateStr}</small></td>
                <td>${actionBtn}</td>
            </tr>
        `;
    }).join('');
}

async function runPipelineCollect(type) {
    let payload = {};
    if (type === 'coupang') {
        const kw = document.getElementById('pipe-coupang-keyword').value;
        if (!kw) return showToast('쿠팡 검색어를 입력하세요.', 'error');
        payload = { coupangKeyword: kw, coupangLimit: 5 };
    } else if (type === 'naver') {
        const kw = document.getElementById('pipe-naver-keyword')?.value;
        const link = document.getElementById('pipe-naver-link')?.value;
        if (!kw) return showToast('네이버 검색어를 입력하세요.', 'error');
        payload = {
            naverKeyword: kw,
            naverLimit: link ? 1 : 5,
            naverLink: link || undefined
        };
    } else if (type === 'url') {
        const url = document.getElementById('pipe-url').value;
        if (!url) return showToast('웹 URL을 입력하세요.', 'error');
        payload = { urls: [url] };
    } else if (type === 'rss') {
        const url = document.getElementById('pipe-rss').value.trim();
        if (url) {
            payload = { rssFeeds: [url], rssLimit: 5 };
        } else {
            // 소스가 비어있으면 설정된 기본 피드 사용
            const res = await api('GET', '/pipeline/config');
            if (res.success && res.config.defaultRssFeeds && res.config.defaultRssFeeds.length > 0) {
                payload = { rssFeeds: res.config.defaultRssFeeds, rssLimit: 5 };
                showToast('등록된 모든 RSS 소스에서 수집을 시작합니다.', 'info');
            } else {
                return showToast('RSS 피드 URL을 입력하거나 설정에 소스를 등록하세요.', 'warning');
            }
        }
    }

    try {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = '수집 중...';
        btn.disabled = true;

        const res = await api('POST', '/pipeline/collect', payload);

        btn.textContent = originalText;
        btn.disabled = false;

        if (res.success) {
            showToast(`${res.totalCollected}건 수집 완료!`, 'success');
            if (res.errors && res.errors.length > 0) {
                showToast(`${res.errors.length}건 수집 중 오류 발생`, 'warning');
            }
            if (type === 'url') document.getElementById('pipe-url').value = '';
            if (type === 'rss') document.getElementById('pipe-rss').value = '';

            loadPipelineQueue();
            updatePipelineStatus();
        } else {
            showToast(res.message || '수집 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

async function runPipelineProcess() {
    try {
        const btn = event.target;
        const originalText = btn.textContent;
        const personaId = document.getElementById('pipe-persona')?.value || '';

        btn.textContent = '가공하는 중 (AI)...';
        btn.disabled = true;

        const res = await api('POST', '/pipeline/process', { personaId });

        btn.textContent = originalText;
        btn.disabled = false;

        if (res.success) {
            showToast(`가공 완료! (성공: ${res.processed}건, 실패: ${res.failed}건)`, 'success');
            loadPipelineQueue();
            updatePipelineStatus();
        } else {
            showToast(res.message || '가공 단계 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
        event.target.disabled = false;
        event.target.textContent = '가공 시작';
    }
}

async function runPipelinePublish() {
    const accountId = document.getElementById('pipe-account').value;
    if (!accountId) {
        return showToast('발행할 계정을 선택해주세요.', 'error');
    }

    try {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = '스레드에 발행 중...';
        btn.disabled = true;

        const res = await api('POST', '/pipeline/publish', { accountId });

        btn.textContent = originalText;
        btn.disabled = false;

        if (res.success) {
            showToast(`발행 완료! (성공: ${res.published}건, 실패: ${res.failed}건)`, 'success');
            loadPipelineQueue();
            updatePipelineStatus();
        } else {
            showToast(res.message || '발행 단계 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
        event.target.disabled = false;
        event.target.textContent = '발행 시작';
    }
}

async function runPipelineFull() {
    const accountId = document.getElementById('pipe-account').value;
    if (!accountId) {
        if (!confirm('발행 계정이 선택되지 않았습니다. 발행 단계를 건너뛰고 수집/가공만 진행할까요?')) {
            return;
        }
    }

    const coupangKw = document.getElementById('pipe-coupang-keyword').value;
    const naverKw = document.getElementById('pipe-naver-keyword').value;

    const payload = { accountId };
    if (coupangKw) { payload.coupangKeyword = coupangKw; payload.coupangLimit = 5; }
    if (naverKw) { payload.naverKeyword = naverKw; payload.naverLimit = 5; }

    try {
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = '전체 파이프라인 작동 중...';
        btn.disabled = true;

        showToast('자동 생성 시작 (잠시만 기다려주세요)', 'info');
        const res = await api('POST', '/pipeline/run', payload);

        btn.textContent = originalText;
        btn.disabled = false;

        if (res.success) {
            let msg = '자동화 완료! ';
            if (res.phases.collect) msg += `수집: ${res.phases.collect.totalCollected || 0}건, `;
            if (res.phases.process) msg += `가공: ${res.phases.process.processed || 0}건, `;
            if (res.phases.publish) msg += `발행: ${res.phases.publish.published || 0}건`;

            showToast(msg, 'success');
            loadPipelineQueue();
            updatePipelineStatus();
        } else {
            showToast(res.message || '전체 파이프라인 실행 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
        event.target.disabled = false;
        event.target.textContent = '전체 코스 실행';
    }
}

async function retryPipelineItem(id) {
    const accountId = document.getElementById('pipe-account').value;
    if (!accountId) {
        return showToast('재시도 시 사용할 계정을 선택해주세요.', 'error');
    }

    try {
        showToast('항목 재시도 중...', 'info');
        const res = await api('POST', `/pipeline/retry/${id}`, { accountId });

        if (res.success) {
            showToast('재시도 성공 및 발행 완료!', 'success');
            loadPipelineQueue();
            updatePipelineStatus();
        } else {
            showToast(res.message || '재시도 실패', 'error');
            loadPipelineQueue();
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

async function processPipelineItem(id) {
    const personaId = document.getElementById('pipe-persona')?.value || '';
    showLoading('AI 글 가공 중... ✨');
    try {
        const res = await api('POST', `/pipeline/process-item/${id}`, { personaId });
        hideLoading();
        if (res.success) {
            showToast('가공이 완료되었습니다!', 'success');
            loadPipelineQueue();
            updatePipelineStatus();
        } else {
            showToast(res.message, 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('가공 오류: ' + e.message, 'error');
    }
}

async function editPipelineItem(id) {
    const item = pipelineQueue.find(i => i.id === id);
    if (!item) return;

    const content = item.processedData?.content || item.processedContent;
    if (!content) {
        return showToast('가공된 콘텐츠가 없습니다. 먼저 AI 가공을 진행해주세요.', 'warning');
    }

    // 업로드 탭으로 데이터 복사
    document.getElementById('upload-content').value = content;
    document.getElementById('upload-char-count').textContent = content.length;

    // 미디어 복사
    if (item.mediaUrls && item.mediaUrls.length > 0) {
        document.getElementById('upload-remote-image-url').value = item.mediaUrls.join(',');
    } else {
        document.getElementById('upload-remote-image-url').value = '';
    }

    // 제휴 링크가 있다면 댓글 링크에도 자동 설정
    const link = item.sourceData?.affiliateLink || item.affiliateLink || item.sourceData?.link;
    if (link) {
        const replyCheck = document.getElementById('upload-reply-check');
        const replyContent = document.getElementById('upload-reply-content');
        if (replyCheck && replyContent) {
            replyCheck.checked = true;
            replyContent.value = `🔗 자세한 정보 확인하기:\n${link}`;
            replyContent.hidden = false;
        }
    }

    // 미리보기 갱신 및 디자인 버튼 준비
    window._designedThumbnailFile = null;
    refreshUploadPreview();

    // 썸네일 디자인 제안 버튼 및 제목 입력란 추가
    const thumbTitleGroup = document.getElementById('upload-thumb-title-group');
    const suggestedTitle = item.thumbTitle || item.sourceData?.title || '오늘의 추천 정보';

    // 제목 입력란 설정
    if (thumbTitleGroup) {
        thumbTitleGroup.style.display = 'block';
        thumbTitleGroup.hidden = false;
        document.getElementById('upload-thumb-title').value = suggestedTitle;
    }

    const uploadBtnContainer = document.querySelector('.upload-card .btn-row') || document.getElementById('btn-upload')?.parentElement;

    if (uploadBtnContainer) {
        const manualBtn = document.getElementById('btn-design-thumb-manual');
        if (manualBtn) {
            manualBtn.onclick = () => {
                const customTitle = document.getElementById('upload-thumb-title').value || suggestedTitle;
                const firstMedia = window._currentPreviewFirstMedia || (item.mediaUrls && item.mediaUrls[0]);
                generateDesignedThumbnail(customTitle, firstMedia);
            };
        }
    }
    switchTab('upload');
    showToast('콘텐츠를 검토할 수 있도록 업로드 창으로 가져왔습니다.', 'success');
}

async function deletePipelineItem(id) {
    if (!confirm('이 큐 항목을 삭제하시겠습니까?')) return;

    try {
        const res = await api('DELETE', `/pipeline/queue/${id}`);
        if (res.success) {
            showToast('삭제 완료', 'success');
            loadPipelineQueue();
            updatePipelineStatus();
        } else {
            showToast(res.message || '삭제 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

async function clearPipelineQueue() {
    const status = document.getElementById('pipe-filter').value;
    const confirmMsg = status === 'all'
        ? '대기열의 모든 항목을 삭제하시겠습니까?'
        : `현재 필터링된 (${status}) 항목을 모두 삭제하시겠습니까?`;

    if (!confirm(confirmMsg)) return;

    try {
        const path = status === 'all' ? '/pipeline/queue' : `/pipeline/queue?status=${status}`;
        const res = await api('DELETE', path);
        if (res.success) {
            showToast('대기열이 정리되었습니다.', 'success');
            loadPipelineQueue();
            updatePipelineStatus();
        } else {
            showToast(res.message || '삭제 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

// editPipelineItem was moved and consolidated above

// ===== 썸네일 디자인 도구 (Canvas) =====

function handleLocalThumbBackground(input) {
    if (!input.files || !input.files[0]) return;
    
    const file = input.files[0];
    const blobUrl = URL.createObjectURL(file);
    const title = document.getElementById('upload-thumb-title').value;
    
    if (!title) {
        showToast('썸네일 제목을 먼저 입력해주세요.', 'warning');
        return;
    }
    
    // 생성 시점에 blobUrl을 사용하여 썸네일 디자인 실행
    generateDesignedThumbnail(title, blobUrl);
    
    // 입력 리셋 (같은 파일 다시 선택 가능하도록)
    input.value = '';
}

function generateThumbWithCurrentMedia() {
    const title = document.getElementById('upload-thumb-title').value;
    const firstMedia = window._currentPreviewFirstMedia;
    
    if (!title) return showToast('썸네일 제목을 입력해주세요.', 'warning');
    if (!firstMedia) return showToast('서버에 수집된 이미지 또는 업로드한 이미지가 필요합니다.', 'warning');
    
    generateDesignedThumbnail(title, firstMedia);
}

async function generateDesignedThumbnail(title, imageUrl) {
    if (!imageUrl) return showToast('이미지가 없습니다', 'warning');

    showLoading('디자인 썸네일 생성 중... 🎨');

    try {
        const canvas = document.getElementById('thumbnail-canvas');
        const ctx = canvas.getContext('2d');

        // 1. 이미지 로드
        const img = new Image();
        img.crossOrigin = "anonymous"; // CORS 대응

        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = () => reject(new Error('이미지 로드 실패 (프록시 확인 필요)'));
            
            // 로컬 Blob URL인 경우 프록시 없이 직접 로드, 아니면 서버 프록시 경유
            if (imageUrl.startsWith('blob:')) {
                img.src = imageUrl;
            } else {
                img.src = `/api/proxy-image?url=${encodeURIComponent(imageUrl)}`;
            }
        });

        // 2. 배경 그리기 (Square)
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 디자인 스타일 선택 정보 가져오기
        const style = document.getElementById('thumb-style')?.value || 'outline';
        const pos = document.getElementById('thumb-pos')?.value || 'center';

        if (style === 'minimal') {
            // 프리미엄 미니멀: 솔리드 그레이 배경
            ctx.fillStyle = '#F5F5F5';
            ctx.fillRect(0, 0, 1080, 1080);
            
            // 다이아몬드 퀼팅 패턴 그리기
            ctx.save();
            ctx.strokeStyle = 'rgba(0,0,0,0.04)';
            ctx.lineWidth = 1.5;
            const step = 80;
            for (let i = -1080; i < 1080 * 2; i += step) {
                // / 방향
                ctx.beginPath();
                ctx.moveTo(i, 0);
                ctx.lineTo(i + 1080, 1080);
                ctx.stroke();
                // \ 방향
                ctx.beginPath();
                ctx.moveTo(i, 0);
                ctx.lineTo(i - 1080, 1080);
                ctx.stroke();
            }
            ctx.restore();
        } else {
            // 기존: 이미지 배경
            const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
            const x = (canvas.width / 2) - (img.width / 2) * scale;
            const y = (canvas.height / 2) - (img.height / 2) * scale;
            ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
        }

        // 4. 오버레이 디자인 (Minimal은 생략 또는 변경)
        if (style === 'gradient') {
            const gradient = ctx.createLinearGradient(0, 400, 0, 1080);
            gradient.addColorStop(0, 'rgba(0,0,0,0)');
            gradient.addColorStop(1, 'rgba(0,0,0,0.85)');
            ctx.fillStyle = gradient;
            ctx.fillRect(0, 0, 1080, 1080);

            ctx.fillStyle = 'rgba(139, 92, 246, 0.9)'; 
            ctx.fillRect(50, 780, 200, 12);
        }

        // 5. 텍스트 설정
        const cleanTitle = title.replace(/<[^>]*>/g, '').trim().substring(0, 80);
        let fontSize = style === 'minimal' ? 120 : 100; // 미니멀은 글씨를 더 크게
        ctx.font = `800 ${fontSize}px "Inter", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;
        
        const maxWidth = 980;
        const words = cleanTitle.split(' ');
        let line = '';
        const lines = [];

        for (let n = 0; n < words.length; n++) {
            const testLine = line + words[n] + ' ';
            const metrics = ctx.measureText(testLine);
            if (metrics.width > maxWidth && n > 0) {
                lines.push(line);
                line = words[n] + ' ';
            } else {
                line = testLine;
            }
        }
        lines.push(line);

        const displayLines = lines.slice(0, 4); // 미니멀은 4줄까지 허용
        
        // 6. 텍스트 드로잉 설정
        if (style === 'minimal') {
            ctx.fillStyle = '#000000';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = 0;
        } else if (style === 'outline') {
            ctx.fillStyle = 'white';
            ctx.strokeStyle = 'black';
            ctx.lineWidth = 14;
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;
            ctx.shadowBlur = 0;
        } else {
            ctx.fillStyle = 'white';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 15;
            ctx.shadowOffsetX = 5;
            ctx.shadowOffsetY = 5;
        }

        // 행간 설정 (Minimal은 1.5배, 나머지는 1.15배 내외)
        const lineHeight = style === 'minimal' ? fontSize * 1.5 : fontSize + 15;

        // 위치에 따른 좌표 및 정렬 설정
        // Minimal은 요청에 따라 무조건 Center로 동작하거나, 선택값을 따름 (여기선 선택값 따르되 기본값 Center)
        const activePos = style === 'minimal' ? 'center' : pos; 

        if (activePos === 'center') {
            ctx.textAlign = 'center';
            const totalHeight = displayLines.length * lineHeight;
            let currentY = (canvas.height / 2) - (totalHeight / 2) + (fontSize * 0.82);

            displayLines.forEach(l => {
                const txt = l.trim();
                if (style === 'outline') ctx.strokeText(txt, 540, currentY);
                ctx.fillText(txt, 540, currentY);
                currentY += lineHeight;
            });
        } else {
            ctx.textAlign = 'left';
            let currentY = 880 - ((displayLines.length - 1) * lineHeight);

            displayLines.forEach(l => {
                const txt = l.trim();
                if (style === 'outline') ctx.strokeText(txt, 60, currentY);
                ctx.fillText(txt, 60, currentY);
                currentY += lineHeight;
            });
        }

        // 5. 결과물을 업로드 탭에 반영
        const dataUrl = canvas.toDataURL('image/jpeg', 0.9);

        // DataURL을 Blob으로 변환하여 File 객체처럼 취급
        const blob = await (await fetch(dataUrl)).blob();
        window._designedThumbnailFile = new File([blob], 'designed-thumbnail.jpg', { type: 'image/jpeg' });

        // 미리보기 갱신 (기존 원격 이미지들 유지됨)
        refreshUploadPreview();

        hideLoading();
        showToast('🎨 디자인 썸네일이 생성되어 맨 앞에 적용되었습니다!', 'success');
        switchTab('upload');
    } catch (e) {
        hideLoading();
        console.error(e);
        showToast('디자인 생성 중 오류: ' + e.message, 'error');
    }
}

// ===== Saved RSS Feeds Management =====

async function saveSavedRssFeed() {
    const url = document.getElementById('pipe-rss').value.trim();
    if (!url) return showToast('저장할 RSS URL을 입력하세요', 'warning');
    if (!url.startsWith('http')) return showToast('올바른 URL 형식이 아닙니다', 'error');

    try {
        const res = await api('GET', '/pipeline/config');
        if (!res.success) throw new Error(res.message);

        const config = res.config;
        const savedFeeds = config.savedRssFeeds || [];

        if (savedFeeds.includes(url)) {
            return showToast('이미 저장된 URL입니다', 'info');
        }

        savedFeeds.push(url);

        // 민감 정보 보안을 위해 기존 설정값과 함께 저장
        const updateRes = await api('POST', '/pipeline/config', { savedRssFeeds: savedFeeds });

        if (updateRes.success) {
            showToast('즐겨찾기에 저장되었습니다', 'success');
            renderSavedRssList(savedFeeds);
        } else {
            showToast(updateRes.message || '저장 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

function renderSavedRssList(feeds) {
    const container = document.getElementById('saved-rss-container');
    const listEl = document.getElementById('saved-rss-list');
    if (!container || !listEl) return;

    if (!feeds || feeds.length === 0) {
        container.hidden = true;
        return;
    }

    container.hidden = false;
    listEl.innerHTML = feeds.map(url => {
        let displayUrl = url.replace(/^https?:\/\//, '').substring(0, 25);
        if (url.length > 25) displayUrl += '...';

        return `
            <div class="d-flex align-items-center gap-1 p-1 px-2 mb-1" 
                 style="background: white; border: 1px solid var(--border-color); border-radius: 20px; font-size: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <span class="text-truncate" style="max-width: 150px; cursor: pointer;" onclick="document.getElementById('pipe-rss').value='${url}'" title="${url}">${displayUrl}</span>
                <button class="btn btn-sm p-0 px-1 text-primary" onclick="runSavedRssCollect('${url}')" title="즉시 수집" style="font-size: 11px; font-weight: 700;">🚀</button>
                <button class="btn btn-sm p-0 px-1 text-danger" onclick="deleteSavedRssFeed('${url}')" title="삭제" style="font-size: 11px;">✕</button>
            </div>
        `;
    }).join('');
}

async function deleteSavedRssFeed(url) {
    if (!confirm('이 RSS 피드를 즐겨찾기에서 삭제하시겠습니까?')) return;

    try {
        const res = await api('GET', '/pipeline/config');
        if (!res.success) throw new Error(res.message);

        const config = res.config;
        const savedFeeds = (config.savedRssFeeds || []).filter(f => f !== url);

        const updateRes = await api('POST', '/pipeline/config', { savedRssFeeds: savedFeeds });

        if (updateRes.success) {
            showToast('삭제되었습니다', 'success');
            renderSavedRssList(savedFeeds);
        } else {
            showToast(updateRes.message || '삭제 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

async function runSavedRssCollect(url) {
    showLoading(`RSS 수집 중: ${url}`);
    try {
        const res = await api('POST', '/pipeline/collect', { rssFeeds: [url], rssLimit: 10 });
        hideLoading();

        if (res.success) {
            showToast(`${res.totalCollected}건 수집 완료!`, 'success');
            loadPipelineQueue();
            updatePipelineStatus();

            // 탭 내의 입력필드도 해당 URL로 채워줌
            document.getElementById('pipe-rss').value = url;
        } else {
            showToast(res.message || '수집 실패', 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('서버 오류: ' + e.message, 'error');
    }
}

// ===== Threads Scraper Tab =====

let lastScrapedThreads = [];

async function loadThreadsScrapeTab() {
    const typeSelect = document.getElementById('threads-scrape-type');
    if (typeSelect && !typeSelect.dataset.listenerAdded) {
        typeSelect.addEventListener('change', (e) => {
            const label = document.getElementById('threads-scrape-label');
            const input = document.getElementById('threads-scrape-input');
            const type = e.target.value;

            if (type === 'user') {
                label.textContent = '사용자 아이디 (예: zuck)';
                input.placeholder = 'zuck';
            } else if (type === 'url') {
                label.textContent = '스레드 URL';
                input.placeholder = 'https://www.threads.net/t/...';
            } else if (type === 'search') {
                label.textContent = '검색 키워드';
                input.placeholder = '홈카페, 테크...';
            }
        });
        typeSelect.dataset.listenerAdded = 'true';
    }

    // 저장된 계정 불러오기
    try {
        const res = await api('GET', '/pipeline/config');
        if (res.success && res.config.savedThreadsAccounts) {
            renderSavedThreadsAccounts(res.config.savedThreadsAccounts);
        }
    } catch (e) {
        console.error('Failed to load saved threads accounts:', e);
    }
}

async function saveSortedThreadsAccount() {
    const input = document.getElementById('threads-scrape-input').value.trim();
    const type = document.getElementById('threads-scrape-type').value;
    if (!input) return showToast('수집할 정보를 입력하세요', 'warning');

    try {
        const res = await api('GET', '/pipeline/config');
        if (!res.success) throw new Error(res.message);

        const config = res.config;
        const savedAccounts = config.savedThreadsAccounts || [];

        const accountObj = { input, type };

        // 중복 체크
        const exists = savedAccounts.some(a => a.input === input && a.type === type);
        if (exists) {
            return showToast('이미 저장된 항목입니다', 'info');
        }

        savedAccounts.push(accountObj);

        const updateRes = await api('POST', '/pipeline/config', { savedThreadsAccounts: savedAccounts });

        if (updateRes.success) {
            showToast('즐겨찾기에 저장되었습니다', 'success');
            renderSavedThreadsAccounts(savedAccounts);
        } else {
            showToast(updateRes.message || '저장 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

function renderSavedThreadsAccounts(accounts) {
    const container = document.getElementById('saved-threads-accounts-container');
    const listEl = document.getElementById('saved-threads-accounts-list');
    if (!container || !listEl) return;

    if (!accounts || accounts.length === 0) {
        container.hidden = true;
        return;
    }

    container.hidden = false;
    listEl.innerHTML = accounts.map(acc => {
        let display = acc.input;
        if (acc.type === 'user' && !display.startsWith('@')) display = '@' + display;

        let icon = acc.type === 'user' ? '👤' : (acc.type === 'url' ? '🔗' : '🔍');

        return `
            <div class="d-flex align-items-center gap-1 p-1 px-2 mb-1" 
                 style="background: white; border: 1px solid var(--border-color); border-radius: 20px; font-size: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); cursor: pointer;">
                <span class="text-truncate" style="max-width: 150px;" onclick="loadSavedThreadsAccount('${acc.input}', '${acc.type}')" title="${acc.input}">
                    ${icon} ${display}
                </span>
                <button class="btn btn-sm p-0 px-1 text-danger" onclick="deleteSavedThreadsAccount('${acc.input}', '${acc.type}')" title="삭제" style="font-size: 11px;">✕</button>
            </div>
        `;
    }).join('');
}

function loadSavedThreadsAccount(input, type) {
    document.getElementById('threads-scrape-input').value = input;
    document.getElementById('threads-scrape-type').value = type;
    document.getElementById('threads-scrape-type').dispatchEvent(new Event('change'));
}

async function deleteSavedThreadsAccount(input, type) {
    if (!confirm('이 항목을 즐겨찾기에서 삭제하시겠습니까?')) return;

    try {
        const res = await api('GET', '/pipeline/config');
        if (!res.success) throw new Error(res.message);

        const config = res.config;
        const savedAccounts = (config.savedThreadsAccounts || []).filter(a => !(a.input === input && a.type === type));

        const updateRes = await api('POST', '/pipeline/config', { savedThreadsAccounts: savedAccounts });

        if (updateRes.success) {
            showToast('삭제되었습니다', 'success');
            renderSavedThreadsAccounts(savedAccounts);
        } else {
            showToast(updateRes.message || '삭제 실패', 'error');
        }
    } catch (e) {
        showToast('서버 오류: ' + e.message, 'error');
    }
}

async function startThreadsScrape() {
    const type = document.getElementById('threads-scrape-type').value;
    const input = document.getElementById('threads-scrape-input').value.trim();
    const limit = document.getElementById('threads-scrape-limit').value || 10;
    
    if (!input) return showToast('수집할 대상을 입력하세요', 'warning');
    
    showLoading('Threads 데이터 수집 중... 🕷️');
    try {
        const res = await api('POST', '/threads/scrape', { type, input, limit });
        hideLoading();
        
        if (res.success && res.threads) {
            lastScrapedThreads = res.threads;
            renderThreadsScrapeResults(res.threads);
            document.getElementById('threads-scrape-results-area').hidden = false;
            showToast(`${res.threads.length}개의 스레드를 수집했습니다`, 'success');
        } else {
            showToast(res.message || '수집에 실패했습니다. (공공 데이터 접근 제한일 수 있음)', 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('스크래핑 오류: ' + e.message, 'error');
    }
}

function renderThreadsScrapeResults(threads) {
    const listEl = document.getElementById('threads-scrape-list');
    if (!listEl) return;
    
    if (threads.length === 0) {
        listEl.innerHTML = '<div class="empty-state">수집된 데이터가 없습니다</div>';
        return;
    }
    
    listEl.innerHTML = threads.map((t, idx) => {
        const hasMedia = t.mediaUrls && t.mediaUrls.length > 0;
        const firstMedia = hasMedia ? t.mediaUrls[0] : null;
        
        return `
            <div class="card mb-3 p-3 result-card">
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <div>
                        <strong>@${escapeHtml(t.author)}</strong>
                        <small class="text-muted ml-2">${formatTime(t.createdAt)}</small>
                    </div>
                    <div class="d-flex gap-2 align-items-center">
                        <button class="btn btn-xs btn-success" onclick="addThreadToQueue(${idx})">
                            ➕ 추가
                        </button>
                        <a href="${t.url}" target="_blank" class="text-primary" style="font-size:12px;">원문 보기 ↗</a>
                    </div>
                </div>
                <div style="white-space: pre-wrap; font-size: 14px; margin-bottom: 10px;">${escapeHtml(t.content)}</div>
                ${hasMedia ? `
                    <div class="threads-media-scroll mb-2">
                        ${t.mediaUrls.map(u => {
                            const isVideo = u.toLowerCase().includes('.mp4') || u.toLowerCase().includes('.mov');
                            if (isVideo) {
                                return `
                                    <video src="${escapeAttr(u)}" class="threads-media-item" controls muted></video>
                                `;
                            } else {
                                // 이미지의 경우 프록시 사용 (CORS 회피)
                                const proxiedUrl = `/api/proxy-image?url=${encodeURIComponent(u)}`;
                                return `
                                    <img src="${proxiedUrl}" class="threads-media-item" 
                                         onclick="window.open('${escapeAttr(u)}', '_blank')">
                                `;
                            }
                        }).join('')}
                    </div>
                ` : ''}
                <div class="d-flex justify-content-between align-items-center" style="border-top: 1px solid var(--border-light); pt-2; margin-top: 5px; padding-top: 8px;">
                    <div style="font-size:12px; color:var(--text-muted);">
                        ❤️ ${t.likeCount}  💬 ${t.replyCount}
                    </div>
                    <button class="btn btn-sm btn-outline-success" onclick="addThreadToQueue(${idx})">
                        ➕ 대기열 추가
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function addThreadToQueue(idx) {
    const thread = lastScrapedThreads[idx];
    if (!thread) return;
    
    showLoading('대기열 추가 중...');
    const res = await api('POST', '/threads/add-to-queue', { thread });
    hideLoading();
    
    if (res.success) {
        showToast('대기열에 추가되었습니다. "AI 자동 생성" 탭에서 확인하세요.', 'success');
    } else {
        showToast(res.message, 'error');
    }
}

async function addAllThreadsToQueue() {
    if (lastScrapedThreads.length === 0) return;
    
    showLoading('전체 대기열 추가 중...');
    let count = 0;
    for (const thread of lastScrapedThreads) {
        const res = await api('POST', '/threads/add-to-queue', { thread });
        if (res.success) count++;
    }
    hideLoading();
    showToast(`${count}개의 스레드가 대기열에 추가되었습니다.`, 'success');
}

// ==========================================
// TikTok Scraper Logic
// ==========================================
let lastScrapedTiktoks = [];

async function loadTiktokScrapeTab() {
    try {
        const res = await api('GET', '/pipeline/config');
        if (res.success && res.config.savedTiktokAccounts) {
            renderSavedTiktokAccounts(res.config.savedTiktokAccounts);
        }
    } catch (e) {
        console.error('Failed to load saved tiktok accounts:', e);
    }
}

async function saveSortedTiktokAccount() {
    const input = document.getElementById('tiktok-scrape-input').value.trim();
    const type = document.getElementById('tiktok-scrape-type').value;
    if (!input) return showToast('입력을 확인하세요', 'warning');

    try {
        const res = await api('GET', '/pipeline/config');
        if (!res.success) throw new Error(res.message);

        const config = res.config;
        const savedAccounts = config.savedTiktokAccounts || [];

        const accountObj = { input, type };

        const exists = savedAccounts.some(a => a.input === input && a.type === type);
        if (exists) {
            return showToast('이미 저장된 항목입니다', 'info');
        }

        savedAccounts.push(accountObj);

        const updateRes = await api('POST', '/pipeline/config', { savedTiktokAccounts: savedAccounts });

        if (updateRes.success) {
            showToast('즐겨찾기에 추가되었습니다', 'success');
            renderSavedTiktokAccounts(savedAccounts);
        } else {
            showToast(updateRes.message || '저장 실패', 'error');
        }
    } catch (e) {
        showToast('오류: ' + e.message, 'error');
    }
}

function renderSavedTiktokAccounts(accounts) {
    const container = document.getElementById('saved-tiktok-accounts-container');
    const listEl = document.getElementById('saved-tiktok-accounts-list');
    if (!container || !listEl) return;

    if (!accounts || accounts.length === 0) {
        container.hidden = true;
        return;
    }

    container.hidden = false;
    listEl.innerHTML = accounts.map(acc => {
        let display = acc.input;
        if (acc.type === 'user' && !display.startsWith('@')) display = '@' + display;

        let icon = acc.type === 'user' ? '👤' : '🔗';

        return `
            <div class="d-flex align-items-center gap-1 p-1 px-2 mb-1" 
                 style="background: white; border: 1px solid var(--border-color); border-radius: 20px; font-size: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); cursor: pointer;">
                <span class="text-truncate" style="max-width: 150px;" onclick="loadSavedTiktokAccount('${acc.input}', '${acc.type}')" title="${acc.input}">
                    ${icon} ${display}
                </span>
                <button class="btn btn-sm p-0 px-1 text-danger" onclick="deleteSavedTiktokAccount('${acc.input}', '${acc.type}')" title="삭제" style="font-size: 11px;">✕</button>
            </div>
        `;
    }).join('');
}

function loadSavedTiktokAccount(input, type) {
    document.getElementById('tiktok-scrape-input').value = input;
    document.getElementById('tiktok-scrape-type').value = type;
    document.getElementById('tiktok-scrape-type').dispatchEvent(new Event('change'));
}

async function deleteSavedTiktokAccount(input, type) {
    if (!confirm('해당 항목을 즐겨찾기에서 삭제하시겠습니까?')) return;

    try {
        const res = await api('GET', '/pipeline/config');
        if (!res.success) throw new Error(res.message);

        const config = res.config;
        const savedAccounts = (config.savedTiktokAccounts || []).filter(a => !(a.input === input && a.type === type));

        const updateRes = await api('POST', '/pipeline/config', { savedTiktokAccounts: savedAccounts });

        if (updateRes.success) {
            showToast('삭제되었습니다', 'success');
            renderSavedTiktokAccounts(savedAccounts);
        } else {
            showToast(updateRes.message || '삭제 실패', 'error');
        }
    } catch (e) {
        showToast('오류: ' + e.message, 'error');
    }
}

async function startTiktokScrape() {
    const type = document.getElementById('tiktok-scrape-type').value;
    const input = document.getElementById('tiktok-scrape-input').value.trim();
    const limit = document.getElementById('tiktok-scrape-limit').value || 10;
    
    if (!input) return showToast('대상 입력을 확인하세요', 'warning');
    
    showLoading('TikTok 게시물 수집 중... 🎵');
    try {
        const res = await api('POST', '/tiktok/scrape', { type, input, limit });
        hideLoading();
        
        if (res.success && res.videos) {
            lastScrapedTiktoks = res.videos;
            renderTiktokScrapeResults(res.videos);
            document.getElementById('tiktok-scrape-results-area').hidden = false;
            showToast(`${res.videos.length}개의 비디오를 수집했습니다`, 'success');
        } else {
            showToast(res.message || '수집에 실패했습니다. (계정 정보 등 확인)', 'error');
        }
    } catch (e) {
        hideLoading();
        showToast('스크래핑 오류: ' + e.message, 'error');
    }
}

function renderTiktokScrapeResults(videos) {
    const listEl = document.getElementById('tiktok-scrape-list');
    if (!listEl) return;
    
    if (videos.length === 0) {
        listEl.innerHTML = '<div class="empty-state">수집된 데이터가 없습니다</div>';
        return;
    }
    
    listEl.innerHTML = videos.map((v, idx) => {
        const hasMedia = v.mediaUrls && v.mediaUrls.length > 0;
        
        return `
            <div class="card mb-3 p-3 result-card">
                <div class="d-flex justify-content-between align-items-center mb-2">
                    <div>
                        <strong>@${escapeHtml(v.author)}</strong>
                        <small class="text-muted ml-2">${v.views || ''}</small>
                    </div>
                    <div class="d-flex gap-2 align-items-center">
                        <button class="btn btn-xs btn-success" onclick="addTiktokToQueue(${idx})">
                            ➕ 추가
                        </button>
                        <a href="${v.url}" target="_blank" class="text-primary" style="font-size:12px;">원문 보기 ↗</a>
                    </div>
                </div>
                <div style="white-space: pre-wrap; font-size: 14px; margin-bottom: 10px;">${escapeHtml(v.content)}</div>
                ${hasMedia ? `
                    <div class="threads-media-scroll mb-2">
                        ${v.mediaUrls.map(u => {
                            const proxiedUrl = `/api/proxy-image?url=${encodeURIComponent(u)}`;
                            return `
                                <img src="${proxiedUrl}" class="threads-media-item" 
                                     onclick="window.open('${escapeAttr(u)}', '_blank')">
                            `;
                        }).join('')}
                    </div>
                ` : ''}
                <div class="mt-3 d-flex justify-content-end">
                    <button class="btn btn-sm btn-outline-success" onclick="addTiktokToQueue(${idx})">
                        ➕ 대기열 추가
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function addTiktokToQueue(idx) {
    const video = lastScrapedTiktoks[idx];
    if (!video) return;
    
    showLoading('대기열 추가 중...');
    const res = await api('POST', '/tiktok/add-to-queue', { video });
    hideLoading();
    
    if (res.success) {
        showToast('대기열에 추가되었습니다. "AI 자동 생성" 탭에서 확인하세요.', 'success');
    } else {
        showToast(res.message, 'error');
    }
}

async function addAllTiktokToQueue() {
    if (lastScrapedTiktoks.length === 0) return;
    
    showLoading('전체 대기열 추가 중...');
    let count = 0;
    for (const video of lastScrapedTiktoks) {
        const res = await api('POST', '/tiktok/add-to-queue', { video });
        if (res.success) count++;
    }
    hideLoading();
    showToast(`${count}개의 비디오가 대기열에 추가되었습니다.`, 'success');
}
