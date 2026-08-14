#!/usr/bin/env python3
"""Summarize deterministic Boot/manual benchmark JSONL without extrapolating to LLM speed."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any


def fail(message: str) -> "NoReturn":
    print(f"Benchmark summary failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_records(path: Path) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as error:
        fail(f"could not read {path}: {error}")

    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(lines, start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as error:
            fail(f"{path}:{line_number} is not valid JSON: {error.msg}")
        if not isinstance(record, dict):
            fail(f"{path}:{line_number} must contain a JSON object")
        required = {
            "schema_version",
            "benchmark",
            "mode",
            "scenario",
            "iteration",
            "elapsed_ms",
            "time_to_first_test_ms",
            "setup_failed",
            "test_passed",
            "error_detected",
        }
        missing = sorted(required - record.keys())
        if missing:
            fail(f"{path}:{line_number} is missing fields: {', '.join(missing)}")
        if record["schema_version"] != 1:
            fail(f"{path}:{line_number} has unsupported schema_version")
        records.append(record)

    if not records:
        fail(f"{path} did not contain any benchmark records")
    return records


def nearest_rank_p95(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(0.95 * len(ordered)) - 1)]


def duration(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.1f} ms"


def median_absolute_deviation(values: list[float]) -> float | None:
    if not values:
        return None
    median = statistics.median(values)
    return statistics.median(abs(value - median) for value in values)


def build_summary(records: list[dict[str, Any]]) -> dict[str, Any]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        grouped[str(record["mode"])].append(record)

    methods: dict[str, Any] = {}
    preferred_order = ["boot", "manual-informed"]
    ordered_modes = preferred_order + sorted(set(grouped) - set(preferred_order))
    for mode in ordered_modes:
        if mode not in grouped:
            continue
        mode_records = grouped[mode]
        success_records = [r for r in mode_records if r["scenario"] == "success"]
        injected_records = [r for r in mode_records if r["scenario"] == "setup_failure"]
        passing_times = [
            float(r["time_to_first_test_ms"])
            for r in success_records
            if r["test_passed"] is True and isinstance(r["time_to_first_test_ms"], (int, float))
        ]
        detected = sum(r["error_detected"] is True for r in injected_records)
        setup_failures = sum(r["setup_failed"] is True for r in mode_records)
        unexpected_setup_failures = sum(
            r["setup_failed"] is True for r in success_records
        )

        methods[mode] = {
            "records": len(mode_records),
            "successful_first_tests": len(passing_times),
            "success_trials": len(success_records),
            "time_to_first_test_ms": {
                "median": statistics.median(passing_times) if passing_times else None,
                "p95_nearest_rank": nearest_rank_p95(passing_times),
                "median_absolute_deviation": median_absolute_deviation(passing_times),
            },
            "setup_failures": setup_failures,
            "unexpected_setup_failures": unexpected_setup_failures,
            "injected_errors_detected": detected,
            "injected_error_trials": len(injected_records),
        }

    return {
        "schema_version": 1,
        "benchmark": "time-to-first-test",
        "scope": (
            "Deterministic local setup mechanics only. Fixture creation, container startup, "
            "remote network time, and LLM reasoning are excluded."
        ),
        "methods": methods,
    }


def is_complete(summary: dict[str, Any]) -> bool:
    methods = summary["methods"]
    return bool(methods) and all(
        data["success_trials"] > 0
        and data["successful_first_tests"] == data["success_trials"]
        and data["unexpected_setup_failures"] == 0
        and data["injected_error_trials"] > 0
        and data["injected_errors_detected"] == data["injected_error_trials"]
        for data in methods.values()
    )


def print_human(summary: dict[str, Any]) -> None:
    print(summary["scope"])
    for mode, data in summary["methods"].items():
        timing = data["time_to_first_test_ms"]
        print(
            f"{mode}: first tests {data['successful_first_tests']}/{data['success_trials']}; "
            f"median {duration(timing['median'])}; "
            f"p95 {duration(timing['p95_nearest_rank'])}; "
            f"MAD {duration(timing['median_absolute_deviation'])}; "
            f"setup failures {data['setup_failures']} "
            f"(unexpected {data['unexpected_setup_failures']}); "
            f"injected errors detected "
            f"{data['injected_errors_detected']}/{data['injected_error_trials']}"
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Summarize Boot benchmark JSONL using median and nearest-rank p95."
    )
    parser.add_argument("results", type=Path, help="JSONL results from run.sh")
    parser.add_argument("--json", action="store_true", help="write the summary as JSON")
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if success trials fail or injected setup errors are missed",
    )
    args = parser.parse_args()

    summary = build_summary(load_records(args.results))
    if args.json:
        print(json.dumps(summary, indent=2, sort_keys=True))
    else:
        print_human(summary)

    if args.check and not is_complete(summary):
        fail("one or more modes failed a success trial or missed an injected setup error")


if __name__ == "__main__":
    main()
