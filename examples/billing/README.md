# Billing task in a fresh agent environment

Start with an empty agent environment. This billing task needs the web app,
billing service, shared SDK, PostgreSQL, Node, pnpm, and four environment
requirements.

Copy `boot.yaml` to the workspace root or retrieve it from the project's
published workspace map, then run:

```bash
boot up /workspace --profile agent --dry-run
boot up /workspace --profile agent
boot inspect /workspace --json
```

Expected behavior:

1. Boot validates all paths and profile references.
2. The local provider clones the three selected repositories.
3. It checks Node and pnpm versions.
4. It checks that PostgreSQL is running, but does not start it.
5. It writes selected encrypted values to `.env` files when a Boot key is
   present.
6. It reports missing requirements and exits nonzero instead of claiming ready.
7. The agent receives repository roles, the approved test command, and both
   billing constraints through JSON.

The URLs are illustrative. Replace the `acme` repositories with reachable test
repositories before running the demo.
