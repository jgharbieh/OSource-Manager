/**
 * Find the GitHub repo behind a tool that is not keyed by one.
 *
 * A globally-installed CLI is keyed `npm:@scope/pkg` — that is how discovery
 * found it (`npm ls -g` knows the name and the installed version, nothing else),
 * so Readme and Changelog had no repo to read and said "no upstream repository
 * on record". But npm knows: every package's metadata carries `repository`.
 *
 * The resolved key is written back as an ALIAS, not as the canonical key: the
 * identity of a global CLI is its package name, and the same repo can publish
 * several packages. The alias is what makes the second lookup free.
 */
import type { OpResult, Tool } from './types.js';
import { type Db, addAlias, selectTool } from './db.js';

export interface GithubRef {
  owner: string;
  repo: string;
  /** How it was found — shown in the UI so a guess never looks like a fact. */
  via: 'canonical' | 'alias' | 'npm-registry';
}

const GITHUB_KEY_RE = /^github\.com\/([^/\s]+)\/([^/\s]+)$/i;
const NPM_KEY_RE = /^npm:(.+)$/;
const REGISTRY_TIMEOUT_MS = 10_000;

export function parseGithubKey(key: string): { owner: string; repo: string } | null {
  const m = GITHUB_KEY_RE.exec(key);
  return m ? { owner: m[1], repo: m[2].replace(/\.git$/i, '') } : null;
}

export function npmPackageOf(key: string): string | null {
  const m = NPM_KEY_RE.exec(key);
  return m ? m[1] : null;
}

/** owner/repo out of any of the shapes npm's `repository` field takes. */
export function githubFromRepositoryField(value: unknown): { owner: string; repo: string } | null {
  const raw =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && typeof (value as { url?: unknown }).url === 'string'
        ? (value as { url: string }).url
        : null;
  if (raw === null) return null;
  // git+https://github.com/o/r.git · git@github.com:o/r.git · github:o/r · https://github.com/o/r/tree/main/pkg
  const m = /(?:github\.com[/:]|^github:)([^/\s#]+)\/([^/\s#?]+)/i.exec(raw);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, '') };
}

function fetchWithTimeout(opts: { fetchImpl?: typeof fetch }): typeof fetch {
  return (
    opts.fetchImpl ??
    ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) }))
  );
}

/**
 * Resolve a tool to a GitHub repo. Canonical key first, then a github alias
 * already on the row, then (for npm keys) one live registry lookup whose answer
 * is cached as an alias. Returns null when there genuinely is no repo.
 */
export async function resolveGithub(
  db: Db,
  toolOrId: Tool | number,
  opts: { fetchImpl?: typeof fetch; aliases?: string[] } = {},
): Promise<GithubRef | null> {
  const tool = typeof toolOrId === 'number' ? selectTool(db, toolOrId) : toolOrId;
  if (!tool) return null;

  const direct = parseGithubKey(tool.canonical_key);
  if (direct) return { ...direct, via: 'canonical' };

  const aliases =
    opts.aliases ??
    db.prepare('SELECT alias FROM aliases WHERE tool_id = ?').all(tool.id).map(r => String(r.alias));
  for (const alias of aliases) {
    const hit = parseGithubKey(alias);
    if (hit) return { ...hit, via: 'alias' };
  }

  const pkg = npmPackageOf(tool.canonical_key);
  if (!pkg) return null;

  try {
    const res = await fetchWithTimeout(opts)(
      `https://registry.npmjs.org/${pkg.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'osource-manager' } },
    );
    if (!res.ok) return null;
    const meta = (await res.json()) as Record<string, unknown>;
    const found =
      githubFromRepositoryField(meta.repository) ?? githubFromRepositoryField(meta.homepage);
    if (!found) return null;
    addAlias(db, tool.id, `github.com/${found.owner}/${found.repo}`);
    return { ...found, via: 'npm-registry' };
  } catch {
    return null;
  }
}

export interface NpmLatest {
  version: string;
  /** ISO timestamp of that version's publish, when the registry reports one. */
  published_at: string | null;
}

/**
 * Latest published version of an npm package.
 *
 * For a global CLI this — not a GitHub release tag — is the real answer to
 * "is mine current": plenty of packages publish to npm without cutting a
 * release, and `npm ls -g` compares against the registry, so OSM must too.
 */
export async function npmLatest(
  pkg: string,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<OpResult<NpmLatest>> {
  try {
    const res = await fetchWithTimeout(opts)(
      `https://registry.npmjs.org/${pkg.split('/').map(encodeURIComponent).join('/')}`,
      { headers: { Accept: 'application/json', 'User-Agent': 'osource-manager' } },
    );
    if (res.status === 404) return { ok: false, message: `npm has no package named ${pkg}` };
    if (!res.ok) return { ok: false, message: `npm registry error: HTTP ${res.status}` };
    const meta = (await res.json()) as {
      'dist-tags'?: Record<string, string>;
      time?: Record<string, string>;
    };
    const version = meta['dist-tags']?.latest;
    if (typeof version !== 'string' || version === '') {
      return { ok: false, message: `${pkg} has no dist-tags.latest` };
    }
    return {
      ok: true,
      message: `npm latest: ${version}`,
      data: { version, published_at: meta.time?.[version] ?? null },
    };
  } catch (err) {
    return {
      ok: false,
      message: `could not reach the npm registry: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
