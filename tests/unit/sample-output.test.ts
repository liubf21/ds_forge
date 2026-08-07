import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  normalizeMathDelimiters,
  renderCompareHtml,
  writeSampleArtifacts,
  type SampleManifest,
} from "../../src/sample-output.js";

const manifest: SampleManifest = {
  group_id: "test-group",
  n: 2,
  prompt: "hello",
  resume_from: null,
  template: "divination",
  model: "deepseek-v4-flash",
  reasoning_effort: "high",
  tools: [],
  unique_outputs: 2,
  runs: [
    {
      index: 0,
      traj: "/tmp/a.json",
      ms: 1000,
      total_tokens: 100,
      content_hash: "aaa",
      markdown: "replica-1.md",
    },
    {
      index: 1,
      traj: "/tmp/b.json",
      ms: 2000,
      total_tokens: 200,
      content_hash: "bbb",
      markdown: "replica-2.md",
    },
  ],
};

const runs = [
  { index: 0, content: "## A\n\nfirst", trajPath: "/tmp/a.json", ms: 1000, totalTokens: 100, hash: "aaa" },
  { index: 1, content: "## B\n\nsecond", trajPath: "/tmp/b.json", ms: 2000, totalTokens: 200, hash: "bbb" },
];

describe("writeSampleArtifacts", () => {
  it("writes markdown files and compare.html", () => {
    const out = mkdtempSync(join(tmpdir(), "ds-forge-sample-"));
    const { comparePath, markdownPaths } = writeSampleArtifacts(out, structuredClone(manifest), runs);

    expect(markdownPaths).toHaveLength(2);
    expect(readFileSync(markdownPaths[0]!, "utf-8")).toContain("## A");
    expect(readFileSync(comparePath, "utf-8")).toContain('"content":"## A\\n\\nfirst"');
    expect(readFileSync(comparePath, "utf-8")).toContain("Sync scroll");
  });
});

describe("renderCompareHtml", () => {
  it("embeds run content as JSON for client-side render", () => {
    const html = renderCompareHtml(manifest, runs);
    expect(html).toContain('"content":"## A\\n\\nfirst"');
    expect(html).toContain("Sync scroll");
    expect(html).toContain('grid-template-columns: repeat(2');
    expect(html).toContain("katex@0.16.22");
    expect(html).toContain("renderMathInElement(body");
  });

  it("does not let model output terminate the data script or render raw HTML", () => {
    const hostileRuns = [{
      ...runs[0]!,
      content: '</script><script>globalThis.pwned = true</script>\n<img src=x onerror="alert(1)">',
    }];
    const html = renderCompareHtml({ ...manifest, n: 1 }, hostileRuns);

    expect(html).not.toContain('"content":"</script>');
    expect(html).toContain('"content":"\\u003c/script>\\u003cscript>');
    expect(html).toContain("marked.parse(escapeRawHtml(r.content)");
  });
});

describe("normalizeMathDelimiters", () => {
  it("collapses lone-dollar display math into one KaTeX text node", () => {
    const input = "$\nE[T] = \\frac{1}{p}\n$";
    expect(normalizeMathDelimiters(input)).toBe("$$E[T] = \\frac{1}{p}$$");
  });

  it("normalizes bracket delimiters and preserves inline dollar math", () => {
    expect(normalizeMathDelimiters("inline $p=0.3$\n\\[\nx^2\n\\]")).toBe(
      "inline $p=0.3$\n$$x^2$$",
    );
  });
});
