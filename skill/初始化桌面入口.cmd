@echo off
call "%~dp0scripts\first-use.cmd" %*
if errorlevel 1 pause
