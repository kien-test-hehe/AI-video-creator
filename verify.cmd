@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\verify-windows.ps1" %*
exit /b %ERRORLEVEL%
