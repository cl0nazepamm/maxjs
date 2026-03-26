@echo off
setlocal

set SCRIPT_DIR=%~dp0

if exist "%SCRIPT_DIR%thirdparty\webview2\build\native\include\WebView2.h" (
    echo WebView2 SDK already present.
    exit /b 0
)

echo Downloading WebView2 SDK from NuGet...
mkdir "%SCRIPT_DIR%thirdparty" 2>nul

powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2' -OutFile '%SCRIPT_DIR%thirdparty\webview2.zip' -UseBasicParsing"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Failed to download WebView2 SDK.
    pause
    exit /b 1
)

echo Extracting...
powershell -Command "Expand-Archive -Path '%SCRIPT_DIR%thirdparty\webview2.zip' -DestinationPath '%SCRIPT_DIR%thirdparty\webview2' -Force"
del "%SCRIPT_DIR%thirdparty\webview2.zip" 2>nul

if exist "%SCRIPT_DIR%thirdparty\webview2\build\native\include\WebView2.h" (
    echo.
    echo WebView2 SDK ready.
) else (
    echo.
    echo ERROR: Extraction failed — WebView2.h not found.
    pause
    exit /b 1
)
