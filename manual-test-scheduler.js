const { addSchedule } = require('./src/scheduler');
const { log } = require('./src/utils');

async function test() {
    const accountId = 'e335a502-ec69-4266-a517-1b0c29a248e7'; // battleofwin45
    const targetString = '2026-03-16T21:10'; 
    
    log('INFO', `최종 GHA 테스트 예약 등록 중: ${targetString} KST`);
    
    const result = await addSchedule({
        accountId,
        content: `[최종 GHA 테스트] 토큰 동기화 패치 후 서버 OFF 예약 업로드 테스트입니다. (등록시간: ${new Date().toLocaleString('ko-KR', {timeZone: 'Asia/Seoul'})})`,
        imagePath: 'c:\\Users\\iss59\\Desktop\\antigravity\\thread auto\\uploads\\1773656719852-designed-thumbnail.jpg',
        scheduleType: 'once',
        dateTime: targetString,
        repeatLabel: ''
    });

    if (result.success) {
        log('INFO', '✅ 최종 테스트 예약 등록 완료!');
    } else {
        log('ERROR', `❌ 최종 테스트 예약 등록 실패: ${result.message}`);
    }
}

test();
