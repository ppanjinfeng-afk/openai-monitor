$ErrorActionPreference = 'Stop'

$nodePath = 'C:\Program Files\nodejs\node.exe'
$workdir = 'C:\Users\111\Desktop\monitor'
$dataDir = Join-Path $workdir 'data'

if (-not (Test-Path -LiteralPath $nodePath)) {
  throw "Node executable not found: $nodePath"
}

if (-not (Test-Path -LiteralPath $dataDir)) {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

function Start-HiddenNodeProcess {
  param(
    [string]$ScriptName,
    [int]$Port,
    [string]$StdoutLog,
    [string]$StderrLog
  )

  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'node') {
      Write-Output "$ScriptName already running (PID $($process.Id))"
      return
    }
  }

  Start-Process -FilePath $nodePath -ArgumentList @($ScriptName) -WorkingDirectory $workdir -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog | Out-Null

  Start-Sleep -Seconds 2

  $startedListener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $startedListener) {
    throw "$ScriptName failed to start on port $Port"
  }

  Write-Output "$ScriptName started on port $Port"
}

Start-HiddenNodeProcess -ScriptName 'maintenance-gateway.js' -Port 3001 `
  -StdoutLog (Join-Path $dataDir 'gateway.stdout.log') `
  -StderrLog (Join-Path $dataDir 'gateway.stderr.log')

Start-HiddenNodeProcess -ScriptName 'server.js' -Port 3000 `
  -StdoutLog (Join-Path $dataDir 'server.stdout.log') `
  -StderrLog (Join-Path $dataDir 'server.stderr.log')
