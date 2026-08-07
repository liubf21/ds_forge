import { describe, expect, it } from "vitest";
import {
  captureEnvironment,
  environmentSnapshotEqual,
  parseEnvironmentSnapshot,
  renderEnvironmentContext,
} from "../../src/environment-context.js";

describe("environment-context", () => {
  it("renders cwd and shell in XML block", () => {
    const snap = captureEnvironment("/tmp/proj");
    const text = renderEnvironmentContext(snap);
    expect(text).toContain("<cwd>/tmp/proj</cwd>");
    expect(text).toContain("<shell>");
    expect(text).toContain("<current_date>");
    expect(text).toContain("<timezone>");
  });

  it("round-trips parseEnvironmentSnapshot", () => {
    const snap = captureEnvironment("/tmp/a");
    const parsed = parseEnvironmentSnapshot(renderEnvironmentContext(snap));
    expect(parsed?.cwd).toBe(snap.cwd);
    expect(parsed?.shell).toBe(snap.shell);
  });

  it("environmentSnapshotEqual detects cwd change", () => {
    const a = captureEnvironment("/a");
    const b = captureEnvironment("/b");
    expect(environmentSnapshotEqual(a, a)).toBe(true);
    expect(environmentSnapshotEqual(a, b)).toBe(false);
  });
});
