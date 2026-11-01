@echo off
title Spider Classes Server & Player
echo Starting Spider Classes on http://localhost:8085...
cd /d "%~dp0"
start "" http://localhost:8085
node server.js
pause
