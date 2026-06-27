# SmartEX領収書 月末自動取得 タスクスケジューラ登録スクリプト
# 使い方: PowerShellで実行 → 管理者権限が必要
#   .\setup-scheduler.ps1
#   .\setup-scheduler.ps1 -Remove  # 登録解除

param(
    [switch]$Remove
)

$TaskName = "SmartEX-Receipt-Monthly"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
$IndexJs = Join-Path $ScriptDir "index.js"
$LogFile = Join-Path $ScriptDir "output\scheduler.log"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "タスク '$TaskName' を削除しました。" -ForegroundColor Green
    exit 0
}

if (-not $NodePath) {
    Write-Host "エラー: Node.jsが見つかりません。" -ForegroundColor Red
    exit 1
}

# 毎月25日 21:00 に実行（月末前に取得）
$Trigger = New-ScheduledTaskTrigger -Monthly -DaysOfMonth 25 -At "21:00"
$Action = New-ScheduledTaskAction `
    -Execute $NodePath `
    -Argument "`"$IndexJs`"" `
    -WorkingDirectory $ScriptDir
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

Register-ScheduledTask `
    -TaskName $TaskName `
    -Trigger $Trigger `
    -Action $Action `
    -Settings $Settings `
    -Description "SmartEX領収書を毎月25日に自動取得" `
    -Force | Out-Null

Write-Host ""
Write-Host "タスクスケジューラに登録しました:" -ForegroundColor Green
Write-Host "  タスク名: $TaskName"
Write-Host "  実行日時: 毎月25日 21:00"
Write-Host "  実行内容: node $IndexJs"
Write-Host ""
Write-Host "確認: タスク スケジューラ → $TaskName"
Write-Host "削除: .\setup-scheduler.ps1 -Remove"
