const { addSchedule } = require('./src/scheduler');
const { log } = require('./src/utils');

async function test() {
    const accountId = 'e335a502-ec69-4266-a517-1b0c29a248e7'; // battleofwin45
    
    // 한국 시간으로 20:45 KST를 명시적으로 설정
    const targetString = '2026-03-16T20:45'; 
    
    log('INFO', `테스트 예약 등록 중: ${targetString} KST`);
    
    const result = await addSchedule({
        accountId,
        content: `[디버깅 테스트] 서버 OFF 환경 예약 업로드 테스트입니다. (등록시간: ${new Date().toLocaleString('ko-KR', {timeZone: 'Asia/Seoul'})}, 예약시간: ${targetString})`,
        imagePath: 'c:\\Users\\iss59\\Desktop\\antigravity\\thread auto\\uploads\\1773656719852-designed-thumbnail.jpg',
        scheduleType: 'once',
        dateTime: targetString,
        repeatLabel: ''
    });

    if (result.success) {
        log('INFO', '✅ 테스트 예약 등록 및 Git Push 완료!');
    } else {
        log('ERROR', `❌ 테스트 예약 등록 실패: ${result.message}`);
    }
}

test();
