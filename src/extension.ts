// src/extension.ts
// 插件主入口

import * as vscode from 'vscode';
import { fetchBalance, parsePrimaryBalance, DeepSeekApiError } from './api.js';
import { BalanceHistory, BalanceSnapshot } from './storage.js';
import { DeepSeekStatusBar } from './statusBar.js';
import { DashboardPanel, DashboardData } from './dashboard.js';
import { getProjectUsage, watchProject, WatcherHandle, encodeWorkspacePath, getClaudeProjectsDir } from './usage.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 全局状态 ──────────────────────────────────────────────────────────────────

let statusBar: DeepSeekStatusBar;
let history: BalanceHistory;
let timer: NodeJS.Timeout | undefined;
let watcherHandle: WatcherHandle | undefined;

// 最后一次成功获取到的数据（供 dashboard 使用）
let lastData: {
  total: number;
  currency: string;
  isAvailable: boolean;
} | null = null;

let lastRefresh: Date | null = null;

// ── 激活 ──────────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  statusBar = new DeepSeekStatusBar();
  history = new BalanceHistory(context);

  // 注册命令
  context.subscriptions.push(
    vscode.commands.registerCommand('deepseek-monitor.refresh', () => refresh(context)),
    vscode.commands.registerCommand('deepseek-monitor.setApiKey', () => cmdSetApiKey(context)),
    vscode.commands.registerCommand('deepseek-monitor.clearApiKey', () => cmdClearApiKey(context)),
    vscode.commands.registerCommand('deepseek-monitor.showDashboard', () => cmdShowDashboard(context)),
    vscode.commands.registerCommand('deepseek-monitor.showUsageHistory', () => cmdShowDashboard(context)),
    vscode.commands.registerCommand('deepseek-monitor.showTokenUsage', () => cmdShowDashboard(context)),
    vscode.commands.registerCommand('deepseek-monitor.generateMockData', () => cmdGenerateMockData(context)),
    vscode.commands.registerCommand('deepseek-monitor.clearTestData', () => cmdClearTestData(context)),
    statusBar,
  );

  // 监听配置变更（刷新间隔改变时重启定时器）
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('deepseekMonitor')) {
        restartTimer(context);
        refresh(context);
      }
    })
  );

  // 启动
  refresh(context);
  restartTimer(context);
}

export function deactivate(): void {
  if (timer) clearInterval(timer);
  if (watcherHandle) watcherHandle.dispose();
}

// ── 核心刷新逻辑 ──────────────────────────────────────────────────────────────

async function refresh(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await getApiKey(context);

  if (!apiKey) {
    statusBar.update({ kind: 'no-key' });
    return;
  }

  statusBar.update({ kind: 'loading' });

  try {
    const resp = await fetchBalance(apiKey);
    const parsed = parsePrimaryBalance(resp);

    if (!parsed) {
      statusBar.update({ kind: 'error', message: '响应数据为空' });
      return;
    }

    lastRefresh = new Date();
    lastData = { ...parsed, isAvailable: resp.is_available };

    // 存入历史
    const snapshot: BalanceSnapshot = {
      timestamp: Date.now(),
      total: parsed.total,
      currency: parsed.currency,
    };
    await history.push(snapshot);

    const lastConsumption = history.getLastConsumption();

    // 更新状态栏
    if (!resp.is_available) {
      statusBar.update({ kind: 'unavailable' });
    } else {
      statusBar.update({
        kind: 'ok',
        total: parsed.total,
        currency: parsed.currency,
        lastConsumption,
      });
    }

    // 如果仪表盘打开，推送余额更新
    pushBalanceToDashboard();

    // 低余额通知
    checkLowBalance(parsed.total, parsed.currency);

  } catch (err) {
    const msg = err instanceof DeepSeekApiError ? err.message : String(err);
    statusBar.update({ kind: 'error', message: msg });

    // 如果是认证错误，提示用户重新配置
    if (err instanceof DeepSeekApiError && err.statusCode === 401) {
      const choice = await vscode.window.showErrorMessage(
        `DeepSeek API Key 无效，请重新设置`,
        '重新设置',
        '忽略'
      );
      if (choice === '重新设置') {
        vscode.commands.executeCommand('deepseek-monitor.setApiKey');
      }
    }
  }
}

// ── Dashboard 余额推送 ────────────────────────────────────────────────────────

function pushBalanceToDashboard(): void {
  if (!DashboardPanel.isOpen || !lastData) return;

  const config = vscode.workspace.getConfiguration('deepseekMonitor');
  const intervalSec = config.get<number>('refreshInterval', 60);

  DashboardPanel.pushBalance({
    ...lastData,
    history: history.getRecent(50),
    lastRefresh,
    refreshInterval: intervalSec,
  });
}

// ── 定时器 ────────────────────────────────────────────────────────────────────

function restartTimer(context: vscode.ExtensionContext): void {
  if (timer) clearInterval(timer);

  const config = vscode.workspace.getConfiguration('deepseekMonitor');
  const intervalSec = Math.max(10, config.get<number>('refreshInterval', 60));

  timer = setInterval(() => refresh(context), intervalSec * 1000);
}

// ── 低余额检测 ────────────────────────────────────────────────────────────────

let lastLowBalanceWarnTime = 0;

function checkLowBalance(total: number, currency: string): void {
  const config = vscode.workspace.getConfiguration('deepseekMonitor');
  const threshold = config.get<number>('lowBalanceThreshold', 5);
  const sym = currency === 'CNY' ? '¥' : '$';

  if (total < threshold && total > 0) {
    // 每小时最多提醒一次
    const now = Date.now();
    if (now - lastLowBalanceWarnTime < 60 * 60 * 1000) return;
    lastLowBalanceWarnTime = now;

    vscode.window.showWarningMessage(
      `⚠️ DeepSeek 余额不足 ${sym}${threshold}，当前余额 ${sym}${total.toFixed(2)}`,
      '打开面板',
      '忽略'
    ).then(choice => {
      if (choice === '打开面板') {
        vscode.commands.executeCommand('deepseek-monitor.showDashboard');
      }
    });
  }

  if (total <= 0) {
    vscode.window.showErrorMessage(
      '❌ DeepSeek 余额已耗尽，请前往平台充值',
      '前往充值'
    ).then(choice => {
      if (choice === '前往充值') {
        vscode.env.openExternal(vscode.Uri.parse('https://platform.deepseek.com/top_up'));
      }
    });
  }
}

// ── API Key 管理 ──────────────────────────────────────────────────────────────

async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  // 优先从安全存储读取
  const secret = await context.secrets.get('deepseek-monitor.apiKey');
  if (secret) return secret;

  // 兼容旧版明文配置（仅读取，不建议使用）
  const config = vscode.workspace.getConfiguration('deepseekMonitor');
  const plainKey = config.get<string>('apiKey', '');
  if (plainKey) return plainKey;

  return undefined;
}

async function cmdSetApiKey(context: vscode.ExtensionContext): Promise<void> {
  const key = await vscode.window.showInputBox({
    title: 'DeepSeek API Key',
    prompt: '粘贴你的 API Key（以 sk- 开头），将加密存储在 VSCode Secrets',
    placeHolder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    ignoreFocusOut: true,
    password: true,
    validateInput: v => {
      if (!v) return '不能为空';
      if (!v.startsWith('sk-')) return 'API Key 应以 sk- 开头';
      return undefined;
    },
  });

  if (!key) return;

  await context.secrets.store('deepseek-monitor.apiKey', key);
  vscode.window.showInformationMessage('✅ API Key 已安全保存');
  refresh(context);
}

async function cmdClearApiKey(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    '确定要删除已保存的 DeepSeek API Key 吗？',
    { modal: true },
    '确定删除'
  );
  if (confirm !== '确定删除') return;

  await context.secrets.delete('deepseek-monitor.apiKey');
  vscode.window.showInformationMessage('🗑️ API Key 已清除');
  statusBar.update({ kind: 'no-key' });
}

// ── 仪表盘（合并余额 + Token 用量）─────────────────────────────────────────────

async function cmdShowDashboard(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration('deepseekMonitor');
  const intervalSec = config.get<number>('refreshInterval', 60);

  const panel = DashboardPanel.createOrShow(context.extensionUri);

  // 余额数据（即使 API 未返回，也使用本地历史）
  const localHistory = history.getRecent(50);
  const balance = lastData
    ? { ...lastData, history: localHistory, lastRefresh, refreshInterval: intervalSec }
    : {
        total: localHistory.length > 0 ? localHistory[localHistory.length - 1].total : 0,
        currency: 'CNY', isAvailable: false,
        history: localHistory, lastRefresh: null, refreshInterval: intervalSec,
      };

  // Token 用量（异步获取）
  let tokenUsage: DashboardData['tokenUsage'] = null;
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    try {
      const usage = await getProjectUsage(folders[0].uri.fsPath);
      if (usage.sessions.length > 0) {
        tokenUsage = usage;
        statusBar.updateTokens(usage.totalUsage.inputTokens + usage.totalUsage.outputTokens);
      }
    } catch {
      // 静默失败，token 区域显示无数据提示
    }
  }

  panel.update({ ...balance, tokenUsage });

  // 如果已有数据，推送一份到仪表盘（确保最新）
  if (balance.lastRefresh) {
    pushBalanceToDashboard();
  }

  // 启动文件监听（实时 Token 用量更新）
  startWatcher(folders);
}

// ── 文件监听 ──────────────────────────────────────────────────────────────────

function startWatcher(folders: readonly vscode.WorkspaceFolder[] | undefined): void {
  // 先停止旧的
  if (watcherHandle) watcherHandle.dispose();

  if (!folders || folders.length === 0) return;

  const cwd = folders[0].uri.fsPath;
  watcherHandle = watchProject(cwd, (data) => {
    DashboardPanel.pushTokenUsage(data);
    statusBar.updateTokens(data.totalUsage.inputTokens + data.totalUsage.outputTokens);
  }, 2000);
}

// ── 测试数据生成 ──────────────────────────────────────────────────────────────

async function cmdGenerateMockData(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    '将清除现有余额历史并生成 7 天模拟数据。继续？',
    { modal: true },
    '确定生成'
  );
  if (confirm !== '确定生成') return;

  await history.clear();

  const currency = lastData?.currency || 'CNY';
  const DAY_MS = 24 * 60 * 60 * 1000;

  // 以今天本地零点为基准，避免 UTC 偏移导致日期错位
  const todayMidnight = new Date();
  todayMidnight.setHours(0, 0, 0, 0);
  const baseMs = todayMidnight.getTime();

  // 每日消耗预算（元）
  const dayBudgets = [0.8, 2.1, 0.5, 1.3, 3.0, 1.7, 0.6];
  let balance = 10.0; // 起始余额 ¥10

  for (let d = 6; d >= 0; d--) {
    const dayStart = baseMs - d * DAY_MS;
    const budget = dayBudgets[6 - d];

    // 每天 10 次采样，分布在早 9 点到晚 9 点之间
    for (let s = 0; s < 10; s++) {
      // 采样时间：9:00 + s * (12小时/9次) + 随机偏移
      const hour = 9 + (s / 9) * 12;
      const minuteOffset = Math.round((Math.random() - 0.5) * 20);
      const sampleTime = new Date(dayStart);
      sampleTime.setHours(Math.floor(hour), (hour % 1) * 60 + minuteOffset, 0, 0);

      // 计算当前消耗量（随时间递增 + 随机噪声）
      const progress = s / 9; // 0 → 1
      const consumed = budget * progress + (Math.random() - 0.5) * 0.3 * budget;
      const currentBalance = balance - Math.max(0, consumed);

      await history.push({
        timestamp: sampleTime.getTime(),
        total: Math.max(0.01, currentBalance),
        currency,
      });
    }

    balance -= budget;
  }

  // 设置当前余额为模拟数据的最后一条
  const records = history.getAll();
  if (records.length > 0) {
    const last = records[records.length - 1];
    lastData = {
      total: last.total,
      currency: last.currency,
      isAvailable: true,
    };
    lastRefresh = new Date(last.timestamp);
    statusBar.update({
      kind: 'ok',
      total: last.total,
      currency: last.currency,
      lastConsumption: history.getLastConsumption(),
    });
  }

  // 生成 mock Token 数据（JSONL 文件），每天一个独立 session
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    try {
      const cwd = folders[0].uri.fsPath;
      const encoded = encodeWorkspacePath(cwd);
      const projDir = path.join(getClaudeProjectsDir(), encoded);

      // 删除旧的 mock 文件
      try {
        const existing = fs.readdirSync(projDir).filter(f => f.startsWith('mock-') && f.endsWith('.jsonl'));
        for (const f of existing) fs.unlinkSync(path.join(projDir, f));
      } catch { /* dir may not exist */ }

      // 每日 Token 消耗（万），对应余额消耗
      const dayTokensK = [240, 630, 150, 390, 900, 510, 180];
      // 不同日期使用不同模型，验证模型分布面板
      const dayModels = ['deepseek-v3', 'deepseek-v4-pro', 'deepseek-v3', 'deepseek-chat', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-v4-pro'];
      const totalLines: number[] = [];

      for (let d = 6; d >= 0; d--) {
        const dayStart = baseMs - d * DAY_MS;
        const dateLabel = new Date(new Date(dayStart).setHours(12, 0, 0, 0));
        const totalK = dayTokensK[6 - d];
        const rounds = 5 + Math.floor(Math.random() * 6);
        const perRoundK = totalK / rounds;
        const sessionId = `mock-${dateLabel.getMonth() + 1}-${dateLabel.getDate()}`;
        const model = dayModels[6 - d];
        const lines: string[] = [];

        for (let r = 0; r < rounds; r++) {
          const ts = new Date(dayStart);
          ts.setHours(9 + r, Math.floor(Math.random() * 50), 0, 0);
          const inputK = Math.round(perRoundK * (0.5 + Math.random() * 0.4));
          const outputK = Math.round(perRoundK * (0.05 + Math.random() * 0.15));
          const cacheReadK = Math.round(inputK * (1.5 + Math.random() * 8));

          lines.push(JSON.stringify({
            type: 'assistant',
            sessionId,
            timestamp: ts.toISOString(),
            message: {
              model: model,
              usage: {
                input_tokens: inputK * 1000,
                output_tokens: outputK * 1000,
                cache_read_input_tokens: cacheReadK * 1000,
                cache_creation_input_tokens: 0,
              },
            },
          }));
        }

        const mockFile = path.join(projDir, `${sessionId}.jsonl`);
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(mockFile, lines.join('\n') + '\n', 'utf-8');
        totalLines.push(lines.length);
      }

      const total = totalLines.reduce((a, b) => a + b, 0);
      vscode.window.showInformationMessage(
        `✅ 已生成 ${records.length} 条余额数据 + ${total} 条 Token 数据（余额 ¥10 → ¥${balance.toFixed(2)}）`
      );
    } catch (err) {
      vscode.window.showWarningMessage(
        `余额数据已生成，Token mock 写入失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    vscode.window.showInformationMessage(
      `✅ 已生成 ${records.length} 条 7 天模拟数据（余额 ¥10 → ¥${balance.toFixed(2)}）`
    );
  }

  // 如果仪表盘已打开，立即刷新
  pushBalanceToDashboard();
}

// ── 清除测试数据 ──────────────────────────────────────────────────────────────

async function cmdClearTestData(context: vscode.ExtensionContext): Promise<void> {
  const confirm = await vscode.window.showWarningMessage(
    '将清除所有测试数据（余额历史 + Mock JSONL），确定？',
    { modal: true },
    '确定清除'
  );
  if (confirm !== '确定清除') return;

  // 清除余额历史
  await history.clear();

  // 清除 mock JSONL 文件
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const cwd = folders[0].uri.fsPath;
    const encoded = encodeWorkspacePath(cwd);
    const projDir = path.join(getClaudeProjectsDir(), encoded);
    try {
      const existing = fs.readdirSync(projDir).filter(f => f.startsWith('mock-') && f.endsWith('.jsonl'));
      for (const f of existing) fs.unlinkSync(path.join(projDir, f));
    } catch { /* dir may not exist */ }
  }

  // 重置状态栏
  lastData = null;
  lastRefresh = null;
  statusBar.update({ kind: 'no-key' });

  // 刷新面板（如果打开）
  if (DashboardPanel.isOpen) {
    const intervalSec = vscode.workspace.getConfiguration('deepseekMonitor').get<number>('refreshInterval', 60);
    DashboardPanel.pushBalance({
      total: 0, currency: 'CNY', isAvailable: false,
      history: [], lastRefresh: null, refreshInterval: intervalSec,
    });
  }

  vscode.window.showInformationMessage('🗑️ 测试数据已清除');
}
