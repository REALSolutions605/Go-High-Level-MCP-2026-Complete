import { execSync } from 'child_process';

// ─── Build Identity ───────────────────────────────────────────────────────────
// A deployed build was once found to be older than source with no way to tell,
// because nothing in the running process named the commit it was built from.
// /health now reports it, so a deploy can be verified against a commit hash
// instead of assumed.
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildInfo {
  /** Full 40-char SHA, or 'unknown' when it could not be determined. */
  commit: string;
  /** First 7 chars of `commit`, or 'unknown'. */
  commitShort: string;
  /** Where the SHA came from — tells you whether to trust it. */
  commitSource: string;
}

/** Platform-injected commit SHA, in preference order. */
const ENV_KEYS = [
  'RAILWAY_GIT_COMMIT_SHA', // Railway (this deployment)
  'GIT_COMMIT_SHA',
  'SOURCE_COMMIT', // Docker Hub / Heroku-style builders
  'GIT_COMMIT',
  'VERCEL_GIT_COMMIT_SHA',
  'RENDER_GIT_COMMIT',
  'HEROKU_SLUG_COMMIT',
] as const;

function looksLikeSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,40}$/i.test(value.trim());
}

/**
 * Resolve the commit this process was built from.
 *
 * Environment first (the only thing available in a container built from a
 * tarball), then `git rev-parse` for local runs. Never throws.
 */
export function resolveBuildInfo(): BuildInfo {
  for (const key of ENV_KEYS) {
    const value = process.env[key];
    if (looksLikeSha(value)) {
      const commit = value.trim();
      return { commit, commitShort: commit.slice(0, 7), commitSource: key };
    }
  }

  try {
    const out = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
    if (looksLikeSha(out)) {
      return { commit: out, commitShort: out.slice(0, 7), commitSource: 'git' };
    }
  } catch {
    // No git, no .git directory, or git not on PATH — fall through.
  }

  return { commit: 'unknown', commitShort: 'unknown', commitSource: 'unavailable' };
}

/** Resolved once at module load; the commit cannot change while running. */
export const BUILD_INFO: BuildInfo = resolveBuildInfo();
