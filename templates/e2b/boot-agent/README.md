# Boot agent E2B template

This is an E2B code-defined template using the root package's `e2b` SDK
dependency. It installs:

- Git, curl, jq, OpenSSH client, and ripgrep;
- the Boot release matching the root `package.json` version;
- one canonical `boot-workspace` skill, exposed through user-level symlinks at
  `~/.agents/skills/boot-workspace` for Codex and
  `~/.claude/skills/boot-workspace` for Claude Code.

Agent CLIs are intentionally not bundled. Install or provide the chosen agent
separately; both supported discovery paths are ready in the sandbox.

The template has no E2B start command. `launch.ts` creates the sandbox, stages
optional credential files, invokes `https://useboot.co/agent.sh`, and then
waits for its bootstrap JSON and `boot inspect --json` to report a ready
workspace. This keeps realization a synchronous runtime operation using
`BOOT_MAP`, not an image-build or sandbox startup side effect.

## Local validation (no E2B account required)

From the repository root:

```bash
pnpm e2b:validate
pnpm test:run src/tests/e2bTemplate.test.ts
```

These commands validate TypeScript against the installed SDK, the portable
skill frontmatter and one-source symlink, required packages, and launch
ordering. They do not create a sandbox or contact E2B.

## Build a private template

Requires Node.js supported by the installed E2B SDK and an E2B project API key:

```bash
E2B_API_KEY=e2b_... \
E2B_TEMPLATE_NAME=boot-agent \
pnpm e2b:build
```

`Template.build` creates or updates a project-scoped, private template. The SDK
reads `E2B_API_KEY` on the host; the template does not copy it into the image.

## Launch and realize a workspace

For a public map:

```bash
E2B_API_KEY=e2b_... \
BOOT_MAP=git@github.com:acme/workspace-map.git \
pnpm e2b:launch
```

Optional variables:

- `E2B_TEMPLATE` (default `boot-agent`), including a namespaced public template
  name when appropriate;
- `E2B_TIMEOUT_MS` (default 900000);
- `BOOT_WORKSPACE` (default `/home/user/workspace`);
- `BOOT_PROFILE` (default `agent`);
- `BOOT_MAP_COMMIT` to pin a full 40- or 64-character map commit;
- `BOOT_NO_ENV=1` to validate encrypted environment requirements without
  materializing `.env` files;
- `BOOT_SSH_PRIVATE_KEY_FILE` plus the required
  `BOOT_SSH_KNOWN_HOSTS_FILE` for private Git over SSH;
- `BOOT_SECRET_KEY_FILE` for an exported Boot `secret.key` when the selected
  profile needs Boot-managed encrypted values.

The credential variables contain local file paths, not credential values.
`launch.ts` uploads file contents with the E2B filesystem API, applies mode
`0600`, and never prints them. Use a dedicated, least-privilege deploy key and a
reviewed `known_hosts` file. Never embed a token or password in `BOOT_MAP`; the
launcher rejects credential-bearing URLs. E2B command environment variables
are scoped but are not OS-private, so `BOOT_MAP` should be a credential-free
reference.

The successful launcher output contains the sandbox ID and Boot's secret-free
JSON contracts. The sandbox remains alive for agent use. Uploaded credentials
remain on its ephemeral filesystem until it is killed, so terminate the
sandbox promptly after the task. A failed launch kills the sandbox
automatically.

## Remote smoke check

After building:

```bash
E2B_API_KEY=e2b_... \
E2B_TEMPLATE=boot-agent \
pnpm e2b:smoke
```

This creates a temporary sandbox, checks every installed executable and both
skill discovery paths, then permanently kills the sandbox. It does not need a
workspace map.

## Publishing (explicit and optional)

Building is private by default. Publishing makes the template usable by other
E2B projects and should be a deliberate separate action. The current official
CLI command is:

```bash
E2B_API_KEY=e2b_... \
pnpm dlx @e2b/cli@2.16.1 template publish --yes boot-agent
```

The only E2B credential required is an `E2B_API_KEY` authorized for the project
that owns `boot-agent`. Do not store it in this repository, template
environment, command output, or a committed `.env` file. After publication,
other projects reference the template as
`<project-slug>/boot-agent`. To reverse publication, run the same pinned CLI
with `template unpublish --yes boot-agent`.
