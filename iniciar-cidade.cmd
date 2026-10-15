@echo off
rem Liga a Cidade dos Agentes (se ainda não estiver rodando) e abre no navegador.
node "%~dp0launcher.js" --open --from=atalho
if errorlevel 1 pause
