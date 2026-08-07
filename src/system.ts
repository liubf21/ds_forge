/**
 * AGENTS.md scope semantics (from Codex base instructions).
 * Teaches the model to honor nested files beyond the auto-injected cwd chain.
 */
export const AGENTS_MD_SCOPE_NOTE = `# AGENTS.md scope
- Each AGENTS.md applies to the directory tree rooted at the folder that contains it.
- For every file you touch, obey instructions in any AGENTS.md whose scope includes that file.
- Repo root through cwd chain instructions are injected on the first turn; do not re-read them.
- When editing outside that chain or in a deeper subdirectory, read applicable AGENTS.md files yourself.`;

/** Default system prompt for coding agents (TUI, examples/agent.ts). */
export function codingAgentSystem(opts?: { agentsScope?: boolean }): string {
  const parts = [
    `You are an AI coding agent with shell access via the 'bash' tool.

Guidelines:
- Use the bash tool to run commands. Think before executing.
- Read files with cat, list with ls, search with grep, etc.
- Be careful with destructive commands (rm, mv, etc.).
- Be concise in your replies.
- Current working directory is provided in <environment_context> on each turn when it changes.`,
  ];
  if (opts?.agentsScope) parts.push(AGENTS_MD_SCOPE_NOTE);
  return parts.join("\n\n");
}
