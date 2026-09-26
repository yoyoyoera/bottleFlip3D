@echo off
chcp 65001 >nul
title Bottle Flip 3D
cd /d "%~dp0prototype"

where node >nul 2>nul
if errorlevel 1 (
  echo [1/3] Node.js가 없어서 설치합니다. 설치 창이 뜨면 허용해 주세요...
  winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
  if errorlevel 1 (
    echo.
    echo 자동 설치에 실패했습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 이 파일을 다시 실행해 주세요.
    pause
    exit /b 1
  )
  echo.
  echo Node.js 설치 완료. 이 창을 닫고 start.bat 을 한 번 더 실행해 주세요.
  pause
  exit /b 0
)

if not exist node_modules (
  echo [2/3] 처음 실행이라 필요한 파일을 받습니다 ^(1~2분^)...
  call npm install
  if errorlevel 1 (
    echo npm install 에 실패했습니다. 인터넷 연결을 확인해 주세요.
    pause
    exit /b 1
  )
)

echo [3/3] 게임을 켭니다. 브라우저가 자동으로 열립니다. 끄려면 이 창을 닫으세요.
call npm run dev -- --open
pause
