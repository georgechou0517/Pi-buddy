/*
 * Copyright 2026 Pi-buddy contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

/*
 * Pi-buddy 本地服务
 *
 * 只依赖 Node 内置模块，不安装、不修改用户已有的 Pi。
 * 职责三件事：
 *   1. 托管 index.html
 *   2. 把浏览器发来的指令翻译成 pi 的命令行参数与 RPC 命令
 *   3. 把 pi 的 JSONL 事件流转换成 SSE 推给浏览器
 */

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// ---------------------------------------------------------------- 常量

const APP_VERSION = '0.1.0';
const ROOT = __dirname;
const INDEX_HTML = path.join(ROOT, 'index.html');
const DATA_DIR = path.join(ROOT, 'data');
const APP_JSON = path.join(DATA_DIR, 'app.json');

const HOME = os.homedir();
const PI_AGENT = path.join(HOME, '.pi', 'agent');
const PI_SESSIONS = path.join(PI_AGENT, 'sessions');
const PI_MODELS = path.join(PI_AGENT, 'models.json');
const PI_MCP = path.join(PI_AGENT, 'mcp.json');
const PI_SETTINGS = path.join(PI_AGENT, 'settings.json');
const PI_SKILLS = path.join(PI_AGENT, 'skills');

const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.PIBUDDY_PORT || 7788);
let activePort = BASE_PORT;
let URL_BASE = 'http://' + HOST + ':' + activePort;

const MD_NOTICE_MARK = '—— 以下为用户输入 ——';
const MD_NOTICE_HEAD = '【输出格式】本轮对话请使用 Markdown 组织回复';

// 通过系统提示词告诉模型用 Markdown，不再往用户消息里塞文本，避免污染会话历史
const MD_SYSTEM_NOTICE = '【输出格式】回复请使用 Markdown 组织：按需使用标题、列表、加粗、代码块和表格，便于在图形界面里渲染。不要因此改变任务本身。';

// 兼容早期版本：旧会话的首条用户消息里确实带着这段声明，展示时剥掉
function stripMdNotice(text) {
  if (typeof text !== 'string') return '';
  if (!text.trimStart().startsWith(MD_NOTICE_HEAD)) return text;
  const idx = text.indexOf(MD_NOTICE_MARK);
  if (idx === -1) return text;
  return text.slice(idx + MD_NOTICE_MARK.length).trimStart();
}

const SIDEBAR_KEYS = ['assistant', 'experts', 'cron', 'library', 'more', 'tasks', 'spaces'];

const DEFAULT_APP = {
  version: 1,
  ui: {
    markdown: true,
    sidebar: { assistant: true, experts: true, cron: true, library: true, more: true, tasks: true, spaces: true }
  },
  skills: { disabled: [] },
  mcp: { disabled: [] },
  spaces: [],
  pinned: [],
  lastModel: null,
  logo: null,
  notify: { mode: 'browser' },
  cron: [],
  experts: []
};

const PRESETS = {
  office: {
    key: 'office',
    label: '办公',
    emoji: '🍵',
    hint: '文档、表格、汇报',
    systemPrompt: '你是一位办公助理，擅长撰写文档、整理表格、生成汇报材料。回复请用 Markdown 组织，需要展示数据时优先使用表格。',
    mode: 'agent'
  },
  dev: {
    key: 'dev',
    label: '开发',
    emoji: '💻',
    hint: '写代码、调试、重构',
    systemPrompt: '你是一位资深软件工程师。先读代码再改，改动保持最小且完整，给出可运行的代码并说明验证方式。回复用 Markdown 组织。',
    mode: 'agent'
  },
  design: {
    key: 'design',
    label: '设计',
    emoji: '🎨',
    hint: '界面、配色、原型',
    systemPrompt: '你是一位产品设计师，关注信息层级、留白、配色与可访问性。给出具体数值与理由，必要时用 Markdown 表格对比方案。',
    mode: 'agent'
  }
};

/*
 * 常见提供商的接入预设。Pi 本身支持 openai-completions / anthropic-messages /
 * google-generative-ai 等协议，这里只是把常用厂商的 baseUrl 预先填好，省得手抄。
 */
const BUILTIN_PROVIDERS = [
  { key: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai-completions' },
  { key: 'anthropic', name: 'Anthropic Claude', baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages' },
  { key: 'google', name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com', api: 'google-generative-ai' },
  { key: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', api: 'openai-completions' },
  { key: 'moonshot', name: 'Moonshot 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', api: 'openai-completions' },
  { key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', api: 'openai-completions' },
  { key: 'qwen', name: '通义千问 DashScope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api: 'openai-completions' },
  { key: 'sensenova', name: '商汤日日新', baseUrl: 'https://token.sensenova.cn/v1', api: 'openai-completions' },
  { key: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions' },
  { key: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions' },
  { key: 'xai', name: 'xAI Grok', baseUrl: 'https://api.x.ai/v1', api: 'openai-completions' },
  { key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai-completions' }
];

// 记住上次用的模型，下次打开直接显示它
function rememberModel(model) {
  if (!model || !model.id) return;
  const app = readApp();
  app.lastModel = { provider: model.provider || '', id: model.id };
  writeApp(app);
}

// ---------------------------------------------------------------- 小工具

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [] : Object.assign({}, base);
  for (const k of Object.keys(patch)) {
    const bv = base ? base[k] : undefined;
    const pv = patch[k];
    out[k] = pv && typeof pv === 'object' && !Array.isArray(pv) ? deepMerge(bv || {}, pv) : pv;
  }
  return out;
}

function readApp() {
  try {
    const raw = JSON.parse(fs.readFileSync(APP_JSON, 'utf8'));
    return deepMerge(DEFAULT_APP, raw);
  } catch {
    return structuredClone(DEFAULT_APP);
  }
}

let appWriteChain = Promise.resolve();
function writeApp(app) {
  appWriteChain = appWriteChain.then(async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(APP_JSON, JSON.stringify(app, null, 2), 'utf8');
  }).catch(err => console.error('[app.json] 写入失败:', err.message));
  return appWriteChain;
}

// ---------------------------------------------------------------- 重试设置

/*
 * Pi 自带 agent 级自动重试，参数在 settings.json 的 retry 段：
 *   retry.enabled / retry.maxRetries / retry.baseDelayMs / retry.maxAgentDelayMs
 * 没有对应的环境变量或命令行参数，只能写配置文件，所以这里只改这四个键，其余原样保留。
 */
const RETRY_DEFAULTS = { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60000 };

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readRetrySettings() {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(PI_SETTINGS, 'utf8')); } catch { /* 文件不存在或损坏 */ }
  const retry = raw.retry || {};
  return {
    enabled: retry.enabled !== false,
    maxRetries: Number.isFinite(retry.maxRetries) ? retry.maxRetries : RETRY_DEFAULTS.maxRetries,
    baseDelayMs: Number.isFinite(retry.baseDelayMs) ? retry.baseDelayMs : RETRY_DEFAULTS.baseDelayMs,
    maxAgentDelayMs: Number.isFinite(retry.maxAgentDelayMs) ? retry.maxAgentDelayMs : RETRY_DEFAULTS.maxAgentDelayMs
  };
}

async function writeRetrySettings(patch) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(PI_SETTINGS, 'utf8')); } catch { /* 从空对象开始 */ }

  const backup = PI_SETTINGS + '.pibuddy.bak';
  if (fs.existsSync(PI_SETTINGS) && !fs.existsSync(backup)) {
    try { await fsp.copyFile(PI_SETTINGS, backup); } catch { /* 备份失败不阻塞写入 */ }
  }

  raw.retry = Object.assign({}, raw.retry || {}, {
    enabled: patch.enabled !== false,
    maxRetries: clampNumber(patch.maxRetries, 1, 20, RETRY_DEFAULTS.maxRetries),
    baseDelayMs: clampNumber(patch.baseDelayMs, 200, 600000, RETRY_DEFAULTS.baseDelayMs),
    maxAgentDelayMs: clampNumber(patch.maxAgentDelayMs, 1000, 3600000, RETRY_DEFAULTS.maxAgentDelayMs)
  });

  await fsp.mkdir(PI_AGENT, { recursive: true });
  await fsp.writeFile(PI_SETTINGS, JSON.stringify(raw, null, 2), 'utf8');
  return raw.retry;
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function fail(res, code, message) {
  json(res, code, { ok: false, error: message });
}

async function readBody(req, limitBytes) {
  const max = limitBytes || 2 * 1024 * 1024;
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > max) throw new Error('请求体超过上限');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  const buf = Buffer.concat(chunks);
  const text = buf.toString('utf8');
  try { return JSON.parse(text); } catch { return { __raw: buf, __text: text }; }
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.md', '.markdown', '.txt', '.rst'].includes(ext)) return 'doc';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'].includes(ext)) return 'image';
  if (['.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.css', '.html', '.json', '.yaml', '.yml', '.toml', '.sh', '.ps1'].includes(ext)) return 'code';
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].includes(ext)) return 'office';
  if (['.csv', '.tsv', '.sql', '.db'].includes(ext)) return 'data';
  if (['.zip', '.tar', '.gz', '.7z', '.rar'].includes(ext)) return 'archive';
  return 'other';
}

function humanSize(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function shortText(s, n) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// ---------------------------------------------------------------- Pi 定位

let PI_ENTRY = null;
let PI_VERSION = '未知';

function findPackageVersion(startDir) {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        if (j.version) return j.version;
      } catch { /* 忽略损坏的 package.json */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '未知';
}

// 在 PATH 里找 pi 的启动器（npm / pnpm / yarn / bun 生成的 shim 都会出现在这里）
function findOnPath(names) {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full)) return full;
      } catch { /* 无权限的目录跳过 */ }
    }
  }
  return null;
}

// shim 内写着真实入口的绝对路径，把里面所有 cli.js 抠出来
function resolveShim(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return (text.match(/[^\s"']*cli\.js/g) || []).map(hit => hit.replace(/^['"]|['"]$/g, ''));
  } catch {
    return [];
  }
}

function locatePi() {
  const candidates = [];
  if (process.env.PI_ENTRY) candidates.push(process.env.PI_ENTRY);

  // 1. 优先跟随 PATH 上的 pi 命令，这样换包管理器 / 换安装目录都能适配
  const shim = findOnPath(['pi.cmd', 'pi.exe', 'pi.bat', 'pi']);
  if (shim) candidates.push(...resolveShim(shim));

  // 2. npm 全局标准位置
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  candidates.push(path.join(appData, 'npm', 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'));
  // 3. 与当前 node 同级的全局目录
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js'));
  // 4. 类 Unix 常见位置
  candidates.push('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
  candidates.push('/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) { PI_ENTRY = candidate; break; }
  }

  if (PI_ENTRY) {
    PI_VERSION = findPackageVersion(path.dirname(PI_ENTRY));
  } else {
    // 兜底：settings.json 里记着上次运行的版本号
    try {
      const s = JSON.parse(fs.readFileSync(PI_SETTINGS, 'utf8'));
      if (s.lastChangelogVersion) PI_VERSION = s.lastChangelogVersion;
    } catch { /* 保持未知 */ }
  }
}

function piCommand() {
  if (PI_ENTRY) return { cmd: process.execPath, pre: [PI_ENTRY] };
  if (process.platform === 'win32') return { cmd: 'pi.cmd', pre: [], shell: true };
  return { cmd: 'pi', pre: [] };
}

// ---------------------------------------------------------------- JSONL 切分

/*
 * RPC 使用严格 JSONL：只按 LF 切分。
 * 不能用 readline，它会把 U+2028 / U+2029 当成换行，那两个字符在 JSON 字符串里是合法的。
 */
class JsonlSplitter {
  constructor() { this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const lines = [];
    let idx;
    while ((idx = this.buf.indexOf(0x0a)) !== -1) {
      let seg = this.buf.subarray(0, idx);
      this.buf = this.buf.subarray(idx + 1);
      if (seg.length && seg[seg.length - 1] === 0x0d) seg = seg.subarray(0, seg.length - 1);
      if (seg.length) lines.push(seg.toString('utf8'));
    }
    return lines;
  }
}

// ---------------------------------------------------------------- RPC 客户端

class RpcClient {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.splitter = new JsonlSplitter();
    this.pending = new Map();
    this.seq = 0;
    this.handlers = new Set();
    this.alive = false;
    this.stderrTail = '';
  }

  on(fn) { this.handlers.add(fn); return () => this.handlers.delete(fn); }

  emit(ev) {
    for (const fn of this.handlers) {
      try { fn(ev); } catch (err) { console.error('[rpc handler]', err.message); }
    }
  }

  start() {
    const base = piCommand();
    const args = [...base.pre, '--mode', 'rpc', ...this.options.args];
    const env = Object.assign({}, process.env, { NO_COLOR: '1', FORCE_COLOR: '0' });
    const spawnOptions = {
      cwd: this.options.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    };
    if (base.shell) spawnOptions.shell = true;

    this.child = spawn(base.cmd, args, spawnOptions);
    this.alive = true;

    this.child.stdout.on('data', chunk => this.feed(chunk));

    this.child.stderr.on('data', chunk => {
      const text = chunk.toString('utf8');
      this.stderrTail = (this.stderrTail + text).slice(-8000);
      this.emit({ type: '__log', text: text.slice(0, 4000) });
    });

    this.child.on('error', err => {
      this.alive = false;
      this.emit({ type: '__fatal', message: err.message });
    });

    this.child.on('exit', (code, signal) => {
      this.alive = false;
      this.rejectAll(new Error('Pi 进程已退出'));
      this.emit({ type: '__exit', code, signal, stderr: this.stderrTail });
    });
  }

  feed(chunk) {
    for (const line of this.splitter.push(chunk)) {
      let record;
      try { record = JSON.parse(line); } catch {
        this.emit({ type: '__log', text: '[非 JSON 行] ' + line.slice(0, 300) });
        continue;
      }
      if (record.type === 'response' && record.id && this.pending.has(record.id)) {
        const waiter = this.pending.get(record.id);
        this.pending.delete(record.id);
        if (record.success) waiter.resolve(record);
        else waiter.reject(new Error(record.error || ('命令失败: ' + record.command)));
        continue;
      }
      this.emit(record);
    }
  }

  rejectAll(err) {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }

  send(command, timeoutMs) {
    if (!this.alive || !this.child) return Promise.reject(new Error('会话进程未运行'));
    const id = 'c' + (++this.seq);
    const payload = Object.assign({ id }, command);
    const limit = timeoutMs || 30000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('命令超时: ' + command.type));
      }, limit);

      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); }
      });

      try {
        this.child.stdin.write(JSON.stringify(payload) + '\n', 'utf8');
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async stop() {
    if (!this.child) return;
    const child = this.child;
    try { child.stdin.end(); } catch { /* 已关闭 */ }
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 已退出 */ }
        resolve();
      }, 2500);
      if (child.exitCode !== null) { clearTimeout(timer); resolve(); return; }
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    this.alive = false;
  }
}

// ---------------------------------------------------------------- 会话参数拼装

/*
 * 所有界面开关都落到这里：把「模式 / 技能 / 连接器 / 权限 / 模型」翻译成 pi 的原生参数。
 * 一个请求对应一串 flags，不写 Pi 扩展、不改 ~/.pi 下的任何配置。
 */
function buildSessionArgs(opts) {
  const args = [];

  if (opts.model) args.push('--model', String(opts.model));
  if (opts.provider) args.push('--provider', String(opts.provider));
  if (opts.name) args.push('--name', String(opts.name));
  if (opts.sessionPath) args.push('--session', String(opts.sessionPath));
  if (opts.thinking) args.push('--thinking', String(opts.thinking));

  if (opts.skillPath) {
    args.push('--no-skills', '--skill', String(opts.skillPath));
  } else if (opts.skillsOff) {
    args.push('--no-skills');
  }

  if (opts.mcpMode === 'none') {
    args.push('--no-mcp');
  } else if (opts.mcpMode === 'only' && Array.isArray(opts.mcpExclude) && opts.mcpExclude.length) {
    args.push('--exclude-tools', opts.mcpExclude.join(','));
  }

  if (opts.mode === 'ask') {
    args.push('--no-tools');
  } else if (opts.mode === 'plan') {
    args.push('--tools', 'read,grep,find,ls');
  }

  args.push(opts.fullAccess ? '--approve' : '--no-approve');

  if (opts.systemPrompt) args.push('--append-system-prompt', String(opts.systemPrompt));
  // 新会话才追加 Markdown 指令；恢复旧会话时不动它的系统提示
  if (opts.markdown !== false && !opts.sessionPath) {
    args.push('--append-system-prompt', MD_SYSTEM_NOTICE);
  }

  return args;
}

// ---------------------------------------------------------------- 会话

const sessions = new Map();
let sessionSeq = 0;

const ARTIFACT_SKIP_DIRS = new Set([
  'node_modules', '.git', '.pibuddy', 'dist', 'build', '__pycache__', '.venv', 'venv',
  'AppData', 'AppDataLocal', 'Library', 'Applications', '.cache', 'Temp', 'tmp', '.npm', '.config'
]);

class Session {
  constructor(id, rpc, meta) {
    this.id = id;
    this.rpc = rpc;
    this.meta = meta;
    this.clients = new Set();
    this.messages = [];
    this.busy = false;
    this.startedAt = Date.now();
    this.lastActive = Date.now();
    this.artifacts = new Map();
    this.pendingToolPaths = new Map();
    this.buffer = new Map();
    this.piState = null;
    this.turnStartedAt = 0;
    this.lastPrompt = '';
    this.retryCount = 0;
    this.successTurns = 0;
    this.retryTimer = null;
  }

  bind() {
    this.rpc.on(ev => this.handle(ev));
  }

  push(event) {
    const line = 'data: ' + JSON.stringify(event) + '\n\n';
    for (const client of this.clients) {
      try { client.res.write(line); } catch { this.clients.delete(client); }
    }
  }

  handle(ev) {
    this.lastActive = Date.now();

    switch (ev.type) {
      case 'message_update': {
        const delta = ev.assistantMessageEvent;
        if (!delta) return;
        if (delta.type === 'text_delta') {
          const key = delta.contentIndex || 0;
          this.buffer.set(key, (this.buffer.get(key) || '') + delta.delta);
          this.push({ type: 'delta', index: key, text: delta.delta });
        } else if (delta.type === 'text_end') {
          this.buffer.set(delta.contentIndex || 0, delta.content || '');
          this.push({ type: 'text_end', index: delta.contentIndex || 0, text: delta.content || '' });
        } else if (delta.type === 'toolcall_start') {
          this.push({ type: 'tool_call', id: delta.id, name: delta.toolName });
        }
        return;
      }

      case 'message_start':
        return;

      case 'message_end': {
        this.buffer.clear();
        const message = ev.message || null;
        if (message) {
          this.messages.push(message);
          if (message.role === 'assistant' && message.stopReason && message.stopReason !== 'error') {
            this.successTurns += 1;
          }
        }
        this.push({ type: 'message', message });
        return;
      }

      case 'tool_execution_start': {
        const target = ev.args && (ev.args.path || ev.args.file_path || ev.args.filePath);
        if (target && (ev.toolName === 'write' || ev.toolName === 'edit' || ev.toolName === 'create')) {
          this.pendingToolPaths.set(ev.toolCallId, target);
        }
        this.push({
          type: 'tool',
          phase: 'start',
          id: ev.toolCallId,
          name: ev.toolName,
          args: summarizeToolArgs(ev.args)
        });
        return;
      }

      case 'tool_execution_end': {
        const target = this.pendingToolPaths.get(ev.toolCallId);
        if (target && !ev.isError) this.addArtifact(target, 'tool');
        this.pendingToolPaths.delete(ev.toolCallId);
        this.push({
          type: 'tool',
          phase: 'end',
          id: ev.toolCallId,
          name: ev.toolName,
          isError: !!ev.isError,
          durationMs: ev.durationMs
        });
        return;
      }

      case 'agent_start':
        this.busy = true;
        this.turnStartedAt = Date.now();
        this.buffer.clear();
        this.push({ type: 'start' });
        return;

      case 'auto_retry_start':
        this.push({
          type: 'retry',
          phase: 'start',
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          errorMessage: shortText(ev.errorMessage || '', 300)
        });
        return;

      case 'auto_retry_end':
        this.push({
          type: 'retry',
          phase: 'end',
          success: !!ev.success,
          attempt: ev.attempt,
          finalError: shortText(ev.finalError || '', 300)
        });
        return;

      case 'agent_settled': {
        this.busy = false;
        const lastAssistant = [...this.messages].reverse().find(m => m && m.role === 'assistant');
        const failed = !!(lastAssistant && lastAssistant.stopReason === 'error');

        // 首轮就失败（典型是 429）时由这里接管重试：重建会话再发一次，历史里不会堆重复提问
        if (failed && !ev.aborted && this.canAutoRetry()) {
          this.scheduleAutoRetry(lastAssistant.errorMessage || '');
          return;
        }

        this.retryCount = 0;
        this.push({ type: 'settled', aborted: !!ev.aborted });
        this.scanArtifacts().catch(() => {});
        return;
      }

      case 'session_info_changed':
        this.meta.name = ev.name || '';
        this.push({ type: 'name', name: ev.name || '' });
        return;

      case '__exit':
        this.busy = false;
        this.push({ type: 'exit', code: ev.code, stderr: shortText(ev.stderr || '', 1500) });
        return;

      case '__fatal':
        this.push({ type: 'error', message: ev.message });
        return;

      case '__log':
        return;

      default:
        return;
    }
  }

  addArtifact(rawPath, source) {
    let abs;
    try {
      abs = path.resolve(this.meta.cwd, String(rawPath));
    } catch {
      return;
    }
    if (!isInside(this.meta.cwd, abs)) return;
    if (this.artifacts.has(abs)) return;

    let stat;
    try { stat = fs.statSync(abs); } catch { return; }
    if (!stat.isFile()) return;

    const artifact = {
      path: abs,
      name: path.basename(abs),
      dir: path.dirname(abs),
      size: stat.size,
      sizeText: humanSize(stat.size),
      kind: kindOf(abs),
      mtime: stat.mtimeMs,
      source: source
    };
    this.artifacts.set(abs, artifact);
    this.push({ type: 'artifact', artifact });
  }

  canAutoRetry() {
    const config = readRetrySettings();
    if (!config.enabled) return false;
    if (this.retryCount >= config.maxRetries) return false;
    if (this.successTurns > 0) return false;
    return true;
  }

  /*
   * 首轮失败的重试：先 new_session 换一个干净会话，再原样重发。
   * 这样失败记录不会堆在对话历史里，用户看到的仍是「一个问题、一个回答」。
   */
  scheduleAutoRetry(errorMessage) {
    const config = readRetrySettings();
    this.retryCount += 1;
    const delay = Math.min(
      config.baseDelayMs * Math.pow(2, this.retryCount - 1),
      config.maxAgentDelayMs
    );

    this.push({
      type: 'retry',
      phase: 'start',
      attempt: this.retryCount,
      maxAttempts: config.maxRetries,
      delayMs: delay,
      errorMessage: shortText(errorMessage, 300)
    });

    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      try {
        const reset = await this.rpc.send({ type: 'new_session' }, 20000);
        if (reset.data && reset.data.cancelled) throw new Error('会话重置被取消');
        this.messages = [];
        this.push({ type: 'retry', phase: 'reset' });
        await this.rpc.send({ type: 'prompt', message: this.lastPrompt }, 30000);
      } catch (err) {
        if (this.canAutoRetry()) {
          this.scheduleAutoRetry(err.message);
          return;
        }
        this.push({
          type: 'retry',
          phase: 'end',
          success: false,
          attempt: this.retryCount,
          finalError: shortText(err.message, 300)
        });
        this.retryCount = 0;
        this.push({ type: 'settled', aborted: false });
      }
    }, delay);
  }

  async scanArtifacts() {
    // cwd 是用户主目录时范围过大，扫出来的都是无关文件；这种情况只认工具事件产生的产物
    if (this.meta.cwd === HOME) return;
    const since = this.turnStartedAt || this.startedAt;
    const limit = Date.now();
    const walk = async (dir, depth) => {
      if (depth > 3 || Date.now() - limit > 4000) return;
      let entries;
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (Date.now() - limit > 4000) return;
        if (entry.name.startsWith('.') || ARTIFACT_SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const stat = await fsp.stat(full);
          if (stat.mtimeMs >= since - 1000 && stat.size > 0) this.addArtifact(full, 'scan');
        } catch { /* 文件在扫描中被删 */ }
      }
    };
    await walk(this.meta.cwd, 0);
  }
}

function summarizeToolArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const candidates = ['command', 'path', 'file_path', 'filePath', 'pattern', 'query', 'url'];
  for (const key of candidates) {
    if (typeof args[key] === 'string' && args[key]) return shortText(args[key], 160);
  }
  const keys = Object.keys(args);
  return keys.length ? shortText(JSON.stringify(args), 160) : '';
}

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Windows 上列出所有存在的盘符，让文件夹选择器能跨出 C 盘
function listDrives() {
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (let code = 67; code <= 90; code += 1) {
    const letter = String.fromCharCode(code) + ':';
    try {
      if (fs.existsSync(letter + '\\')) drives.push({ name: letter, path: letter + '\\' });
    } catch { /* 无访问权限的盘跳过 */ }
  }
  return drives;
}

// ---------------------------------------------------------------- 配置扫描

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return {};
  const end = text.indexOf('\n---', 3);
  if (end === -1) return {};
  const out = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

/*
 * 技能发现路径（与 Pi 自己的扫描范围保持一致）：
 *   ~/.pi/agent/skills        Pi 用户级
 *   ~/.agents/skills          Agent Skills 规范用户级（市场安装的 skill 多在这里，可能带 @user_xxx 命名空间子目录）
 *   ~/.pi/skills              旧版位置
 *   <space>/.pi/skills        项目级
 *   <space>/.agents/skills    项目级
 * 目录含 SKILL.md 即为技能，且需要递归往下找。
 */
const SKILL_ROOTS = [
  path.join(PI_AGENT, 'skills'),
  path.join(HOME, '.agents', 'skills'),
  path.join(HOME, '.pi', 'skills')
];

function scanSkills() {
  const found = [];
  const seenFiles = new Set();
  const seenNames = new Set();

  const add = (skillFile, scope) => {
    if (seenFiles.has(skillFile)) return;
    seenFiles.add(skillFile);

    let meta = {};
    try { meta = parseFrontmatter(fs.readFileSync(skillFile, 'utf8')); } catch { /* 读取失败则只报路径 */ }

    const dir = path.dirname(skillFile);
    const name = meta.name || path.basename(dir) || '未命名技能';
    if (seenNames.has(name)) return;
    seenNames.add(name);

    found.push({
      id: skillFile,
      name,
      description: meta.description || '',
      path: skillFile,
      dir,
      scope
    });
  };

  const walk = (dir, depth, scope) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const candidate = path.join(full, 'SKILL.md');
        if (fs.existsSync(candidate)) add(candidate, scope);
        else walk(full, depth + 1, scope);
      } else if (entry.name.toLowerCase() === 'skill.md') {
        add(full, scope);
      }
    }
  };

  for (const root of SKILL_ROOTS) walk(root, 0, 'user');
  for (const space of readApp().spaces || []) {
    if (!space || !space.path) continue;
    walk(path.join(space.path, '.pi', 'skills'), 0, 'project');
    walk(path.join(space.path, '.agents', 'skills'), 0, 'project');
  }

  return found.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
}

function scanMcp() {
  const servers = [];
  const seen = new Set();

  const addFrom = file => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const map = parsed.mcpServers || parsed.servers || {};
      for (const [name, cfg] of Object.entries(map)) {
        if (seen.has(name)) continue;
        seen.add(name);
        servers.push({
          name,
          command: cfg.command || cfg.url || '',
          args: Array.isArray(cfg.args) ? cfg.args : [],
          source: file
        });
      }
    } catch { /* 文件不存在或格式不对 */ }
  };

  // 全局配置
  addFrom(PI_MCP);
  addFrom(path.join(HOME, '.pi', 'mcp.json'));
  // 项目级配置：Pi 会读当前工作目录下的 .pi/mcp.json
  for (const space of readApp().spaces || []) {
    if (space && space.path) addFrom(path.join(space.path, '.pi', 'mcp.json'));
  }

  return servers;
}

function scanModels() {
  const out = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(PI_MODELS, 'utf8'));
    for (const [providerKey, provider] of Object.entries(parsed.providers || {})) {
      for (const model of provider.models || []) {
        out.push({
          provider: providerKey,
          providerName: provider.name || providerKey,
          id: model.id,
          name: model.name || model.id,
          input: model.input || ['text'],
          contextWindow: model.contextWindow || 0,
          reasoning: !!model.reasoning
        });
      }
    }
  } catch { /* models.json 不存在 */ }
  return out;
}

// OpenAI 兼容接口的实际请求地址：Pi 会按 baseUrl 拼 /chat/completions
function chatEndpoint(baseUrl, customProtocol) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  if (customProtocol) return trimmed;
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  return trimmed + '/chat/completions';
}

async function testModelConnection(input) {
  const url = chatEndpoint(input.baseUrl, input.customProtocol);
  if (!url) throw new Error('接口地址为空');
  if (!input.modelId) throw new Error('缺少模型 ID');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        input.apiKey ? { Authorization: 'Bearer ' + input.apiKey } : {}
      ),
      body: JSON.stringify({
        model: input.modelId,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        stream: false
      }),
      signal: controller.signal
    });

    const text = await response.text();
    let detail = '';
    try {
      const parsed = JSON.parse(text);
      detail = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || '';
      if (typeof detail !== 'string') detail = JSON.stringify(detail);
    } catch {
      detail = text.slice(0, 200);
    }

    return { ok: response.ok, status: response.status, detail: String(detail).slice(0, 300) };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('连接超时（20 秒）');
    throw new Error('连接失败: ' + err.message);
  } finally {
    clearTimeout(timer);
  }
}

async function addModel(input) {
  const providerKey = String(input.providerKey || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const modelId = String(input.modelId || '').trim();
  const baseUrl = String(input.baseUrl || '').trim();

  if (!providerKey) throw new Error('缺少提供商');
  if (!modelId) throw new Error('缺少模型 ID');
  if (!baseUrl) throw new Error('缺少接口地址');

  let models = {};
  try { models = JSON.parse(fs.readFileSync(PI_MODELS, 'utf8')); } catch { models = {}; }
  models.$schema = models.$schema || 'https://pi.dev/schemas/models.schema.json';
  models.providers = models.providers || {};

  const customProtocol = !!input.customProtocol;
  const normalizedBase = customProtocol
    ? baseUrl.replace(/\/+$/, '')
    : baseUrl.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');

  const provider = models.providers[providerKey] || {};
  provider.name = String(input.providerName || provider.name || providerKey);
  provider.baseUrl = normalizedBase;
  provider.api = String(input.api || provider.api || 'openai-completions');
  if (input.apiKey) provider.apiKey = String(input.apiKey);
  provider.models = provider.models || [];

  const model = {
    id: modelId,
    name: String(input.modelName || modelId),
    reasoning: !!input.supportsReasoning,
    input: input.supportsImages ? ['text', 'image'] : ['text'],
    contextWindow: Number(input.contextWindow) || 128000,
    maxTokens: Number(input.maxTokens) || 16384,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };

  if (input.supportsReasoning) {
    if (input.thinkingOnly) {
      // 只允许高档位：低档位标记为不支持
      model.thinkingLevelMap = { off: null, minimal: null, low: null, medium: null };
    } else if (input.allowThinkingOff === false) {
      model.thinkingLevelMap = { off: null };
    }
  }

  const index = provider.models.findIndex(m => m && m.id === modelId);
  if (index >= 0) provider.models[index] = model;
  else provider.models.push(model);

  models.providers[providerKey] = provider;

  const backup = PI_MODELS + '.pibuddy.bak';
  if (fs.existsSync(PI_MODELS) && !fs.existsSync(backup)) {
    try { await fsp.copyFile(PI_MODELS, backup); } catch { /* 备份失败不阻塞写入 */ }
  }

  await fsp.mkdir(PI_AGENT, { recursive: true });
  await fsp.writeFile(PI_MODELS, JSON.stringify(models, null, 2), 'utf8');

  // 同步写 auth.json，保持 Pi 自己的登录态一致
  if (input.apiKey) {
    const authFile = path.join(PI_AGENT, 'auth.json');
    try {
      let auth = {};
      try { auth = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { auth = {}; }
      auth[providerKey] = { type: 'api_key', key: String(input.apiKey) };
      await fsp.writeFile(authFile, JSON.stringify(auth, null, 2), 'utf8');
    } catch { /* auth.json 写失败不影响 models.json 生效 */ }
  }

  return { providerKey, modelId, baseUrl: normalizedBase, api: provider.api };
}

function readSessionHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n')[0];
    return JSON.parse(first);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关闭 */ } }
  }
}

// 从会话文件里取它用过的模型，用于「上次使用的模型」兜底
function readSessionModel(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    const text = buf.subarray(0, n).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'model_change' && record.modelId) {
        return { provider: record.provider || '', id: record.modelId };
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关闭 */ } }
  }
  return null;
}

function readLastUsedModel() {
  const app = readApp();
  if (app.lastModel && app.lastModel.id) return app.lastModel;
  for (const item of listSessions(3)) {
    const model = readSessionModel(item.path);
    if (model) return model;
  }
  return null;
}

function readSessionTitle(file) {
  let fd;
  let infoName = '';
  try {
    fd = fs.openSync(file, 'r');
    const size = 262144;
    const buf = Buffer.alloc(size);
    const n = fs.readSync(fd, buf, 0, size, 0);
    const text = buf.subarray(0, n).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.type === 'session_info' && record.name) { infoName = record.name; continue; }
      if (record.type !== 'message' || !record.message) continue;
      if (record.message.role !== 'user') continue;
      const content = record.message.content;
      const flat = typeof content === 'string'
        ? content
        : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '';
      // 优先用真实提问当标题；会话名（我们自己起的「新任务」）只作兜底
      const title = shortText(stripMdNotice(flat), 60);
      if (title) return title;
    }
  } catch {
    return infoName;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关闭 */ } }
  }
  return infoName;
}

function listSessions(limit) {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PI_SESSIONS, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }

  for (const dir of dirs) {
    const dirPath = path.join(PI_SESSIONS, dir.name);
    let files = [];
    try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { continue; }
    for (const file of files) {
      const full = path.join(dirPath, file);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      const header = readSessionHeader(full);
      out.push({
        path: full,
        id: (header && header.id) || file,
        cwd: (header && header.cwd) || '',
        createdAt: (header && header.timestamp) || stat.birthtime.toISOString(),
        mtime: stat.mtimeMs,
        size: stat.size,
        title: readSessionTitle(full)
      });
    }
  }

  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit || 120);
}

// ---------------------------------------------------------------- 会话生命周期

async function createSession(options) {
  const id = crypto.randomBytes(8).toString('hex');
  const cwd = options.cwd && fs.existsSync(options.cwd) ? options.cwd : HOME;
  const args = buildSessionArgs(options);
  const rpc = new RpcClient({ cwd, args });
  const session = new Session(id, rpc, {
    cwd,
    name: options.name || '',
    mode: options.mode || 'agent',
    model: options.model || '',
    provider: options.provider || '',
    markdown: options.markdown !== false,
    mdNoticeSent: false,
    systemPrompt: options.systemPrompt || '',
    preset: options.preset || '',
    skillPath: options.skillPath || '',
    mcpMode: options.mcpMode || 'all',
    fullAccess: !!options.fullAccess,
    sessionPath: options.sessionPath || ''
  });

  rpc.start();
  session.bind();
  sessions.set(id, session);

  try {
    const state = await rpc.send({ type: 'get_state' }, 25000);
    session.piState = state.data || null;
    if (state.data) {
      session.meta.sessionPath = state.data.sessionFile || session.meta.sessionPath;
      session.meta.piSessionId = state.data.sessionId || '';
      session.meta.name = state.data.sessionName || session.meta.name;
      if (state.data.model) {
        session.meta.model = state.data.model.id;
        rememberModel(state.data.model);
      }
    }
    const history = await rpc.send({ type: 'get_messages' }, 20000);
    session.messages = (history.data && history.data.messages) || [];
  } catch (err) {
    sessions.delete(id);
    await rpc.stop();
    throw new Error('启动 Pi 会话失败: ' + err.message);
  }

  return session;
}

async function openSession(sessionPath, extra) {
  const [existing] = [...sessions.values()].filter(s => s.meta.sessionPath === sessionPath);
  if (existing) return existing;
  return createSession(Object.assign({ sessionPath, name: '' }, extra || {}));
}

function dropSession(session) {
  sessions.delete(session.id);
  if (session.retryTimer) clearTimeout(session.retryTimer);
  for (const client of session.clients) {
    try { client.res.end(); } catch { /* 已断开 */ }
  }
  session.rpc.stop().catch(() => {});
}

function serializeSession(session) {
  return {
    id: session.id,
    cwd: session.meta.cwd,
    name: session.meta.name,
    mode: session.meta.mode,
    model: session.meta.model,
    provider: session.meta.provider,
    markdown: session.meta.markdown,
    fullAccess: session.meta.fullAccess,
    skillPath: session.meta.skillPath,
    mcpMode: session.meta.mcpMode,
    sessionPath: session.meta.sessionPath,
    busy: session.busy,
    messageCount: session.messages.length
  };
}

// ---------------------------------------------------------------- SSE

function attachSse(session, req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');

  const client = { res };
  session.clients.add(client);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* 已断开 */ }
  }, 15000);

  const cleanup = () => {
    clearInterval(ping);
    session.clients.delete(client);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function escapeXml(text) {
  return String(text == null ? '' : text).replace(/[<>&'"]/g, ch => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[ch]
  ));
}

/*
 * Windows 系统通知：走 WinRT 的 ToastNotificationManager。
 * 用 Windows PowerShell 自己的 AppId，避免要求用户先建开始菜单快捷方式。
 */
function sendSystemToast(title, body) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, error: '系统通知目前只在 Windows 上可用' });
      return;
    }

    const template = '<toast><visual><binding template="ToastGeneric"><text>' +
      escapeXml(title) + '</text><text>' + escapeXml(body) + '</text></binding></visual></toast>';

    const script = [
      "$ErrorActionPreference = 'Stop'",
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
      "$xml.LoadXml('" + template.replace(/'/g, "''") + "')",
      '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
      "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)'
    ].join('\n');

    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };

    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      });
    } catch (err) {
      done({ ok: false, error: err.message });
      return;
    }

    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', err => done({ ok: false, error: err.message }));
    child.on('close', code => done(code === 0 ? { ok: true } : { ok: false, error: stderr.slice(0, 300) || ('退出码 ' + code) }));
    setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      done({ ok: false, error: '通知超时' });
    }, 10000);
  });
}

// ---------------------------------------------------------------- 打开外部

function openExternal(target) {
  return new Promise(resolve => {
    let cmd;
    let args;

    if (process.platform === 'win32') {
      const escaped = String(target).replace(/'/g, "''");
      const script = "$ProgressPreference = 'SilentlyContinue'; Start-Process '" + escaped + "'";
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [String(target)];
    } else {
      cmd = 'xdg-open';
      args = [String(target)];
    }

    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };

    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    } catch {
      done(false);
      return;
    }
    child.on('error', () => done(false));
    child.on('close', code => done(code === 0));
    setTimeout(() => done(true), 6000);
  });
}

// ---------------------------------------------------------------- 定时任务

let cronTimer = null;

function cronDue(task, now) {
  const spec = task.schedule || {};
  if (spec.kind === 'interval') {
    const minutes = Math.max(1, Number(spec.minutes) || 30);
    return now.getTime() - (task.lastRun || 0) >= minutes * 60000;
  }
  const parts = String(spec.time || '09:00').split(':');
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (now.getHours() !== hour || now.getMinutes() !== minute) return false;
  if (spec.kind === 'weekly') {
    const days = Array.isArray(spec.days) ? spec.days.map(Number) : [];
    if (!days.includes(now.getDay())) return false;
  }
  return true;
}

async function runCronTask(task) {
  const app = readApp();
  const cwd = task.cwd && fs.existsSync(task.cwd) ? task.cwd : HOME;
  const base = piCommand();
  const args = [...base.pre, '-p', '--mode', 'json'];
  if (task.model) args.push('--model', task.model);
  if (task.fullAccess) args.push('--approve');

  const env = Object.assign({}, process.env, { NO_COLOR: '1', FORCE_COLOR: '0' });
  const spawnOptions = { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  if (base.shell) spawnOptions.shell = true;

  return new Promise(resolve => {
    let output = '';
    let finished = false;
    const finish = (status, text) => {
      if (finished) return;
      finished = true;
      task.lastRun = Date.now();
      task.lastStatus = status;
      task.lastOutput = shortText(text || '', 600);
      writeApp(app);
      resolve();
    };

    let child;
    try {
      child = spawn(base.cmd, [...args, task.prompt || ''], spawnOptions);
    } catch (err) {
      finish('error', err.message);
      return;
    }

    child.stdout.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-20000); });
    child.stderr.on('data', chunk => { output = (output + chunk.toString('utf8')).slice(-20000); });
    child.on('error', err => finish('error', err.message));
    child.on('close', code => {
      let summary = '';
      for (const line of output.split('\n')) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.type === 'message_end' && record.message && record.message.role === 'assistant') {
            const content = record.message.content;
            summary = typeof content === 'string'
              ? content
              : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text).join('\n') : '';
          }
        } catch { /* 非协议行 */ }
      }
      finish(code === 0 ? 'ok' : 'error', summary || output);
    });

    setTimeout(() => {
      if (!finished) {
        try { child.kill(); } catch { /* 已退出 */ }
        finish('timeout', output);
      }
    }, 10 * 60 * 1000);
  });
}

function startCronLoop() {
  if (cronTimer) clearInterval(cronTimer);
  cronTimer = setInterval(async () => {
    const now = new Date();
    const app = readApp();
    let dirty = false;
    for (const task of app.cron) {
      if (!task || task.enabled === false) continue;
      if (!cronDue(task, now)) continue;
      if (task.running) continue;
      task.running = true;
      dirty = true;
      runCronTask(task)
        .catch(err => { task.lastStatus = 'error'; task.lastOutput = err.message; })
        .finally(() => { task.running = false; writeApp(readApp()); });
    }
    if (dirty) writeApp(app);
  }, 30000);
}

// ---------------------------------------------------------------- 路由

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
};

async function handleRequest(req, res) {
  const parsed = new URL(req.url, URL_BASE);
  const pathname = decodeURIComponent(parsed.pathname);

  // 静态资源
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    try {
      const html = await fsp.readFile(INDEX_HTML);
      res.writeHead(200, {
        'Content-Type': MIME['.html'],
        'Cache-Control': 'no-store',
        'Content-Length': html.length
      });
      res.end(html);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('index.html 缺失');
    }
    return;
  }

  // Service Worker：浏览器通知走 showNotification 比直接 new Notification 可靠
  if (pathname === '/sw.js') {
    const sw = [
      "self.addEventListener('install', () => self.skipWaiting());",
      "self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));",
      "self.addEventListener('notificationclick', event => {",
      '  event.notification.close();',
      '  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {',
      '    for (const client of list) { if ("focus" in client) return client.focus(); }',
      '    if (self.clients.openWindow) return self.clients.openWindow("/");',
      '  }));',
      '});'
    ].join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache'
    });
    res.end(sw);
    return;
  }

  if (pathname === '/api/ping') {
    json(res, 200, { ok: true, version: APP_VERSION, pi: PI_VERSION, piEntry: PI_ENTRY });
    return;
  }

  // 前台存活探针（双信号）：SSE 连接 + 定时心跳，任一还在就认为页面开着
  if (pathname === '/api/alive' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    });
    res.write(': alive\n\n');

    ALIVE_CLIENTS.add(res);
    ALIVE_SEEN = true;
    LAST_BEAT = Date.now();
    if (ALIVE_TIMER) { clearTimeout(ALIVE_TIMER); ALIVE_TIMER = null; }

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* 连接已断 */ }
    }, 15000);

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      ALIVE_CLIENTS.delete(res);
      scheduleAutoQuit(8000);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    return;
  }

  // 心跳：后台标签页会把定时器降频，所以 SSE 连接才是主信号，心跳用于兜住连接抖动
  if (pathname === '/api/alive/beat' && req.method === 'POST') {
    LAST_BEAT = Date.now();
    ALIVE_SEEN = true;
    if (ALIVE_TIMER) { clearTimeout(ALIVE_TIMER); ALIVE_TIMER = null; }
    json(res, 200, { ok: true });
    return;
  }

  // 页面主动告别：关标签页时 sendBeacon 发来，缩短等待
  if (pathname === '/api/alive/bye' && req.method === 'POST') {
    LAST_BEAT = 0;
    scheduleAutoQuit(2000);
    json(res, 200, { ok: true });
    return;
  }


  // 重新检测 Pi（安装完不用重启服务）
  if (pathname === '/api/pi' && req.method === 'GET') {
    PI_ENTRY = null;
    PI_VERSION = '';
    locatePi();
    json(res, 200, { ok: true, piEntry: PI_ENTRY, piVersion: PI_VERSION, node: process.version, platform: process.platform });
    return;
  }

  // 退出服务：无窗口启动时唯一干净的停止方式
  if (pathname === '/api/quit' && req.method === 'POST') {
    json(res, 200, { ok: true });
    clearPortFile();
    setTimeout(() => { try { process.exit(0); } catch { /* 已退出 */ } }, 120);
    return;
  }

  if (pathname === '/api/bootstrap' && req.method === 'GET') {
    const app = readApp();
    json(res, 200, {
      ok: true,
      app,
      version: { app: APP_VERSION, pi: PI_VERSION },
      presets: PRESETS,
      skills: scanSkills(),
      mcp: scanMcp(),
      models: scanModels(),
      providers: BUILTIN_PROVIDERS,
      lastModel: readLastUsedModel(),
      retry: readRetrySettings(),
      sessions: listSessions(60),
      home: HOME,
      piEntry: PI_ENTRY,
      sidebarKeys: SIDEBAR_KEYS
    });
    return;
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    const patch = await readBody(req);
    const app = deepMerge(readApp(), patch || {});
    await writeApp(app);
    json(res, 200, { ok: true, app });
    return;
  }

  if (pathname === '/api/retry' && req.method === 'GET') {
    json(res, 200, { ok: true, retry: readRetrySettings() });
    return;
  }

  if (pathname === '/api/retry' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const retry = await writeRetrySettings(body || {});
      json(res, 200, { ok: true, retry });
    } catch (err) {
      fail(res, 500, '写入 settings.json 失败: ' + err.message);
    }
    return;
  }

  if (pathname === '/api/sessions' && req.method === 'GET') {
    json(res, 200, { ok: true, sessions: listSessions(120) });
    return;
  }

  // 删除会话：只允许删会话目录下的 .jsonl，删之前先把它对应的进程关掉
  if (pathname === '/api/sessions/delete' && req.method === 'POST') {
    const body = await readBody(req);
    const target = body && body.path ? path.resolve(String(body.path)) : '';
    if (!target || !isInside(path.resolve(PI_SESSIONS), target) || !target.endsWith('.jsonl')) {
      fail(res, 403, '只允许删除会话目录下的 .jsonl 文件');
      return;
    }
    for (const session of [...sessions.values()]) {
      if (session.meta.sessionPath === target) dropSession(session);
    }
    try {
      await fsp.unlink(target);
      json(res, 200, { ok: true, removed: true });
    } catch (err) {
      // 空会话可能还没落盘，删除按幂等处理
      if (err.code === 'ENOENT') {
        json(res, 200, { ok: true, removed: false });
        return;
      }
      fail(res, 500, '删除失败: ' + err.message);
    }
    return;
  }

  if (pathname === '/api/sessions/pin' && req.method === 'POST') {
    const body = await readBody(req);
    const target = body && body.path ? path.resolve(String(body.path)) : '';
    if (!target) { fail(res, 400, '缺少 path'); return; }
    const app = readApp();
    const pinned = new Set(app.pinned || []);
    if (body.pinned === false) pinned.delete(target);
    else pinned.add(target);
    app.pinned = Array.from(pinned);
    await writeApp(app);
    json(res, 200, { ok: true, pinned: app.pinned });
    return;
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    json(res, 200, { ok: true, models: scanModels() });
    return;
  }

  if (pathname === '/api/providers' && req.method === 'GET') {
    json(res, 200, { ok: true, providers: BUILTIN_PROVIDERS });
    return;
  }

  if (pathname === '/api/models/test' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await testModelConnection(body || {});
      json(res, 200, Object.assign({ ok: true }, result));
    } catch (err) {
      json(res, 200, { ok: false, error: err.message });
    }
    return;
  }

  if (pathname === '/api/models/add' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const result = await addModel(body || {});
      json(res, 200, Object.assign({ ok: true, models: scanModels() }, result));
    } catch (err) {
      fail(res, 400, err.message);
    }
    return;
  }

  if (pathname === '/api/skills' && req.method === 'GET') {
    json(res, 200, { ok: true, skills: scanSkills() });
    return;
  }

  if (pathname === '/api/mcp' && req.method === 'GET') {
    json(res, 200, { ok: true, mcp: scanMcp() });
    return;
  }

  // 新建会话
  if (pathname === '/api/session' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body) { fail(res, 400, '缺少请求体'); return; }
    try {
      const session = await createSession(body);
      json(res, 200, { ok: true, session: serializeSession(session) });
    } catch (err) {
      fail(res, 500, err.message);
    }
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/session\/([0-9a-f]+)(\/[a-z]+)?$/);
  if (sessionMatch) {
    const session = sessions.get(sessionMatch[1]);
    const action = sessionMatch[2] || '';
    if (!session) { fail(res, 404, '会话不存在或已回收'); return; }

    if (action === '/events' && req.method === 'GET') {
      attachSse(session, req, res);
      return;
    }

    if (action === '/messages' && req.method === 'GET') {
      try {
        const history = await session.rpc.send({ type: 'get_messages' }, 15000);
        json(res, 200, { ok: true, messages: (history.data && history.data.messages) || [] });
      } catch (err) {
        json(res, 200, { ok: true, messages: session.messages, warning: err.message });
      }
      return;
    }

    if (action === '/prompt' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.message) { fail(res, 400, '缺少 message'); return; }
      try {
        const message = String(body.message);
        session.lastActive = Date.now();
        session.lastPrompt = message;
        session.retryCount = 0;
        const command = { type: 'prompt', message };
        if (Array.isArray(body.images) && body.images.length) command.images = body.images;
        if (session.busy) command.streamingBehavior = 'steer';
        const result = await session.rpc.send(command, 30000);
        json(res, 200, { ok: true, disposition: result.data && result.data.disposition });
      } catch (err) {
        fail(res, 500, err.message);
      }
      return;
    }

    if (action === '/abort' && req.method === 'POST') {
      try {
        await session.rpc.send({ type: 'abort' }, 120000);
        json(res, 200, { ok: true });
      } catch (err) {
        fail(res, 500, err.message);
      }
      return;
    }

    if (action === '/model' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.modelId) { fail(res, 400, '缺少 modelId'); return; }
      try {
        const result = await session.rpc.send({
          type: 'set_model',
          provider: body.provider || session.meta.provider,
          modelId: body.modelId
        }, 20000);
        session.meta.model = body.modelId;
        session.meta.provider = body.provider || session.meta.provider;
        if (result.data && result.data.id) rememberModel(result.data);
        else rememberModel({ id: body.modelId, provider: body.provider });
        json(res, 200, { ok: true, model: result.data });
      } catch (err) {
        fail(res, 500, err.message);
      }
      return;
    }

    if (action === '/name' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        await session.rpc.send({ type: 'set_session_name', name: String((body && body.name) || '') }, 15000);
        session.meta.name = (body && body.name) || '';
        json(res, 200, { ok: true });
      } catch (err) {
        fail(res, 500, err.message);
      }
      return;
    }

    if (action === '/state' && req.method === 'GET') {
      try {
        const state = await session.rpc.send({ type: 'get_state' }, 15000);
        json(res, 200, { ok: true, state: state.data, meta: serializeSession(session) });
      } catch (err) {
        fail(res, 500, err.message);
      }
      return;
    }

    if (req.method === 'DELETE' || action === '/close') {
      dropSession(session);
      json(res, 200, { ok: true });
      return;
    }
  }

  // 打开已有会话文件
  if (pathname === '/api/session/open' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.path) { fail(res, 400, '缺少 path'); return; }
    if (!fs.existsSync(body.path)) { fail(res, 404, '会话文件不存在'); return; }
    try {
      const session = await openSession(body.path, body.options || {});
      json(res, 200, { ok: true, session: serializeSession(session) });
    } catch (err) {
      fail(res, 500, err.message);
    }
    return;
  }

  // 上传附件（原始字节流，文件名走 header）
  if (pathname === '/api/upload' && req.method === 'POST') {
    const sessionId = parsed.searchParams.get('sessionId') || '';
    const session = sessions.get(sessionId);
    if (!session) { fail(res, 404, '会话不存在'); return; }

    const rawName = req.headers['x-filename'] || 'file';
    let filename;
    try { filename = decodeURIComponent(String(rawName)); } catch { filename = String(rawName); }
    filename = path.basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'file';

    const limit = 50 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > limit) { fail(res, 413, '文件超过 50 MB'); return; }
        chunks.push(chunk);
      }
    } catch {
      fail(res, 400, '读取上传内容失败');
      return;
    }

    const dir = path.join(session.meta.cwd, '.pibuddy', 'uploads');
    try {
      await fsp.mkdir(dir, { recursive: true });
      const stamp = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex') + '-';
      const target = path.join(dir, stamp + filename);
      await fsp.writeFile(target, Buffer.concat(chunks));
      json(res, 200, { ok: true, path: target, name: filename, size: total });
    } catch (err) {
      fail(res, 500, err.message);
    }
    return;
  }

// 识别上传图片是否为动图；GIF 顺带算出「一轮」的时长，点击播放要用
function inspectAnimation(buf, ext) {
  const out = { animated: false, frames: 0, durationMs: 0 };
  try {
    if (ext === '.gif' && buf.slice(0, 3).toString('ascii') === 'GIF') {
      let p = 13;
      const screen = buf[10];
      if (screen & 0x80) p += 3 * (1 << ((screen & 7) + 1));   // 全局调色板
      let delay = 0, frames = 0, pending = 0;
      while (p < buf.length - 1) {
        const tag = buf[p];
        if (tag === 0x21) {                                     // 扩展块
          if (buf[p + 1] === 0xf9 && buf[p + 2] === 4) {
            const d = buf.readUInt16LE(p + 4);                  // 1/100 秒
            pending = d > 0 ? d * 10 : 100;
          }
          p += 2;
          while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
          p++;
        } else if (tag === 0x2c) {                              // 图像描述符
          frames++;
          delay += pending || 100;
          pending = 0;
          const lp = buf[p + 9];
          p += 10;
          if (lp & 0x80) p += 3 * (1 << ((lp & 7) + 1));       // 局部调色板
          p++;                                                  // LZW 最小码长
          while (p < buf.length && buf[p] !== 0) p += buf[p] + 1;
          p++;
        } else if (tag === 0x3b) break;
        else break;
      }
      out.frames = frames;
      out.animated = frames >= 2;
      out.durationMs = Math.min(60000, Math.max(100, delay));
    } else if (ext === '.png') {
      out.animated = buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a' && buf.includes(Buffer.from('acTL'));
      out.durationMs = 4000;                                   // APNG 帧时长未解析，给个兜底
    } else if (ext === '.webp') {
      out.animated = buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.includes(Buffer.from('ANIM'));
      out.durationMs = 4000;
    } else if (ext === '.avif') {
      out.animated = buf.includes(Buffer.from('avis'));
      out.durationMs = 4000;
    }
  } catch { /* 解析不了就当静态图 */ }
  return out;
}


  // 首页标志：用户导入的图片或动图
  if (pathname === '/logo' && req.method === 'GET') {
    const logo = readApp().logo;
    if (!logo || !logo.file) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('no logo');
      return;
    }
    const file = path.join(DATA_DIR, path.basename(logo.file));
    try {
      const buf = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': logo.mime || MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': buf.length
      });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('logo missing');
    }
    return;
  }

  // 首页标志：上传（原始字节流，靠 x-filename 判断格式）
  if (pathname === '/api/logo' && req.method === 'POST') {
    const rawName = req.headers['x-filename'] || 'logo';
    let name;
    try { name = decodeURIComponent(String(rawName)); } catch { name = String(rawName); }
    const ext = path.extname(name).toLowerCase();
    const allowed = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp'];
    if (!allowed.includes(ext)) {
      fail(res, 415, '只支持 PNG / JPG / GIF / WebP / AVIF / BMP');
      return;
    }

    const limit = 10 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        total += chunk.length;
        if (total > limit) { fail(res, 413, '图片超过 10 MB'); return; }
        chunks.push(chunk);
      }
    } catch {
      fail(res, 400, '读取图片失败');
      return;
    }
    if (!total) { fail(res, 400, '图片内容为空'); return; }

    const app = readApp();
    const previous = app.logo && app.logo.file ? path.join(DATA_DIR, path.basename(app.logo.file)) : null;
    const file = 'logo-' + Date.now().toString(36) + ext;
    const bytes = Buffer.concat(chunks);
    const anim = inspectAnimation(bytes, ext);
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(path.join(DATA_DIR, file), bytes);
      app.logo = {
        file, name, mime: MIME[ext] || 'application/octet-stream', size: total, mtime: Date.now(),
        animated: anim.animated, frames: anim.frames, durationMs: anim.durationMs,
        playMode: (app.logo && app.logo.playMode) || 'loop'
      };
      await writeApp(app);
      if (previous && path.basename(previous) !== file) {
        try { await fsp.unlink(previous); } catch { /* 旧文件已不在 */ }
      }
      json(res, 200, { ok: true, logo: app.logo });
    } catch (err) {
      fail(res, 500, '保存图片失败: ' + err.message);
    }
    return;
  }

  // 首页标志：移除
  if (pathname === '/api/logo' && req.method === 'DELETE') {
    const app = readApp();
    const previous = app.logo && app.logo.file ? path.join(DATA_DIR, path.basename(app.logo.file)) : null;
    app.logo = null;
    await writeApp(app);
    if (previous) { try { await fsp.unlink(previous); } catch { /* 已不存在 */ } }
    json(res, 200, { ok: true });
    return;
  }

  // 打开本地文件（产物卡牌）
  if (pathname === '/api/open' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body || !body.path) { fail(res, 400, '缺少 path'); return; }
    const target = path.resolve(String(body.path));
    const allowed = allowedRoots();
    const permitted = allowed.some(root => isInside(root, target));
    if (!permitted) { fail(res, 403, '路径不在已挂载目录内'); return; }
    if (!fs.existsSync(target)) { fail(res, 404, '文件不存在'); return; }
    const ok = await openExternal(target);
    json(res, 200, { ok, path: target });
    return;
  }

  // 任务完成提醒（Windows 系统通知）
  if (pathname === '/api/notify' && req.method === 'POST') {
    const body = await readBody(req);
    const title = (body && body.title) || 'Pi-buddy';
    const text = (body && body.body) || '任务已完成';
    const result = await sendSystemToast(title, text);
    json(res, 200, result);
    return;
  }

  // 目录浏览（挂载文件夹用）
  if (pathname === '/api/browse' && req.method === 'GET') {
    const target = parsed.searchParams.get('path') || HOME;
    try {
      const entries = await fsp.readdir(target, { withFileTypes: true });
      json(res, 200, {
        ok: true,
        path: target,
        parent: path.dirname(target) === target ? null : path.dirname(target),
        drives: listDrives(),
        entries: entries
          .filter(e => e.isDirectory())
          .map(e => ({ name: e.name, path: path.join(target, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      });
    } catch (err) {
      fail(res, 500, err.message);
    }
    return;
  }

  // 定时任务
  if (pathname === '/api/cron' && req.method === 'GET') {
    const app = readApp();
    json(res, 200, { ok: true, tasks: app.cron });
    return;
  }

  if (pathname === '/api/cron' && req.method === 'POST') {
    const body = await readBody(req);
    const app = readApp();
    if (body && body.remove) {
      app.cron = app.cron.filter(t => t.id !== body.remove);
      await writeApp(app);
      json(res, 200, { ok: true, tasks: app.cron });
      return;
    }
    const task = {
      id: (body && body.id) || crypto.randomBytes(6).toString('hex'),
      name: (body && body.name) || '未命名任务',
      prompt: (body && body.prompt) || '',
      cwd: (body && body.cwd) || HOME,
      model: (body && body.model) || '',
      fullAccess: !!(body && body.fullAccess),
      enabled: body && body.enabled !== false,
      schedule: (body && body.schedule) || { kind: 'daily', time: '09:00' },
      createdAt: Date.now()
    };
    const index = app.cron.findIndex(t => t.id === task.id);
    if (index >= 0) app.cron[index] = Object.assign({}, app.cron[index], task);
    else app.cron.push(task);
    await writeApp(app);
    json(res, 200, { ok: true, tasks: app.cron });
    return;
  }

  if (pathname === '/api/cron/run' && req.method === 'POST') {
    const body = await readBody(req);
    const app = readApp();
    const task = app.cron.find(t => t.id === (body && body.id));
    if (!task) { fail(res, 404, '任务不存在'); return; }
    runCronTask(task).catch(err => console.error('[cron]', err.message));
    json(res, 200, { ok: true });
    return;
  }

  // 资料库
  if (pathname === '/api/library' && req.method === 'GET') {
    const app = readApp();
    const items = [];
    for (const space of app.spaces) {
      if (!space || !space.path) continue;
      const walk = (dir, depth) => {
        if (depth > 2 || items.length > 400) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (items.length > 400) return;
          if (entry.name.startsWith('.') || ARTIFACT_SKIP_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) { walk(full, depth + 1); continue; }
          try {
            const stat = fs.statSync(full);
            items.push({
              path: full,
              name: entry.name,
              size: stat.size,
              sizeText: humanSize(stat.size),
              mtime: stat.mtimeMs,
              kind: kindOf(full),
              space: space.name || space.path
            });
          } catch { /* 跳过无法读取的条目 */ }
        }
      };
      walk(space.path, 0);
    }
    items.sort((a, b) => b.mtime - a.mtime);
    json(res, 200, { ok: true, items, spaces: app.spaces });
    return;
  }

  fail(res, 404, '未找到接口: ' + pathname);
}

function allowedRoots() {
  const app = readApp();
  const roots = [HOME];
  for (const space of app.spaces) {
    if (space && space.path) roots.push(space.path);
  }
  for (const session of sessions.values()) {
    if (session.meta.cwd) roots.push(session.meta.cwd);
  }
  return roots;
}

// ---------------------------------------------------------------- 启动

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    console.error('[request]', err && err.stack ? err.stack : err);
    if (!res.headersSent) fail(res, 500, err.message || '内部错误');
    else { try { res.end(); } catch { /* 已结束 */ } }
  });
});

server.on('error', err => {
  if (err.code === 'EACCES' && activePort - BASE_PORT < 20) {
    activePort += 1;
    URL_BASE = 'http://' + HOST + ':' + activePort;
    console.log('端口 ' + (activePort - 1) + ' 被系统保留，改用 ' + activePort);
    server.listen(activePort, HOST, onListening);
    return;
  }
  if (err.code === 'EADDRINUSE') {
    console.log('已有 Pi-buddy 在运行，直接打开浏览器。');
    openExternal(URL_BASE).then(() => process.exit(0));
    return;
  }
  console.error('服务启动失败:', err.message);
  process.exit(1);
});

function clearPortFile() {
  try { fs.unlinkSync(path.join(DATA_DIR, 'port.txt')); } catch { /* 不存在就算了 */ }
}

// ---- 关掉网页就退出（只对「应用式」启动生效：PIBUDDY_QUIT_ON_CLOSE=1） ----
const ALIVE_CLIENTS = new Set();
let ALIVE_SEEN = false;
let LAST_BEAT = 0;
let ALIVE_TIMER = null;
const ALIVE_GRACE = 15000;

function autoQuitAllowed() {
  return process.env.PIBUDDY_QUIT_ON_CLOSE === '1'
    && ALIVE_SEEN
    && ALIVE_CLIENTS.size === 0
    && Date.now() - LAST_BEAT > ALIVE_GRACE;
}

function scheduleAutoQuit(delayMs) {
  if (process.env.PIBUDDY_QUIT_ON_CLOSE !== '1' || !ALIVE_SEEN) return;
  if (ALIVE_TIMER) clearTimeout(ALIVE_TIMER);
  ALIVE_TIMER = setTimeout(() => {
    ALIVE_TIMER = null;
    if (autoQuitAllowed()) shutdown('page-closed');
  }, delayMs || 8000);
}

// 兜底：连接全断、心跳也过期时，即使没收到 close 事件也会退出
setInterval(() => {
  if (autoQuitAllowed() && !ALIVE_TIMER) shutdown('page-closed');
}, 3000).unref();


function shutdown(signal) {
  console.log('收到 ' + signal + '，正在关闭…');
  clearPortFile();
  if (cronTimer) clearInterval(cronTimer);
  const pending = [...sessions.values()].map(s => s.rpc.stop());
  Promise.allSettled(pending).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

locatePi();
const recover = setInterval(() => {
  const now = Date.now();
  for (const session of [...sessions.values()]) {
    if (session.busy || session.clients.size > 0) continue;
    if (now - session.lastActive < 30 * 60 * 1000) continue;
    dropSession(session);
  }
}, 5 * 60 * 1000);
recover.unref();

async function onListening() {
  // 记下实际端口，无窗口启动时「停止」脚本靠它找服务
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(path.join(DATA_DIR, 'port.txt'), String(activePort), 'utf8');
  } catch { /* 端口文件写不了不影响运行 */ }

  console.log('Pi-buddy ' + APP_VERSION + '  ·  Pi ' + PI_VERSION);
  console.log('Pi 入口: ' + (PI_ENTRY || '未找到（将尝试 `pi` 命令）'));
  console.log('服务地址: ' + URL_BASE);
  if (process.env.PIBUDDY_NO_OPEN !== '1') {
    const opened = await openExternal(URL_BASE);
    if (!opened) console.log('自动打开浏览器失败，请手动访问上面的地址。');
  }
}

server.listen(activePort, HOST, onListening);

startCronLoop();
