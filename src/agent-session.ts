import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { BUILTIN_TOOL_NAMES, builtinTools } from "./builtin-tools.js";
import { DEFAULT_MAX_TURNS } from "./defaults.js";
import { Forge } from "./forge.js";
import { codingAgentSystem, AGENTS_MD_SCOPE_NOTE } from "./system.js";
import { TurnContext } from "./turn-context.js";
import type { AgentsMdOptions } from "./agents-md.js";
import type { BashOptions } from "./bash.js";
import type { SkillRegistry } from "./skills.js";
import type { TurnContextState } from "./turn-context.js";
import type { ReasoningEffort, StreamEvent, Tool } from "./types.js";

export const TRAJECTORY_DIR = resolve(process.env.DS_FORGE_DIR ?? "./trajectories");

export { codingAgentSystem, AGENTS_MD_SCOPE_NOTE } from "./system.js";

export function createTrajectoryPath(): string {
  mkdirSync(TRAJECTORY_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = randomBytes(4).toString("hex");
  return join(TRAJECTORY_DIR, `task-${ts}-${suffix}.json`);
}

export function trajectoryLabel(path: string): string {
  return basename(path);
}

/**
 * The default tool set for a coding session: bash plus the dedicated file
 * tools (read/write/edit). Centralized here so `open` and `fork` stay in sync
 * and the TUI gets file tools without each call site re-listing them.
 */
export function defaultTools(cwd?: string, bashOpts?: BashOptions): Tool[] {
  return builtinTools(BUILTIN_TOOL_NAMES, { cwd, bash: bashOpts });
}

export interface OpenAgentSessionOptions {
  cwd?: string;
  resume?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  system?: string;
  tools?: Tool[];
  bash?: BashOptions;
  apiKey?: string;
  /** Reusable skills to expose through the `skill` tool. */
  skills?: SkillRegistry | string[];
  /**
   * Load AGENTS.md into the first-turn contextual prefix. `true` = project scope
   * from cwd; omitted/`false` = off; pass options to customize scopes.
   */
  agentsMd?: boolean | AgentsMdOptions;
  /**
   * Inject `<environment_context>` on turn 1 and when cwd/shell/date/timezone
   * change. Default: true.
   */
  environmentContext?: boolean;
}

function composeSystem(
  base: string,
  agentsMd?: boolean | AgentsMdOptions,
): string {
  if (!agentsMd) return base;
  if (base.includes("# AGENTS.md scope")) return base;
  return `${base}\n\n${AGENTS_MD_SCOPE_NOTE}`;
}

/**
 * Session system prompt: override ?? trajectory system ?? default, with the
 * AGENTS.md scope note composed in when agentsMd is enabled. Always matches
 * what `clear()` restores and what the context carries.
 */
function resolveSystem(
  forge: Forge,
  agentsMd?: boolean | AgentsMdOptions,
  override?: string,
): string {
  const msg = forge.context.messages.find((m) => m.role === "system");
  const base = override ?? msg?.content ?? codingAgentSystem();
  return composeSystem(base, agentsMd);
}

function makeTurnContext(
  cwd: string,
  opts: Pick<OpenAgentSessionOptions, "agentsMd" | "environmentContext">,
): TurnContext {
  return new TurnContext({
    cwd,
    includeEnvironment: opts.environmentContext !== false,
    agentsMd: opts.agentsMd,
  });
}

/** Headless coding-agent session: Forge + trajectory path + save. */
export class AgentSession {
  readonly forge: Forge;
  readonly cwd: string;
  private _trajPath: string;
  private readonly _system: string;
  private readonly _turnContext: TurnContext;

  constructor(
    forge: Forge,
    trajPath: string,
    cwd: string,
    system: string,
    turnContext: TurnContext,
  ) {
    this.forge = forge;
    this._trajPath = trajPath;
    this.cwd = cwd;
    this._system = system;
    this._turnContext = turnContext;
  }

  get system(): string {
    return this._system;
  }

  get trajPath(): string {
    return this._trajPath;
  }

  save(): void {
    this.forge.save(this._trajPath);
  }

  /** Clear context, restore session system prompt, new trajectory file. Returns the new path. */
  clear(): string {
    this.forge.context.clear();
    this.forge.context.addSystem(this._system);
    this.forge.resetTrajectoryState();
    this._turnContext.reset();
    this._trajPath = createTrajectoryPath();
    return this._trajPath;
  }

  /**
   * Snapshot standing-prefix state. Pair with `restoreTurnContext` + a context
   * rollback when aborting a turn, so the next turn re-sends AGENTS.md /
   * environment instead of silently skipping them.
   */
  snapshotTurnContext(): TurnContextState {
    return this._turnContext.snapshot();
  }

  /** Restore standing-prefix state captured by `snapshotTurnContext`. */
  restoreTurnContext(state: TurnContextState): void {
    this._turnContext.restore(state);
  }

  /**
   * Inject standing contextual prefix (AGENTS.md + environment) then the user
   * message. Call before model steps when not using `run` / `runStream`.
   */
  prepareUserTurn(userText: string, cwd?: string): void {
    for (const prefix of this._turnContext.prefixForTurn(cwd ?? this.cwd)) {
      this.forge.context.addUser(prefix);
    }
    this.forge.context.addUser(userText);
  }

  async run(
    message?: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    if (message) this.prepareUserTurn(message);
    return this.forge.run(undefined, maxTurns, extra);
  }

  async *runStream(
    message: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
    extra?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    this.prepareUserTurn(message);
    yield* this.forge.runStream(undefined, maxTurns, extra, signal);
  }

  static open(opts: OpenAgentSessionOptions = {}): AgentSession {
    const cwd = opts.cwd ?? process.cwd();
    const tools = opts.tools ?? defaultTools(cwd, opts.bash);
    const turnContext = makeTurnContext(cwd, opts);

    if (opts.resume) {
      const trajPath = resolve(opts.resume);
      const forge = Forge.load(trajPath, {
        tools,
        apiKey: opts.apiKey,
        reasoningEffort: opts.reasoningEffort,
        skills: opts.skills,
      });
      turnContext.restoreFromMessages(forge.context.toList());
      const system = resolveSystem(forge, opts.agentsMd, opts.system);
      // Keep the context system in sync with `session.system` (scope note
      // included); for system-less trajectories this injects the default.
      forge.context.addSystem(system);
      return new AgentSession(forge, trajPath, cwd, system, turnContext);
    }

    const base = opts.system ?? codingAgentSystem();
    const system = composeSystem(base, opts.agentsMd);
    const trajPath = createTrajectoryPath();
    const forge = new Forge({
      apiKey: opts.apiKey,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      system,
      tools,
      skills: opts.skills,
    });
    return new AgentSession(forge, trajPath, cwd, system, turnContext);
  }

  /**
   * Fork a saved trajectory: load its messages and model, but persist
   * continuations to a new file (does not overwrite `from`).
   */
  static fork(from: string, opts: OpenAgentSessionOptions = {}): AgentSession {
    const cwd = opts.cwd ?? process.cwd();
    const tools = opts.tools ?? defaultTools(cwd, opts.bash);
    const turnContext = makeTurnContext(cwd, opts);
    const sourcePath = resolve(from);
    const forge = Forge.load(sourcePath, {
      tools,
      apiKey: opts.apiKey,
      reasoningEffort: opts.reasoningEffort,
      skills: opts.skills,
    });
    turnContext.restoreFromMessages(forge.context.toList());
    const system = resolveSystem(forge, opts.agentsMd, opts.system);
    forge.context.addSystem(system);
    return new AgentSession(forge, createTrajectoryPath(), cwd, system, turnContext);
  }
}
