// src/usage.ts
// Claude Code 本地 JSONL 用量解析

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';

// ── 类型定义 ────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface SessionSummary {
  sessionId: string;
  model: string;
  rounds: number;
  firstTimestamp: string;
  lastTimestamp: string;
  usage: TokenUsage;
}

export interface ProjectUsage {
  cwd: string;
  encodedPath: string;
  sessions: SessionSummary[];
  totalUsage: TokenUsage;
  totalRounds: number;
  parsedAt: number;
}

// ── 内部类型：JSONL 助理消息 ─────────────────────────────────────────────────────

interface JsonlAssistantMessage {
  type: 'assistant';
  sessionId: string;
  timestamp: string;
  message: {
    model: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function isAssistantLine(obj: unknown): obj is JsonlAssistantMessage {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return o['type'] === 'assistant' &&
    typeof o['sessionId'] === 'string' &&
    o['message'] !== null &&
    typeof o['message'] === 'object';
}

// ── 路径编码 ────────────────────────────────────────────────────────────────────

/** 将工作区路径编码为 Claude Code 的项目目录名 */
export function encodeWorkspacePath(cwd: string): string {
  return cwd.replace(/\//g, '-');
}

/** Claude Code 项目数据根目录 */
export function getClaudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

// ── 文件发现 ────────────────────────────────────────────────────────────────────

/** 列出项目下所有 .jsonl 文件，按修改时间降序 */
export function listJsonlFiles(encodedPath: string): string[] {
  const dir = path.join(getClaudeProjectsDir(), encodedPath);

  try {
    const entries = fs.readdirSync(dir);
    const jsonlFiles = entries.filter(f => f.endsWith('.jsonl'));

    // 按修改时间降序
    return jsonlFiles.sort((a, b) => {
      const statA = fs.statSync(path.join(dir, a));
      const statB = fs.statSync(path.join(dir, b));
      return statB.mtimeMs - statA.mtimeMs;
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

// ── 单文件解析 ──────────────────────────────────────────────────────────────────

/** 流式解析单个 JSONL 文件，汇总 token 用量 */
export async function parseSessionFile(
  filePath: string
): Promise<SessionSummary | null> {
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };

  let rounds = 0;
  let model = 'unknown';
  let firstTimestamp = '';
  let lastTimestamp = '';
  let sessionId = '';

  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      let obj: unknown;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // 跳过损坏行
      }

      if (!isAssistantLine(obj)) continue;

      const u = obj.message.usage;
      if (u) {
        usage.inputTokens += u.input_tokens ?? 0;
        usage.outputTokens += u.output_tokens ?? 0;
        usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
        usage.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      }

      rounds++;
      model = obj.message.model || model;
      sessionId = sessionId || obj.sessionId;

      if (!firstTimestamp) firstTimestamp = obj.timestamp;
      lastTimestamp = obj.timestamp;
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') return null;
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  if (rounds === 0) return null; // 无有效数据的文件

  return {
    sessionId,
    model,
    rounds,
    firstTimestamp,
    lastTimestamp,
    usage,
  };
}

// ── 文件监听 ────────────────────────────────────────────────────────────────────

export interface WatcherHandle {
  dispose(): void;
}

/**
 * 监听项目目录的文件变更，自动重新解析并回调。
 * 防抖 delayMs 毫秒内多次变更只触发一次。
 */
export function watchProject(
  cwd: string,
  callback: (data: ProjectUsage) => void,
  delayMs: number = 2000
): WatcherHandle {
  const encodedPath = encodeWorkspacePath(cwd);
  const dir = path.join(getClaudeProjectsDir(), encodedPath);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (disposed) return;
      try {
        const data = await getProjectUsage(cwd);
        if (!disposed) callback(data);
      } catch {
        // 解析失败静默跳过，下次变更再试
      }
    }, delayMs);
  };

  let watcher: fs.FSWatcher | null = null;

  try {
    watcher = fs.watch(dir, { persistent: true }, (_eventType, _filename) => {
      // 只关心 .jsonl 文件
      if (_filename && !_filename.endsWith('.jsonl')) return;
      schedule();
    });
    watcher.on('error', () => {
      // watcher 出错时不做处理，等下次 schedule 自愈
    });
  } catch {
    // 目录不存在等 — callback 不会触发，dispose 安全
  }

  return {
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}

// ── 项目级聚合 ──────────────────────────────────────────────────────────────────

/** 获取当前项目的全部 Token 用量统计 */
export async function getProjectUsage(cwd: string): Promise<ProjectUsage> {
  const encodedPath = encodeWorkspacePath(cwd);
  const files = listJsonlFiles(encodedPath);
  const dir = path.join(getClaudeProjectsDir(), encodedPath);

  const sessions: SessionSummary[] = [];
  const totalUsage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let totalRounds = 0;

  for (const filename of files) {
    const summary = await parseSessionFile(path.join(dir, filename));
    if (!summary) continue;

    sessions.push(summary);
    totalUsage.inputTokens += summary.usage.inputTokens;
    totalUsage.outputTokens += summary.usage.outputTokens;
    totalUsage.cacheReadTokens += summary.usage.cacheReadTokens;
    totalUsage.cacheCreationTokens += summary.usage.cacheCreationTokens;
    totalRounds += summary.rounds;
  }

  return {
    cwd,
    encodedPath,
    sessions,
    totalUsage,
    totalRounds,
    parsedAt: Date.now(),
  };
}
