const { log, readJSON, writeJSON, PATHS } = require('./utils');
const { callGeminiAPI, loadAIConfig } = require('./ai-generator');
const { getQueueItems, updateQueueItem } = require('./collector');

/**
 * Phase 2 — 가공기 (Processor)
 * 큐에서 pending 항목을 가져와 Gemini API로 스레드용 콘텐츠로 변환
 */

// ===== 고도화된 시스템 프롬프트 =====

const SYSTEM_PROMPTS = {
    // 제휴 마케팅 콘텐츠
    affiliate: `당신은 라이프스타일과 트렌드에 민감한 전문 큐레이터이자 스레드(Threads) 콘텐츠 크리에이터입니다.

역할:
- 제품의 실질적인 매력을 자연스럽게 전달하는 콘텐츠를 작성합니다
- 직접 써본 것처럼 진솔하고 친근한 말투를 사용합니다
- 콘텐츠의 성격에 맞춰 독자가 공감할 수 있는 포인트를 짚어줍니다

핵심 규칙:
1. "광고", "협찬" 같은 단어는 피하고, "찐후기", "내돈내산 느낌"으로 작성하세요
2. 제품 링크는 본문에 넣지 마세요
3. 억지로 전문적인 용어를 섞지 마세요. 제품이 주는 행복이나 편리함에 집중하세요
4. 실제 사용자들이 가장 좋아할 만한 1가지 포인트를 강조하세요
5. 이모지는 2-3개, 500자 이내로 작성하세요`,

    // RSS / 정보성 콘텐츠
    rss: `당신은 다양한 분야의 뉴스나 유용한 정보를 쉽고 재밌게 요약해주는 스레드(Threads) 콘텐츠 크리에이터입니다.

역할:
- 복잡한 정보를 독자가 10초 만에 이해할 수 있게 재구성합니다
- "이거 진짜 대박인데?", "드디어 떴네요" 같은 소셜 미디어 특유의 활기찬 후크를 사용하세요
- 정보의 핵심과 이것이 우리 생활/생각에 어떤 영향을 주는지(인사이트)를 연결합니다

핵심 규칙:
1. 무조건 IT/비즈니스 관점으로 해석하지 마세요. 뉴스 자체가 가진 주제(건강, 사회, 여행, 테크 등)에 충실하세요
2. 원문을 그대로 베끼지 말고, 당신의 친구에게 설명해주듯 친절하게 다시 쓰세요
3. 원문 내용 → 이것의 의미/꿀팁 → 나의 생각 순서로 자연스럽게 구성하세요
4. 전문 용어보다는 일상 언어를 사용하여 가독성을 높이세요
5. 이모지는 2-3개, 500자 이내로 작성하세요`,

    crawl: `당신은 다양한 웹 콘텐츠와 영상/이미지 소식을 스레드(Threads)에 어울리는 감성적인 게시물로 변환하는 크리에이터입니다.

역할:
- 영상이나 이미지 위주의 콘텐츠를 보았을 때의 느낌을 생동감 있게 전달합니다
- 텍스트가 적은 경우에는 억지로 내용을 꾸미지 말고, 그 영상/이미지가 주는 '분위기'나 '핵심 비주얼'에 집중하세요
- 유저들이 "나도 이거 보고 싶다/하고 싶다"는 생각이 들게끔 매력적인 후크를 던집니다

핵심 규칙:
1. 텍스트가 부족할 땐 "이 영상 분위기 대박이다...", "이 한 장으로 설명 끝" 같은 직관적인 표현을 사용하세요
2. 영상 속의 상황을 유추하여 공감대를 형성하세요 (예: 요리 영상이면 맛에 대해, 여행이면 떠나고 싶은 마음에 대해)
3. 개인적인 감상이나 "나중에 꼭 해봐야지" 같은 다짐을 한 줄 추가하세요
4. 가볍고 트렌디한 톤을 유지하며, 이모지는 2-3개, 500자 이내로 작성하세요
5. 출처 아이디(@...)를 언급하거나 주인공으로 삼지 마세요.`,
};

// ===== 가공 전용 프롬프트 생성 =====

function buildProcessingPrompt(item, personaId = null) {
    const type = item.type;
    let systemPrompt = SYSTEM_PROMPTS[type] || SYSTEM_PROMPTS.crawl;
    const source = item.sourceData;

    // 페르소나 적용 로직 추가
    if (personaId) {
        const { getPersonas } = require('./ai-generator');
        const personas = getPersonas();
        const p = personas.find(x => x.id === personaId);
        if (p) {
            systemPrompt = `당신은 다음 페르소나(가상의 인물/브랜드 성격)로 활동합니다:
이름: ${p.name}
말투/톤: ${p.tone || '자연스러운'}
자주 쓰는 핵심 키워드/테마: ${(p.keywords || []).join(', ') || '없음'}
페르소나 예시 문장:
${(p.sampleTexts || []).map((t, i) => `[예시 ${i + 1}] ${t}`).join('\n')}

역할 및 주의사항:
이 페르소나의 성격, 말투, 스타일을 완벽하게 모방하여 스레드(Threads) 글을 작성하세요.
${p.customInstructions ? `\n[추가 지시사항]\n${p.customInstructions}\n` : ''}
${type === 'affiliate' ? '제품을 자연스럽게 추천하되 절대 "광고", "협찬" 등의 단어를 쓰지 마세요.' : ''}
${type === 'crawl' ? '웹 콘텐츠의 핵심포인트만 뽑아서 이 페르소나만의 독창적인 인사이트나 생각을 한 줄 덧붙이세요.' : ''}
이모지는 2~3개 이내로 절제하며, 문장 길이는 500자 이내로 하세요.
`;
        }
    }

    let contextBlock = '';

    if (type === 'affiliate') {
        const product = source.product || {};
        contextBlock = `
원본 정보:
- 제품명: ${product.productName || source.title || ''}
- 가격: ${product.price ? product.price + '원' : '정보 없음'}
- 플랫폼: ${source.platform || ''}
- 카테고리: ${product.category || ''}
- 평점: ${product.rating || ''} / 리뷰: ${product.reviewCount || ''}건

이 제품을 자연스럽게 추천하는 스레드 게시물을 작성해주세요.
제품의 실질적인 장점, 활용 팁, 또는 이 제품이 특별한 이유를 포함해주세요.`;
    } else if (type === 'rss') {
        contextBlock = `
원본 정보:
- 제목: ${source.title || ''}
- 출처: ${source.feedTitle || ''}
- 부분 본문: ${(source.bodyText || '').substring(0, 2000)}

이 내용을 바탕으로 독자적인 인사이트가 담긴 스레드 게시물을 작성해주세요.
핵심 정보를 요약하고, 당신만의 관점이나 실용적인 꿀팁을 추가해주세요.`;
    } else {
        const isShortText = (source.bodyText || '').length < 60;
        contextBlock = `
원본 정보:
- 제목: ${source.title || ''}
- 설명: ${source.description || ''}
- 부분 본문: ${(source.bodyText || '').substring(0, 2000)}

${isShortText ? `[특이사항: 텍스트 정보가 거의 없는 영상/이미지 위주 콘텐츠]
- 본문의 글이 적으므로, 이 미디어가 주는 '시각적 매력'이나 '상황적 재미'를 짚어주세요.
- 억지로 논리적인 요약을 하려 하지 말고, "이런 영상은 저장해둬야 함", "분위기 미쳤다..." 같은 감성적인 코멘트를 남기세요.` : '이 웹 콘텐츠를 바탕으로 유익하고 트렌디한 스레드 게시물을 작성해주세요.'}

주의사항:
- 제목의 @아이디는 무시하고 '내용'과 '비주얼'에만 집중하세요.
- 인사이트와 활용 팁을 포함해주세요.`;
    }

    return `${systemPrompt}\n\n${contextBlock}\n\n반드시 한국어로 작성해주세요.
결과는 아래 JSON 형식으로만 응답하세요 (설명 없이 JSON만 출력):
{
  "content": "여기에 스레드 게시물 본문(500자 이내) 작성",
  "thumbTitle": "여기에 썸네일에 들어갈 짧고 강렬한 제목(15자 이내) 작성"
}`;
}

// ===== 단일 항목 가공 =====

async function processItem(item, options = {}) {
    const config = loadAIConfig();
    if (!config.apiKey) {
        return { success: false, message: 'Gemini API 키가 설정되지 않았습니다.' };
    }

    try {
        const prompt = buildProcessingPrompt(item, options.personaId);
        const rawResponse = await callGeminiAPI(config.apiKey, config.model, prompt);

        if (!rawResponse || rawResponse.length < 10) {
            throw new Error('AI가 빈 응답이나 너무 짧은 응답을 반환했습니다.');
        }

        let content = '';
        let thumbTitle = '';

        try {
            // JSON 응답에서 마크다운 코드 블록 제거 후 파싱
            const cleanJson = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
            const parsed = JSON.parse(cleanJson);
            content = parsed.content || '';
            thumbTitle = parsed.thumbTitle || '';
        } catch (e) {
            // 파싱 실패 시 전체를 본문으로 간주
            log('WARN', 'JSON 파싱 실패, 전체 텍스트를 본문으로 처리합니다.');
            content = rawResponse;
            thumbTitle = item.sourceData?.title || '오늘의 추천';
        }

        if (!content) {
            throw new Error('AI 응답에서 유효한 콘텐츠를 찾을 수 없습니다.');
        }

        // 큐 업데이트
        const updated = updateQueueItem(item.id, {
            status: 'processed',
            processedContent: content,
            thumbTitle: thumbTitle, // 새 필드 추가
            processedAt: new Date().toISOString(),
        });

        log('INFO', `가공 완료: ${item.id} (${item.type}, 본문 ${content.length}자, 썸네일 제목: ${thumbTitle})`);
        return { success: true, item: updated, charCount: content.length };
    } catch (error) {
        log('ERROR', `가공 실패 [${item.id}]: ${error.message}`);
        updateQueueItem(item.id, {
            status: 'failed',
            errorMessage: `가공 실패: ${error.message}`,
        });
        return { success: false, itemId: item.id, message: error.message };
    }
}

// ===== 일괄 가공 =====

async function processAllPending(options = {}) {
    const pendingItems = getQueueItems('pending');

    if (pendingItems.length === 0) {
        log('INFO', '가공할 항목이 없습니다.');
        return { success: true, processed: 0, failed: 0, message: '가공할 항목이 없습니다.' };
    }

    log('INFO', `가공 시작: ${pendingItems.length}건 (페르소나: ${options.personaId || '기본'})`);

    const results = [];
    let processed = 0;
    let failed = 0;

    // 순차 처리 (Gemini API 레이트 리밋 고려)
    for (const item of pendingItems) {
        const result = await processItem(item, options);
        results.push(result);

        if (result.success) {
            processed++;
        } else {
            failed++;
        }

        // API 레이트 리밋 방지를 위한 딜레이
        if (pendingItems.indexOf(item) < pendingItems.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }

    log('INFO', `가공 완료: 성공 ${processed}건, 실패 ${failed}건`);
    return { success: true, processed, failed, total: pendingItems.length, results };
}

module.exports = {
    processItem,
    processAllPending,
    buildProcessingPrompt,
    SYSTEM_PROMPTS,
};
