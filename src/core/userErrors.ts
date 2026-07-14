const ANSI_ESCAPE =
  /\u001B(?:\][^\u0007]*(?:\u0007|\u001B\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
const URL_USER_INFO = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/g;
const URL_SECRET_PARAMETER =
  /([?&](?:access_token|api_key|auth|client_secret|key|password|secret|token)=)[^&#\s]*/gi;
const AUTHORIZATION_VALUE =
  /\b((?:authorization|proxy-authorization)\s*:\s*(?:basic|bearer)\s+)\S+/gi;
const SECRET_ASSIGNMENT =
  /\b((?:access[_-]?token|api[_-]?key|client[_-]?secret|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const KNOWN_ACCESS_TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})\b/g;

function redactCredentials(value: string): string {
  return value
    .replace(URL_USER_INFO, "$1")
    .replace(URL_SECRET_PARAMETER, "$1[redacted]")
    .replace(AUTHORIZATION_VALUE, "$1[redacted]")
    .replace(SECRET_ASSIGNMENT, "$1[redacted]")
    .replace(KNOWN_ACCESS_TOKEN, "[redacted]");
}

/** Remove terminal controls, line breaks, and credentials from text shown to users. */
export function sanitizeUserText(value: unknown, maxLength = 240): string {
  const limit = Math.max(0, Math.floor(maxLength));
  const text = redactCredentials(String(value ?? ""))
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARACTERS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  if (limit === 0) return "";
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/** Keep a remote useful for troubleshooting without exposing URL credentials. */
export function sanitizeRemoteUrl(value: string): string {
  return sanitizeUserText(value, 500);
}

/** Quote a short value for display after removing controls and credentials. */
export function quoteUserValue(value: unknown, maxLength = 160): string {
  return JSON.stringify(sanitizeUserText(value, maxLength));
}

/** Quote a user-controlled value as one POSIX shell argument. */
export function shellQuoteUserValue(value: unknown, maxLength = 500): string {
  const text = sanitizeUserText(value, maxLength);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

/** Extract one short, sanitized reason from command output. */
export function subprocessFailureReason(value: unknown): string {
  const text = redactCredentials(String(value ?? ""))
    .replace(ANSI_ESCAPE, "")
    .replace(CONTROL_CHARACTERS, "");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const reason =
    lines.find((line) =>
      /\b(?:authentication|denied|error|failed|fatal|forbidden|not found|permission|rejected|unable)\b/i.test(
        line,
      ),
    ) ??
    lines.at(-1) ??
    "";
  return sanitizeUserText(reason.replace(/^(?:error|fatal|remote):\s*/i, ""));
}

export function isFileNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Turn a filesystem read failure into a short message with a next step. */
export function fileReadError(label: string, filePath: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException)?.code;
  const safeLabel = sanitizeUserText(label, 80) || "file";
  const safePath = quoteUserValue(filePath, 500);
  if (code === "EACCES" || code === "EPERM") {
    return new Error(
      `Could not read ${safeLabel} at ${safePath}: permission denied. Grant read access, then retry.`,
    );
  }
  if (code === "EISDIR") {
    return new Error(
      `Could not read ${safeLabel} at ${safePath}: the path is a directory. Replace it with a file, then retry.`,
    );
  }
  const reason = code ? ` (${code})` : "";
  return new Error(
    `Could not read ${safeLabel} at ${safePath}${reason}. Check the file and its permissions, then retry.`,
  );
}
