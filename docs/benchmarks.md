# Agent bootstrap benchmark

Boot includes a deterministic benchmark for setup mechanics through the first
passing test:

```bash
pnpm benchmark:agent -- \
  --binary dist/release/boot-linux-arm64 \
  --iterations 20 --warmups 3
```

The benchmark runs inside a fresh Ubuntu 24.04 container with networking
disabled during trials. Every trial uses new workspace paths and local bare Git
remotes. The Boot path runs ephemeral workspace bootstrap, validates
`boot inspect --json`, and executes the declared test command. The
`manual-informed` lower bound receives the repository URL plus setup/test
commands directly; it does not include README discovery or agent reasoning.

## Baseline

Measured on 2026-08-14 with an ARM64 standalone development binary, 20 recorded
iterations per mode/scenario, and 3 warmups:

- Boot: 20/20 first tests passed; median 293.5 ms; p95 337.0 ms; median absolute
  deviation 9.5 ms.
- Manual-informed: 20/20 first tests passed; median 8.0 ms; p95 9.0 ms; median
  absolute deviation 0.5 ms.
- Both paths detected all 20 injected setup failures and had no unexpected
  setup failures. Boot's detection required structured JSON identifying the
  failed `setup` command and exit status 42.

Boot is not faster than an operator that already knows the exact repository and
commands. Its measured overhead buys map acquisition, profile scoping,
readiness validation, a runtime-validated context contract, and deterministic
failure attribution. This harness does not measure LLM exploration time, remote
network latency, container startup, or template build time.

Use `--smoke` for one correctness sample. Raw JSONL and a summary JSON are
written below `dist/benchmarks/`; timing thresholds are intentionally not CI
gates.
