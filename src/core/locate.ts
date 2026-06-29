import path from "node:path";
import { mapPaths, readWorkspaceMap } from "./map";

/** A repo in the map, resolved against this machine's workspace root. */
export interface RepoChoice {
  name: string;
  relativePath: string;
  absolutePath: string;
}

export interface RankedRepo extends RepoChoice {
  score: number;
}

/** Characters that mark a "word" boundary in a repo name or path. */
const BOUNDARY_CHARS = "/-_. ";

function isBoundaryBefore(target: string, index: number): boolean {
  return index === 0 || BOUNDARY_CHARS.includes(target[index - 1]!);
}

/**
 * Score how well `query` fuzzy-matches `target` (both expected lowercased).
 * Returns `null` when `query` is not an in-order subsequence of `target`.
 * Higher is better: contiguous runs and matches at word boundaries (after
 * `/`, `-`, `_`, `.`, space) score more, and shorter targets are gently
 * preferred so a tight match beats an incidental one in a long path.
 */
export function subsequenceScore(query: string, target: string): number | null {
  if (query === "") return 0;

  let score = 0;
  let qi = 0;
  let prevMatch = -2;
  let run = 0;

  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] !== query[qi]) continue;

    score += 1;
    if (prevMatch === ti - 1) {
      run += 1;
      score += run * 3;
    } else {
      run = 0;
    }
    if (isBoundaryBefore(target, ti)) score += 6;

    prevMatch = ti;
    qi += 1;
  }

  if (qi < query.length) return null;
  return score - target.length * 0.1;
}

/**
 * Best score for a repo: match against its name and its relative path, taking
 * whichever is stronger. Name hits get a fixed bonus because typing `web`
 * usually means the repo named `web`, not just any path containing those
 * letters. Returns `null` when neither matches.
 */
export function scoreRepo(query: string, repo: RepoChoice): number | null {
  const q = query.toLowerCase();
  const nameScore = subsequenceScore(q, repo.name.toLowerCase());
  const pathScore = subsequenceScore(q, repo.relativePath.toLowerCase());

  const scores: number[] = [];
  if (nameScore !== null) scores.push(nameScore + 12);
  if (pathScore !== null) scores.push(pathScore);
  if (scores.length === 0) return null;
  return Math.max(...scores);
}

/**
 * Rank repos by how well they match `query`, best first. An empty query
 * returns every repo in stable path order (so the caller can offer a browse
 * list); ties break alphabetically by relative path.
 */
export function rankRepos(query: string, repos: RepoChoice[]): RankedRepo[] {
  const q = query.trim();
  if (q === "") {
    return repos
      .map((repo) => ({ ...repo, score: 0 }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  const ranked: RankedRepo[] = [];
  for (const repo of repos) {
    const score = scoreRepo(q, repo);
    if (score !== null) ranked.push({ ...repo, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath));
  return ranked;
}

/**
 * Load every repo the map knows about, resolved to absolute paths under this
 * machine's workspace root. Returns `[]` when the workspace has no map yet.
 */
export async function loadRepoChoices(root: string): Promise<RepoChoice[]> {
  const paths = mapPaths(root);
  const map = await readWorkspaceMap(paths.mapDir);
  if (!map) return [];
  return map.repos.map((repo) => ({
    name: repo.name,
    relativePath: repo.relativePath,
    absolutePath: path.join(paths.root, repo.relativePath),
  }));
}
