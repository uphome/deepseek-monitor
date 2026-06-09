# DeepSeek Monitor

在 VSCode 状态栏实时显示 DeepSeek API 余额与 Token 用量，提供可视化监控面板。

> 无需代理拦截网络请求 —— Token 数据直接读取 Claude Code 本地 JSONL 文件，API Key 经由 VSCode Secrets API 加密存储。

## 功能

- 💰 **余额监控** — 状态栏实时显示余额，颜色预警
- 📊 **Token 用量** — 统计当前项目累积的 Input / Output / Cache 用量
- 📈 **7 天折线图** — 每日消耗可视化，悬停查看详细数据
- 🔔 **低余额报警** — 余额低于阈值自动弹窗提醒
- 🔐 **安全存储** — API Key 存于 VSCode Secrets，不落明文
- ⚡ **实时更新** — 余额定时轮询 + Token 文件监听，面板数字无闪烁动态刷新

## 安装

### 从 VSIX 安装

```sh
# 编译
npm install
npm run compile

# 打包
npx @vscode/vsce package

# 安装
code --install-extension deepseek-monitor-0.1.0.vsix
```

### 开发调试

```sh
git clone <repo-url>
cd deepseek-monitor
npm install
npm run watch   # 持续编译
```

在 VSCode 中按 `F5` 启动 Extension Development Host。

## 依赖

| 依赖 | 版本 |
|------|------|
| Node.js | >= 18 |
| VSCode | >= 1.85.0 |
| TypeScript | ^5.3 |

## 使用方法

1. `Ctrl+Shift+P` → **DeepSeek: 设置 API Key（安全存储）**
2. 粘贴你的 API Key（以 `sk-` 开头），从 [DeepSeek Platform](https://platform.deepseek.com/api_keys) 获取
3. 右下角状态栏即显示余额

### 命令列表

| 命令 | 说明 |
|------|------|
| `DeepSeek: 刷新余额` | 手动刷新余额 |
| `DeepSeek: 设置 API Key（安全存储）` | 配置 API Key |
| `DeepSeek: 清除 API Key` | 删除已保存的 Key |
| `DeepSeek: 打开用量面板` | 打开可视化面板 |
| `DeepSeek: 查看 Token 用量` | 同上 |
| `DeepSeek: 生成测试数据` | 生成 7 天模拟数据用于调试 |

## 配置

在 VSCode 设置中搜索 `deepseekMonitor`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `deepseekMonitor.refreshInterval` | `60` | 余额刷新间隔（秒），最小 10 |
| `deepseekMonitor.lowBalanceThreshold` | `5` | 低余额预警阈值（CNY） |
| `deepseekMonitor.showInStatusBar` | `true` | 是否在状态栏显示 |

## 架构

```
src/
├── extension.ts    # 插件入口、命令注册、定时器、watcher 生命周期
├── api.ts          # DeepSeek /user/balance API 封装
├── storage.ts      # 余额历史持久化（VSCode globalState）
├── statusBar.ts    # 状态栏显示（余额 + Token）
├── dashboard.ts    # Webview 面板（余额卡片 + 折线图 + Token 用量）
└── usage.ts        # 本地 JSONL 解析 + fs.watch 文件监听
```

数据来源：
- **余额** → `api.deepseek.com/user/balance` 定时轮询
- **Token** → `~/.claude/projects/<项目路径>/*.jsonl` 文件监听

## 常见问题

### Q: 状态栏显示 `DeepSeek: 未配置`？

运行 `DeepSeek: 设置 API Key（安全存储）` 并粘贴你的 API Key。

### Q: Token 用量面板显示"暂无数据"？

确保当前项目中使用过 Claude Code。Token 数据源是 Claude Code 本地 JSONL，如果项目中没有 Claude Code 会话记录则无数据。

### Q: 折线图/消耗表显示 `--`？

需要至少 2 条余额采样记录。首次安装后等待 60 秒再查看，或运行"生成测试数据"命令获取模拟数据。

### Q: 余额显示不更新？

检查 API Key 是否有效：运行 `DeepSeek: 刷新余额`，如果报 401 错误需重新设置 Key。

## 开源协议

MIT
