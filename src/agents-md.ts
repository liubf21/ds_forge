/**
 * AGENTS.md support — the cross-vendor standard (OpenAI → Agentic AI Foundation
 * / Linux Foundation) for project-specific agent instructions.
 *
 * Unlike skills (on-demand capability packs loaded via a tool), AGENTS.md is
 * persistent project memory: discovered from disk and injected into the first
 * turn's contextual user prefix. It is plain markdown with no required schema.
 *
 * Discovery follows ds-forge's agent guidance behaviour:
 *  - Per directory, `AGENTS.override.md` wins over `AGENTS.md` (first non-empty).
 *  - Project scope walks the git root → cwd chain (cwd only if no git root).
 *  - Optional global scope: `~/.agents` — opt-in, since reading user-global
 *    guidance unasked is overreach.
 *  - Files are ordered general → specific (nearest last = highest precedence)
 *    and the combined section is capped at 32 KiB by default.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

export const AGENTS_MD = "AGENTS.md";
export const AGENTS_MD_OVERRIDE = "AGENTS.override.md";
export const GLOBAL_AGENTS_DIR = ".agents";
/** Per-directory lookup order: override beats the base file. */
const DOC_NAMES = [AGENTS_MD_OVERRIDE, AGENTS_MD];
/** Codex's `project_doc_max_bytes` default. */
export const DEFAULT_AGENTS_MD_MAX_BYTES = 32 * 1024;

export interface AgentsMdDoc {
  /** Absolute path to the file (AGENTS.override.md or AGENTS.md). */
  path: string;
  /** Directory containing it. */
  dir: string;
  /** Raw file contents (trimmed). */
  content: string;
}

export interface AgentsMdOptions {
  /** Project directory to discover from. Default: process.cwd(). */
  cwd?: string;
  /** Load project AGENTS.md files from git root to cwd. Default: false. */
  includeProject?: boolean;
  /**
   * Also load one global AGENTS.md from ~/.agents.
   * Default: false — reading user-global guidance unasked is overreach.
   */
  global?: boolean;
  /** Cap for the combined section, in bytes. Default: 32 KiB. */
  maxBytes?: number;
}

function readFile(path: string): AgentsMdDoc | null {
  try {
    if (!statSync(path).isFile()) return null;
    const content = readFileSync(path, "utf-8").trim();
    if (!content) return null;
    return { path, dir: dirname(path), content };
  } catch {
    return null;
  }
}

/** First non-empty `AGENTS.override.md` / `AGENTS.md` in a directory. */
function readDirDoc(dir: string): AgentsMdDoc | null {
  for (const name of DOC_NAMES) {
    const d = readFile(join(dir, name));
    if (d) return d;
  }
  return null;
}

function globalAgentsDir(): string {
  return process.env.DS_FORGE_AGENTS_HOME
    ? resolve(process.env.DS_FORGE_AGENTS_HOME)
    : join(homedir(), GLOBAL_AGENTS_DIR);
}

/** Ancestor dirs from `start` up to the filesystem root (inclusive), nearest first. */
function ancestors(start: string): string[] {
  const out: string[] = [];
  let dir = resolve(start);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/**
 * Discover AGENTS.md files for `cwd`. Walks up to the git root (nearest
 * ancestor containing `.git`); if none is found, only `cwd` is considered so we
 * never wander into unrelated parent directories. Returns docs ordered
 * general → specific (optional global first, then repo root … cwd).
 */
export function findAgentsMd(opts: AgentsMdOptions = {}): AgentsMdDoc[] {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const chain = ancestors(cwd); // nearest first
  const gitRootIdx = chain.findIndex((d) => existsSync(join(d, ".git")));
  const boundaryIdx = gitRootIdx === -1 ? 0 : gitRootIdx;
  const projectDirs = chain.slice(0, boundaryIdx + 1).reverse(); // general → specific

  const docs: AgentsMdDoc[] = [];
  const seen = new Set<string>();

  if (opts.global) {
    const d = readDirDoc(globalAgentsDir());
    if (d) {
      seen.add(d.path);
      docs.push(d);
    }
  }

  if (opts.includeProject === true) {
    for (const dir of projectDirs) {
      const d = readDirDoc(dir);
      if (d && !seen.has(d.path)) {
        seen.add(d.path);
        docs.push(d);
      }
    }
  }
  return docs;
}

/** Largest UTF-8 prefix of `s` within `maxBytes`, not splitting a codepoint. */
function truncateBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf-8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // back off mid-codepoint
  return { text: buf.subarray(0, end).toString("utf-8"), truncated: true };
}

function formatAgentsDocBlocks(docs: AgentsMdDoc[], cwd?: string): string {
  const base = resolve(cwd ?? process.cwd());
  return docs
    .map((d) => {
      const rel = relative(base, d.path);
      const label = !rel || rel.startsWith("..") ? d.path : rel;
      return `<!-- ${label} -->\n${d.content}`;
    })
    .join("\n\n");
}

/**
 * Format discovered docs as a system-prompt section (empty string if none).
 * Prefer `agentsMdUserInstructions` for new integrations — Codex injects via
 * contextual user messages, not system.
 */
export function agentsMdSection(
  docs: AgentsMdDoc[],
  cwd?: string,
  maxBytes: number = DEFAULT_AGENTS_MD_MAX_BYTES,
): string {
  if (docs.length === 0) return "";
  const header = `## Project instructions (AGENTS.md)

Project-specific guidance loaded from AGENTS.md. Follow it unless the user's request overrides it. More specific (nearer) instructions appear later and take precedence.

`;
  const { text, truncated } = truncateBytes(
    header + formatAgentsDocBlocks(docs, cwd),
    maxBytes,
  );
  return truncated ? `${text}\n\n<!-- [truncated at ${maxBytes} bytes] -->` : text;
}

/**
 * Codex-style contextual user block for AGENTS.md (session-scoped, first turn).
 * Returns "" when no docs are found or no scope is enabled.
 */
export function agentsMdUserInstructions(opts: AgentsMdOptions = {}): string {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const docs = findAgentsMd(opts);
  if (docs.length === 0) return "";
  const maxBytes = opts.maxBytes ?? DEFAULT_AGENTS_MD_MAX_BYTES;
  const { text, truncated } = truncateBytes(
    formatAgentsDocBlocks(docs, cwd),
    maxBytes,
  );
  const body = truncated ? `${text}\n\n<!-- [truncated at ${maxBytes} bytes] -->` : text;
  return `# AGENTS.md instructions for ${cwd}

<INSTRUCTIONS>
${body}
</INSTRUCTIONS>`;
}

/** Discover + format as a legacy system section. Returns "" when none found. */
export function loadAgentsMd(opts: AgentsMdOptions = {}): string {
  return agentsMdSection(findAgentsMd(opts), opts.cwd, opts.maxBytes);
}
