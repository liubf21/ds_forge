#!/usr/bin/env npx tsx
/**
 * Multi-step agent with bash tool + trajectory persistence.
 *
 * Usage:
 *   # Run a new task
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/agent.ts "explain the architecture of this project"
 *
 *   # Resume from a saved trajectory
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/agent.ts --resume trajectory.json "now check for bugs"
 *
 *   # Replay from a trajectory (read-only, no agent loop)
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/agent.ts --replay trajectory.json
 *
 *   # Specify working directory
 *   DEEPSEEK_API_KEY=sk-... npx tsx examples/agent.ts --cwd /path/to/project "run the tests"
 *
 * Trajectory files are saved to ./trajectories/ by default.
 */

import { resolve } from "node:path";
import { AgentSession, DEFAULT_AGENT_REASONING_EFFORT, DEFAULT_MAX_TURNS, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS, Forge, type ReasoningEffort } from "../src/index.js";

function usage(): never {
  console.log(`
Usage: npx tsx examples/agent.ts [options] <task>

Options:
  --resume <path>     Load and continue from a saved trajectory
  --replay <path>     Stateless replay of a saved trajectory (no agent loop)
  --cwd <dir>         Working directory for bash commands
  --model <name>      Model to use (default: ${DEFAULT_MODEL})
  --effort <level>    Reasoning effort: high | max | off (default: ${DEFAULT_AGENT_REASONING_EFFORT})
  --max-turns <n>     Max agent turns (default: ${DEFAULT_MAX_TURNS})
  --timeout <ms>      Bash command timeout in ms (default: ${DEFAULT_TIMEOUT_MS})

Examples:
  npx tsx examples/agent.ts "what files are in src/?"
  npx tsx examples/agent.ts --cwd /my/project "run the tests and fix failures"
  npx tsx examples/agent.ts --resume trajectories/task.json "continue the work"
  npx tsx examples/agent.ts --replay trajectories/task.json
`);
  process.exit(1);
}

function parseArgs(args: string[]) {
  const opts: {
    resume?: string;
    replay?: string;
    cwd?: string;
    model: string;
    reasoningEffort: ReasoningEffort;
    maxTurns: number;
    timeout: number;
    task: string;
  } = {
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_AGENT_REASONING_EFFORT,
    maxTurns: DEFAULT_MAX_TURNS,
    timeout: DEFAULT_TIMEOUT_MS,
    task: "",
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--resume":
        opts.resume = args[++i];
        break;
      case "--replay":
        opts.replay = args[++i];
        break;
      case "--cwd":
        opts.cwd = resolve(args[++i]);
        break;
      case "--model":
        opts.model = args[++i];
        break;
      case "--effort": {
        const v = args[++i] as ReasoningEffort;
        if (v !== "high" && v !== "max" && v !== "off") usage();
        opts.reasoningEffort = v;
        break;
      }
      case "--max-turns":
        opts.maxTurns = parseInt(args[++i], 10);
        break;
      case "--timeout":
        opts.timeout = parseInt(args[++i], 10);
        break;
      case "--help":
      case "-h":
        usage();
      default:
        if (args[i]?.startsWith("-")) usage();
        opts.task = args.slice(i).join(" ");
        i = args.length;
    }
    i++;
  }

  if (!opts.task && !opts.replay) usage();
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.replay) {
    const msg = await Forge.debug(opts.replay, { model: opts.model });
    console.log("=".repeat(60));
    console.log("REPLAY");
    console.log("=".repeat(60));
    console.log(`Role: ${msg.role}`);
    console.log(`Content:\n${msg.content}`);
    if (msg.tool_calls) {
      console.log("Tool calls:", JSON.stringify(msg.tool_calls, null, 2));
    }
    return;
  }

  const cwd = opts.cwd ?? process.cwd();
  const session = AgentSession.open({
    cwd,
    resume: opts.resume,
    model: opts.model,
    reasoningEffort: opts.reasoningEffort,
    bash: { timeout: opts.timeout },
  });

  if (opts.resume) {
    console.log(`Loading trajectory: ${opts.resume}`);
  }

  console.log("=".repeat(60));
  console.log(opts.resume ? "RESUMING" : "RUNNING");
  console.log("=".repeat(60));
  console.log(`Task: ${opts.task}`);
  console.log(`Trajectory: ${session.trajPath}`);
  console.log("=".repeat(60));
  console.log();

  const result = await session.run(opts.task, opts.maxTurns);

  session.save();
  console.log();
  console.log("=".repeat(60));
  console.log("RESULT");
  console.log("=".repeat(60));
  console.log(result);
  console.log();
  console.log(`Trajectory saved: ${session.trajPath}`);
  console.log(
    `  ${session.forge.context.messages.length} messages, model: ${session.forge.model}`,
  );
  console.log();
  console.log("Next steps:");
  console.log(
    `  Resume:  npx tsx examples/agent.ts --resume ${session.trajPath} "<next task>"`,
  );
  console.log(
    `  Replay:  npx tsx examples/agent.ts --replay ${session.trajPath}`,
  );
  console.log(
    `  Inspect: cat ${session.trajPath} | jq '.messages'`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
