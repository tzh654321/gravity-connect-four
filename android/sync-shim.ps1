# 热更新：把 android\inject\*.js（适配层/设置面板）推送到手机
# 仅改注入层时用；与 sync-html.ps1 互不干扰
$ErrorActionPreference = "Stop"
$Adb = "D:\Android\sdk\platform-tools\adb.exe"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Inject = Join-Path $Root "inject"

$devices = & $Adb devices
if ($devices -notmatch "device$") { Write-Error "未检测到已授权的设备"; exit 1 }

$all = @()
foreach ($f in Get-ChildItem "$Inject\*.js") {
    $name = $f.Name
    Write-Host "推送 $name"
    & $Adb push $f.FullName "/data/local/tmp/$name" | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 1 }
    & $Adb shell run-as com.tzh.g4 "sh -c 'cp /data/local/tmp/$name files/g4/$name && rm -f /data/local/tmp/$name'"
    if ($LASTEXITCODE -ne 0) { Write-Error "run-as 失败"; exit 1 }
    $all += $name
}
Write-Host "重启应用"
& $Adb shell am force-stop com.tzh.g4 | Out-Null
& $Adb shell monkey -p com.tzh.g4 -c android.intent.category.LAUNCHER 1 | Out-Null
Write-Host "完成：注入层已更新 ($($all -join ', '))"
