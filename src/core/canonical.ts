// Canonicalization helpers: collapse every spelling of the same tool into one
// canonical key, so discovery and scanning never create duplicate rows.
import { createHash } from 'node:crypto';

/**
 * Normalize any git remote URL to `host/owner/repo` (lowercase host).
 * Handles https/http/git/ssh schemes, git@host:owner/repo SCP-style SSH,
 * `www.` prefixes, trailing `.git` and trailing slashes.
 * Returns null if the URL cannot be parsed as a git remote.
 */
export function canonicalizeGitUrl(url: string): string | null {
  let s = url.trim();
  if (!s) return null;

  // SCP-style SSH: [user@]host:path (e.g. git@github.com:owner/repo.git)
  const scpMatch = /^[^@\s/]+@([^:/\s]+):(.+)$/.exec(s);
  if (scpMatch) {
    const host = scpMatch[1].toLowerCase();
    const pathPart = scpMatch[2];
    return joinParts(host, pathPart);
  }

  // ssh://[user@]host[:port]/path and other scheme:// URLs
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!u.hostname) return null;
      return joinParts(u.hostname.toLowerCase(), u.pathname);
    } catch {
      return null;
    }
  }

  // Scheme-relative //host/path
  if (s.startsWith('//')) {
    return canonicalizeGitUrl(`https:${s}`);
  }

  // Bare host/owner/repo (first segment looks like a hostname) or owner/repo
  // shorthand (assume GitHub).
  const bareParts = s.replace(/\/+$/, '').split('/').filter(Boolean);
  if (bareParts.length === 3 && bareParts[0].includes('.')) {
    return joinParts(bareParts[0].toLowerCase(), bareParts.slice(1).join('/'));
  }
  if (bareParts.length === 2 && !bareParts[0].includes('.')) {
    return joinParts('github.com', s);
  }

  return null;
}

/** Join host + path into host/owner/repo, or null if not owner/repo shaped. */
function joinParts(host: string, rawPath: string): string | null {
  const cleanHost = host.replace(/^www\./i, '');
  const parts = rawPath
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
  if (parts.length !== 2) return null;
  if (!parts[0] || !parts[1]) return null;
  return `${cleanHost}/${parts[0]}/${parts[1]}`;
}

/** Canonical key for a git remote — same value as canonicalizeGitUrl. */
export function canonicalKeyForGitUrl(url: string): string | null {
  return canonicalizeGitUrl(url);
}

/** Canonical key for an npm package: `npm:<pkg>`. */
export function canonicalKeyForNpm(pkg: string): string {
  return `npm:${pkg.trim()}`;
}

/** Canonical key for a skill: `skill:<name>`. */
export function canonicalKeyForSkill(name: string): string {
  return `skill:${name.trim()}`;
}

/** Canonical key for a local path: `local:<first 12 hex of sha1>`. */
export function canonicalKeyForLocal(absPath: string): string {
  const normalized = absPath.trim().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  return `local:${hash}`;
}

/**
 * All common spellings of a git URL that must collapse to one row:
 * https and SSH forms, with/without `.git`, with/without `www.`.
 * Empty array if the URL is unparseable.
 *
 * Every alias is HOST-QUALIFIED. A bare `owner/repo` alias used to be emitted
 * too, and because both trackTool() and discovery match on any alias, it fused
 * `github.com/acme/widget` and `gitlab.com/acme/widget` — two genuinely
 * different repos — into one row that could only be unpicked with manual SQL.
 * The one exception is github.com, whose shorthand IS `owner/repo`: that alias
 * is unambiguous inside GitHub's namespace, and no other host emits it, so it
 * can no longer collide.
 */
export function aliasesForGitUrl(url: string): string[] {
  const key = canonicalizeGitUrl(url);
  if (!key) return [];
  const [host, owner, repo] = key.split('/');
  const out = [
    `https://${host}/${owner}/${repo}`,
    `https://${host}/${owner}/${repo}.git`,
    `https://www.${host}/${owner}/${repo}`,
    `https://www.${host}/${owner}/${repo}.git`,
    `http://${host}/${owner}/${repo}`,
    `git@${host}:${owner}/${repo}.git`,
    `git@${host}:${owner}/${repo}`,
    `ssh://git@${host}/${owner}/${repo}.git`,
    `ssh://git@${host}/${owner}/${repo}`,
    `git://${host}/${owner}/${repo}.git`,
    `${host}/${owner}/${repo}`,
  ];
  if (host === 'github.com') out.push(`${owner}/${repo}`);
  return [...new Set(out)];
}

/** Human-readable short name from any canonical key. */
export function nameFromCanonicalKey(key: string): string {
  if (key.startsWith('npm:')) return key.slice(4);
  if (key.startsWith('skill:')) return key.slice(6);
  if (key.startsWith('local:')) return key.slice(6);
  const parts = key.split('/');
  return parts[parts.length - 1] ?? key;
}

/** Web URL for a canonical git key (`host/owner/repo`) for UI links. */
export function repoWebUrl(canonicalGitKey: string): string {
  return `https://${canonicalGitKey}`;
}
