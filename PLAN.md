# OSource-Manager — build plan v2

> v2 supersedes v1 after **two independent Codex adversarial reviews** (2026-07-31 / 08-01). Both flagged the same five design flaws; the second added eight more, all verified locally. Every mechanism claim in v1 that was wrong is corrected below. Changes marked **[R2]**.

## Context

Joseph's dev/social audit surfaced one unowned gap: nothing joins *what's on my disk* ↔ *what upstream did* ↔ *do I still want this* ↔ *act on it*. The 60-tool pile is the symptom; `D:\dev\tools\IMPORTED.md` — hand-written origin traces, "deleted 2026-07-31, link kept, re-clone if needed" — is proof he already does this job by hand. OSource-Manager automates that: **see it → try it → keep it or kill it, with the verdict remembered**.

Personal, open source (MIT), local-only, single-user. UI approved over 4 iterations: `ui-mockup.html` (in repo) / https://claude.ai/code/artifact/dc69860e-ac58-4556-9b97-4db39586f56c

**Joseph's critical flows, his order:** storing repos · tracking · running repos · updating repos. Registrar = "a longer fight," in scope, built last. Comments stream = "game changer."

**[R2] The differentiated product is trustworthy inventory + comments.** Docker execution, mutation, and registrar writes are *privileged extensions*, not ordinary CRUD — each ships behind its own gate after its own verification.

## Locked decisions

| # | Decision | Value |
|---|---|---|
| 1 | Name / location | `OSource-Manager` at `D:\dev\personal\OSource-Manager` |
| 2 | Stack | TypeScript, ESM, Vite, **no UI framework** |
| 3 | DB | `node:sqlite` — **[R2] stability 1.2 (release candidate), not stable.** Verified working on Node 24.15 (no warning emitted). Keep the DB layer behind a thin interface so `better-sqlite3` is a real, not theoretical, fallback |
| 4 | Layout | one package: `core/` + `mcp/` + `web/` — MCP tools and HTTP endpoints call the **same core functions** |
| 5 | Owned fields | `verdict`, `why_i_want_it`, `retire_reason`, `tags`, `favorite`, **comments stream** |
| 6 | Discovery | scan configured dirs + package managers + agent configs + `docker ps` — registry is a cache of the machine |
| 7 | Source dirs | configurable (default `D:\dev\tools`, `D:\dev\personal`) |
| 8 | Upstream | GitHub Releases **API, paginated until the local tag is found** — [R2] the atom feed is finite and unpaginated, so an older installed tag may not appear in it, and the commits fallback has no version correspondence at all. When the local version can't be located, render **"history incomplete"**, never a silent partial changelog. ETag-cached, on open + manual refresh, **no daemon** |
| 9 | Trial | local Docker only. No cloud, ever |
| 10 | Catalogs | queried **live**, never mirrored |
| 11 | First run | auto-import everything found |
| 12 | Auto-update | **off** by default, per-row toggle |
| 13 | License | MIT, public repo (creation + push = ask Joseph) |
| 14 | Scale | plain list; virtualize only when a real row count lags. Ctrl+K palette is the entry point at scale |

## [R2] Verified mechanism corrections

Checked against the actual CLIs on this machine, 2026-07-31:

| v1 claimed | Truth | Consequence |
|---|---|---|
| `docker mcp server enable <name>` | ❌ **Does not exist.** `docker mcp server` exposes only `init`. Real groups: `catalog`, `client`, `gateway`, `profile`, `tools`, `secret`, `oauth` | Toolkit path must be designed against `client`/`gateway`/`catalog`. Probe before building |
| Hand-edit `~/.codex/config.toml` w/ backup+rollback | ❌ **Unnecessary.** `codex mcp add / list / get / remove` exist | Use the CLI. Deletes all TOML-editing machinery |
| `claude mcp add-json <name> <json> --scope user` | ✅ Exists as documented | Keep |
| `node:sqlite` stable in Node 24 | ❌ RC (stability 1.2) | Interface + real fallback (row 3) |
| GitHub unauth: search 10/min | ✅ — but broader REST is **60/hr** | Browse must degrade gracefully and surface remaining quota |

**Rule this establishes:** prefer an official CLI over editing another tool's config file. Every adapter probes `--help` at build time; none is written from memory.

### [R2] Windows execution — `.cmd` shims
Bare `claude` / `codex` are **blocked by this machine's PowerShell execution policy**; `claude.cmd` / `codex.cmd` work. Verified locally. Every spawn resolves the `.cmd` shim on Windows and passes JSON as a single argv element (never a shell string) — `child_process` documents the special handling `.cmd` requires. Getting this wrong makes the entire registrar silently fail on the only machine it runs on.

### [R2] Two processes, one database
The web server and one or more stdio MCP processes write concurrently. `DatabaseSync` defaults to a **zero-millisecond busy timeout** — the second writer errors instead of waiting. Required at db-open: `PRAGMA journal_mode=WAL`, `PRAGMA busy_timeout=5000`. Every mutation **and its journal event** go in one transaction, so a state change can never land without its comment. Concurrency test in the phase-1 suite.

### [R2] Docker Toolkit — real mechanism
Not `server enable`. Browse uses `docker mcp catalog server ls <catalog>`; enabling is **profile-based**: `docker mcp profile server add/remove`. Probe both at build time before writing the adapter.

## Non-goals

❌ Managing *all* agent MCP servers (only tools inside OSM) · ❌ cloud trials, hosted mode, auth, multi-user · ❌ catalog mirroring, notifications, daemon · ❌ container management past trial + teardown (link to Portainer) · ❌ dependency tracking inside repos · ❌ rebuilding topgrade / Portainer / Docker MCP Toolkit

## Machine facts (verified 2026-07-31)

- Node v24.15.0, npm 11.13, pnpm 11.12 · winget ✓ · scoop/pipx/cargo ✗ (probers skip absent managers)
- Docker 29.5.3 running; `docker mcp` present (surface above)
- Agent configs: `~/.claude.json` ✓ · `~/.codex/config.toml` ✓ · `~/.kimi/` ✓ (shape TBD) · VS Code mcp.json ✗ at default path · Zed TBD
- `D:\dev\tools`: 3 git repos (mcp-server-trello, openmontage, openwhispr-src) + obscura (binaries, origin unknown) + **IMPORTED.md** — parse as seed; the CL4R1T4S row is a deleted-but-tracked entry, exactly the state the schema must express
- npm -g: 11 packages (claude-code, codex, gemini-cli, agent-browser, slack-mcp-server, …) → `global-cli` rows
- Skills: 29 at `D:\dev\personal\claude-code\skills`, symlinked to `~/.claude/skills`, remote `jgharbieh/claude-code`

## [R2] Schema — verdict vs. observation split

v1's single `state` column conflated *what Joseph decided* with *what the machine currently shows*. A tool can be installed **and** serving **and** under trial simultaneously; v1's `tear_down → tracked` would have erased the fact that a clone still sits on disk.

```sql
-- IDENTITY (canonical, reconciliation-safe)
tools(
  id INTEGER PRIMARY KEY,
  canonical_key TEXT UNIQUE NOT NULL,   -- "github.com/owner/repo" | "npm:pkg" | "skill:name" | "local:<hash>"
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- repo | global-cli | skill | binary
  -- JOSEPH'S VERDICT (owned, never overwritten by discovery)
  verdict TEXT NOT NULL,                -- wanted | trying | kept | retired
  why_i_want_it TEXT, retire_reason TEXT,
  favorite INTEGER DEFAULT 0, auto_update INTEGER DEFAULT 0,
  source TEXT, added_at TEXT, updated_at TEXT
);
aliases(tool_id, alias TEXT UNIQUE);    -- ssh/https/symlink variants collapse here
installations(                           -- OBSERVED, replaced wholesale each scan
  id INTEGER PRIMARY KEY, tool_id,
  where_ TEXT,                          -- disk path | npm-g | winget | skills-dir
  version_local TEXT, present INTEGER, last_seen_at TEXT
);
observations(tool_id PRIMARY KEY, serving_count INT, trial_running INT,
  version_upstream TEXT, update_available INT, upstream_checked_at TEXT, feed_etag TEXT);
tags(tool_id, tag TEXT, detected INTEGER);
comments(id INTEGER PRIMARY KEY, tool_id, kind TEXT CHECK(kind IN('user','event')),
  body TEXT, created_at TEXT);          -- append-only journal
trials(id INTEGER PRIMARY KEY, trial_uid TEXT UNIQUE, tool_id,
  container TEXT, image TEXT, ports TEXT,
  image_created_by_osm INTEGER, volumes_created_by_osm TEXT,   -- [R2] ownership
  started_at TEXT, ended_at TEXT, outcome TEXT);
```

**Reconciliation rules [R2]:** canonicalize URLs (strip `.git`, scheme, `www`, trailing slash; SSH→HTTPS) before matching · a scan writes only `installations`/`observations`, **never** owned fields · missing on scan sets `present=0` + keeps `last_seen_at`, it does not delete the row · `serving_count` derived by reading agent configs each refresh, never stored as truth.

**Comments stream = the journal.** Every mutating op appends an `event` row (tracked · trial started/ended · promoted · updated vX→vY · registered→codex · retired: reason). User comments interleave. This is what makes a six-month-old decision legible.

## [R2] "Do I still use this?" — stated honestly

Discovery can see *installed* and *registered*. It **cannot** see usage — Joseph launches tools outside OSM constantly. v1's `last_used_at` would have been a confident lie.

Three signals, each labeled in the UI for what it is:
- `last_touched_at` — filesystem mtime of the install dir. Weak, honest, free.
- `last_action_at` — last action **through OSM**. Exact, narrow, labeled as such.
- **Manual check-in** — a comment or a "still using this" button. The journal already carries it.

The retire-candidate view is `present=1 AND never any signal` — surfaced as *"no evidence of use"*, never *"unused"*. Skills are the exception: `~/.claude/skills` usage is genuinely unobservable, so a skill row shows "never fired" only if Joseph says so.

## The eight operations (`ops.ts` — each 1:1 an MCP tool and an HTTP endpoint)

| Op | Does | [R2] Safety |
|---|---|---|
| `search` | shelf query + **live** catalog query | surface GitHub rate-limit remaining; degrade, don't fail |
| `track` | add URL at `wanted` (+ why → column + comment) | canonicalize before insert; merge into existing row if alias matches |
| `comment` | append to a tool's stream | — |
| `plan_trial` | **[R2] new — read-only.** Parse compose/Dockerfile/README → return the exact command + every flag explained | never executes |
| `try_it` | run a **previously planned** command | see trial safety below |
| `tear_down` | remove **only OSM-created** resources for that `trial_uid` | see below |
| `preview_update` | **[R2] read-only.** Changelog since local version + preconditions check | never mutates |
| `update` | apply it | see update safety below |
| `register_mcp` | add server to chosen agents | official CLIs; dry-run first |
| `unregister_mcp` | **[R2] new.** Remove the server from chosen agents | registration needs an inverse — see below |
| `retire` | verdict → retired, reason **required** | rows never deleted; **[R2]** prompts to unregister if `serving_count>0` |

Favorite/tag toggles are web-only PATCHes; `search` accepts them as filters.

### [R2] Trial safety — repo instructions are untrusted input
A README/compose file is attacker-controlled content. v1 would have run whatever it parsed.
- `plan_trial` always runs first and its output is **displayed before anything executes**
- **Allowlist** of Docker flags: `-d --name --label -p -v -e --shm-size --memory`. Anything else (`--privileged`, `--network=host`, `--cap-add`, `-v /var/run/docker.sock`, `--pid=host`) is **refused**, with the refusal shown
- `execFile` with an argv array — **never** a shell string
- Bind mounts refused; named volumes only
- First trial of any source requires explicit confirmation
- Every resource labeled `osm.trial=<trial_uid>`
- **[R2] Port binding:** never probe-then-bind (racy — another process can claim the port between check and `docker run`) and never bare `-p HOST:CONTAINER` (publishes on **all interfaces**, exposing the trial to the LAN). Use `-p 127.0.0.1::<containerPort>` — Docker allocates atomically on loopback — then read the assigned port back via `docker inspect`

### [R2] Teardown ownership
Record at creation whether OSM pulled the image and which volumes it made. Teardown removes container always; image **only if** `image_created_by_osm=1`; volumes **only** those in `volumes_created_by_osm`. A shared base image is never deleted. Anything skipped is reported.

### [R2] Update safety
`git pull` is not a generic update. `preview_update` checks preconditions: clean worktree · not detached HEAD · tracking branch exists · fast-forwardable · not a linked worktree. Any fail → show the reason, offer "open in IDE", **do not mutate**. v1 supports fast-forward-only pulls. Global CLI updates (`npm -g`, `winget`) ship in the last phase.

### [R2] Local HTTP hardening
Bind `127.0.0.1` explicitly (not `0.0.0.0`) · reject unexpected `Host`/`Origin` (DNS-rebinding + CSRF) · mutating routes require `content-type: application/json` and a random per-run token · destructive actions confirmation-gated in the UI.

## Registrar — official CLIs, not config surgery [R2]

| Target | Mechanism | Phase |
|---|---|---|
| Claude Code | `claude mcp add-json <name> '<json>' --scope user` ✅ verified | 4 |
| Codex | `codex mcp add …` ✅ verified — **no TOML editing** | 4 |
| Docker Toolkit | probe `docker mcp catalog/client/gateway --help`; design to real surface | 4, after probe |
| Kimi / Zed / VS Code | detect config; absent → greyed "not detected" | 5, individually |

**[R2] Registration must be reversible.** v1 had no inverse: retiring a tool left its entry in every agent config, so the next refresh still derived `serving`, and the mockup's own "Unregister all" action was unimplementable. Treat registration as desired-state reconciliation — `register_mcp` and `unregister_mcp` both exist, retire offers to unregister, and `serving_count` is always read back from the agents rather than assumed.

Rules: per-repo always, no "apply to all" · dry-run diff before every write · back up any file OSM edits directly to `~/.osource/backups/<ts>-<file>` · verify by reading state back through the CLI (`claude mcp list`, `codex mcp get`), not by trusting exit code · **self-registration** in `osm setup` uses this same path — dogfoods the riskiest feature on day one.

## Web UI (port `ui-mockup.html`, vanilla TS)

Funnel strip (real counts; Retired starts at 0) · filter pills (All / ★ / tags / no-evidence-of-use / has-update) · add bar (Track / Try in Docker / Clone+install) · table with fav star, tags, links (repo / README / copy path / open in IDE), state chips, versions, Actions ▾ · detail tabs **Details / Readme / Changelog / Run / Log / Comments** (Comments = input + interleaved user/event stream, count badge) · Ctrl+K palette (shelf + live catalogs + `>` actions) · Browse tab · Settings (scan dirs, skills dirs, clone path, port, auto-update default, register targets, catalogs) · refresh stamp to the second.

**[R2]** State chips render from `verdict` + observations together — e.g. `kept · serving ×2 · update`, not one flattened word.

## [R2] Phased build — each phase independently useful and verified

**Phase 1 — trustworthy inventory (the actual product).** db · settings · discovery + canonical reconciliation + IMPORTED.md parser · comments · search · web UI + API. Ships: every tool on the machine, in one place, with a journal. No mutation anywhere.

**Phase 2 — read-only intelligence.** `github.ts` atom + ETag · `preview_update` · `plan_trial`. Ships: what changed upstream, and what *would* run — still zero mutation.

**Phase 3 — guarded execution.** `try_it` / `tear_down` with the allowlist + ownership tracking · fast-forward-only `update`. First mutating phase.

**Phase 4 — MCP + registrar core.** 8 tools over `ops.ts` · Claude Code + Codex via their CLIs · Docker Toolkit after probing. Self-registration last.

**Phase 5 — the long tail.** Kimi/Zed/VS Code adapters, one at a time · global package-manager mutation.

This ordering matches Joseph's priorities (storing → tracking → running → updating) with the correction that **inventory must be trustworthy before "try it" means anything.**

## [R2] Verification — failure paths, not happy paths

v1 tested only that things work. Both reviews flagged this: `docker volume ls` looking clean is a **global observation**, not proof that an unrelated volume survived. Snapshot before/after and filter by the trial label.

**Phase 1 — inventory**
- `node --test`: ops round-trip on temp DB · IMPORTED.md fixture → expected rows **including the deleted-but-tracked CL4R1T4S case** · reconciliation fixture: same repo as SSH remote + HTTPS remote + symlinked skill → **exactly one row** · **repeat-refresh idempotency**: run scan 3×, row count and owned fields unchanged · **concurrent writers**: web + MCP process writing simultaneously, no `SQLITE_BUSY`, no orphaned state-without-event
- Real `osm refresh` → count matches a hand `ls`; a tool deleted from disk flips `present=0` and keeps its row + comments
- UI screenshot via playwright MCP

**Phase 2 — read-only intelligence**
- `preview_update` on: clean repo · dirty worktree · detached HEAD · diverged branch · linked worktree → correct verdict each, and `git status` byte-identical after every one
- `plan_trial` on a compose declaring `--privileged` / `-v /var/run/docker.sock` / `--network=host` → refusal shown with the offending flag named
- A repo whose installed tag predates the first API page → renders **"history incomplete"**, not a partial changelog

**Phase 3 — guarded execution**
- Snapshot `docker images` + `docker volume ls` **before**; `try_it` on `alpine`; verify container carries `osm.trial=<uid>`, published port is on `127.0.0.1` only (`docker port` shows the loopback bind), and no non-allowlisted flag reached the argv
- **Shared-resource test:** pre-pull an image and pre-create a named volume, run a trial that reuses both, tear down → **both still exist**; diff against the before-snapshot shows only OSM-created resources gone
- Fast-forward-only update on a clean repo succeeds; on a diverged one refuses without touching the checkout

**Phase 4 — MCP + registrar**
- Each adapter tested inside an **isolated temporary HOME**, never the real one
- Dry-run diff correct → live write on the copy → **read state back through the CLI** (`claude.cmd mcp list`, `codex.cmd mcp get`), not exit code
- **Failed-rollback test:** corrupt the target mid-write, confirm the backup restores cleanly
- `register_mcp` → `unregister_mcp` round-trip leaves the config byte-identical to its starting state
- Windows: confirm `.cmd` resolution works and bare-name spawn is not relied on anywhere
- Real self-registration into Claude Code with Joseph watching — config write is a gated action

**Phase 5** — each remaining adapter, same bar, one at a time.

## Open at build time

- `docker mcp profile server add/remove` + `catalog server ls` exact argument shapes
- `~/.kimi/` config shape
- Whether `node:sqlite` RC has a gap that triggers the `better-sqlite3` fallback
- GitHub unauth 60/hr ceiling during heavy Browse — optional `GITHUB_TOKEN` env respected, never stored
