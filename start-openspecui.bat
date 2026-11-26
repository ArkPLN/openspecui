@echo off
chcp 65001 >nul
setlocal EnableExtensions

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^(>= 20.0.0^)。
    pause
    exit /b 1
)

if not exist "%~dp0node_modules" (
    echo [OpenSpecUI] 首次运行，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败。
        pause
        exit /b 1
    )
)

if not exist "%~dp0packages\server\dist\cli.js" (
    goto :build_app
)
if not exist "%~dp0packages\server\dist\public\index.html" (
    goto :build_app
)
goto :start_app

:build_app
echo [OpenSpecUI] 未检测到完整构建产物，正在执行构建...
call npm run build
if errorlevel 1 (
    echo [错误] 项目构建失败。
    pause
    exit /b 1
)

:start_app
echo [OpenSpecUI] 正在启动本地工作台（默认自动打开浏览器，按 Ctrl+C 停止服务）...
node "%~dp0packages\server\dist\cli.js" %*
set "EXIT_CODE=%errorlevel%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [错误] 服务异常退出，退出码: %EXIT_CODE%
    pause
    exit /b %EXIT_CODE%
)

endlocal
