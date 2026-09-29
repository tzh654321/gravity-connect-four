# 安装 APK 到已连接的安卓设备
$ErrorActionPreference = "Stop"
$Adb = "D:\Android\sdk\platform-tools\adb.exe"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Apk = Get-ChildItem "$Root\out\*.apk" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $Apk) { Write-Error "未找到 APK，请先运行 tools/build.py"; exit 1 }
Write-Host "安装: $($Apk.Name)"
& $Adb install -r $Apk.FullName
if ($LASTEXITCODE -ne 0) { exit 1 }
& $Adb shell monkey -p com.tzh.g4 -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host "已启动 重力四子棋"
