const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function setup() {
    console.log('🚀 Cloudflare Worker 연동 및 배포를 시작합니다...');
    
    try {
        // 1. Worker 폴더로 이동
        const workerDir = path.join(__dirname, '..', 'worker');
        
        console.log('\n1. Cloudflare에 배포 중...');
        const deployOut = execSync('npx wrangler deploy', { cwd: workerDir }).toString();
        
        // URL 추출 (예: https://threads-auto-scheduler.abc.workers.dev)
        const urlMatch = deployOut.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/);
        if (!urlMatch) {
            console.error('❌ 배포 주소를 찾을 수 없습니다. 배포 로그를 확인해주세요.');
            console.log(deployOut);
            return;
        }
        const workerUrl = urlMatch[0];
        console.log(`✅ 배포 성공: ${workerUrl}`);

        // 2. API_SECRET 설정 (랜덤 생성)
        console.log('\n2. 보안 키(API_SECRET) 설정 중...');
        const apiSecret = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        execSync(`npx wrangler secret put API_SECRET`, { 
            cwd: workerDir,
            input: apiSecret 
        });
        console.log('✅ 보안 키 설정 완료');

        // 3. 로컬 설정 파일 저장
        const configPath = path.join(__dirname, '..', 'data', 'cloudflare-config.json');
        const config = {
            workerUrl: workerUrl,
            apiSecret: apiSecret
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`\n🎉 모든 설정이 완료되었습니다!`);
        console.log(`파일 저장됨: ${configPath}`);
        console.log(`\n이제 예약 버튼을 누르면 ${workerUrl}을 통해 정확한 시간에 업로드됩니다.`);

    } catch (e) {
        console.error(`\n❌ 오류 발생: ${e.message}`);
        console.log('힌트: npx wrangler login 명령어로 로그인이 되어 있는지 확인해주세요.');
    }
}

setup();
