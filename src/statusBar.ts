// src/statusBar.ts
// 状态栏显示逻辑

import * as vscode from 'vscode';

export type StatusBarState =
  | { kind: 'loading' }
  | { kind: 'ok'; total: number; currency: string; lastConsumption: number | null }
  | { kind: 'unavailable' }        // API 返回 is_available: false（余额耗尽）
  | { kind: 'error'; message: string }
  | { kind: 'no-key' };

export class DeepSeekStatusBar {
  private readonly item: vscode.StatusBarItem;
  private lastTotalTokens = 0;
  private _lastOkState: StatusBarState & { kind: 'ok' } | null = null;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.item.command = 'deepseek-monitor.showDashboard';
    this.item.name = 'DeepSeek Monitor';
  }

  /** 从 Token 数据更新状态栏（余额数据可能尚未准备好） */
  updateTokens(totalTokens: number): void {
    this.lastTotalTokens = totalTokens;
    this.render();
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString('zh-CN');
  }

  private render(): void {
    const s = this._lastOkState;
    if (!s) return;

    const sym = s.currency === 'CNY' ? '¥' : '$';
    const tokenText = this.lastTotalTokens > 0 ? ` | Tokens ${this.formatTokens(this.lastTotalTokens)}` : '';
    this.item.text = `$(circuit-board) ${sym}${s.total.toFixed(2)}${tokenText}`;

    const tokenHint = this.lastTotalTokens > 0
      ? `\n总消耗 Token：${this.formatTokens(this.lastTotalTokens)}`
      : '';
    this.item.tooltip = new vscode.MarkdownString(
      `**DeepSeek 余额**\n\n总余额：${sym}${s.total.toFixed(2)}${tokenHint}\n\n点击打开用量面板`
    );
    this.item.backgroundColor = getLowBalanceColor(s.total);
  }

  update(state: StatusBarState): void {
    const config = vscode.workspace.getConfiguration('deepseekMonitor');
    const show = config.get<boolean>('showInStatusBar', true);

    if (!show) {
      this.item.hide();
      return;
    }

    switch (state.kind) {
      case 'loading':
        this.item.text = '$(sync~spin) DeepSeek';
        this.item.tooltip = '正在获取余额…';
        this.item.backgroundColor = undefined;
        break;

      case 'ok': {
        this._lastOkState = state;
        this.render();
        break;
      }

      case 'unavailable':
        this.item.text = '$(warning) DeepSeek: 余额耗尽';
        this.item.tooltip = '账户余额已耗尽，请前往 DeepSeek Platform 充值';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        break;

      case 'error':
        this.item.text = '$(error) DeepSeek';
        this.item.tooltip = `获取失败：${state.message}\n点击重试`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;

      case 'no-key':
        this.item.text = '$(key) DeepSeek: 未配置';
        this.item.tooltip = '点击设置 API Key';
        this.item.command = 'deepseek-monitor.setApiKey';
        this.item.backgroundColor = undefined;
        break;
    }

    if (state.kind !== 'no-key') {
      this.item.command = 'deepseek-monitor.showDashboard';
    }

    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function getLowBalanceColor(balance: number): vscode.ThemeColor | undefined {
  const config = vscode.workspace.getConfiguration('deepseekMonitor');
  const threshold = config.get<number>('lowBalanceThreshold', 5);
  if (balance <= 0) {
    return new vscode.ThemeColor('statusBarItem.errorBackground');
  }
  if (balance < threshold) {
    return new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  return undefined;
}
