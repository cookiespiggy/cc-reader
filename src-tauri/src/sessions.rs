//! 扫描 ~/.claude/projects 下的 transcript, 产出项目 / 会话索引。
//!
//! 只读: 全程不写入 Claude Code 的任何目录。

use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;

pub const DEFAULT_PROJECTS_DIR: &str = ".claude/projects";

/// 人类输入的噪声前缀: 系统注入、命令回显、后台任务通知都不是用户说的话。
const NOISE_PREFIXES: &[&str] = &[
    "<system-reminder",
    "<command-name",
    "<command-message",
    "<local-command",
    "<task-notification",
    "Caveat: The messages below",
    "<bash-input",
    "<bash-stdout",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    /// 编码后的项目目录名, 例如 -Users-jimmy-work-extour-ui-pretty
    pub project_dir: String,
    /// transcript 里记录的真实工作目录
    pub project_path: String,
    pub title: String,
    /// 第一条人类输入的时间, ISO8601
    pub timestamp: String,
    /// 最后一次写入时间, ISO8601
    pub modified: String,
    pub file_size: u64,
    pub file_path: String,
    /// 是否是 subagent 的 sidechain 会话
    pub is_sidechain: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub dir: String,
    pub path: String,
    pub session_count: usize,
    pub sessions: Vec<SessionSummary>,
}

fn projects_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    PathBuf::from(home).join(DEFAULT_PROJECTS_DIR)
}

/// 把 home 前缀换成 ~ , 路径短一大截, 列表里不用截断
fn tildify(path: &str) -> String {
    if let Ok(home) = std::env::var("HOME") {
        if !home.is_empty() {
            if let Some(rest) = path.strip_prefix(&home) {
                return format!("~{rest}");
            }
        }
    }
    path.to_string()
}

fn to_iso(secs: i64) -> String {
    // 只到分钟精度即可; 避免引入 chrono 依赖
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Howard Hinnant 的 days -> civil date 算法
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 判断一段文本是不是"人类说的话"
fn is_human_text(s: &str) -> bool {
    let t = s.trim_start();
    if t.is_empty() {
        return false;
    }
    !NOISE_PREFIXES.iter().any(|p| t.starts_with(p))
}

/// 读取一个 transcript 的头部信息: 第一条人类输入 + 工作目录。
/// 只读前若干行, 遇到人类输入就停, 避免为了列目录而扫描整个 1.2G。
fn read_head(path: &Path, max_lines: usize) -> (Option<String>, Option<String>, Option<String>) {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (None, None, None),
    };
    let reader = BufReader::with_capacity(64 * 1024, file);
    let mut title = None;
    let mut cwd = None;
    let mut ts = None;

    for line in reader.lines().take(max_lines) {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if cwd.is_none() {
            if let Some(c) = v.get("cwd").and_then(|x| x.as_str()) {
                cwd = Some(c.to_string());
            }
        }
        if title.is_some() {
            break;
        }
        if v.get("type").and_then(|x| x.as_str()) != Some("user") {
            continue;
        }
        if v.get("isSidechain").and_then(|x| x.as_bool()).unwrap_or(false) {
            continue;
        }
        let content = v.get("message").and_then(|m| m.get("content"));
        let text = match content {
            Some(serde_json::Value::String(s)) => s.clone(),
            _ => continue, // 数组形态 = tool_result, 不是人类输入
        };
        if !is_human_text(&text) {
            continue;
        }
        title = Some(text.trim().lines().next().unwrap_or("").chars().take(160).collect());
        ts = v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
    }
    (title, cwd, ts)
}

/// 列出全部会话, 按项目分组。
pub fn list_sessions() -> Result<Vec<ProjectGroup>, String> {
    let root = projects_dir();
    let entries = match std::fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) => return Err(format!("读取 {} 失败: {e}", root.display())),
    };

    let mut groups: Vec<ProjectGroup> = Vec::new();

    for proj_entry in entries.flatten() {
        let proj_path = proj_entry.path();
        if !proj_path.is_dir() {
            continue;
        }
        let dir_name = proj_entry.file_name().to_string_lossy().to_string();
        let files = match std::fs::read_dir(&proj_path) {
            Ok(f) => f,
            Err(_) => continue,
        };

        let mut sessions: Vec<SessionSummary> = Vec::new();
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") {
                continue;
            }
            // 跳过 Claude Code 自己备份的旧版本
            if name.contains(".orphaned-") || name.contains(".superseded-") {
                continue;
            }
            let path = f.path();
            let meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| to_iso(d.as_secs() as i64))
                .unwrap_or_default();

            let (title, cwd, ts) = read_head(&path, 400);
            let session_id = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();

            sessions.push(SessionSummary {
                session_id,
                project_dir: dir_name.clone(),
                project_path: tildify(&cwd.clone().unwrap_or_else(|| dir_name.clone())),
                title: title.unwrap_or_else(|| "(无标题)".to_string()),
                timestamp: ts.unwrap_or_else(|| modified.clone()),
                modified,
                file_size: meta.len(),
                file_path: path.to_string_lossy().to_string(),
                is_sidechain: false,
            });
        }

        if sessions.is_empty() {
            continue;
        }
        sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
        let path = sessions[0].project_path.clone();
        let count = sessions.len();
        groups.push(ProjectGroup {
            dir: dir_name,
            path,
            session_count: count,
            sessions,
        });
    }

    groups.sort_by(|a, b| b.sessions[0].modified.cmp(&a.sessions[0].modified));
    Ok(groups)
}

/// 一个 transcript 文件的定位信息
#[derive(Clone, Debug)]
pub struct TranscriptEntry {
    pub path: String,
    pub project_dir: String,
    pub session_id: String,
    pub mtime: f64,
    pub size: u64,
}

/// 列出全部主会话 transcript (不含 subagent)。
/// 索引和统计都基于它。
pub fn iter_transcripts() -> Vec<TranscriptEntry> {
    let root = projects_dir();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for proj_entry in entries.flatten() {
        let proj_path = proj_entry.path();
        if !proj_path.is_dir() {
            continue;
        }
        let dir_name = proj_entry.file_name().to_string_lossy().to_string();
        let Ok(files) = std::fs::read_dir(&proj_path) else {
            continue;
        };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") || name.contains(".orphaned-") || name.contains(".superseded-")
            {
                continue;
            }
            let path = f.path();
            let Ok(meta) = std::fs::metadata(&path) else {
                continue;
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0);
            out.push(TranscriptEntry {
                path: path.to_string_lossy().to_string(),
                project_dir: dir_name.clone(),
                session_id: path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default(),
                mtime,
                size: meta.len(),
            });
        }
    }
    out
}
