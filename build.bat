@echo off
setlocal

for %%I in ("%~dp0.") do set "ROOT=%%~fI"
set "BUILD_DIR=%ROOT%\build"
set "CMAKE_EXE=cmake"
if exist "C:\Program Files\CMake\bin\cmake.exe" set "CMAKE_EXE=C:\Program Files\CMake\bin\cmake.exe"

call "%ROOT%\setup_webview2.bat"
if errorlevel 1 goto :fail

echo [1/4] Configuring...
"%CMAKE_EXE%" -S "%ROOT%" -B "%BUILD_DIR%" -G "Visual Studio 17 2022" -A x64
if errorlevel 1 goto :fail

echo [2/4] Building...
"%CMAKE_EXE%" --build "%BUILD_DIR%" --config Release --target maxjs
if errorlevel 1 goto :fail

if /I "%MAXJS_SKIP_DEPLOY%"=="1" (
    echo.
    echo Build complete. Deployment skipped because MAXJS_SKIP_DEPLOY=1.
    goto :done
)

set "PLUGIN_NAME=maxjs"
set "PLUGIN_TYPE=gup"
for /f "tokens=2 delims==" %%a in ('findstr "PLUGIN_NAME:INTERNAL" "%BUILD_DIR%\CMakeCache.txt"') do set "PLUGIN_NAME=%%a"
for /f "tokens=2 delims==" %%a in ('findstr "PLUGIN_TYPE:INTERNAL" "%BUILD_DIR%\CMakeCache.txt"') do set "PLUGIN_TYPE=%%a"

set "PLUGIN_FILE=%PLUGIN_NAME%.%PLUGIN_TYPE%"
set "PLUGIN_SRC=%BUILD_DIR%\Release\%PLUGIN_FILE%"
set "PLUGIN_DST=C:\Program Files\Autodesk\3ds Max 2026\plugins\%PLUGIN_FILE%"
set "WEB_DST=C:\Program Files\Autodesk\3ds Max 2026\plugins\maxjs_web"

echo [3/4] Deploying plugin...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Copy-Item -Force '%PLUGIN_SRC%' '%PLUGIN_DST%'" >nul
if errorlevel 1 goto :deploy_fail

echo [4/4] Deploying web runtime...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$dst='%WEB_DST%'; New-Item -ItemType Directory -Force -Path $dst | Out-Null; Copy-Item -Recurse -Force '%ROOT%\web\*' $dst" >nul
if errorlevel 1 goto :deploy_fail

echo.
echo Done. Restart 3ds Max to load %PLUGIN_FILE%.
goto :done

:deploy_fail
echo.
echo Deployment failed. Run install.bat to retry with elevation.
exit /b 1

:fail
echo.
echo Build failed.
exit /b 1

:done
exit /b 0
