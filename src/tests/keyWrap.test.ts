import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateKey, unwrapKey, wrapKey, wrappedKeySchema } from "../core/secrets";
import {
  hasKeyringEntry,
  latestEntry,
  listKeyringLabels,
  readKeyring,
  removeKeyringEntry,
  upsertKeyringEntry,
  type KeyringEntry,
} from "../core/keyring";

describe("wrapKey / unwrapKey", () => {
  it("round-trips a key through a passphrase", () => {
    const key = generateKey();
    const wrapped = wrapKey(key, "correct horse battery staple");
    expect(wrappedKeySchema.safeParse(wrapped).success).toBe(true);
    const out = unwrapKey(wrapped, "correct horse battery staple");
    expect(out.equals(key)).toBe(true);
  });

  it("produces a different blob each time (random salt + iv)", () => {
    const key = generateKey();
    const a = wrapKey(key, "pw");
    const b = wrapKey(key, "pw");
    expect(a.data).not.toBe(b.data);
    expect(a.salt).not.toBe(b.salt);
  });

  it("rejects a wrong passphrase", () => {
    const wrapped = wrapKey(generateKey(), "right");
    expect(() => unwrapKey(wrapped, "wrong")).toThrow(/passphrase/i);
  });

  it("rejects a tampered blob", () => {
    const wrapped = wrapKey(generateKey(), "pw");
    const tampered = { ...wrapped, data: Buffer.from("garbage").toString("base64") };
    expect(() => unwrapKey(tampered, "pw")).toThrow();
  });

  it("requires a non-empty passphrase to wrap", () => {
    expect(() => wrapKey(generateKey(), "")).toThrow(/passphrase/i);
  });
});

describe("keyring store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "boot-keyring-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function entry(label: string, createdAt: string): KeyringEntry {
    return { label, createdAt, wrapped: wrapKey(generateKey(), "pw") };
  }

  it("reports no entry on an empty map", async () => {
    expect(await hasKeyringEntry(dir)).toBe(false);
    expect(await readKeyring(dir)).toBeNull();
    expect(latestEntry(null)).toBeNull();
  });

  it("writes and reads back an entry", async () => {
    await upsertKeyringEntry(dir, entry("laptop", "2026-01-01T00:00:00Z"));
    expect(await hasKeyringEntry(dir)).toBe(true);
    const keyring = await readKeyring(dir);
    expect(keyring?.entries).toHaveLength(1);
    expect(keyring?.entries[0]?.label).toBe("laptop");
  });

  it("overwrites the entry for the same label rather than piling up", async () => {
    await upsertKeyringEntry(dir, entry("laptop", "2026-01-01T00:00:00Z"));
    await upsertKeyringEntry(dir, entry("laptop", "2026-02-01T00:00:00Z"));
    const keyring = await readKeyring(dir);
    expect(keyring?.entries).toHaveLength(1);
    expect(keyring?.entries[0]?.createdAt).toBe("2026-02-01T00:00:00Z");
  });

  it("latestEntry picks the newest by createdAt", async () => {
    await upsertKeyringEntry(dir, entry("a", "2026-01-01T00:00:00Z"));
    await upsertKeyringEntry(dir, entry("b", "2026-03-01T00:00:00Z"));
    await upsertKeyringEntry(dir, entry("c", "2026-02-01T00:00:00Z"));
    expect(latestEntry(await readKeyring(dir))?.label).toBe("b");
  });

  it("revokes an entry by label and reports the count", async () => {
    await upsertKeyringEntry(dir, entry("laptop", "2026-01-01T00:00:00Z"));
    await upsertKeyringEntry(dir, entry("server", "2026-02-01T00:00:00Z"));
    expect(await listKeyringLabels(dir)).toEqual(["laptop", "server"]);

    expect(await removeKeyringEntry(dir, "laptop")).toBe(1);
    expect(await listKeyringLabels(dir)).toEqual(["server"]);

    // Revoking a label that isn't there is a no-op.
    expect(await removeKeyringEntry(dir, "laptop")).toBe(0);
  });

  it("listKeyringLabels is empty for an untouched map", async () => {
    expect(await listKeyringLabels(dir)).toEqual([]);
  });
});
