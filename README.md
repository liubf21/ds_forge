# ds-forge

[中文文档](docs/README.zh-CN.md)

Lightweight agent harness for DeepSeek V4. Thin wrapper around the OpenAI-compatible API with context management, tool calling, and session persistence.

## Install

```bash
npm install
cp .env.example .env   # add your key
```

`npm run demo` / `demo:mcp` load `.env` automatically (`tsx --env-file-if-exists`). To run examples directly: `npx tsx --env-file=.env examples/...`

## Quick start

```typescript
import { Forge, tool } from "ds-forge";

const getWeather = tool({
  name: "get_weather",
  description: "Get current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string", description: "City name" },
    },
    required: ["city"],
  },
  execute: async (args) => `Weather in ${args.city}: 22°C, sunny`,
});

const forge = new Forge({
  system: "You are a helpful assistant.",
  tools: [getWeather],
});

await forge.run("What's the weather in Paris?");
```

## API

### `Forge`

Main harness — wires together the API client, context, and tools.

```typescript
const forge = new Forge({
  apiKey?: string;       // default: process.env.DEEPSEEK_API_KEY
  model?: string;        // default: "deepseek-v4-flash"
  reasoningEffort?: "high" | "max" | "off";  // default: "high" with tools, "off" without
  system?: string;       // system prompt
  tools?: Tool[];        // registered tools
  maxTokens?: number;    // default: 900_000; crossing it truncates to 600_000
  baseURL?: string;      // default: "https://api.deepseek.com/v1"
});
```

DeepSeek's official examples use `https://api.deepseek.com` as `base_url`. The current default keeps the OpenAI-style `/v1` path for SDK compatibility; override `baseURL` if your gateway expects the official root URL.

**Methods:**

| Method | Description |
|---|---|
| `chat(message, extra?)` | Single turn. Returns text, tool calls rendered as JSON. |
| `run(message?, maxTurns?, extra?)` | Agent loop. Auto-executes tools, feeds results back. Stops when the model is done or `maxTurns` (default `DEFAULT_MAX_TURNS`) is reached. |
| `runStream(message?, maxTurns?, extra?)` | Same as `run`, but yields `StreamEvent` chunks (text deltas, tool calls, results). |
| `resume(message?, maxTurns?, extra?)` | Alias for `run` — semantic clarity for loaded sessions. |
| `save(path)` | Persist conversation to a JSON file. |
| `Forge.load(path, config?)` | Reconstruct from a saved session. Tools must be re-provided (callables can't be serialized). |
| `Forge.debug(path, config?)` | Stateless replay. Loads messages from a JSON file (raw list or session), sends one API call, returns `{ role, content, tool_calls }`. No agent loop, no side effects. |

### `tool()`

Factory that creates a `Tool` from a definition object.

```typescript
const myTool = tool({
  name: string;           // must match ^[a-zA-Z0-9_-]+$
  description: string;    // shown to the model
  parameters: JsonSchema; // JSON Schema for arguments
  execute: (args: Record<string, unknown>) => string | Promise<string>;
});
```

Use `ToolRegistry.toOpenAISpecs()` when you need OpenAI-format tool specs (e.g. custom API calls).

### `ToolRegistry`

Collection of tools with lookup and batch serialization.

```typescript
const reg = new ToolRegistry();
reg.register(myTool);
reg.has("myTool");              // boolean
reg.get("myTool");              // Tool | undefined
await reg.execute("myTool", { key: "value" });
reg.toOpenAISpecs();           // OpenAI-format tool specs
```

Errors during execution are caught and returned as strings — the model can self-correct.

### `Context`

Ordered message list with token estimation and auto-truncation.

```typescript
const ctx = new Context();
ctx.addSystem("You are helpful.");
ctx.addUser("Hello!");
ctx.addAssistant("Hi!");
ctx.addToolResult("call_1", "result", "toolName");
ctx.tokenCount();       // char/4 heuristic, pluggable via ctx.tokenCounter
ctx.truncate();          // FIFO eviction, preserves system message
ctx.toList();            // OpenAI-format message dicts
ctx.clear();
Context.fromDicts(dicts); // reconstruct from raw dicts
```

### `Session`

Serializable conversation snapshot. Stores messages and tool schemas — **not** callables.

```typescript
Session.fromForge(forge);     // snapshot
session.save("path.json");
const s = Session.load("path.json");
s.validateTools(registry);    // check tool names match registered callables
```

**JSON format:**

```json
{
  "version": "0.1.0",
  "model": "deepseek-v4-flash",
  "tools": [
    { "type": "function", "function": { "name": "...", "description": "...", "parameters": {} } }
  ],
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "metadata": {
    "created_at": "...",
    "message_count": 4,
    "usage_log": [
      {
        "turn": 0,
        "at": "...",
        "prompt_tokens": 1200,
        "completion_tokens": 80,
        "total_tokens": 1280,
        "prompt_cache_hit_tokens": 900,
        "prompt_cache_miss_tokens": 300
      }
    ]
  }
}
```

`messages` is the source of truth. The system prompt is stored as the first
`{"role":"system"}` message; top-level `system` is not part of the session
format.

### `AgentSession`

Optional preset for coding agents — wraps `Forge` with default system prompt, bash tool, and trajectory persistence. Used by `npm run tui` and `examples/agent.ts`.

```typescript
const session = AgentSession.open({ cwd: "/my/project", resume: "trajectories/task.json" });
await session.forge.run("list files in src/");
session.save();                          // writes to session.trajPath
session.clear();                         // new trajectory + reset context
```

**System prompt:** default lives in `src/system.ts` (`codingAgentSystem`). Override at open time with `system: "..."`. `--resume` uses the prompt stored in the trajectory; pass `system:` with `--resume` to replace it immediately via `context.addSystem()`.

```typescript
AgentSession.open({ cwd, system: "You are a security reviewer." });
```

### Skills

Reusable instruction packs loaded from `.agents/skills/<name>/SKILL.md` (YAML frontmatter + markdown body). Uses **progressive disclosure**: the model sees a one-line catalog in its system prompt and loads a skill's full instructions on demand via an auto-registered `skill` tool — no slash commands, no prompt bloat.

```
.agents/skills/
  code-review/
    SKILL.md
```

```markdown
---
name: code-review
description: Review code changes for security, performance, and style.
allowed-tools: [bash]
model: deepseek-v4-pro
---
Review the files in ${arguments} with focus on correctness.
```

Wire skills into a `Forge` by passing directories or a prebuilt registry:

```typescript
import { Forge, bashTool, discoverSkills } from "ds-forge";

// Exact directories only; no ambient project/user discovery.
const forge = new Forge({
  system: "You are a code assistant.",
  tools: [bashTool()],
  skills: [".agents/skills"],
});

// Or a prebuilt registry
const registry = discoverSkills({
  cwd: process.cwd(),
  includeProject: true,
  includeUser: true,
});
const forge2 = new Forge({ tools: [bashTool()], skills: registry });
```

At runtime the model calls `skill({ name: "code-review", arguments: "src/auth.ts" })`; the tool returns the rendered instructions (`${arguments}`, `${SKILL_DIR}` interpolated) for the model to follow. `allowed-tools` and `model` are advisory hints surfaced to the model.

TUI skill discovery is fully opt-in: `--skills` loads project `.agents/skills`
directories between `cwd` and the git root; `--user-skills` loads
`~/.agents/skills`. Use both flags to enable both scopes.

Frontmatter is parsed as standard YAML, including folded multiline scalars and
nested metadata. **Recognized fields:** `name` (defaults to dir name),
`description`, `allowed-tools`, `model`.

**API:** `discoverSkills`, `loadSkillsFromDir`, `SkillRegistry`, `parseSkill`, `parseFrontmatter`, `renderSkill`, `skillsCatalog`, `skillTool`.

### AGENTS.md

[AGENTS.md](https://agents.md) is the cross-vendor standard (OpenAI → Agentic AI Foundation / Linux Foundation) for project-specific agent instructions — a plain-markdown "README for agents" with no required schema. ds-forge discovers and injects it into the system prompt.

Where skills are on-demand capability packs (loaded via a tool), AGENTS.md is **persistent project memory**. Discovery walks up from `cwd` to the git root, collecting every `AGENTS.md` on the chain, ordered general → specific so the nearest file carries the most weight (matching the spec's "closest AGENTS.md wins").

```typescript
import { Forge, AgentSession, loadAgentsMd } from "ds-forge";

// Forge: opt-in (a library shouldn't read disk unasked)
const forge = new Forge({ system: "You are a code assistant.", agentsMd: true });
// Or select exact scopes:
// agentsMd: { cwd: "/my/project", includeProject: true, global: true }

// AgentSession: off by default; enable only the scopes you want.
const session = AgentSession.open({ cwd, agentsMd: true });
AgentSession.open({ cwd, agentsMd: { global: true, includeProject: false } });

// Standalone
const section = loadAgentsMd({ cwd, includeProject: true });
```

**Discovery** (follows Codex's reference behavior):

- Per directory, `AGENTS.override.md` wins over `AGENTS.md` (first non-empty; at most one file per directory).
- Project scope walks the **git root → cwd** chain; if there's no git root, only `cwd` is read (no wandering into unrelated parents).
- Global scope (`~/.agents/AGENTS.md`) is **opt-in** via `global: true` — user-global guidance should be explicit.
- The combined section is capped at **32 KiB** (`maxBytes`); the nearest (last) doc is truncated when over the limit.
- On `--resume`, the saved trajectory already contains the baked-in instructions, so they aren't re-read.

**API:** `findAgentsMd`, `loadAgentsMd`, `agentsMdSection`, `AGENTS_MD`, `AGENTS_MD_OVERRIDE`, `DEFAULT_AGENTS_MD_MAX_BYTES`.

### `bashTool`

Full shell access via `child_process.exec` — **not sandboxed**. Options: `cwd`, `timeout`, `maxOutput`. No command allowlist; see DESIGN.md §7. For constrained environments, register structured tools instead of patching bash.

```typescript
import { bashTool } from "ds-forge";

forge.tools.register(bashTool({ cwd: "/my/project", timeout: 60_000 }));
```

## Patterns

### Tool with validation

```typescript
const divide = tool({
  name: "divide",
  description: "Divide two numbers.",
  parameters: {
    type: "object",
    properties: {
      a: { type: "number", description: "Numerator" },
      b: { type: "number", description: "Denominator" },
    },
    required: ["a", "b"],
  },
  execute: async (args) => {
    const a = Number(args.a);
    const b = Number(args.b);
    if (b === 0) return "Error: division by zero";
    return String(a / b);
  },
});
```

### Custom token counter

```typescript
import { Context } from "ds-forge";

const ctx = new Context();
ctx.tokenCounter = (msgs) => {
  // plug in tiktoken or any estimator
  return msgs.reduce((n, m) => n + JSON.stringify(m).length, 0) / 4;
};
```

### Debug workflow

```bash
# 1. Save a session
forge.save("debug.json");

# 2. Edit messages manually in debug.json

# 3. Replay
npx tsx -e "
  import { Forge } from './src/index.js';
  const msg = await Forge.debug('debug.json');
  console.log(msg);
"
```

### Load & resume

```typescript
const forge = Forge.load("session.json", { tools: [getWeather, calculate] });
await forge.resume("Now check Tokyo too.");
```

## Agent TUI

Interactive terminal chat (Claude Code style) with streaming, bash tool, and automatic trajectory persistence.

```bash
npm run tui                                          # new session
npm run tui -- --cwd /path/to/project                # set working directory
npm run tui -- --resume trajectories/task-xxx.json   # continue a saved session
```

The extra `--` is required by npm: everything after it is passed to the script, not interpreted by npm itself. To skip it, run directly:

```bash
npx tsx --env-file-if-exists=.env tui/index.tsx --resume trajectories/task-xxx.json
```

**CLI flags:** `--cwd`, `--resume <path>`, `--model`, `--max-turns`, `--agents` (load project AGENTS.md), `--global-agents` (load global AGENTS.md), `--skills` (load project skills), `--user-skills` (load `~/.agents/skills`), `--template <name>` (load a system-prompt template)

**In-session commands:** `/clear` (new trajectory), `/quit`, Ctrl+C

**Trajectories:** saved to `./trajectories/` by default (override with `DS_FORGE_DIR`). A new `task-<timestamp>.json` is created on start; the file is updated after each turn and on exit. The header shows the current filename.

See also `examples/agent.ts` for a non-interactive CLI with the same persistence model.

**Stability sampling:** `npm run sample -- --n 3 --template divination --model deepseek-v4-pro --effort max "<prompt>"` runs the same prompt N times in parallel (no tools by default). Enable tools with `--tools bash,read,write,edit`. Artifacts: `trajectories/samples/<group-id>/` (`compare.html` for side-by-side view). Fork: `--resume trajectories/task.json --n 3 "<follow-up>"`.

### Agentic Writing templates

`--template <name>` loads a markdown document and uses it as the **system prompt**, replacing the default coding-agent persona. This turns the TUI into an agent for any role a document can describe — writing, reviewing, research — while keeping bash, skills, and AGENTS.md configured.

Drop a template in the repo (relative to `cwd`):

```
templates/
  blog.md        # --template blog
  report.md      # --template report
```

```bash
npm run tui -- --effort max --global-agents --user-skills \
  --cwd /path/to/project --template blog
```

Resolution for `--template <name>`: an explicit path (`name` contains `/` or ends in `.md`) is used as-is relative to `cwd`; otherwise `templates/<name>.md`, then `templates/<name>/SP.md`. The whole file becomes the SP — no required schema or frontmatter. `${cwd}` and other `${name}` placeholders are substituted from `--cwd` and optional `vars` when using `loadTemplate()`. A sample lives at `templates/writing.md`.

**API:** `loadTemplate`, `renderTemplate`, `resolveTemplatePath`, `TEMPLATES_DIR`.

## Running the demo

```bash
npm run demo        # needs DEEPSEEK_API_KEY in .env
npm run demo:mcp    # MCP playground
npm run test        # no API key (MCP + TUI)
npm run tui         # Agent TUI (terminal chat)
```

## Further reading

| Doc | Description |
|---|---|
| [DESIGN.md](DESIGN.md) | Architecture and design trade-offs |
| [docs/README.zh-CN.md](docs/README.zh-CN.md) | Getting started (Chinese) |
| [docs/deepseek-v4.md](docs/deepseek-v4.md) | DeepSeek V4 architecture, API, agent semantics (Chinese) |
| [docs/DESIGN.zh-CN.md](docs/DESIGN.zh-CN.md) | Architecture (Chinese) |
| [docs/tui.md](docs/tui.md) | TUI architecture and internals (Chinese) |
| [docs/mcp.md](docs/mcp.md) | MCP protocol (Chinese) |
| [docs/llm-protocols.md](docs/llm-protocols.md) | LLM API protocol comparison (Chinese) |

## License

MIT — see [LICENSE](LICENSE).
