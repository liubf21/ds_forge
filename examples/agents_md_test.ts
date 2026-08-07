#!/usr/bin/env npx tsx
/**
 * AGENTS.md test suite. Zero external deps, no API calls — uses Node assert and
 * temp directory fixtures.
 *
 * Run: npm run test (via root test suite)
 *   AGENTS_MD_TEST_VERBOSE=1 npx tsx examples/agents_md_test.ts
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentSession,
  Forge,
  TurnContext,
  agentsMdSection,
  findAgentsMd,
  loadAgentsMd,
} from "../src/index.js";
import { AGENTS_MD_OVERRIDE } from "../src/agents-md.js";

const VERBOSE = !!process.env.AGENTS_MD_TEST_VERBOSE;
let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    if (VERBOSE) console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`\n  ✗ FAIL [${name}]`);
    console.error(`    ${(e as Error).message}`);
  }
}

/** repo/ (git) with root AGENTS.md and packages/api/AGENTS.md; returns dirs. */
function repoFixture() {
  const repo = mkdtempSync(join(tmpdir(), "ds-forge-agents-"));
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "# Root\nUse pnpm. Run `pnpm test`.");
  const api = join(repo, "packages", "api");
  mkdirSync(api, { recursive: true });
  writeFileSync(join(api, "AGENTS.md"), "# API\nThis package uses Fastify.");
  return { repo, api };
}

async function main() {
  console.log("AGENTS.md Test Suite\n");

  await check("findAgentsMd: none → empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-forge-agents-empty-"));
    assert.deepStrictEqual(findAgentsMd({ cwd: dir, includeProject: true }), []);
  });

  await check("findAgentsMd: walks up to git root, general → specific", () => {
    const { repo, api } = repoFixture();
    const docs = findAgentsMd({ cwd: api, includeProject: true });
    assert.strictEqual(docs.length, 2);
    // root first (general), nearest last (specific)
    assert.ok(docs[0]!.path.startsWith(repo) && docs[0]!.content.includes("Root"));
    assert.ok(docs[1]!.content.includes("Fastify"));
    assert.ok(docs[1]!.dir === api);
  });

  await check("findAgentsMd: no scope enabled → empty", () => {
    const { api } = repoFixture();
    assert.deepStrictEqual(findAgentsMd({ cwd: api }), []);
  });

  await check("findAgentsMd: no git → only cwd, no upward wander", () => {
    const root = mkdtempSync(join(tmpdir(), "ds-forge-agents-nogit-"));
    const sub = join(root, "a", "b");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "ROOT-LEVEL");
    writeFileSync(join(sub, "AGENTS.md"), "SUB-LEVEL");
    const docs = findAgentsMd({ cwd: sub, includeProject: true });
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0]!.content, "SUB-LEVEL");
  });

  await check("findAgentsMd: blank file skipped", () => {
    const repo = mkdtempSync(join(tmpdir(), "ds-forge-agents-blank-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "   \n  \n");
    assert.deepStrictEqual(findAgentsMd({ cwd: repo, includeProject: true }), []);
  });

  await check("agentsMdSection: relative labels + precedence note", () => {
    const { repo, api } = repoFixture();
    const docs = findAgentsMd({ cwd: api, includeProject: true });
    const section = agentsMdSection(docs, api);
    assert.ok(section.includes("## Project instructions (AGENTS.md)"));
    assert.ok(section.includes("Fastify"));
    assert.ok(section.includes("pnpm test"));
    // root file is above cwd → labeled by relative path containing ".."
    assert.ok(section.includes("AGENTS.md"));
  });

  await check("agentsMdSection: empty docs → empty string", () => {
    assert.strictEqual(agentsMdSection([]), "");
  });

  await check("findAgentsMd: AGENTS.override.md beats AGENTS.md per dir", () => {
    const repo = mkdtempSync(join(tmpdir(), "ds-forge-agents-ovr-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "BASE");
    writeFileSync(join(repo, AGENTS_MD_OVERRIDE), "OVERRIDE");
    const docs = findAgentsMd({ cwd: repo, includeProject: true });
    assert.strictEqual(docs.length, 1, "one file per directory");
    assert.strictEqual(docs[0]!.content, "OVERRIDE");
    assert.ok(docs[0]!.path.endsWith(AGENTS_MD_OVERRIDE));
  });

  await check("findAgentsMd: global honors ~/.agents-style dir, override wins", () => {
    const home = mkdtempSync(join(tmpdir(), "ds-forge-agents-home-"));
    writeFileSync(join(home, "AGENTS.md"), "GLOBAL-BASE");
    writeFileSync(join(home, AGENTS_MD_OVERRIDE), "GLOBAL-OVERRIDE");
    const proj = mkdtempSync(join(tmpdir(), "ds-forge-proj-"));
    writeFileSync(join(proj, "AGENTS.md"), "PROJECT");

    const prev = process.env.DS_FORGE_AGENTS_HOME;
    process.env.DS_FORGE_AGENTS_HOME = home;
    try {
      const docs = findAgentsMd({ cwd: proj, global: true, includeProject: true });
      // global override first, then project
      assert.ok(docs.some((d) => d.content === "GLOBAL-OVERRIDE"));
      assert.ok(!docs.some((d) => d.content === "GLOBAL-BASE"));
      assert.strictEqual(docs[docs.length - 1]!.content, "PROJECT");
    } finally {
      if (prev === undefined) delete process.env.DS_FORGE_AGENTS_HOME;
      else process.env.DS_FORGE_AGENTS_HOME = prev;
    }
  });

  await check("agentsMdSection: caps combined size at maxBytes", () => {
    const big = "x".repeat(5000);
    const docs = [
      { path: "/r/AGENTS.md", dir: "/r", content: big },
      { path: "/r/sub/AGENTS.md", dir: "/r/sub", content: "NEAREST-" + big },
    ];
    const out = agentsMdSection(docs, "/r", 1024);
    assert.ok(Buffer.byteLength(out, "utf-8") <= 1024 + 64); // + truncation marker
    assert.ok(out.includes("[truncated at 1024 bytes]"));
    // header + root come first; nearest tail is what gets cut
    assert.ok(out.includes("## Project instructions"));
  });

  await check("loadAgentsMd: discover + format", () => {
    const { api } = repoFixture();
    const text = loadAgentsMd({ cwd: api, includeProject: true });
    assert.ok(text.includes("Fastify"));
    assert.ok(text.includes("Root"));
  });

  await check("Forge: agentsMd injects on first run, default off", () => {
    const { api } = repoFixture();

    const off = new Forge({ apiKey: "k", system: "BASE" });
    assert.strictEqual(
      off.context.messages.find((m) => m.role === "system")?.content,
      "BASE",
    );

    const on = new Forge({
      apiKey: "k",
      system: "BASE",
      agentsMd: { cwd: api, includeProject: true },
      environmentContext: true,
    });
    const sys = on.context.messages.find((m) => m.role === "system")?.content ?? "";
    assert.ok(sys.startsWith("BASE"));
    assert.ok(!sys.includes("Fastify"), "AGENTS.md not in system");

    // Mock-less: inject prefix via the same path run() uses
    for (const prefix of new TurnContext({
      cwd: api,
      agentsMd: { cwd: api, includeProject: true },
      includeEnvironment: true,
    }).prefixForTurn(api)) {
      on.context.addUser(prefix);
    }
    const user = on.context.messages.find((m) => m.role === "user")?.content ?? "";
    assert.ok(user.includes("Fastify"));
    assert.ok(user.includes("# AGENTS.md instructions"));
    assert.ok(user.includes("<environment_context>"));
  });

  await check("AgentSession: agentsMd:true loads project and survives clear()", () => {
    const { repo, api } = repoFixture();
    const session = AgentSession.open({
      cwd: api,
      apiKey: "k",
      system: "CODER",
      agentsMd: true,
    });
    const sys1 = session.forge.context.messages.find((m) => m.role === "system");
    assert.ok(sys1?.content?.includes("CODER"));
    assert.ok(sys1?.content?.includes("# AGENTS.md scope"));
    assert.ok(!sys1?.content?.includes("Fastify"), "AGENTS body not in system");

    session.prepareUserTurn("go");
    const prefix = session.forge.context.messages.find(
      (m) => m.role === "user" && m.content?.includes("Fastify"),
    );
    assert.ok(prefix, "AGENTS.md in first-turn user prefix");

    session.clear();
    const sys2 = session.forge.context.messages.find((m) => m.role === "system");
    assert.ok(sys2?.content?.includes("# AGENTS.md scope"), "scope note survives clear()");
    session.prepareUserTurn("again");
    const prefix2 = session.forge.context.messages.find(
      (m) => m.role === "user" && m.content?.includes("Fastify"),
    );
    assert.ok(prefix2, "AGENTS.md re-injected after clear on first turn");
    void repo;
  });

  await check("AgentSession: agentsMd options support global-only scope", () => {
    const home = mkdtempSync(join(tmpdir(), "ds-forge-as-agents-home-"));
    writeFileSync(join(home, "AGENTS.md"), "GLOBAL-AGENTS-RULE");
    const repo = mkdtempSync(join(tmpdir(), "ds-forge-as-proj-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "REPO-RULE");

    const prev = process.env.DS_FORGE_AGENTS_HOME;
    process.env.DS_FORGE_AGENTS_HOME = home;
    try {
      const session = AgentSession.open({
        cwd: repo,
        apiKey: "k",
        system: "CODER",
        agentsMd: { global: true, includeProject: false },
      });
      const sys = session.forge.context.messages.find((m) => m.role === "system");
      assert.ok(sys?.content?.includes("CODER"));
      session.prepareUserTurn("go");
      const prefix = session.forge.context.messages.find(
        (m) => m.role === "user" && m.content?.includes("GLOBAL-AGENTS-RULE"),
      );
      assert.ok(prefix, "global loaded in user prefix");
      assert.ok(!prefix?.content?.includes("REPO-RULE"), "project not loaded");
    } finally {
      if (prev === undefined) delete process.env.DS_FORGE_AGENTS_HOME;
      else process.env.DS_FORGE_AGENTS_HOME = prev;
    }
  });

  await check("AgentSession: AGENTS.md is off by default", () => {
    const { api } = repoFixture();
    const session = AgentSession.open({
      cwd: api,
      apiKey: "k",
      system: "CODER",
    });
    const sys = session.forge.context.messages.find((m) => m.role === "system");
    assert.strictEqual(sys?.content, "CODER");
  });

  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("Test suite error:", e);
  process.exit(1);
});
