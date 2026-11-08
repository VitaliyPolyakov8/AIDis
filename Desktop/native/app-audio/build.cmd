@echo off
rem Builds assets\native\aidis-app-audio.exe (MSVC x64, Windows SDK). Run from any prompt.
setlocal
for /f "usebackq tokens=*" %%i in (`"%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath`) do set VS=%%i
call "%VS%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
cd /d "%~dp0"
if not exist "..\..\assets\native" mkdir "..\..\assets\native"
cl /nologo /O2 /EHsc /W4 /permissive- /std:c++17 /DUNICODE /D_UNICODE /MT app_audio.cpp /Fe:..\..\assets\native\aidis-app-audio.exe /Fo:%TEMP%\aidis_app_audio.obj /link /SUBSYSTEM:CONSOLE || exit /b 1
echo built assets\native\aidis-app-audio.exe
