import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { linkCommand } from "../commands/link";
import { envInit, envKeyReceive, envKeyRevoke, envKeyShare } from "../commands/env";
import { readKeyring } from "../core/keyring";
import { exportKeyBase64, keyExists } from "../core/secrets";

function gitUsable(): boolean {
  let probe: string | null = null;
  try {
    probe = mkdtempSync(path.join(os.tmpdir(), "boot-gitprobe-"));
    execFileSync("git", ["init", "-q"], { cwd: probe, stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    if (probe) rmSync(probe, { recursive: true, force: true });
  }
}

const GIT_OK = gitUsable();
const PASS = "correct horse battery staple";

describe.skipIf(!GIT_OK)("env key share / receive (e2e)", () => {
  let e2eRoot: string;
  let sharedFolder: string;
  let homeA: string;
  let homeB: string;
  let homeC: string;
  let homeD: string;
  let wsA: string;
  let wsB: string;
  let wsC: string;
  let wsD: string;
  const prevHome = process.env.BOOT_HOME;

  async function asMachine<T>(home: string, fn: () => Promise<T>): Promise<T> {
    process.env.BOOT_HOME = home;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      spy.mockRestore();
      process.env.BOOT_HOME = prevHome;
    }
  }

  beforeAll(async () => {
    e2eRoot = await fs.mkdtemp(path.join(os.tmpdir(), "boot-keyshare-"));
    sharedFolder = path.join(e2eRoot, "dropbox", "boot-map");
    homeA = path.join(e2eRoot, "homeA");
    homeB = path.join(e2eRoot, "homeB");
    homeC = path.join(e2eRoot, "homeC");
    homeD = path.join(e2eRoot, "homeD");
    wsA = path.join(e2eRoot, "wsA");
    wsB = path.join(e2eRoot, "wsB");
    wsC = path.join(e2eRoot, "wsC");
    wsD = path.join(e2eRoot, "wsD");
    await fs.mkdir(wsA, { recursive: true });
    await fs.mkdir(wsB, { recursive: true });
    await fs.mkdir(wsC, { recursive: true });
    await fs.mkdir(wsD, { recursive: true });
  });

  afterAll(async () => {
    process.env.BOOT_HOME = prevHome;
    await fs.rm(e2eRoot, { recursive: true, force: true });
  });

  it("escrows the key on A and installs the identical key on B via passphrase", async () => {
    const keyA = await asMachine(homeA, async () => {
      await linkCommand(sharedFolder, wsA, { folder: true });
      await envInit();
      await envKeyShare({ cwd: wsA, passphrase: PASS });
      return exportKeyBase64();
    });

    const keyB = await asMachine(homeB, async () => {
      await linkCommand(sharedFolder, wsB, { folder: true });
      expect(keyExists()).toBe(false);
      await envKeyReceive({ cwd: wsB, passphrase: PASS });
      expect(keyExists()).toBe(true);
      return exportKeyBase64();
    });

    expect(keyB).toBe(keyA);
  });

  it("rejects a wrong passphrase and installs nothing", async () => {
    await asMachine(homeC, async () => {
      await linkCommand(sharedFolder, wsC, { folder: true });
      await expect(envKeyReceive({ cwd: wsC, passphrase: "nope" })).rejects.toThrow(/passphrase/i);
      expect(keyExists()).toBe(false);
    });
  });

  it("revoke prunes the escrowed entry so new machines can no longer receive", async () => {
    // The escrowed entry is labelled with A's hostname; read it back from the map.
    const escrowed = await readKeyring(sharedFolder);
    const label = escrowed?.entries[0]?.label;
    expect(label).toBeTruthy();

    await asMachine(homeA, () => envKeyRevoke(label!, { cwd: wsA }));
    expect((await readKeyring(sharedFolder))?.entries ?? []).toHaveLength(0);

    await asMachine(homeD, async () => {
      await linkCommand(sharedFolder, wsD, { folder: true });
      await expect(envKeyReceive({ cwd: wsD, passphrase: PASS })).rejects.toThrow(/escrow/i);
      expect(keyExists()).toBe(false);
    });
  });
});
