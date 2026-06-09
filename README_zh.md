[English](README.md)

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

## 环境要求

开始前请确保你的开发环境满足以下条件：

| 依赖 | 最低版本 | 检查命令 |
|------|----------|----------|
| Node.js | >= 18 | `node -v` |
| npm | >= 9 | `npm -v` |
| VSCode | >= 1.85.0 | `code --version` |
| Git | 任意 | `git --version` |

```sh
# 确认 Node 版本
node -v    # 应输出 v18.x 或更高

# 确认 npm 版本
npm -v     # 应输出 9.x 或更高
```

## 安装

### 方式一：从源码编译

```sh
# 1. 克隆仓库
git clone https://github.com/uphome/deepseek-monitor.git
cd deepseek-monitor

# 2. 安装依赖
npm install

# 3. 编译 TypeScript
npm run compile

# 4. 打包为 .vsix（需要 vsce，首次使用会自动安装）
npx @vscode/vsce package

# 5. 安装到 VSCode
code --install-extension deepseek-monitor-0.1.0.vsix
```

### 方式二：VSCode Marketplace（发布后）

在 VSCode 扩展商店搜索 `DeepSeek Monitor`，点击安装。

### 开发调试

```sh
git clone https://github.com/uphome/deepseek-monitor.git
cd deepseek-monitor
npm install
npm run watch    # 持续监听文件变更并编译
```

然后在 VSCode 中打开项目，按 `F5` 启动 Extension Development Host。修改源码后编译产物自动更新。

## 配置

### 1. 获取 API Key

访问 [DeepSeek Platform](https://platform.deepseek.com/api_keys) 创建 API Key（格式：`sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`）。

### 2. 设置 API Key

在 VSCode 中：

1. `Ctrl+Shift+P` 打开命令面板
2. 搜索并运行 **DeepSeek: 设置 API Key（安全存储）**
3. 粘贴你的 API Key
4. Key 将加密存入系统密钥链，不会以明文写入任何文件

### 3. 验证

设置成功后，VSCode 右下角状态栏立即显示余额：

```
┌─────────────────────────────────────┐
│ $(circuit-board) ¥4.52 | Tokens 3.73M │
└─────────────────────────────────────┘
```

### 4. 可选配置

在 VSCode 设置中搜索 `deepseekMonitor`：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `deepseekMonitor.refreshInterval` | `60` | 余额刷新间隔（秒），最小 10 |
| `deepseekMonitor.lowBalanceThreshold` | `5` | 余额低于此值发出警告（CNY） |
| `deepseekMonitor.showInStatusBar` | `true` | 是否在状态栏显示 |

## 使用

### 状态栏

右下角状态栏实时显示余额及当前项目 Token 消耗。鼠标悬停查看详情，点击打开完整面板。

余额颜色预警：
- 绿色 / 默认：余额充足
- 黄色：余额低于阈值（默认 ¥5）
- 红色：余额已耗尽

### 用量面板

`Ctrl+Shift+P` → **DeepSeek: 打开用量面板**

面板包含：
- 账户余额卡片（总余额 + 今日消耗）
- Token 用量卡片（Input / Output / Cache Read / 缓存覆盖率）
- 7 天每日消耗折线图（悬停查看详情）
- 近 7 天消耗明细表
- 模型分布与会话明细

### 全部命令

| 命令 | 说明 |
|------|------|
| `DeepSeek: 刷新余额` | 手动刷新余额 |
| `DeepSeek: 设置 API Key（安全存储）` | 配置 API Key |
| `DeepSeek: 清除 API Key` | 删除已保存的 Key |
| `DeepSeek: 打开用量面板` | 打开可视化面板 |
| `DeepSeek: 生成测试数据（开发）` | 生成 7 天模拟数据用于调试 |
| `DeepSeek: 清除测试数据（开发）` | 清除所有测试数据 |

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
