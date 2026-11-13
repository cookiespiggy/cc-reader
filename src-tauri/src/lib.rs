pub mod agents;
pub mod cli;
pub mod index;
pub mod sessions;
pub mod transcript;

use sessions::{list_sessions, ProjectGroup};
use tauri::Emitter;

#[tauri::command]
fn list_projects() -> Result<Vec<ProjectGroup>, String> {
    list_sessions()
}

#[tauri::command]
fn read_transcript(path: String) -> Result<transcript::Transcript, String> {
    transcript::parse_transcript(std::path::Path::new(&path), 64 * 1024 * 1024)
}

/// 某个主会话下挂了哪些 subagent (只读 meta.json, 很便宜)
#[tauri::command]
fn list_agents(path: String) -> Result<Vec<agents::AgentMeta>, String> {
    Ok(agents::list_agents(std::path::Path::new(&path)))
}

/// 按需解析一个 subagent 的对话
#[tauri::command]
fn read_agent(path: String) -> Result<transcript::Transcript, String> {
    agents::read_agent(std::path::Path::new(&path))
}

/// 建立 / 增量更新全文索引。进度通过 index-progress 事件推送
#[tauri::command]
fn build_index(app: tauri::AppHandle, force: bool) -> Result<index::IndexStats, String> {
    let mut conn = index::open()?;
    index::build(&mut conn, force, |done, total, current| {
        let _ = app.emit(
            "index-progress",
            index::Progress {
                done,
                total,
                current: current.to_string(),
            },
        );
    })
}

/// 全文搜索
#[tauri::command]
fn search_index(query: String, limit: Option<usize>) -> Result<Vec<index::Hit>, String> {
    let conn = index::open()?;
    index::search(&conn, &query, limit.unwrap_or(150))
}

/// 索引概况
#[tauri::command]
fn index_stats() -> Result<index::IndexStats, String> {
    let conn = index::open()?;
    let (files, messages, db_bytes) = index::stats(&conn)?;
    Ok(index::IndexStats {
        files,
        messages,
        db_bytes,
        elapsed_ms: 0,
        changed: 0,
        removed: 0,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_projects,
            read_transcript,
            list_agents,
            read_agent,
            build_index,
            search_index,
            index_stats
        ])
        .run(tauri::generate_context!())
        .expect("error while running cc-reader");
}
