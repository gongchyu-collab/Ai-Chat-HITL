# AI Chat HITL MCP Tool

一个用于 AI 对话人工介入 (Human-in-the-Loop) 控制的 VSCode 插件，集成了 MCP Server。

## 功能特性

- **AI_chat_HITL 工具**: AI 在回答结束时调用此工具，询问用户是否继续对话
- **人工中断恢复**: 用户可以选择继续对话并输入新指令，或结束对话
- **工作区感知**: 对话框会在正确的 VSCode 窗口中弹出
- **MCP Server 集成**: 无需单独安装和启动 MCP Server
- **端口配置**: 支持自定义 MCP Server 端口
- **全局规则生成**: 一键生成 `.AichatHITLrules` 规则文件
- **富文本对话框**: 支持粘贴图片、拖拽文件/代码、上传文件等功能
- **多窗口支持**: 根据工作区路径自动匹配正确的窗口
- **侧边栏面板**: 活动栏显示状态、操作按钮和对话历史
- **对话历史记录**: 显示每次对话的时间、状态和用户输入
- **MCP 自动配置**: 一键自动写入 MCP 配置文件

## 项目结构

```
Ai-Chat-HITL/
├── vscode-extension/                      # VSCode 插件 (集成 MCP Server)
│   ├── src/
│   │   ├── extension.ts                   # 插件主入口
│   │   ├── mcpServer.ts                   # 内置 HTTP 服务器
│   │   ├── mcpServerStandalone.ts         # 独立 MCP Server (供外部调用)
│   │   ├── dialogPanel.ts                 # 对话面板 UI
│   │   ├── sidebarPanel.ts                # 侧边栏面板
│   │   └── configManager.ts               # 配置管理
│   ├── ai-chat-hitl-extension-1.21.0.vsix # 可直接安装的插件包
│   ├── package.json
│   └── tsconfig.json
├── .AichatHITLrules                       # AI 对话规则示例
└── README.md
```

---

## 安装指南

### 方式一：直接安装 VSIX 文件（推荐）

这是最简单的安装方式，无需编译源码。

**步骤：**

1. 下载本仓库中的 `vscode-extension/ai-chat-hitl-extension-1.21.0.vsix` 文件
2. 打开 VSCode / Windsurf / Cursor
3. 按 `Ctrl+Shift+P` (Mac: `Cmd+Shift+P`) 打开命令面板
4. 输入 `Extensions: Install from VSIX...` 并选择
5. 选择下载的 `.vsix` 文件
6. 重启编辑器即可使用

### 方式二：从源码构建安装

如果你需要自定义修改或者想使用最新的开发版本，可以从源码构建。

**环境要求：**

- Node.js >= 16.x
- npm >= 8.x

**步骤：**

```bash
# 1. 克隆仓库
git clone https://github.com/gongchyu/Ai-Chat-HITL.git

# 2. 进入插件目录
cd Ai-Chat-HITL/vscode-extension

# 3. 安装依赖
npm install

# 4. 编译 TypeScript 源码
npm run compile

# 5. 打包成 VSIX 文件
npm run package

# 打包完成后会生成 ai-chat-hitl-extension-x.x.x.vsix 文件
```

**安装打包后的插件：**

```bash
# 方法一：使用命令行安装
code --install-extension ai-chat-hitl-extension-1.21.0.vsix

# 方法二：在编辑器中手动安装（同方式一的步骤3-5）
```

---

## 配置 MCP

安装插件后，点击状态栏的 "AI Chat HITL" 按钮，选择 "配置 MCP"，按照说明配置。

或者手动在 MCP 配置文件中添加：

**Windsurf**: `~/.codeium/windsurf/mcp_config.json`
**Cursor**: `~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "AI_chat_HITL": {
      "command": "node",
      "args": ["<插件安装路径>/dist/mcpServerStandalone.js"],
      "env": {
        "AI_CHAT_HITL_PORT": "23987"
      }
    }
  }
}
```

## 插件功能

### 侧边栏面板

点击活动栏的 AI Chat HITL 图标，打开侧边栏面板：

- **版本显示**: 右上角显示当前插件版本
- **状态区域**: 显示服务端口、运行状态、对话次数
- **操作按钮**:
  - 配置 MCP（支持自动配置）
  - 生成规则文件
  - 修改端口
  - 重启服务
- **对话历史**: 显示每次对话的时间、状态和用户输入摘要

### 状态栏

点击状态栏的 "AI Chat HITL :23987" 按钮可以：

- **查看状态**: 查看 MCP Server 运行状态
- **修改端口**: 更改 MCP Server 端口
- **生成全局规则**: 在工作区生成 `.AichatHITLrules` 文件
- **配置 MCP**: 自动或手动配置 MCP
- **重启服务器**: 重启内置 MCP Server

## 对话框功能

当 AI 调用 `AI_chat_HITL` 工具时，会弹出对话框：

- **对话计数**: 显示当前是第几次对话
- **历史记录**: 可展开查看之前的对话历史
- **文本输入**: 输入新的指令
- **粘贴图片**: 使用 Ctrl+V 粘贴剪贴板中的图片
- **拖拽文件**: 将文件拖拽到对话框
- **拖拽代码**: 将代码文本拖拽到对话框
- **上传图片**: 点击图片按钮上传图片
- **上传文件**: 点击文件按钮上传文件
- **粘贴代码**: 点击代码按钮粘贴剪贴板中的代码

## 工作原理

1. 插件启动时自动启动内置 HTTP 服务器 (默认端口 23987)
2. 外部 MCP Server (mcpServerStandalone.js) 通过 HTTP 与插件通信
3. AI 调用 `AI_chat_HITL` 工具时，MCP Server 向插件发送请求
4. 插件根据 `workspace` 参数匹配正确的工作区窗口
5. 弹出对话面板让用户选择继续或结束
6. 用户响应后，结果返回给 AI

## 设置

在 VSCode 设置中可以配置：

- `ai-chat-hitl.serverPort`: MCP Server HTTP 端口 (默认: 23987)
