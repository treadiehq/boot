import { describe, expect, it } from "vitest";
import { confirm, input, isInteractive, select } from "../ui/prompt";

// Vitest runs without a TTY, so every prompt should resolve to its default
// without blocking — that's the property scripts/CI rely on.
describe("prompt (non-interactive fallback)", () => {
  it("reports non-interactive when stdin isn't a TTY", () => {
    expect(isInteractive()).toBe(false);
  });

  it("confirm returns the default", async () => {
    expect(await confirm("ok?")).toBe(true);
    expect(await confirm("ok?", { default: false })).toBe(false);
  });

  it("confirm with assumeYes is always true", async () => {
    expect(await confirm("ok?", { default: false, assumeYes: true })).toBe(true);
  });

  it("select returns the default choice", async () => {
    const choices = [
      { label: "a", value: "a" },
      { label: "b", value: "b" },
      { label: "c", value: "c" },
    ];
    expect(await select("pick", choices)).toBe("a");
    expect(await select("pick", choices, { default: 2 })).toBe("c");
  });

  it("input returns the default text", async () => {
    expect(await input("name?", { default: "boot" })).toBe("boot");
    expect(await input("name?")).toBe("");
  });
});
