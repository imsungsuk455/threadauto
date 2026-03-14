@echo off
TITLE Threads Auto - Starter
COLOR 0B

echo ==========================================
echo    Threads Auto 자동화 프로그램 시작
echo ==========================================
echo.

:: Check if Node.js is installed
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [!] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org/ 에서 LTS 버전을 설치해주세요.
    pause
    exit
)

:: Install dependencies if node_modules is missing
if not exist "node_modules\" (
    echo [1/3] 의존성을 설치하고 있습니다. 잠시만 기다려주세요...
    call npm install
) else (
    echo [1/3] 의존성 확인 완료.
)

:: Install Playwright browsers if needed
if not exist "%USERPROFILE%\AppData\Local\ms-playwright\" (
    echo [2/3] 브라우저 환경을 설정하고 있습니다...
    call npx playwright install chromium
) else (
    echo [2/3] 브라우저 환경 확인 완료.
)

echo [3/3] 서버를 실행하는 중입니다...
echo 대시보드 주소: http://localhost:3000
echo.

:: Start the browser and the server
start http://localhost:3000
call npm start

pause
