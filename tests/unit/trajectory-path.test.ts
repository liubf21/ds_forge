import { describe, expect, it } from "vitest";
import { createTrajectoryPath } from "../../src/agent-session.js";

describe("createTrajectoryPath", () => {
  it("returns unique paths when called in parallel", () => {
    const paths = Array.from({ length: 20 }, () => createTrajectoryPath());
    expect(new Set(paths).size).toBe(20);
  });

  it("includes a random suffix after the timestamp", () => {
    const path = createTrajectoryPath();
    expect(path).toMatch(/task-\d{4}-\d{2}-\d{2}T[\d-]+Z-[0-9a-f]{8}\.json$/);
  });
});
