import { Template, defaultBuildLogger } from "e2b";
import { template } from "./template";

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required. Set it to an E2B project API key before building.`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  requiredEnvironment("E2B_API_KEY");
  const name = process.env.E2B_TEMPLATE_NAME?.trim() || "boot-agent";

  const build = await Template.build(template, name, {
    cpuCount: 2,
    memoryMB: 2048,
    onBuildLogs: defaultBuildLogger(),
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        name: build.name,
        templateId: build.templateId,
        buildId: build.buildId,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`E2B template build failed: ${message}\n`);
  process.exitCode = 1;
});
