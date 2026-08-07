import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { AgentSession } from "../src/agent-session.js";
import { trajectoryLabel } from "../src/agent-session.js";
import { MAX_TURNS_REACHED } from "../src/defaults.js";
import { AssistantBubble, FileLink, UserBubble } from "./components.js";
import { chatReducer, visibleHistory } from "./chat-state.js";
import { applyEvent } from "./display.js";
import { historyFromContext } from "./history.js";
import type { LiveTurn } from "./types.js";

/** Merge rapid stream deltas so Ink doesn't erase/repaint every token. */
const LIVE_UPDATE_MS = 50;

interface Props {
  session: AgentSession;
  maxTurns: number;
}

interface InputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder?: string;
  focus?: boolean;
}

interface Pos {
  line: number;
  col: number;
  lines: string[];
}

function offsetToPos(text: string, offset: number): Pos {
  const lines = text.split("\n");
  let off = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  while (line < lines.length - 1 && off > lines[line]!.length) {
    off -= lines[line]!.length + 1;
    line++;
  }
  return { line, col: Math.min(off, lines[line]!.length), lines };
}

function posToOffset(lines: string[], line: number, col: number): number {
  const li = Math.max(0, Math.min(line, lines.length - 1));
  let off = 0;
  for (let i = 0; i < li; i++) off += lines[i]!.length + 1;
  return off + Math.min(col, lines[li]!.length);
}

/** Subset of Ink's Key we care about; all optional so Ink's Key is assignable. */
export type InputKey = {
  return?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
  escape?: boolean;
  tab?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
};

export interface KeyResult {
  value: string;
  cursor: number;
  submit: boolean;
}

/**
 * Embedded CSI-u in a batched chunk — must include ESC. Literal `[13;2u` in paste
 * is left untouched; standalone `[13;2u` / `[13u` is handled via is*EnterInput().
 */
const CSI_MODIFIED_ENTER_EMBED_G = /\x1b\[13;(\d+)u/g;
const CSI_PLAIN_ENTER_EMBED = /\x1b\[13(?:;1)?u/;
const CSI_PLAIN_ENTER_EMBED_G = /\x1b\[13(?:;1)?u/g;

function csiEnterModifierInsertsNewline(mod: string): boolean {
  return Number(mod) > 1;
}

/**
 * True when `input` is only a CSI-u modified Enter (no batched typing).
 * Ink 5 often leaves `input` as `[13;2u` with `key.return=false`.
 */
export function isModifiedEnterInput(input: string): boolean {
  const seq = input.startsWith("\x1b") ? input.slice(1) : input;
  const m = /^\[13;(\d+)u$/.exec(seq);
  return m !== null && csiEnterModifierInsertsNewline(m[1]!);
}

/** Whole chunk is CSI-u plain Enter (`[13;1u` / `[13u`). Map to submit, not insert. */
export function isCsiPlainEnterInput(input: string): boolean {
  const seq = input.startsWith("\x1b") ? input.slice(1) : input;
  return /^\[13;1u$/.test(seq) || /^\[13u$/.test(seq);
}

/** Chunk contains Shift+Enter style CSI-u (modifier > 1), not plain paste text. */
export function inputContainsCsiModifiedNewline(input: string): boolean {
  if (isModifiedEnterInput(input)) return true;
  for (const m of input.matchAll(CSI_MODIFIED_ENTER_EMBED_G)) {
    if (csiEnterModifierInsertsNewline(m[1]!)) return true;
  }
  return false;
}

/** Chunk contains CSI-u plain Enter (whole chunk or batched with typing). */
export function inputContainsCsiPlainEnter(input: string): boolean {
  if (isCsiPlainEnterInput(input)) return true;
  return CSI_PLAIN_ENTER_EMBED.test(input);
}

/**
 * Normalize a possibly batched stdin chunk: embedded CSI-u Shift+Enter → `\n`,
 * CRLF → `\n`, stray C0 controls dropped. Plain `[13;1u` left to isCsiPlainEnterInput.
 */
export function normalizeTextInput(input: string): string {
  if (isModifiedEnterInput(input)) return "\n";
  if (isCsiPlainEnterInput(input)) return "";

  return input
    .replace(CSI_MODIFIED_ENTER_EMBED_G, (_m, mod: string) =>
      csiEnterModifierInsertsNewline(mod) ? "\n" : "",
    )
    .replace(CSI_PLAIN_ENTER_EMBED_G, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f]/g, "");
}

/**
 * Text to insert at cursor. Echoed-prefix stripping runs only when the raw chunk
 * contains CSI-u modified Enter (PTY batching); normal paste is untouched.
 */
export function textToInsertAtCursor(value: string, cursor: number, input: string): string {
  const text = normalizeTextInput(input);
  if (!text) return "";
  if (!inputContainsCsiModifiedNewline(input) && !inputContainsCsiPlainEnter(input)) {
    return text;
  }
  const left = value.slice(0, cursor);
  return text.startsWith(left) ? text.slice(left.length) : text;
}

/**
 * Pure keystroke reducer — the heart of the input, kept side-effect-free so it
 * can be unit-tested by feeding it Ink-parsed keys (see tui_test.ts).
 */
export function reduceKey(
  value: string,
  cursor: number,
  input: string,
  key: InputKey,
): KeyResult {
  const keep: KeyResult = { value, cursor, submit: false };
  const insertAt = (text: string): KeyResult => ({
    value: value.slice(0, cursor) + text + value.slice(cursor),
    cursor: cursor + text.length,
    submit: false,
  });

  if (key.tab) return keep;
  if (key.ctrl && input === "c") return keep; // handled globally (quit)

  // Enter + a newline modifier (kitty / configured iTerm / VS Code report this).
  if (key.return && (key.shift || key.meta)) return insertAt("\n");
  // Plain Enter -> submit.
  if (key.return) return { value, cursor, submit: true };

  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1), submit: false };
  if (key.rightArrow)
    return { value, cursor: Math.min(value.length, cursor + 1), submit: false };

  if (key.upArrow || key.downArrow) {
    const { line, col, lines } = offsetToPos(value, cursor);
    const target = line + (key.upArrow ? -1 : 1);
    if (target < 0 || target > lines.length - 1) return keep;
    return { value, cursor: posToOffset(lines, target, col), submit: false };
  }

  // Ink reports the common DEL byte (`\x7f`, macOS Backspace) as `delete`.
  // Treat both names as backward delete; forward Delete is not distinguishable
  // from Backspace through Ink's public `useInput` key object.
  if (key.backspace || key.delete) {
    if (cursor > 0)
      return {
        value: value.slice(0, cursor - 1) + value.slice(cursor),
        cursor: cursor - 1,
        submit: false,
      };
    return keep;
  }

  if (key.ctrl || key.meta || key.escape) return keep;

  if (input) {
    // Batched chunks may mix typing + CSI-u Enter (newline or submit). Option+Enter
    // arrives as bare CR with ESC stripped.
    const text = textToInsertAtCursor(value, cursor, input);
    if (inputContainsCsiPlainEnter(input)) {
      if (text) {
        const inserted = insertAt(text);
        return { value: inserted.value, cursor: inserted.cursor, submit: true };
      }
      return { value, cursor, submit: true };
    }
    if (text) return insertAt(text);
    return keep;
  }

  return keep;
}

/** Approximate display width: CJK / fullwidth / most emoji are 2 cols, else 1. */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export interface VisualRow {
  text: string;
  /** Logical line index this row belongs to. */
  line: number;
  /** UTF-16 offset within the logical line where this row begins. */
  start: number;
}

/** Soft-wrap logical lines into visual rows no wider than `width` columns. */
export function wrapLines(lines: string[], width: number): VisualRow[] {
  const rows: VisualRow[] = [];
  const w = Math.max(1, width);
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line]!;
    if (text.length === 0) {
      rows.push({ text: "", line, start: 0 });
      continue;
    }
    let cur = "";
    let curW = 0;
    let start = 0;
    let idx = 0;
    for (const ch of text) {
      const cw = charWidth(ch.codePointAt(0)!);
      if (curW + cw > w && cur.length > 0) {
        rows.push({ text: cur, line, start });
        cur = ch;
        curW = cw;
        start = idx;
      } else {
        cur += ch;
        curW += cw;
      }
      idx += ch.length;
    }
    rows.push({ text: cur, line, start });
  }
  return rows;
}

/** Index of the visual row holding the cursor (given its logical line + offset). */
export function cursorVisualRow(
  rows: VisualRow[],
  line: number,
  col: number,
): number {
  let last = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (r.line !== line) continue;
    last = i;
    if (col < r.start + r.text.length) return i;
  }
  return last; // cursor sits at the end of the logical line
}

/**
 * Multi-line text input for Ink.
 *
 * - Enter            → submit
 * - Shift+Enter      → newline (shift+return, or CSI-u `[13;2u` from Cursor/VS Code)
 * - Alt/Option+Enter → newline (reliable fallback in most terminals)
 * - Pasted newlines are kept verbatim (never auto-submit).
 *
 * Replaces ink-text-input, which is single-line and corrupts its display
 * once a "\n" enters the value.
 */
function MultilineInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  focus = true,
}: InputProps) {
  const { stdout } = useStdout();

  // Single synchronous source of truth. Keeping {value, cursor} in a ref (instead
  // of parent-prop value + local-state cursor) means rapid key events never read a
  // stale closure — otherwise fast typing drops characters and desyncs the cursor,
  // which transiently mis-renders the box.
  const stRef = useRef({ value, cursor: value.length });
  const [, bump] = useState(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  // Pull external value changes (submit clears, /clear, resume) into local state.
  useEffect(() => {
    if (value !== stRef.current.value) {
      stRef.current = {
        value,
        cursor: Math.min(stRef.current.cursor, value.length),
      };
      bump((n) => n + 1);
    }
  }, [value]);

  useInput(
    (input, key) => {
      const s = stRef.current;
      const r = reduceKey(s.value, s.cursor, input, key);
      if (r.submit) {
        onSubmitRef.current(s.value);
        return;
      }
      if (r.value === s.value && r.cursor === s.cursor) return;
      stRef.current = { value: r.value, cursor: r.cursor };
      bump((n) => n + 1);
      if (r.value !== s.value) onChangeRef.current(r.value);
    },
    { isActive: focus },
  );

  const { value: curValue, cursor: curCursor } = stRef.current;

  // Give the input column an EXPLICIT width and pre-wrap text to it (minus 1 col for
  // the end-of-line cursor). Ink then never re-wraps a row, so each <Text> is exactly
  // one visual row: the box height is correct (no border drawn over text) and nothing
  // is truncated to "…". Width is left a little short of the true inner width so the
  // bordered box can never exceed the terminal.
  const colWidth = Math.max(4, (stdout?.columns ?? 80) - 7);
  const wrapWidth = Math.max(1, colWidth - 1);

  if (curValue.length === 0) {
    return (
      <Box flexShrink={0} width={colWidth}>
        <Text inverse> </Text>
        {placeholder ? <Text dimColor>{placeholder}</Text> : null}
      </Box>
    );
  }

  const { line: cLine, col: cCol, lines } = offsetToPos(curValue, curCursor);
  const rows = wrapLines(lines, wrapWidth);
  const cap = Math.max(3, (stdout?.rows ?? 24) - 8);
  const cRow = cursorVisualRow(rows, cLine, cCol);
  const total = rows.length;
  const start = Math.min(Math.max(0, cRow - cap + 1), Math.max(0, total - cap));
  const end = Math.min(total, start + cap);
  const above = start;
  const below = total - end;

  return (
    <Box flexDirection="column" flexShrink={0} width={colWidth}>
      {above > 0 && <Text dimColor>{`\u2191 ${above} more above`}</Text>}
      {rows.slice(start, end).map((r, idx) => {
        const i = start + idx;
        if (i !== cRow) {
          return (
            <Text key={i} wrap="wrap">
              {r.text.length === 0 ? " " : r.text}
            </Text>
          );
        }
        const within = cCol - r.start;
        const ch = r.text[within] ?? " ";
        return (
          <Text key={i} wrap="wrap">
            {r.text.slice(0, within)}
            <Text inverse>{ch}</Text>
            {r.text.slice(within + 1)}
          </Text>
        );
      })}
      {below > 0 && <Text dimColor>{`\u2193 ${below} more below`}</Text>}
    </Box>
  );
}

export default function App({ session, maxTurns }: Props) {
  const { exit } = useApp();
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const [{ history, live }, dispatch] = useReducer(chatReducer, undefined, () => ({
    history: historyFromContext(session.forge.context.messages),
    live: null as LiveTurn | null,
  }));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [trajLabel, setTrajLabel] = useState(() => trajectoryLabel(session.trajPath));
  const [showAll, setShowAll] = useState(false);
  const busyRef = useRef(false);
  const abortCtrlRef = useRef<AbortController | null>(null);
  const lastInputRef = useRef("");
  const pendingLiveRef = useRef<LiveTurn | null>(null);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushLive = useCallback(() => {
    if (liveTimerRef.current) {
      clearTimeout(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    const turn = pendingLiveRef.current;
    if (turn) {
      pendingLiveRef.current = null;
      dispatch({ type: "live_update", turn });
    }
  }, []);

  const scheduleLive = useCallback(
    (turn: LiveTurn) => {
      pendingLiveRef.current = turn;
      if (liveTimerRef.current) return;
      liveTimerRef.current = setTimeout(() => {
        liveTimerRef.current = null;
        flushLive();
      }, LIVE_UPDATE_MS);
    },
    [flushLive],
  );

  const persist = useCallback(() => {
    try {
      sessionRef.current.save();
    } catch (e) {
      setStatus(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const quit = useCallback(() => {
    persist();
    exit();
  }, [persist, exit]);

  useEffect(() => () => {
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    persist();
  }, [persist]);

  const submit = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;

      if (text === "/quit" || text === "/exit") {
        quit();
        return;
      }

      if (text === "/clear") {
        const newPath = sessionRef.current.clear();
        setTrajLabel(trajectoryLabel(newPath));
        pendingLiveRef.current = null;
        if (liveTimerRef.current) {
          clearTimeout(liveTimerRef.current);
          liveTimerRef.current = null;
        }
        dispatch({ type: "reset" });
        setShowAll(false);
        setStatus(`cleared · ${trajectoryLabel(newPath)}`);
        return;
      }

      if (text === "/history") {
        setShowAll((v) => !v);
        setStatus("");
        return;
      }

      const { forge } = sessionRef.current;
      const snapshot = forge.context.snapshot();
      const turnSnapshot = sessionRef.current.snapshotTurnContext();
      const ctrl = new AbortController();
      abortCtrlRef.current = ctrl;
      busyRef.current = true;
      setBusy(true);
      setStatus("");
      lastInputRef.current = text;
      dispatch({ type: "add_user", content: text });
      setInput("");

      let turn: LiveTurn = { content: "", tools: [] };
      pendingLiveRef.current = null;
      if (liveTimerRef.current) {
        clearTimeout(liveTimerRef.current);
        liveTimerRef.current = null;
      }
      dispatch({ type: "live_update", turn });

      try {
        let completed = false;
        for await (const ev of sessionRef.current.runStream(text, maxTurns, undefined, ctrl.signal)) {
          if (ctrl.signal.aborted) break;
          if (ev.type === "error") {
            setStatus(ev.message);
            break;
          }
          if (ev.type === "turn_done") {
            turn = { ...turn, content: ev.content || turn.content };
            completed = true;
            break;
          }
          turn = applyEvent(turn, ev);
          // Coalesce text deltas; paint tool boundaries immediately.
          if (ev.type === "text_delta") {
            scheduleLive({ ...turn });
          } else {
            flushLive();
            dispatch({ type: "live_update", turn: { ...turn } });
          }
        }

        flushLive();
        if (ctrl.signal.aborted) {
          forge.context.restore(snapshot);
          sessionRef.current.restoreTurnContext(turnSnapshot);
          dispatch({ type: "undo_last" });
          setInput(lastInputRef.current);
          setStatus("Aborted — input restored");
        } else if (completed) {
          const hitLimit = turn.content === MAX_TURNS_REACHED;
          dispatch({
            type: "complete_turn",
            message: { role: "assistant", content: turn.content, tools: turn.tools },
          });
          if (hitLimit) {
            setStatus("Max turns reached — send a message to continue");
          }
        } else {
          dispatch({ type: "live_clear" });
        }
      } catch (e) {
        flushLive();
        if (ctrl.signal.aborted) {
          forge.context.restore(snapshot);
          sessionRef.current.restoreTurnContext(turnSnapshot);
          dispatch({ type: "undo_last" });
          setInput(lastInputRef.current);
          setStatus("Aborted — input restored");
        } else {
          dispatch({ type: "live_clear" });
          setStatus(e instanceof Error ? e.message : String(e));
        }
      } finally {
        abortCtrlRef.current = null;
        busyRef.current = false;
        setBusy(false);
        persist();
      }
    },
    [quit, maxTurns, persist, scheduleLive, flushLive],
  );

  const undo = useCallback(() => {
    const { forge } = sessionRef.current;
    const msgs = forge.context.messages;
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role !== "user") i--;
    if (i < 0) return;
    const undoneText = msgs[i].content ?? "";
    forge.context.restore(msgs.slice(0, i));
    dispatch({ type: "undo_last" });
    setInput(undoneText);
    setStatus("Undone — edit and resend");
    persist();
  }, [persist]);

  const DOUBLE_ESC_MS = 500;
  const lastEscRef = useRef(0);

  useInput((_input, key) => {
    if (key.ctrl && _input === "c") quit();
    if (!key.escape) return;

    const now = Date.now();
    const gap = now - lastEscRef.current;
    lastEscRef.current = now;

    if (busyRef.current) {
      if (gap < DOUBLE_ESC_MS) {
        abortCtrlRef.current?.abort();
        setStatus("");
      } else {
        setStatus("Press Esc again to abort");
      }
    } else {
      if (gap < DOUBLE_ESC_MS) {
        undo();
      } else {
        setStatus("Press Esc again to undo");
      }
    }
  });

  const { hidden, items: messages } = visibleHistory(history, showAll);

  return (
    <Box flexDirection="column" height="100%">
      <Box
        flexDirection="column"
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        marginBottom={1}
      >
        <Box justifyContent="space-between">
          <Text bold>ds-forge</Text>
          <FileLink path={session.trajPath} label={trajLabel} />
        </Box>
        <FileLink path={session.cwd} />
      </Box>

      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {history.length === 0 && !live && (
          <Box flexDirection="column" marginBottom={1}>
            <Text dimColor>Agent TUI — type a message to begin</Text>
            <Text dimColor>Esc undo · /clear · /history · /quit</Text>
          </Box>
        )}

        {hidden > 0 && (
          <Box marginBottom={1}>
            <Text dimColor>… {hidden} older messages hidden · /history to expand</Text>
          </Box>
        )}

        {messages.map((msg, i) =>
          msg.role === "user" ? (
            <UserBubble key={`u-${i}`} content={msg.content} />
          ) : (
            <AssistantBubble
              key={`a-${i}`}
              content={msg.content}
              tools={msg.tools}
            />
          ),
        )}

        {live && (
          <AssistantBubble content={live.content} tools={live.tools} streaming />
        )}
      </Box>

      {status && (
        <Box marginBottom={1}>
          <Text color="red">{status}</Text>
        </Box>
      )}

      <Box
        borderStyle="round"
        borderColor={busy ? "gray" : "cyan"}
        paddingX={1}
        flexDirection="column"
      >
        {busy ? (
          <Text dimColor>Agent is thinking… <Text color="gray">(Esc to undo)</Text></Text>
        ) : (
          <Box>
            <Text color="cyan" bold>
              ❯{" "}
            </Text>
            <MultilineInput
              value={input}
              onChange={setInput}
              onSubmit={submit}
              placeholder="Message the agent…"
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
