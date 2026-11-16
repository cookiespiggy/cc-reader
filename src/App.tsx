import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import MessageList, {
  type AgentMeta,
  type Msg,
  type Transcript,
  inputSummary,
} from "./MessageList";
import PetMascot from "./PetMascot";
import { previewJson } from "./preview";
import { THEME_KEY, THEME_LABEL, THEME_ORDER, applyTheme, readTheme, type Theme } from "./theme";
import { SETTINGS_KEY, applySettings, readSettings, type Settings } from "./settings";

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
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16).replace("T", " ");
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const hhmm = `${p(d.getHours())}:${p(d.getMinutes())}`;

  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);

  if (d >= todayStart) return `今天 ${hhmm}`;
  if (d >= yesterdayStart) return `昨天 ${hhmm}`;

  const sameYear = d.getFullYear() === now.getFullYear();
  if (sameYear) return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${String(d.getFullYear()).slice(2)}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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

/** 阅读状态: 上次打开的会话 + 每个会话的滚动位置。只写 localStorage, 不碰 ~/.claude */
const LAST_SESSION_KEY = "cc-reader-last-session";
const SCROLL_KEY = "cc-reader-scroll";

type FindMatch = { key: string; midx: number; openKeys: string[] };
const FIND_LIMIT = 300;

/** 搜索工具输入时避免把 Write 的超大 content 整个 stringify */
function toolInputHaystack(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.length <= 20000 ? input : "";
  try {
    const s = JSON.stringify(input);
    return s && s.length <= 20000 ? s : "";
  } catch {
    return "";
  }
}

function haystack(text: string): string {
  return text.length > 1_000_000 ? text.slice(0, 1_000_000) : text;
}

/** 会话内查找: 折叠内容也纳入; openKeys 记录跳转前需要展开的祖先/自身 */
function collectFindMatches(messages: Msg[], query: string): FindMatch[] {
  const q = query.toLowerCase();
  const out: FindMatch[] = [];
  const walk = (list: Msg[], inherited: string[]) => {
    for (const m of list) {
      if (out.length >= FIND_LIMIT) return;
      if (m.kind === "thinking") {
        if (haystack(m.text).toLowerCase().includes(q)) {
          out.push({ key: m.key, midx: m.index, openKeys: [...inherited, m.key] });
        }
        // thinking 的 children 渲染在 details 外, 不继承展开
        walk(m.children, inherited);
        continue;
      }
      if (m.kind === "tool_use") {
        const visible = `${m.toolName ?? ""} ${inputSummary(m.toolName, m.input)}`;
        if (visible.toLowerCase().includes(q)) {
          out.push({ key: m.key, midx: m.index, openKeys: inherited });
        } else if (toolInputHaystack(m.input).toLowerCase().includes(q)) {
          out.push({ key: m.key, midx: m.index, openKeys: [...inherited, m.key] });
        }
        for (const c of m.children) {
          walk([c], c.kind === "tool_result" ? [...inherited, m.key] : inherited);
        }
        continue;
      }
      if (m.kind !== "image" && haystack(m.text).toLowerCase().includes(q)) {
        out.push({ key: m.key, midx: m.index, openKeys: inherited });
      }
      walk(m.children, inherited);
    }
  };
  walk(messages, []);
  return out;
}

type ScrollState = { top: number; midx: number | null; off: number };

function readScrollMap(): Record<string, ScrollState> {
  try {
    const raw = JSON.parse(localStorage.getItem(SCROLL_KEY) || "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, ScrollState> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "number") {
        out[k] = { top: v, midx: null, off: 0 };
      } else if (v && typeof v === "object") {
        const o = v as { top?: unknown; midx?: unknown; off?: unknown };
        if (typeof o.top === "number") {
          out[k] = {
            top: o.top,
            midx: typeof o.midx === "number" ? o.midx : null,
            off: typeof o.off === "number" ? o.off : 0,
          };
        }
      }
    }
    return out;
  } catch {
    return {};
  }
}

export default function App() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [settings, setSettings] = useState<Settings>(readSettings);
  const settingsRef = useRef(settings);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    settingsRef.current = settings;
    applySettings(settings);
  }, [settings]);

  // 设置窗口改主题/选项时, 通过 storage 事件同步回主窗口
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY) setTheme(readTheme());
      else if (e.key === SETTINGS_KEY) setSettings(readSettings());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const [themeMenu, setThemeMenu] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!themeMenu) return;
    const onDown = (e: PointerEvent) => {
      if (!themeMenuRef.current?.contains(e.target as Node)) setThemeMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setThemeMenu(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [themeMenu]);

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

  // 会话内查找
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findCursor, setFindCursor] = useState(0);
  const [forceOpenKeys, setForceOpenKeys] = useState<Set<string>>(new Set());
  const [findSeq, setFindSeq] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);
  const findNavRef = useRef<{ key: string; openKeys: string[] } | null>(null);

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
  const saveScrollTimer = useRef<number | null>(null);
  const activeSessionIdRef = useRef<string | null>(null);
  const restoreSuppressed = useRef(false);

  useEffect(() => {
    activeSessionIdRef.current = activeSession?.sessionId ?? null;
  }, [activeSession]);

  // 窗口标题 (macOS 隐藏标题栏后仍用于 Mission Control / 窗口菜单)
  useEffect(() => {
    document.title = activeSession ? `${activeSession.title} — CC Reader` : "CC Reader";
  }, [activeSession]);

  const loadTranscript = useCallback((s: Session) => {
    setTLoading(true);
    setTError(null);
    setTranscript(null);
    setAgents(new Map());
    const inTauri = "__TAURI_INTERNALS__" in window;
    const req: Promise<Transcript> = inTauri
      ? invoke<Transcript>("read_transcript", { path: s.filePath })
      : previewJson<Transcript>(
          `/api/transcript?path=${encodeURIComponent(s.filePath)}`,
          "/transcript.json",
        );
    // subagent 元信息只读 meta.json, 很便宜, 并行拉
    const agentsReq: Promise<AgentMeta[]> = inTauri
      ? invoke<AgentMeta[]>("list_agents", { path: s.filePath })
      : previewJson<AgentMeta[]>(
          `/api/agents?path=${encodeURIComponent(s.filePath)}`,
          "/agents.json",
        ).catch(() => [] as AgentMeta[]);

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

  const openSettings = useCallback(async () => {
    if (inTauri) {
      try {
        await invoke("open_settings");
      } catch (e) {
        setSearchErr(String(e));
      }
    } else {
      window.open("/?settings=1", "cc-reader-settings", "width=560,height=720");
    }
  }, [inTauri]);

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
    // 在设置窗口重建索引后, 回到主窗口刷新一下统计
    const onFocus = () => {
      invoke<IndexStats>("index_stats").then(setIdxStats).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => {
      un?.();
      window.removeEventListener("focus", onFocus);
    };
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

  // 重开 app: 回到上次阅读的会话 (设置里可关)
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || allSessions.length === 0) return;
    restoredRef.current = true;
    if (!settingsRef.current.restoreLastSession) return;
    let sid = "";
    try {
      sid = localStorage.getItem(LAST_SESSION_KEY) || "";
    } catch {
      // 隐私模式下 localStorage 不可用
    }
    const last = sid ? allSessions.find((s) => s.sessionId === sid) : undefined;
    if (!last) return;
    setActiveProject(last.projectDir);
    setActiveSession(last);
    loadTranscript(last);
  }, [allSessions, loadTranscript]);

  useEffect(() => {
    if (!activeSession) return;
    try {
      localStorage.setItem(LAST_SESSION_KEY, activeSession.sessionId);
    } catch {
      // 忽略
    }
  }, [activeSession]);

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
    restoreSuppressed.current = true;
    requestAnimationFrame(() => {
      const el = document.getElementById(`m${midx}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("flash");
        window.setTimeout(() => el.classList.remove("flash"), 2200);
      }
    });
  }, [transcript]);

  // 普通打开会话: 恢复上次滚动位置 (搜索跳转优先, 由上一个 effect 抑制)
  // 用「顶部消息 + 偏移」做锚点, 折叠状态变化时仍能落到同一段内容
  useEffect(() => {
    if (!transcript) return;
    if (restoreSuppressed.current) {
      restoreSuppressed.current = false;
      return;
    }
    const pane = detailRef.current;
    const sid = activeSessionIdRef.current;
    if (!pane || !sid) return;
    const state = readScrollMap()[sid];
    if (!state) return;
    let timer = 0;
    const apply = () => {
      const el = state.midx != null ? document.getElementById(`m${state.midx}`) : null;
      if (!el) {
        pane.scrollTop = state.top;
        return;
      }
      // 元素可能因折叠变矮: 最多恢复到「元素底部上方 24px」
      const h = el.getBoundingClientRect().height;
      const off = state.off < 0 ? Math.max(state.off, 24 - h) : state.off;
      const delta = el.getBoundingClientRect().top - pane.getBoundingClientRect().top - off;
      pane.scrollTop = Math.max(0, pane.scrollTop + delta);
    };
    requestAnimationFrame(() => {
      apply();
      // 高亮/图片等异步布局可能改变高度, 再兜一次
      timer = window.setTimeout(apply, 120);
    });
    return () => window.clearTimeout(timer);
  }, [transcript]);

  const onDetailScroll = useCallback(() => {
    const pane = detailRef.current;
    const sid = activeSessionIdRef.current;
    if (!pane || !sid || !transcript || tLoading) return;
    if (saveScrollTimer.current != null) window.clearTimeout(saveScrollTimer.current);
    saveScrollTimer.current = window.setTimeout(() => {
      saveScrollTimer.current = null;
      try {
        const paneTop = pane.getBoundingClientRect().top;
        let anchor: HTMLElement | null = null;
        for (const el of pane.querySelectorAll<HTMLElement>(".msg[id]")) {
          if (el.getBoundingClientRect().top <= paneTop + 12) anchor = el;
          else break;
        }
        // 锚点若在展开的工具/思考内容里, 提升到最外层消息, 收起后仍可定位
        while (anchor) {
          const parent = anchor.parentElement?.closest<HTMLElement>(".msg");
          if (!parent || !pane.contains(parent)) break;
          anchor = parent;
        }
        const midx = anchor ? Number.parseInt(anchor.id.slice(1), 10) : NaN;
        const map = readScrollMap();
        map[sid] = {
          top: pane.scrollTop,
          midx: Number.isFinite(midx) ? midx : null,
          off: anchor ? anchor.getBoundingClientRect().top - paneTop : 0,
        };
        localStorage.setItem(SCROLL_KEY, JSON.stringify(map));
      } catch {
        // 忽略
      }
    }, 180);
  }, [transcript, tLoading]);

  // ---- 会话内查找 ----

  const findHits = useMemo(
    () => (transcript && findQ.trim() ? collectFindMatches(transcript.messages, findQ.trim()) : []),
    [transcript, findQ],
  );

  const navigateFind = useCallback(
    (index: number) => {
      if (findHits.length === 0) return;
      const n = ((index % findHits.length) + findHits.length) % findHits.length;
      setFindCursor(n);
      const hit = findHits[n];
      if (hit.openKeys.length) setForceOpenKeys(new Set(hit.openKeys));
      findNavRef.current = { key: hit.key, openKeys: hit.openKeys };
      setFindSeq((x) => x + 1);
    },
    [findHits],
  );

  // 输入变化 / 打开查找条: 自动跳到第一个命中
  useEffect(() => {
    if (!findOpen || !findQ.trim()) return;
    if (findHits.length === 0) {
      setFindCursor(0);
      return;
    }
    navigateFind(0);
  }, [findHits, findOpen, findQ, navigateFind]);

  // 命中可能在折叠块里: 等展开挂载后滚动 + flash
  useEffect(() => {
    if (!findSeq) return;
    const nav = findNavRef.current;
    const pane = detailRef.current;
    if (!nav || !pane) return;
    let alive = true;
    const tryScroll = () => {
      if (!alive) return true;
      const sel = (k: string) => `[data-key="${CSS.escape(k)}"]`;
      const exact = pane.querySelector<HTMLElement>(sel(nav.key));
      if (exact) {
        pane.querySelectorAll<HTMLElement>(".find-current").forEach((n) => {
          n.classList.remove("find-current");
        });
        exact.classList.add("find-current", "flash");
        exact.scrollIntoView({ behavior: "smooth", block: "center" });
        window.setTimeout(() => exact.classList.remove("flash"), 2200);
        return true;
      }
      // 目标还没挂载: 先把祖先滚进视野, 继续等下一轮
      if (nav.openKeys.length) {
        pane
          .querySelector<HTMLElement>(sel(nav.openKeys[0]))
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      return false;
    };
    const timers: number[] = [];
    if (!tryScroll()) {
      for (const ms of [60, 180, 400, 900]) timers.push(window.setTimeout(tryScroll, ms));
    }
    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [findSeq]);

  // 已挂载的命中加淡标记, 当前命中加强调
  useEffect(() => {
    const pane = detailRef.current;
    if (!pane) return;
    pane.querySelectorAll<HTMLElement>(".find-hit, .find-current").forEach((el) => {
      el.classList.remove("find-hit", "find-current");
    });
    if (!findOpen || !findQ.trim()) return;
    findHits.forEach((h, i) => {
      const el = pane.querySelector<HTMLElement>(`[data-key="${CSS.escape(h.key)}"]`);
      if (!el) return;
      el.classList.add(i === findCursor ? "find-current" : "find-hit");
    });
  }, [findHits, findCursor, findOpen, findQ]);

  // 切换会话: 关闭查找并清空
  useEffect(() => {
    setFindOpen(false);
    setFindQ("");
    setFindCursor(0);
    setForceOpenKeys(new Set());
    findNavRef.current = null;
  }, [activeSession?.sessionId]);

  useEffect(() => {
    let cancelled = false;
    // 桌面端走 Tauri IPC; 浏览器预览模式读静态 dump, 方便用 playwright 截图和快速迭代 UI
    const inTauri = "__TAURI_INTERNALS__" in window;
    const req: Promise<Project[]> = inTauri
      ? invoke<Project[]>("list_projects")
      : previewJson<Project[]>("/api/sessions", "/sessions.json");

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

  // 全局快捷键: ⌘F 会话内查找 / ⇧⌘F 全局搜索 / ⌘G 下一个命中 / Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        if (e.shiftKey || !transcript) {
          searchRef.current?.focus();
          searchRef.current?.select();
        } else {
          setFindOpen(true);
          requestAnimationFrame(() => {
            findInputRef.current?.focus();
            findInputRef.current?.select();
          });
        }
      } else if (mod && e.key.toLowerCase() === "g" && findOpen && findHits.length > 0) {
        e.preventDefault();
        navigateFind(findCursor + (e.shiftKey ? -1 : 1));
      } else if (mod && e.key === ",") {
        e.preventDefault();
        void openSettings();
      } else if (e.key === "Escape") {
        if (findOpen) {
          setFindOpen(false);
          return;
        }
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
  }, [findOpen, findHits, findCursor, navigateFind, transcript, openSettings]);

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
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) {
        return;
      }
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
            className={`session${row.active ? " active" : ""}${row.session.isSidechain ? " sidechain" : ""}`}
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
        <div className="tb-title" data-tauri-drag-region>
          {activeSession ? (
            <>
              <div className="tb-main" title={activeSession.title} data-tauri-drag-region>
                {activeSession.title || "未命名会话"}
              </div>
              <div
                className="tb-sub"
                title={`${activeSession.projectPath} · ${activeSession.sessionId}`}
                data-tauri-drag-region
              >
                {activeSession.projectPath.split("/").filter(Boolean).pop() ??
                  activeSession.projectDir}
                {" · "}
                {activeSession.sessionId.slice(0, 8)}
              </div>
            </>
          ) : (
            <>
              <div className="tb-main brand" data-tauri-drag-region>CC Reader</div>
              <div className="tb-sub brand" data-tauri-drag-region>claude code transcripts</div>
            </>
          )}
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
          {searching ? <span className="search-spinner" aria-label="搜索中" /> : <kbd>⇧⌘F</kbd>}
        </div>
        <div className="stats">
          <button
            type="button"
            className="btn"
            onClick={() => void openSettings()}
            title="设置 (⌘,)"
          >
            设置
          </button>
          <div className="theme-menu" ref={themeMenuRef}>
            <button
              className="btn theme-toggle"
              aria-haspopup="menu"
              aria-expanded={themeMenu}
              title="切换主题"
              onClick={() => setThemeMenu((v) => !v)}
            >
              {THEME_LABEL[theme]} ▾
            </button>
            {themeMenu && (
              <div className="theme-pop" role="menu">
                {THEME_ORDER.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="menuitemradio"
                    aria-checked={t === theme}
                    className={t === theme ? "on" : ""}
                    onClick={() => {
                      setTheme(t);
                      setThemeMenu(false);
                    }}
                  >
                    <span>{THEME_LABEL[t]}</span>
                    {t === theme && <span className="tick">✓</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
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
          <div className="projects-scroll">
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
          </div>
          <div className="pane-foot">
            <div className="pane-foot-row">
              <span title={inTauri ? "全文索引已收录的消息条数" : "浏览器预览不建索引"}>
                {idxStats
                  ? `${idxStats.messages.toLocaleString()} 条`
                  : inTauri
                    ? "索引未建立"
                    : "浏览器预览"}
              </span>
              {inTauri && (
                <button
                  type="button"
                  className="mini-btn"
                  onClick={() => buildIndex(false)}
                  disabled={indexing}
                  title="增量更新全文索引"
                >
                  {indexing ? "索引中…" : "更新索引"}
                </button>
              )}
            </div>
            {indexing && idxProgress && idxProgress.total > 0 && (
              <div className="idx-progress-wrap">
                <div
                  className="idx-progress-bar"
                  style={{ width: `${Math.round((idxProgress.done / idxProgress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
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
          onScroll={onDetailScroll}
        >
          {findOpen && activeSession && (
            <div className="findbar">
              <input
                ref={findInputRef}
                className={`find-input${findQ.trim() && findHits.length === 0 ? " empty" : ""}`}
                value={findQ}
                placeholder="在当前会话中查找"
                onChange={(e) => setFindQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    navigateFind(findCursor + (e.shiftKey ? -1 : 1));
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    setFindOpen(false);
                  }
                }}
              />
              <span className={`find-count${findQ.trim() && findHits.length === 0 ? " empty" : ""}`}>
                {findQ.trim()
                  ? findHits.length
                    ? `${findCursor + 1}/${findHits.length}${findHits.length >= FIND_LIMIT ? "+" : ""}`
                    : "0/0"
                  : ""}
              </span>
              <button
                type="button"
                className="mini-btn"
                onClick={() => navigateFind(findCursor - 1)}
                disabled={findHits.length === 0}
                title="上一个 (⇧Enter)"
              >
                ↑
              </button>
              <button
                type="button"
                className="mini-btn"
                onClick={() => navigateFind(findCursor + 1)}
                disabled={findHits.length === 0}
                title="下一个 (Enter / ⌘G)"
              >
                ↓
              </button>
              <button
                type="button"
                className="mini-btn"
                onClick={() => setFindOpen(false)}
                title="关闭 (Esc)"
              >
                ✕
              </button>
            </div>
          )}
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
                  {activeSession.isSidechain && (
                    <span className="detail-sidechain">⇥ 续话分支</span>
                  )}
                </div>
              </div>
              {tLoading && (
                <div className="transcript-skeleton" aria-label="加载中">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="sk-msg">
                      <div className="sk-who" />
                      <div className="sk-bubble" />
                    </div>
                  ))}
                </div>
              )}
              {tError && <div className="error">{tError}</div>}
              {transcript && (
                <MessageList
                  messages={transcript.messages}
                  agents={agents}
                  forceOpen={forceOpenKeys}
                />
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
                <span><kbd>⌘F</kbd> 会话内查找</span>
                <span><kbd>⇧⌘F</kbd> 全局搜索</span>
                <span><kbd>⌘,</kbd> 设置</span>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
