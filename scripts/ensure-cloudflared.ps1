$ErrorActionPreference = 'Stop'

$exePath = 'C:\Users\111\AppData\Local\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe'
$configPath = 'C:\Users\111\.cloudflared\config.yml'
$stdoutLog = 'C:\Users\111\Desktop\monitor\data\cloudflared.stdout.log'
$stderrLog = 'C:\Users\111\Desktop\monitor\data\cloudflared.stderr.log'
$nodePath = 'C:\Program Files\nodejs\node.exe'
$workdir = 'C:\Users\111\Desktop\monitor'
$gatewayStdoutLog = 'C:\Users\111\Desktop\monitor\data\gateway.stdout.log'
$gatewayStderrLog = 'C:\Users\111\Desktop\monitor\data\gateway.stderr.log'

if (-not (Test-Path -LiteralPath $exePath)) {
  throw "cloudflared executable not found: $exePath"
}

if (-not (Test-Path -LiteralPath $configPath)) {
  throw "cloudflared config not found: $configPath"
}

$logDir = Split-Path -Parent $stdoutLog
if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

function Get-CloudflaredProcess {
  Get-Process cloudflared -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $exePath } |
    Select-Object -First 1
}

function Ensure-Gateway {
  $listener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    return
  }

  Start-Process -FilePath $nodePath -ArgumentList @('maintenance-gateway.js') -WorkingDirectory $workdir -WindowStyle Hidden `
    -RedirectStandardOutput $gatewayStdoutLog -RedirectStandardError $gatewayStderrLog | Out-Null

  Start-Sleep -Seconds 2

  $startedListener = Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $startedListener) {
    throw 'maintenance gateway failed to start'
  }
}

Ensure-Gateway

$runningProcess = Get-CloudflaredProcess
if ($runningProcess) {
  Write-Output "cloudflared already running (PID $($runningProcess.Id))"
  exit 0
}

Start-Process `
  -FilePath $exePath `
  -ArgumentList @('tunnel', '--config', $configPath, 'run') `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog | Out-Null

Start-Sleep -Seconds 5

$startedProcess = Get-CloudflaredProcess
if (-not $startedProcess) {
  throw 'cloudflared failed to start'
}

Write-Output "cloudflared started (PID $($startedProcess.Id))"
