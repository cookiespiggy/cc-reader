//! 解析单个 transcript JSONL, 输出消息树。
//!
//! 节点划分:
//!   - 一条 user 消息           -> user 节点 (content 是数组时视为 tool_result)
//!   - 一条 assistant 消息      -> 拆成 text / thinking / tool_use 若干节点
//!   - tool_result              -> 挂到对应 tool_use 的 children 里
//!   - system 消息              -> system 节点
//! 同一 uuid 下的多个块用 `uuid#i` 做唯一键, 共享同一个 parent。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Msg {
    /// transcript 里的行序号(1 起)。与全文索引的 midx 对齐, 搜索结果据此跳转
    pub index: usize,
    /// user | assistant | thinking | tool_use | tool_result | system | image
    pub kind: String,
    pub timestamp: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    /// tool_result 的 toolUseResult.agentId —— 指向本会话下的 subagent transcript
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub is_error: bool,
    pub depth: u32,
    pub children: Vec<Msg>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub session_id: String,
    pub messages: Vec<Msg>,
    pub message_count: usize,
    pub truncated: bool,
}

struct Node {
    msg: Msg,
    /// 消息的 uuid。同一 uuid 下的多个 block 共享
    uuid: String,
    /// 父节点的 uuid
    parent: Option<String>,
}

/// 系统注入到 user 消息里的噪音前缀, 不是"人说的话"
const NOISE_PREFIXES: &[&str] = &[
    "<system-reminder",
    "<command-name",
    "<command-message",
    "<local-command",
    "<task-notification>",
    "<bash-input",
    "<bash-stdout",
    "Caveat: The messages below",
];

fn text_of(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn tool_result_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|b| {
                b.get("text")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| b.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

/// 解析 transcript。max_bytes 用来限制单次读入规模。
pub fn parse_transcript(path: &Path, max_bytes: u64) -> Result<Transcript, String> {
    let meta = std::fs::metadata(path).map_err(|e| format!("打开失败: {e}"))?;
    let truncated = meta.len() > max_bytes;

    let file = File::open(path).map_err(|e| format!("打开失败: {e}"))?;
    let reader = BufReader::with_capacity(256 * 1024, file);

    let mut nodes: Vec<Node> = Vec::new();
    // tool_use_id -> node 下标, 用来把 tool_result 挂上去
    let mut tool_nodes: HashMap<String, usize> = HashMap::new();
    let mut session_id = String::new();
    let mut count = 0usize;
    // transcript 行号(1 起)。与全文索引的 midx 对齐, 搜索结果据此跳转
    let mut line_no = 0usize;

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }
        line_no += 1;
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let uuid = match v.get("uuid").and_then(|u| u.as_str()) {
            Some(u) => u.to_string(),
            None => continue,
        };
        if session_id.is_empty() {
            if let Some(s) = v.get("sessionId").and_then(|s| s.as_str()) {
                session_id = s.to_string();
            }
        }
        let ts = v
            .get("timestamp")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        let parent = v
            .get("parentUuid")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string());
        let message = v.get("message").cloned().unwrap_or(Value::Null);
        let content = message.get("content").cloned().unwrap_or(Value::Null);

        let mut block = 0usize;
        let push = |nodes: &mut Vec<Node>, mut m: Msg, key: &str| {
            m.timestamp = ts.clone();
            m.index = line_no;
            let _ = key;
            nodes.push(Node {
                msg: m,
                uuid: uuid.clone(),
                parent: parent.clone(),
            });
        };

        match kind {
            "user" => {
                let as_result = content
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                    })
                    .unwrap_or(false);
                if as_result {
                    let blocks = content.as_array().cloned().unwrap_or_default();
                    for b in blocks {
                        if b.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                            continue;
                        }
                        let tool_id = b
                            .get("tool_use_id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let m = Msg {
                            kind: "tool_result".into(),
                            tool_id: Some(tool_id.clone()),
                            agent_id: v
                                .get("toolUseResult")
                                .and_then(|r| r.get("agentId"))
                                .and_then(|x| x.as_str())
                                .map(|s| s.to_string()),
                            is_error: b.get("is_error").and_then(|x| x.as_bool()).unwrap_or(false),
                            text: tool_result_text(b.get("content").unwrap_or(&Value::Null)),
                            ..Default::default()
                        };
                        count += 1;
                        // 挂到对应的 tool_use 节点下
                        if let Some(idx) = tool_nodes.get(&tool_id).copied() {
                            // 把 agentId 提到 tool_use 上, 前端据此懒加载 subagent 对话
                            if let Some(aid) = &m.agent_id {
                                nodes[idx].msg.agent_id = Some(aid.clone());
                            }
                            nodes[idx].msg.children.push(m);
                        } else {
                            let key = format!("{uuid}#{block}");
                            block += 1;
                            push(&mut nodes, m, &key);
                        }
                    }
                } else {
                    // 人类输入 vs 系统注入。Claude Code 把 <system-reminder> /
                    // <command-name> / <task-notification> 等也塞进 user 消息,
                    // 它们不是"人说的话", 渲染出来是噪音。
                    let text = text_of(&content);
                    let trimmed = text.trim_start();
                    let kind = if trimmed.starts_with("[Image:") {
                        "image"
                    } else if NOISE_PREFIXES.iter().any(|p| trimmed.starts_with(p)) {
                        // 纯噪音, 不渲染
                        continue;
                    } else {
                        "user"
                    };
                    count += 1;
                    let key = format!("{uuid}#{block}");
                    push(
                        &mut nodes,
                        Msg {
                            kind: kind.into(),
                            text,
                            ..Default::default()
                        },
                        &key,
                    );
                }
            }
            "assistant" => {
                let blocks = content.as_array().cloned().unwrap_or_default();
                for b in blocks {
                    let btype = b.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    match btype {
                        "text" => {
                            count += 1;
                            let key = format!("{uuid}#{block}");
                            block += 1;
                            push(
                                &mut nodes,
                                Msg {
                                    kind: "assistant".into(),
                                    text: b.get("text").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                                    ..Default::default()
                                },
                                &key,
                            );
                        }
                        "thinking" => {
                            count += 1;
                            let key = format!("{uuid}#{block}");
                            block += 1;
                            push(
                                &mut nodes,
                                Msg {
                                    kind: "thinking".into(),
                                    text: b.get("thinking").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                                    ..Default::default()
                                },
                                &key,
                            );
                        }
                        "tool_use" => {
                            count += 1;
                            let key = format!("{uuid}#{block}");
                            block += 1;
                            let id = b
                                .get("id")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string();
                            let m = Msg {
                                kind: "tool_use".into(),
                                tool_name: b.get("name").and_then(|x| x.as_str()).map(|s| s.to_string()),
                                tool_id: Some(id.clone()),
                                input: b.get("input").cloned(),
                                ..Default::default()
                            };
                            push(&mut nodes, m, &key);
                            if !id.is_empty() {
                                let idx = nodes.len() - 1;
                                tool_nodes.insert(id, idx);
                            }
                        }
                        _ => {}
                    }
                }
            }
            "system" => {
                count += 1;
                let key = format!("{uuid}#{block}");
                // 无 content 的系统事件(turn_duration / away_summary 之外的 meta 行)
                // 合成一行可读摘要, 否则前端会渲染成一张空卡片
                let text = match v.get("content").and_then(|c| c.as_str()) {
                    Some(s) if !s.is_empty() => s.to_string(),
                    _ => {
                        let sub = v.get("subtype").and_then(|s| s.as_str()).unwrap_or("system");
                        match sub {
                            "turn_duration" => {
                                let secs = v.get("durationMs").and_then(|d| d.as_u64()).unwrap_or(0) / 1000;
                                let n = v.get("messageCount").and_then(|c| c.as_u64()).unwrap_or(0);
                                if secs >= 60 {
                                    format!("本轮 {n} 条消息 · {}m{}s", secs / 60, secs % 60)
                                } else {
                                    format!("本轮 {n} 条消息 · {secs}s")
                                }
                            }
                            other => format!("[{other}]"),
                        }
                    }
                };
                push(
                    &mut nodes,
                    Msg {
                        kind: "system".into(),
                        text,
                        ..Default::default()
                    },
                    &key,
                );
            }
            _ => {}
        }
    }

    // 建树: 只有 parent 指向一个真实存在的节点时才保留父子关系,
    // 否则(压缩/缺失/跨 session)当作根节点
    let known_uuids: std::collections::HashSet<String> = nodes
        .iter()
        .map(|n| n.uuid.clone())
        .collect();

    // by_parent: parentUuid -> 该消息下的 block 节点
    //
    // tool_result 不进这张表: 它已经通过 tool_use_id 配对挂到对应的 tool_use
    // 下面了, 再进 parentUuid 树会出现两份。
    let mut by_parent: HashMap<Option<String>, Vec<usize>> = HashMap::new();
    for (i, n) in nodes.iter().enumerate() {
        if n.msg.kind == "tool_result" {
            continue;
        }
        let p = match &n.parent {
            Some(p) if known_uuids.contains(p) => Some(p.clone()),
            _ => None,
        };
        by_parent.entry(p).or_default().push(i);
    }

    /// 递归展开。
    /// `expanded` 必须跨整棵树共享: 同一 uuid 的多个 block 共享 parent,
    /// 它们的子节点只能被展开一次, 否则会重复计数。
    fn build(
        parent: Option<&str>,
        by_parent: &HashMap<Option<String>, Vec<usize>>,
        nodes: &[Node],
        expanded: &mut std::collections::HashSet<String>,
        depth: u32,
    ) -> Vec<Msg> {
        let mut out = Vec::new();
        let key = parent.map(|s| s.to_string());
        let Some(idxs) = by_parent.get(&key) else {
            return out;
        };
        for &i in idxs {
            let mut m = nodes[i].msg.clone();
            m.depth = depth;
            if expanded.insert(nodes[i].uuid.clone()) {
                let mut kids = build(
                    Some(&nodes[i].uuid),
                    by_parent,
                    nodes,
                    expanded,
                    depth + 1,
                );
                m.children.append(&mut kids);
            }
            out.push(m);
        }
        out
    }

    let mut expanded = std::collections::HashSet::new();
    let messages = build(None, &by_parent, &nodes, &mut expanded, 0);

    Ok(Transcript {
        session_id,
        messages,
        message_count: count,
        truncated,
    })
}
