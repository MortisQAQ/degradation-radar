# Register (or remove) the hourly pelican probe on Windows.
#
#   pwsh -NoProfile -File scripts/install-schedule.ps1
#   pwsh -NoProfile -File scripts/install-schedule.ps1 -Uninstall
#   pwsh -NoProfile -File scripts/install-schedule.ps1 -EveryHours 2
#
# Two mechanisms, because they need different privileges:
#   hourly     -> Task Scheduler (/SC HOURLY); no elevation required
#   at sign-in -> HKCU\Software\Microsoft\Windows\CurrentVersion\Run pointing at
#                 a hidden launcher. schtasks /SC ONLOGON needs admin, and the
#                 Startup folder is blocked for some sandboxed shells; the Run
#                 key is user-writable and does the same job.
#
# Why sign-in and not AtStartup: the probe drives the real agy CLI, which needs
# your user session for its stored credentials. A pre-login task has no session
# and fails in ways that look like model failures.
param(
  [switch]$Uninstall,
  [int]$EveryHours = 1,
  [string]$Model = 'gemini-4-hydrogen-high',
  [string]$Probes = 'pelican-bicycle'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$script = Join-Path $root 'scripts\scheduled-probe.mjs'
$node = (Get-Command node -ErrorAction Stop).Source

$taskName = 'DegradationRadar-Hourly'
$legacyLogon = 'DegradationRadar-AtLogon'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runValue = 'DegradationRadarProbe'
$launcher = Join-Path $root 'data\launch-probe.vbs'

if ($Uninstall) {
  schtasks /Query /TN $taskName *> $null
  if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $taskName /F | Out-Null
    Write-Host "removed task: $taskName" -ForegroundColor Yellow
  } else {
    Write-Host "not present: $taskName" -ForegroundColor DarkGray
  }
  schtasks /Query /TN $legacyLogon *> $null
  if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $legacyLogon /F | Out-Null
    Write-Host "removed task: $legacyLogon" -ForegroundColor Yellow
  }
  $existing = Get-ItemProperty -Path $runKey -Name $runValue -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-ItemProperty -Path $runKey -Name $runValue -Force
    Write-Host "removed logon entry: $runValue" -ForegroundColor Yellow
  }
  if (Test-Path $launcher) {
    Remove-Item $launcher -Force
    Write-Host "removed launcher: $launcher" -ForegroundColor Yellow
  }
  return
}

if (-not (Test-Path $script)) { throw "missing $script" }

Write-Host "node   : $node"
Write-Host "script : $script"
Write-Host "model  : $Model   probes: $Probes"
Write-Host ''

Write-Host "==> $taskName (every $EveryHours h)" -ForegroundColor Cyan

# Call node directly. Wrapping this in `cmd /c` made the task die with
# STATUS_CONTROL_C_EXIT (0xC000013A) when its console went away, losing the
# result line it was about to log. Model and probes travel as CLI flags, so no
# shell is needed to set environment variables.
$action = '"' + $node + '" "' + $script + '" --model ' + $Model + ' --probes ' + $Probes
# /IT: only run when this user is signed in — the probe needs the user session
# for agy's stored credentials.
schtasks /Create /TN $taskName /TR $action /SC HOURLY /MO $EveryHours /RL LIMITED /IT /F | Out-Null

schtasks /Query /TN $legacyLogon *> $null
if ($LASTEXITCODE -eq 0) { schtasks /Delete /TN $legacyLogon /F | Out-Null }

Write-Host '==> logon entry (hidden launcher, no admin)' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path (Split-Path $launcher) | Out-Null
# Build the launcher with a placeholder substitution: concatenating paths into
# an array produced a file with the path split across lines, which VBScript
# rejects with "unterminated string constant".
$vbsTemplate = @'
' Degradation Radar - runs the pelican probe once at sign-in.
' Hidden window: output goes to data\scheduled.log.
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "__ROOT__"
shell.Run """__NODE__"" ""__SCRIPT__""", 0, False
'@
$vbs = $vbsTemplate.Replace('__ROOT__', $root).Replace('__NODE__', $node).Replace('__SCRIPT__', $script)
[IO.File]::WriteAllText($launcher, $vbs, [Text.Encoding]::ASCII)
New-ItemProperty -Path $runKey -Name $runValue -Value ('wscript.exe "' + $launcher + '"') -PropertyType String -Force | Out-Null
Write-Host "    $launcher"
Write-Host '    HKCU Run -> DegradationRadarProbe'

Write-Host ''
$info = schtasks /Query /TN $taskName /FO LIST /V 2>$null
$next = ($info | Select-String -Pattern 'Next Run Time|下次运行时间' | Select-Object -First 1).Line
$status = ($info | Select-String -Pattern '^Status|^状态' | Select-Object -First 1).Line
Write-Host $taskName -ForegroundColor Green
if ($next) { Write-Host ('    ' + ($next -replace '\s+', ' ')) }
if ($status) { Write-Host ('    ' + ($status -replace '\s+', ' ')) }

Write-Host ''
Write-Host '结果: http://127.0.0.1:7417/     日志: data\scheduled.log' -ForegroundColor Green
Write-Host '立即试跑: schtasks /Run /TN ' -NoNewline
Write-Host $taskName -ForegroundColor Yellow
