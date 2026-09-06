import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// The same opt-in real-Docker suite runs from cmd.exe, PowerShell, and POSIX shells.
const root = fileURLToPath(new URL("../../", import.meta.url));
const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "src/tests/sessionDocker.test.ts", "src/tests/sessionRuntimeDocker.test.ts", "--hookTimeout=60000"], {
  cwd: root, env: { ...process.env, BOOT_TEST_DOCKER: "1" }, stdio: "inherit",
});
child.once("error", () => { console.error("Could not start the session runtime tests."); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
