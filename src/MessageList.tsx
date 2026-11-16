import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import { invoke } from "@tauri-apps/api/core";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { CodeBlock } from "./CodeBlock";
import { copyText } from "./clipboard";
import { formatJsonText } from "./jsonFormat";
import { previewJson } from "./preview";
import { codeBlockFromChildren } from "./codeFence";
import { TableBlock, Td, Th } from "./TableBlock";
import { DiffBlock } from "./DiffBlock";

export type Msg = {
  index: number;
  /** Rust 侧唯一键(uuid#block), 查找/跳转用; index 是行号, 同一行多个 block 会重复 */
  key: string;
  kind:
    | "user"
    | "assistant"
    | "thinking"
    | "tool_use"
    | "tool_result"
    | "system"
    | "image";
  timestamp: string;
  text: string;
  toolName?: string;
  toolId?: string;
  input?: unknown;
  agentId?: string;
  isError: boolean;
  depth: number;
  children: Msg[];
};

export type AgentMeta = {
  agentId: string;
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
  finished: boolean;
  jsonlPath: string;
  size: number;
};

export type Transcript = {
  sessionId: string;
  messages: Msg[];
  messageCount: number;
  truncated: boolean;
};

function clock(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function humanSize(bytes: number): string {
  if (!bytes) return "0B";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

/** 工具调用的输入摘要: 取最有辨识度的那个字段 */
export function inputSummary(name: string | undefined, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const prefer: Record<string, string[]> = {
    Bash: ["command"],
    Read: ["file_path"],
    Write: ["file_path"],
    Edit: ["file_path"],
    MultiEdit: ["file_path"],
    NotebookEdit: ["notebook_path"],
    Grep: ["pattern"],
    Glob: ["pattern"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    Task: ["description"],
    Agent: ["description"],
    Skill: ["skill"],
  };
  const keys = (name && prefer[name]) || ["command", "file_path", "pattern", "url", "query", "description", "skill"];
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v) {
      return v.length > 160 ? v.slice(0, 160) + "…" : v;
    }
  }
  return "";
}

/** subagent 对话: 按需加载, 409M 的 agent transcript 不能一次全读 */
function AgentBlock({ agent }: { agent: AgentMeta }) {
  const [state, setState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [data, setData] = useState<Transcript | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = async () => {
    if (state === "loaded" || state === "loading") return;
    setState("loading");
    try {
      const inTauri = "__TAURI_INTERNALS__" in window;
      const t = inTauri
        ? await invoke<Transcript>("read_agent", { path: agent.jsonlPath })
        : await previewJson<Transcript>(
            `/api/transcript?path=${encodeURIComponent(agent.jsonlPath)}`,
            "/agent.json",
          );
      setData(t);
      setState("loaded");
    } catch (e) {
      setErr(String(e));
      setState("error");
    }
  };

  return (
    <div className="agent">
      <div className="lbl">subagent</div>
      <div className="agent-head">
        <span className="agent-type">{agent.agentType || "agent"}</span>
        <span className="agent-desc">{agent.description || "(无描述)"}</span>
        <span className="tool-meta">
          {agent.finished ? "已完成" : "运行中"} · {humanSize(agent.size)}
        </span>
      </div>
      <button
        className="btn agent-load"
        onClick={async () => {
          const next = !open;
          setOpen(next);
          if (next) await load();
        }}
      >
        {state === "loading"
          ? "加载中…"
          : state === "loaded"
            ? open
              ? "收起 subagent 对话"
              : "展开 subagent 对话"
            : "展开 subagent 对话"}
      </button>
      {state === "error" && <div className="error">{err}</div>}
      {state === "loaded" && data && open && (
        <div className="agent-body">
          <div className="lbl">
            {data.messageCount} 条消息{data.truncated ? " (已截断)" : ""}
          </div>
          <MessageList messages={data.messages} nested />
        </div>
      )}
    </div>
  );
}

/** 工具输入/输出旁的轻量复制按钮 */
function CopyBtn({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mini-btn"
      title="复制"
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? "✓ 已复制" : "复制"}
    </button>
  );
}

/** 工具输入: 对象直接缩进; 字符串若是 JSON 也格式化, 否则原样 */
function ToolInput({ input }: { input: unknown }) {
  const text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
  const formatted = typeof input === "string" ? formatJsonText(text) : text;
  const raw =
    input && typeof input === "object"
      ? (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).notebook_path
      : undefined;
  const revealPath =
    typeof raw === "string" && raw.startsWith("/") && "__TAURI_INTERNALS__" in window ? raw : null;
  return (
    <>
      <div className="lbl-row">
        <div className="lbl">输入</div>
        <div className="lbl-actions">
          {revealPath && (
            <button
              type="button"
              className="mini-btn"
              title="在 Finder 中显示"
              onClick={() => {
                void revealItemInDir(revealPath).catch(() => {});
              }}
            >
              在 Finder 显示
            </button>
          )}
          <CopyBtn text={text} />
        </div>
      </div>
      {formatted ? <CodeBlock code={formatted} lang="json" /> : <pre className="out">{text}</pre>}
    </>
  );
}

function ToolBlock({
  m,
  agents,
  forceOpen,
}: {
  m: Msg;
  agents: Map<string, AgentMeta>;
  forceOpen?: Set<string>;
}) {
  const summary = inputSummary(m.toolName, m.input);
  const results = m.children.filter((c) => c.kind === "tool_result");
  const hasError = results.some((r) => r.isError);
  const [open, setOpen] = useState(false);
  const agent = m.agentId ? agents.get(m.agentId) : undefined;

  useEffect(() => {
    if (forceOpen?.has(m.key)) setOpen(true);
  }, [forceOpen, m.key]);

  return (
    <>
      <details
        id={`m${m.index}`}
        data-key={m.key}
        className={`msg tool${hasError ? " error" : ""}`}
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          <span className="caret">▸</span>
          <span className="tool-name">{m.toolName ?? "tool"}</span>
          {summary && <span className="tool-arg">{summary}</span>}
          {agent && <span className="agent-badge">subagent</span>}
          {results.length > 0 && (
            <span className="tool-meta">
              {hasError ? "ERROR" : `${results[0].text.length} 字符`}
            </span>
          )}
        </summary>
        {open && (
          <div className="tool-body">
            {m.input !== undefined && m.input !== null && <ToolInput input={m.input} />}
            {results.map((r) => (
              <div
                key={r.key}
                data-key={r.key}
                className={r.isError ? "tool-out error" : "tool-out"}
              >
                <div className="lbl-row">
                  <div className={`lbl${r.isError ? " err" : ""}`}>
                    输出{r.isError ? " (错误)" : ""}
                  </div>
                  <CopyBtn text={r.text} />
                </div>
                <DiffBlock text={r.text} />
              </div>
            ))}
            {agent && <AgentBlock agent={agent} />}
          </div>
        )}
      </details>
      <LooseChildren m={m} agents={agents} forceOpen={forceOpen} />
    </>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkCjkFriendly]}
      components={{
        a: ({ href, children, ...rest }) => {
          const external = !!href && /^https?:/i.test(href);
          return (
            <a
              {...rest}
              href={href}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => {
                if (!external || !("__TAURI_INTERNALS__" in window)) return;
                e.preventDefault();
                void openUrl(href).catch(() => window.open(href, "_blank"));
              }}
            >
              {children}
            </a>
          );
        },
        pre: ({ children }) => {
          const block = codeBlockFromChildren(children);
          return block ? <CodeBlock code={block.code} lang={block.lang} /> : <pre>{children}</pre>;
        },
        table: (p) => <TableBlock {...p} />,
        td: (p) => <Td {...p} />,
        th: (p) => <Th {...p} />,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** thinking 折叠态不挂载 markdown: 210 份解析结果不必在收起时就存在 */
function ThinkingBlock({
  m,
  agents,
  forceOpen,
}: {
  m: Msg;
  agents?: Map<string, AgentMeta>;
  forceOpen?: Set<string>;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (forceOpen?.has(m.key)) setOpen(true);
  }, [forceOpen, m.key]);

  return (
    <>
      <details
        id={`m${m.index}`}
        data-key={m.key}
        className="msg thinking"
        open={open}
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary>
          <span className="think-mark" aria-hidden="true">◇</span>
          <span className="think-label">思考</span>
          <span className="think-meta">{m.text.length} 字符</span>
        </summary>
        {open && (
          <div className="bubble plain">
            <Markdown text={m.text} />
          </div>
        )}
      </details>
      {/* loose children 必须渲染在 details 外: 收起时 details 会隐藏 summary
          以外的全部内容, 挂在里面会导致链在思考下的正式回答 / tool_use 整段不可见;
          展开时则会被包进思考卡片 */}
      <LooseChildren m={m} agents={agents} forceOpen={forceOpen} />
    </>
  );
}

/** 按 parentUuid 挂进 children 的非配对节点(轮次小结 / away 摘要等),
    各渲染分支原本只挑 tool_result, 会把它们静默丢掉 */
function LooseChildren({
  m,
  agents,
  forceOpen,
}: {
  m: Msg;
  agents?: Map<string, AgentMeta>;
  forceOpen?: Set<string>;
}) {
  const extras = m.children.filter((c) => c.kind !== "tool_result");
  if (extras.length === 0) return null;
  const amap = agents ?? new Map<string, AgentMeta>();
  return (
    <>
      {extras.map((c) => (
        <Node key={c.key} m={c} agents={amap} forceOpen={forceOpen} />
      ))}
    </>
  );
}

function Node({
  m,
  agents,
  forceOpen,
}: {
  m: Msg;
  agents: Map<string, AgentMeta>;
  forceOpen?: Set<string>;
}) {
  const t = clock(m.timestamp);
  switch (m.kind) {
    case "user":
      return (
        <div id={`m${m.index}`} data-key={m.key} className="msg user">
          <div className="who">
            <span>你</span>
            <span className="ts">{t}</span>
          </div>
          <div className="bubble">
            <Markdown text={m.text} />
          </div>
          <LooseChildren m={m} agents={agents} forceOpen={forceOpen} />
        </div>
      );
    case "assistant":
      return (
        <div id={`m${m.index}`} data-key={m.key} className="msg assistant">
          <div className="who">
            <span>Claude</span>
            <span className="ts">{t}</span>
          </div>
          <div className="bubble">
            <Markdown text={m.text} />
          </div>
          <LooseChildren m={m} agents={agents} forceOpen={forceOpen} />
        </div>
      );
    case "thinking":
      return <ThinkingBlock m={m} agents={agents} forceOpen={forceOpen} />;
    case "tool_use":
      return <ToolBlock m={m} agents={agents} forceOpen={forceOpen} />;
    case "tool_result":
      return (
        <div
          id={`m${m.index}`}
          data-key={m.key}
          className={`msg tool-result${m.isError ? " error" : ""}`}
        >
          <div className="lbl-row">
            <div className={`lbl${m.isError ? " err" : ""}`}>
              结果{m.isError ? " (错误)" : ""}
            </div>
            <CopyBtn text={m.text} />
          </div>
          <DiffBlock text={m.text} />
          <LooseChildren m={m} agents={agents} forceOpen={forceOpen} />
        </div>
      );
    case "image":
      return (
        <div id={`m${m.index}`} data-key={m.key} className="msg image">
          <div className="who">
            <span>你</span>
            <span className="ts">{t}</span>
          </div>
          <div className="bubble image-bubble">图片消息</div>
        </div>
      );
    case "system":
      // Rust 侧已把无 content 的系统事件合成摘要; 仍为空的直接不渲染, 不留空白卡片
      if (!m.text.trim()) return null;
      return (
        <div id={`m${m.index}`} data-key={m.key} className="msg system">
          <div className="who">
            <span>system</span>
            <span className="ts">{t}</span>
          </div>
          <div className="bubble plain">{m.text}</div>
          <LooseChildren m={m} agents={agents} forceOpen={forceOpen} />
        </div>
      );
    default:
      return null;
  }
}

function MessageList({
  messages,
  agents,
  nested,
  forceOpen,
}: {
  messages: Msg[];
  agents?: Map<string, AgentMeta>;
  nested?: boolean;
  forceOpen?: Set<string>;
}) {
  if (messages.length === 0) {
    return <div className="empty-note">这个会话没有可渲染的消息</div>;
  }
  const amap = agents ?? new Map<string, AgentMeta>();
  return (
    <div className={nested ? "msglist nested" : "msglist"}>
      {messages.map((m) => (
        <Node key={m.key} m={m} agents={amap} forceOpen={forceOpen} />
      ))}
    </div>
  );
}

export default memo(MessageList);
