# 热更新：把最新 index.html 推送到手机（无需重新打包/安装 APK）
# 前提：APK 为 debuggable 构建（本工程默认如此）
$ErrorActionPreference = "Stop"
$Adb = "D:\Android\sdk\platform-tools\adb.exe"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Html = Join-Path (Split-Path -Parent $Root) "index.html"
if (-not (Test-Path $Html)) { Write-Error "未找到 index.html"; exit 1 }

$devices = & $Adb devices
if ($devices -notmatch "device$") { Write-Error "未检测到已授权的设备（请先连上并允许 USB 调试）"; exit 1 }

Write-Host "推送 game.html → /data/local/tmp"
& $Adb push "$Html" /data/local/tmp/g4-game.html
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "写入应用内部覆盖目录 files/g4/"
& $Adb shell run-as com.tzh.g4 "sh -c 'mkdir -p files/g4 && cp /data/local/tmp/g4-game.html files/g4/game.html && rm -f /data/local/tmp/g4-game.html'"
if ($LASTEXITCODE -ne 0) { Write-Error "run-as 失败（确认 APK 为 debuggable 且包名 com.tzh.g4）"; exit 1 }

Write-Host "重启应用"
& $Adb shell am force-stop com.tzh.g4 | Out-Null
& $Adb shell monkey -p com.tzh.g4 -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host "完成：页面已热更新并重启应用"
