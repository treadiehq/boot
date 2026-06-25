import { detectShell, isSupportedShell, SHELLS, type SupportedShell } from "../core/health";
import { logger } from "../ui/logger";

export { detectShell, type SupportedShell };

/**
 * Render the shell snippet that hydrates a placeholder whenever you `cd` into
 * it. Each runs `boot enter "$PWD"` in the background on directory change, so
 * navigating into part of the workspace pulls it down "in the moment".
 */
export function renderShellHook(shell: SupportedShell): string {
  switch (shell) {
    case "zsh":
      return `# boot on-access hydration (zsh) — add to ~/.zshrc:  eval "$(boot shell-hook zsh)"
_boot_autohydrate() {
  command boot enter "$PWD" --quiet >/dev/null 2>&1 &!
}
autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook chpwd _boot_autohydrate
fi
`;
    case "bash":
      return `# boot on-access hydration (bash) — add to ~/.bashrc:  eval "$(boot shell-hook bash)"
_boot_autohydrate() {
  command boot enter "$PWD" --quiet >/dev/null 2>&1 &
}
case ";\${PROMPT_COMMAND};" in
  *";_boot_autohydrate;"*) ;;
  *) PROMPT_COMMAND="_boot_autohydrate;\${PROMPT_COMMAND}" ;;
esac
`;
    case "fish":
      return `# boot on-access hydration (fish) — add to ~/.config/fish/config.fish:  boot shell-hook fish | source
function _boot_autohydrate --on-variable PWD
    command boot enter "$PWD" --quiet >/dev/null 2>&1 &
end
`;
  }
}

/** Print the shell hook snippet for `eval`/`source`. */
export function shellHookCommand(shell?: string): void {
  const resolved = shell && isSupportedShell(shell) ? shell : shell ? null : detectShell();

  if (shell && !isSupportedShell(shell)) {
    throw new Error(`Unsupported shell "${shell}". Supported: ${SHELLS.join(", ")}.`);
  }
  if (!resolved) {
    throw new Error(
      `Could not detect your shell. Run \`boot shell-hook <${SHELLS.join("|")}>\` explicitly.`,
    );
  }

  logger.info(renderShellHook(resolved));
}
