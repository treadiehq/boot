<#
.SYNOPSIS
  Download boot for Windows and install it on PATH.

.DESCRIPTION
  Run it directly from the web:

    irm https://raw.githubusercontent.com/treadiehq/boot/main/scripts/install.ps1 | iex

  Environment overrides:
    BOOT_VERSION   release tag to install, e.g. v0.1.0 (default: latest)
    BOOT_BIN_DIR   where to install boot.exe (default: %LOCALAPPDATA%\boot\bin)
    BOOT_REPO      owner/repo to download releases from (default: treadiehq/boot)
#>

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say($msg) { Write-Host "-> $msg" -ForegroundColor DarkGray }
function Ok($msg)  { Write-Host "OK $msg"  -ForegroundColor Green }
function Die($msg) { Write-Host "x $msg"   -ForegroundColor Red; exit 1 }

$repo    = if ($env:BOOT_REPO)    { $env:BOOT_REPO }    else { 'treadiehq/boot' }
$version = if ($env:BOOT_VERSION) { $env:BOOT_VERSION } else { 'latest' }
$binDir  = if ($env:BOOT_BIN_DIR) { $env:BOOT_BIN_DIR } else { Join-Path $env:LOCALAPPDATA 'boot\bin' }

# Boot currently publishes a Windows x64 binary, which Windows ARM64 runs through emulation.
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Say "ARM64 detected; installing the x64 binary through Windows emulation."
}

$asset = 'boot-windows-x64.exe'
if ($version -eq 'latest') {
  $url = "https://github.com/$repo/releases/latest/download/$asset"
} else {
  $url = "https://github.com/$repo/releases/download/$version/$asset"
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$dest = Join-Path $binDir 'boot.exe'
$old  = "$dest.old"

# Clean up a stale copy left behind by a previous self-update, if it's no longer locked.
if (Test-Path $old) { try { Remove-Item $old -Force -ErrorAction Stop } catch {} }

Say "Downloading $asset ($version)..."
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("boot-" + [guid]::NewGuid().ToString('N') + '.exe')
try {
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
} catch {
  Die "Could not download $url`nCheck your network connection and available releases: https://github.com/$repo/releases"
}

# Windows locks a running .exe, but it can still be renamed — move the old one
# aside so an in-place `boot update` works, then drop the freshly downloaded one in.
if (Test-Path $dest) {
  try { Move-Item -Path $dest -Destination $old -Force } catch {}
}
Move-Item -Path $tmp -Destination $dest -Force

try {
  $installed = (& $dest --version).Trim()
} catch {
  Die "The installed binary could not run: $dest"
}
Ok "Installed boot $installed at $dest"

# --- ensure the install dir is on the user PATH ------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$onPath = $userPath -and (($userPath -split ';') -contains $binDir)
if (-not $onPath) {
  $newPath = if ([string]::IsNullOrEmpty($userPath)) { $binDir } else { "$userPath;$binDir" }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  $env:Path = "$env:Path;$binDir"
  Say "Added $binDir to your user PATH. New terminals will use it automatically."
}

Write-Host ""
Ok "Boot is installed. Initialize a workspace with:"
Write-Host "    boot init" -ForegroundColor White
Write-Host ""
Write-Host "Update later:  boot update" -ForegroundColor DarkGray
