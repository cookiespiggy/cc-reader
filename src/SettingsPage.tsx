import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { applyTheme, readTheme, THEME_LABEL, THEME_ORDER, type Theme } from "./theme";
import {
  applySettings,
  readSettings,
  writeSettings,
  type Density,
  type Settings,
} from "./settings";

type IndexStats = { files: number; messages: number };

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="knob" />
    </button>
  );
}

function Seg<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? "on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function SettingsPage() {
  const inTauri = "__TAURI_INTERNALS__" in window;
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [settings, setSettings] = useState<Settings>(readSettings);
  const [idx, setIdx] = useState<IndexStats | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    applySettings(settings);
    writeSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (!inTauri) return;
    invoke<IndexStats>("index_stats").then(setIdx).catch(() => {});
    let un: (() => void) | undefined;
    listen<{ done: number; total: number }>("index-progress", (e) =>
      setProgress({ done: e.payload.done, total: e.payload.total }),
    )
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, [inTauri]);

  const build = async (force: boolean) => {
    if (!inTauri) return;
    setIndexing(true);
    setErr(null);
    setProgress({ done: 0, total: 0 });
    try {
      setIdx(await invoke<IndexStats>("build_index", { force }));
    } catch (e) {
      setErr(String(e));
    } finally {
      setIndexing(false);
      setProgress(null);
    }
  };

  const patch = (p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p }));

  return (
    <div className="settings">
      <header className="set-head">
        <h1>设置</h1>
        <span>CC Reader 0.1.0</span>
      </header>

      <section className="set-sec">
        <h2>外观</h2>
        <div className="set-row">
          <div className="set-label">主题</div>
          <Seg
            options={THEME_ORDER.map((t) => ({ value: t, label: THEME_LABEL[t] }))}
            value={theme}
            onChange={setTheme}
          />
        </div>
      </section>

      <section className="set-sec">
        <h2>阅读</h2>
        <div className="set-row">
          <div>
            <div className="set-label">时间戳</div>
            <div className="set-hint">在消息头部显示发送时间</div>
          </div>
          <Toggle
            checked={settings.showTimestamps}
            onChange={(v) => patch({ showTimestamps: v })}
          />
        </div>
        <div className="set-row">
          <div>
            <div className="set-label">密度</div>
            <div className="set-hint">紧凑模式缩小消息间距与行高</div>
          </div>
          <Seg<Density>
            options={[
              { value: "comfortable", label: "标准" },
              { value: "compact", label: "紧凑" },
            ]}
            value={settings.density}
            onChange={(v) => patch({ density: v })}
          />
        </div>
        <div className="set-row">
          <div>
            <div className="set-label">恢复上次会话</div>
            <div className="set-hint">重新打开时回到上次阅读的会话与位置</div>
          </div>
          <Toggle
            checked={settings.restoreLastSession}
            onChange={(v) => patch({ restoreLastSession: v })}
          />
        </div>
      </section>

      <section className="set-sec">
        <h2>全文索引</h2>
        <div className="set-row">
          <div className="set-label">索引库</div>
          <code className="set-path">~/Library/Application Support/cc-reader/index.db</code>
        </div>
        <div className="set-row">
          <div className="set-label">已收录</div>
          <span className="set-value">
            {inTauri
              ? idx
                ? `${idx.files} 文件 · ${idx.messages.toLocaleString()} 条`
                : "读取中…"
              : "浏览器预览不建索引"}
          </span>
        </div>
        {inTauri && (
          <div className="set-actions">
            <button
              className="btn"
              type="button"
              disabled={indexing}
              onClick={() => void build(false)}
            >
              {indexing ? "索引中…" : "更新索引"}
            </button>
            <button
              className="btn"
              type="button"
              disabled={indexing}
              onClick={() => void build(true)}
            >
              重建索引
            </button>
            {err && <span className="set-err">{err}</span>}
            {indexing && progress && progress.total > 0 && (
              <div className="idx-progress-wrap" style={{ flex: "1 1 100%", marginTop: 2 }}>
                <div
                  className="idx-progress-bar"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}
      </section>

      <section className="set-sec">
        <h2>关于</h2>
        <div className="set-about">
          <div className="set-label">CC Reader · 0.1.0</div>
          <div className="set-hint">
            只读 Claude Code transcript（~/.claude），不写入任何文件；索引与偏好只存本机。
          </div>
        </div>
      </section>
    </div>
  );
}
