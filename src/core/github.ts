/**
 * Upstream release intelligence for GitHub-hosted repo tools (Phase 2:
 * read-only — nothing here executes installers, mutates git checkouts, or
 * touches Docker). The ONLY write is into the observations table's upstream
 * fields (version_upstream, update_available, upstream_checked_at,
 * feed_etag) via upsertObservations.
 *
 * Uses the GitHub Releases API (not the atom feed — the feed is finite and
 * unpaginated). GITHUB_TOKEN, when present in the environment, is sent as a
 * Bearer token and is never persisted, logged, or written to the DB.
 */
import type { OpResult } from './types.js';
import { npmLatest, npmPackageOf, resolveGithub } from './resolve.js';
import {
  type Db,
  now,
  selectInstallations,
  selectObservations,
  selectTool,
  selectTools,
  upsertObservations,
} from './db.js';

export interface ReleaseInfo {
  tag: string;
  name: string;
  published_at: string;
  body_excerpt: string;
}

export interface UpstreamResult {
  version_upstream: string | null;
  update_available: boolean;
  /** False when the local version could not be located in the fetched
   *  releases — the UI must render "history incomplete", never a silent
   *  partial changelog. */
  history_complete: boolean;
  releases: ReleaseInfo[];
  rate_limit_remaining: number | null;
  error?: string;
}

export interface CheckUpstreamOpts {
  /** Injectable fetch so tests never hit the network. */
  fetchImpl?: typeof fetch;
}

export interface RefreshAllOpts extends CheckUpstreamOpts {
  limit?: number;
}

const MAX_PAGES = 5;
const PER_PAGE = 100;
const BODY_EXCERPT_LEN = 280;
const GITHUB_KEY_RE = /^github\.com\/([^/\s]+)\/([^/\s]+)$/i;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** owner/repo from a github.com canonical git key, or null. */
function parseGithubKey(canonicalKey: string): { owner: string; repo: string } | null {
  const m = GITHUB_KEY_RE.exec(canonicalKey);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Tolerant tag compare: local '2.1.220' matches tag 'v2.1.220'. */
export function tagsMatch(a: string, b: string): boolean {
  const norm = (s: string): string => s.trim().replace(/^v/i, '').toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Pure, host-agnostic: entries newer than localVersion (releases are
 * newest-first), plus whether the local tag was found at all.
 */
export function changelogSince(
  releases: ReleaseInfo[],
  localVersion: string,
): { entries: ReleaseInfo[]; history_complete: boolean } {
  if (!localVersion || !localVersion.trim()) {
    return { entries: [], history_complete: false };
  }
  const idx = releases.findIndex(r => tagsMatch(r.tag, localVersion));
  if (idx === -1) return { entries: [], history_complete: false };
  return { entries: releases.slice(0, idx), history_complete: true };
}

function toReleaseInfo(raw: Record<string, unknown>): ReleaseInfo {
  const body = typeof raw.body === 'string' ? raw.body : '';
  return {
    tag: String(raw.tag_name ?? ''),
    name: String(raw.name ?? raw.tag_name ?? ''),
    published_at: String(raw.published_at ?? ''),
    body_excerpt: body.replace(/\s+/g, ' ').trim().slice(0, BODY_EXCERPT_LEN),
  };
}

function nextLink(linkHeader: string | null): boolean {
  if (!linkHeader) return false;
  return /<[^>]+>;\s*rel="next"/.test(linkHeader);
}

function rateLimitRemaining(headers: Headers): number | null {
  const raw = headers.get('x-ratelimit-remaining');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function rateLimitMessage(headers: Headers): string {
  const remaining = headers.get('x-ratelimit-remaining') ?? 'unknown';
  const resetRaw = headers.get('x-ratelimit-reset');
  const reset = resetRaw && Number.isFinite(Number(resetRaw))
    ? new Date(Number(resetRaw) * 1000).toISOString()
    : 'unknown';
  return `github rate limit exhausted (remaining ${remaining}, resets ${reset})`;
}

/** Local version = version_local of the first present installation, if any. */
function localVersionFor(db: Db, toolId: number): string | null {
  for (const inst of selectInstallations(db, toolId)) {
    if (inst.present && inst.version_local) return inst.version_local;
  }
  return null;
}

function requestHeaders(etag: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'osource-manager',
  };
  // GITHUB_TOKEN is read from the environment and sent — never persisted.
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers['If-None-Match'] = etag;
  return headers;
}

/**
 * Upstream check for an npm-keyed tool: the registry decides the version, and
 * the repo (if the package declares one) supplies the release notes.
 */
async function checkNpmUpstream(
  db: Db,
  toolId: number,
  pkg: string,
  opts: CheckUpstreamOpts,
): Promise<OpResult<UpstreamResult>> {
  const latest = await npmLatest(pkg, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
  if (!latest.ok || !latest.data) {
    return { ok: false, message: latest.message };
  }
  const version = latest.data.version;
  const localVersion = localVersionFor(db, toolId);
  const updateAvailable = localVersion !== null && !tagsMatch(localVersion, version);

  upsertObservations(db, toolId, {
    version_upstream: version,
    update_available: updateAvailable ? 1 : 0,
    upstream_checked_at: now(),
  });

  // Release notes are a bonus, never a reason to fail the check.
  let releases: ReleaseInfo[] = [];
  let historyComplete = localVersion !== null;
  const gh = await resolveGithub(db, toolId, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
  if (gh && updateAvailable && localVersion !== null) {
    const notes = await fetchReleases(gh, null, localVersion, opts.fetchImpl ?? fetch);
    if (notes) {
      const cut = changelogSince(notes.releases, localVersion);
      releases = cut.entries;
      historyComplete = cut.history_complete;
    }
  }

  return {
    ok: true,
    message: updateAvailable
      ? `npm has ${version} (you have ${localVersion})`
      : `npm latest: ${version}${localVersion === null ? ' (nothing installed locally)' : ' — up to date'}`,
    data: {
      version_upstream: version,
      update_available: updateAvailable,
      history_complete: historyComplete,
      releases,
      rate_limit_remaining: null,
    },
  };
}

/** Paginated release fetch, shared by the repo and npm paths. Null on any
 *  failure — a missing changelog must never fail the version check. */
async function fetchReleases(
  gh: { owner: string; repo: string },
  etag: string | null,
  localVersion: string | null,
  fetchImpl: typeof fetch,
): Promise<{ releases: ReleaseInfo[]; etag: string | null } | null> {
  const baseUrl = `https://api.github.com/repos/${gh.owner}/${gh.repo}/releases`;
  const releases: ReleaseInfo[] = [];
  let newEtag: string | null = null;
  try {
    for (let page = 1; page <= (localVersion ? MAX_PAGES : 1); page++) {
      const res = await fetchImpl(`${baseUrl}?per_page=${PER_PAGE}&page=${page}`, {
        headers: requestHeaders(page === 1 ? etag : null),
      });
      if (!res.ok) return null;
      if (page === 1) newEtag = res.headers.get('etag');
      const pageReleases = ((await res.json()) as Record<string, unknown>[]).map(toReleaseInfo);
      releases.push(...pageReleases);
      if (localVersion && pageReleases.some(r => tagsMatch(r.tag, localVersion))) break;
      if (!nextLink(res.headers.get('link'))) break;
    }
  } catch {
    return null;
  }
  return { releases, etag: newEtag };
}

/**
 * Check what changed upstream since the locally installed version of a
 * github.com repo tool. Paginates releases (cap MAX_PAGES) until the local
 * tag is found; ETag-caches in observations.feed_etag. Never throws — every
 * failure path is an ok:false OpResult.
 */
export async function checkUpstream(
  db: Db,
  toolId: number,
  opts: CheckUpstreamOpts = {},
): Promise<OpResult<UpstreamResult>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const tool = selectTool(db, toolId);
  if (!tool) return { ok: false, message: `tool ${toolId} not found` };

  // A globally-installed CLI is keyed npm:<pkg>. Its authority for "am I
  // current" is the npm registry, not GitHub Releases: plenty of packages
  // publish to npm without cutting a release, and `npm ls -g` compares against
  // the registry, so OSM must too. The repo (resolved from the package
  // metadata) is still used for the changelog text.
  const pkg = npmPackageOf(tool.canonical_key);
  if (pkg) return await checkNpmUpstream(db, toolId, pkg, opts);

  const gh = parseGithubKey(tool.canonical_key);
  if (!gh || tool.kind !== 'repo') {
    return { ok: false, message: `unsupported host: ${tool.canonical_key}` };
  }

  const localVersion = localVersionFor(db, toolId);
  const prev = selectObservations(db, toolId);
  const baseUrl = `https://api.github.com/repos/${gh.owner}/${gh.repo}/releases`;

  const releases: ReleaseInfo[] = [];
  let rateRemaining: number | null = null;
  let newEtag: string | null = null;
  let found = false;

  // Without a local version there is nothing to locate — page 1 is enough.
  const pagesWanted = localVersion ? MAX_PAGES : 1;
  try {
    for (let page = 1; page <= pagesWanted; page++) {
      const res = await fetchImpl(`${baseUrl}?per_page=${PER_PAGE}&page=${page}`, {
        headers: requestHeaders(page === 1 ? (prev?.feed_etag ?? null) : null),
      });
      if (page === 1) rateRemaining = rateLimitRemaining(res.headers);

      if (res.status === 304 && page === 1) {
        // Nothing changed upstream: keep the previous result, just bump the
        // checked-at timestamp.
        upsertObservations(db, toolId, { upstream_checked_at: now() });
        return {
          ok: true,
          message: 'not modified (etag match)',
          data: {
            version_upstream: prev?.version_upstream ?? null,
            update_available: Boolean(prev?.update_available),
            history_complete: true,
            releases: [],
            rate_limit_remaining: rateRemaining,
          },
        };
      }
      if (res.status === 403) {
        return { ok: false, message: rateLimitMessage(res.headers) };
      }
      if (res.status === 404) {
        // A private repo and a deleted one look identical to an unauthenticated
        // caller. Never report "no releases" for either.
        return {
          ok: false,
          message: process.env.GITHUB_TOKEN
            ? `github.com/${gh.owner}/${gh.repo} is not visible to your GITHUB_TOKEN (private, renamed or deleted)`
            : `github.com/${gh.owner}/${gh.repo} returned 404 — private, renamed or deleted. OSM calls GitHub unauthenticated; set GITHUB_TOKEN to check your private repos.`,
        };
      }
      if (!res.ok) {
        return { ok: false, message: `github api error: HTTP ${res.status}` };
      }

      if (page === 1) newEtag = res.headers.get('etag');
      const pageReleases = ((await res.json()) as Record<string, unknown>[]).map(toReleaseInfo);
      releases.push(...pageReleases);
      if (localVersion && pageReleases.some(r => tagsMatch(r.tag, localVersion))) {
        found = true;
        break;
      }
      if (!nextLink(res.headers.get('link'))) break;
    }
  } catch (err) {
    return { ok: false, message: `github check failed: ${errMsg(err)}` };
  }

  const versionUpstream = releases.length > 0 ? releases[0].tag : null;
  const { entries, history_complete } = localVersion
    ? changelogSince(releases, localVersion)
    : { entries: [] as ReleaseInfo[], history_complete: false };
  const updateAvailable = found && entries.length > 0;

  const fields: Parameters<typeof upsertObservations>[2] = {
    version_upstream: versionUpstream,
    update_available: updateAvailable ? 1 : 0,
    upstream_checked_at: now(),
  };
  if (newEtag) fields.feed_etag = newEtag;
  upsertObservations(db, toolId, fields);

  return {
    ok: true,
    message: updateAvailable
      ? `update available: ${localVersion} → ${versionUpstream}`
      : `upstream latest: ${versionUpstream ?? 'none'}`,
    data: {
      version_upstream: versionUpstream,
      update_available: updateAvailable,
      history_complete,
      releases: entries,
      rate_limit_remaining: rateRemaining,
    },
  };
}

/**
 * Check every github.com repo tool, sequentially (polite to the API), never
 * aborting the batch on one failure. Delay is skipped when fetchImpl is
 * injected (tests).
 */
export async function refreshAllUpstream(
  db: Db,
  opts: RefreshAllOpts = {},
): Promise<OpResult<{ checked: number; errors: string[] }>> {
  // Global CLIs are checked too — their upstream is the npm registry, which is
  // unauthenticated and not rate-limited the way the GitHub API is.
  const tools = selectTools(db).filter(
    t =>
      (t.kind === 'repo' && parseGithubKey(t.canonical_key) !== null) ||
      npmPackageOf(t.canonical_key) !== null,
  );
  const limited = opts.limit !== undefined ? tools.slice(0, opts.limit) : tools;

  const errors: string[] = [];
  let checked = 0;
  for (const tool of limited) {
    try {
      const res = await checkUpstream(db, tool.id, { fetchImpl: opts.fetchImpl });
      if (res.ok) {
        checked++;
      } else {
        errors.push(`${tool.name}: ${res.message}`);
      }
    } catch (err) {
      errors.push(`${tool.name}: ${errMsg(err)}`);
    }
    if (!opts.fetchImpl) {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  return {
    ok: true,
    message: `checked ${checked} tool(s), ${errors.length} error(s)`,
    data: { checked, errors },
  };
}
