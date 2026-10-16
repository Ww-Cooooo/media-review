@echo off
setlocal DisableDelayedExpansion
rem The bootstrap uses Windows curl/certutil, never Windows PowerShell 5.1.
if /i "%PROCESSOR_ARCHITECTURE%"=="ARM64" goto unsupported
if /i "%PROCESSOR_ARCHITEW6432%"=="ARM64" goto unsupported
if /i not "%PROCESSOR_ARCHITECTURE%"=="AMD64" if /i not "%PROCESSOR_ARCHITEW6432%"=="AMD64" goto unsupported
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" >nul 2>nul
if not errorlevel 1 (
  node "%~dp0setup.mjs" %*
  exit /b
)
set "MR_DATA=%USERPROFILE%\.media-review-desk"
if defined MEDIA_REVIEW_DATA_DIR set "MR_DATA=%MEDIA_REVIEW_DATA_DIR%"
set "MR_NODE=%MR_DATA%\runtime\node-24.16.0\node.exe"
if exist "%MR_NODE%" (
  "%SystemRoot%\System32\certutil.exe" -hashfile "%MR_NODE%" SHA256 2>nul | "%SystemRoot%\System32\findstr.exe" /i /x "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3" >nul
  if not errorlevel 1 goto ready
)
set "MR_TEMP=%TEMP%\media-review-node-%RANDOM%-%RANDOM%"
if exist "%MR_TEMP%" exit /b 1
mkdir "%MR_TEMP%"
if errorlevel 1 exit /b 1
echo [Media Review] Preparing the private Node.js runtime...
"%SystemRoot%\System32\curl.exe" --fail --location --silent --show-error --proto =https --proto-redir =https --connect-timeout 15 --max-time 45 --speed-limit 8192 --speed-time 15 --max-filesize 120000000 --output "%MR_TEMP%\node.exe" "https://nodejs.org/download/release/v24.16.0/win-x64/node.exe"
if errorlevel 1 goto fallback
:verify
"%SystemRoot%\System32\certutil.exe" -hashfile "%MR_TEMP%\node.exe" SHA256 2>nul | "%SystemRoot%\System32\findstr.exe" /i /x "b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3" >nul
if errorlevel 1 goto failed
"%MR_TEMP%\node.exe" "%~dp0setup.mjs" --bootstrap-node %*
set "MR_RESULT=%ERRORLEVEL%"
del "%MR_TEMP%\node.exe"
if exist "%MR_TEMP%\node.tgz" del "%MR_TEMP%\node.tgz"
rmdir "%MR_TEMP%"
exit /b %MR_RESULT%
:fallback
echo [Media Review] Official download unavailable. Fetching the same pinned binary from the npm registry, then verifying the official Node.js SHA-256.
"%SystemRoot%\System32\curl.exe" --fail --location --silent --show-error --proto =https --proto-redir =https --connect-timeout 15 --max-time 600 --speed-limit 8192 --speed-time 30 --retry 2 --retry-all-errors --retry-max-time 600 --max-filesize 60000000 --output "%MR_TEMP%\node.tgz" "https://registry.npmjs.org/node-win-x64/-/node-win-x64-24.16.0.tgz"
if errorlevel 1 goto failed
"%SystemRoot%\System32\certutil.exe" -hashfile "%MR_TEMP%\node.tgz" SHA256 2>nul | "%SystemRoot%\System32\findstr.exe" /i /x "f33a75898185922e28e2b84bdeed05170ef78bc48c1877dcdff5ca5c148b9c57" >nul
if errorlevel 1 goto failed
rem Extract only the selected file to stdout; archive paths cannot write to disk.
"%SystemRoot%\System32\tar.exe" -xOf "%MR_TEMP%\node.tgz" package/bin/node.exe > "%MR_TEMP%\node.exe"
if errorlevel 1 goto failed
goto verify
:ready
"%MR_NODE%" "%~dp0setup.mjs" %*
exit /b
:failed
echo [Media Review] Node.js download or verification failed. Ask the Agent to retry this entry after checking the network.
if exist "%MR_TEMP%\node.exe" del "%MR_TEMP%\node.exe"
if exist "%MR_TEMP%\node.tgz" del "%MR_TEMP%\node.tgz"
rmdir "%MR_TEMP%"
exit /b 1
:unsupported
echo [Media Review] Automatic setup currently supports Windows x64 only.
exit /b 1
