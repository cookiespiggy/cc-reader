# CC Reader

把 Claude Code 的本地会话日志，重渲染成高密度桌面阅读器。**只读、本地、可搜索。**

![platform](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)
![Tauri](https://img.shields.io/badge/Tauri-2.x-24C8DB?logo=tauri&logoColor=white)
![Rust](https://img.shields.io/badge/Rust-1.77%2B-000000?logo=rust&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=06181F)
![License](https://img.shields.io/badge/license-MIT-green)

Claude Code 每次对话都完整落盘到 `~/.claude/projects/<工作目录编码>/<session-id>.jsonl`，
但你只能对着终端往上滚。CC Reader 直接读这些 JSONL，解析成消息树，按 IDE 的密度重新排版：
思考过程、工具调用、命令输出默认收成一行摘要，真正要读的那几句话留在屏幕上。

全程只读 `~/.claude`，不写任何文件、不改任何配置，也不联网。

## 特性

- **三栏阅读界面** —— 项目 → 会话 → 消息，几十个项目、几百个会话，打开即用
- **消息树，而不是平铺日志** —— assistant 的 `text` / `thinking` / `tool_use` 拆成独立节点，
  `tool_result` 挂回对应的 `tool_use`，subagent 与 fork 分支天然表现成嵌套
- **默认折叠，按需挂载** —— 折叠块的内容不进 DOM；单条输出超过 100KB 或 1200 行时
  先渲染前 1200 行，给「显示全部」
- **subagent 会话可展开** —— 列表只读 `subagents/*.meta.json`，点开才解析对应的
  `agent-*.jsonl`（上百个 subagent、数百 MB 数据，全量读会卡死）
- **跨会话全文搜索** —— SQLite FTS5 + trigram 分词，中文可搜子串；≥3 字符 3–13ms，
  2 字符回退 `LIKE` 约 220ms；命中按会话聚合，点击跳到具体消息并高亮
- **渲染细节** —— markdown（表格 / 代码块）、diff 行级着色、图片占位、工具参数摘要与字符数
- **三套主题**（深色 / 浅色 / 像素，顶栏一键循环）、**完整键盘导航**
- **会话列表虚拟滚动** —— 合成 5,000 会话的用例下，DOM 只保留视口附近的行

## 下载

macOS，未签名。Apple Silicon 与 Intel 各一份 dmg，见 [Releases](../../releases)。

1. 下载 `CC Reader_<version>_aarch64.dmg`（Apple Silicon）或 `_x86_64.dmg`（Intel）
2. 打开 dmg，把 **CC Reader** 拖进 Applications
3. 首次打开会被 Gatekeeper 拦下 —— 应用没有 Apple 开发者证书，放行一次即可：

   方式一：系统设置 → 隐私与安全性 → 「仍要打开」

   方式二（最稳，终端）：

```bash
xattr -dr com.apple.quarantine "/Applications/CC Reader.app"
open -a "CC Reader"
```

## 首次使用

1. 顶栏点「更新索引」建全量全文索引（约 35 秒 / 数万条消息，索引库数百 MB）
2. 左侧选项目，中间选会话（<kbd>↑</kbd> <kbd>↓</kbd> 直接切）
3. 搜索框输入内容可过滤标题 / 路径；回车走全文搜索，点击结果跳到该条消息

## 键盘

按焦点分区，不全局劫持：<kbd>↑</kbd> <kbd>↓</kbd> 在会话栏是切会话，在详情栏是原生滚动。

| 焦点 | 键 | 行为 |
|---|---|---|
| 全局 | <kbd>⌘F</kbd> / <kbd>Ctrl</kbd>+<kbd>F</kbd> | 聚焦搜索框 |
| 全局 | <kbd>Esc</kbd> | 清空搜索 / 失焦，焦点回会话栏 |
| 会话栏 | <kbd>↑</kbd> <kbd>↓</kbd> | 上一条 / 下一条会话 |
| 会话栏 | <kbd>Home</kbd> / <kbd>End</kbd> | 首条 / 末条 |
| 会话栏 | <kbd>PgUp</kbd> / <kbd>PgDn</kbd> | 翻 12 行 |
| 会话栏 | <kbd>Enter</kbd> | 焦点交给详情栏，回到消息流顶部 |
| 详情栏 | <kbd>n</kbd> / <kbd>j</kbd> | 下一条消息（滚动 + 短暂高亮） |
| 详情栏 | <kbd>p</kbd> / <kbd>k</kbd> | 上一条消息 |
| 详情栏 | <kbd>↑</kbd> <kbd>↓</kbd> / <kbd>Space</kbd> | 浏览器原生滚动，不劫持 |

## 命令行

GUI 与 CLI 是**同一个二进制**，按子命令分流 —— 打包出来的 `.app` 里不会多出几个可执行文件。

```bash
# 装好的 app
"/Applications/CC Reader.app/Contents/MacOS/cc-reader" search "环境变量" 20

# 从源码（cargo 的参数要用 -- 分隔，否则会被 cargo 自己吃掉）
cd src-tauri
cargo run --release -- index              # 增量索引，实测 0.4s
cargo run --release -- index --force      # 全量重建 + VACUUM，实测 35s
cargo run --release -- search "环境变量" 20
cargo run --release -- dump sessions      # 项目 / 会话索引 JSON
cargo run --release -- dump transcript <session.jsonl>
cargo run --release -- dump agents <session.jsonl>
```

## 从源码构建

依赖：macOS、Xcode Command Line Tools、Rust ≥ 1.77、[bun](https://bun.sh) 1.3+

```bash
bun install
bun run dev          # 原生窗口，热重载
bun run dev:web      # 只跑前端，浏览器 http://localhost:1420
bun run build        # 打包 .app + .dmg -> src-tauri/target/release/bundle/
```

`bun run dev:web` 是**浏览器预览模式**：前端检测不到 Tauri 时改读 `web/public/*.json`，
方便用 Playwright 截图迭代 UI。这些快照含真实会话内容，所以没有进版本库，需要自己 dump 一份：

```bash
cd src-tauri
cargo run --quiet -- dump sessions > ../web/public/sessions.json
cargo run --quiet -- dump transcript <session.jsonl> > ../web/public/transcript.json
```

## 数据与隐私

| | |
|---|---|
| 读取 | `~/.claude/projects/**.jsonl`（含 `subagents/`），只读 |
| 写入 | 只有全文索引库 `~/Library/Application Support/cc-reader/index.db` |
| 网络 | 不联网；字体走 npm 包打进产物，不请求 CDN |

会话内容不会离开本机，也不会上传任何地方。

## 工作原理

```
~/.claude/projects/<项目>/<session-id>.jsonl
  ├─ sessions.rs    项目 / 会话索引（标题 = 首条 user 消息）
  ├─ transcript.rs  JSONL → 消息树
  └─ <session-id>/subagents/agent-*.meta.json → 按需解析 agent-*.jsonl
                          │
        React 三栏 UI（虚拟滚动 + 折叠块按需挂载 + 主题变量）
                          │
        SQLite FTS5 (trigram) ←→ 全文搜索 / 锚点跳转
```

一条 assistant 消息可能同时含 `text` / `thinking` / `tool_use`，必须拆成独立节点，
否则工具调用无法与结果配对：

| 源 | 产出节点 |
|---|---|
| `type: user` + 字符串 content | `user` |
| `type: user` + 数组 content | `tool_result`（按 `tool_use_id` 挂到对应 `tool_use` 下） |
| `type: assistant` + `text` / `thinking` / `tool_use` block | 各自一个节点 |
| `type: system` | `system` |

**搜索分词用 trigram，不用默认的 `unicode61`**：后者把连续中文当成一个 token，
搜「搜索」匹配不到「全文搜索」。代价是 `MATCH` 要求查询 ≥3 字符，更短的查询回退 `LIKE`
（在 trigram 表上仍走 FTS5 索引）。工具输出只索引前 4KB，否则索引库会涨到 GB 级。

## 已知限制

- **transcript 是 Claude Code 的内部格式**，官方明说会变。解析器的正确性靠与
  `claude-code-log` 逐字段对拍维持，升级 Claude Code 后需要重新验证
- **未签名**：首次打开要手动放行一次，也没有自动更新
- 不渲染 `api-request` / `api-request-blob` / `api-request-shape`（发给模型的完整请求体），
  `claude-code-log` 同样跳过，属于共识
- 索引库数百 MB，是 trigram 分词的固有膨胀
- 只支持 macOS；只做阅读，不支持 resume / 执行会话

## 目录

| 路径 | 作用 |
|---|---|
| `src-tauri/src/sessions.rs` | 扫 `~/.claude/projects`，建项目 / 会话索引，路径 `~` 化 |
| `src-tauri/src/transcript.rs` | JSONL → 消息树（节点划分 / 建树 / agentId 提取） |
| `src-tauri/src/agents.rs` | subagent 元信息 + 按需解析 agent transcript |
| `src-tauri/src/index.rs` | FTS5 trigram 索引、增量更新、搜索 |
| `src-tauri/src/cli.rs` | 子命令 `index` / `search` / `dump` |
| `src/App.tsx` | 三栏布局、索引加载、前缀过滤、全文搜索、跳转 |
| `src/MessageList.tsx` | 消息渲染（markdown / diff / 折叠 / subagent 懒加载 / 锚点） |
| `src/styles.css` | 设计系统（配色 / 字号 / 密度 / 双主题） |
| `scripts/compare-parsers.py` | 解析器对拍工具 |
| `scripts/build-icons.sh` | 手写 SVG → 全套图标 |
| `.github/workflows/release.yml` | push `v*` tag 触发双架构 dmg 构建与上传 |

## 解析器对拍

自己写解析器最大的风险是「不知道自己漏了什么」，所以用
[claude-code-log](https://github.com/daaain/claude-code-log)（独立实现）当参照物逐字段对拍。
改动 `transcript.rs` 的解析逻辑后必须重跑：

```bash
cd src-tauri
ccl convert <session.jsonl> -o /tmp/verify/<id>.ccl.json --format json
cargo run --release -- dump transcript <session.jsonl> > /tmp/verify/<id>.mine.json
python3 ../scripts/compare-parsers.py <id>
```

基线是 **claude-code-log 零缺失**（CC Reader 是超集，ccl 会丢弃约 8% 的重复 `tool_use`）。
这套对拍抓到过两个靠读代码发现不了的 bug：噪音消息没过滤、建树时子节点重复计数 ——
两者都表现为「数字看着差不多」。

## 致谢

- [claude-code-log](https://github.com/daaain/claude-code-log) —— 解析层对拍基准，很多坑是靠它暴露的
- [JetBrains Mono](https://www.jetbrains.com/lp/mono/)（SIL OFL 1.1）—— 界面等宽字体，随产物打包

## 许可

[MIT](LICENSE)
