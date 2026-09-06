#!/usr/bin/env bash
set -euo pipefail
cp -R /input/src /work/src
node -e 'const fs=require("node:fs");const text=fs.readFileSync("/work/src/core/sessionWindowsSource.ts","utf8");fs.writeFileSync("/work/windows-session.cs",text.split("String.raw`",2)[1].split("`;",1)[0]);'
mcs -warnaserror -out:/work/windows-session.exe /work/windows-session.cs
mkdir -p /mnt/cow
for filesystem in btrfs xfs; do
  truncate -s 2G "/$filesystem.img"
  if [[ "$filesystem" == btrfs ]]; then
    mkfs.btrfs -q -f "/$filesystem.img"
  else
    mkfs.xfs -q -f -m reflink=1 "/$filesystem.img"
  fi
  mount -o loop "/$filesystem.img" /mnt/cow
  export BOOT_TEST_WORKSPACE_ROOT=/mnt/cow
  export BOOT_TEST_REQUIRE_COW=1
  echo "Testing real forced reflinks on $filesystem"
  node node_modules/vitest/vitest.mjs run src/tests/sessions.test.ts src/tests/sessionFailures.test.ts src/tests/sessionProcesses.test.ts src/tests/preparationRegressions.test.ts src/tests/sessionSubmodules.test.ts src/tests/sessionRuntime.test.ts
  umount /mnt/cow
  rm "/$filesystem.img"
done
