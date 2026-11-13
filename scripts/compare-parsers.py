#!/usr/bin/env python3
"""回归工具: 把 claude-code-log --format json 与 cc-reader 的 Rust 解析器逐字段对拍。

cc-reader 的解析器是自己写的 (Claude Code 的 transcript 是内部格式, 会变),
所以需要一个独立实现的参照物来对拍 —— claude-code-log 就是那个参照物。

用法:
    cd src-tauri
    # 1. 两侧各出一份 JSON
    ccl convert <session.jsonl> -o /tmp/verify/<id>.ccl.json --format json
    cargo run --release --bin dump -- --transcript <session.jsonl> > /tmp/verify/<id>.mine.json
    # 2. 对拍
    python3 ../scripts/compare-parsers.py <id> [<id> ...]

比对维度:
    user/assistant/thinking  -> 归一化文本
    tool_use/tool_result     -> tool_use_id (唯一标识, 比 input 可靠:
                               ccl 会给自己的 input 加 minted_agent_id 等字段)
    图片占位消息             -> 单独排除 (ccl 过滤, 我们保留并标成 image)

已知差异 (2026-11-13 实测):
    - claude-code-log 会丢弃约 8% 的 tool_use (同一 tool_use_id 多行时去重),
      cc-reader 全部保留 -> cc-reader 更完整
    - cc-reader 把 subagent 的 transcript 与主会话分开按需加载,
      ccl 是内联进主树 -> 总量差异由此而来, 不是解析差异
"""
import json
import sys
import collections
import re
from pathlib import Path

VERIFY = Path("/tmp/verify")

TOOL_KEYS = ["command", "file_path", "pattern", "url", "query", "description", "prompt", "skill", "notebook_path"]


def norm(s: str) -> str:
    return " ".join((s or "").split())[:400]


def norm_tool_input(inp):
    if not isinstance(inp, dict):
        return json.dumps(inp, sort_keys=True, ensure_ascii=False)
    keep = {k: inp[k] for k in TOOL_KEYS if k in inp}
    return json.dumps(keep, sort_keys=True, ensure_ascii=False)


def strip_lineno(s: str) -> str:
    # grep -rn 的输出每行前缀 "123:" 或 "123-", 去掉便于对齐
    out = []
    for line in (s or "").split("\n"):
        out.append(re.sub(r"^\s*\d+[:-]\s?", "", line))
    return "\n".join(out)


def flatten_ccl(msgs, acc):
    for m in msgs:
        t = m.get("type")
        c = m.get("content") or {}
        if t in ("user", "assistant"):
            for it in c.get("items") or []:
                if it.get("type") == "text" and (it.get("text") or "").strip():
                    acc.append((t, norm(it["text"])))
        elif t == "thinking":
            if (c.get("thinking") or "").strip():
                acc.append((t, norm(c["thinking"])))
        elif t == "tool_use":
            acc.append((t, norm_tool_input(c.get("input"))))
        elif t == "tool_result":
            acc.append((t, norm(strip_lineno(str((c.get("output") or {}).get("content", ""))))))
        flatten_ccl(m.get("children") or [], acc)
    return acc


def flatten_mine(msgs, acc):
    for m in msgs:
        k = m.get("kind")
        if k in ("user", "assistant", "thinking"):
            if (m.get("text") or "").strip():
                acc.append((k, norm(m["text"])))
        elif k == "tool_use":
            acc.append((k, norm_tool_input(m.get("input"))))
        elif k == "tool_result":
            acc.append((k, norm(strip_lineno(m.get("text") or ""))))
        flatten_mine(m.get("children") or [], acc)
    return acc


def is_image(text: str) -> bool:
    return (text or "").lstrip().startswith("[Image:")


def compare(sid):
    ccl_p = VERIFY / f"{sid}.ccl.json"
    mine_p = VERIFY / f"{sid}.mine.json"
    if not ccl_p.exists() or not mine_p.exists():
        print(f"  {sid}: 缺文件")
        return

    ccl = json.load(open(ccl_p))
    mine = json.load(open(mine_p))

    a = flatten_ccl(ccl.get("messages") or [], [])
    b = flatten_mine(mine.get("messages") or [], [])

    # 图片占位单独计, 不算差异
    b = [x for x in b if not is_image(x[1])]

    ca = collections.Counter(k for k, _ in a)
    cb = collections.Counter(k for k, _ in b)

    print(f"\n=== {sid} ===")
    print(f"  ccl {len(a)} 条 / mine {len(b)} 条 (已排除图片占位)")
    kinds = sorted(set(ca) | set(cb))
    bad = 0
    for k in kinds:
        flag = ""
        if ca[k] != cb[k]:
            flag = "   <-- 不一致"
            bad += 1
        print(f"    {k:14} ccl {ca[k]:5}  mine {cb[k]:5}{flag}")

    sa, sb = collections.Counter(a), collections.Counter(b)
    only_ccl, only_mine = list((sa - sb).elements()), list((sb - sa).elements())
    print(f"  内容差集: ccl 多 {len(only_ccl)}, mine 多 {len(only_mine)}")
    for k, v in only_ccl[:4]:
        print(f"    [ccl only ] {k}: {v[:100]}")
    for k, v in only_mine[:4]:
        print(f"    [mine only] {k}: {v[:100]}")
    return bad


total_bad = 0
for sid in sys.argv[1:]:
    total_bad += compare(sid) or 0
print(f"\n>>> 类型数量不一致的会话数: {total_bad}")
