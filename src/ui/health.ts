import { hookEvalLine, type SetupHealth } from "../core/health";
import { colors, logger } from "./logger";

const OK = () => colors.green("\u2713");
const NO = () => colors.yellow("\u2717");
const DOT = () => colors.dim("\u2022");

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
    row(NO(), "Linked", colors.dim("not linked — run `boot setup <remote>`"));
  }

  if (health.keyPresent) {
    row(OK(), "Secret key", colors.dim(health.keyPath));
  } else {
    row(NO(), "Secret key", colors.dim("missing — `boot env init` (or import an existing key)"));
  }

  if (!health.shell) {
    row(DOT(), "Shell hook", colors.dim("shell not detected — `boot shell-hook <zsh|bash|fish|powershell>`"));
  } else if (health.hookInstalled) {
    row(OK(), "Shell hook", colors.dim(`${health.rcPath} (${health.shell})`));
  } else {
    row(NO(), "Shell hook", colors.dim(`not in ${health.rcPath} — add: ${hookEvalLine(health.shell)}`));
  }

  if (health.daemonRunning) {
    const svc = health.serviceInstalled ? `, service ${health.servicePlatform}` : "";
    row(OK(), "Daemon", `${colors.green("running")}${colors.dim(svc)}`);
  } else if (health.serviceInstalled) {
    row(DOT(), "Daemon", colors.dim(`service installed (${health.servicePlatform}), not active yet`));
  } else if (health.servicePlatform) {
    row(NO(), "Daemon", colors.dim("not installed — `boot daemon install`"));
  } else {
    row(DOT(), "Daemon", colors.dim("no managed service on this OS — `boot daemon start`"));
  }

  if (health.fuseAvailable) {
    row(OK(), "FUSE mount", colors.dim("available — `boot mount <ws> <mnt>`"));
  } else {
    row(DOT(), "FUSE mount", colors.dim("optional, not installed (shell hook + watch still work)"));
  }
}
