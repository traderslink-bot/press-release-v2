param(
  [Parameter(Mandatory = $true)]
  [int]$ChromePid
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$LogPath = Join-Path $PSScriptRoot "logs\manual-refresh-resume.log"
New-Item -ItemType Directory -Force -Path (Split-Path $LogPath -Parent) | Out-Null

function Write-ResumeLog {
  param([string]$Message)
  $Line = "[$((Get-Date).ToString('o'))] $Message"
  for ($Attempt = 0; $Attempt -lt 5; $Attempt++) {
    try {
      Add-Content -LiteralPath $LogPath -Value $Line
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
}

Set-Location $Root
Write-ResumeLog "Waiting for Stocktwits manual Chrome PID $ChromePid to close before one-shot retry."

try {
  Wait-Process -Id $ChromePid -ErrorAction SilentlyContinue
} catch {
  Write-ResumeLog "Wait-Process ended with warning: $($_.Exception.Message)"
}

Start-Sleep -Seconds 3
Write-ResumeLog "Manual Chrome closed; starting one-shot Stocktwits retry."
node stocktwits/live-worker.js --once *>> $LogPath
Write-ResumeLog "One-shot Stocktwits retry finished."
