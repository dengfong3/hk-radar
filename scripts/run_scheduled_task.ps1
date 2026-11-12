param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('intraday','l2','history','weekly','openEastmoney','openPWA','announcements')]
  [string]$Task
)

$ErrorActionPreference = "Continue"
$Base = "E:\12-1-good\hk-radar-pwa"
$Research = Join-Path $Base "research"
$LogDir = Join-Path $Research "forward_data\logs"
$Node = "C:\Program Files\nodejs\node.exe"
$Python = "C:\Users\11341\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$Edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$Eastmoney = "D:\eastmoney\swc8\mainfree.exe"
$PwaUrl = "https://dengfong3.github.io/hk-radar/"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$Log = Join-Path $LogDir ("{0}_{1}.log" -f $Task, (Get-Date -Format "yyyyMMdd_HHmmss"))

function Write-Log($msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $msg
  Write-Output $line
  Add-Content -Path $Log -Value $line -Encoding UTF8
}

function Invoke-Logged([string]$exe, [string[]]$cmdArgs) {
  Write-Log ("RUN " + $exe + " " + ($cmdArgs -join " "))
  & $exe @cmdArgs 2>&1 | ForEach-Object { Add-Content -Path $Log -Value $_ -Encoding UTF8; Write-Output $_ }
}

Set-Location $Base
Write-Log "TASK=$Task start"

switch ($Task) {
  "intraday" {
    Invoke-Logged $Node @("research\collect_intraday_v4.mjs")
  }
  "announcements" {
    Invoke-Logged $Python @("research\sync_pwa_watchlist.py")
    Invoke-Logged $Python @("research\collect_announcements.py", "--days=3")
  }
  "l2" {
    Invoke-Logged $Python @("research\run_l2_daily.py")
  }
  "history" {
    Invoke-Logged $Python @("research\collect_history_v4.py", "--days=2", "--lhb-retries=6", "--lhb-wait=60")
  }
  "weekly" {
    Invoke-Logged $Python @("research\collect_history_v4.py", "--days=7", "--lhb-retries=6", "--lhb-wait=60")
    $Backup = Join-Path $Research "forward_data\backups"
    New-Item -ItemType Directory -Force -Path $Backup | Out-Null
    $zip = Join-Path $Backup ("forward_data_{0}.zip" -f (Get-Date -Format "yyyyMMdd"))
    $src = Join-Path $Research "forward_data"
    try {
      Compress-Archive -Path $src -DestinationPath $zip -Force
      Write-Log "BACKUP $zip"
    } catch {
      Write-Log ("BACKUP FAILED: " + $_.Exception.Message)
    }
  }
  "openEastmoney" {
    $p = Get-Process -Name "mainfree" -ErrorAction SilentlyContinue
    if ($p) {
      Write-Log "Eastmoney already running; skip launch"
    } else {
      Start-Process -FilePath $Eastmoney -WorkingDirectory (Split-Path $Eastmoney)
      Write-Log "Started Eastmoney"
    }
  }
  "openPWA" {
    Start-Process -FilePath $Edge -ArgumentList @("--new-window", $PwaUrl)
    Write-Log "Opened PWA in Edge"
  }
}

Write-Log "TASK=$Task done"
