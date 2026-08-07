#!/usr/bin/env npx tsx
/**
 * Stability sampling — run the same prompt N times in parallel with identical
 * config. Each replica gets its own trajectory; artifacts land in --out-dir.
 *
 * Usage:
 *   npm run sample -- --n 3 --template divination "..."
 *   npm run sample -- --tools read,edit --template divination "..."
 *   open trajectories/samples/<group-id>/compare.html
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AgentSession,
  Session,
  TRAJECTORY_DIR,
  BUILTIN_TOOL_NAMES,
  builtinTools,
  DEFAULT_AGENT_REASONING_EFFORT,
  DEFAULT_MAX_TURNS,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  loadTemplate,
  parseToolNames,
  type BuiltinToolName,
  type ReasoningEffort,
} from "../src/index.js";
import {
  writeSampleArtifacts,
  type SampleManifest,
  type SampleRunRecord,
} from "../src/sample-output.js";

interface SampleOpts {
  cwd: string;
  task: string;
  n: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  maxTurns: number;
  timeout: number;
  system?: string;
  template?: string;
  resume?: string;
  outDir?: string;
  verbose: boolean;
  tools: BuiltinToolName[];
}

function usage(): never {
  console.log(`
Usage: npx tsx examples/sample.ts [options] <prompt>

Options:
  --n <count>         Parallel replicas (default: 3)
  --out-dir <path>    Write replica-*.md + compare.html (default: trajectories/samples/<group-id>)
  --resume <path>     Fork from a trajectory (history preserved; saves to new files)
  --template <name>   System-prompt template (fresh sessions only; ignored with --resume)
  --tools <list>      Comma-separated builtin tools (default: none). Available: ${BUILTIN_TOOL_NAMES.join(", ")}
  --cwd <dir>         Working directory for file/bash tools
  --model <name>      Model (default: ${DEFAULT_MODEL})
  --effort <level>    Reasoning effort: high | max | off (default: ${DEFAULT_AGENT_REASONING_EFFORT})
  --max-turns <n>     Max agent turns per replica (default: ${DEFAULT_MAX_TURNS})
  --timeout <ms>      Bash timeout when bash is in --tools (default: ${DEFAULT_TIMEOUT_MS})
  --verbose           Print full replica bodies to the terminal (default: summary only)

Examples:
  npm run sample -- --n 3 --template divination --model deepseek-v4-pro --effort max "..."
  npm run sample -- --tools bash,read,write,edit "list and summarize src/"
  npm run sample -- --tools read,edit --resume trajectories/task.json --n 3 "fix typos"
  open trajectories/samples/<group-id>/compare.html
`);
  process.exit(1);
}

function parseArgs(args: string[]): SampleOpts {
  const opts: SampleOpts = {
    cwd: process.cwd(),
    task: "",
    n: 3,
    model: DEFAULT_MODEL,
    reasoningEffort: DEFAULT_AGENT_REASONING_EFFORT,
    maxTurns: DEFAULT_MAX_TURNS,
    timeout: DEFAULT_TIMEOUT_MS,
    verbose: false,
    tools: [],
  };

  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--n":
        opts.n = parseInt(args[++i]!, 10);
        if (!Number.isFinite(opts.n) || opts.n < 1) usage();
        break;
      case "--out-dir":
        opts.outDir = resolve(args[++i]!);
        break;
      case "--resume":
        opts.resume = resolve(args[++i]!);
        break;
      case "--template":
      case "-T":
        opts.template = args[++i];
        break;
      case "--tools":
        opts.tools.push(...parseToolNames(args[++i]!));
        break;
      case "--cwd":
        opts.cwd = resolve(args[++i]!);
        break;
      case "--model":
        opts.model = args[++i]!;
        break;
      case "--effort": {
        const v = args[++i]! as ReasoningEffort;
        if (v !== "high" && v !== "max" && v !== "off") usage();
        opts.reasoningEffort = v;
        break;
      }
      case "--max-turns":
        opts.maxTurns = parseInt(args[++i]!, 10);
        break;
      case "--timeout":
        opts.timeout = parseInt(args[++i]!, 10);
        break;
      case "--verbose":
        opts.verbose = true;
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

  if (!opts.task && !opts.resume) usage();
  if (opts.template && opts.resume) {
    console.error("Warning: --template is ignored when --resume is set (system comes from trajectory).");
  } else if (opts.template) {
    opts.system = loadTemplate(opts.template, { cwd: opts.cwd });
  }
  // A fork always keeps the source trajectory's model. Use that same source of
  // truth for console output and manifest metadata instead of the CLI default.
  if (opts.resume) {
    opts.model = Session.load(opts.resume).model;
  }
  opts.tools = [...new Set(opts.tools)];
  return opts;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

async function runReplica(index: number, opts: SampleOpts): Promise<SampleRunRecord> {
  const start = Date.now();
  const tools = builtinTools(opts.tools, {
    cwd: opts.cwd,
    bash: { timeout: opts.timeout },
  });
  const sessionOpts = {
    cwd: opts.cwd,
    reasoningEffort: opts.reasoningEffort,
    system: opts.system,
    tools,
    ...(opts.resume ? {} : { model: opts.model }),
  };
  const session = opts.resume
    ? AgentSession.fork(opts.resume, sessionOpts)
    : AgentSession.open(sessionOpts);

  const usageBefore = session.forge.usageLog.length;
  const content = await session.run(opts.task || undefined, opts.maxTurns);
  session.save();

  const totalTokens = session.forge.usageLog
    .slice(usageBefore)
    .reduce((sum, u) => sum + u.total_tokens, 0);

  return {
    index,
    trajPath: session.trajPath,
    content,
    ms: Date.now() - start,
    totalTokens,
    hash: contentHash(content),
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const groupId = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = opts.outDir ?? join(TRAJECTORY_DIR, "samples", groupId);
  const toolsLabel = opts.tools.length > 0 ? opts.tools.join(",") : "(none)";

  console.log("=".repeat(60));
  console.log(
    `SAMPLING  n=${opts.n}  model=${opts.model}  effort=${opts.reasoningEffort}  tools=${toolsLabel}`,
  );
  if (opts.resume) console.log(`Fork from: ${opts.resume}`);
  if (opts.template) console.log(`Template: ${opts.template}`);
  console.log(`Output: ${outDir}`);
  console.log("=".repeat(60));
  console.log(opts.task || "(no new user message — continue from fork point)");
  console.log("=".repeat(60));
  console.log();

  const results = await Promise.all(
    Array.from({ length: opts.n }, (_, i) => runReplica(i, opts)),
  );

  const unique = new Set(results.map((r) => r.hash));
  const manifest: SampleManifest = {
    group_id: groupId,
    n: opts.n,
    prompt: opts.task || null,
    resume_from: opts.resume ?? null,
    template: opts.template ?? null,
    model: opts.model,
    reasoning_effort: opts.reasoningEffort,
    tools: opts.tools,
    unique_outputs: unique.size,
    runs: results.map((r) => ({
      index: r.index,
      traj: r.trajPath,
      ms: r.ms,
      total_tokens: r.totalTokens,
      content_hash: r.hash,
      markdown: `replica-${r.index + 1}.md`,
    })),
  };

  mkdirSync(TRAJECTORY_DIR, { recursive: true });
  const legacyManifestPath = join(TRAJECTORY_DIR, `sample-${groupId}.json`);
  writeFileSync(legacyManifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const { comparePath, markdownPaths } = writeSampleArtifacts(outDir, manifest, results);

  for (const r of results) {
    const line =
      `Replica ${r.index + 1}/${opts.n}  ${(r.ms / 1000).toFixed(1)}s  ` +
      `${r.totalTokens} tok  hash=${r.hash}`;
    if (opts.verbose) {
      console.log(`--- ${line} ---`);
      console.log(r.content);
      console.log(`Trajectory: ${r.trajPath}`);
      console.log(`Markdown: ${markdownPaths[r.index]}`);
      console.log();
    } else {
      console.log(`${line}`);
      console.log(`  traj: ${r.trajPath}`);
      console.log(`  md:   ${markdownPaths[r.index]}`);
    }
  }

  console.log();
  console.log("=".repeat(60));
  console.log(
    `Stability: ${unique.size}/${opts.n} unique output(s)  ` +
      (unique.size === 1 ? "(identical)" : `(hashes: ${[...unique].join(", ")})`),
  );
  console.log(`Compare:  ${comparePath}`);
  console.log(`Manifest: ${join(outDir, "manifest.json")}`);
  console.log(`Legacy:   ${legacyManifestPath}`);
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
