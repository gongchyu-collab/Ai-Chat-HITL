# AI Chat HITL MCP Tool

一个用于 AI 对话人工介入 (Human-in-the-Loop) 控制的 VSCode 插件，集成了 MCP Server。

## 功能

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
mcp_tool/
├── vscode-extension/           # VSCode 插件 (集成 MCP Server)
│   ├── src/
│   │   ├── extension.ts        # 插件主入口
│   │   ├── mcpServer.ts        # 内置 HTTP 服务器
│   │   ├── mcpServerStandalone.ts  # 独立 MCP Server (供外部调用)
│   │   ├── dialogPanel.ts      # 对话面板 UI
│   │   ├── sidebarPanel.ts     # 侧边栏面板
│   │   └── configManager.ts    # 配置管理
│   ├── dist/                   # 编译后的文件
│   ├── ai-chat-hitl-extension-1.2.0.vsix  # 可安装的插件包
│   ├── package.json
│   └── tsconfig.json
├── .AichatHITLrules            # AI 对话规则示例
└── README.md
```

## 安装

### 方式一：安装 VSIX 文件

1. 下载 `vscode-extension/ai-chat-hitl-extension-1.4.0.vsix`
2. 在 VSCode/Windsurf/Cursor 中按 `Ctrl+Shift+P`
3. 输入 "Install from VSIX" 并选择下载的文件

### 方式二：从源码构建

```bash
cd vscode-extension
npm install
npm run compile
npm run package
```

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
