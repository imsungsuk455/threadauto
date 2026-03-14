const https = require('https');
const http = require('http');
const axios = require('axios');
const cheerio = require('cheerio');
const { log, readJSON, writeJSON, PATHS } = require('./utils');
const { v4: uuidv4 } = require('uuid');

/**
 * AI 콘텐츠 생성기 (Gemini API 사용)
 * 3가지 모드: 브랜드 글, 제휴마케팅, 크롤링
 */

// ===== 공통 설정 =====
function loadAIConfig() {
    const config = readJSON(PATHS.aiConfig) || { apiKey: '', model: 'gemini-2.0-flash', templates: [] };
    
    // 환경 변수 우선 적용 (보안)
    if (process.env.GEMINI_API_KEY) {
        config.apiKey = process.env.GEMINI_API_KEY;
    }
    
    return config;
}

function saveAIConfig(config) {
    return writeJSON(PATHS.aiConfig, config);
}

function setApiKey(apiKey) {
    const config = loadAIConfig();
    config.apiKey = apiKey;
    saveAIConfig(config);
    return { success: true };
}

// ===== Gemini API 호출 =====
async function callGeminiAPI(apiKey, model, prompt, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await new Promise((resolve, reject) => {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
                const parsedUrl = new URL(url);

                const postData = JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.9,
                        topK: 40,
                        topP: 0.95,
                        maxOutputTokens: 2048,
                    }
                });

                const options = {
                    hostname: parsedUrl.hostname,
                    port: 443,
                    path: parsedUrl.pathname + parsedUrl.search,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(postData),
                    },
                };

                const req = https.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(data);
                            if (parsed.error) {
                                // 429 Resource Exhausted 체크
                                if (res.statusCode === 429 || parsed.error.message?.includes('Resource exhausted')) {
                                    const err = new Error('Resource exhausted');
                                    err.status = 429;
                                    reject(err);
                                } else {
                                    reject(new Error(parsed.error.message || 'API 오류'));
                                }
                                return;
                            }
                            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
                            resolve(text.trim());
                        } catch (e) {
                            reject(new Error(`응답 파싱 실패: ${e.message}`));
                        }
                    });
                });

                req.on('error', (e) => reject(new Error(`API 요청 실패: ${e.message}`)));
                req.setTimeout(30000, () => {
                    req.destroy();
                    reject(new Error('API 요청 시간 초과 (30초)'));
                });

                req.write(postData);
                req.end();
            });
        } catch (error) {
            // 429 에러인 경우에만 재시도
            if (error.status === 429 && i < retries - 1) {
                const waitTime = delay * Math.pow(2, i); // 지수 백오프
                log('WARN', `API 할당량 초과. ${waitTime}ms 후 재시도합니다... (시도 ${i + 1}/${retries})`);
                await new Promise(r => setTimeout(r, waitTime));
                continue;
            }
            throw error;
        }
    }
}

// ===== 기존 콘텐츠 생성 (일반 모드) =====
async function generateContent({ templateId, customPrompt, topic, tone, language = 'ko' }) {
    const config = loadAIConfig();
    if (!config.apiKey) {
        return { success: false, message: 'API 키가 설정되지 않았습니다.' };
    }

    let basePrompt = '';
    if (templateId && templateId !== 'custom') {
        const template = config.templates.find(t => t.id === templateId);
        if (template) basePrompt = template.prompt;
    }

    let fullPrompt = customPrompt || basePrompt || 'Write a short, engaging Threads post. Keep it under 500 characters.';

    if (topic) fullPrompt += `\n\nTopic/Subject: ${topic}`;
    if (tone) fullPrompt += `\n\nTone: ${tone}`;
    if (language === 'ko') fullPrompt += '\n\nIMPORTANT: Write the entire post in Korean (한국어).';
    else if (language === 'en') fullPrompt += '\n\nIMPORTANT: Write the entire post in English.';

    fullPrompt += '\n\nIMPORTANT RULES:\n- Keep the post under 500 characters.\n- Do NOT use hashtags unless specifically asked.\n- Write ONLY the post content, no explanations or meta-text.\n- Make it natural and engaging for social media.';

    log('INFO', `AI 콘텐츠 생성 요청 (모델: ${config.model})`);
    try {
        const content = await callGeminiAPI(config.apiKey, config.model, fullPrompt);
        if (!content) return { success: false, message: 'AI가 빈 응답을 반환했습니다.' };
        log('INFO', `AI 콘텐츠 생성 완료 (${content.length}자)`);
        return { success: true, content, model: config.model, charCount: content.length };
    } catch (error) {
        log('ERROR', `AI 생성 실패: ${error.message}`);
        return { success: false, message: error.message };
    }
}

async function generateVariations({ templateId, customPrompt, topic, tone, language = 'ko', count = 3 }) {
    const config = loadAIConfig();
    if (!config.apiKey) return { success: false, message: 'API 키가 설정되지 않았습니다.' };

    let basePrompt = '';
    if (templateId && templateId !== 'custom') {
        const template = config.templates.find(t => t.id === templateId);
        if (template) basePrompt = template.prompt;
    }

    let fullPrompt = customPrompt || basePrompt || 'Write a short, engaging Threads post.';
    if (topic) fullPrompt += `\n\nTopic: ${topic}`;
    if (tone) fullPrompt += `\n\nTone: ${tone}`;
    fullPrompt += `\n\nGenerate exactly ${count} DIFFERENT variations of this post.`;
    fullPrompt += '\nSeparate each variation with "---" on its own line.';
    fullPrompt += '\nEach variation should be under 500 characters.';
    if (language === 'ko') fullPrompt += '\nWrite ALL variations in Korean (한국어).';
    fullPrompt += '\nWrite ONLY the posts, no numbering, no explanations.';

    try {
        const raw = await callGeminiAPI(config.apiKey, config.model, fullPrompt);
        const variations = raw.split('---').map(v => v.trim()).filter(v => v.length > 0);
        return { success: true, variations, count: variations.length };
    } catch (error) {
        return { success: false, message: error.message };
    }
}

// ===== 템플릿 관리 =====
function getTemplates() {
    const config = loadAIConfig();
    return config.templates || [];
}

function addTemplate(template) {
    const config = loadAIConfig();
    template.id = template.id || uuidv4();
    config.templates.push(template);
    saveAIConfig(config);
    return { success: true, template };
}

function deleteTemplate(templateId) {
    const config = loadAIConfig();
    config.templates = config.templates.filter(t => t.id !== templateId);
    saveAIConfig(config);
    return { success: true };
}

// =============================================
// 모드 1: 브랜드 글 생성
// =============================================

function getPersonas() {
    const data = readJSON(PATHS.brandPersonas) || { personas: [] };
    return data.personas;
}

function addPersona(persona) {
    const data = readJSON(PATHS.brandPersonas) || { personas: [] };
    persona.id = persona.id || uuidv4();
    persona.createdAt = new Date().toISOString();
    data.personas.push(persona);
    writeJSON(PATHS.brandPersonas, data);
    log('INFO', `브랜드 페르소나 추가: ${persona.name}`);
    return { success: true, persona };
}

function updatePersona(personaId, updatedData) {
    const data = readJSON(PATHS.brandPersonas) || { personas: [] };
    const index = data.personas.findIndex(p => p.id === personaId);
    if (index === -1) return { success: false, message: '페르소나를 찾을 수 없습니다.' };
    
    data.personas[index] = { ...data.personas[index], ...updatedData };
    writeJSON(PATHS.brandPersonas, data);
    return { success: true, persona: data.personas[index] };
}

function deletePersona(personaId) {
    const data = readJSON(PATHS.brandPersonas) || { personas: [] };
    data.personas = data.personas.filter(p => p.id !== personaId);
    writeJSON(PATHS.brandPersonas, data);
    return { success: true };
}

async function learnPersonaFromUrl(url) {
    const config = loadAIConfig();
    if (!config.apiKey) return { success: false, message: 'API 키가 설정되지 않았습니다.' };

    log('INFO', `URL에서 페르소나 분석 시도: ${url}`);
    const crawlResult = await crawlUrl(url);
    if (!crawlResult.success) return crawlResult;

    const { title, bodyText, description } = crawlResult.data;

    const prompt = `You are an expert AI persona analyst. Process this web content and extract a distinct "Brand Persona".

SOURCE CONTENT:
Title: ${title}
Description: ${description}
Body (excerpt): ${bodyText.substring(0, 3000)}

TASK: Analyze the writing style, tone, terminology, and vibe of the content above. 
Then, return a JSON response matching exactly this structure:
{
  "tone": "Describe the tone in a short sentence in Korean (e.g., '전문적이지만 친근한', '재치있고 에너지 넘치는')",
  "keywords": ["keyword1", "keyword2", "keyword3"], // Up to 5 key topics/themes
  "sampleTexts": [
    "A typical sentence found in the text that shows the style",
    "Another interesting sentence or phrase used"
  ]
}

RULES:
- Extract Korean characteristics carefully.
- Output ONLY valid JSON, do not include markdown blocks or other text.`;

    try {
        const resultText = await callGeminiAPI(config.apiKey, config.model, prompt);
        let parsed;
        try {
            // Remove markdown format if any
            let cleanText = resultText.replace(/```json/g, '').replace(/```/g, '').trim();
            parsed = JSON.parse(cleanText);
        } catch (e) {
            return { success: false, message: 'JSON 파싱 실패: AI 응답 형식이 올바르지 않습니다.' };
        }

        log('INFO', `페르소나 분석 완료: ${parsed.tone}`);
        return { success: true, persona: parsed };
    } catch (error) {
        log('ERROR', `페르소나 분석 실패: ${error.message}`);
        return { success: false, message: error.message };
    }
}

async function generateBrandContent({ personaId, topic, language = 'ko' }) {
    const config = loadAIConfig();
    if (!config.apiKey) return { success: false, message: 'API 키가 설정되지 않았습니다.' };

    const personas = getPersonas();
    const persona = personas.find(p => p.id === personaId);
    if (!persona) return { success: false, message: '해당 페르소나를 찾을 수 없습니다.' };

    let prompt = `You are a social media content writer for the brand "${persona.name}".

BRAND PERSONA:
- Tone & Style: ${persona.tone || '자연스럽고 친근한'}
- Keywords: ${(persona.keywords || []).join(', ') || '없음'}

SAMPLE CONTENT (learn this style and voice):
${(persona.sampleTexts || []).map((t, i) => `[예시 ${i + 1}] ${t}`).join('\n')}

TASK: Write a NEW Threads post that perfectly matches this brand's voice and style.`;

    if (topic) prompt += `\nTopic: ${topic}`;
    if (language === 'ko') prompt += '\n\nWrite the entire post in Korean (한국어).';

    prompt += `\n\nRULES:
- Keep it under 500 characters.
- Match the brand's tone exactly.
${persona.customInstructions ? `- ${persona.customInstructions}\n` : ''}
- Do NOT copy the sample texts, create original content.
- Write ONLY the post, no explanations.
- Make it engaging for Threads/social media.`;

    log('INFO', `브랜드 콘텐츠 생성 (페르소나: ${persona.name})`);
    try {
        const content = await callGeminiAPI(config.apiKey, config.model, prompt);
        if (!content) return { success: false, message: 'AI가 빈 응답을 반환했습니다.' };
        return { success: true, content, persona: persona.name, charCount: content.length };
    } catch (error) {
        log('ERROR', `브랜드 콘텐츠 생성 실패: ${error.message}`);
        return { success: false, message: error.message };
    }
}

// =============================================
// 모드 2: 제휴마케팅
// =============================================

function getAffiliates() {
    const data = readJSON(PATHS.affiliateConfig) || { affiliates: [] };
    return data.affiliates;
}

function addAffiliate(affiliate) {
    const data = readJSON(PATHS.affiliateConfig) || { affiliates: [] };
    affiliate.id = affiliate.id || uuidv4();
    affiliate.createdAt = new Date().toISOString();
    data.affiliates.push(affiliate);
    writeJSON(PATHS.affiliateConfig, data);
    log('INFO', `제휴 상품 추가: ${affiliate.productName} (${affiliate.platform})`);
    return { success: true, affiliate };
}

function deleteAffiliate(affiliateId) {
    const data = readJSON(PATHS.affiliateConfig) || { affiliates: [] };
    data.affiliates = data.affiliates.filter(a => a.id !== affiliateId);
    writeJSON(PATHS.affiliateConfig, data);
    return { success: true };
}

async function generateAffiliateContent({ affiliateId, personaId, topic, language = 'ko' }) {
    const config = loadAIConfig();
    if (!config.apiKey) return { success: false, message: 'API 키가 설정되지 않았습니다.' };

    const affiliates = getAffiliates();
    const affiliate = affiliates.find(a => a.id === affiliateId);
    if (!affiliate) return { success: false, message: '해당 제휴 상품을 찾을 수 없습니다.' };

    const personas = getPersonas();
    const persona = personaId ? personas.find(p => p.id === personaId) : null;

    let personaContext = '';
    if (persona) {
        personaContext = `
WRITING STYLE (Adopt this persona):
- Name/Brand: ${persona.name}
- Tone: ${persona.tone || '자연스러운'}
- Sample Styles: ${(persona.sampleTexts || []).slice(0, 2).join(' / ')}
`;
    }

    let prompt = `You are a skilled social media marketer. ${persona ? `You are writing as the persona "${persona.name}".` : 'Write a natural promotional post.'}

PRODUCT INFO:
- Product Name: ${affiliate.productName}
- Description: ${affiliate.description || '없음'}
- Platform: ${affiliate.platform}
- URL context: ${affiliate.link}
${personaContext}
TASK: Write an engaging Threads post to promote this product. Matches the persona's voice if provided.

CRITICAL INSTRUCTIONS:
1. If the Product Name or Description mentions "네이버", "브랜드 커넥트", "쿠팡!", "Access Denied", or is completely useless, IGNORE IT COMPLETELY. Do not use those words.
2. DO NOT write posts about "네이버 브랜드 커넥트" or "쿠팡" itself. You must act as if you are promoting a hidden gem or an amazing product.
3. 직접 사용해본 것처럼 진솔한 후기 스타일로 작성하세요. "진짜 써보고 놀란", "이건 찐으로 추천" 같은 표현을 사용하세요.
4. 반드시 제품의 실질적 혜택(시간 절약, 생산성 향상, 가성비 등)을 구체적으로 언급하세요.
5. 활용 꿀팁을 최소 1가지 포함하세요 (예: "이렇게 쓰면 더 좋아요", "OO과 같이 쓰면 시너지가").
6. 제품에 대해 자신감 넘치게, 흥분된 톤으로 작성하세요.`;

    if (topic) prompt += `\nAdditional Focus/Angle: ${topic}`;
    if (language === 'ko') prompt += '\n\n전체를 한국어로 작성하세요.';

    prompt += `\n\nRULES:
- 500자 이내로 작성하세요.
- 진짜 추천처럼 자연스럽게 작성하세요. 명백한 광고처럼 보이면 안 됩니다.
- 페르소나의 톤에 맞춰주세요.
${persona && persona.customInstructions ? `- ${persona.customInstructions}\n` : ''}
- 글 본문에 링크를 포함하지 마세요 (댓글에 별도로 달립니다).
- "광고", "협찬"이라는 단어를 사용하지 마세요.
- 이모지는 2-3개 이내로 절제하여 사용하세요.
- 게시물 본문만 출력하세요. 부가 설명 없이.`;

    log('INFO', `제휴 콘텐츠 생성 (상품: ${affiliate.productName}, 페르소나: ${persona ? persona.name : '없음'})`);
    try {
        const content = await callGeminiAPI(config.apiKey, config.model, prompt);
        if (!content) return { success: false, message: 'AI가 빈 응답을 반환했습니다.' };
        return {
            success: true,
            content,
            affiliateLink: affiliate.link,
            productName: affiliate.productName,
            platform: affiliate.platform,
            charCount: content.length,
        };
    } catch (error) {
        log('ERROR', `제휴 콘텐츠 생성 실패: ${error.message}`);
        return { success: false, message: error.message };
    }
}

// =============================================
// 모드 3: 크롤링
// =============================================

async function crawlUrl(url) {
    log('INFO', `크롤링 시작: ${url}`);
    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
                'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cache-Control': 'max-age=0',
                'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': '"Windows"',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'Referer': 'https://www.google.com/',
            },
            timeout: 15000,
            maxRedirects: 5,
        });

        const $ = cheerio.load(response.data);

        // 불필요한 요소 제거
        $('script, style, nav, footer, header, iframe, noscript, .ads, .advertisement').remove();

        // 제목 추출 (og:title 우선)
        let title = $('meta[property="og:title"]').attr('content') ||
            $('title').text().trim() ||
            $('h1').first().text().trim() || '';

        // 본문 추출
        let bodyText = '';
        const articleEl = $('article').first();
        if (articleEl.length) bodyText = articleEl.text();
        else if ($('main').first().length) bodyText = $('main').first().text();
        else bodyText = $('body').text();

        // 텍스트 정리
        bodyText = bodyText.replace(/\s+/g, ' ').trim().substring(0, 3000);

        // 이미지 추출 강화 (Ali, Temu, 1688 등 동적 사이트 대응)
        const images = [];
        $('img').each((i, el) => {
            let src = $(el).attr('src') ||
                $(el).attr('data-src') ||
                $(el).attr('data-lazy-src') ||
                $(el).attr('original') ||
                $(el).attr('data-original') || '';
            const alt = $(el).attr('alt') || '';

            if (src && !src.includes('data:image') && !src.includes('icon') && !src.includes('logo')) {
                // 상대 URL 및 프로토콜 없는 URL 처리
                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) {
                    const urlObj = new URL(url);
                    src = urlObj.origin + src;
                }

                // AliExpress/1688 등 썸네일 -> 고해상도 변환 시도
                if (src.includes('.jpg_')) src = src.split('.jpg_')[0] + '.jpg';
                if (src.includes('.png_')) src = src.split('.png_')[0] + '.png';

                if (images.length < 20 && !images.find(img => img.src === src)) {
                    images.push({ src, alt });
                }
            }
        });

        // OG 이미지
        const ogImage = $('meta[property="og:image"]').attr('content');
        if (ogImage && !images.find(img => img.src === ogImage)) {
            images.unshift({ src: ogImage, alt: 'OG Image' });
        }

        // 비디오 추출
        $('video source, video, iframe, meta[property="og:video"]').each((i, el) => {
            let src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('content') || '';
            if (src && (src.includes('.mp4') || src.includes('.mov') || src.includes('youtube.com/embed') || src.includes('video'))) {
                if (src.startsWith('//')) src = 'https:' + src;
                else if (src.startsWith('/')) {
                    const urlObj = new URL(url);
                    src = urlObj.origin + src;
                }
                if (images.length < 15 && !images.find(m => m.src === src)) {
                    images.push({ src, alt: 'Video content', type: 'video' });
                }
            }
        });

        // 메타 설명
        let description = $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') || '';

        // 쿠팡, 네이버 등 의미 없는 제목 보정
        const genericTitles = ['쿠팡!', '추천 제휴 상품', 'Access Denied', '네이버', '네이버 브랜드 커넥트', '브랜드 커넥트', 'NAVER'];
        const isGeneric = title.length < 5 || genericTitles.some(t => title.includes(t));

        if (isGeneric) {
            title = description.substring(0, 50) || '추천 아이템/장소 (AI가 자동 분석합니다)';
        }

        log('INFO', `크롤링 완료: 제목="${title}", 본문=${bodyText.length}자, 미디어=${images.length}개`);

        return {
            success: true,
            data: { title, bodyText, description, images, sourceUrl: url }
        };
    } catch (error) {
        log('ERROR', `크롤링 실패: ${error.message}`);
        return { success: false, message: `크롤링 실패: ${error.message}` };
    }
}

async function crawlAndGenerate({ url, language = 'ko' }) {
    const config = loadAIConfig();
    if (!config.apiKey) return { success: false, message: 'API 키가 설정되지 않았습니다.' };

    // 1. 크롤링
    const crawlResult = await crawlUrl(url);
    if (!crawlResult.success) return crawlResult;

    const { title, bodyText, description, images } = crawlResult.data;

    // 2. AI로 Threads 게시물 변환 (고도화된 프롬프트)
    const prompt = `당신은 소셜 미디어 트렌드를 분석하고 사람들에게 공유하는 공감능력이 뛰어난 스레드(Threads) 전문 크리에이터입니다.

원본 콘텐츠:
제목: ${title}
설명: ${description}
본문 (일부): ${bodyText.substring(0, 2000)}

작성 지침:
1. 핵심 정보를 3줄 이내로 요약하되, 단순 정보 전달이 아닌 원본의 "핵심 매력"이나 "사람들이 공감할 포인트"를 짚어주세요.
2. 콘텐츠의 성격(유머, 정보, 뉴스, 팁 등)에 맞춰 가장 자연스러운 톤으로 시작하세요.
3. 억지로 IT나 비즈니스 이야기를 끌어오지 마세요. 원본이 웃긴 영상이면 웃음에 집중하고, 정보글이면 그 정보의 실질적 가치에 집중하세요.
4. "이걸 보고 느낀 건...", "생각보다 유용한 게..." 같은 자연스러운 개인 의견이나 통찰을 1줄 이상 포함하세요.
5. 출처 정보(예: @아이디)에 집착하지 마세요. 해당 아이디를 글의 주인공처럼 묘사하거나 태그하지 말고, 내용 그 자체에 집중하세요.
6. 500자 이내, 이모지 2-3개 이내로 작성하세요.
7. URL은 포함하지 마세요.
8. [도입 후크] → [핵심 내용] → [개인 통찰/재해석] → [한 줄 요약/질문] 구조로 작성하세요.
${language === 'ko' ? '9. 전체를 한국어(한국어)로 작성하세요.' : '9. Write in English.'}

게시물 본문만 출력하세요. 부가 설명이나 메타 텍스트는 절대 포함하지 마세요.`;

    log('INFO', `크롤링 데이터 → Threads 콘텐츠 변환 중...`);
    try {
        const content = await callGeminiAPI(config.apiKey, config.model, prompt);
        if (!content) return { success: false, message: 'AI가 빈 응답을 반환했습니다.' };

        return {
            success: true,
            content,
            crawledData: { title, description, images, sourceUrl: url },
            charCount: content.length,
        };
    } catch (error) {
        log('ERROR', `크롤링 콘텐츠 생성 실패: ${error.message}`);
        return { success: false, message: error.message };
    }
}

/**
 * 외부 플랫폼 미디어 검색 (AliExpress, Temu, 1688 등)
 */
async function searchProductMedia(platform, query) {
    log('INFO', `${platform}에서 관련 미디어 검색 시작: ${query}`);

    try {
        if (platform === 'ddg' || platform === 'bing') {
            try {
                // Bing 이미지 검색 (뉴스, 연예 기사 등 구글과 가장 유사하게 정확함)
                const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}&form=HDRSC3`;
                const res = await axios.get(searchUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
                    timeout: 7000
                });

                const media = [];
                // Bing은 이미지 메타데이터 원본 URL을 HTML 안에 murl 파라미터로 숨겨둠
                const regex = /murl&quot;:&quot;(.*?)&quot;/g;
                let match;
                while ((match = regex.exec(res.data)) !== null && media.length < 20) {
                    let src = match[1];
                    if (src && src.startsWith('http')) {
                        media.push({ src, alt: 'Bing Image Content', type: 'image' });
                    }
                }

                if (media.length > 0) return { success: true, media };

                // 정 안되면 핀터레스트로 자동 전환
                log('INFO', 'Bing 이미지 결과 부족 -> 핀터레스트로 전환');
                return await searchProductMedia('pinterest', query);
            } catch (err) {
                log('WARN', `Bing 이미지 검색 실패: ${err.message}`);
                return await searchProductMedia('pinterest', query);
            }
        } else if (platform === 'pinterest') {
            try {
                const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(query)}`;
                const res = await axios.get(searchUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
                    timeout: 5000
                });
                const $ = cheerio.load(res.data);
                const media = [];
                $('img').each((i, el) => {
                    const src = $(el).attr('src');
                    if (src && src.includes('pinimg.com')) {
                        // 고해상도 변환: 236x, 474x, 170x 등 다양한 크기를 736x로 변경
                        const highRes = src.replace(/\/(170x|236x|474x)\//, '/736x/');
                        if (!media.find(m => m.src === highRes)) {
                            media.push({ src: highRes, alt: 'Pinterest Content', type: 'image' });
                        }
                    }
                });

                if (media.length > 0) return { success: true, media: media.slice(0, 20) };

                log('INFO', 'Pinterest 결과 없음 -> Naver 이미지 검색으로 전환');
                return await searchProductMedia('naver-image', query);
            } catch (err) {
                log('WARN', `Pinterest 실패, Naver 전환: ${err.message}`);
                return await searchProductMedia('naver-image', query);
            }
        }
        else if (platform === 'youtube') {
            // 3. YouTube 검색 (Thumbnail 및 링크)
            const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query + ' review')}`;
            const res = await axios.get(searchUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' }
            });
            const $ = cheerio.load(res.data);
            const media = [];
            // 간단하게 thumbnail만 추출 (스크립트 파싱 생략)
            const thumbs = res.data.match(/https:\/\/i\.ytimg\.com\/vi\/[^\/]+\/hqdefault\.jpg/g) || [];
            const uniqueThumbs = [...new Set(thumbs)];
            uniqueThumbs.forEach(src => {
                media.push({ src, alt: 'YouTube Thumbnail', type: 'video_thumbnail' });
            });
            return { success: true, media: media.slice(0, 15) };
        }
        else if (platform === 'naver-image') {
            try {
                const config = readJSON(PATHS.pipelineConfig) || {};
                const { naverClientId, naverClientSecret } = config;

                if (!naverClientId || !naverClientSecret) {
                    log('WARN', '네이버 API 키가 없어 Bing으로 우회합니다.');
                    return await searchProductMedia('bing', query);
                }

                const res = await axios.get('https://openapi.naver.com/v1/search/image.json', {
                    params: { query: query, display: 15, sort: 'sim', filter: 'large' },
                    headers: {
                        'X-Naver-Client-Id': naverClientId,
                        'X-Naver-Client-Secret': naverClientSecret,
                    },
                    timeout: 5000,
                });

                const media = (res.data?.items || []).map(item => ({
                    src: item.link,
                    alt: item.title ? item.title.replace(/<[^>]*>/g, '') : 'Naver Image',
                    type: 'image'
                }));

                if (media.length > 0) return { success: true, media };

                log('INFO', '네이버 API 결과 없음 -> Bing으로 전환');
                return await searchProductMedia('bing', query);
            } catch (err) {
                log('WARN', `네이버 이미지 API 실패: ${err.message}`);
                return await searchProductMedia('bing', query);
            }
        }

        return { success: false, message: '지원하지 않는 플랫폼입니다.' };
    } catch (e) {
        log('ERROR', `${platform} 검색 실패: ${e.message}`);
        return { success: false, message: `검색 중 오류 발생: ${e.message}` };
    }
}

// ===== Module Exports =====
module.exports = {
    // 공통
    loadAIConfig, saveAIConfig, setApiKey, callGeminiAPI,
    // 일반 생성
    generateContent, generateVariations,
    getTemplates, addTemplate, deleteTemplate,
    // 브랜드 모드
    getPersonas, addPersona, updatePersona, deletePersona, generateBrandContent, learnPersonaFromUrl,
    // 제휴마케팅 모드
    getAffiliates, addAffiliate, deleteAffiliate, generateAffiliateContent,
    searchProductMedia,
    // 크롤링 모드
    crawlUrl, crawlAndGenerate,
};
