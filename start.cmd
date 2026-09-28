@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-windows.ps1" %*
exit /b %ERRORLEVEL%
