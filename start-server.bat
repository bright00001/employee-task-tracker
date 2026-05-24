@echo off
chcp 65001 >nul
title 员工任务记录 - 后端服务

echo.
echo ═══════════════════════════════════════
echo   员工每日任务完成记录 - 后端服务
echo ═══════════════════════════════════════
echo.

cd /d "H:\跨境业务系统数据库"

if not exist "node_modules\" (
    echo � 首次运行，正在安装依赖...
    call npm install
    echo.
)

echo ?? 启动服务...
node server.js
pause
