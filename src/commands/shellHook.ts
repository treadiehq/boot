import { detectShell, isSupportedShell, SHELLS, type SupportedShell } from "../core/health";
import { logger } from "../ui/logger";

export { detectShell, type SupportedShell };

/**
 * Render the shell snippet that hydrates a placeholder whenever you `cd` into
 * it. Each runs `boot enter "$PWD"` in the background on directory change, so
 * navigating into part of the workspace pulls it down "in the moment". It also
 * defines `bcd`, a quick-jump that `cd`s to (and hydrates) any repo in the map.
 */
export function renderShellHook(shell: SupportedShell): string {
  return `${renderAutohydrateHook(shell)}\n${renderJumpFunction(shell)}`;
}

function renderAutohydrateHook(shell: SupportedShell): string {
  switch (shell) {
    case "zsh":
      return `# boot: clone repository placeholders on access (zsh) — add to ~/.zshrc:  eval "$(boot shell-hook zsh)"
_boot_autohydrate() {
  command boot enter "$PWD" --quiet >/dev/null 2>&1 &!
}
autoload -Uz add-zsh-hook 2>/dev/null
if (( $+functions[add-zsh-hook] )); then
  add-zsh-hook chpwd _boot_autohydrate
fi
`;
    case "bash":
      return `# boot: clone repository placeholders on access (bash) — add to ~/.bashrc:  eval "$(boot shell-hook bash)"
_boot_autohydrate() {
  command boot enter "$PWD" --quiet >/dev/null 2>&1 &
}
case ";\${PROMPT_COMMAND};" in
  *";_boot_autohydrate;"*) ;;
  *) PROMPT_COMMAND="_boot_autohydrate;\${PROMPT_COMMAND}" ;;
esac
`;
    case "fish":
      return `# boot: clone repository placeholders on access (fish) — add to ~/.config/fish/config.fish:  boot shell-hook fish | source
function _boot_autohydrate --on-variable PWD
    command boot enter "$PWD" --quiet >/dev/null 2>&1 &
end
`;
    case "powershell":
      return `# boot: clone repository placeholders on access (PowerShell) — add to $PROFILE:  Invoke-Expression (& boot shell-hook powershell | Out-String)
if (-not $global:__BootPromptHooked) {
  $global:__BootPromptHooked = $true
  $global:__BootLastPwd = $null
  $global:__BootOriginalPrompt = $function:prompt
  function global:prompt {
    if ($global:__BootLastPwd -ne $PWD.Path) {
      $global:__BootLastPwd = $PWD.Path
      Start-Process -FilePath 'boot' -ArgumentList @('enter', $PWD.Path, '--quiet') -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null
    }
    if ($global:__BootOriginalPrompt) { & $global:__BootOriginalPrompt } else { "PS $($PWD.Path)> " }
  }
}
`;
  }
}

/**
 * Quick-jump: `bcd <name>` resolves a repo from your map, hydrates it if it's
 * still a placeholder, and `cd`s you into it. `boot cd` prints the path; the
 * function is what actually changes the directory (a child process can't).
 */
function renderJumpFunction(shell: SupportedShell): string {
  switch (shell) {
    case "zsh":
    case "bash":
      return `# boot quick-jump: \`bcd <name>\` opens a repository and clones its placeholder
bcd() {
  local _dir
  _dir="$(command boot cd --print "$@")" || return
  [ -n "$_dir" ] && cd "$_dir"
}
`;
    case "fish":
      return `# boot quick-jump: \`bcd <name>\` opens a repository and clones its placeholder
function bcd --description 'boot quick-jump to a repository'
    set -l _dir (command boot cd --print $argv); or return
    test -n "$_dir"; and cd $_dir
end
`;
    case "powershell":
      return `# boot quick-jump: \`bcd <name>\` opens a repository and clones its placeholder
function bcd {
  $dir = & boot cd --print @args
  if ($LASTEXITCODE -eq 0 -and $dir) { Set-Location $dir }
}
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
    throw new Error("Could not detect your shell. Choose one with: boot shell-hook --help");
  }

  logger.info(renderShellHook(resolved));
}
