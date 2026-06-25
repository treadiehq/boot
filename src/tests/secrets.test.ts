import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  decrypt,
  encrypt,
  exportKeyBase64,
  generateKey,
  importKeyBase64,
  keyExists,
  loadKey,
  loadOrCreateKey,
  secretKeyPath,
} from "../core/secrets";

let home: string;
const prevHome = process.env.BOOT_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "boot-secrets-"));
  process.env.BOOT_HOME = home;
});

afterEach(async () => {
  process.env.BOOT_HOME = prevHome;
  await fs.rm(home, { recursive: true, force: true });
});

describe("encrypt / decrypt", () => {
  it("round-trips a value", () => {
    const key = generateKey();
    const blob = encrypt("hunter2", key);
    expect(blob.alg).toBe("aes-256-gcm");
    expect(decrypt(blob, key)).toBe("hunter2");
  });

  it("fails to decrypt with the wrong key", () => {
    const blob = encrypt("secret", generateKey());
    expect(() => decrypt(blob, generateKey())).toThrow(/wrong key or tampered/);
  });

  it("detects tampering via the GCM auth tag", () => {
    const key = generateKey();
    const blob = encrypt("secret", key);
    const data = Buffer.from(blob.data, "base64");
    data[0] ^= 0xff; // flip a bit
    const tampered = { ...blob, data: data.toString("base64") };
    expect(() => decrypt(tampered, key)).toThrow(/tampered/);
  });
});

describe("key management", () => {
  it("creates a key on first use, then loads the same one", async () => {
    expect(keyExists()).toBe(false);
    const { key, created } = await loadOrCreateKey();
    expect(created).toBe(true);
    expect(key).toHaveLength(32);
    expect(keyExists()).toBe(true);

    const again = await loadOrCreateKey();
    expect(again.created).toBe(false);
    expect(again.key.equals(key)).toBe(true);
  });

  it("writes the key file with 0600 permissions", async () => {
    await loadOrCreateKey();
    const stat = await fs.stat(secretKeyPath());
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("throws a friendly error when the key is missing", async () => {
    await expect(loadKey()).rejects.toThrow(/No boot secret key/);
  });

  it("exports and imports a key across machines", async () => {
    await loadOrCreateKey();
    const exported = await exportKeyBase64();

    // Simulate a second machine with its own (empty) home.
    const otherHome = await fs.mkdtemp(path.join(os.tmpdir(), "boot-secrets-b-"));
    process.env.BOOT_HOME = otherHome;
    try {
      expect(keyExists()).toBe(false);
      await importKeyBase64(exported);
      expect((await loadKey()).toString("base64")).toBe(exported);
    } finally {
      await fs.rm(otherHome, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing key without force", async () => {
    await loadOrCreateKey();
    const other = generateKey().toString("base64");
    await expect(importKeyBase64(other)).rejects.toThrow(/already exists/);
    await importKeyBase64(other, true); // force succeeds
    expect((await loadKey()).toString("base64")).toBe(other);
  });

  it("rejects a malformed key", async () => {
    await expect(importKeyBase64("not-a-real-key")).rejects.toThrow(/Invalid boot secret key/);
  });
});
