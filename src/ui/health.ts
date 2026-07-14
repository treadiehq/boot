import { hookEvalLine, type SetupHealth } from "../core/health";
import { colors, logger } from "./logger";

const OK = () => colors.green("\u2713");
const NO = () => colors.yellow("\u2717");
const DOT = () => colors.dim("\u2022");

function commandArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function row(mark: string, label: string, detail: string): void {
  logger.info(`  ${mark} ${label.padEnd(12)} ${detail}`);
}

/**
 * Render a {@link SetupHealth} snapshot as a short checklist. Shared by
 * `boot setup` (final summary) and `boot doctor --system`.
 */
export function renderSetupHealth(health: SetupHealth): void {
  logger.heading(`Setup health — ${colors.cyan(health.root)}`);

  if (health.linked) {
    row(OK(), "Linked", `${health.linkKind} \u2192 ${colors.dim(health.remote ?? "")}`);
  } else {
    row(
      NO(),
      "Linked",
      colors.dim(
        `not linked — run: boot link <map-remote> ${commandArg(health.root)}`,
      ),
    );
  }

  if (health.keyPresent) {
    row(OK(), "Secret key", colors.dim(health.keyPath));
  } else {
    row(NO(), "Secret key", colors.dim("missing — create one: boot env init"));
  }

  if (!health.shell) {
    row(
      DOT(),
      "Shell hook",
      colors.dim("shell not detected — choose one: boot shell-hook --help"),
    );
  } else if (health.hookInstalled) {
    row(OK(), "Shell hook", colors.dim(`${health.rcPath} (${health.shell})`));
  } else {
    row(NO(), "Shell hook", colors.dim(`not in ${health.rcPath} — add: ${hookEvalLine(health.shell)}`));
  }

  if (health.daemonRunning) {
    const svc = health.serviceInstalled ? `, service ${health.servicePlatform}` : "";
    row(OK(), "Daemon", `${colors.green("running")}${colors.dim(svc)}`);
  } else if (health.serviceInstalled) {
    row(
      DOT(),
      "Daemon",
      colors.dim(`service file found (${health.servicePlatform}); daemon is not running`),
    );
  } else if (health.servicePlatform) {
    row(
      NO(),
      "Daemon",
      colors.dim(`not installed — run: boot daemon install ${commandArg(health.root)}`),
    );
  } else {
    row(
      DOT(),
      "Daemon",
      colors.dim(
        `no managed service on this OS — run: boot daemon start ${commandArg(health.root)}`,
      ),
    );
  }

  if (health.fuseAvailable) {
    row(
      DOT(),
      "FUSE mount",
      colors.dim(
        `package found; mount support not tested — try: boot mount ${commandArg(health.root)} ${commandArg(
          `${health.root}-live`,
        )}`,
      ),
    );
  } else {
    row(
      DOT(),
      "FUSE mount",
      colors.dim("optional, not installed; the shell hook and watch still clone placeholders"),
    );
  }
}
