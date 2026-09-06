$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true') { throw 'This suite provisions an isolated WSL2 fixture on a Windows CI runner only. Use pnpm test:sessions:runtime with your existing local Docker elsewhere.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$id = [Guid]::NewGuid().ToString('N')
$distro = 'BootPostgres-' + $id
$fixture = Join-Path $env:RUNNER_TEMP $distro
$previousPsql = $env:BOOT_TEST_PSQL
$ownsDistribution = $false
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
  $env:BOOT_TEST_PSQL = Join-Path $env:PGBIN 'psql.exe'
  if (-not (Test-Path -LiteralPath $env:BOOT_TEST_PSQL)) { throw 'The Windows PostgreSQL client is required for host-side authentication tests.' }
  $existing = @(& wsl.exe --list --quiet | ForEach-Object { ($_ -replace "`0", '').Trim() })
  if ($existing -contains $distro) { throw 'The randomly named test distribution already exists.' }
  $base = 'https://cloud-images.ubuntu.com/wsl/releases/24.04/current/'
  $imageName = 'ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz'
  $archive = Join-Path $fixture $imageName
  Write-Host 'Downloading and verifying the official Ubuntu WSL2 fixture'
  Invoke-WebRequest ($base + $imageName) -OutFile $archive -UseBasicParsing
  $checksumFile = Join-Path $fixture 'SHA256SUMS'
  Invoke-WebRequest ($base + 'SHA256SUMS') -OutFile $checksumFile -UseBasicParsing
  $checksums = Get-Content -Raw -LiteralPath $checksumFile
  $expected = ($checksums -split "`n" | Where-Object { $_ -match ([regex]::Escape($imageName) + '$') } | ForEach-Object { ($_ -split '\s+')[0] })
  if (@($expected).Count -ne 1 -or (Get-FileHash -Algorithm SHA256 $archive).Hash -ine $expected) { throw 'Ubuntu WSL2 image checksum did not match.' }
  $ownsDistribution = $true
  & wsl.exe --import $distro (Join-Path $fixture 'disk') $archive --version 2
  if ($LASTEXITCODE -ne 0) { throw 'Could not import the owned WSL2 test distribution.' }
  # Only this newly created distribution is configured; existing distros and
  # the Windows Docker service/default context remain untouched.
  $setup = @'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl socat
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io
if ! docker info >/dev/null 2>&1; then
  nohup dockerd --host unix:///var/run/docker.sock >/var/log/boot-docker.log 2>&1 </dev/null &
fi
for attempt in $(seq 1 90); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker info --format 'Engine OS: {{.OSType}}'
docker version --format 'Engine version: {{.Server.Version}}'
docker pull postgres:16-alpine
docker pull postgres:17-alpine
'@
  # Preserve LF bytes; PowerShell's native stdin pipeline appends CRLF, which
  # can turn the last shell argument into an invalid image name.
  $setupFile = Join-Path $fixture 'setup-docker.sh'
  [IO.File]::WriteAllText($setupFile, ($setup -replace "`r", '') + "`n", [Text.UTF8Encoding]::new($false))
  $linuxSetup = (& wsl.exe --distribution $distro --user root --exec wslpath -a -u $setupFile).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the test setup script inside WSL2.' }
  & wsl.exe --distribution $distro --user root --exec bash $linuxSetup
  if ($LASTEXITCODE -ne 0) { throw 'The owned WSL2 Docker engine could not be prepared.' }
  Write-Host 'Testing native Windows Boot, a local named pipe, and real PostgreSQL 16/17 in WSL2'
  & node (Join-Path $repoRoot 'scripts/distribution/session-windows-docker.mjs') $distro
  if ($LASTEXITCODE -ne 0) { throw 'Native Windows PostgreSQL validation failed.' }
} finally {
  $env:BOOT_TEST_PSQL = $previousPsql
  if ($ownsDistribution) {
    $registered = @(& wsl.exe --list --quiet | ForEach-Object { ($_ -replace "`0", '').Trim() })
    if ($registered -contains $distro) {
      & wsl.exe --terminate $distro
      & wsl.exe --unregister $distro
      if ($LASTEXITCODE -ne 0) { throw 'Could not remove the owned WSL2 test distribution.' }
    }
  }
  for ($attempt = 0; ; $attempt++) {
    try { Remove-Item -LiteralPath $fixture -Recurse -Force; break }
    catch { if ($attempt -ge 20) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
