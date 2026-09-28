@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1" %*
set "CINEFORGE_EXIT=%ERRORLEVEL%"
if not "%CINEFORGE_EXIT%"=="0" echo CineForge setup failed with exit code %CINEFORGE_EXIT%.
pause
exit /b %CINEFORGE_EXIT%
