import { describe, expect, it } from "vitest";
import {
  sanitizeRemoteUrl,
  sanitizeUserText,
  shellQuoteUserValue,
  subprocessFailureReason,
} from "../core/userErrors";

describe("user-facing error helpers", () => {
  it("removes terminal controls and collapses multiline output", () => {
    expect(sanitizeUserText("\u001b[31mfatal:\u001b[0m\npermission denied\u0007")).toBe(
      "fatal: permission denied",
    );
  });

  it("redacts credentials from URLs, parameters, and authorization headers", () => {
    const text = sanitizeUserText(
      "https://user:password@example.com/repo.git?access_token=secret Authorization: Bearer abc123",
    );

    expect(text).toBe(
      "https://example.com/repo.git?access_token=[redacted] Authorization: Bearer [redacted]",
    );
    expect(sanitizeRemoteUrl("https://token@example.com/repo.git")).toBe(
      "https://example.com/repo.git",
    );
  });

  it("quotes paths with spaces as one shell argument", () => {
    expect(shellQuoteUserValue("/tmp/project files/boot.yaml")).toBe(
      "'/tmp/project files/boot.yaml'",
    );
  });

  it("keeps one useful, sanitized subprocess failure reason", () => {
    const reason = subprocessFailureReason(
      "remote: counting objects\n\u001b[31mfatal: authentication failed for https://token@example.com/repo.git\u001b[0m\nmore details",
    );

    expect(reason).toBe("authentication failed for https://example.com/repo.git");
    expect(reason).not.toContain("\n");
    expect(reason).not.toContain("token@");
  });
});
