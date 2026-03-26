@echo off
setlocal

set NATIVE_DIR=%~dp0
set CMAKE="C:\Program Files\CMake\bin\cmake.exe"

:: Ensure WebView2 SDK is present
call "%NATIVE_DIR%setup_webview2.bat"
if %ERRORLEVEL% NEQ 0 goto :fail

:: Configure if needed
if not exist "%NATIVE_DIR%build\CMakeCache.txt" (
    echo [1/4] Configuring...
    %CMAKE% -B "%NATIVE_DIR%build" -G "Visual Studio 17 2022" -A x64 "%NATIVE_DIR%"
    if %ERRORLEVEL% NEQ 0 goto :fail
)

:: Build
echo [2/4] Building...
%CMAKE% --build "%NATIVE_DIR%build" --config Release
if %ERRORLEVEL% NEQ 0 goto :fail

:: Read plugin name and type from CMakeCache
for /f "tokens=2 delims==" %%a in ('findstr "PLUGIN_NAME:INTERNAL" "%NATIVE_DIR%build\CMakeCache.txt"') do set PNAME=%%a
for /f "tokens=2 delims==" %%a in ('findstr "PLUGIN_TYPE:INTERNAL" "%NATIVE_DIR%build\CMakeCache.txt"') do set PTYPE=%%a

:: Fallback
if "%PNAME%"=="" set PNAME=maxjs
if "%PTYPE%"=="" set PTYPE=gup

set PLUGIN_FILE=%PNAME%.%PTYPE%
set PLUGIN_SRC=%NATIVE_DIR%build\Release\%PLUGIN_FILE%
set PLUGIN_DST=C:\Program Files\Autodesk\3ds Max 2026\plugins\%PLUGIN_FILE%
set WEB_DST=C:\Program Files\Autodesk\3ds Max 2026\plugins\maxjs_web

:: Deploy plugin
echo [3/4] Deploying %PLUGIN_FILE%...
copy /Y "%PLUGIN_SRC%" "%PLUGIN_DST%"
if %ERRORLEVEL% NEQ 0 (
    echo Deploy failed - retrying as Administrator...
    powershell -Command "Start-Process cmd -ArgumentList '/c copy /Y \"%PLUGIN_SRC%\" \"%PLUGIN_DST%\" && xcopy /Y /E /I \"%NATIVE_DIR%web\" \"%WEB_DST%\" && echo SUCCESS && pause' -Verb RunAs"
    goto :done
)

:: Deploy web files
echo [4/4] Deploying web files...
xcopy /Y /E /I "%NATIVE_DIR%web" "%WEB_DST%"
if %ERRORLEVEL% NEQ 0 (
    echo Web deploy failed - retrying as Administrator...
    powershell -Command "Start-Process cmd -ArgumentList '/c xcopy /Y /E /I \"%NATIVE_DIR%web\" \"%WEB_DST%\" && echo SUCCESS && pause' -Verb RunAs"
    goto :done
)

echo.
echo === Done! Restart 3ds Max to load %PLUGIN_FILE% ===
goto :done

:fail
echo.
echo === BUILD FAILED ===
pause
exit /b 1

:done
pause
