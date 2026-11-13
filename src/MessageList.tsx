import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke } from "@tauri-apps/api/core";

export type Msg = {
  index: number;
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
function inputSummary(name: string | undefined, input: unknown): string {
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

/** 超长输出: 先给前 1200 行 / 100KB, 点「显示全部」再铺开。
 *  折叠块本身已按需挂载, 这里守的是「展开后仍可能几百 KB」的第二道门。 */
const PREVIEW_LINES = 1200;
const PREVIEW_CHARS = 100 * 1024;

/** diff 文本 -> 带 +/- 着色的行 */
function DiffBlock({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => text.split("\n"), [text]);
  const isDiff = useMemo(() => lines.some((l) => l.startsWith("@@")), [lines]);
  const needsPreview = text.length > PREVIEW_CHARS || lines.length > PREVIEW_LINES;
  const truncated = needsPreview && !expanded;
  const shownLines = truncated ? lines.slice(0, PREVIEW_LINES) : lines;
  const plain = truncated
    ? shownLines.join("\n").slice(0, PREVIEW_CHARS)
    : text;

  return (
    <>
      {isDiff ? (
        <pre className="out diff">
          {shownLines.map((l, i) => {
            const cls = l.startsWith("+")
              ? "dl-add"
              : l.startsWith("-")
                ? "dl-del"
                : l.startsWith("@@")
                  ? "dl-hunk"
                  : "";
            return (
              <div key={i} className={cls}>
                {l || " "}
              </div>
            );
          })}
        </pre>
      ) : (
        <pre className="out">{plain}</pre>
      )}
      {truncated && (
        <div className="out-trunc-note">
          <span>
            仅显示前 {Math.min(PREVIEW_LINES, lines.length)} 行 · 共{" "}
            {lines.length.toLocaleString()} 行 / {text.length.toLocaleString()} 字符
          </span>
          <button className="btn out-more" onClick={() => setExpanded(true)}>
            显示全部
          </button>
        </div>
      )}
    </>
  );
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
        : await fetch("/agent.json").then((r) => {
            if (!r.ok) throw new Error(`agent.json ${r.status}`);
            return r.json();
          });
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

function ToolBlock({ m, agents }: { m: Msg; agents: Map<string, AgentMeta> }) {
  const summary = inputSummary(m.toolName, m.input);
  const results = m.children.filter((c) => c.kind === "tool_result");
  const [open, setOpen] = useState(false);
  const agent = m.agentId ? agents.get(m.agentId) : undefined;

  return (
    <details
      id={`m${m.index}`}
      className="msg tool"
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
            {results[0].isError ? "ERROR" : `${results[0].text.length} 字符`}
          </span>
        )}
      </summary>
      {open && (
        <div className="tool-body">
          {m.input !== undefined && m.input !== null && (
            <>
              <div className="lbl">输入</div>
              <pre className="out">
                {typeof m.input === "string" ? m.input : JSON.stringify(m.input, null, 2)}
              </pre>
            </>
          )}
          {results.map((r) => (
            <div key={r.index}>
              <div className="lbl">输出{r.isError ? " (错误)" : ""}</div>
              <DiffBlock text={r.text} />
            </div>
          ))}
          {agent && <AgentBlock agent={agent} />}
        </div>
      )}
    </details>
  );
}

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        a: (p) => <a {...p} target="_blank" rel="noreferrer" />,
        table: (p) => (
          <div className="table-wrap">
            <table {...p} />
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

/** thinking 折叠态不挂载 markdown: 210 份解析结果不必在收起时就存在 */
function ThinkingBlock({ m, agents }: { m: Msg; agents?: Map<string, AgentMeta> }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      id={`m${m.index}`}
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
      <LooseChildren m={m} agents={agents} />
    </details>
  );
}

/** 按 parentUuid 挂进 children 的非配对节点(轮次小结 / away 摘要等),
    各渲染分支原本只挑 tool_result, 会把它们静默丢掉 */
function LooseChildren({ m, agents }: { m: Msg; agents?: Map<string, AgentMeta> }) {
  const extras = m.children.filter((c) => c.kind !== "tool_result");
  if (extras.length === 0) return null;
  const amap = agents ?? new Map<string, AgentMeta>();
  return (
    <>
      {extras.map((c) => (
        <Node key={c.index} m={c} agents={amap} />
      ))}
    </>
  );
}

function Node({ m, agents }: { m: Msg; agents: Map<string, AgentMeta> }) {
  const t = clock(m.timestamp);
  switch (m.kind) {
    case "user":
      return (
        <div id={`m${m.index}`} className="msg user">
          <div className="who">
            <span>你</span>
            <span className="ts">{t}</span>
          </div>
          <div className="bubble">
            <Markdown text={m.text} />
          </div>
        </div>
      );
    case "assistant":
      return (
        <div id={`m${m.index}`} className="msg assistant">
          <div className="who">
            <span>Claude</span>
            <span className="ts">{t}</span>
          </div>
          <div className="bubble">
            <Markdown text={m.text} />
          </div>
          <LooseChildren m={m} agents={agents} />
        </div>
      );
    case "thinking":
      return <ThinkingBlock m={m} agents={agents} />;
    case "tool_use":
      return <ToolBlock m={m} agents={agents} />;
    case "tool_result":
      return (
        <div id={`m${m.index}`} className="msg tool-result">
          <div className="lbl">结果</div>
          <DiffBlock text={m.text} />
        </div>
      );
    case "image":
      return (
        <div id={`m${m.index}`} className="msg image">
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
        <div id={`m${m.index}`} className="msg system">
          <div className="who">
            <span>system</span>
            <span className="ts">{t}</span>
          </div>
          <div className="bubble plain">{m.text}</div>
          <LooseChildren m={m} agents={agents} />
        </div>
      );
    default:
      return null;
  }
}

export default function MessageList({
  messages,
  agents,
  nested,
}: {
  messages: Msg[];
  agents?: Map<string, AgentMeta>;
  nested?: boolean;
}) {
  if (messages.length === 0) {
    return <div className="empty-note">这个会话没有可渲染的消息</div>;
  }
  const amap = agents ?? new Map<string, AgentMeta>();
  return (
    <div className={nested ? "msglist nested" : "msglist"}>
      {messages.map((m) => (
        <Node key={m.index} m={m} agents={amap} />
      ))}
    </div>
  );
}
