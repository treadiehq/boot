import fs from "node:fs/promises";
import path from "node:path";
import { ensureGitAvailable } from "../core/git";
import { loadMachineIdentity } from "../core/identity";
import { isLinked, mapPaths } from "../core/map";
import { loadTransport } from "../core/transport";
import {
  listScopes,
  materializeAll,
  parseDotenv,
  readEnvScope,
  removeEnvScope,
  scopeLabel,
  writeEnvScope,
  type EnvScope,
} from "../core/env";
import {
  exportKeyBase64,
  importKeyBase64,
  installKey,
  keyExists,
  loadKey,
  loadOrCreateKey,
  secretKeyPath,
  unwrapKey,
  wrapKey,
} from "../core/secrets";
import {
  latestEntry,
  listKeyringLabels,
  readKeyring,
  removeKeyringEntry,
  upsertKeyringEntry,
} from "../core/keyring";
import { copyToClipboard } from "../core/clipboard";
import { colors, logger } from "../ui/logger";
import { password } from "../ui/prompt";

export interface EnvCommonOptions {
  cwd?: string;
  repo?: string;
}

function resolveRoot(opts: EnvCommonOptions): string {
  return path.resolve(opts.cwd ?? ".");
}

function requireLinked(root: string): void {
  if (!isLinked(root)) {
    throw new Error(`${root} is not linked. Run \`boot link <remote>\` first.`);
  }
}

function scopeFromOptions(opts: EnvCommonOptions): EnvScope {
  if (!opts.repo) return { type: "global" };
  const rel = opts.repo
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  return { type: "repo", relativePath: rel };
}

function maskValue(value: string): string {
  if (value.length === 0) return colors.dim("(empty)");
  return colors.dim(`•••• (${value.length} chars)`);
}

async function commit(root: string, scope: EnvScope, verb: string): Promise<void> {
  const identity = await loadMachineIdentity();
  const transport = await loadTransport(root);
  await transport.push(`env: ${verb} ${scopeLabel(scope)} from ${identity.hostname}`);
}

/** `boot env init` — create the machine-local secret key if missing. */
export async function envInit(opts: EnvCommonOptions = {}): Promise<void> {
  void opts;
  const { created } = await loadOrCreateKey();
  if (created) {
    logger.success(`created secret key at ${colors.cyan(secretKeyPath())}`);
    logger.info();
    logger.info("This key encrypts your env vars in the synced map. To use the same");
    logger.info("secrets on another machine, copy it there:");
    logger.info(colors.dim("  boot env key export        # on this machine"));
    logger.info(colors.dim("  boot env key import <key>  # on the other machine"));
  } else {
    logger.info(`${colors.dim("\u2022")} secret key already exists at ${secretKeyPath()}`);
  }
}

/** `boot env set KEY=VALUE...` */
export async function envSet(assignments: string[], opts: EnvCommonOptions = {}): Promise<void> {
  if (assignments.length === 0) throw new Error("Nothing to set. Pass one or more KEY=VALUE pairs.");
  await ensureGitAvailable();
  const root = resolveRoot(opts);
  requireLinked(root);
  const scope = scopeFromOptions(opts);

  const { key } = await loadOrCreateKey();
  const transport = await loadTransport(root);
  await transport.pull();

  const vars = (await readEnvScope(mapPaths(root).mapDir, scope, key)) ?? {};
  for (const assignment of assignments) {
    const eq = assignment.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid assignment "${assignment}". Use KEY=VALUE.`);
    vars[assignment.slice(0, eq).trim()] = assignment.slice(eq + 1);
  }

  await writeEnvScope(mapPaths(root).mapDir, scope, vars, key);
  await commit(root, scope, "set");
  logger.success(`set ${assignments.length} var(s) in ${colors.cyan(scopeLabel(scope))}`);
  logger.next("Write them to .env files:  boot env materialize");
}

/** `boot env import <file>` — merge a dotenv file into a scope. */
export async function envImport(file: string, opts: EnvCommonOptions = {}): Promise<void> {
  await ensureGitAvailable();
  const root = resolveRoot(opts);
  requireLinked(root);
  const scope = scopeFromOptions(opts);

  const body = await fs.readFile(path.resolve(file), "utf8");
  const incoming = parseDotenv(body);
  const count = Object.keys(incoming).length;
  if (count === 0) throw new Error(`No variables found in ${file}.`);

  const { key } = await loadOrCreateKey();
  const transport = await loadTransport(root);
  await transport.pull();

  const vars = (await readEnvScope(mapPaths(root).mapDir, scope, key)) ?? {};
  Object.assign(vars, incoming);
  await writeEnvScope(mapPaths(root).mapDir, scope, vars, key);
  await commit(root, scope, "import");
  logger.success(`imported ${count} var(s) into ${colors.cyan(scopeLabel(scope))}`);
}

/** `boot env rm KEY...` (or `--all` to remove the whole scope). */
export async function envRm(
  keys: string[],
  opts: EnvCommonOptions & { all?: boolean } = {},
): Promise<void> {
  await ensureGitAvailable();
  const root = resolveRoot(opts);
  requireLinked(root);
  const scope = scopeFromOptions(opts);
  const key = await loadKey();

  const transport = await loadTransport(root);
  await transport.pull();

  if (opts.all) {
    const removed = await removeEnvScope(mapPaths(root).mapDir, scope);
    if (!removed) {
      logger.info(`${colors.dim("\u2022")} no env stored for ${scopeLabel(scope)}`);
      return;
    }
    await commit(root, scope, "remove");
    logger.success(`removed all env for ${colors.cyan(scopeLabel(scope))}`);
    return;
  }

  if (keys.length === 0) throw new Error("Pass key names to remove, or --all to clear the scope.");
  const vars = (await readEnvScope(mapPaths(root).mapDir, scope, key)) ?? {};
  let removed = 0;
  for (const k of keys) {
    if (k in vars) {
      delete vars[k];
      removed += 1;
    }
  }
  await writeEnvScope(mapPaths(root).mapDir, scope, vars, key);
  await commit(root, scope, "remove");
  logger.success(`removed ${removed} var(s) from ${colors.cyan(scopeLabel(scope))}`);
}

/** `boot env list` — show scopes and their keys (values masked). */
export async function envList(opts: EnvCommonOptions = {}): Promise<void> {
  const root = resolveRoot(opts);
  requireLinked(root);

  if (!keyExists()) {
    logger.warn(`no secret key on this machine (${secretKeyPath()}).`);
    logger.info("Copy it over with `boot env key import <key>` to read these secrets.");
    return;
  }
  const key = await loadKey();
  const mapDir = mapPaths(root).mapDir;
  const scopes = await listScopes(mapDir);

  if (scopes.length === 0) {
    logger.info(`${colors.dim("\u2022")} no env vars stored yet. Add some with \`boot env set\`.`);
    return;
  }

  logger.heading(`Env vars in ${colors.cyan(path.relative(process.cwd(), root) || ".")}`);
  for (const scope of scopes) {
    const vars = (await readEnvScope(mapDir, scope, key)) ?? {};
    logger.info();
    logger.info(colors.bold(scopeLabel(scope)));
    for (const k of Object.keys(vars).sort()) {
      logger.info(`  ${k} = ${maskValue(vars[k])}`);
    }
  }
}

/** `boot env materialize` — write decrypted `.env` files into the workspace. */
export async function envMaterialize(opts: EnvCommonOptions = {}): Promise<void> {
  await ensureGitAvailable();
  const root = resolveRoot(opts);
  requireLinked(root);
  const key = await loadKey();
  const mapDir = mapPaths(root).mapDir;

  const transport = await loadTransport(root);
  await transport.pull();

  const written = await materializeAll(root, mapDir, key);
  if (written.length === 0) {
    logger.info(`${colors.dim("\u2022")} no env vars to materialize.`);
    return;
  }
  logger.heading(`Materialized ${written.length} .env file(s)`);
  for (const result of written) {
    logger.success(
      `${colors.cyan(path.relative(root, result.target))} ${colors.dim(`(${result.count} vars)`)}`,
    );
  }
}

export interface EnvKeyExportOptions {
  /** Print the raw key to stdout (history/scrollback risk; opt-in). */
  stdout?: boolean;
  /** Write the key to this file (mode 0600) instead of the clipboard. */
  file?: string;
}

/**
 * `boot env key export` — get the secret key off this machine *safely*.
 * Defaults to the clipboard (or a 0600 file) and prints only a masked
 * confirmation, so the raw key never lands in shell history by accident.
 * Prefer `boot env key share` — it avoids moving the raw key entirely.
 */
export async function envKeyExport(opts: EnvKeyExportOptions = {}): Promise<void> {
  const b64 = await exportKeyBase64();

  if (opts.stdout) {
    logger.info(b64);
    return;
  }
  if (opts.file) {
    const dest = path.resolve(opts.file);
    await fs.writeFile(dest, `${b64}\n`, { mode: 0o600 });
    logger.success(`wrote the key to ${colors.cyan(dest)} (0600)`);
    logger.next(`On the other machine:  boot env key import --file ${dest}`);
    return;
  }
  if (await copyToClipboard(b64)) {
    logger.success("copied the secret key to your clipboard");
    logger.next("On the other machine:  boot env key import  (then paste)");
    logger.info(colors.dim("Tip: `boot env key share` avoids moving the raw key at all."));
    return;
  }
  // No clipboard tool — be explicit rather than silently dumping the key.
  logger.warn("no clipboard tool found (pbcopy/wl-copy/xclip/xsel).");
  logger.info(colors.dim("Re-run with --file <path> to write it, or --stdout to print it."));
}

export interface EnvKeyImportOptions {
  force?: boolean;
  /** Read the key from this file instead of an argument. */
  file?: string;
  /** Read the key from stdin instead of an argument. */
  stdin?: boolean;
}

/** `boot env key import [base64]` — install a secret key from another machine. */
export async function envKeyImport(base64 = "", opts: EnvKeyImportOptions = {}): Promise<void> {
  let value = base64.trim();
  if (opts.file) {
    value = (await fs.readFile(path.resolve(opts.file), "utf8")).trim();
  } else if (opts.stdin || (!value && !process.stdin.isTTY)) {
    value = (await readStdin()).trim();
  } else if (!value) {
    value = (await password("Paste the secret key:")).trim();
  }
  if (!value) throw new Error("No key provided. Pass it as an argument, --file, or via stdin.");

  await importKeyBase64(value, opts.force);
  logger.success(`installed secret key at ${colors.cyan(secretKeyPath())}`);
  logger.next("Write your synced secrets to disk:  boot env materialize");
}

/**
 * `boot env key share` — escrow this machine's key in the synced map, encrypted
 * under a passphrase. The other machine runs `boot env key receive` with the
 * same passphrase. You transfer a short passphrase out-of-band, not the key.
 */
export async function envKeyShare(opts: EnvCommonOptions & { passphrase?: string } = {}): Promise<void> {
  await ensureGitAvailable();
  const root = resolveRoot(opts);
  requireLinked(root);

  const key = await loadKey();
  const identity = await loadMachineIdentity();

  const passphrase = opts.passphrase ?? (await promptNewPassphrase());
  const wrapped = wrapKey(key, passphrase);

  const transport = await loadTransport(root);
  await transport.pull();
  await upsertKeyringEntry(mapPaths(root).mapDir, {
    label: identity.hostname,
    createdAt: new Date().toISOString(),
    wrapped,
  });
  await transport.push(`env: share wrapped key from ${identity.hostname}`);

  logger.success("escrowed the key in the map (passphrase-protected)");
  logger.next("On the other machine:  boot env key receive");
}

/**
 * `boot env key receive` — pull the escrowed key from the map and unwrap it with
 * the passphrase, installing it locally.
 */
export async function envKeyReceive(
  opts: EnvCommonOptions & { passphrase?: string; force?: boolean } = {},
): Promise<void> {
  await ensureGitAvailable();
  const root = resolveRoot(opts);
  requireLinked(root);

  const transport = await loadTransport(root);
  await transport.pull();

  const entry = latestEntry(await readKeyring(mapPaths(root).mapDir));
  if (!entry) {
    throw new Error(
      "No escrowed key in the map. Run `boot env key share` on a machine that has the key.",
    );
  }

  const passphrase = opts.passphrase ?? (await password("Passphrase:"));
  if (!passphrase) throw new Error("A passphrase is required.");

  const key = unwrapKey(entry.wrapped, passphrase);
  await installKey(key, opts.force);
  logger.success(`installed secret key at ${colors.cyan(secretKeyPath())}`);
  logger.info(colors.dim(`(shared by ${entry.label})`));
  logger.next("Write your synced secrets to disk:  boot env materialize");
}

/**
 * `boot env key revoke <label>` — prune a stale escrowed-key entry from the
 * keyring in the map (e.g. a machine you no longer use). Note: this only stops
 * *future* unlocks with that entry; machines that already received the key keep
 * it. Rotate the key itself if it may be compromised.
 */
export async function envKeyRevoke(label: string, opts: EnvCommonOptions = {}): Promise<void> {
  await ensureGitAvailable();
  const root = resolveRoot(opts);
  requireLinked(root);

  const transport = await loadTransport(root);
  await transport.pull();

  const mapDir = mapPaths(root).mapDir;
  const removed = await removeKeyringEntry(mapDir, label);
  if (removed === 0) {
    const labels = await listKeyringLabels(mapDir);
    logger.warn(`no keyring entry labelled "${label}".`);
    if (labels.length > 0) logger.info(colors.dim(`   escrowed: ${labels.join(", ")}`));
    else logger.info(colors.dim("   the keyring is empty."));
    return;
  }

  await transport.push(`env: revoke wrapped key "${label}"`);
  logger.success(`revoked ${removed} keyring entr${removed === 1 ? "y" : "ies"} for "${label}"`);
}

/** Prompt for a new passphrase twice and confirm they match. */
async function promptNewPassphrase(): Promise<string> {
  const first = await password("Choose a passphrase:");
  if (!first) throw new Error("A passphrase is required.");
  const second = await password("Confirm passphrase:");
  if (first !== second) throw new Error("Passphrases did not match.");
  return first;
}

/** Read all of stdin to a string (for piped key import). */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.once("end", () => resolve(buf));
    process.stdin.once("error", reject);
    process.stdin.resume();
  });
}
