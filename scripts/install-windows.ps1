param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Refresh-Path {
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $parts = @($env:Path, $userPath, $machinePath) |
    ForEach-Object { if ($_){ $_ -split ';' } } |
    Where-Object { $_ } |
    Select-Object -Unique
  $env:Path = $parts -join ';'
}

function Command-Path([string]$name) {
  $command = Get-Command $name -ErrorAction SilentlyContinue
  if ($command.Source) { return $command.Source }
  if ($command) { return $command.Path }
  return $null
}

function Invoke-WingetInstall([string]$id) {
  if (-not (Command-Path 'winget')) {
    throw 'winget was not found. Install Microsoft App Installer or install the missing dependency manually.'
  }
  & winget install --id $id --source winget --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget install failed: $id (exit code $LASTEXITCODE)" }
  Refresh-Path
}

function Invoke-Npm([string[]]$arguments) {
  & npm @arguments
  if ($LASTEXITCODE -ne 0) { throw "npm failed (exit code $LASTEXITCODE): npm $($arguments -join ' ')" }
}

try {
  Push-Location $repoRoot
  Refresh-Path

  if (-not (Command-Path 'node')) {
    if ($CheckOnly) { throw 'Node.js was not found. Install Node.js 22 or newer.' }
    Write-Host 'Installing Node.js LTS...'
    Invoke-WingetInstall 'OpenJS.NodeJS.LTS'
  }
  if (-not (Command-Path 'node')) { throw 'Node.js is still unavailable after installation. Reopen PowerShell.' }

  $nodeVersion = (& node --version).Trim()
  $nodeMajor = [int](($nodeVersion -replace '^v', '').Split('.')[0])
  if ($nodeMajor -lt 22) { throw "Node.js $nodeVersion is too old. wecode requires Node.js 22 or newer." }
  if (-not (Command-Path 'npm')) { throw 'npm was not found. Reopen PowerShell and try again.' }

  if (-not (Command-Path 'codex')) {
    if ($CheckOnly) { throw 'Codex CLI was not found. Install @openai/codex.' }
    Write-Host 'Installing Codex CLI...'
    Invoke-Npm @('--global', '@openai/codex')
    Refresh-Path
  }
  if (-not (Command-Path 'codex')) { throw 'Codex CLI is still unavailable after installation. Reopen PowerShell.' }

  if (-not (Command-Path 'cloudflared')) {
    if ($CheckOnly) { throw 'cloudflared was not found.' }
    Write-Host 'Installing cloudflared...'
    Invoke-WingetInstall 'Cloudflare.cloudflared'
  }
  if (-not (Command-Path 'cloudflared')) { throw 'cloudflared is still unavailable after installation. Reopen PowerShell.' }

  if (-not $CheckOnly) {
    Write-Host 'Installing project dependencies and registering wecode...'
    Invoke-Npm @('ci')
    Invoke-Npm @('run', 'build')
    Invoke-Npm @('link')
    Refresh-Path
  }
  if (-not (Command-Path 'wecode')) {
    throw 'wecode is unavailable. Reopen PowerShell or run npm link.'
  }

  Write-Host "Node.js: $nodeVersion"
  Write-Host "Codex: $((& codex --version 2>$null).Trim())"
  Write-Host "cloudflared: $((& cloudflared --version 2>$null).Trim())"
  Write-Host 'Setup check complete. Run wecode for first-time QR login, or wecode restart if already logged in.'
}
finally {
  Pop-Location
}
