@echo off
call "%~dp0scripts\first-use.cmd" --install %*
if errorlevel 1 pause
