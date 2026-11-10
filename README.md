# Pi-buddy

[简体中文](#zh) · [English](#en)

> 给 [Pi](https://pi.dev) 命令行编码助手做的本地图形界面。双击启动，关掉网页自动退出，像一个普通的 Windows 程序。

---

<a id="zh"></a>

## 简体中文

[功能](#features-zh) · [快速开始](#start-zh) · [技术](#tech-zh) · [许可证](#license-zh) · [English](#en)

Pi-buddy 是 Pi 的**本地前端**：它不替代 Pi，而是把 Pi 的会话、模型、技能与工具能力放进一个浏览器窗口里。所有数据留在自己电脑上，服务只监听 `127.0.0.1`。

<a id="features-zh"></a>

### 功能

**对话与会话**
- 流式输出，同一个提问里的多轮工具调用合并成一个气泡；Markdown 标题、列表、代码块、表格实时渲染
- 会话历史恢复、置顶、删除；标题自动取首条提问；随时中止正在进行的回答
- 首轮遇到 429 / 网络错误时自动换干净会话重发，气泡里显示重试与失败原因
- 计划（Plan）、仅问答（Ask）、Agent 三种模式，以及完全访问权限开关

**模型、技能与连接器**
- 模型热切换、连通性测试、手动添加自定义模型；按服务商列出可用模型
- 技能：扫描用户级与项目级多个目录，可单独启停
- MCP 连接器：读取用户级与项目级 `mcp.json`，也识别 Pi 扩展里 `registerMcpServer()` 动态注册的连接器；可单独启停
- 专家预设（办公 / 开发 / 设计）一次挂好模式、系统提示词、技能与连接器；场景预设一键切换
- 没装 Pi 时首页直接给出安装命令，装完点「重新检测」即可，不必重启

**文件与产物**
- 附件上传（支持中文文件名）、工作文件夹挂载
- 资料库：按文件名或路径检索已挂载目录里的文件
- 工具写出的文件以产物卡牌呈现，点一下用系统默认程序打开
- 代码块高亮、一键复制

**任务与提醒**
- 定时任务：每天 / 每周 / 固定间隔，可跑一次性提示词，结果只记录状态与摘要
- 任务完成提醒：浏览器通知（Windows 上即系统通知）或 PowerShell 通知，可发测试通知
- 网络与重试参数（重试次数、基础间隔、最大等待）在设置里可调

**界面与个性化**
- 界面语言跟随系统：简体 / 繁体中文显示中文，其它语言显示英文；AI 回复内容不会被翻译
- 自定义首页标志：PNG / JPG / GIF / WebP / AVIF / BMP，单张不超过 10 MB，等比缩放不拉伸
- 动图可选**循环播放**或**点击播放**（显示静帧，点一下播一轮后还原）
- 侧栏菜单显隐、Markdown 输出开关
- 左侧侧边栏可一键收起 / 展开；窄屏或竖屏（含 Windows 11 三分屏）自动收起，仍可手动打开
- 侧边栏宽度可拖动右侧边调整（不超过窗口宽度的 75%），宽度会被记住

**像普通桌面软件一样使用**
- 无窗口启动，全程没有黑色终端；运行日志写到 `data/server.log`
- 解压后会**先询问**是否在桌面创建快捷方式，图标使用程序 LOGO
- 关闭网页后后台服务与 Pi 进程自动退出；也可手动停止
- 另有带终端的调试启动器，供排错使用

<a id="start-zh"></a>

### 快速开始

1. 安装 [Node.js 20+](https://nodejs.org) 与 Pi CLI：
   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```
2. 解压到任意文件夹后会询问是否在桌面创建快捷方式；也可随时双击 `创建桌面快捷方式.vbs` 重新创建。
3. 双击桌面图标（或解压目录里的 `启动.vbs`）启动：无终端窗口，浏览器自动打开 `http://127.0.0.1:7788`。
4. 关闭所有网页后服务与 Pi 进程自动退出；`停止.vbs` 可手动停止，排错用 `启动.cmd`（显示终端与日志）。

> 没装 Pi 时首页会直接给出安装命令，装完点「重新检测」即可，不必重启服务。


<a id="tech-zh"></a>

### 技术

- 只有两个源文件：`index.html`（HTML / CSS / JS 全内联）与 `server.js`（仅 Node.js 内置模块）。**零 npm 依赖、无构建步骤**。
- 需要 Node.js 20+，以及用户自行安装的 Pi CLI（`npm install -g @earendil-works/pi-coding-agent`）。本项目**不捆绑 Pi 的代码**，只通过 `pi --mode rpc` 子进程通信，按 LF 切分 JSONL，再用 SSE 推给浏览器。
- 默认 `127.0.0.1:7788`；端口被占用或落在系统保留段时自动 +1。配置存 `data/app.json`，上传的 LOGO 存 `data/`，日志存 `data/server.log`。
- 分发包是手动制作的自解压压缩包（Bandizip SFX 格式），只含程序文件，不含任何运行时。
- 版本号采用 **年份.月份.第几次更新**（如 `26.11.1`）；设置页的「检查更新」同时查询 Gitee 与 GitHub 的最新 Release，**下载源可选「自动 / Gitee / GitHub」，默认自动**，并以主源的版本为准。自动模式在后台探测 `google.com` 等大陆无法直连的 `generate_204` 端点（多数可达判为海外 → GitHub，否则 → Gitee），整体断网时回退到系统区域判断；也可用 `PIBUDDY_REGION=cn|global` 覆盖。
- 双语实现为中文源文 + 渲染层替换，不改动任何业务数据与聊天内容。

<a id="license-zh"></a>

### 许可证

本项目采用 **Apache License 2.0（SPDX: `Apache-2.0`）**，完整文本见根目录的 [LICENSE](./LICENSE)。

**衍生项目必须注明来源。** 协议第 4 条要求任何对外分发的衍生作品：

- 随附一份协议副本（§4a）
- 在改动过的文件里标明改过（§4b）
- 保留源码中的版权、专利、商标与归属声明（§4c）
- 保留 [NOTICE](./NOTICE) 中的归属声明，放在衍生作品自己的 NOTICE、随附文档，或界面中通常展示第三方声明的位置（例如「关于」页）（§4d）

`NOTICE` 写明「本产品包含 Pi-buddy 项目开发的软件」；保留它即等于注明使用了本项目的代码。协议另含明确的专利授权（§3），并明确规定**不授予商标权**（§6）。

> Copyright 2026 Pi-buddy contributors

**第三方字体**：`index.html` 内嵌了 [Silkscreen](https://github.com/googlefonts/silkscreen) Regular 像素字体，版权归 The Silkscreen Project Authors，按 **SIL Open Font License 1.1** 单独授权（全文见 [OFL.txt](./OFL.txt)），**不在本项目 Apache-2.0 的授权范围内**。


**边界说明**：Node.js、Pi CLI 及其名称 / LOGO 都不属于本项目。Pi 的名称与标志是 Earendil 的商标，Pi-buddy 是非官方的第三方前端，与 Earendil 无关联、也未获其背书。项目不分发任何官方标志素材。仅解压使用、未修改代码的用户不受上述分发义务约束。

[← 顶部](#pi-buddy) · [→ English](#en)

---

<a id="en"></a>

## English

[Features](#features-en) · [Quick start](#start-en) · [Tech](#tech-en) · [License](#license-en) · [简体中文](#zh)

Pi-buddy is a **local front-end** for [Pi](https://pi.dev), the terminal coding agent. It does not replace Pi; it puts Pi's sessions, models, skills and tools into a browser window. Everything stays on your machine, and the server listens on `127.0.0.1` only.

<a id="features-en"></a>

### Features

**Chat & sessions**
- Streaming replies; multiple tool-call rounds within one question are merged into a single bubble. Live Markdown rendering for headings, lists, code blocks and tables.
- Restore, pin and delete past sessions; titles are derived from the first message; abort a running answer at any time.
- Automatic retry with a clean session on first-turn 429 / network failures, with retry and error notices inside the bubble.
- Plan / Ask / Agent modes, plus a full-access toggle.

**Models, skills & connectors**
- Hot-swap models, test connectivity, add custom models; available models grouped by provider.
- Skills: scans both user-level and project-level directories, individually toggleable.
- MCP connectors: reads user-level and project-level `mcp.json`, and also detects servers registered dynamically by Pi extensions via `registerMcpServer()`; individually toggleable.
- Expert presets (Office / Dev / Design) attach mode, system prompt, skills and connectors in one click; scene presets switch context instantly.
- If Pi is missing, the home page shows the install command; click "Check again" after installing — no restart needed.

**Files & artifacts**
- Attachment uploads (including non-ASCII filenames) and working-folder mounting.
- Library: search mounted folders by filename or path.
- Files written by tools appear as artifact cards that open with the system default program.
- Syntax-highlighted code blocks with one-click copy.

**Tasks & notifications**
- Scheduled tasks: daily / weekly / fixed interval, or one-shot prompts whose results are logged as status and summary.
- Task-completion alerts: browser notifications (system toasts on Windows) or PowerShell notifications, with a test button.
- Configurable retry knobs (max retries, base delay, max wait).

**Interface & personalization**
- UI language follows the system: Simplified / Traditional Chinese → Chinese, everything else → English. AI replies are never translated.
- Custom home logo: PNG / JPG / GIF / WebP / AVIF / BMP, up to 10 MB, scaled proportionally without stretching.
- Animated logos can **loop** or **play on click** (a still frame that plays one cycle when clicked).
- Toggle sidebar sections and Markdown output.
- Collapse / expand the sidebar with one click; it auto-collapses on narrow or portrait windows (including Windows 11 three-column snap) and can still be opened manually.
- Drag the sidebar's right edge to resize it (up to 75% of the window width); the width is remembered.

**Works like a regular desktop app**
- Windowless startup with no black console; logs go to `data/server.log`.
- After extraction, the user is **asked** whether to create a desktop shortcut, using the project logo as its icon.
- Closing the web page shuts down the server and Pi processes; a manual stop script is also provided.
- A console-bearing debug launcher is included for troubleshooting.

<a id="start-en"></a>

### Quick start

1. Install [Node.js 20+](https://nodejs.org) and the Pi CLI:
   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```
2. After extraction you will be asked whether to create a desktop shortcut; you can also double-click `创建桌面快捷方式.vbs` at any time to recreate it.
3. Double-click the desktop icon (or `启动.vbs` in the extracted folder). There is no console window, and the browser opens `http://127.0.0.1:7788` automatically.
4. Closing all pages shuts down the server and Pi processes. Use `停止.vbs` to stop manually, or `启动.cmd` for a console with logs when troubleshooting.

> If Pi is missing, the home page shows the install command; click "Check again" after installing - no restart needed.


<a id="tech-en"></a>

### Tech

- Two source files only: `index.html` (inline HTML / CSS / JS) and `server.js` (Node.js built-in modules only). **No npm dependencies, no build step.**
- Requires Node.js 20+ and a user-installed Pi CLI (`npm install -g @earendil-works/pi-coding-agent`). **No Pi code is bundled**: Pi-buddy spawns `pi --mode rpc`, splits its JSONL output on LF, and streams events to the browser over SSE.
- Defaults to `127.0.0.1:7788`; the port increments automatically when occupied or reserved by the OS. Settings live in `data/app.json`, uploaded logos in `data/`, logs in `data/server.log`.
- Distributed as a manually built self-extracting archive (Bandizip SFX) containing program files only — no runtime included.
- Versions follow **year.month.sequence** (e.g. `26.11.1`). “Check for updates” in Settings queries both Gitee and GitHub; **the download source can be set to Auto / Gitee / GitHub (Auto by default)**, and the preferred source decides the latest version. Auto mode probes `generate_204` endpoints such as `google.com` that are not directly reachable from mainland China (reachable from most probes → GitHub; otherwise → Gitee), falling back to the system region when the network is down. Override with `PIBUDDY_REGION=cn|global`.
- Bilingual UI = Chinese source text plus a render-time replacement layer; business data and chat content are untouched.

<a id="license-en"></a>

### License

Released under the **Apache License 2.0 (SPDX: `Apache-2.0`)**. The full text is in [LICENSE](./LICENSE) at the repository root.

**Derivative works must credit this project.** Section 4 requires anyone distributing a derivative work to:

- Include a copy of the license (§4a)
- Mark modified files with prominent change notices (§4b)
- Retain all copyright, patent, trademark and attribution notices from the source (§4c)
- Reproduce the attribution notices in [NOTICE](./NOTICE) — in the derivative's own NOTICE file, its accompanying documentation, or wherever third-party notices normally appear in its UI (for example an About page) (§4d)

`NOTICE` states that the product includes software developed by the Pi-buddy project; retaining it is what credits this codebase. The license also grants an explicit patent license (§3) and expressly **grants no trademark rights** (§6).

> Copyright 2026 Pi-buddy contributors

**Third-party font**: `index.html` embeds the [Silkscreen](https://github.com/googlefonts/silkscreen) Regular pixel font, (c) The Silkscreen Project Authors, licensed separately under the **SIL Open Font License 1.1** (full text in [OFL.txt](./OFL.txt)). It is **not covered by this project's Apache-2.0 license**.


**Scope**: Node.js, the Pi CLI, and the Pi name / logo are not part of this project. The Pi name and logo are trademarks of Earendil; Pi-buddy is an unofficial third-party front-end, unaffiliated with and not endorsed by Earendil. No official brand assets are distributed. Users who merely unpack and run the software without modifying it are not subject to these redistribution obligations.

[← Top](#pi-buddy) · [→ 简体中文](#zh)
