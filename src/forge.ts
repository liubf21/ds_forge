import OpenAI from "openai";
import { readFileSync } from "node:fs";
import { Context, messageFromDict, messagesForApi } from "./context.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  MAX_TURNS_REACHED,
  buildModelExtra,
  resolveReasoningEffort,
} from "./defaults.js";
import { Session } from "./session.js";
import { SkillRegistry, skillTool, skillsCatalog, toSkillRegistry } from "./skills.js";
import { TurnContext } from "./turn-context.js";
import { ToolRegistry } from "./tools.js";
import { parseUsage, parseUsageLog, type UsageRecord } from "./usage.js";
import type {
  ForgeConfig,
  ForgeLoadConfig,
  ForgeDebugConfig,
  MessageDict,
  ReasoningEffort,
  StreamEvent,
  Tool,
  ToolCall,
} from "./types.js";

type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionMessage & {
  reasoning_content?: string | null;
};

function mapToolCalls(
  raw: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
): ToolCall[] {
  return raw.map((tc) => ({
    id: tc.id,
    type: "function" as const,
    function: {
      name: tc.function.name,
      arguments: tc.function.arguments,
    },
  }));
}

export class Forge {
  readonly model: string;
  readonly client: OpenAI;
  readonly tools: ToolRegistry;
  readonly skills?: SkillRegistry;
  readonly reasoningEffort: ReasoningEffort;
  context: Context;
  /** Cumulative API usage per model call (persisted in trajectory `metadata.usage_log`). */
  readonly usageLog: UsageRecord[] = [];
  private _createdAt: string;
  private _maxTokens: number;

  constructor(config: ForgeConfig = {}) {
    const apiKey =
      config.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "API key required. Set DEEPSEEK_API_KEY env var or pass apiKey in config.",
      );
    }

    this.model = config.model ?? DEFAULT_MODEL;
    this._maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;

    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    });

    this.tools = new ToolRegistry();
    for (const t of config.tools ?? []) {
      this.tools.register(t);
    }

    // Skills: register the `skill` tool so the model can load packs on demand.
    if (config.skills) {
      const registry = toSkillRegistry(config.skills);
      if (registry.size > 0) {
        this.skills = registry;
        this.tools.register(skillTool(registry));
      }
    }

    this.reasoningEffort = resolveReasoningEffort(
      config.reasoningEffort,
      this.tools.size > 0,
    );

    this._createdAt = new Date().toISOString();
    this.context = new Context();
    this.context.maxTokens = this._maxTokens;

    const catalog = this.skills ? skillsCatalog(this.skills) : "";
    const system = [config.system, catalog].filter(Boolean).join("\n\n");
    if (system) {
      this.context.addSystem(system);
    }

    if (config.turnContext) {
      this._turnContext = config.turnContext;
    } else if (config.agentsMd || config.environmentContext) {
      this._turnContext = new TurnContext({
        agentsMd: config.agentsMd,
        includeEnvironment: config.environmentContext === true,
      });
    }
  }

  private readonly _turnContext?: TurnContext;

  private _injectTurnPrefix(cwd?: string): void {
    if (!this._turnContext) return;
    for (const prefix of this._turnContext.prefixForTurn(cwd)) {
      this.context.addUser(prefix);
    }
  }

  get createdAt(): string {
    return this._createdAt;
  }

  /** Reset usage + created_at when starting a fresh trajectory (e.g. TUI `/clear`). */
  resetTrajectoryState(): void {
    this.usageLog.length = 0;
    this._createdAt = new Date().toISOString();
  }

  private _recordUsage(
    usage: OpenAI.Completions.CompletionUsage | undefined,
  ): void {
    const rec = parseUsage(
      usage as unknown as Record<string, unknown> | undefined,
      this.usageLog.length,
    );
    if (rec) this.usageLog.push(rec);
  }

  private _modelExtra(userExtra?: Record<string, unknown>): Record<string, unknown> {
    return buildModelExtra(this.reasoningEffort, userExtra);
  }

  // ── model step (shared by chat / run) ────────────────────

  private async _callModel(extra?: Record<string, unknown>): Promise<{
    content: string | null;
    reasoningContent: string | null;
    toolCalls: ToolCall[] | null;
  }> {
    this.context.truncate();

    const toolSpecs = this.tools.toOpenAISpecs();
    const tools = toolSpecs.length > 0 ? toolSpecs : undefined;

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: messagesForApi(this.context.toList()) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools,
      ...this._modelExtra(extra),
    });

    this._recordUsage(response.usage);

    const msg = response.choices[0]!.message as AssistantMessage;
    const toolCalls = msg.tool_calls?.length
      ? mapToolCalls(msg.tool_calls)
      : null;

    return {
      content: msg.content,
      reasoningContent: msg.reasoning_content ?? null,
      toolCalls,
    };
  }

  /** One model turn: call API, record assistant message. */
  private async _step(extra?: Record<string, unknown>): Promise<ToolCall[] | null> {
    const { content, reasoningContent, toolCalls } = await this._callModel(extra);
    this.context.addAssistant(content, toolCalls ?? undefined, reasoningContent);
    return toolCalls;
  }

  private async _executeToolCalls(toolCalls: ToolCall[]): Promise<void> {
    for (const tc of toolCalls) {
      await this._executeOneToolCall(tc);
    }
  }

  private async _executeOneToolCall(tc: ToolCall, signal?: AbortSignal): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      const err = `Error parsing tool arguments: ${tc.function.arguments}`;
      this.context.addToolResult(tc.id, err, tc.function.name);
      return err;
    }

    const result = await this.tools.execute(tc.function.name, args, signal);
    this.context.addToolResult(tc.id, result, tc.function.name);
    return result;
  }

  // ── single turn ──────────────────────────────────────────

  async chat(message: string, extra?: Record<string, unknown>): Promise<string> {
    this._injectTurnPrefix();
    this.context.addUser(message);
    const toolCalls = await this._step(extra);
    return toolCalls
      ? JSON.stringify(toolCalls, null, 2)
      : (this.context.last()?.content ?? "");
  }

  // ── agent loop ───────────────────────────────────────────

  async run(
    message?: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    if (message) {
      this._injectTurnPrefix();
      this.context.addUser(message);
    }

    for (let turn = 0; turn < maxTurns; turn++) {
      const toolCalls = await this._step(extra);
      if (!toolCalls) {
        return this.context.last()?.content ?? "";
      }
      await this._executeToolCalls(toolCalls);
    }

    return MAX_TURNS_REACHED;
  }

  async resume(
    message?: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
    extra?: Record<string, unknown>,
  ): Promise<string> {
    return this.run(message, maxTurns, extra);
  }

  // ── streaming agent loop ─────────────────────────────────

  private async *_callModelStream(
    extra?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<
    StreamEvent,
    { content: string | null; reasoningContent: string | null; toolCalls: ToolCall[] | null }
  > {
    this.context.truncate();

    const toolSpecs = this.tools.toOpenAISpecs();
    const tools = toolSpecs.length > 0 ? toolSpecs : undefined;

    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: messagesForApi(this.context.toList()) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
        tools,
        ...this._modelExtra(extra),
        stream: true,
        stream_options: { include_usage: true },
      },
      signal ? { signal } : undefined,
    );

    let content = "";
    let reasoningContent = "";
    let streamUsage: OpenAI.Completions.CompletionUsage | undefined;
    const acc = new Map<number, { id: string; name: string; arguments: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) streamUsage = chunk.usage;
      const delta = chunk.choices[0]?.delta as
        | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
            reasoning_content?: string | null;
          })
        | undefined;
      if (!delta) continue;

      const rc = delta.reasoning_content;
      if (rc) reasoningContent += rc;

      if (delta.content) {
        content += delta.content;
        yield { type: "text_delta", delta: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let entry = acc.get(idx);
          if (!entry) {
            entry = { id: "", name: "", arguments: "" };
            acc.set(idx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.arguments += tc.function.arguments;
        }
      }
    }

    const toolCalls =
      acc.size > 0
        ? [...acc.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, v]) => ({
              id: v.id,
              type: "function" as const,
              function: { name: v.name, arguments: v.arguments },
            }))
        : null;

    this._recordUsage(streamUsage);

    return {
      content: content || null,
      reasoningContent: reasoningContent || null,
      toolCalls,
    };
  }

  private async *_stepStream(
    extra?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent, ToolCall[] | null> {
    const gen = this._callModelStream(extra, signal);
    let next = await gen.next();
    while (!next.done) {
      yield next.value;
      next = await gen.next();
    }

    const { content, reasoningContent, toolCalls } = next.value;
    this.context.addAssistant(content, toolCalls ?? undefined, reasoningContent);
    return toolCalls;
  }

  async *runStream(
    message?: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
    extra?: Record<string, unknown>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    if (message) {
      this._injectTurnPrefix();
      this.context.addUser(message);
    }

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        if (signal?.aborted) break;

        const stepGen = this._stepStream(extra, signal);
        let next = await stepGen.next();
        while (!next.done) {
          yield next.value;
          next = await stepGen.next();
        }

        if (signal?.aborted) break;

        const toolCalls = next.value;
        if (!toolCalls) {
          yield { type: "turn_done", content: this.context.last()?.content ?? "" };
          return;
        }

        for (const tc of toolCalls) {
          if (signal?.aborted) break;
          yield {
            type: "tool_call_start",
            id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          };
          const result = await this._executeOneToolCall(tc, signal);
          yield {
            type: "tool_result",
            id: tc.id,
            name: tc.function.name,
            result,
          };
        }
      }

      if (!signal?.aborted) {
        yield { type: "turn_done", content: MAX_TURNS_REACHED };
      }
    } catch (e) {
      if (signal?.aborted) return;
      yield {
        type: "error",
        message: e instanceof Error ? e.message : String(e),
      };
    }
  }

  // ── persistence ──────────────────────────────────────────

  save(path: string): void {
    Session.fromForge(this).save(path);
  }

  static load(path: string, config: ForgeLoadConfig = {}): Forge {
    const session = Session.load(path);

    const forge = new Forge({
      apiKey: config.apiKey,
      model: session.model,
      tools: config.tools ?? [],
      baseURL: config.baseURL,
      reasoningEffort: config.reasoningEffort,
      skills: config.skills,
    });
    forge.context = Context.fromDicts(session.messages);
    forge._createdAt =
      typeof session.metadata.created_at === "string"
        ? session.metadata.created_at
        : new Date().toISOString();
    forge.usageLog.push(...parseUsageLog(session.metadata.usage_log));

    if (config.tools && config.tools.length > 0) {
      session.validateTools(forge.tools);
    }

    return forge;
  }

  // ── debug ────────────────────────────────────────────────

  static async debug(
    path: string,
    config: ForgeDebugConfig = {},
  ): Promise<{
    role: string;
    content: string | null;
    tool_calls: ToolCall[] | null;
  }> {
    const apiKey =
      config.apiKey || process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error("API key required.");
    }

    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);

    let messages: MessageDict[];
    if (Array.isArray(data)) {
      messages = data;
    } else if (data && Array.isArray(data.messages)) {
      messages = data.messages;
    } else {
      throw new Error(
        `Expected a message list or session dict, got ${typeof data}`,
      );
    }

    const client = new OpenAI({
      apiKey,
      baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    });

    const registry =
      config.tools && config.tools.length > 0 ? new ToolRegistry() : null;
    if (registry) {
      for (const t of config.tools!) registry.register(t);
    }
    const toolSpecs = registry?.toOpenAISpecs();

    const response = await client.chat.completions.create({
      model: config.model ?? DEFAULT_MODEL,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: toolSpecs,
      ...buildModelExtra(
        resolveReasoningEffort(undefined, (toolSpecs?.length ?? 0) > 0),
      ),
    });

    const rawMsg = response.choices[0]!.message;
    return {
      role: rawMsg.role,
      content: rawMsg.content,
      tool_calls: rawMsg.tool_calls?.length
        ? mapToolCalls(rawMsg.tool_calls)
        : null,
    };
  }
}
