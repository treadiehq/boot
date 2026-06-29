import { describe, expect, it } from "vitest";
import {
  rankRepos,
  scoreRepo,
  subsequenceScore,
  type RepoChoice,
} from "../core/locate";

function choice(relativePath: string, name = relativePath.split("/").pop()!): RepoChoice {
  return { name, relativePath, absolutePath: `/ws/${relativePath}` };
}

describe("subsequenceScore", () => {
  it("returns null when the query is not a subsequence", () => {
    expect(subsequenceScore("xyz", "apps/web")).toBeNull();
    expect(subsequenceScore("baw", "apps/web")).toBeNull(); // order matters
  });

  it("matches an in-order subsequence", () => {
    expect(subsequenceScore("aw", "apps/web")).not.toBeNull();
  });

  it("scores a contiguous prefix higher than a scattered match", () => {
    const contiguous = subsequenceScore("web", "web")!;
    const scattered = subsequenceScore("web", "wonderful-elastic-blob")!;
    expect(contiguous).toBeGreaterThan(scattered);
  });

  it("rewards matches at word boundaries", () => {
    // "api" sitting right after a `/` should beat the same letters mid-word.
    const boundary = subsequenceScore("api", "services/api")!;
    const midword = subsequenceScore("api", "therapist")!;
    expect(boundary).toBeGreaterThan(midword);
  });

  it("treats an empty query as a neutral match", () => {
    expect(subsequenceScore("", "anything")).toBe(0);
  });
});

describe("scoreRepo", () => {
  it("prefers a name match over an incidental path match", () => {
    const named = scoreRepo("web", choice("apps/web"))!;
    const pathOnly = scoreRepo("web", choice("wendy/blob", "blob"))!;
    expect(named).toBeGreaterThan(pathOnly);
  });

  it("returns null when neither name nor path matches", () => {
    expect(scoreRepo("zzz", choice("apps/web"))).toBeNull();
  });
});

describe("rankRepos", () => {
  const repos = [
    choice("apps/web"),
    choice("apps/web-admin", "web-admin"),
    choice("services/api"),
    choice("libs/web-utils", "web-utils"),
    choice("notes"),
  ];

  it("ranks the exact name match first", () => {
    const ranked = rankRepos("web", repos);
    expect(ranked[0]!.relativePath).toBe("apps/web");
  });

  it("excludes non-matches", () => {
    const ranked = rankRepos("web", repos);
    const paths = ranked.map((r) => r.relativePath);
    expect(paths).not.toContain("services/api");
    expect(paths).not.toContain("notes");
  });

  it("matches on the path segment too", () => {
    const ranked = rankRepos("api", repos);
    expect(ranked[0]!.relativePath).toBe("services/api");
  });

  it("returns every repo in path order for an empty query", () => {
    const ranked = rankRepos("", repos);
    expect(ranked).toHaveLength(repos.length);
    expect(ranked.map((r) => r.relativePath)).toEqual([
      "apps/web",
      "apps/web-admin",
      "libs/web-utils",
      "notes",
      "services/api",
    ]);
  });

  it("breaks score ties alphabetically by path", () => {
    const ranked = rankRepos("web", repos);
    const webish = ranked.filter((r) => r.name.includes("web")).map((r) => r.relativePath);
    // apps/web (exact) leads; the remaining ties stay path-sorted.
    expect(webish[0]).toBe("apps/web");
  });
});
