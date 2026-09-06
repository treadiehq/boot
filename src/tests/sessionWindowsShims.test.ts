import { describe, expect, it } from "vitest";
import { nodeShimTarget } from "../core/sessionWindows";

describe("Windows Node launcher recognition", () => {
  it("extracts npm and pnpm entrypoints without interpreting shell syntax", () => {
    expect(nodeShimTarget('SET "_prog=node"\r\n"%_prog%" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*')).toBe('node_modules\\@openai\\codex\\bin\\codex.js');
    expect(nodeShimTarget('node "%~dp0\\..\\tool\\entry.cjs" %*')).toBe('..\\tool\\entry.cjs');
    expect(nodeShimTarget('echo custom wrapper\r\ncmd /c %*')).toBeNull();
    expect(nodeShimTarget('node "%~dp0\\one.js" %*\r\nnode "%~dp0\\two.js" %*')).toBeNull();
  });
});
