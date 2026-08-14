# Boot launch video

A 45-second, 1920×1080 Remotion composition designed for the Boot homepage,
launch posts, and product demos.

## Narrative

1. Promise: your workspace on every machine.
2. Setup: one `boot setup` command captures the workspace map.
3. Map: the layout appears on another machine without cloning every repo.
4. Hydrate: touching a placeholder turns it into a real clone.
5. Agent: `boot agent` prepares a fresh cloud workspace.
6. Benefits: on-demand repos, encryption, background sync, broad platform support.
7. CTA: Boot's official mark and `useboot.co`.

The terminal copy mirrors Boot's current product behavior. The official logo is
from `useboot.co`; the soundtrack is generated locally and does not depend on
licensed third-party media.

## Preview

```bash
pnpm video:studio
```

## Render

```bash
pnpm video:render
```

The MP4 is written to `out/boot-launch.mp4`.

## v0.3.7 agent-bootstrap release video

`AgentBootstrapUpdate` is a 12-second release composition focused on the public
one-line adapter, exact map SHA pinning, ephemeral no-push behavior, and
runtime-validated secret-free JSON.

```bash
pnpm video:still:v037
pnpm video:render:v037
```

These commands write `out/boot-v0.3.7-preview.png` and
`out/boot-v0.3.7.mp4`.
