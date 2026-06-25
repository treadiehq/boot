import { describe, expect, it } from "vitest";
import { runDoctorChecks, type DoctorRepo } from "../core/doctor";
import { IGNORE_FILE_NAME } from "../core/ignore";

function repo(overrides: Partial<DoctorRepo> = {}): DoctorRepo {
  return {
    name: "kplane",
    relativePath: "apps/kplane",
    status: "local",
    dirty: false,
    remoteUrl: "git@github.com:dantelex2/kplane.git",
    currentBranch: "main",
    lastCommitDate: new Date("2026-06-20T00:00:00.000Z"),
    projectType: "node",
    detectedFiles: ["package.json", "pnpm-lock.yaml"],
    packageManager: "pnpm",
    presentGeneratedDirs: [],
    ...overrides,
  };
}

const NOW = new Date("2026-06-24T00:00:00.000Z");

const base = {
  hasWorkspaceIgnoreFile: true,
  defaultBranchNames: ["main", "master"],
  staleAfterDays: 30,
  now: NOW,
};

describe("runDoctorChecks", () => {
  it("reports a clean workspace with no warnings", () => {
    const report = runDoctorChecks({ ...base, repos: [repo()] });
    expect(report.warnings).toEqual([]);
    expect(report.reposChecked).toBe(1);
    expect(report.placeholdersChecked).toBe(0);
  });

  it("flags dirty, off-branch, and remoteless repos", () => {
    const report = runDoctorChecks({
      ...base,
      repos: [
        repo({ name: "infraone", dirty: true }),
        repo({ name: "kplane", currentBranch: "agent-test" }),
        repo({ name: "local-experiment", remoteUrl: null }),
      ],
    });
    expect(report.warnings).toContain("infraone is dirty");
    expect(report.warnings).toContain("kplane is on branch agent-test instead of main/master");
    expect(report.warnings).toContain("local-experiment has no remote");
  });

  it("flags placeholders without a remote URL and counts them separately", () => {
    const report = runDoctorChecks({
      ...base,
      repos: [
        repo({ relativePath: "experiments/receipts", status: "placeholder", remoteUrl: null }),
        repo({ relativePath: "apps/ok", status: "placeholder" }),
      ],
    });
    expect(report.placeholdersChecked).toBe(2);
    expect(report.reposChecked).toBe(0);
    expect(report.warnings).toContain("experiments/receipts is a placeholder with no remote URL");
  });

  it("flags stale repos based on staleAfterDays", () => {
    const report = runDoctorChecks({
      ...base,
      repos: [repo({ name: "old", lastCommitDate: new Date("2026-01-01T00:00:00.000Z") })],
    });
    expect(report.warnings.some((w) => /old last commit is \d+ days old/.test(w))).toBe(true);
  });

  it("flags missing lockfiles, generated folders, and a missing ignore file", () => {
    const report = runDoctorChecks({
      ...base,
      hasWorkspaceIgnoreFile: false,
      repos: [
        repo({ name: "nolock", packageManager: null, presentGeneratedDirs: ["node_modules"] }),
      ],
    });
    expect(report.warnings).toContain(`workspace has no ${IGNORE_FILE_NAME}`);
    expect(report.warnings).toContain("nolock has a package.json but no lockfile");
    expect(report.warnings).toContain("nolock has node_modules present; this should not be synced later");
  });
});
