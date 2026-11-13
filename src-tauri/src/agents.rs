//! 读取 subagent 的独立 transcript。
//!
//! 目录结构: ~/.claude/projects/<project>/<session-id>/subagents/
//!   agent-<agentId>.jsonl       agent 的完整对话
//!   agent-<agentId>.meta.json   agent 元信息, 含 toolUseId (指向主会话的 tool_use)
//!
//! 主会话的 tool_result 里也有 toolUseResult.agentId, 双向都能关联。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::transcript::{parse_transcript, Transcript};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AgentMeta {
    pub agent_id: String,
    pub agent_type: String,
    pub description: String,
    /// 主会话里对应的 tool_use id
    pub tool_use_id: String,
    pub spawn_depth: u32,
    pub finished: bool,
    pub jsonl_path: String,
    pub size: u64,
}

/// 主会话对应的 subagents 目录
pub fn subagents_dir(session_jsonl: &Path) -> Option<PathBuf> {
    let stem = session_jsonl.file_stem()?.to_str()?;
    let dir = session_jsonl.parent()?.join(stem).join("subagents");
    dir.is_dir().then_some(dir)
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

/// 列出某个主会话下的所有 subagent。
/// 只读 meta.json (每个 ~250 字节), 不碰 .jsonl, 所以很便宜。
pub fn list_agents(session_jsonl: &Path) -> Vec<AgentMeta> {
    let Some(dir) = subagents_dir(session_jsonl) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for e in entries.flatten() {
        let path = e.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        if !name.ends_with(".meta.json") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        let agent_id = name
            .trim_start_matches("agent-")
            .trim_end_matches(".meta.json")
            .to_string();
        // 注意: 不能用 with_extension("jsonl") —— "agent-x.meta.json" 的 stem 是
        // "agent-x.meta", 会得到 "agent-x.meta.jsonl"。这里按名字重建。
        let jsonl = path.with_file_name(format!("agent-{agent_id}.jsonl"));
        let size = fs::metadata(&jsonl).map(|m| m.len()).unwrap_or(0);
        out.push(AgentMeta {
            agent_id,
            agent_type: str_field(&v, "agentType"),
            description: str_field(&v, "description"),
            tool_use_id: str_field(&v, "toolUseId"),
            spawn_depth: v.get("spawnDepth").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            finished: v.get("finished").and_then(|x| x.as_bool()).unwrap_or(false),
            jsonl_path: jsonl.to_string_lossy().to_string(),
            size,
        });
    }
    out.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    out
}

/// 按需解析一个 agent 的对话
pub fn read_agent(jsonl: &Path) -> Result<Transcript, String> {
    parse_transcript(jsonl, 64 * 1024 * 1024)
}
