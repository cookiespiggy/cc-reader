//! 命令行子命令。
//!
//! 跟 GUI 共用一个二进制, 避免打包时 .app/Contents/MacOS 里混进一堆可执行文件。
//!
//!   cc-reader index [--force]              建 / 更新全文索引
//!   cc-reader search <词> [条数]            全文搜索
//!   cc-reader dump sessions                导出项目/会话索引 JSON
//!   cc-reader dump transcript <路径>        导出单个 transcript 的消息树 JSON

use std::path::Path;
use std::time::Instant;

use crate::index;
use crate::sessions::list_sessions;

pub fn index(args: &[String]) {
    let force = args.iter().any(|a| a == "--force" || a == "-f");
    let mut conn = match index::open() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("打开索引库失败: {e}");
            std::process::exit(1);
        }
    };
    println!("索引库: {:?}", index::db_path());

    let t = Instant::now();
    let mut last = Instant::now();
    let stats = match index::build(&mut conn, force, |done, total, cur| {
        if done % 50 == 0 && done != 0 {
            println!(
                "  {}/{}  本轮 {:.1}s  {}",
                done,
                total,
                last.elapsed().as_secs_f64(),
                cur.rsplit('/').next().unwrap_or("")
            );
            last = Instant::now();
        }
    }) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("建索引失败: {e}");
            std::process::exit(1);
        }
    };

    println!(
        "\n文件 {} · 消息 {} · 索引库 {:.0}M · 耗时 {:.1}s (新增/更新 {} 个, 清理 {} 个)",
        stats.files,
        stats.messages,
        stats.db_bytes as f64 / 1048576.0,
        t.elapsed().as_secs_f64(),
        stats.changed,
        stats.removed
    );
}

pub fn search(args: &[String]) {
    if args.is_empty() {
        eprintln!("用法: cc-reader search <查询词> [条数]");
        std::process::exit(1);
    }
    let query = &args[0];
    let limit = args
        .get(1)
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(20);

    let conn = match index::open() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("打开索引库失败: {e}");
            std::process::exit(1);
        }
    };
    let t = Instant::now();
    let hits = index::search(&conn, query, limit).unwrap_or_default();
    println!(
        "\"{}\" -> {} 命中 ({:.1} ms)\n",
        query,
        hits.len(),
        t.elapsed().as_secs_f64() * 1000.0
    );
    for h in &hits {
        let snip: String = h.snippet.chars().take(140).collect();
        println!("  [{}] {}", h.kind, snip.replace('\n', " "));
        println!("      {}", h.path);
    }
}

pub fn dump(args: &[String]) {
    let what = args.first().map(|s| s.as_str()).unwrap_or("");
    match what {
        "sessions" => {
            match list_sessions() {
                Ok(g) => println!(
                    "{}",
                    serde_json::to_string(&g).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
                ),
                Err(e) => {
                    eprintln!("错误: {e}");
                    std::process::exit(1);
                }
            }
        }
        "transcript" => {
            let path = match args.get(1) {
                Some(p) => p,
                None => {
                    eprintln!("用法: cc-reader dump transcript <transcript.jsonl>");
                    std::process::exit(1);
                }
            };
            match crate::transcript::parse_transcript(Path::new(path), 64 * 1024 * 1024) {
                Ok(t) => println!(
                    "{}",
                    serde_json::to_string(&t).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
                ),
                Err(e) => {
                    eprintln!("错误: {e}");
                    std::process::exit(1);
                }
            }
        }
        "agents" => {
            let path = match args.get(1) {
                Some(p) => p,
                None => {
                    eprintln!("用法: cc-reader dump agents <transcript.jsonl>");
                    std::process::exit(1);
                }
            };
            let list = crate::agents::list_agents(Path::new(path));
            println!(
                "{}",
                serde_json::to_string(&list).unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
            );
        }
        _ => {
            eprintln!("用法: cc-reader dump <sessions|transcript|agents> [路径]");
            std::process::exit(1);
        }
    }
}
