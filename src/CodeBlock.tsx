import { Fragment, useEffect, useMemo, useState } from "react";
import { copyText } from "./clipboard";
import { formatJsonDocument } from "./jsonFormat";
import type { HighlighterCore, LanguageRegistration, ThemeRegistration } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import githubLight from "@shikijs/themes/github-light";
import vesper from "@shikijs/themes/vesper";
import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import diff from "@shikijs/langs/diff";
import java from "@shikijs/langs/java";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import markdown from "@shikijs/langs/markdown";
import python from "@shikijs/langs/python";
import typescript from "@shikijs/langs/typescript";
import xml from "@shikijs/langs/xml";
import yaml from "@shikijs/langs/yaml";

/** Shiki 只做 tokenize，不做布局；三套主题全部走 CSS 变量，切主题不重新高亮。 */
const THEMES = { dark: "vesper", light: "github-light", pixel: "pico8" } as const;

const PICO8_THEME: ThemeRegistration = {
  name: "pico8",
  type: "dark",
  colors: {
    "editor.background": "#12182B",
    "editor.foreground": "#FFF1E8",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#5F574F" } },
    { scope: ["string", "string.quoted", "string.template"], settings: { foreground: "#00E436" } },
    { scope: ["keyword", "storage", "storage.type", "storage.modifier"], settings: { foreground: "#FF77A8" } },
    { scope: ["entity.name.function", "support.function", "meta.function-call"], settings: { foreground: "#29ADFF" } },
    { scope: ["constant.numeric", "constant.language", "constant.character"], settings: { foreground: "#FFA300" } },
    { scope: ["entity.name.type", "support.type", "entity.name.class"], settings: { foreground: "#FFEC27" } },
    { scope: ["variable", "meta.object-literal.key", "support.variable"], settings: { foreground: "#FFF1E8" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#C2C3C7" } },
    { scope: ["invalid"], settings: { foreground: "#FF004D" } },
  ],
};

type LangLoader = () => Promise<{ default: LanguageRegistration[] }>;

/** 初始只打包语料 top 语言；其余语言在第一次遇到时才 import()。 */
const LAZY_LANGS: Record<string, LangLoader> = {
  tsx: () => import("@shikijs/langs/tsx"),
  jsx: () => import("@shikijs/langs/jsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  sql: () => import("@shikijs/langs/sql"),
  html: () => import("@shikijs/langs/html"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  c: () => import("@shikijs/langs/c"),
  kotlin: () => import("@shikijs/langs/kotlin"),
};

const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  plaintext: "text",
  txt: "text",
  console: "text",
  output: "text",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const langLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [vesper, githubLight, PICO8_THEME],
      langs: [python, java, bash, json, typescript, jsonc, yaml, diff, xml, css, markdown],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  }
  return highlighterPromise;
}

function normalizeLang(raw: string | undefined): string {
  const cleaned = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9+#._-]/g, "");
  return LANG_ALIASES[cleaned] ?? cleaned;
}

/** 无语言围栏的轻量探测：宁可退回 text，也不猜错后乱上色。 */
function detectLang(code: string): string {
  const text = code.trim();
  if (!text) return "text";

  if (/^[\[{]/.test(text)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      // 不是完整 JSON，继续往下猜
    }
  }
  if (/^(diff --git|@@ |--- a\/|\+\+\+ b\/)/m.test(text)) return "diff";
  if (/(^|\n)\s*(#!.*\b(?:ba|z|fi)?sh\b|\$ |npm |pnpm |bun |cargo |git |docker |kubectl |curl )/.test(text)) return "bash";
  // 收紧到真正的 Python 语句，避免英文散文以 "from the ..." 开头被误判
  if (/(^|\n)\s*(def\s+\w+\s*\(|class\s+\w+\s*[(:]|import\s+[\w.]+|from\s+[\w.]+\s+import\b)/.test(text)) {
    return "python";
  }
  if (/(^|\n)\s*(public |private |protected )?(class|interface|enum) |System\.out\.|import java\./.test(text)) return "java";
  if (/[┌┐└┘├┤┬┴┼─│╭╮╰╯]/.test(text)) return "diagram";
  if (/(^|\n)\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|WITH)\b/i.test(text)) return "sql";
  return "text";
}

function resolveLang(raw: string | undefined, code: string): { lang: string; auto: boolean } {
  const explicit = normalizeLang(raw);
  if (explicit) return { lang: explicit, auto: false };
  return { lang: detectLang(code), auto: true };
}

async function ensureLanguage(h: HighlighterCore, lang: string): Promise<string> {
  if (lang === "text" || h.getLoadedLanguages().includes(lang)) return lang;
  const loader = LAZY_LANGS[lang];
  if (!loader) return "text";

  let pending = langLoads.get(lang);
  if (!pending) {
    pending = loader()
      .then((mod) => h.loadLanguage(mod.default))
      .catch(() => {
        // 语法加载失败时安静退回纯文本，不要让整条消息渲染失败
      });
    langLoads.set(lang, pending);
  }
  await pending;
  return h.getLoadedLanguages().includes(lang) ? lang : "text";
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const resolved = useMemo(() => resolveLang(lang, code), [lang, code]);
  // 正文围栏默认保真；只有整段合法且重排有变化时才提供「格式化/原始」切换
  const pretty = useMemo(
    () =>
      resolved.lang === "json" || resolved.lang === "jsonc" ? formatJsonDocument(code) : null,
    [code, resolved.lang],
  );
  const [showFormatted, setShowFormatted] = useState(false);
  const shown = showFormatted && pretty ? pretty : code;
  const lineCount = useMemo(() => shown.split("\n").length, [shown]);
  const tooLarge = lineCount > 500;
  const folded = lineCount > 30;
  const plain = tooLarge || resolved.lang === "text" || resolved.lang === "diagram";

  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [showLines, setShowLines] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
    setCopied(false);
    setShowFormatted(false);
  }, [code]);

  useEffect(() => {
    let alive = true;
    setHtml(null);
    if (plain) return;

    (async () => {
      const h = await getHighlighter();
      const actual = await ensureLanguage(h, resolved.lang);
      if (!alive) return;
      const out = h.codeToHtml(shown, {
        lang: actual,
        themes: THEMES,
        defaultColor: false,
      });
      if (alive) setHtml(out);
    })().catch(() => {
      if (alive) setHtml(null);
    });

    return () => {
      alive = false;
    };
  }, [shown, plain, resolved.lang]);

  const label = `${resolved.lang}${resolved.auto && resolved.lang !== "text" ? " · 自动" : ""}${
    showFormatted ? " · 格式化" : ""
  }${tooLarge ? " · 未高亮" : ""}`;

  return (
    <div
      className={`code-block${wrap ? " wrap" : ""}${showLines ? " show-lines" : ""}${
        folded && !expanded ? " folded" : ""
      }`}
    >
      <div className="code-head">
        <span className="code-lang">{label}</span>
        <div className="code-actions">
          {pretty && (
            <button
              type="button"
              className="code-btn"
              onClick={() => setShowFormatted((v) => !v)}
              title={showFormatted ? "恢复作者原始排版" : "按 2 空格缩进重排"}
            >
              {showFormatted ? "原始" : "格式化"}
            </button>
          )}
          {lineCount > 20 && (
            <button
              type="button"
              className="code-btn"
              onClick={() => setShowLines((v) => !v)}
              title={showLines ? "隐藏行号" : "显示行号"}
            >
              {showLines ? "隐藏行号" : "行号"}
            </button>
          )}
          <button
            type="button"
            className="code-btn"
            onClick={() => setWrap((v) => !v)}
            title={wrap ? "改为横向滚动" : "长行自动换行"}
          >
            {wrap ? "不换行" : "换行"}
          </button>
          <button
            type="button"
            className="code-btn"
            onClick={() => {
              void copyText(shown).then((ok) => {
                if (!ok) return;
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              });
            }}
            title="复制当前显示的内容"
          >
            {copied ? "✓ 已复制" : "复制"}
          </button>
        </div>
      </div>

      <div className="code-body">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="code-plain">
            <code>
              {shown.split("\n").map((line, i) => (
                <Fragment key={i}>
                  {i > 0 ? "\n" : null}
                  <span className="line">{line}</span>
                </Fragment>
              ))}
            </code>
          </pre>
        )}
      </div>

      {folded && (
        <button
          type="button"
          className="code-expand"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : `展开全部 ${lineCount} 行`}
        </button>
      )}
    </div>
  );
}
