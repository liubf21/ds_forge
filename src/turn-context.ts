/**
 * Per-turn contextual user prefix — Codex-style standing memory injection.
 *
 * First user turn: optional AGENTS.md instructions + environment_context.
 * Later turns: environment_context diff only when cwd/shell/date/timezone change.
 * AGENTS.md stays session-scoped (not re-read on cwd change; matches Codex today).
 */

import {
  type EnvironmentSnapshot,
  captureEnvironment,
  environmentSnapshotEqual,
  parseEnvironmentSnapshot,
  renderEnvironmentContext,
} from "./environment-context.js";
import {
  type AgentsMdOptions,
  agentsMdUserInstructions,
} from "./agents-md.js";
import type { MessageDict } from "./types.js";

export const AGENTS_MD_INSTRUCTIONS_MARKER = "# AGENTS.md instructions";

export interface TurnContextOptions {
  cwd?: string;
  /** Inject `<environment_context>` on turn 1 and when it changes. Default: true. */
  includeEnvironment?: boolean;
  /** Load AGENTS.md into the first-turn contextual prefix. Default: false. */
  agentsMd?: boolean | AgentsMdOptions;
}
/** Snapshot of standing-prefix state, for rolling back an aborted turn. */
export interface TurnContextState {
  baseline: EnvironmentSnapshot | null;
  agentsPrefixSent: boolean;
}

export class TurnContext {
  private readonly defaultCwd: string;
  private readonly includeEnvironment: boolean;
  private readonly agentsMdOpts: AgentsMdOptions | null;
  private baseline: EnvironmentSnapshot | null = null;
  private agentsPrefixSent = false;

  constructor(opts: TurnContextOptions = {}) {
    this.defaultCwd = opts.cwd ?? process.cwd();
    this.includeEnvironment = opts.includeEnvironment !== false;
    this.agentsMdOpts = opts.agentsMd
      ? (typeof opts.agentsMd === "object"
        ? opts.agentsMd
        : { includeProject: true, cwd: opts.cwd })
      : null;
  }

  /** Restore baseline from an resumed trajectory so prefixes are not duplicated. */
  restoreFromMessages(messages: MessageDict[]): void {
    let lastEnv: EnvironmentSnapshot | null = null;
    let sawAgents = false;
    for (const msg of messages) {
      if (msg.role !== "user" || !msg.content) continue;
      if (msg.content.includes(AGENTS_MD_INSTRUCTIONS_MARKER)) {
        sawAgents = true;
      }
      const parsed = parseEnvironmentSnapshot(msg.content);
      if (parsed) lastEnv = parsed;
    }
    if (lastEnv) this.baseline = lastEnv;
    if (sawAgents) this.agentsPrefixSent = true;
  }

  reset(): void {
    this.baseline = null;
    this.agentsPrefixSent = false;
  }

  /** Snapshot standing-prefix state so an aborted turn can be rolled back. */
  snapshot(): TurnContextState {
    return { baseline: this.baseline, agentsPrefixSent: this.agentsPrefixSent };
  }

  /**
   * Restore standing-prefix state. Use together with a context rollback
   * (`forge.context.restore(snapshot)`) after an aborted turn so the next turn
   * re-sends the first-turn prefix (AGENTS.md + environment) instead of
   * silently skipping it.
   */
  restore(state: TurnContextState): void {
    this.baseline = state.baseline;
    this.agentsPrefixSent = state.agentsPrefixSent;
  }

  /**
   * User messages to insert before the real user turn (may be empty).
   * Updates internal baseline after computing the prefix.
   */
  prefixForTurn(cwd?: string): string[] {
    const resolved = cwd ?? this.defaultCwd;
    const snapshot = captureEnvironment(resolved);
    const agents = !this.agentsPrefixSent && this.agentsMdOpts
      ? agentsMdUserInstructions({ cwd: resolved, ...this.agentsMdOpts })
      : "";

    const firstTurn = !this.baseline;
    const envChanged =
      this.includeEnvironment
      && (firstTurn || !environmentSnapshotEqual(this.baseline!, snapshot));

    // No baseline yet (fresh session), or a baseline restored from a trajectory
    // that never carried AGENTS.md: still emit the pending AGENTS.md block even
    // when the environment is unchanged.
    if (!agents && !envChanged) return [];

    this.baseline = snapshot;
    if (agents) this.agentsPrefixSent = true;

    const parts: string[] = [];
    if (agents) parts.push(agents);
    if (envChanged) parts.push(renderEnvironmentContext(snapshot));
    return parts.length > 0 ? [parts.join("\n\n")] : [];
  }
}
