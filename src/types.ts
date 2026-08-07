/** Shared types for ds-forge. */

import type { AgentsMdOptions } from "./agents-md.js";
import type { SkillRegistry } from "./skills.js";
import type { TurnContext } from "./turn-context.js";

export interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  description?: string;
  nullable?: boolean;
  additionalProperties?: JsonSchema | boolean;
  [key: string]: unknown; // for OpenAI index-signature compatibility
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface MessageDict {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  /** DeepSeek V4 thinking mode — must round-trip when tool_calls present. */
  reasoning_content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface Tool extends ToolDef {
  execute: (args: Record<string, unknown>, signal?: AbortSignal) => unknown | Promise<unknown>;
}

export interface OpenAICompatibleToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
}

export type ReasoningEffort = "high" | "max" | "off";

export interface ForgeConfig {
  apiKey?: string;
  model?: string;
  system?: string;
  tools?: Tool[];
  maxTokens?: number;
  baseURL?: string;
  /** V4 thinking effort. Default: "high" with tools, "off" without. */
  reasoningEffort?: ReasoningEffort;
  /**
   * Reusable skills: a prebuilt registry or directories to discover. Registers
   * a `skill` tool and appends a catalog to the system prompt.
   */
  skills?: SkillRegistry | string[];
  /**
   * Load AGENTS.md into the first-turn contextual prefix. `true` uses project
   * scope. Default: off.
   */
  agentsMd?: boolean | AgentsMdOptions;
  /**
   * Inject `<environment_context>` on turn 1 and when cwd/shell/date/timezone
   * change. Default: off for bare `Forge`; `AgentSession` enables by default.
   */
  environmentContext?: boolean;
  /** Advanced: inject an existing TurnContext (e.g. shared with AgentSession). */
  turnContext?: TurnContext;
}

export interface ForgeLoadConfig {
  tools?: Tool[];
  apiKey?: string;
  baseURL?: string;
  /** Override V4 thinking effort on resume (not persisted in session JSON). */
  reasoningEffort?: ReasoningEffort;
  /** Re-provide skills on resume (callables/registry aren't persisted). */
  skills?: SkillRegistry | string[];
}

export interface ForgeDebugConfig {
  apiKey?: string;
  model?: string;
  tools?: Tool[];
  baseURL?: string;
}

export class ForgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeError";
  }
}

export type { UsageRecord } from "./usage.js";

/** Events emitted by `Forge.runStream()`. */
export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; name: string; result: string }
  | { type: "turn_done"; content: string }
  | { type: "error"; message: string };
