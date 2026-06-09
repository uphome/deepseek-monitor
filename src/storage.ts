// src/storage.ts
// 本地余额历史记录管理

import * as vscode from 'vscode';

export interface BalanceSnapshot {
  timestamp: number;   // Unix ms
  total: number;
  currency: string;
}

const STORAGE_KEY = 'deepseek-monitor.balanceHistory';
const MAX_RECORDS = 200; // 最多保留 200 条

export class BalanceHistory {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getAll(): BalanceSnapshot[] {
    return this.context.globalState.get<BalanceSnapshot[]>(STORAGE_KEY, []);
  }

  async push(snapshot: BalanceSnapshot): Promise<void> {
    const records = this.getAll();
    records.push(snapshot);

    // 只保留最新的 MAX_RECORDS 条
    const trimmed = records.slice(-MAX_RECORDS);
    await this.context.globalState.update(STORAGE_KEY, trimmed);
  }

  getLast(): BalanceSnapshot | undefined {
    const records = this.getAll();
    return records[records.length - 1];
  }

  /** 获取最近 N 条 */
  getRecent(n: number): BalanceSnapshot[] {
    const records = this.getAll();
    return records.slice(-n);
  }

  /** 计算最近两次之间的消耗 */
  getLastConsumption(): number | null {
    const records = this.getAll();
    if (records.length < 2) return null;
    const last = records[records.length - 1];
    const prev = records[records.length - 2];
    const diff = prev.total - last.total;
    return diff > 0 ? diff : null;
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(STORAGE_KEY, []);
  }
}
