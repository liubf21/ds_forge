/**
 * Model-visible environment snapshot (Codex-style `<environment_context>`).
 *
 * Injected on the first user turn and again only when cwd/shell/date/timezone
 * change — appended to history without rebuilding the earlier prefix.
 */

import { basename, resolve } from "node:path";

export const ENVIRONMENT_CONTEXT_OPEN = "<environment_context>";
export const ENVIRONMENT_CONTEXT_CLOSE = "</environment_context>";

export interface EnvironmentSnapshot {
  cwd: string;
  shell: string;
  currentDate: string;
  timezone: string;
}

/** Capture the current process environment for model context. */
export function captureEnvironment(cwd: string): EnvironmentSnapshot {
  const shellPath = process.env.SHELL ?? "";
  const shell = shellPath ? basename(shellPath) : "sh";
  return {
    cwd: resolve(cwd),
    shell,
    currentDate: new Date().toISOString().slice(0, 10),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Render a full environment_context block. */
export function renderEnvironmentContext(snapshot: EnvironmentSnapshot): string {
  return `${ENVIRONMENT_CONTEXT_OPEN}
  <cwd>${escapeXml(snapshot.cwd)}</cwd>
  <shell>${escapeXml(snapshot.shell)}</shell>
  <current_date>${snapshot.currentDate}</current_date>
  <timezone>${escapeXml(snapshot.timezone)}</timezone>
${ENVIRONMENT_CONTEXT_CLOSE}`;
}

export function environmentSnapshotEqual(
  a: EnvironmentSnapshot,
  b: EnvironmentSnapshot,
): boolean {
  return (
    a.cwd === b.cwd
    && a.shell === b.shell
    && a.currentDate === b.currentDate
    && a.timezone === b.timezone
  );
}

/** Parse the last `<cwd>` from a stored environment_context user message. */
export function parseEnvironmentSnapshot(text: string): EnvironmentSnapshot | null {
  if (!text.includes(ENVIRONMENT_CONTEXT_OPEN)) return null;
  const cwd = text.match(/<cwd>([^<]*)<\/cwd>/)?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
  if (!cwd) return null;
  const shell = text.match(/<shell>([^<]*)<\/shell>/)?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'") ?? "sh";
  const currentDate = text.match(/<current_date>([^<]*)<\/current_date>/)?.[1]
    ?? new Date().toISOString().slice(0, 10);
  const timezone = text.match(/<timezone>([^<]*)<\/timezone>/)?.[1]
    ?.replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { cwd, shell, currentDate, timezone };
}
