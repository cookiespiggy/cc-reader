import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import MessageList, { type AgentMeta, type Transcript } from "./MessageList";
import PetMascot from "./PetMascot";

type Session = {
  sessionId: string;
  projectDir: string;
  projectPath: string;
  title: string;
  timestamp: string;
  modified: string;
  fileSize: number;
  filePath: string;
  isSidechain: boolean;
};

type Project = {
  dir: string;
  path: string;
  sessionCount: number;
  sessions: Session[];
};

type Hit = {
  path: string;
  projectDir: string;
  sessionId: string;
  kind: string;
  midx: number;
  snippet: string;
  score: number;
  modified: number;
};

/** 搜索结果按归属会话聚合后的组 */
type HitGroup = { key: string; title: string; hits: Hit[]; first: Hit };

/** 会话栏的扁平行模型: 搜索结果 / 分组头 / 会话 / 空态共用一个虚拟滚动容器 */
type ListRow =
  | { key: string; type: "head"; label: string; count: number }
  | { key: string; type: "note"; text: string; loading?: boolean }
  | { key: string; type: "error"; text: string }
  | { key: string; type: "hit-group"; title: string; count: number; hit: Hit }
  | { key: string; type: "hit"; hit: Hit }
  | { key: string; type: "session"; session: Session; active: boolean };

type IndexStats = {
  files: number;
  messages: number;
  dbBytes: number;
  elapsedMs: number;
  changed: number;
  removed: number;
};

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

function shortTime(iso: string): string {
  if (!iso) return "";
  // 2026-11-13T08:05:39.236Z -> 11-13 16:05 (本地)
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 命中片段高亮。
 * MATCH 路径的 snippet 自带 ▸ 标记; LIKE 路径没有, 所以按查询词自己标一次。 */
function snippetHtml(s: string, q: string): string {
  const esc = s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  let out = esc.replace(/▸/g, "<mark>▸</mark>");
  const term = q.trim();
  if (term.length >= 1 && !out.includes("▸")) {
    const re = new RegExp(
      term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "gi",
    );
    out = out.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return out;
}

type Theme = "dark" | "light" | "pixel";
const THEME_KEY = "cc-reader-theme";
const THEME_ORDER: Theme[] = ["dark", "light", "pixel"];
const THEME_LABEL: Record<Theme, string> = { dark: "深色", light: "浅色", pixel: "像素" };

function readTheme(): Theme {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return saved === "light" || saved === "pixel" ? saved : "dark";
  } catch {
    return "dark";
  }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    // 深色即默认值, 不挂 data-theme: 否则 :root 与 [data-theme] 两套变量同时命中
    if (theme === "dark") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // 隐私模式下 localStorage 不可用, 用默认深色
    }
  }, [theme]);

  const nextTheme = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length];

  // 三栏宽度: 拖动分隔手柄调整, 双击恢复默认, 记在 localStorage (不碰 ~/.claude)
  const COL_DEFAULT = { projects: 216, sessions: 320 };
  const COL_LIMITS: Record<keyof typeof COL_DEFAULT, [number, number]> = {
    projects: [150, 420],
    sessions: [220, 640],
  };
  const COLS_KEY = "cc-reader-cols";
  const [colW, setColW] = useState(COL_DEFAULT);
  const [colsLoaded, setColsLoaded] = useState(false);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || "null");
      if (
        saved &&
        typeof saved.projects === "number" &&
        typeof saved.sessions === "number"
      ) {
        setColW(saved);
      }
    } catch {
      // 隐私模式下 localStorage 不可用, 用默认宽度
    }
    setColsLoaded(true);
  }, []);

  useEffect(() => {
    if (!colsLoaded) return;
    try {
      localStorage.setItem(COLS_KEY, JSON.stringify(colW));
    } catch {
      // 忽略
    }
  }, [colW, colsLoaded]);

  const startDrag = (key: keyof typeof COL_DEFAULT) => {
    return (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = colW[key];
      const [min, max] = COL_LIMITS[key];
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);
      document.body.classList.add("col-resizing");
      const onMove = (ev: PointerEvent) => {
        const w = Math.min(max, Math.max(min, startW + ev.clientX - startX));
        setColW((c) => ({ ...c, [key]: w }));
      };
      const onUp = () => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        document.body.classList.remove("col-resizing");
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    };
  };

  const resetCols = (key: keyof typeof COL_DEFAULT) =>
    setColW((c) => ({ ...c, [key]: COL_DEFAULT[key] }));

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [agents, setAgents] = useState<Map<string, AgentMeta>>(new Map());
  const [tLoading, setTLoading] = useState(false);
  const [tError, setTError] = useState<string | null>(null);

  // 全文搜索
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [idxStats, setIdxStats] = useState<IndexStats | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [idxProgress, setIdxProgress] = useState<{ done: number; total: number } | null>(null);
  const pendingScroll = useRef<number | null>(null);
  const listRef = useRef<VirtuosoHandle>(null);
  const sessionPaneRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);

  const loadTranscript = useCallback((s: Session) => {
    setTLoading(true);
    setTError(null);
    setTranscript(null);
    setAgents(new Map());
    const inTauri = "__TAURI_INTERNALS__" in window;
    const req: Promise<Transcript> = inTauri
      ? invoke<Transcript>("read_transcript", { path: s.filePath })
      : fetch("/transcript.json").then((r) => {
          if (!r.ok) throw new Error(`transcript.json ${r.status}`);
          return r.json();
        });
    // subagent 元信息只读 meta.json, 很便宜, 并行拉
    const agentsReq: Promise<AgentMeta[]> = inTauri
      ? invoke<AgentMeta[]>("list_agents", { path: s.filePath })
      : fetch("/agents.json")
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [] as AgentMeta[]);

    req
      .then(setTranscript)
      .catch((e) => setTError(String(e)))
      .finally(() => setTLoading(false));
    agentsReq
      .then((list) => setAgents(new Map(list.map((a) => [a.agentId, a]))))
      .catch(() => {});
  }, []);

  // ---- 全文索引 ----

  const inTauri = "__TAURI_INTERNALS__" in window;

  // 索引概况 + 进度事件
  useEffect(() => {
    if (!inTauri) return;
    invoke<IndexStats>("index_stats")
      .then(setIdxStats)
      .catch(() => {});
    let un: (() => void) | undefined;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ done: number; total: number }>("index-progress", (e) =>
          setIdxProgress({ done: e.payload.done, total: e.payload.total }),
        ),
      )
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, [inTauri]);

  const buildIndex = useCallback(async (force: boolean) => {
    if (!inTauri) {
      setSearchErr("浏览器预览模式不支持建索引, 请在桌面 app 里操作");
      return;
    }
    setIndexing(true);
    setIdxProgress({ done: 0, total: 0 });
    try {
      const stats = await invoke<IndexStats>("build_index", { force });
      setIdxStats(stats);
    } catch (e) {
      setSearchErr(String(e));
    } finally {
      setIndexing(false);
      setIdxProgress(null);
    }
  }, [inTauri]);

  const runSearch = useCallback(
    async (q: string) => {
      if (!q.trim()) {
        setHits(null);
        return;
      }
      setSearching(true);
      setSearchErr(null);
      try {
        const r = inTauri
          ? await invoke<Hit[]>("search_index", { query: q, limit: 150 })
          : await fetch("/hits.json").then((x) => x.json());
        setHits(r as Hit[]);
      } catch (e) {
        setSearchErr(String(e));
      } finally {
        setSearching(false);
      }
    },
    [inTauri],
  );

  const allSessions = useMemo(
    () => projects.flatMap((p) => p.sessions),
    [projects],
  );

  /** 跳到命中处。agent 的命中会回退到它所属的主会话 */
  const jumpToHit = useCallback(
    (hit: Hit) => {
      const direct = allSessions.find((x) => x.filePath === hit.path);
      const owner = direct ?? allSessions.find((x) => hit.path.includes(`${x.sessionId}/subagents/`));
      if (!owner) {
        setSearchErr(`找不到会话文件: ${hit.path}`);
        return;
      }
      setActiveProject(owner.projectDir);
      setActiveSession(owner);
      pendingScroll.current = direct ? hit.midx : null;
      loadTranscript(owner);
    },
    [allSessions, loadTranscript],
  );

  // 消息加载完再滚动到锚点
  useEffect(() => {
    if (!transcript || pendingScroll.current == null) return;
    const midx = pendingScroll.current;
    pendingScroll.current = null;
    requestAnimationFrame(() => {
      const el = document.getElementById(`m${midx}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("flash");
        window.setTimeout(() => el.classList.remove("flash"), 2200);
      }
    });
  }, [transcript]);

  useEffect(() => {
    let cancelled = false;
    // 桌面端走 Tauri IPC; 浏览器预览模式读静态 dump, 方便用 playwright 截图和快速迭代 UI
    const inTauri = "__TAURI_INTERNALS__" in window;
    const req: Promise<Project[]> = inTauri
      ? invoke<Project[]>("list_projects")
      : fetch("/sessions.json").then((r) => {
          if (!r.ok) throw new Error(`sessions.json ${r.status}`);
          return r.json();
        });

    req
      .then((groups) => {
        if (cancelled) return;
        setProjects(groups);
        setLoading(false);
        if (groups.length > 0) setActiveProject(groups[0].dir);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 全局快捷键: Cmd+F 聚焦搜索, Esc 清搜索并把焦点交回会话栏
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape") {
        if (document.activeElement === searchRef.current) {
          setQuery("");
          setHits(null);
          searchRef.current?.blur();
        }
        sessionPaneRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const q = query.trim().toLowerCase();

  // 过滤后的项目 -> 会话
  const filtered = useMemo(() => {
    if (!q) return projects;
    return projects
      .map((p) => ({
        ...p,
        sessions: p.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.projectPath.toLowerCase().includes(q) ||
            s.sessionId.toLowerCase().includes(q),
        ),
      }))
      .filter((p) => p.sessions.length > 0 || p.path.toLowerCase().includes(q));
  }, [projects, q]);

  const current = useMemo(
    () => filtered.find((p) => p.dir === activeProject) ?? filtered[0] ?? null,
    [filtered, activeProject],
  );

  // 稳定引用: current 为 null 时 `?? []` 每次都生成新数组, 会让行模型反复重建
  const sessions = useMemo(() => current?.sessions ?? [], [current]);
  const activeSessionId = activeSession?.sessionId;

  /** 搜索结果按归属会话聚合: 150 条命中常只来自 2 个会话, 标题不该重复 148 次 */
  const hitGroups = useMemo(() => {
    if (!hits) return [] as HitGroup[];
    const byPath = new Map(allSessions.map((s) => [s.filePath, s]));
    const groups = new Map<string, HitGroup>();
    for (const h of hits) {
      const owner =
        byPath.get(h.path) ??
        allSessions.find((x) => h.path.includes(`${x.sessionId}/subagents/`));
      const key = owner?.sessionId ?? h.sessionId;
      let g = groups.get(key);
      if (!g) {
        g = { key, title: owner?.title ?? "(未知会话)", hits: [], first: h };
        groups.set(key, g);
      }
      g.hits.push(h);
    }
    return [...groups.values()];
  }, [hits, allSessions]);

  /** 会话栏扁平化: 搜索结果 / 分组头 / 会话 / 空态共用一个 Virtuoso, 避免嵌套滚动 */
  const { rows, sessionRowIndex } = useMemo(() => {
    const out: ListRow[] = [];
    const idx = new Map<string, number>();
    if (hits) {
      if (searchErr) out.push({ key: "search-err", type: "error", text: searchErr });
      hitGroups.forEach((g, gi) => {
        out.push({
          key: `hg-${g.key}`,
          type: "hit-group",
          title: g.title,
          count: g.hits.length,
          hit: g.first,
        });
        g.hits.forEach((h, i) => {
          out.push({ key: `hit-${gi}-${i}-${h.path}-${h.midx}`, type: "hit", hit: h });
        });
      });
      if (hits.length === 0) out.push({ key: "no-hits", type: "note", text: "没有命中" });
      out.push({ key: "head-sessions", type: "head", label: "会话", count: sessions.length });
    }
    if (searching) {
      out.push({ key: "searching", type: "note", text: "搜索中…", loading: true });
    }
    sessions.forEach((s) => {
      idx.set(s.sessionId, out.length);
      out.push({
        key: `s-${s.sessionId}`,
        type: "session",
        session: s,
        active: s.sessionId === activeSessionId,
      });
    });
    if (sessions.length === 0 && !loading) {
      out.push({ key: "no-sessions", type: "note", text: "该项目下没有会话" });
    }
    return { rows: out, sessionRowIndex: idx };
  }, [hits, hitGroups, searchErr, searching, sessions, loading, activeSessionId]);

  const selectSession = useCallback(
    (next: number) => {
      if (!sessions[next]) return;
      setActiveSession(sessions[next]);
      loadTranscript(sessions[next]);
      const row = sessionRowIndex.get(sessions[next].sessionId);
      if (row !== undefined) {
        listRef.current?.scrollToIndex({ index: row, align: "center", behavior: "auto" });
      }
    },
    [sessions, loadTranscript, sessionRowIndex],
  );

  const PAGE_ROWS = 12;

  const onKeyNav = useCallback(
    (e: React.KeyboardEvent) => {
      if (document.activeElement === searchRef.current) return;
      const idx = sessions.findIndex((s) => s.sessionId === activeSessionId);
      let next: number | null = null;
      switch (e.key) {
        case "ArrowDown":
          next = Math.min(idx + 1, sessions.length - 1);
          break;
        case "ArrowUp":
          next = Math.max(idx - 1, 0);
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = sessions.length - 1;
          break;
        case "PageDown":
          next = Math.min(idx + PAGE_ROWS, sessions.length - 1);
          break;
        case "PageUp":
          next = Math.max(idx - PAGE_ROWS, 0);
          break;
        case "Enter":
          e.preventDefault();
          detailRef.current?.focus();
          if (detailRef.current) detailRef.current.scrollTop = 0;
          return;
        default:
          return;
      }
      e.preventDefault();
      selectSession(next);
    },
    [sessions, activeSessionId, selectSession],
  );

  /** 详情栏内跳消息: 复用 id=m${index} 锚点, 与搜索结果跳转同一套 */
  const jumpMessage = useCallback((dir: 1 | -1) => {
    const pane = detailRef.current;
    if (!pane) return;
    const nodes = Array.from(pane.querySelectorAll<HTMLElement>(".msg[id]"));
    if (nodes.length === 0) return;
    const top = pane.getBoundingClientRect().top + 80;
    let cur = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].getBoundingClientRect().top <= top) cur = i;
      else break;
    }
    const el = nodes[Math.min(Math.max(cur + dir, 0), nodes.length - 1)];
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    el.classList.add("flash");
    window.setTimeout(() => el.classList.remove("flash"), 2200);
  }, []);

  const onDetailKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "n" || e.key === "j") {
        e.preventDefault();
        jumpMessage(1);
      } else if (e.key === "p" || e.key === "k") {
        e.preventDefault();
        jumpMessage(-1);
      }
    },
    [jumpMessage],
  );

  // 切换项目 / 换一批搜索结果时回到顶部, 否则会停在上一个项目的滚动位置
  useEffect(() => {
    listRef.current?.scrollToIndex({ index: 0, align: "start" });
  }, [current?.dir, hits]);

  const renderRow = (_: number, row: ListRow) => {
    switch (row.type) {
      case "head":
        return (
          <div className="pane-head pane-head-inline">
            <span>{row.label}</span>
            <span>{row.count}</span>
          </div>
        );
      case "note":
        return <div className={row.loading ? "loading" : "empty-note"}>{row.text}</div>;
      case "error":
        return <div className="error">{row.text}</div>;
      case "hit-group":
        return (
          <div className="hit-group" onClick={() => jumpToHit(row.hit)}>
            <span className="hit-group-title">{row.title}</span>
            <span className="hit-group-count">{row.count} 处</span>
          </div>
        );
      case "hit":
        return (
          <div className="hit grouped" onClick={() => jumpToHit(row.hit)}>
            <div
              className="hit-snip"
              dangerouslySetInnerHTML={{ __html: snippetHtml(row.hit.snippet, query) }}
            />
            <div className="session-meta">
              <span>{row.hit.kind}</span>
              <span>{row.hit.midx}</span>
              <span className="id">{row.hit.sessionId.slice(0, 8)}</span>
            </div>
          </div>
        );
      case "session":
        return (
          <div
            className={`session${row.active ? " active" : ""}`}
            onClick={() => {
              setActiveSession(row.session);
              loadTranscript(row.session);
            }}
          >
            <div className="session-title" title={row.session.title}>
              {row.session.title}
            </div>
            <div className="session-meta">
              <span>{shortTime(row.session.modified)}</span>
              <span>{humanSize(row.session.fileSize)}</span>
              <span className="id">{row.session.sessionId.slice(0, 8)}</span>
            </div>
          </div>
        );
    }
  };

  return (
    <div className="app">
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" data-tauri-drag-region>
          CC Reader <span>claude code transcripts</span>
        </div>
        <div className="search">
          <input
            ref={searchRef}
            value={query}
            placeholder="过滤标题/路径 · 回车全文搜索"
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value.trim()) setHits(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                runSearch(query);
              } else if (e.key === "Escape") {
                setHits(null);
                setQuery("");
              }
            }}
          />
          <kbd>⌘F</kbd>
        </div>
        <div className="stats">
          {idxStats && (
            <span className="idx-badge" title="全文索引已收录的消息条数">
              <b>{idxStats.messages.toLocaleString()}</b> 条
            </span>
          )}
          <button
            className="btn"
            onClick={() => buildIndex(false)}
            disabled={indexing}
            title="增量更新全文索引"
          >
            {indexing
              ? idxProgress && idxProgress.total
                ? `索引中 ${idxProgress.done}/${idxProgress.total}`
                : "索引中…"
              : "更新索引"}
          </button>
          <button
            className="btn theme-toggle"
            onClick={() => setTheme(nextTheme)}
            title={`切换主题：深色 → 浅色 → 像素（当前${THEME_LABEL[theme]}）。记在 localStorage，不写 ~/.claude`}
          >
            {THEME_LABEL[nextTheme]}
          </button>
        </div>
      </header>

      <main
        className="panes"
        style={{
          gridTemplateColumns: `${colW.projects}px 6px ${colW.sessions}px 6px minmax(360px, 1fr)`,
        }}
      >
        <aside className="pane pane-projects">
          <div className="pane-head">
            <span>项目</span>
            <span>{projects.length}</span>
          </div>
          {loading && <div className="loading">扫描 ~/.claude/projects …</div>}
          {filtered.map((p) => (
            <div
              key={p.dir}
              className={`project${current?.dir === p.dir ? " active" : ""}`}
              onClick={() => {
                setActiveProject(p.dir);
                setActiveSession(null);
              }}
              title={p.path}
            >
              <div className="project-name">
                <span>{p.path.split("/").filter(Boolean).pop() ?? p.dir}</span>
                <span className="project-count">{p.sessions.length}</span>
              </div>
              <div className="project-path">{p.path}</div>
            </div>
          ))}
          {!loading && filtered.length === 0 && (
            <div className="empty-note">没有匹配的项目</div>
          )}
        </aside>

        <div
          className="grip"
          onPointerDown={startDrag("projects")}
          onDoubleClick={() => resetCols("projects")}
          title="拖拽调宽 · 双击恢复默认"
        />

        <section
          className="pane pane-sessions"
          ref={sessionPaneRef}
          tabIndex={0}
          onKeyDown={onKeyNav}
        >
          <div className="pane-head pane-head-fixed">
            <span>{hits ? "搜索结果" : "会话"}</span>
            <span>
              {hits ? `${hits.length} 命中 · ${hitGroups.length} 会话` : sessions.length}
            </span>
          </div>
          <Virtuoso
            ref={listRef}
            className="sessions-virtuoso"
            data={rows}
            computeItemKey={(_, row) => row.key}
            itemContent={renderRow}
            increaseViewportBy={200}
          />
        </section>

        <div
          className="grip"
          onPointerDown={startDrag("sessions")}
          onDoubleClick={() => resetCols("sessions")}
          title="拖拽调宽 · 双击恢复默认"
        />

        <section
          className="pane pane-detail"
          ref={detailRef}
          tabIndex={0}
          onKeyDown={onDetailKey}
        >
          {error ? (
            <div className="error">{error}</div>
          ) : activeSession ? (
            <>
              <div className="detail-head">
                <div className="detail-title">{activeSession.title}</div>
                <div className="detail-meta">
                  <span>
                    session <b>{activeSession.sessionId}</b>
                  </span>
                  <span>
                    文件 <b>{humanSize(activeSession.fileSize)}</b>
                  </span>
                  <span>
                    首次 <b>{shortTime(activeSession.timestamp)}</b>
                  </span>
                  <span>
                    最近 <b>{shortTime(activeSession.modified)}</b>
                  </span>
                  {transcript && (
                    <span>
                      消息 <b>{transcript.messageCount}</b>
                    </span>
                  )}
                </div>
              </div>
              {tLoading && <div className="loading">解析 transcript …</div>}
              {tError && <div className="error">{tError}</div>}
              {transcript && (
                <MessageList messages={transcript.messages} agents={agents} />
              )}
            </>
          ) : (
            <div className="detail-empty">
              <PetMascot size={88} />
              <div>在左侧选择一个会话</div>
              <div className="key-hints">
                <span><kbd>↑</kbd><kbd>↓</kbd> 切会话</span>
                <span><kbd>Home</kbd><kbd>End</kbd> 首尾</span>
                <span><kbd>PgUp</kbd><kbd>PgDn</kbd> 翻页</span>
                <span><kbd>Enter</kbd> 开始阅读</span>
                <span><kbd>n</kbd><kbd>p</kbd> 跳消息</span>
                <span><kbd>⌘F</kbd> 搜索</span>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
