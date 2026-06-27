import { describe, expect, it, vi } from "vitest";
import { buildProgram } from "../cli";

const EXPECTED = buildProgram().version() as string;

describe("version", () => {
  it("exposes a non-empty version", () => {
    expect(EXPECTED).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prints the version via the `version` subcommand", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    try {
      await buildProgram().parseAsync(["node", "boot", "version"]);
    } finally {
      spy.mockRestore();
    }
    expect(logs.join("\n")).toContain(EXPECTED);
  });

  it("prints the version via -v and --version flags", async () => {
    for (const flag of ["-v", "--version"]) {
      const program = buildProgram().exitOverride();
      const writes: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: string | Uint8Array) => {
          writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
          return true;
        });
      try {
        await program.parseAsync(["node", "boot", flag]);
      } catch (err) {
        // commander throws (instead of exiting) once exitOverride is set.
        expect((err as { code?: string }).code).toBe("commander.version");
      } finally {
        spy.mockRestore();
      }
      expect(writes.join("")).toContain(EXPECTED);
    }
  });
});
