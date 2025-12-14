import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const AICHATHITLRULES_CONTENT = `# AI Chat HITL - AI对话人工介入规则

⚠️⚠️⚠️ 最高优先级警告 ⚠️⚠️⚠️
无论任何情况，每次回复结束前必须调用 AI_chat_HITL 工具！没有任何例外！

## 核心规则

1. **完整输出** - 输出完整代码和答案，禁止使用省略号或“代码过长不展示”

2. **持续执行** - 复杂任务尽量一次性完成，不要频繁中断或反复追问是否继续

3. **结束确认** - 当你想结束对话或任务时，必须先调用 AI_chat_HITL 工具询问用户是否继续

4. **严格遵守用户选择** - 当用户选择“结束对话”（返回 should_continue=False）时，必须立即停止所有操作

## 调用 AI_chat_HITL 工具时

⚠️ **必须同时传递 reason 和 workspace 两个参数**，缺一不可！

\`\`\`json
{
  "reason": "任务完成原因",
  "workspace": "当前工作区的绝对路径"
}
\`\`\`

- **reason**: AI想要结束对话的原因
- **workspace**: 当前工作区的根目录绝对路径，用于确保对话框在正确的IDE窗口中打开。若不传递此参数，对话框可能在错误的窗口中弹出！
`;

export class ConfigManager {
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async generateGlobalRules(): Promise<void> {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            vscode.window.showErrorMessage('请先打开一个工作区');
            return;
        }

        const targetFolder = await vscode.window.showQuickPick(
            workspaceFolders.map(f => ({
                label: f.name,
                description: f.uri.fsPath,
                folder: f
            })),
            {
                placeHolder: '选择要生成规则文件的工作区'
            }
        );

        if (!targetFolder) {
            return;
        }

        const rulesPath = path.join(targetFolder.folder.uri.fsPath, '.AichatHITLrules');

        try {
            if (fs.existsSync(rulesPath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    '.AichatHITLrules 文件已存在，是否覆盖？',
                    '覆盖',
                    '取消'
                );
                if (overwrite !== '覆盖') {
                    return;
                }
            }

            fs.writeFileSync(rulesPath, AICHATHITLRULES_CONTENT, 'utf-8');
            vscode.window.showInformationMessage(`已生成规则文件: ${rulesPath}`);

            // 打开文件
            const doc = await vscode.workspace.openTextDocument(rulesPath);
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(`生成规则文件失败: ${error}`);
        }
    }

    async configureMCP(): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-chat-hitl');
        const port = config.get<number>('serverPort', 23987);

        // 检测 IDE 类型
        const ideType = await this.detectIDE();
        const configPath = this.getMCPConfigPath(ideType);

        // 使用 SSE 方式配置 MCP
        const aiDialogConfig = {
            serverUrl: `http://localhost:${port}/sse`,
            disabled: false
        };

        // 询问用户是否自动配置
        const choice = await vscode.window.showQuickPick([
            { label: '$(gear) 自动配置', description: '自动写入 MCP 配置文件（推荐）', value: 'auto' },
            { label: '$(copy) 手动配置', description: '显示配置内容，手动复制', value: 'manual' }
        ], {
            placeHolder: '选择配置方式'
        });

        if (!choice) {
            return;
        }

        if (choice.value === 'auto') {
            await this.autoConfigureMCP(configPath, aiDialogConfig, ideType);
        } else {
            this.showManualConfigPanel(aiDialogConfig, ideType, port, configPath);
        }
    }

    private async autoConfigureMCP(configPath: string, aiDialogConfig: any, ideType: string): Promise<void> {
        try {
            // 确保目录存在
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            // 读取现有配置或创建新配置
            let existingConfig: any = { mcpServers: {} };
            if (fs.existsSync(configPath)) {
                try {
                    const content = fs.readFileSync(configPath, 'utf-8');
                    existingConfig = JSON.parse(content);
                    if (!existingConfig.mcpServers) {
                        existingConfig.mcpServers = {};
                    }
                } catch (e) {
                    // 如果解析失败，备份原文件
                    const backupPath = configPath + '.backup';
                    fs.copyFileSync(configPath, backupPath);
                    vscode.window.showWarningMessage(`原配置文件解析失败，已备份到 ${backupPath}`);
                    existingConfig = { mcpServers: {} };
                }
            }

            // 添加或更新 AI_dialog 配置
            existingConfig.mcpServers.AI_chat_HITL = aiDialogConfig;

            // 写入配置文件
            fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), 'utf-8');

            const result = await vscode.window.showInformationMessage(
                `MCP 配置已自动写入: ${configPath}\n\n需要重启 ${ideType.charAt(0).toUpperCase() + ideType.slice(1)} 使配置生效。`,
                '立即重启',
                '稍后重启'
            );

            if (result === '立即重启') {
                // 执行重启命令
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`自动配置失败: ${error}`);
            // 失败时显示手动配置面板
            const config = vscode.workspace.getConfiguration('ai-chat-hitl');
            const port = config.get<number>('serverPort', 23987);
            this.showManualConfigPanel(aiDialogConfig, ideType, port, configPath);
        }
    }

    private getMCPConfigPath(ideType: string): string {
        const configPaths: Record<string, string> = {
            windsurf: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
            cursor: path.join(os.homedir(), '.cursor', 'mcp.json'),
            vscode: path.join(os.homedir(), '.vscode', 'mcp.json')
        };
        return configPaths[ideType] || configPaths.vscode;
    }

    private showManualConfigPanel(aiDialogConfig: any, ideType: string, port: number, configPath: string): void {
        // 手动配置也使用 SSE 方式
        const mcpConfig = {
            mcpServers: {
                AI_chat_HITL: {
                    serverUrl: `http://localhost:${port}/sse`,
                    disabled: false
                }
            }
        };
        const configJson = JSON.stringify(mcpConfig, null, 2);

        const panel = vscode.window.createWebviewPanel(
            'mcpConfig',
            'MCP 配置',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = this.getMCPConfigHtml(configJson, ideType, port, configPath);
    }

    private async detectIDE(): Promise<string> {
        const appName = vscode.env.appName.toLowerCase();
        if (appName.includes('windsurf')) {
            return 'windsurf';
        } else if (appName.includes('cursor')) {
            return 'cursor';
        }
        return 'vscode';
    }

    private getMCPServerPath(): string {
        return path.join(this.context.extensionPath, 'dist', 'mcpServerStandalone.js');
    }

    private getMCPConfigHtml(configJson: string, ideType: string, port: number, configPath: string): string {
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MCP 配置</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
            line-height: 1.6;
        }
        h1 { font-size: 20px; margin-bottom: 16px; }
        h2 { font-size: 16px; margin-top: 20px; margin-bottom: 12px; }
        .info-box {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
            padding: 12px 16px;
            border-radius: 4px;
            margin-bottom: 16px;
        }
        .code-block {
            background-color: var(--vscode-textCodeBlock-background);
            padding: 16px;
            border-radius: 6px;
            overflow-x: auto;
            font-family: var(--vscode-editor-font-family);
            font-size: 13px;
            white-space: pre;
            margin-bottom: 16px;
        }
        .path {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 8px;
            border-radius: 4px;
            font-family: var(--vscode-editor-font-family);
        }
        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            cursor: pointer;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            margin-right: 8px;
        }
        .btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .success {
            color: var(--vscode-testing-iconPassed);
        }
    </style>
</head>
<body>
    <h1>🔧 MCP Server 配置</h1>

    <div class="info-box">
        <strong>检测到的 IDE:</strong> ${ideType.charAt(0).toUpperCase() + ideType.slice(1)}<br>
        <strong>当前端口:</strong> ${port}
    </div>

    <h2>配置文件路径</h2>
    <p>将以下配置添加到: <span class="path">${configPath}</span></p>

    <h2>MCP 配置内容</h2>
    <div class="code-block" id="configCode">${this.escapeHtml(configJson)}</div>

    <button class="btn" onclick="copyConfig()">复制配置</button>
    <span id="copyStatus"></span>

    <h2>使用说明</h2>
    <ol>
        <li>复制上面的配置内容</li>
        <li>打开配置文件 <span class="path">${configPath}</span></li>
        <li>如果文件已存在，将 AI_chat_HITL 部分合并到现有的 mcpServers 中</li>
        <li>如果文件不存在，直接粘贴整个配置</li>
        <li>重启 IDE 使配置生效</li>
    </ol>

    <script>
        function copyConfig() {
            const config = document.getElementById('configCode').textContent;
            navigator.clipboard.writeText(config).then(() => {
                document.getElementById('copyStatus').innerHTML = '<span class="success">✓ 已复制</span>';
                setTimeout(() => {
                    document.getElementById('copyStatus').innerHTML = '';
                }, 2000);
            });
        }
    </script>
</body>
</html>`;
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    async changePort(): Promise<{ newPort: number; shouldUpdateMCP: boolean } | null> {
        const config = vscode.workspace.getConfiguration('ai-chat-hitl');
        const currentPort = config.get<number>('serverPort', 23987);

        const newPortStr = await vscode.window.showInputBox({
            prompt: '输入新的 MCP Server 端口',
            value: currentPort.toString(),
            validateInput: (value) => {
                const port = parseInt(value);
                if (isNaN(port) || port < 1024 || port > 65535) {
                    return '端口必须是 1024-65535 之间的数字';
                }
                return null;
            }
        });

        if (newPortStr) {
            const newPort = parseInt(newPortStr);
            await config.update('serverPort', newPort, vscode.ConfigurationTarget.Global);
            
            // 询问是否同时更新 MCP 配置
            const updateMCP = await vscode.window.showQuickPick([
                { label: '$(check) 是，同时更新 MCP 配置', description: '自动更新 MCP 配置文件中的端口', value: true },
                { label: '$(x) 否，仅更改插件端口', description: '需要手动更新 MCP 配置', value: false }
            ], {
                placeHolder: '是否同时更新 MCP 配置文件？'
            });

            if (updateMCP?.value) {
                await this.updateMCPConfigPort(newPort);
            }

            return { newPort, shouldUpdateMCP: updateMCP?.value || false };
        }
        return null;
    }

    // 更新 MCP 配置文件中的端口
    async updateMCPConfigPort(port: number): Promise<boolean> {
        const ideType = await this.detectIDE();
        const configPath = this.getMCPConfigPath(ideType);

        try {
            // 读取现有配置
            let existingConfig: any = { mcpServers: {} };
            if (fs.existsSync(configPath)) {
                try {
                    const content = fs.readFileSync(configPath, 'utf-8');
                    existingConfig = JSON.parse(content);
                    if (!existingConfig.mcpServers) {
                        existingConfig.mcpServers = {};
                    }
                } catch (e) {
                    // 解析失败，使用空配置
                    existingConfig = { mcpServers: {} };
                }
            }

            // 更新 AI_chat_HITL 配置为 SSE 模式
            existingConfig.mcpServers.AI_chat_HITL = {
                serverUrl: `http://localhost:${port}/sse`,
                disabled: false
            };

            // 确保目录存在
            const configDir = path.dirname(configPath);
            if (!fs.existsSync(configDir)) {
                fs.mkdirSync(configDir, { recursive: true });
            }

            // 写入配置文件
            fs.writeFileSync(configPath, JSON.stringify(existingConfig, null, 2), 'utf-8');

            vscode.window.showInformationMessage(
                `✅ 端口已更改为 ${port}，MCP 配置已更新！\n需要重启 ${ideType.charAt(0).toUpperCase() + ideType.slice(1)} 使 MCP 配置生效。`
            );

            return true;
        } catch (error) {
            vscode.window.showErrorMessage(`更新 MCP 配置失败: ${error}`);
            return false;
        }
    }

    // 一键配置：设置端口并更新 MCP 配置
    async quickSetup(port?: number): Promise<void> {
        const config = vscode.workspace.getConfiguration('ai-chat-hitl');
        const currentPort = port || config.get<number>('serverPort', 23987);

        const ideType = await this.detectIDE();
        const configPath = this.getMCPConfigPath(ideType);

        // 获取工作区路径用于规则文件
        const workspaceFolders = vscode.workspace.workspaceFolders;
        let rulesPath = '';
        if (workspaceFolders && workspaceFolders.length > 0) {
            rulesPath = path.join(workspaceFolders[0].uri.fsPath, '.AichatHITLrules');
        }

        try {
            // 更新 MCP 配置
            await this.updateMCPConfigPort(currentPort);

            const result = await vscode.window.showInformationMessage(
                `✅ ${ideType.charAt(0).toUpperCase() + ideType.slice(1)} 配置完成！\n` +
                `规则文件: ${rulesPath || '(请先打开工作区)'}\n` +
                `MCP配置: ${configPath}\n` +
                `服务端口: ${currentPort}`,
                '立即重启',
                '稍后重启'
            );

            if (result === '立即重启') {
                vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`配置失败: ${error}`);
        }
    }
}
