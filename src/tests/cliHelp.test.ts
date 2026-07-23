import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { buildProgram } from "../cli";

function leafCommands(command: Command): Command[] {
  if (command.commands.length === 0) return [command];
  return command.commands.flatMap((child) => leafCommands(child));
}

function allCommands(command: Command): Command[] {
  return [command, ...command.commands.flatMap((child) => allCommands(child))];
}

function commandPath(command: Command): string {
  const names: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    names.unshift(current.name());
  }
  return names.join(" ");
}

function findCommand(program: Command, path: string): Command {
  let command = program;
  for (const name of path.split(" ")) {
    const child = command.commands.find((candidate) => candidate.name() === name);
    if (!child) throw new Error(`Missing command: ${path}`);
    command = child;
  }
  return command;
}

function renderHelp(command: Command): string {
  const output: string[] = [];
  command.configureOutput({ writeOut: (text) => output.push(text) });
  command.outputHelp();
  return output.join("");
}

describe("CLI help", () => {
  it("explains boot and separates primary from compatibility commands", () => {
    const program = buildProgram();
    const help = renderHelp(program);

    expect(program.description()).toBe(
      "Set up a project workspace with the repositories, tools, and settings a developer or coding agent needs.",
    );
    expect(help).toContain("Primary workspace commands:");
    expect(help).toContain("Compatibility sync commands:");
    expect(help.indexOf("agent <remote>")).toBeLessThan(
      help.indexOf("Other commands:"),
    );
  });

  it("includes a command-specific example for every executable leaf command", () => {
    const leaves = leafCommands(buildProgram());

    expect(leaves).toHaveLength(39);
    for (const command of leaves) {
      const help = renderHelp(command);
      expect(help, commandPath(command)).toContain("Examples:");
      expect(help, commandPath(command)).toContain(`  boot ${commandPath(command)}`);
    }
  });

  it("hides false defaults without changing parsed option defaults", () => {
    const program = buildProgram();

    for (const command of leafCommands(program)) {
      expect(renderHelp(command), commandPath(command)).not.toContain("(default: false)");
      for (const option of command.options.filter((candidate) => candidate.defaultValue === false)) {
        expect(command.getOptionValue(option.attributeName()), option.flags).toBe(false);
      }
    }
  });

  it("shows command help after a parse error", async () => {
    const errors: string[] = [];
    const program = buildProgram();
    for (const command of allCommands(program)) {
      command
        .exitOverride()
        .configureOutput({ writeErr: (text) => errors.push(text) });
    }

    await expect(
      program.parseAsync(["node", "boot", "up", "--unknown-option"]),
    ).rejects.toMatchObject({ code: "commander.unknownOption" });

    const output = errors.join("");
    expect(output).toContain("unknown option '--unknown-option'");
    expect(output).toContain("Usage: boot up [options] [workspacePath]");
    expect(output).toContain("Examples:");
  });

  it.each(["abc", "", " ", "60s", "60.5", "0", "-30"])(
    "rejects invalid daemon interval %j before running a command",
    async (interval) => {
      const errors: string[] = [];
      const program = buildProgram();
      for (const command of allCommands(program)) {
        command
          .exitOverride()
          .configureOutput({ writeErr: (text) => errors.push(text) });
      }

      await expect(
        program.parseAsync(["node", "boot", "daemon", "install", "--interval", interval]),
      ).rejects.toMatchObject({ code: "commander.invalidArgument" });

      expect(errors.join("")).toContain(
        "Daemon interval must be a positive whole number of seconds.",
      );
    },
  );

  it("uses strict interval parsing for every daemon installation path", async () => {
    for (const args of [
      ["setup", "--interval", "invalid"],
      ["daemon", "start", "--interval", "invalid"],
      ["daemon", "install", "--interval", "invalid"],
    ]) {
      const program = buildProgram();
      for (const command of allCommands(program)) {
        command.exitOverride().configureOutput({ writeErr: () => undefined });
      }

      await expect(
        program.parseAsync(["node", "boot", ...args]),
      ).rejects.toMatchObject({ code: "commander.invalidArgument" });
    }
  });

  it("states JSON-only stdout and foreground behavior", () => {
    const program = buildProgram();

    for (const path of ["up", "inspect", "agent", "cd"]) {
      const json = findCommand(program, path).options.find((option) => option.long === "--json");
      expect(json?.description, path).toMatch(/JSON.*only.*stdout/);
    }

    for (const path of ["watch", "mount", "daemon start"]) {
      expect(findCommand(program, path).description(), path).toContain("foreground");
    }
  });
});
