$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This suite requires a real Windows machine.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$originalRoot = $env:BOOT_TEST_WORKSPACE_ROOT
$originalCow = $env:BOOT_TEST_WINDOWS_EXPECT_COW
$fixtureRoot = Join-Path $env:TEMP ('boot-windows-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$script:failed = $false
function Run-Tests([string]$root, [bool]$cow) {
  $env:BOOT_TEST_WORKSPACE_ROOT = $root
  $env:BOOT_TEST_WINDOWS_EXPECT_COW = $(if ($cow) { '1' } else { '0' })
  & node (Join-Path $repoRoot 'node_modules/vitest/vitest.mjs') run src/tests/sessionWindows.test.ts src/tests/sessionWindowsShims.test.ts src/tests/sessionSubmodules.test.ts src/tests/sessionRuntime.test.ts --testTimeout=60000 --hookTimeout=30000
  if ($LASTEXITCODE -ne 0) { $script:failed = $true }
}
try {
  Write-Host 'Testing NTFS fallback and Windows Job Object execution'
  Run-Tests $fixtureRoot $false
  foreach ($cluster in @(4096, 65536)) {
    $disk = Join-Path $fixtureRoot ('refs-' + $cluster + '.vhdx')
    $letter = @('R','S','T','U','V','W','X','Y','Z') | Where-Object { -not (Test-Path ($_ + ':\')) } | Select-Object -First 1
    if (-not $letter) { throw 'No unused drive letter is available for the test VHD.' }
    $label = 'Boot-' + [Guid]::NewGuid().ToString('N').Substring(0, 20)
    $commands = Join-Path $fixtureRoot 'diskpart.txt'
    # Create only a new image; Storage cmdlets own its mount and dismount.
    @"
create vdisk file="$disk" maximum=4096 type=expandable
"@ | Set-Content -Encoding ASCII -Path $commands
    try {
      & diskpart /s $commands
      if ($LASTEXITCODE -ne 0) { throw 'Could not create the disposable ReFS test volume.' }
      $diskInfo = Mount-DiskImage -ImagePath $disk -StorageType VHD -NoDriveLetter -PassThru | Get-Disk
      if (@($diskInfo).Count -ne 1 -or $diskInfo.PartitionStyle -ne 'RAW') { throw 'The newly created test disk is not an empty image.' }
      $diskInfo | Initialize-Disk -PartitionStyle GPT -PassThru | New-Partition -UseMaximumSize -DriveLetter $letter | Format-Volume -FileSystem ReFS -AllocationUnitSize $cluster -NewFileSystemLabel $label -Confirm:$false | Out-Null
      $volume = Get-Volume -DriveLetter $letter
      if ($volume.FileSystem -ne 'ReFS' -or $volume.FileSystemLabel -ne $label) { throw 'The test volume is not the expected ReFS volume.' }
      $root = $letter + ':\boot-tests'
      New-Item -ItemType Directory -Path $root | Out-Null
      Write-Host "Testing real ReFS block cloning with $cluster-byte clusters"
      Run-Tests $root $true
    } finally {
      if (Test-Path -LiteralPath $disk) {
        if ((Get-DiskImage -ImagePath $disk).Attached) { Dismount-DiskImage -ImagePath $disk }
        if ((Get-DiskImage -ImagePath $disk).Attached) { throw 'The owned test image is still attached.' }
      }
    }
  }
} finally {
  $env:BOOT_TEST_WORKSPACE_ROOT = $originalRoot
  $env:BOOT_TEST_WINDOWS_EXPECT_COW = $originalCow
  for ($attempt = 0; ; $attempt++) {
    try { Remove-Item -LiteralPath $fixtureRoot -Recurse -Force; break }
    catch { if ($attempt -ge 20) { throw }; Start-Sleep -Milliseconds 500 }
  }
}
if ($script:failed) { throw 'Windows session validation failed.' }
