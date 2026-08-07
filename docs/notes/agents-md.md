# AGENTS.md 支持设计笔记

> 状态：已实现（`src/agents-md.ts` + Forge/AgentSession 集成 + 10 个单测）

## 一、它是不是业界标准？是

| 维度 | 现状 |
|------|------|
| 起源 | OpenAI 2025-08 为 Codex 推出 |
| 治理 | 2025-12 捐给 Linux 基金会旗下 **Agentic AI Foundation (AAIF)**，与 MCP、goose 并列 |
| 采用 | 6 万+ 项目；Codex / Cursor / Devin / Factory / Gemini CLI / GitHub Copilot / Jules / VS Code |
| 形态 | **纯 Markdown，无强制 schema**，就是「给 agent 看的 README」 |

行为约定（非语法）：根目录/子目录均可放；**就近覆盖**（离被编辑文件最近的优先）；用户对话指令 > 文件；老格式靠 symlink 兼容。

## 二、Skill vs AGENTS.md —— 为什么集成方式不同

| | Skill | AGENTS.md |
|---|-------|-----------|
| 性质 | 按需加载的能力包 | 常驻项目记忆 |
| 触发 | 模型调用 `skill` 工具（渐进式披露） | 启动时发现并注入 system |
| 机制 | 注册一个 tool | 读盘 → 拼进 system prompt |

二者互补，不重叠。

## 三、实现（`src/agents-md.ts`，约 120 行）

```
findAgentsMd({cwd, includeProject, global}) → 按显式 scope 收集 AGENTS.md
                               顺序 general→specific（root 在前，最近的在后=权重最高）
agentsMdSection(docs, cwd)   → 拼成 system prompt 段落，每块带 <!-- 相对路径 --> 标注来源/作用域
loadAgentsMd(opts)           → 二者合一，无文件时返回 ""
```

关键边界决策：
- **git root 为上界**：找到含 `.git` 的最近祖先即停；无 git 时只看 cwd，**绝不向上乱爬**到无关父目录。
- **空文件跳过**；读盘异常吞掉返回 null（健壮）。

## 四、集成（两个入口，一个 loader）

| 入口 | 类型 | 默认 | 理由 |
|------|------|------|------|
| `Forge.agentsMd` | `boolean \| AgentsMdOptions` | **关** | 库不该未经请求就读盘 |
| `AgentSession.agentsMd` | `boolean \| AgentsMdOptions` | **关** | prompt scope 必须显式授权 |
| TUI `--agents` | flag | **关** | 显式开启项目 AGENTS.md |
| TUI `--global-agents` | flag | **关** | 显式开启 global AGENTS.md |

想用 global-only AGENTS.md：`new Forge({ agentsMd: { global: true, includeProject: false } })` /
`AgentSession.open({ agentsMd: { global: true, includeProject: false } })` / `npm run tui -- --global-agents`。
global 路径固定为 `~/.agents/AGENTS.md`（测试可用 `DS_FORGE_AGENTS_HOME` 指向临时目录）。

- `Forge`：构造时 `loadAgentsMd` → 注入 `[system, agents, skillsCatalog]`。`Forge.load`（resume）不重注，因为存档的 system 已烘焙进去。
- `AgentSession`：在 **session 层** `composeSystem(base, cwd)` 算好完整 system 再传给 Forge，并存为 `_system` —— 这样 `clear()` 重置后能正确恢复带 AGENTS.md 的 system（若交给 Forge 注入，clear 会丢）。

## 五、global 默认 false —— 一次被测试抓到的越界

最初把 global 默认 true，结果 TUI 的 `AgentSession.clear keeps custom system` 用例挂了：
本机存在全局 AGENTS.md，被我顺手读进了 system，破坏了精确断言。

教训 & 修正：读盘并注入 prompt 必须显式授权。Forge、AgentSession、TUI 的 AGENTS scopes
都默认关闭；项目和 global 分别开启，也可以组合。

## 五·补 ds-forge 约定（最小集，已实现）

global 仍默认关；开启后采用 ds-forge 自己的统一 `~/.agents` 约定：

| 项 | 行为 |
|----|------|
| `AGENTS.override.md` 每目录优先 | 每个目录先找 `AGENTS.override.md`，无则 `AGENTS.md`，每目录最多一份（`DOC_NAMES` 顺序） |
| global AGENTS.md | `~/.agents/AGENTS.md`；`AGENTS.override.md` 同样优先 |
| 32 KiB 截断 | `maxBytes` 默认 `DEFAULT_AGENTS_MD_MAX_BYTES = 32*1024`，超限截断**尾部**（最近的 doc），按 UTF-8 码点边界回退，附 `[truncated]` 标记 |

**要读的目录（速查）**：① 全局 `~/.agents`（opt-in）② git root → cwd 链上每个目录，各取 override→base 一份 ③ root→leaf 拼接、近者覆盖、32KiB 封顶。

仍**刻意不做**：global 默认开（越界读他人配置）、fallback 文件名（`CLAUDE.md` 等，scope creep）。

## 六·补 TurnContext + environment_context（2026-06-25，Codex 对齐）

| 模块 | 职责 |
|------|------|
| `environment-context.ts` | `<environment_context>`：cwd、shell、date、timezone |
| `turn-context.ts` | 首轮 AGENTS.md + env；稳态仅 env diff；resume 从 history 恢复 baseline |
| `system.ts` | `AGENTS_MD_SCOPE_NOTE`（agentsMd 开时）；cwd 移出 system |
| `AgentSession.run` / `runStream` | 每轮 `prepareUserTurn` 再调 Forge |

- cwd 不变 → 不重发 env；cwd 变 → **追加** env diff（不重建前缀）
- AGENTS.md session 首轮注入，cwd 变更不重读（同 Codex）
- `clear()` 重置 TurnContext，下轮重新注入首轮 prefix
- TUI 改走 `session.runStream`

## 七、验证

`examples/agents_md_test.ts`，15 用例：默认零 scope、空/缺失、git 边界向上走、无 git 不乱爬、空文件跳过、
section 格式与优先级、`AGENTS.override.md` 每目录优先、global `~/.agents` + override、32KiB 截断、
Forge 注入（默认关）、AgentSession 显式开启 + clear 轮回、AgentSession 默认关闭。
接入 `npm test`；当前新增的 AGENTS.md / skills / TUI 用例可独立运行验证。
