import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SampleRunRecord {
  index: number;
  content: string;
  trajPath: string;
  ms: number;
  totalTokens: number;
  hash: string;
}

export interface SampleManifest {
  group_id: string;
  n: number;
  prompt: string | null;
  resume_from: string | null;
  template: string | null;
  model: string;
  reasoning_effort: string;
  tools: string[];
  unique_outputs: number;
  runs: Array<{
    index: number;
    traj: string;
    ms: number;
    total_tokens: number;
    content_hash: string;
    markdown: string;
  }>;
}

function replicaMarkdown(run: SampleRunRecord): string {
  return [
    "---",
    `replica: ${run.index + 1}`,
    `ms: ${run.ms}`,
    `tokens: ${run.totalTokens}`,
    `hash: ${run.hash}`,
    `trajectory: ${run.trajPath}`,
    "---",
    "",
    run.content,
  ].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface HtmlRun {
  index: number;
  ms: number;
  total_tokens: number;
  content_hash: string;
  content: string;
}

/**
 * Normalize model-emitted LaTeX before Markdown parsing.
 *
 * `marked({ breaks: true })` turns newlines into <br> elements, while KaTeX's
 * auto-renderer only matches delimiters within one text node. Collapse display
 * math whose delimiters occupy their own lines so it survives that boundary.
 * A lone `$ ... $` block is treated as display math; inline `$...$` is kept.
 */
export function normalizeMathDelimiters(content: string): string {
  const normalized = content
    .replaceAll("\\[", "$$")
    .replaceAll("\\]", "$$")
    .replaceAll("\\(", "$")
    .replaceAll("\\)", "$");
  const lines = normalized.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const delimiter = lines[i]!.trim();
    if (delimiter === "$" || delimiter === "$$") {
      let end = i + 1;
      while (end < lines.length && lines[end]!.trim() !== delimiter) end++;
      if (end < lines.length) {
        const formula = lines.slice(i + 1, end).join(" ").trim();
        out.push(`$$${formula}$$`);
        i = end;
        continue;
      }
    }
    out.push(lines[i]!);
  }

  return out.join("\n");
}

/** Self-contained three-column comparison page (marked.js from CDN). */
export function renderCompareHtml(manifest: SampleManifest, runs: SampleRunRecord[]): string {
  const prompt = manifest.prompt ?? "(continue from fork — no new user message)";
  const htmlRuns: HtmlRun[] = runs.map((r) => ({
    index: r.index,
    ms: r.ms,
    total_tokens: r.totalTokens,
    content_hash: r.hash,
    content: normalizeMathDelimiters(r.content),
  }));
  // This JSON is embedded in a <script> element. Escape "<" so untrusted model
  // output cannot terminate the element with </script> and inject markup.
  const serializedRuns = JSON.stringify(htmlRuns).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sample ${escapeHtml(manifest.group_id)}</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css" />
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/auto-render.min.js"></script>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0f1115;
      --panel: #1a1d24;
      --border: #2a2f3a;
      --text: #e6e8ec;
      --muted: #8b929e;
      --accent: #6ea8fe;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f4f5f7;
        --panel: #fff;
        --border: #dde1e8;
        --text: #1a1d24;
        --muted: #5c6370;
        --accent: #2563eb;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    .page { max-width: 100%; padding: 1rem 1.25rem 2rem; }
    .meta {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.25rem;
      margin-bottom: 1rem;
    }
    .meta h1 { margin: 0 0 .5rem; font-size: 1.1rem; }
    .meta dl { display: flex; flex-wrap: wrap; gap: .75rem 1.5rem; margin: 0; font-size: .85rem; color: var(--muted); }
    .meta dt { display: inline; font-weight: 600; color: var(--text); }
    .meta dd { display: inline; margin: 0; }
    .prompt {
      margin-top: .75rem;
      padding: .75rem;
      background: var(--bg);
      border-radius: 6px;
      white-space: pre-wrap;
      font-size: .9rem;
    }
    .stability { margin-top: .5rem; font-size: .85rem; }
    .stability strong { color: var(--accent); }
    .grid {
      display: grid;
      grid-template-columns: repeat(${manifest.n}, minmax(0, 1fr));
      gap: .75rem;
      align-items: start;
    }
    @media (max-width: 1100px) {
      .grid { grid-template-columns: 1fr; }
    }
    .col {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      min-height: 50vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .col-head {
      padding: .75rem 1rem;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    .col-head h2 { margin: 0 0 .35rem; font-size: .95rem; }
    .col-head dl { display: flex; flex-wrap: wrap; gap: .35rem .9rem; margin: 0; font-size: .75rem; color: var(--muted); }
    .col-head dt { display: inline; font-weight: 600; }
    .col-head dd { display: inline; margin: 0; }
    .col-head code { font-size: .7rem; word-break: break-all; }
    .col-body {
      padding: 1rem 1.1rem 1.5rem;
      overflow-y: auto;
      max-height: calc(100vh - 14rem);
      flex: 1;
    }
    .markdown :first-child { margin-top: 0; }
    .markdown h1, .markdown h2, .markdown h3 { line-height: 1.3; margin: 1.1em 0 .5em; }
    .markdown h1 { font-size: 1.15em; }
    .markdown h2 { font-size: 1.05em; }
    .markdown table { border-collapse: collapse; width: 100%; font-size: .85rem; margin: .75rem 0; }
    .markdown th, .markdown td { border: 1px solid var(--border); padding: .35rem .5rem; text-align: left; }
    .markdown th { background: var(--bg); }
    .toolbar {
      display: flex;
      gap: .5rem;
      margin-bottom: .75rem;
      font-size: .8rem;
    }
    .toolbar label { display: flex; align-items: center; gap: .35rem; color: var(--muted); cursor: pointer; }
  </style>
</head>
<body>
  <div class="page">
    <div class="meta">
      <h1>Stability sample · ${escapeHtml(manifest.group_id)}</h1>
      <dl>
        <div><dt>model</dt><dd>${escapeHtml(manifest.model)}</dd></div>
        <div><dt>effort</dt><dd>${escapeHtml(manifest.reasoning_effort)}</dd></div>
        <div><dt>tools</dt><dd>${escapeHtml(manifest.tools.length ? manifest.tools.join(", ") : "(none)")}</dd></div>
        ${manifest.template ? `<div><dt>template</dt><dd>${escapeHtml(manifest.template)}</dd></div>` : ""}
        ${manifest.resume_from ? `<div><dt>fork</dt><dd>${escapeHtml(manifest.resume_from)}</dd></div>` : ""}
      </dl>
      <div class="prompt">${escapeHtml(prompt)}</div>
      <p class="stability"><strong>${manifest.unique_outputs}/${manifest.n}</strong> unique outputs</p>
    </div>
    <div class="toolbar">
      <label><input type="checkbox" id="sync-scroll" checked /> Sync scroll</label>
    </div>
    <div class="grid" id="grid"></div>
  </div>
  <script id="runs-data" type="application/json">${serializedRuns}</script>
  <script>
    const runs = JSON.parse(document.getElementById("runs-data").textContent);
    const grid = document.getElementById("grid");
    const bodies = [];
    const escapeRawHtml = (text) => text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    for (const r of runs) {
      const col = document.createElement("section");
      col.className = "col";
      col.innerHTML = \`
        <header class="col-head">
          <h2>Replica \${r.index + 1}</h2>
          <dl>
            <div><dt>time</dt><dd>\${(r.ms / 1000).toFixed(1)}s</dd></div>
            <div><dt>tokens</dt><dd>\${r.total_tokens.toLocaleString()}</dd></div>
            <div><dt>hash</dt><dd><code>\${r.content_hash}</code></dd></div>
          </dl>
        </header>
        <article class="col-body markdown"></article>\`;
      const body = col.querySelector(".markdown");
      // Keep Markdown formatting, but do not let model-authored raw HTML create
      // executable DOM nodes or event handlers.
      body.innerHTML = marked.parse(escapeRawHtml(r.content), { breaks: true });
      renderMathInElement(body, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
        strict: false,
      });
      grid.appendChild(col);
      bodies.push(col.querySelector(".col-body"));
    }
    const sync = document.getElementById("sync-scroll");
    let locking = false;
    bodies.forEach((src) => {
      src.addEventListener("scroll", () => {
        if (!sync.checked || locking) return;
        locking = true;
        const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
        bodies.forEach((dst) => {
          if (dst !== src) {
            dst.scrollTop = ratio * Math.max(0, dst.scrollHeight - dst.clientHeight);
          }
        });
        locking = false;
      });
    });
  </script>
</body>
</html>`;
}

/** Write replica markdown files, manifest copy, and compare.html into outDir. */
export function writeSampleArtifacts(
  outDir: string,
  manifest: SampleManifest,
  runs: SampleRunRecord[],
): { manifestPath: string; comparePath: string; markdownPaths: string[] } {
  mkdirSync(outDir, { recursive: true });

  const markdownPaths: string[] = [];
  for (const run of runs) {
    const name = `replica-${run.index + 1}.md`;
    const path = join(outDir, name);
    writeFileSync(path, replicaMarkdown(run), "utf-8");
    markdownPaths.push(path);
    const mRun = manifest.runs.find((r) => r.index === run.index);
    if (mRun) mRun.markdown = name;
  }

  const manifestPath = join(outDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const comparePath = join(outDir, "compare.html");
  writeFileSync(comparePath, renderCompareHtml(manifest, runs), "utf-8");

  return { manifestPath, comparePath, markdownPaths };
}
