export type ToolKind = 'repo' | 'global-cli' | 'skill' | 'binary';
export type Verdict = 'wanted' | 'trying' | 'kept' | 'retired';

export interface Tool {
  id: number;
  canonical_key: string;
  name: string;
  kind: ToolKind;
  verdict: Verdict;
  why_i_want_it: string | null;
  retire_reason: string | null;
  favorite: number;
  auto_update: number;
  source: string | null;
  added_at: string;
  updated_at: string;
}

export interface Alias {
  tool_id: number;
  alias: string;
}

export interface Installation {
  id: number;
  tool_id: number;
  /** Disk path, or one of 'npm-g' | 'winget' | 'skills-dir'. */
  where_: string;
  version_local: string | null;
  present: number;
  last_seen_at: string;
}

export interface Observations {
  tool_id: number;
  serving_count: number;
  trial_running: number;
  version_upstream: string | null;
  update_available: number;
  upstream_checked_at: string | null;
  feed_etag: string | null;
}

export interface Tag {
  tool_id: number;
  tag: string;
  /** 1 = machine-detected, 0 = user-added. */
  detected: number;
}

export interface Comment {
  id: number;
  tool_id: number;
  kind: 'user' | 'event';
  body: string;
  created_at: string;
}

export interface Trial {
  id: number;
  trial_uid: string;
  tool_id: number;
  container: string | null;
  image: string | null;
  ports: string | null;
  image_created_by_osm: number;
  /** JSON array of volume names created by osm for this trial. */
  volumes_created_by_osm: string;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
}

/**
 * One MCP server registration OSM actually performed.
 *
 * This is the ownership record. OSM's entries are NOT identifiable by their
 * name — a tool is registered under its own name ('trello', not 'osm-trello'),
 * which is the whole point — so what OSM may later remove is remembered here
 * instead of being encoded in the name.
 */
export interface McpRegistration {
  tool_id: number;
  /** TargetId of the agent written to ('claude' | 'codex' | …). */
  target: string;
  server_name: string;
  registered_at: string;
}

export interface Settings {
  scanDirs: string[];
  skillsDirs: string[];
  clonePath: string;
  port: number;
  autoUpdateDefault: boolean;
  registerTargets: {
    claude: boolean;
    codex: boolean;
    docker: boolean;
    kimi: boolean;
    zed: boolean;
    vscode: boolean;
  };
  catalogs: {
    docker: boolean;
    anthropic: boolean;
    github: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  scanDirs: ['D:\\dev\\tools', 'D:\\dev\\personal'],
  skillsDirs: ['D:\\dev\\personal\\claude-code\\skills'],
  clonePath: 'D:\\dev\\tools',
  port: 7807,
  autoUpdateDefault: false,
  registerTargets: {
    claude: true,
    codex: true,
    docker: true,
    kimi: false,
    zed: false,
    vscode: false,
  },
  catalogs: {
    docker: true,
    anthropic: true,
    github: true,
  },
};

export interface OpResult<T = unknown> {
  ok: boolean;
  message: string;
  data?: T;
}

/** Composed per-tool view for API responses. */
export type ToolView = Tool & {
  aliases: string[];
  installations: Installation[];
  observations: Observations | null;
  tags: Tag[];
};
