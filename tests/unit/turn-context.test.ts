import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_CONTEXT_OPEN, captureEnvironment, renderEnvironmentContext } from "../../src/environment-context.js";
import {
  AGENTS_MD_INSTRUCTIONS_MARKER,
  TurnContext,
} from "../../src/turn-context.js";

describe("TurnContext", () => {
  it("first turn emits env + agents prefix", () => {
    const repo = mkdtempSync(join(tmpdir(), "ds-forge-tc-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "RULE-A");

    const tc = new TurnContext({
      cwd: repo,
      agentsMd: true,
      includeEnvironment: true,
    });
    const msgs = tc.prefixForTurn(repo);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(AGENTS_MD_INSTRUCTIONS_MARKER);
    expect(msgs[0]).toContain("RULE-A");
    expect(msgs[0]).toContain(ENVIRONMENT_CONTEXT_OPEN);
    expect(msgs[0]).toContain(`<cwd>${repo}</cwd>`);
  });

  it("steady turn with same cwd emits nothing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ds-forge-tc-steady-"));
    const tc = new TurnContext({ cwd, includeEnvironment: true });
    tc.prefixForTurn(cwd);
    expect(tc.prefixForTurn(cwd)).toEqual([]);
  });

  it("cwd change emits environment diff only", () => {
    const a = mkdtempSync(join(tmpdir(), "ds-forge-tc-a-"));
    const b = mkdtempSync(join(tmpdir(), "ds-forge-tc-b-"));
    const tc = new TurnContext({ cwd: a, includeEnvironment: true });
    tc.prefixForTurn(a);
    const diff = tc.prefixForTurn(b);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toContain(ENVIRONMENT_CONTEXT_OPEN);
    expect(diff[0]).toContain(`<cwd>${b}</cwd>`);
    expect(diff[0]).not.toContain(AGENTS_MD_INSTRUCTIONS_MARKER);
  });

  it("restoreFromMessages avoids duplicate agents prefix", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ds-forge-tc-resume-"));
    const tc = new TurnContext({ cwd, includeEnvironment: true, agentsMd: true });
    const first = tc.prefixForTurn(cwd)[0]!;
    tc.restoreFromMessages([{ role: "user", content: first }, { role: "user", content: "hi" }]);
    expect(tc.prefixForTurn(cwd)).toEqual([]);
  });

  it("reset allows first-turn prefix again", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ds-forge-tc-reset-"));
    const tc = new TurnContext({ cwd, includeEnvironment: true });
    tc.prefixForTurn(cwd);
    tc.reset();
    expect(tc.prefixForTurn(cwd)).toHaveLength(1);
  });
  it("env-only history still sends AGENTS.md when newly enabled on resume", () => {
    const repo = mkdtempSync(join(tmpdir(), "ds-forge-tc-resume-agents-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "RULE-A");

    const tc = new TurnContext({ cwd: repo, agentsMd: true, includeEnvironment: true });
    // Prior session ran without agentsMd: history has environment but no
    // AGENTS.md block, so restoreFromMessages must not suppress a pending one.
    tc.restoreFromMessages([
      { role: "user", content: renderEnvironmentContext(captureEnvironment(repo)) },
      { role: "user", content: "hi" },
    ]);

    const msgs = tc.prefixForTurn(repo);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(AGENTS_MD_INSTRUCTIONS_MARKER);
    expect(msgs[0]).toContain("RULE-A");
    // Environment unchanged since the restored baseline: no duplicate env block.
    expect(msgs[0]).not.toContain(ENVIRONMENT_CONTEXT_OPEN);
  });

  it("restore() rolls back so the first-turn prefix is sent again", () => {
    const repo = mkdtempSync(join(tmpdir(), "ds-forge-tc-rollback-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "RULE-A");

    const tc = new TurnContext({ cwd: repo, agentsMd: true, includeEnvironment: true });
    const snap = tc.snapshot();
    const first = tc.prefixForTurn(repo);
    expect(first).toHaveLength(1);

    // Simulate an aborted turn: context was rolled back, now roll the
    // turn-context state back too.
    tc.restore(snap);
    expect(tc.prefixForTurn(repo)).toEqual(first);

    // Steady state after the re-sent prefix: nothing further.
    expect(tc.prefixForTurn(repo)).toEqual([]);
  });
  it("restore + pending agents + env change emits both blocks", () => {
    const a = mkdtempSync(join(tmpdir(), "ds-forge-tc-br-a-"));
    const b = mkdtempSync(join(tmpdir(), "ds-forge-tc-br-b-"));
    for (const d of [a, b]) {
      mkdirSync(join(d, ".git"), { recursive: true });
      writeFileSync(join(d, "AGENTS.md"), "RULE-A");
    }

    const tc = new TurnContext({ cwd: a, agentsMd: true, includeEnvironment: true });
    tc.restoreFromMessages([
      { role: "user", content: renderEnvironmentContext(captureEnvironment(a)) },
      { role: "user", content: "hi" },
    ]);

    const msgs = tc.prefixForTurn(b);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(AGENTS_MD_INSTRUCTIONS_MARKER);
    expect(msgs[0]).toContain("RULE-A");
    expect(msgs[0]).toContain(ENVIRONMENT_CONTEXT_OPEN);
    expect(msgs[0]).toContain(`<cwd>${b}</cwd>`);
  });

  it("includeEnvironment=false emits agents without environment", () => {
    const repo = mkdtempSync(join(tmpdir(), "ds-forge-tc-noenv-"));
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "AGENTS.md"), "RULE-A");

    const tc = new TurnContext({ cwd: repo, agentsMd: true, includeEnvironment: false });
    const msgs = tc.prefixForTurn(repo);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(AGENTS_MD_INSTRUCTIONS_MARKER);
    expect(msgs[0]).toContain("RULE-A");
    expect(msgs[0]).not.toContain(ENVIRONMENT_CONTEXT_OPEN);

    // Steady state stays empty.
    expect(tc.prefixForTurn(repo)).toEqual([]);
  });
});
