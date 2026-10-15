@echo off
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -InitializeOnly
if errorlevel 1 pause
