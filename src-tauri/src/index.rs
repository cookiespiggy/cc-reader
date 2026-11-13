//! 跨会话全文搜索索引。
//!
//! 存储位置: ~/Library/Application Support/cc-reader/index.db
//! (不碰 ~/.claude)
//!
//! 分词: FTS5 的 trigram tokenizer。默认的 unicode61 会把连续中文当成一个
//! token, 搜"搜索"匹配不到"全文搜索"。trigram 按 3 字符切, 支持子串匹配。
//! 代价: MATCH 要求查询 >= 3 字符; 更短的查询退回 LIKE
//! (SQLite 对 trigram 表的 LIKE 会走 FTS5 索引, 实测 10 万条 11ms)。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::sessions::iter_transcripts;

pub fn db_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("cc-reader")
        .join("index.db")
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexStats {
    pub files: usize,
    pub messages: usize,
    pub db_bytes: u64,
    pub elapsed_ms: u128,
    /// 本次新增/更新的文件数
    pub changed: usize,
    pub removed: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub path: String,
    pub project_dir: String,
    pub session_id: String,
    pub kind: String,
    /// 消息在 transcript 里的序号
    pub midx: i64,
    pub snippet: String,
    pub score: f64,
    pub modified: f64,
}

/// 打开并初始化索引库
pub fn open() -> Result<Connection, String> {
    let path = db_path();
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("打开索引库失败: {e}"))?;
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=NORMAL;
         CREATE TABLE IF NOT EXISTS files (
           path       TEXT PRIMARY KEY,
           project_dir TEXT,
           session_id TEXT,
           source     TEXT,
           mtime      REAL,
           size       INTEGER,
           msg_count  INTEGER
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS msgs USING fts5(
           body,
           path UNINDEXED,
           kind UNINDEXED,
           midx UNINDEXED,
           tokenize = 'trigram'
         );
         CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime);",
    )
    .map_err(|e| format!("初始化索引失败: {e}"))?;
    Ok(conn)
}

/// 工具输出单条索引的最大长度。工具输出常有几百 KB,
/// 全索引会让索引库膨胀到 GB 级; 截断后仍能搜到开头的关键信息。
const TOOL_OUTPUT_MAX: usize = 4 * 1024;

/// 系统注入 user 消息里的噪音, 索引时跳过 (与 transcript.rs 的过滤保持一致)
const NOISE_PREFIXES: &[&str] = &[
    "<system-reminder",
    "<command-name",
    "<command-message",
    "<local-command",
    "<task-notification>",
    "<bash-input",
    "<bash-stdout",
    "[Image:",
];

/// 从 transcript 里抽出可索引的文本。
/// 一行可能产出多条 (同一行里既有 text 又有 tool_result)。
fn extract_texts(path: &Path) -> Vec<(usize, String, String)> {
    let mut out = Vec::new();
    let Ok(file) = fs::File::open(path) else {
        return out;
    };
    let reader = std::io::BufReader::with_capacity(256 * 1024, file);
    let mut idx = 0usize;

    for line in std::io::BufRead::lines(reader).flatten() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        idx += 1;

        if kind == "user" || kind == "assistant" {
            let c = v.get("message").and_then(|m| m.get("content"));
            match c {
                Some(serde_json::Value::String(s)) => {
                    let t = s.trim_start();
                    if !t.is_empty() && !NOISE_PREFIXES.iter().any(|p| t.starts_with(p)) {
                        out.push((idx, kind.to_string(), s.clone()));
                    }
                }
                Some(serde_json::Value::Array(items)) => {
                    // 助手消息: text / thinking
                    for b in items {
                        let t = match b.get("type").and_then(|t| t.as_str()) {
                            Some("text") => b.get("text").and_then(|t| t.as_str()),
                            Some("thinking") => b.get("thinking").and_then(|t| t.as_str()),
                            _ => None,
                        };
                        if let Some(t) = t {
                            if !t.trim().is_empty() {
                                out.push((idx, kind.to_string(), t.to_string()));
                            }
                        }
                    }
                    // 用户消息里的 tool_result: 工具输出, 单独一条
                    for b in items {
                        if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                            continue;
                        }
                        let content = b.get("content");
                        let text = match content {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(serde_json::Value::Array(inner)) => inner
                                .iter()
                                .filter_map(|x| x.get("text").and_then(|t| t.as_str()))
                                .collect::<Vec<_>>()
                                .join("\n"),
                            _ => String::new(),
                        };
                        if text.trim().is_empty() {
                            continue;
                        }
                        let text = if text.len() > TOOL_OUTPUT_MAX {
                            // 退到 UTF-8 字符边界, 否则会切碎多字节字符
                            let mut end = TOOL_OUTPUT_MAX.min(text.len());
                            while end > 0 && !text.is_char_boundary(end) {
                                end -= 1;
                            }
                            let mut t = text[..end].to_string();
                            t.push_str("\n… (已截断)");
                            t
                        } else {
                            text
                        };
                        let tool = b
                            .get("tool_use_id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        out.push((idx, format!("tool_result:{tool}"), text));
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// 建立 / 增量更新索引
pub fn build(
    conn: &mut Connection,
    force: bool,
    mut on_progress: impl FnMut(usize, usize, &str),
) -> Result<IndexStats, String> {
    let started = Instant::now();

    // 收集所有待索引的 transcript (主会话 + subagent)
    let mut targets: Vec<(String, String, String, String, f64, u64)> = Vec::new();
    for t in iter_transcripts() {
        targets.push((
            t.path.clone(),
            t.project_dir.clone(),
            t.session_id.clone(),
            "main".to_string(),
            t.mtime,
            t.size,
        ));
        for a in crate::agents::list_agents(Path::new(&t.path)) {
            let mtime = fs::metadata(&a.jsonl_path)
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            let size = fs::metadata(&a.jsonl_path).map(|m| m.len()).unwrap_or(0);
            targets.push((
                a.jsonl_path.clone(),
                t.project_dir.clone(),
                a.agent_id.clone(),
                format!("agent:{}", a.agent_id),
                mtime,
                size,
            ));
        }
    }

    let total = targets.len();
    on_progress(0, total, "");

    // 已知文件的 mtime, 用来判断是否需要重建
    let mut known: HashMap<String, f64> = HashMap::new();
    {
        let mut st = conn
            .prepare("SELECT path, mtime FROM files")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?)))
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            known.insert(row.0, row.1);
        }
    }

    let mut changed = 0usize;
    let mut removed = 0usize;
    let mut messages = 0usize;

    for (i, (path, project_dir, session_id, source, mtime, size)) in targets.iter().enumerate() {
        on_progress(i, total, path);

        if !force {
            if let Some(prev) = known.get(path) {
                if (prev - mtime).abs() < 0.001 {
                    continue; // 没变, 跳过
                }
            }
        }

        // 旧的行先清掉
        conn.execute("DELETE FROM msgs WHERE path = ?1", params![path])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM files WHERE path = ?1", params![path])
            .map_err(|e| e.to_string())?;

        let texts = extract_texts(Path::new(path));
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut ins = tx
                .prepare("INSERT INTO msgs(body, path, kind, midx) VALUES (?1, ?2, ?3, ?4)")
                .map_err(|e| e.to_string())?;
            for (midx, kind, text) in &texts {
                ins.execute(params![text, path, kind, *midx as i64])
                    .map_err(|e| e.to_string())?;
            }
            messages += texts.len();
            tx.execute(
                "INSERT OR REPLACE INTO files(path, project_dir, session_id, source, mtime, size, msg_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![path, project_dir, session_id, source, mtime, *size as i64, texts.len() as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        changed += 1;
    }
    on_progress(total, total, "");

    // 清掉已删除的 transcript
    let live: std::collections::HashSet<&String> = targets.iter().map(|t| &t.0).collect();
    let stale: Vec<String> = known
        .keys()
        .filter(|p| !live.contains(*p))
        .cloned()
        .collect();
    for p in stale {
        conn.execute("DELETE FROM msgs WHERE path = ?1", params![p])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM files WHERE path = ?1", params![p])
            .map_err(|e| e.to_string())?;
        removed += 1;
    }

    let files = conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize;

    // FTS5 的 DELETE 只删逻辑行, 文件碎片不会回收 (auto_vacuum 默认 off),
    // 反复重建会让索引库只涨不跌。全量重建后回收一次。
    if force {
        conn.execute_batch("VACUUM;").map_err(|e| e.to_string())?;
    }
    let db_bytes = fs::metadata(db_path()).map(|m| m.len()).unwrap_or(0);

    Ok(IndexStats {
        files,
        messages,
        db_bytes,
        elapsed_ms: started.elapsed().as_millis(),
        changed,
        removed,
    })
}

/// 搜索。>=3 字符走 FTS5 MATCH (有 bm25 相关性), 更短的走 LIKE (仍走索引)
pub fn search(conn: &Connection, query: &str, limit: usize) -> Result<Vec<Hit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 500);

    if q.chars().count() >= 3 {
        // MATCH 语法: 整个词组作为一个 phrase, 引号包住避免被当运算符
        let phrase = format!("\"{}\"", q.replace('"', "\"\""));
        let mut st = conn
            .prepare(
                "SELECT m.path, f.project_dir, f.session_id, m.kind, m.midx,
                        snippet(msgs, 0, '▸', '▸', '…', 16),
                        bm25(msgs), f.mtime
                 FROM msgs m JOIN files f ON f.path = m.path
                 WHERE msgs MATCH ?1
                 ORDER BY bm25(msgs)
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map(params![phrase, limit as i64], |r| {
                Ok(Hit {
                    path: r.get(0)?,
                    project_dir: r.get(1)?,
                    session_id: r.get(2)?,
                    kind: r.get(3)?,
                    midx: r.get(4)?,
                    snippet: r.get(5)?,
                    score: r.get(6)?,
                    modified: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;
        return Ok(rows.flatten().collect());
    }

    // 短查询: LIKE (trigram 表上走索引)
    let mut st = conn
        .prepare(
            "SELECT m.path, f.project_dir, f.session_id, m.kind, m.midx,
                    substr(m.body, max(1, instr(m.body, ?1) - 60), 160),
                    0.0, f.mtime
             FROM msgs m JOIN files f ON f.path = m.path
             WHERE m.body LIKE '%' || ?1 || '%'
             ORDER BY f.mtime DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![q, limit as i64], |r| {
            Ok(Hit {
                path: r.get(0)?,
                project_dir: r.get(1)?,
                session_id: r.get(2)?,
                kind: r.get(3)?,
                midx: r.get(4)?,
                snippet: r.get(5)?,
                score: r.get(6)?,
                modified: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

/// 索引概况
pub fn stats(conn: &Connection) -> Result<(usize, usize, u64), String> {
    let files = conn
        .query_row("SELECT count(*) FROM files", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize;
    let msgs = conn
        .query_row("SELECT count(*) FROM msgs", [], |r| r.get::<_, i64>(0))
        .unwrap_or(0) as usize;
    let bytes = fs::metadata(db_path()).map(|m| m.len()).unwrap_or(0);
    Ok((files, msgs, bytes))
}
