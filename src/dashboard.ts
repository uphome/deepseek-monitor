// src/dashboard.ts
// 用量仪表盘 WebviewPanel — 余额 + Token 用量合并面板
// 支持 postMessage 局部更新，带实时文件监听

import * as vscode from 'vscode';
import { BalanceSnapshot } from './storage.js';

// ── Token 用量相关类型 ───────────────────────────────────────────────────────────

interface TokenUsageData {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface TokenSessionData {
  sessionId: string;
  model: string;
  rounds: number;
  firstTimestamp: string;
  lastTimestamp: string;
  usage: TokenUsageData;
}

interface TokenData {
  cwd: string;
  sessions: TokenSessionData[];
  totalUsage: TokenUsageData;
  totalRounds: number;
  parsedAt: number;
}

// ── 按天聚合 ─────────────────────────────────────────────────────────────────────

interface DailyAggregate {
  date: string;       // "6/9"
  iso: string;        // "2026-06-09"
  firstTotal: number;
  lastTotal: number;
  consumed: number;
}

function groupByDay(history: { timestamp: number; total: number }[]): DailyAggregate[] {
  const map = new Map<string, { firstTotal: number; lastTotal: number; firstTs: number; lastTs: number }>();

  for (const h of history) {
    const d = new Date(h.timestamp);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const existing = map.get(key);
    if (!existing) {
      map.set(key, { firstTotal: h.total, lastTotal: h.total, firstTs: h.timestamp, lastTs: h.timestamp });
    } else {
      if (h.timestamp < existing.firstTs) { existing.firstTotal = h.total; existing.firstTs = h.timestamp; }
      if (h.timestamp > existing.lastTs) { existing.lastTotal = h.total; existing.lastTs = h.timestamp; }
    }
  }

  return [...map.entries()]
    .map(([key, v]) => ({
      iso: key,
      date: `${parseInt(key.split('-')[1], 10)}/${parseInt(key.split('-')[2], 10)}`,
      firstTotal: v.firstTotal,
      lastTotal: v.lastTotal,
      consumed: Math.max(0, v.firstTotal - v.lastTotal),
    }))
    .sort((a, b) => a.iso.localeCompare(b.iso))
    .slice(-7);
}

function buildTokenDaily(sessions: { lastTimestamp: string; usage: TokenUsageData }[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const s of sessions) {
    const d = new Date(s.lastTimestamp);
    const key = `${d.getMonth() + 1}/${d.getDate()}`;
    map[key] = (map[key] || 0) + s.usage.inputTokens + s.usage.outputTokens;
  }
  return map;
}

function calcTodayConsumed(history: { timestamp: number; total: number }[]): number | null {
  const todayKey = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  })();
  const todayRecords = history.filter(h => {
    const d = new Date(h.timestamp);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayKey;
  });
  if (todayRecords.length < 2) return null;
  return Math.max(0, todayRecords[0].total - todayRecords[todayRecords.length - 1].total);
}

// ── 面板输入数据 ─────────────────────────────────────────────────────────────────

export interface DashboardData {
  total: number;
  currency: string;
  isAvailable: boolean;
  history: BalanceSnapshot[];
  lastRefresh: Date | null;
  refreshInterval: number;
  tokenUsage: TokenData | null;
}

export class DashboardPanel {
  private static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];
  private rendered = false;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  static createOrShow(extensionUri: vscode.Uri): DashboardPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.One;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      return DashboardPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'deepseekDashboard',
      'DeepSeek 用量面板',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel);
    return DashboardPanel.currentPanel;
  }

  static get isOpen(): boolean {
    return DashboardPanel.currentPanel !== undefined;
  }

  static pushBalance(data: {
    total: number;
    currency: string;
    isAvailable: boolean;
    history: BalanceSnapshot[];
    lastRefresh: Date | null;
    refreshInterval: number;
  }): void {
    if (!DashboardPanel.currentPanel) return;
    const p = DashboardPanel.currentPanel;
    if (!p.rendered) return;
    p.panel.webview.postMessage({ type: 'updateBalance', data: p.serializeBalance(data) });
  }

  static pushTokenUsage(data: TokenData): void {
    if (!DashboardPanel.currentPanel) return;
    const p = DashboardPanel.currentPanel;
    if (!p.rendered) return;
    p.panel.webview.postMessage({ type: 'updateTokenUsage', data });
  }

  // ── 实例方法 ──────────────────────────────────────────────────────────────────

  update(data: DashboardData): void {
    if (!this.rendered) {
      this.panel.webview.html = this.buildHtml(data);
      this.rendered = true;
    } else {
      this.panel.webview.postMessage({
        type: 'fullUpdate',
        balance: this.serializeBalance(data),
        tokenUsage: data.tokenUsage,
      });
    }
  }

  // ── HTML 构建 ──────────────────────────────────────────────────────────────────

  private buildHtml(data: DashboardData): string {
    const sym = data.currency === 'CNY' ? '¥' : '$';
    const balJson = JSON.stringify(this.serializeBalance(data));

    // 按天聚合
    const daily = groupByDay(data.history);
    const todayConsumed = calcTodayConsumed(data.history);
    const tokenDaily = buildTokenDaily(data.tokenUsage?.sessions ?? []);

    // Token 缓存覆盖率
    const cacheRate = data.tokenUsage
      ? data.tokenUsage.totalUsage.cacheReadTokens / (data.tokenUsage.totalUsage.cacheReadTokens + data.tokenUsage.totalUsage.inputTokens || 1)
      : 0;

    const refreshTime = data.lastRefresh
      ? data.lastRefresh.toLocaleTimeString('zh-CN')
      : '--';

    return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>DeepSeek 用量面板</title>
<style>
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-panel-border);
    --card-bg: var(--vscode-sideBar-background);
    --accent: #4D9EF7;
    --green: #3DC97A;
    --orange: #F5A623;
    --red: #E05252;
    --purple: #A78BFA;
    --muted: var(--vscode-descriptionForeground);
    --font: var(--vscode-font-family);
    --mono: var(--vscode-editor-font-family);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--font);
    background: var(--bg);
    color: var(--fg);
    padding: 24px;
    min-height: 100vh;
  }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 24px; flex-wrap: wrap; gap: 8px;
  }
  .header h1 { font-size: 18px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .status-dot.ok { background: var(--green); }
  .status-dot.bad { background: var(--red); }
  .live-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--green); display: inline-block;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .refresh-info { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 8px; }
  .cards {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 16px; margin-bottom: 28px;
  }
  .card {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 18px 20px; transition: border-color 0.3s;
  }
  .card.flash { border-color: var(--accent); }
  .card-label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--muted); margin-bottom: 8px;
  }
  .card-value { font-size: 26px; font-weight: 700; font-family: var(--mono); }
  .card-value.accent { color: var(--accent); }
  .card-value.green  { color: var(--green); }
  .card-value.purple { color: var(--purple); }
  .card-value.muted  { color: var(--muted); font-size: 20px; }
  .card-value.warning { color: var(--orange); }
  .card-value.danger  { color: var(--red); }
  .card-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }
  .section-title {
    font-size: 13px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px;
  }
  .divider { border-top: 1px solid var(--border); margin: 28px 0; }
  /* 折线图 */
  .chart-wrap {
    position: relative;
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 18px 20px; margin-bottom: 24px;
  }
  .line-chart { width: 100%; display: block; }
  .line-chart polyline { fill: none; stroke: var(--accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
  .dot-hit { fill: transparent; stroke: none; cursor: pointer; }
  .dot-vis { fill: var(--accent); transition: r 0.2s ease, cx 0.4s ease, cy 0.4s ease; }
  .dot-group:hover .dot-vis { r: 5; fill: #fff; stroke: var(--accent); stroke-width: 2; }
  #chtLine { transition: opacity 0.2s; }
  #chtDots { transition: opacity 0.2s; }
  .line-chart .grid-line { stroke: var(--border); stroke-width: 0.5; vector-effect: non-scaling-stroke; }
  .chart-label { font-size: 9px; fill: var(--muted); font-family: var(--font); }
  /* 自定义 tooltip */
  #svgTooltip {
    position: fixed;
    display: none;
    background: var(--card-bg);
    color: var(--fg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 10px 14px;
    font-size: 12px;
    font-family: var(--mono);
    line-height: 1.7;
    pointer-events: none;
    z-index: 1000;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    white-space: nowrap;
  }
  #svgTooltip .tt-date { color: var(--fg); font-weight: 600; margin-bottom: 4px; font-size: 13px; }
  #svgTooltip .tt-row { display: flex; justify-content: space-between; gap: 20px; }
  #svgTooltip .tt-label { color: var(--muted); }
  #svgTooltip .tt-val { color: var(--orange); }
  #svgTooltip .tt-val-token { color: var(--accent); }
  /* 表 */
  .table-wrap {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 8px; overflow: hidden;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead tr { background: var(--border); }
  th {
    padding: 10px 14px; text-align: left; font-size: 11px;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);
  }
  td { padding: 9px 14px; border-bottom: 1px solid var(--border); font-family: var(--mono); font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; }
  .cost-cell { color: var(--orange); }
  .token-cell { color: var(--accent); }
  .empty { padding: 24px; text-align: center; color: var(--muted); font-size: 13px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .badge-ok  { background: rgba(61,201,122,0.15); color: var(--green); }
  .badge-bad { background: rgba(224,82,82,0.15); color: var(--red); }
  .model-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; }
  .model-chip {
    background: var(--card-bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 10px 16px; font-size: 13px;
  }
  .model-chip .name { font-weight: 600; margin-bottom: 4px; }
  .model-chip .detail { font-size: 11px; color: var(--muted); font-family: var(--mono); }
  .footer-stats { display: flex; gap: 24px; margin-top: 20px; font-size: 13px; color: var(--muted); }
  .footer-stats strong { color: var(--fg); }
  .no-data-hint {
    padding: 20px; text-align: center; color: var(--muted);
    background: var(--card-bg); border: 1px dashed var(--border);
    border-radius: 8px; margin-bottom: 16px;
  }
</style>
</head>
<body>

<div id="svgTooltip"></div>
<div class="header">
  <h1>
    <span class="status-dot ${data.isAvailable ? 'ok' : 'bad'}" id="statusDot"></span>
    DeepSeek 用量监控
    <span class="badge ${data.isAvailable ? 'badge-ok' : 'badge-bad'}" id="availBadge">
      ${data.isAvailable ? '正常' : '余额耗尽'}
    </span>
    <span class="live-dot" id="liveDot" title="实时监听中" style="margin-left:4px"></span>
  </h1>
  <div class="refresh-info" id="refreshInfo">
    最后更新：${refreshTime} &nbsp;·&nbsp; 每 ${data.refreshInterval}s 自动刷新
  </div>
</div>

<!-- ① 账户余额 -->
<div class="section-title">💰 账户余额</div>
<div class="cards">
  <div class="card" id="cardTotal">
    <div class="card-label">💰 总余额</div>
    <div class="card-value ${data.total < 1 ? 'danger' : data.total < 5 ? 'warning' : ''}" id="valTotal">
      ${sym}${data.total.toFixed(2)}
    </div>
    <div class="card-sub">${data.currency}</div>
  </div>
  <div class="card" id="cardConsumed">
    <div class="card-label">📉 今日消耗</div>
    <div class="card-value ${todayConsumed !== null && todayConsumed > 0 ? 'warning' : 'muted'}" id="valConsumed">
      ${todayConsumed !== null && todayConsumed > 0 ? `${sym}${todayConsumed.toFixed(2)}` : '--'}
    </div>
    <div class="card-sub">${new Date().toLocaleDateString('zh-CN')}</div>
  </div>
</div>

${data.tokenUsage ? `
<!-- ② Token 用量 -->
<div class="section-title">📊 Token 用量</div>
<div class="cards">
  <div class="card" id="cardTkInput">
    <div class="card-label">📥 Input Tokens</div>
    <div class="card-value accent" id="valTkInput">${this.formatNum(data.tokenUsage.totalUsage.inputTokens)}</div>
    <div class="card-sub">提示词消耗</div>
  </div>
  <div class="card" id="cardTkOutput">
    <div class="card-label">📤 Output Tokens</div>
    <div class="card-value green" id="valTkOutput">${this.formatNum(data.tokenUsage.totalUsage.outputTokens)}</div>
    <div class="card-sub">生成回复消耗</div>
  </div>
  <div class="card" id="cardTkCacheRead">
    <div class="card-label">♻️ Cache Read</div>
    <div class="card-value purple" id="valTkCacheRead">${this.formatNum(data.tokenUsage.totalUsage.cacheReadTokens)}</div>
    <div class="card-sub">缓存命中节省</div>
  </div>
  <div class="card" id="cardTkCacheRate">
    <div class="card-label">🎯 缓存覆盖率</div>
    <div class="card-value ${cacheRate > 0.5 ? 'green' : 'warning'}" id="valTkCacheRate">${(cacheRate * 100).toFixed(1)}%</div>
    <div class="card-sub">Cache / (Cache + Input)</div>
  </div>
</div>
` : ''}

<div class="divider"></div>

<!-- ③ 每日消耗折线图 -->
<div class="chart-wrap">
  <div class="section-title">📈 每日消耗（近 7 天）</div>
  <div id="chartArea">${this.buildLineChart(daily)}</div>
</div>

<!-- ④ 近 7 天消耗 -->
<div class="section-title">🕐 近 7 天消耗</div>
<div class="table-wrap" id="dailyTable">${this.buildDailyTable(daily, sym, tokenDaily)}</div>

${data.tokenUsage ? `
<div class="divider"></div>
<!-- ⑤ 模型分布 -->
<div class="section-title">🤖 模型分布</div>
<div class="model-chips" id="modelChips">${this.buildModelChips(data.tokenUsage.sessions)}</div>

<!-- ⑥ 会话明细 -->
<div class="section-title">📋 会话明细</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>会话 ID</th><th>模型</th><th class="num">轮次</th><th class="num">Input</th><th class="num">Output</th><th class="num">Cache Read</th><th>最后活跃</th></tr></thead>
    <tbody id="sessionTbody">${this.buildSessionRows(data.tokenUsage.sessions)}</tbody>
  </table>
</div>

<div class="footer-stats">
  <div>总轮次：<strong id="statRounds">${data.tokenUsage.totalRounds}</strong></div>
  <div>总会话：<strong id="statSessions">${data.tokenUsage.sessions.length}</strong></div>
  <div>Input/Output 比：<strong id="statRatio">${data.tokenUsage.totalUsage.outputTokens > 0 ? (data.tokenUsage.totalUsage.inputTokens / data.tokenUsage.totalUsage.outputTokens).toFixed(1) : '--'}</strong></div>
</div>
` : `<div class="no-data-hint">暂无 Token 用量数据 — 请先在当前项目中使用 Claude Code</div>`}

<script>
(function() {
  const vscode = acquireVsCodeApi();
  var sym = "${sym}";
  var prev = { balTotal: ${data.total}, tkI: ${data.tokenUsage?.totalUsage.inputTokens ?? 0}, tkO: ${data.tokenUsage?.totalUsage.outputTokens ?? 0} };
  var tokenDailyMap = {};
  var lastDaily = [];
  var tooltipEl = document.getElementById('svgTooltip');

  function showTooltip(e, tipHtml) {
    if (!tooltipEl) return;
    tooltipEl.innerHTML = tipHtml;
    tooltipEl.style.display = 'block';

    // 获取悬停圆点的屏幕坐标
    var dot = e.target.closest('.dot-group');
    var vis = dot ? dot.querySelector('.dot-vis') : null;
    var circleRect = vis ? vis.getBoundingClientRect() : null;
    var cx = circleRect ? circleRect.left + circleRect.width / 2 : e.clientX;
    var cy = circleRect ? circleRect.top : e.clientY;

    // tooltip 放在圆点正上方，居中
    var tw = tooltipEl.offsetWidth;
    var th = tooltipEl.offsetHeight;
    var left = cx - tw / 2;
    var top = cy - th - 10;

    // 边界修正
    if (left < 8) left = 8;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    if (top < 8) top = cy + 16; // 上方空间不够，放到下方

    tooltipEl.style.left = left + 'px';
    tooltipEl.style.top = top + 'px';
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
  }

  function buildTooltipHtml(d) {
    var sym2 = sym;
    return '<div class="tt-date">' + d.date + '</div>' +
      '<div class="tt-row"><span class="tt-label">消耗</span><span class="tt-val">' + sym2 + d.consumed.toFixed(2) + '</span></div>' +
      '<div class="tt-row"><span class="tt-label">Token</span><span class="tt-val-token">' + (d._tokens > 0 ? fmtNum(d._tokens) : '--') + '</span></div>';
  }

  function attachTooltipListeners() {
    var groups = document.querySelectorAll('#chtDots .dot-group');
    for (var i = 0; i < groups.length; i++) {
      (function(g, idx) {
        g.addEventListener('mouseenter', function(e) {
          if (lastDaily && idx < lastDaily.length) showTooltip(e, buildTooltipHtml(lastDaily[idx]));
        });
        g.addEventListener('mouseleave', hideTooltip);
      })(groups[i], i);
    }
  }
  // 初始挂载
  setTimeout(attachTooltipListeners, 100);

  function fmtNum(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toLocaleString('zh-CN');
  }

  function flash(cardId) {
    var el = document.getElementById(cardId);
    if (!el) return;
    el.classList.add('flash');
    setTimeout(function() { el.classList.remove('flash'); }, 600);
  }

  // ── 按天分组 ──
  function groupByDay(history) {
    var map = new Map();
    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      var d = new Date(h.timestamp);
      var key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      var ex = map.get(key);
      if (!ex) {
        map.set(key, { firstTotal: h.total, lastTotal: h.total, firstTs: h.timestamp, lastTs: h.timestamp });
      } else {
        if (h.timestamp < ex.firstTs) { ex.firstTotal = h.total; ex.firstTs = h.timestamp; }
        if (h.timestamp > ex.lastTs) { ex.lastTotal = h.total; ex.lastTs = h.timestamp; }
      }
    }
    var arr = [];
    map.forEach(function(v, key) {
      arr.push({
        iso: key,
        date: parseInt(key.split('-')[1],10) + '/' + parseInt(key.split('-')[2],10),
        firstTotal: v.firstTotal, lastTotal: v.lastTotal,
        consumed: Math.max(0, v.firstTotal - v.lastTotal)
      });
    });
    arr.sort(function(a,b) { return a.iso.localeCompare(b.iso); });
    return arr.slice(-7);
  }

  function buildTokenDailyMap(sessions) {
    var map = {};
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var d = new Date(s.lastTimestamp);
      var key = (d.getMonth()+1) + '/' + d.getDate();
      map[key] = (map[key] || 0) + s.usage.inputTokens + s.usage.outputTokens;
    }
    return map;
  }

  function calcTodayConsumed(history) {
    var now = new Date();
    var todayKey = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
    var records = [];
    for (var i = 0; i < history.length; i++) {
      var d = new Date(history[i].timestamp);
      var k = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      if (k === todayKey) records.push(history[i]);
    }
    if (records.length < 2) return null;
    return Math.max(0, records[0].total - records[records.length - 1].total);
  }

  // ── SVG 折线图（DOM 直接更新，避免 innerHTML 闪烁）──
  var chartW = 560, chartH = 90;

  function updateLineChart(daily, s, tokenMap) {
    var svg = document.getElementById('lineChart');
    if (!svg || daily.length < 2) return;

    var tMap = tokenMap || {};
    // 给 daily 附加 token 数据供 tooltip 使用
    for (var i = 0; i < daily.length; i++) {
      daily[i]._tokens = tMap[daily[i].date] || 0;
    }
    var values = daily.map(function(d) { return d.consumed; });
    var max = Math.max.apply(null, values.concat([0.01]));
    var adjRange = max * 1.15 || 1;
    var n = daily.length;
    var xScale = chartW / (n - 1);

    // 更新 polyline 点
    var pts = '';
    for (var i = 0; i < n; i++) {
      var x = i * xScale;
      var y = chartH - ((values[i] - 0) / adjRange) * chartH;
      pts += (i === 0 ? '' : ' ') + x.toFixed(1) + ',' + y.toFixed(1);
    }
    var line = document.getElementById('chtLine');
    if (line) {
      line.style.opacity = '0.5';
      line.setAttribute('points', pts);
      setTimeout(function() { line.style.opacity = '1'; }, 50);
    }

    // 更新圆圈 + tooltip（按索引匹配，不足则补充）
    var dotsG = document.getElementById('chtDots');
    var existingCircles = dotsG ? dotsG.querySelectorAll('.dot-group') : [];
    var existingLen = existingCircles.length;

    var newDotsHtml = '';
    for (var i = 0; i < n; i++) {
      var x = i * xScale;
      var y = chartH - ((values[i] - 0) / adjRange) * chartH;
      var d = daily[i];

      if (i < existingLen) {
        var g = existingCircles[i];
        var vis = g ? g.querySelector('.dot-vis') : null;
        var hit = g ? g.querySelector('.dot-hit') : null;
        if (vis) { vis.setAttribute('cx', x.toFixed(1)); vis.setAttribute('cy', y.toFixed(1)); }
        if (hit) { hit.setAttribute('cx', x.toFixed(1)); hit.setAttribute('cy', y.toFixed(1)); }
      } else {
        newDotsHtml += '<g class="dot-group">' +
          '<circle id="cdh' + i + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="8" class="dot-hit"/>' +
          '<circle id="cd' + i + '" cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2" class="dot-vis"/>' +
          '</g>';
      }
    }
    // 移除多余的旧 circle
    if (existingLen > n && dotsG) {
      for (var i = n; i < existingLen; i++) {
        if (existingCircles[i]) existingCircles[i].remove();
      }
    }
    // 追加新的
    if (newDotsHtml && dotsG) {
      dotsG.insertAdjacentHTML('beforeend', newDotsHtml);
    }
    setTimeout(attachTooltipListeners, 50);

    // 更新 X 轴日期标签
    var labelsG = document.getElementById('chtXLabels');
    if (labelsG) {
      var labelHtml = '';
      for (var i = 0; i < n; i++) {
        if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
          labelHtml += '<text x="' + (i * xScale).toFixed(1) + '" y="' + (chartH + 12) + '" text-anchor="middle" class="chart-label">' + daily[i].date + '</text>';
        }
      }
      labelsG.innerHTML = labelHtml;
    }

  }

  function buildDailyTable(daily, s, tokenMap) {
    if (daily.length === 0) return '<div class="empty">暂无数据</div>';
    var tMap = tokenMap || {};
    var reversed = daily.slice().reverse();
    var rows = '';
    for (var i = 0; i < reversed.length; i++) {
      var d = reversed[i];
      var tokens = tMap[d.date] || 0;
      rows += '<tr>' +
        '<td>' + d.date + '</td>' +
        '<td class="num">' + s + d.lastTotal.toFixed(2) + '</td>' +
        '<td class="num cost-cell">' + (d.consumed > 0 ? s + d.consumed.toFixed(2) : '--') + '</td>' +
        '<td class="num token-cell">' + (tokens > 0 ? fmtNum(tokens) : '--') + '</td>' +
        '</tr>';
    }
    return '<table><thead><tr><th>日期</th><th class="num">当日终值</th><th class="num">当日消耗</th><th class="num">Token</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // ── 更新余额 ──
  function updateBalance(d) {
    var t = d.total;
    if (Math.abs(t - prev.balTotal) > 0.0001) { flash('cardTotal'); flash('cardConsumed'); }
    prev.balTotal = t;

    document.getElementById('valTotal').textContent = sym + t.toFixed(2);
    document.getElementById('valTotal').className = 'card-value' + (t < 1 ? ' danger' : t < 5 ? ' warning' : '');

    // 今日消耗
    var consumed = calcTodayConsumed(d.history);
    var valC = document.getElementById('valConsumed');
    valC.textContent = consumed !== null && consumed > 0 ? sym + consumed.toFixed(2) : '--';
    valC.className = 'card-value' + (consumed !== null && consumed > 0 ? ' warning' : ' muted');

    // 7 天折线图 + 日消耗表
    lastDaily = groupByDay(d.history);
    for (var _j = 0; _j < lastDaily.length; _j++) {
      lastDaily[_j]._tokens = tokenDailyMap[lastDaily[_j].date] || 0;
    }
    updateLineChart(lastDaily, sym, tokenDailyMap);
    document.getElementById('dailyTable').innerHTML = buildDailyTable(lastDaily, sym, tokenDailyMap);

    // 状态点
    var dot = document.getElementById('statusDot');
    dot.className = 'status-dot ' + (d.isAvailable ? 'ok' : 'bad');
    var badge = document.getElementById('availBadge');
    badge.textContent = d.isAvailable ? '正常' : '余额耗尽';
    badge.className = 'badge ' + (d.isAvailable ? 'badge-ok' : 'badge-bad');

    var rt = d.lastRefresh ? new Date(d.lastRefresh).toLocaleTimeString('zh-CN') : '--';
    document.getElementById('refreshInfo').textContent =
      '最后更新：' + rt + '  ·  每 ' + (d.refreshInterval || 60) + 's 自动刷新';
  }

  // ── 更新 Token 用量 ──
  function updateTokenUsage(tu) {
    if (!tu) return;
    var u = tu.totalUsage;

    if (u.inputTokens !== prev.tkI) { flash('cardTkInput'); prev.tkI = u.inputTokens; }
    if (u.outputTokens !== prev.tkO) { flash('cardTkOutput'); prev.tkO = u.outputTokens; }
    flash('cardTkCacheRead'); flash('cardTkCacheRate');

    document.getElementById('valTkInput').textContent = fmtNum(u.inputTokens);
    document.getElementById('valTkOutput').textContent = fmtNum(u.outputTokens);
    document.getElementById('valTkCacheRead').textContent = fmtNum(u.cacheReadTokens);

    // 更新 token 日聚合并刷新折线图 tooltip
    tokenDailyMap = buildTokenDailyMap(tu.sessions);
    for (var _k = 0; _k < lastDaily.length; _k++) {
      lastDaily[_k]._tokens = tokenDailyMap[lastDaily[_k].date] || 0;
    }
    updateLineChart(lastDaily, sym, tokenDailyMap);
    document.getElementById('dailyTable').innerHTML = buildDailyTable(lastDaily, sym, tokenDailyMap);

    // 缓存覆盖率
    var rate = u.cacheReadTokens / (u.cacheReadTokens + (u.inputTokens || 1));
    var rateEl = document.getElementById('valTkCacheRate');
    rateEl.textContent = (rate * 100).toFixed(1) + '%';
    rateEl.className = 'card-value' + (rate > 0.5 ? ' green' : ' warning');

    // 模型分布
    var modelMap = new Map();
    for (var i = 0; i < tu.sessions.length; i++) {
      var s = tu.sessions[i];
      var m = modelMap.get(s.model);
      if (!m) { m = { count: 0, input: 0, output: 0 }; modelMap.set(s.model, m); }
      m.count++;
      m.input += s.usage.inputTokens;
      m.output += s.usage.outputTokens;
    }
    var chips = '';
    modelMap.forEach(function(m, name) {
      chips += '<div class="model-chip">' +
        '<div class="name">' + esc(name) + '</div>' +
        '<div class="detail">' + m.count + ' 会话 · 入 ' + fmtNum(m.input) + ' · 出 ' + fmtNum(m.output) + '</div>' +
        '</div>';
    });
    document.getElementById('modelChips').innerHTML = chips;

    document.getElementById('sessionTbody').innerHTML = buildSessionRows(tu.sessions);
    document.getElementById('statRounds').textContent = tu.totalRounds;
    document.getElementById('statSessions').textContent = tu.sessions.length;
    document.getElementById('statRatio').textContent =
      u.outputTokens > 0 ? (u.inputTokens / u.outputTokens).toFixed(1) : '--';
  }

  function buildSessionRows(sessions) {
    var sorted = sessions.slice().sort(function(a, b) {
      return new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime();
    });
    var rows = '';
    for (var i = 0; i < sorted.length; i++) {
      var s = sorted[i];
      rows += '<tr>' +
        '<td title="' + esc(s.sessionId) + '">' + esc(s.sessionId.slice(0, 8)) + '…</td>' +
        '<td>' + esc(s.model) + '</td>' +
        '<td class="num">' + s.rounds + '</td>' +
        '<td class="num">' + fmtNum(s.usage.inputTokens) + '</td>' +
        '<td class="num">' + fmtNum(s.usage.outputTokens) + '</td>' +
        '<td class="num">' + fmtNum(s.usage.cacheReadTokens) + '</td>' +
        '<td>' + new Date(s.lastTimestamp).toLocaleString('zh-CN') + '</td>' +
        '</tr>';
    }
    return rows;
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // 初始化日聚合数据（后续 postMessage 更新时复用）
  lastDaily = groupByDay(${JSON.stringify(data.history.map(h => ({timestamp: h.timestamp, total: h.total})))});
  tokenDailyMap = buildTokenDailyMap(${JSON.stringify(data.tokenUsage?.sessions ?? [])});
  for (var _i = 0; _i < lastDaily.length; _i++) {
    lastDaily[_i]._tokens = tokenDailyMap[lastDaily[_i].date] || 0;
  }

  window.addEventListener('message', function(e) {
    var msg = e.data;
    if (!msg) return;
    if (msg.type === 'updateBalance') updateBalance(msg.data);
    else if (msg.type === 'updateTokenUsage') updateTokenUsage(msg.data);
    else if (msg.type === 'fullUpdate') {
      if (msg.balance) updateBalance(msg.balance);
      if (msg.tokenUsage) updateTokenUsage(msg.tokenUsage);
    }
  });
})();
</script>

</body>
</html>`;
  }

  // ── 序列化 / 格式化辅助 ────────────────────────────────────────────────────────

  private serializeBalance(data: {
    total: number;
    currency: string;
    isAvailable: boolean;
    history: BalanceSnapshot[];
    lastRefresh: Date | null;
    refreshInterval: number;
  }): Record<string, unknown> {
    return {
      total: data.total,
      currency: data.currency,
      isAvailable: data.isAvailable,
      history: data.history.map(h => ({
        timestamp: h.timestamp,
        total: h.total,
      })),
      lastRefresh: data.lastRefresh ? data.lastRefresh.toISOString() : null,
      refreshInterval: data.refreshInterval,
    };
  }

  private formatNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return n.toLocaleString('zh-CN');
  }

  private esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  private buildLineChart(daily: DailyAggregate[]): string {
    if (daily.length < 2) return '<div class="empty">数据不足（需至少 2 天）</div>';

    const W = 560, H = 90, R = 2;
    const values = daily.map(d => d.consumed);
    const max = Math.max(...values, 0.01);
    const min = 0;
    const adjRange = max * 1.15 || 1;
    const n = daily.length;
    const xScale = W / (n - 1);

    let points = '';
    let dots = '';
    let labels = '';
    for (let i = 0; i < n; i++) {
      const x = i * xScale;
      const y = H - ((values[i] - min) / adjRange) * H;
      const d = daily[i];
      points += `${i === 0 ? '' : ' '}${x.toFixed(1)},${y.toFixed(1)}`;
      dots += `<g class="dot-group">
        <circle id="cdh${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="8" class="dot-hit"/>
        <circle id="cd${i}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${R}" class="dot-vis"/>
      </g>`;
      if (i === 0 || i === n - 1 || i === Math.floor(n / 2)) {
        labels += `<text x="${x.toFixed(1)}" y="${H + 12}" text-anchor="middle" class="chart-label">${d.date}</text>`;
      }
    }

    return `<svg id="lineChart" viewBox="-40 -4 ${W + 80} ${H + 20}" class="line-chart">
      <polyline id="chtLine" points="${points}"/>
      <g id="chtDots">${dots}</g>
      <g id="chtXLabels">${labels}</g>
      <line x1="0" y1="${H}" x2="${W}" y2="${H}" class="grid-line"/>
    </svg>`;
  }

  private buildDailyTable(daily: DailyAggregate[], sym: string, tokenDaily: Record<string, number> = {}): string {
    if (daily.length === 0) return '<div class="empty">暂无数据</div>';
    const reversed = [...daily].reverse();
    const rows = reversed.map(d => {
      const tokens = tokenDaily[d.date] ?? 0;
      return `<tr>
        <td>${d.date}</td>
        <td class="num">${sym}${d.lastTotal.toFixed(2)}</td>
        <td class="num cost-cell">${d.consumed > 0 ? `${sym}${d.consumed.toFixed(2)}` : '--'}</td>
        <td class="num token-cell">${tokens > 0 ? this.formatNum(tokens) : '--'}</td>
      </tr>`;
    }).join('');
    return `<table>
      <thead><tr><th>日期</th><th class="num">当日终值</th><th class="num">当日消耗</th><th class="num">Token</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  private buildModelChips(sessions: TokenSessionData[]): string {
    const modelMap = new Map<string, { count: number; input: number; output: number }>();
    for (const s of sessions) {
      const m = modelMap.get(s.model) || { count: 0, input: 0, output: 0 };
      m.count++;
      m.input += s.usage.inputTokens;
      m.output += s.usage.outputTokens;
      modelMap.set(s.model, m);
    }
    let html = '';
    modelMap.forEach((m, name) => {
      html += `<div class="model-chip">
        <div class="name">${this.esc(name)}</div>
        <div class="detail">${m.count} 会话 · 入 ${this.formatNum(m.input)} · 出 ${this.formatNum(m.output)}</div>
      </div>`;
    });
    return html;
  }

  private buildSessionRows(sessions: TokenSessionData[]): string {
    const sorted = [...sessions].sort(
      (a, b) => new Date(b.lastTimestamp).getTime() - new Date(a.lastTimestamp).getTime()
    );
    return sorted.map(s => `
      <tr>
        <td title="${this.esc(s.sessionId)}">${this.esc(s.sessionId.slice(0, 8))}…</td>
        <td>${this.esc(s.model)}</td>
        <td class="num">${s.rounds}</td>
        <td class="num">${this.formatNum(s.usage.inputTokens)}</td>
        <td class="num">${this.formatNum(s.usage.outputTokens)}</td>
        <td class="num">${this.formatNum(s.usage.cacheReadTokens)}</td>
        <td>${new Date(s.lastTimestamp).toLocaleString('zh-CN')}</td>
      </tr>
    `).join('');
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────────

  dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
  }
}
