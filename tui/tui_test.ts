#!/usr/bin/env npx tsx
/**
 * TUI test suite — pure logic only, no Ink render, no API calls.
 *
 * Run:
 * Run: npm run test (via root test suite)
 */

import assert from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSession } from "../src/agent-session.js";
import { Forge } from "../src/forge.js";
import { parseUsage, parseUsageLog } from "../src/usage.js";
import { messagesForApi, messageFromDict } from "../src/context.js";
import type { StreamEvent } from "../src/types.js";
import { chatReducer, visibleHistory, MAX_VISIBLE_MESSAGES } from "./chat-state.js";
import { applyEvent, formatToolCommand, formatToolStatus } from "./display.js";
import { historyFromContext } from "./history.js";
import { fileUrl, linkText } from "./links.js";
import {
  reduceKey,
  isModifiedEnterInput,
  isCsiPlainEnterInput,
  inputContainsCsiPlainEnter,
  normalizeTextInput,
  textToInsertAtCursor,
  wrapLines,
  cursorVisualRow,
  type InputKey,
} from "./app.js";
// Direct file path bypasses ink's exports map (only "." is exported). Lets the
// test feed real Ink-parsed keystrokes through reduceKey — genuine end-to-end.
import parseKeypress, {
  nonAlphanumericKeys,
} from "../node_modules/ink/build/parse-keypress.js";

const VERBOSE = !!process.env.TUI_TEST_VERBOSE;
const TEST_KEY = "test-key";
const TEST_CWD = "/tmp/ds-forge-tui-test";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void | Promise<void>) {
  return async () => {
    try {
      await fn();
      passed++;
      if (VERBOSE) console.log(`  ✓ ${name}`);
    } catch (e) {
      failed++;
      console.error(`\n  ✗ FAIL [${name}]`);
      console.error(`    ${(e as Error).message}`);
    }
  };
}

const emptyTurn = () => ({ content: "", tools: [] as Array<{ id: string; name: string; args: string; result?: string; running: boolean }> });

function test_applyEvent_stream_lifecycle() {
  let turn = emptyTurn();
  turn = applyEvent(turn, { type: "text_delta", delta: "Hello" });
  turn = applyEvent(turn, { type: "text_delta", delta: " world" });
  assert.equal(turn.content, "Hello world");

  turn = applyEvent(turn, {
    type: "tool_call_start",
    id: "c1",
    name: "bash",
    arguments: '{"command":"ls"}',
  });
  assert.equal(turn.tools.length, 1);
  assert.equal(turn.tools[0]!.running, true);

  turn = applyEvent(turn, { type: "tool_result", id: "c1", name: "bash", result: "a\nb\n" });
  assert.equal(turn.tools[0]!.running, false);
  assert.equal(turn.tools[0]!.result, "a\nb\n");
}

function test_applyEvent_ignores_turn_done() {
  const turn = emptyTurn();
  const next = applyEvent(turn, { type: "turn_done", content: "ignored" });
  assert.deepEqual(next, turn);
}

function test_chatReducer_complete_turn_clears_live() {
  let state = chatReducer({ history: [], live: { content: "partial", tools: [] } }, {
    type: "complete_turn",
    message: { role: "assistant", content: "done", tools: [] },
  });
  assert.equal(state.live, null);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0]?.role, "assistant");
}

function test_stream_to_history_no_duplicate_live() {
  // Simulates turn completion: live must not coexist with history entry.
  const events: StreamEvent[] = [
    { type: "text_delta", delta: "Answer" },
    { type: "tool_call_start", id: "t1", name: "bash", arguments: '{"command":"pwd"}' },
    { type: "tool_result", id: "t1", name: "bash", result: TEST_CWD },
  ];

  let state = chatReducer({ history: [], live: null }, { type: "add_user", content: "where?" });
  let turn = emptyTurn();
  for (const ev of events) turn = applyEvent(turn, ev);
  state = chatReducer(state, {
    type: "complete_turn",
    message: { role: "assistant", content: turn.content, tools: turn.tools },
  });

  assert.equal(state.live, null);
  assert.equal(state.history.length, 2);
  const assistant = state.history[1];
  assert.equal(assistant?.role, "assistant");
  assert.equal(assistant?.role === "assistant" && assistant.tools[0]?.name, "bash");
}

function test_formatToolStatus_collapses_multiline() {
  assert.equal(formatToolStatus("line1\nline2\nline3", false), "✓ 3 lines");
  assert.equal(formatToolStatus("/short", false), "✓ /short");
  assert.equal(formatToolStatus(undefined, true), "…");
}

function test_formatToolCommand_bash_json() {
  assert.equal(formatToolCommand("bash", '{"command":"git status"}'), "git status");
}

function test_historyFromContext() {
  const history = historyFromContext([
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
    },
    { role: "tool", content: "ok", tool_call_id: "c1", name: "bash" },
    { role: "assistant", content: "done" },
  ]);

  assert.equal(history.length, 3);
  assert.equal(history[0]?.role, "user");
  assert.equal(history[1]?.role, "assistant");
  assert.equal(history[1]?.role === "assistant" && history[1].tools[0]?.result, "ok");
  assert.equal(history[2]?.role === "assistant" && history[2].content, "done");
}

function test_visibleHistory_caps() {
  const history = Array.from({ length: MAX_VISIBLE_MESSAGES + 5 }, (_, i) => ({
    role: "user" as const,
    content: String(i),
  }));
  const { hidden, items } = visibleHistory(history);
  assert.equal(hidden, 5);
  assert.equal(items.length, MAX_VISIBLE_MESSAGES);
  assert.equal(items[0]?.content, "5");
}

function test_terminal_links() {
  const path = "/Users/me/project";
  assert.equal(fileUrl(path), "file:///Users/me/project");
  const linked = linkText(fileUrl(path), path);
  assert.ok(linked.includes("file:///Users/me/project"));
  assert.ok(linked.includes(path));

  const spaced = "/Users/me/my project/foo#bar";
  assert.equal(fileUrl(spaced), "file:///Users/me/my%20project/foo%23bar");
}

function test_agentSession_clear_keeps_custom_system() {
  const session = AgentSession.open({
    apiKey: TEST_KEY,
    cwd: TEST_CWD,
    system: "CUSTOM_SYSTEM",
    tools: [],
  });
  session.forge.context.addUser("hello");
  session.clear();
  assert.equal(session.system, "CUSTOM_SYSTEM");
  assert.equal(session.forge.context.messages[0]?.content, "CUSTOM_SYSTEM");
  assert.equal(session.forge.context.messages.length, 1);
}

function test_messagesForApi_reasoning_only_assistant() {
  const api = messagesForApi([
    { role: "user", content: "你好" },
    {
      role: "assistant",
      reasoning_content: "你好！有什么可以帮你的吗？",
    },
    { role: "user", content: "看看仓库" },
  ]);
  const assistant = api[1]!;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.content, "你好！有什么可以帮你的吗？");
  assert.equal(assistant.reasoning_content, undefined);
}

function test_historyFromContext_reasoning_only_assistant() {
  const history = historyFromContext([
    { role: "user", content: "你好" },
    {
      role: "assistant",
      reasoning_content: "你好！有什么可以帮你的吗？",
    },
  ]);
  assert.equal(history.length, 2);
  assert.equal(history[1]?.role, "assistant");
  assert.match(history[1]?.content ?? "", /你好/);
}

function test_messageFromDict_promotes_reasoning_only() {
  const m = messageFromDict({
    role: "assistant",
    reasoning_content: "reply text",
  });
  assert.equal(m.content, "reply text");
  assert.equal(m.reasoning_content, undefined);
}

function test_agentSession_resume_reasoning_effort() {
  const trajDir = mkdtempSync(join(tmpdir(), "ds-forge-traj-"));
  const prev = process.env.DS_FORGE_DIR;
  process.env.DS_FORGE_DIR = trajDir;

  try {
    const trajPath = join(trajDir, "resume-effort.json");
    writeFileSync(
      trajPath,
      JSON.stringify({
        version: "0.1.0",
        model: "deepseek-v4-flash",
        system: "test",
        tools: [],
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
    );

    const off = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: trajPath,
      reasoningEffort: "off",
      tools: [],
    });
    assert.equal(off.forge.reasoningEffort, "off");

    const max = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: trajPath,
      reasoningEffort: "max",
      tools: [],
    });
    assert.equal(max.forge.reasoningEffort, "max");
  } finally {
    if (prev === undefined) delete process.env.DS_FORGE_DIR;
    else process.env.DS_FORGE_DIR = prev;
  }
}

function test_parseUsage_cache_fields() {
  const rec = parseUsage(
    {
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 200,
    },
    0,
  );
  assert.ok(rec);
  assert.equal(rec.prompt_cache_hit_tokens, 800);
  assert.equal(rec.prompt_cache_miss_tokens, 200);
  assert.equal(rec.turn, 0);
}

function test_session_usage_log_round_trip() {
  const path = join(tmpdir(), `ds-forge-usage-${Date.now()}.json`);
  const created = "2026-06-01T00:00:00.000Z";
  const usageLog = [
    {
      turn: 0,
      at: "2026-06-01T00:01:00.000Z",
      prompt_tokens: 500,
      completion_tokens: 10,
      total_tokens: 510,
      prompt_cache_hit_tokens: 400,
      prompt_cache_miss_tokens: 100,
    },
  ];
  writeFileSync(
    path,
    JSON.stringify({
      version: "0.1.0",
      model: "deepseek-v4-flash",
      system: "test",
      tools: [],
      messages: [{ role: "system", content: "test" }],
      metadata: { created_at: created, message_count: 1, usage_log: usageLog },
    }),
  );

  const forge = Forge.load(path, { apiKey: TEST_KEY });
  assert.equal(forge.usageLog.length, 1);
  assert.equal(forge.usageLog[0]?.prompt_cache_hit_tokens, 400);
  assert.equal(forge.createdAt, created);

  forge.save(path);
  const saved = JSON.parse(readFileSync(path, "utf-8"));
  assert.equal("system" in saved, false);
  assert.deepEqual(saved.messages, [{ role: "system", content: "test" }]);
  assert.equal(saved.metadata.created_at, created);
  assert.equal(saved.metadata.usage_log.length, 1);
  assert.equal(
    parseUsageLog(saved.metadata.usage_log)[0]?.prompt_cache_miss_tokens,
    100,
  );
}

function test_agentSession_clear_resets_usage_log() {
  const session = AgentSession.open({
    apiKey: TEST_KEY,
    cwd: TEST_CWD,
    system: "CUSTOM",
    tools: [],
  });
  session.forge.usageLog.push(
    parseUsage(
      {
        prompt_tokens: 1,
        completion_tokens: 1,
        total_tokens: 2,
        prompt_cache_hit_tokens: 0,
        prompt_cache_miss_tokens: 1,
      },
      0,
    )!,
  );
  session.clear();
  assert.equal(session.forge.usageLog.length, 0);
}

function test_agentSession_fork_new_trajectory() {
  const trajDir = mkdtempSync(join(tmpdir(), "ds-forge-fork-"));
  const prev = process.env.DS_FORGE_DIR;
  process.env.DS_FORGE_DIR = trajDir;

  try {
    const source = join(trajDir, "source.json");
    writeFileSync(
      source,
      JSON.stringify({
        version: "0.1.0",
        model: "deepseek-chat",
        tools: [],
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
        ],
        metadata: {},
      }),
    );

    const forked = AgentSession.fork(source, { apiKey: TEST_KEY, cwd: TEST_CWD, tools: [] });
    assert.notEqual(forked.trajPath, source);
    assert.equal(forked.forge.context.messages.length, 2);

    forked.forge.context.addAssistant("reply");
    forked.save();

    const unchanged = JSON.parse(readFileSync(source, "utf-8"));
    assert.equal(unchanged.messages.length, 2);
    assert.equal(unchanged.messages[1]?.content, "hi");
  } finally {
    if (prev === undefined) delete process.env.DS_FORGE_DIR;
    else process.env.DS_FORGE_DIR = prev;
  }
}

function test_agentSession_turnContext_rollback_reinjects_agents() {
  const trajDir = mkdtempSync(join(tmpdir(), "ds-forge-tc-rollback-"));
  const repo = join(trajDir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "ROLLBACK-RULE");
  const prev = process.env.DS_FORGE_DIR;
  process.env.DS_FORGE_DIR = trajDir;

  try {
    const session = AgentSession.open({ apiKey: TEST_KEY, cwd: repo, agentsMd: true });
    const ctxSnap = session.forge.context.snapshot();
    const tcSnap = session.snapshotTurnContext();

    session.prepareUserTurn("go");
    assert.ok(
      session.forge.context.messages.some(
        (m) => m.role === "user" && m.content?.includes("ROLLBACK-RULE"),
      ),
      "first turn carries AGENTS.md",
    );

    // Simulate an aborted turn: roll back both the context and the standing
    // prefix state so the next submit re-sends AGENTS.md.
    session.forge.context.restore(ctxSnap);
    session.restoreTurnContext(tcSnap);

    session.prepareUserTurn("again");
    const prefix = session.forge.context.messages.find(
      (m) => m.role === "user" && m.content?.includes("ROLLBACK-RULE"),
    );
    assert.ok(prefix, "AGENTS.md re-injected after abort rollback");
  } finally {
    if (prev === undefined) delete process.env.DS_FORGE_DIR;
    else process.env.DS_FORGE_DIR = prev;
  }
}

function test_agentSession_resume_newly_enabled_agentsMd() {
  const trajDir = mkdtempSync(join(tmpdir(), "ds-forge-resume-agents-"));
  const repo = join(trajDir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "RESUME-RULE");
  const prev = process.env.DS_FORGE_DIR;
  process.env.DS_FORGE_DIR = trajDir;

  try {
    // Trajectory from a session that ran WITHOUT agentsMd: env prefix only.
    const source = join(trajDir, "old.json");
    const envBlock = `<environment_context>\n  <cwd>${repo}</cwd>\n  <shell>sh</shell>\n  <current_date>2026-08-03</current_date>\n  <timezone>Asia/Shanghai</timezone>\n</environment_context>`;
    writeFileSync(
      source,
      JSON.stringify({
        version: "0.1.0",
        model: "deepseek-chat",
        tools: [],
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: envBlock },
          { role: "user", content: "hi" },
        ],
        metadata: {},
      }),
    );

    // Resume with agentsMd newly enabled: AGENTS.md must still be injected.
    const session = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: repo,
      resume: source,
      agentsMd: true,
      tools: [],
    });
    session.prepareUserTurn("go");
    const prefix = session.forge.context.messages.find(
      (m) => m.role === "user" && m.content?.includes("RESUME-RULE"),
    );
    assert.ok(prefix, "AGENTS.md injected after resume with newly-enabled agentsMd");

    // And it must not be sent again on the next turn.
    session.prepareUserTurn("again");
    const agentsCount = session.forge.context.messages.filter(
      (m) => m.role === "user" && m.content?.includes("RESUME-RULE"),
    ).length;
    assert.equal(agentsCount, 1, "AGENTS.md not duplicated on steady turns");
  } finally {
    if (prev === undefined) delete process.env.DS_FORGE_DIR;
    else process.env.DS_FORGE_DIR = prev;
  }
}

function test_agentSession_resume_system_override() {
  const trajDir = mkdtempSync(join(tmpdir(), "ds-forge-traj-"));
  const prev = process.env.DS_FORGE_DIR;
  process.env.DS_FORGE_DIR = trajDir;

  try {
    const trajPath = join(trajDir, "resume-test.json");
    writeFileSync(
      trajPath,
      JSON.stringify({
        version: "0.1.0",
        model: "deepseek-chat",
        system: "OLD_SYSTEM",
        tools: [],
        messages: [
          { role: "system", content: "OLD_SYSTEM" },
          { role: "user", content: "hi" },
        ],
        metadata: {},
      }),
    );

    const session = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: trajPath,
      system: "OVERRIDE",
      tools: [],
    });

    assert.equal(session.system, "OVERRIDE");
    assert.equal(session.forge.context.messages[0]?.content, "OVERRIDE");
  } finally {
    if (prev === undefined) delete process.env.DS_FORGE_DIR;
    else process.env.DS_FORGE_DIR = prev;
  }
}

function test_agentSession_resume_system_syncs_scope_note() {
  const trajDir = mkdtempSync(join(tmpdir(), "ds-forge-resume-sys-"));
  const prev = process.env.DS_FORGE_DIR;
  process.env.DS_FORGE_DIR = trajDir;

  try {
    // Trajectory whose system prompt predates the scope note.
    const trajPath = join(trajDir, "t.json");
    writeFileSync(
      trajPath,
      JSON.stringify({
        version: "0.1.0",
        model: "deepseek-chat",
        tools: [],
        messages: [
          { role: "system", content: "OLD_SYSTEM" },
          { role: "user", content: "hi" },
        ],
        metadata: {},
      }),
    );

    // Override + agentsMd: context system must equal session.system (note in).
    const withOverride = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: trajPath,
      agentsMd: true,
      system: "OVERRIDE",
      tools: [],
    });
    assert.equal(withOverride.forge.context.messages[0]?.content, withOverride.system);
    assert.ok(withOverride.system.includes("# AGENTS.md scope"));

    // No override: trajectory system preserved, note still composed in.
    const noOverride = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: trajPath,
      agentsMd: true,
      tools: [],
    });
    assert.ok(noOverride.system.startsWith("OLD_SYSTEM"));
    assert.ok(noOverride.system.includes("# AGENTS.md scope"));
    assert.equal(noOverride.forge.context.messages[0]?.content, noOverride.system);

    // System-less trajectory: default coding agent injected, not left empty.
    const syslessPath = join(trajDir, "no-sys.json");
    writeFileSync(
      syslessPath,
      JSON.stringify({
        version: "0.1.0",
        model: "deepseek-chat",
        tools: [],
        messages: [{ role: "user", content: "hi" }],
        metadata: {},
      }),
    );
    const sysless = AgentSession.open({
      apiKey: TEST_KEY,
      cwd: TEST_CWD,
      resume: syslessPath,
      tools: [],
    });
    assert.equal(sysless.forge.context.messages[0]?.role, "system");
    assert.equal(sysless.forge.context.messages[0]?.content, sysless.system);
    assert.ok(sysless.system.includes("AI coding agent"));
  } finally {
    if (prev === undefined) delete process.env.DS_FORGE_DIR;
    else process.env.DS_FORGE_DIR = prev;
  }
}

/** Replicate Ink useInput's (input, key) construction from a raw byte sequence. */
function inkInput(bytes: string): { input: string; key: InputKey } {
  const kp = parseKeypress(Buffer.from(bytes));
  const key: InputKey = {
    upArrow: kp.name === "up",
    downArrow: kp.name === "down",
    leftArrow: kp.name === "left",
    rightArrow: kp.name === "right",
    return: kp.name === "return",
    escape: kp.name === "escape",
    ctrl: kp.ctrl,
    shift: kp.shift,
    tab: kp.name === "tab",
    backspace: kp.name === "backspace",
    delete: kp.name === "delete",
    meta: kp.meta || kp.name === "escape" || (kp as { option?: boolean }).option,
  };
  let input = kp.ctrl ? kp.name : kp.sequence;
  if (nonAlphanumericKeys.includes(kp.name)) input = "";
  if (input.startsWith("\u001B")) input = input.slice(1);
  return { input, key };
}

function feed(value: string, cursor: number, bytes: string) {
  const { input, key } = inkInput(bytes);
  return reduceKey(value, cursor, input, key);
}

/** The core bug: Option+Enter must insert a newline, not submit, not a bare CR. */
function test_multiline_option_enter_inserts_newline() {
  let value = "";
  let cursor = 0;
  for (const ch of "ab") {
    const r = feed(value, cursor, ch);
    value = r.value;
    cursor = r.cursor;
  }
  assert.equal(value, "ab");

  // Option+Enter = ESC + CR. Ink reports return:false and input:"\r".
  const oe = feed(value, cursor, "\x1b\r");
  assert.equal(oe.submit, false, "Option+Enter must NOT submit");
  assert.equal(oe.value, "ab\n", "Option+Enter must insert a real newline (not \\r)");
  value = oe.value;
  cursor = oe.cursor;

  for (const ch of "cd") {
    const r = feed(value, cursor, ch);
    value = r.value;
    cursor = r.cursor;
  }
  assert.equal(value, "ab\ncd");

  // Plain Enter submits, value untouched.
  const ent = feed(value, cursor, "\r");
  assert.equal(ent.submit, true, "plain Enter submits");
  assert.equal(ent.value, "ab\ncd");
}

function test_multiline_strips_stray_control_chars() {
  // Two Option+Enter presses batched into one chunk arrive as "\r\x1b\r".
  const r = reduceKey("", 0, "\r\u001b\r", {});
  assert.equal(r.value, "\n\n", "CRs become newlines, stray ESC dropped");
  assert.equal(r.submit, false);
  // A bare ESC in the input must not insert anything.
  const e = reduceKey("ab", 2, "\u001b", {});
  assert.equal(e.value, "ab");
}

function test_multiline_paste_and_backspace() {
  const paste = feed("", 0, "x\r\ny"); // CRLF in a paste
  assert.equal(paste.value, "x\ny", "CRLF normalized to one newline");
  assert.equal(paste.submit, false);

  const bs = feed("ab", 2, "\x08"); // backspace
  assert.equal(bs.value, "a");
  assert.equal(bs.cursor, 1);

  const delAtEnd = feed("ab", 2, "\x7f"); // macOS Backspace (Ink names it delete)
  assert.equal(delAtEnd.value, "a");
  assert.equal(delAtEnd.cursor, 1);

  const delAtStart = feed("ab", 0, "\x7f");
  assert.equal(delAtStart.value, "ab");
  assert.equal(delAtStart.cursor, 0);
}

function test_multiline_shift_enter_csi_u() {
  assert.equal(isModifiedEnterInput("[13;2u"), true);
  assert.equal(isModifiedEnterInput("\x1b[13;2u"), true);
  assert.equal(isModifiedEnterInput("[13;3u"), true, "Alt+Enter CSI-u");
  assert.equal(isModifiedEnterInput("[13;1u"), false, "modifier 1 is not Shift+Enter");
  assert.equal(isModifiedEnterInput("[13u"), false);
  assert.equal(isModifiedEnterInput("ab"), false);

  assert.equal(isCsiPlainEnterInput("[13;1u"), true);
  assert.equal(isCsiPlainEnterInput("[13u"), true);
  assert.equal(normalizeTextInput("line1\x1b[13;2uline2"), "line1\nline2");
  assert.equal(textToInsertAtCursor("line1", 5, "line1\x1b[13;2uline2"), "\nline2");
  assert.equal(textToInsertAtCursor("abc", 3, "abcdef"), "abcdef", "paste keeps full text");

  assert.equal(inputContainsCsiPlainEnter("hello\x1b[13;1u"), true);

  const plain = reduceKey("draft", 5, "\x1b[13;1u", {});
  assert.equal(plain.submit, true, "CSI-u plain Enter submits");
  assert.equal(plain.value, "draft");

  const batchedPlain = reduceKey("", 0, "hello\x1b[13;1u", {});
  assert.equal(batchedPlain.value, "hello");
  assert.equal(batchedPlain.submit, true, "batched CSI-u plain Enter inserts then submits");

  const echoPlain = reduceKey("line1", 5, "line1\x1b[13;1u", {});
  assert.equal(echoPlain.value, "line1");
  assert.equal(echoPlain.submit, true);

  const r = feed("line1", 5, "\x1b[13;2u");
  assert.equal(r.submit, false, "CSI-u Shift+Enter must not submit");
  assert.equal(r.value, "line1\n", "CSI-u Shift+Enter inserts newline");
  assert.equal(r.cursor, 6);

  const batched = reduceKey("line1", 5, "line1\x1b[13;2uline2", {});
  assert.equal(batched.value, "line1\nline2", "batched chunk embeds CSI-u as newline");
  assert.equal(batched.cursor, 11);

  const suffixOnly = reduceKey("line1", 5, "\x1b[13;2uline2", {});
  assert.equal(suffixOnly.value, "line1\nline2");

  const paste = reduceKey("abc", 3, "abcdef", {});
  assert.equal(paste.value, "abcabcdef");
  assert.equal(paste.cursor, 9);

  const literalMod = reduceKey("", 0, "foo[13;2ubar", {});
  assert.equal(literalMod.value, "foo[13;2ubar", "literal [13;2u in paste is not CSI-u");
  assert.equal(literalMod.submit, false);

  const literalPlain = reduceKey("", 0, "foo[13u", {});
  assert.equal(literalPlain.value, "foo[13u");
  assert.equal(literalPlain.submit, false);
}

function test_wrapLines() {
  const rows = wrapLines(["abcdef"], 3);
  assert.deepEqual(rows.map((r) => r.text), ["abc", "def"]);
  assert.deepEqual(rows.map((r) => r.start), [0, 3]);

  // width 4 fits exactly two double-width CJK chars per row
  const z = wrapLines(["\u4f60\u597d\u4e16\u754c"], 4);
  assert.deepEqual(z.map((r) => r.text), ["\u4f60\u597d", "\u4e16\u754c"]);

  // empty logical lines survive as their own row
  const e = wrapLines(["a", "", "b"], 10);
  assert.equal(e.length, 3);
  assert.deepEqual(e.map((r) => r.line), [0, 1, 2]);
}

function test_cursorVisualRow() {
  const rows = wrapLines(["abcdef"], 3); // ["abc"@0, "def"@3]
  assert.equal(cursorVisualRow(rows, 0, 0), 0);
  assert.equal(cursorVisualRow(rows, 0, 2), 0);
  assert.equal(cursorVisualRow(rows, 0, 3), 1, "boundary moves to wrapped row");
  assert.equal(cursorVisualRow(rows, 0, 6), 1, "end of line stays on last row");

  const multi = wrapLines(["ab", "cdefgh"], 3); // ["ab"@0(l0), "cde"@0(l1), "fgh"@3(l1)]
  assert.equal(cursorVisualRow(multi, 1, 0), 1);
  assert.equal(cursorVisualRow(multi, 1, 4), 2);
}

async function main() {
  console.log("TUI Test Suite\n");

  await check("applyEvent stream lifecycle", test_applyEvent_stream_lifecycle)();
  await check("applyEvent ignores turn_done", test_applyEvent_ignores_turn_done)();
  await check("complete_turn clears live", test_chatReducer_complete_turn_clears_live)();
  await check("stream → history leaves no live", test_stream_to_history_no_duplicate_live)();
  await check("formatToolStatus collapses multiline", test_formatToolStatus_collapses_multiline)();
  await check("formatToolCommand bash JSON", test_formatToolCommand_bash_json)();
  await check("historyFromContext", test_historyFromContext)();
  await check("visibleHistory caps", test_visibleHistory_caps)();
  await check("multiline Option+Enter inserts newline", test_multiline_option_enter_inserts_newline)();
  await check("multiline paste CRLF + backspace/delete", test_multiline_paste_and_backspace)();
  await check("multiline Shift+Enter CSI-u", test_multiline_shift_enter_csi_u)();
  await check("multiline strips stray control chars", test_multiline_strips_stray_control_chars)();
  await check("wrapLines splits by width", test_wrapLines)();
  await check("cursorVisualRow mapping", test_cursorVisualRow)();
  await check("terminal OSC 8 links", test_terminal_links)();
  await check("AgentSession.clear keeps custom system", test_agentSession_clear_keeps_custom_system)();
  await check("messagesForApi reasoning-only assistant", test_messagesForApi_reasoning_only_assistant)();
  await check("historyFromContext reasoning-only assistant", test_historyFromContext_reasoning_only_assistant)();
  await check("messageFromDict promotes reasoning-only", test_messageFromDict_promotes_reasoning_only)();
  await check("AgentSession resume reasoningEffort", test_agentSession_resume_reasoning_effort)();
  await check("AgentSession.fork new trajectory", test_agentSession_fork_new_trajectory)();
  await check("AgentSession turnContext rollback re-injects AGENTS.md", test_agentSession_turnContext_rollback_reinjects_agents)();
  await check("AgentSession resume newly-enabled agentsMd", test_agentSession_resume_newly_enabled_agentsMd)();
  await check("AgentSession resume system syncs scope note", test_agentSession_resume_system_syncs_scope_note)();
  await check("AgentSession resume+system override", test_agentSession_resume_system_override)();
  await check("parseUsage cache fields", test_parseUsage_cache_fields)();
  await check("session usage_log round-trip", test_session_usage_log_round_trip)();
  await check("AgentSession.clear resets usage_log", test_agentSession_clear_resets_usage_log)();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
