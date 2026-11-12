# 创建「股你唔到」每日/每周自动任务（当前用户，无需管理员）
# 用法（PowerShell，普通权限）：
#   powershell -ExecutionPolicy Bypass -File scripts\install_tasks.ps1
# 卸载：
#   powershell -ExecutionPolicy Bypass -File scripts\install_tasks.ps1 -Uninstall

param([switch]$Uninstall)

$ErrorActionPreference = "Stop"
$Base = "E:\12-1-good\hk-radar-pwa"
$Wrapper = Join-Path $Base "scripts\run_scheduled_task.ps1"
$Pwsh = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

$tasks = @(
  @{ Name = "HKRadar-OpenEastmoney"; Task = "openEastmoney"; Time = "09:15"; Hours = 1;  Desc = "自动启动东方财富客户端" },
  @{ Name = "HKRadar-Intraday";      Task = "intraday";      Time = "09:20"; Hours = 7;  Desc = "盘中采集：竞价/盘口/资金流" },
  @{ Name = "HKRadar-OpenPWA";       Task = "openPWA";       Time = "09:25"; Hours = 1;  Desc = "自动打开 PWA 页面（观察记录）" },
  @{ Name = "HKRadar-Announcements"; Task = "announcements"; Time = "18:30"; Hours = 1;  Desc = "公告采集：观察名单最近3天公告（巨潮公开接口）" },
  @{ Name = "HKRadar-L2Daily";       Task = "l2";            Time = "15:05"; Hours = 1;  Desc = "L2 归档/解析/特征/日报" },
  @{ Name = "HKRadar-HistoryDaily";  Task = "history";       Time = "19:00"; Hours = 1;  Desc = "历史/收盘采集（19:00 后龙虎榜已发布；涨停/炸板/资金流）" }
)

function Remove-TaskByName($name) {
  $t = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($t) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false
    Write-Host "已删除任务: $name"
  }
}

if ($Uninstall) {
  foreach ($t in $tasks) { Remove-TaskByName $t.Name }
  Remove-TaskByName "HKRadar-Weekly"
  Write-Host "全部 HKRadar 任务已删除。"
  exit 0
}

if (-not (Test-Path $Wrapper)) { throw "缺少脚本: $Wrapper" }

$principal = New-ScheduledTaskPrincipal -UserId ("{0}\{1}" -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited

foreach ($t in $tasks) {
  $action = New-ScheduledTaskAction -Execute $Pwsh -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`" -Task {1}" -f $Wrapper, $t.Task) -WorkingDirectory $Base
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $t.Time
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours $t.Hours) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $t.Desc -Force | Out-Null
  Write-Host ("已创建 {0} 工作日 {1}：{2}" -f $t.Name, $t.Time, $t.Desc)
}

# 每周任务：周五 19:10 补 7 天龙虎榜 + 备份（避开龙虎榜发布前）
$actionW = New-ScheduledTaskAction -Execute $Pwsh -Argument ("-NoProfile -ExecutionPolicy Bypass -File `"{0}`" -Task weekly" -f $Wrapper) -WorkingDirectory $Base
$triggerW = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At "19:10"
$settingsW = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "HKRadar-Weekly" -Action $actionW -Trigger $triggerW -Settings $settingsW -Principal $principal -Description "每周五：补 7 天龙虎榜 + 备份 forward_data" -Force | Out-Null
Write-Host "已创建 HKRadar-Weekly 每周五 19:10（7 天龙虎榜 + 备份）"

Write-Host "`n完成。验证：Get-ScheduledTask -TaskName 'HKRadar-*' | Format-Table TaskName,State"
