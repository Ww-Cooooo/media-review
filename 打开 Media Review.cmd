@echo off
chcp 65001 >nul
title 启动 Media Review 本机音视频校对室
echo 启动 Media Review 本机音视频校对室
echo 此入口按需启动或复用本机 Node.js 校对服务，不上传素材，不开机自启。
node "%~dp0server\open.mjs"
if errorlevel 1 pause
