/**
 * README rendering.
 *
 * OSM stores no repo files, so a README is fetched at read time:
 *
 * 1. github.com repo  → GitHub's own `GET /repos/:o/:r/readme` with
 *    `Accept: application/vnd.github.html+json`. GitHub returns the README
 *    ALREADY rendered to HTML, with relative image paths rewritten to absolute
 *    camo URLs and `<video>` tags intact. That is why this module contains no
 *    markdown parser: rendering markdown correctly (tables, footnotes, task
 *    lists, HTML blocks, attachment videos) is exactly the job GitHub already
 *    does, for free, on the canonical source.
 * 2. no upstream, but a checkout on disk → the local README.md, unrendered.
 *    Local markdown gets no images anyway (they are relative to a path the
 *    browser cannot read), so raw text in a <pre> is the honest render.
 *
 * README content is attacker-controlled. GitHub's pipeline already strips
 * scripts and event handlers, but this is a local app rendering a third
 * party's HTML, so `sanitize()` re-strips independently — trust nothing
 * that arrives over the wire.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { OpResult } from './types.js';
import { type Db, selectInstallations, selectTool } from './db.js';
import { resolveGithub } from './resolve.js';

export interface ReadmeDoc {
  /** 'html' = safe-to-inject markup. 'text' = must be escaped by the caller. */
  format: 'html' | 'text';
  body: string;
  /** Where it came from, shown verbatim in the UI. */
  source: string;
  /** Canonical web URL of the README, when there is one. */
  url: string | null;
  truncated: boolean;
}

export interface ReadmeOpts {
  fetchImpl?: typeof fetch;
}

const MAX_BYTES = 400_000;
const TIMEOUT_MS = 15_000;

/** Tags that can execute or exfiltrate. Dropped with their contents. */
const KILL_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'base'];

/**
 * Strip anything executable from third-party HTML.
 *
 * ponytail: regex, not a DOM parser — the input is GitHub's own already-
 * sanitized output, so this is defence in depth on a localhost-only page, not
 * the only line of defence. If OSM ever renders HTML from an untrusted host
 * directly, swap this for a real sanitizer.
 */
export function sanitize(html: string): string {
  let out = html;
  for (const tag of KILL_TAGS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), '');
  }
  // Inline event handlers: on*="…" / on*='…' / on*=bare
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // javascript:/vbscript: and data: URLs in href/src (data:image is fine).
  out = out.replace(
    /\s(href|src|xlink:href)\s*=\s*("|')\s*(javascript|vbscript|data)\s*:(?!image\/)[^"']*\2/gi,
    ' data-blocked-url="1"',
  );
  return out;
}

/** Anything with a scheme, a protocol-relative URL, or an in-page anchor. */
const ABSOLUTE_RE = /^([a-z][a-z0-9+.-]*:|\/\/|#|mailto:)/i;

/**
 * Rewrite repo-relative URLs to absolute ones.
 *
 * GitHub rewrites markdown images (`![x](a.png)`) to camo URLs, but leaves raw
 * HTML blocks alone — and READMEs are full of `<img src="src/assets/logo.svg">`
 * inside a `<p align="center">`. Served from OSM's own origin those resolve to
 * http://127.0.0.1:PORT/src/assets/logo.svg and 404. Verified against
 * OpenWhispr/openwhispr, whose logo broke exactly this way.
 *
 * Images/media point at raw.githubusercontent (the file itself); links point at
 * the blob page (what a human wants).
 */
export function absolutize(html: string, owner: string, repo: string): string {
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/`;
  const blob = `https://github.com/${owner}/${repo}/blob/HEAD/`;
  return html.replace(
    /\s(src|href|poster)\s*=\s*"([^"]*)"/gi,
    (whole: string, attr: string, value: string) => {
      const v = value.trim();
      if (v === '' || ABSOLUTE_RE.test(v)) return whole;
      const base = attr.toLowerCase() === 'href' ? blob : raw;
      return ` ${attr}="${base}${v.replace(/^\.?\//, '')}"`;
    },
  );
}

/** Present disk path of an installation, or null (named sources are not paths). */
function diskPath(db: Db, toolId: number): string | null {
  const inst = selectInstallations(db, toolId).find(
    i => i.present === 1 && !['npm-g', 'winget', 'skills-dir'].includes(i.where_),
  );
  if (!inst) return null;
  return inst.where_.startsWith('skills-dir:') ? inst.where_.slice('skills-dir:'.length) : inst.where_;
}

/**
 * The file that documents this directory, in preference order.
 *
 * A skill has no README — its documentation IS SKILL.md, which is why the
 * Readme tab came up empty for every skill on the shelf. Same for an agent
 * repo's AGENTS.md/CLAUDE.md when that is all it ships.
 */
const DOC_FILES: RegExp[] = [
  /^readme(\.(md|markdown|txt|rst))?$/i,
  /^skill\.md$/i,
  /^agents?\.md$/i,
  /^claude\.md$/i,
];

function findLocalReadme(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const re of DOC_FILES) {
    const hit = names.find(f => re.test(f));
    if (hit) return join(dir, hit);
  }
  return null;
}

function clamp(s: string): { body: string; truncated: boolean } {
  return s.length > MAX_BYTES
    ? { body: s.slice(0, MAX_BYTES), truncated: true }
    : { body: s, truncated: false };
}

/**
 * Fetch the README for a tool. Never throws — every failure is ok:false so the
 * panel can render the reason instead of a blank pane.
 */
export async function getReadme(
  db: Db,
  toolId: number,
  opts: ReadmeOpts = {},
): Promise<OpResult<ReadmeDoc>> {
  const tool = selectTool(db, toolId);
  if (!tool) return { ok: false, message: `tool ${toolId} not found` };

  // A global CLI is keyed npm:<pkg>; its repo comes from the registry.
  const gh = await resolveGithub(db, tool, opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {});
  const dir = diskPath(db, toolId);

  if (gh) {
    const fetchImpl =
      opts.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }));
    const headers: Record<string, string> = {
      // html+json ⇒ GitHub renders the markdown for us, absolute image URLs included.
      Accept: 'application/vnd.github.html+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'osource-manager',
    };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    const api = `https://api.github.com/repos/${gh.owner}/${gh.repo}/readme`;
    try {
      const res = await fetchImpl(api, { headers });
      if (res.ok) {
        const { body, truncated } = clamp(absolutize(sanitize(await res.text()), gh.owner, gh.repo));
        return {
          ok: true,
          message: `README from github.com/${gh.owner}/${gh.repo}`,
          data: {
            format: 'html',
            body,
            source: `github.com/${gh.owner}/${gh.repo}`,
            url: `https://github.com/${gh.owner}/${gh.repo}#readme`,
            truncated,
          },
        };
      }
      if (res.status === 404) {
        // Unauthenticated GitHub answers 404 for a private repo and for one that
        // does not exist — the two are indistinguishable from here, so say so
        // rather than claiming the repo has no README.
        return {
          ok: false,
          message: process.env.GITHUB_TOKEN
            ? `github.com/${gh.owner}/${gh.repo} has no README (or the repo is not visible to your GITHUB_TOKEN)`
            : `github.com/${gh.owner}/${gh.repo} returned 404 — a private repo, a renamed/deleted one, or genuinely no README. OSM is calling GitHub unauthenticated; set GITHUB_TOKEN to see your private repos.`,
        };
      }
      if (res.status === 403) {
        const remaining = res.headers.get('x-ratelimit-remaining') ?? 'unknown';
        return {
          ok: false,
          message: `github rate limit reached (remaining ${remaining}) — set GITHUB_TOKEN to raise it`,
        };
      }
      // Fall through to the local copy rather than failing outright.
      if (!dir) return { ok: false, message: `github api error: HTTP ${res.status}` };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      if (!dir) return { ok: false, message: `could not reach github: ${why}` };
    }
  }

  if (dir && existsSync(dir)) {
    const file = findLocalReadme(dir);
    if (file) {
      try {
        const { body, truncated } = clamp(readFileSync(file, 'utf8'));
        return {
          ok: true,
          message: `README from the checkout at ${file}`,
          data: { format: 'text', body, source: file, url: null, truncated },
        };
      } catch (err) {
        return { ok: false, message: `could not read ${file}: ${String(err)}` };
      }
    }
    return { ok: false, message: `no README.md, SKILL.md or AGENTS.md in ${dir}` };
  }

  return {
    ok: false,
    message: gh
      ? 'github was unreachable and there is no checkout on this disk to fall back to'
      : `no repository could be resolved for ${tool.name} (key: ${tool.canonical_key}) and there is no checkout on this disk. Set its upstream in Details and this tab starts working.`,
  };
}
