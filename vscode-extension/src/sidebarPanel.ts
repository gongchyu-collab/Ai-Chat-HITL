import * as vscode from 'vscode';
import { DialogHistoryItem } from './mcpServer';

export class SidebarPanel implements vscode.WebviewViewProvider {
    public static readonly viewType = 'ai-chat-hitl.sidebarView';
    private _view?: vscode.WebviewView;
    private _extensionUri: vscode.Uri;
    private _version: string;
    private _port: number = 23987;
    private _history: DialogHistoryItem[] = [];
    private _dialogCount: number = 0;

    constructor(extensionUri: vscode.Uri, version: string) {
        this._extensionUri = extensionUri;
        this._version = version;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.command) {
                case 'generateRules':
                    vscode.commands.executeCommand('ai-chat-hitl.generateRules');
                    break;
                case 'configureMCP':
                    vscode.commands.executeCommand('ai-chat-hitl.configureMCP');
                    break;
                case 'changePort':
                    vscode.commands.executeCommand('ai-chat-hitl.changePort');
                    break;
                case 'restartServer':
                    vscode.commands.executeCommand('ai-chat-hitl.restartServer');
                    break;
                case 'stopServer':
                    vscode.commands.executeCommand('ai-chat-hitl.stopServer');
                    break;
                case 'clearHistory':
                    this._history = [];
                    this._dialogCount = 0;
                    this.updateView();
                    break;
                case 'openDialog':
                    vscode.commands.executeCommand('ai-chat-hitl.openDialog');
                    break;
                case 'showPendingDialogs':
                    vscode.commands.executeCommand('ai-chat-hitl.showPendingDialogs');
                    break;
            }
        });
    }

    public updateStatus(port: number, history: DialogHistoryItem[], dialogCount: number) {
        this._port = port;
        this._history = history;
        this._dialogCount = dialogCount;
        this.updateView();
    }

    public updatePort(port: number) {
        this._port = port;
        this.updateView();
    }

    private updateView() {
        if (this._view) {
            this._view.webview.html = this._getHtmlForWebview();
        }
    }

    private _getHtmlForWebview(): string {
        const historyHtml = this._history.length > 0 
            ? this._history.map((item, index) => {
                const time = new Date(item.timestamp).toLocaleTimeString();
                const status = item.continued ? '✅' : '❌';
                const userQuery = item.userInput ? this._escapeHtml(item.userInput).substring(0, 50) : '(无输入)';
                return `
                    <div class="history-item">
                        <div class="history-header">
                            <span class="history-index">#${index + 1}</span>
                            <span class="history-time">${time}</span>
                            <span class="history-status">${status}</span>
                        </div>
                        <div class="history-query" title="${this._escapeHtml(item.userInput || '')}">${userQuery}${item.userInput && item.userInput.length > 50 ? '...' : ''}</div>
                    </div>
                `;
            }).join('')
            : '<div class="empty-state">暂无对话历史</div>';

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AI Chat HITL</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: var(--vscode-font-family);
            background-color: var(--vscode-sideBar-background);
            color: var(--vscode-sideBar-foreground);
            padding: 12px;
            font-size: 13px;
        }
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 16px;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--vscode-sideBar-border);
        }
        .logo {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .logo-icon {
            font-size: 20px;
        }
        .logo-text {
            font-weight: 600;
            font-size: 14px;
        }
        .version {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 2px 6px;
            border-radius: 10px;
        }
        .status-section {
            margin-bottom: 16px;
        }
        .status-title {
            font-size: 11px;
            text-transform: uppercase;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 8px;
            font-weight: 600;
        }
        .status-card {
            background-color: var(--vscode-editor-background);
            border-radius: 6px;
            padding: 12px;
        }
        .status-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .status-row:last-child {
            margin-bottom: 0;
        }
        .status-label {
            color: var(--vscode-descriptionForeground);
        }
        .status-value {
            font-weight: 500;
        }
        .status-value.active {
            color: var(--vscode-testing-iconPassed);
        }
        .actions-section {
            margin-bottom: 16px;
        }
        .action-btn {
            width: 100%;
            padding: 8px 12px;
            margin-bottom: 8px;
            border: none;
            border-radius: 4px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            font-size: 12px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 8px;
            transition: background-color 0.2s;
        }
        .action-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .action-btn.primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .action-btn.primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .action-btn:last-child {
            margin-bottom: 0;
        }
        .action-icon {
            font-size: 14px;
        }
        .history-section {
            margin-bottom: 16px;
        }
        .history-header-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        .history-list {
            background-color: var(--vscode-editor-background);
            border-radius: 6px;
            max-height: 300px;
            overflow-y: auto;
        }
        .history-item {
            padding: 10px 12px;
            border-bottom: 1px solid var(--vscode-sideBar-border);
        }
        .history-item:last-child {
            border-bottom: none;
        }
        .history-item .history-header {
            display: flex;
            gap: 8px;
            align-items: center;
            margin-bottom: 4px;
        }
        .history-index {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
            font-size: 11px;
        }
        .history-time {
            color: var(--vscode-descriptionForeground);
            font-size: 11px;
        }
        .history-status {
            font-size: 11px;
        }
        .history-query {
            font-size: 12px;
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .empty-state {
            padding: 20px;
            text-align: center;
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
        }
        .clear-btn {
            font-size: 11px;
            color: var(--vscode-textLink-foreground);
            background: none;
            border: none;
            cursor: pointer;
            padding: 2px 6px;
        }
        .clear-btn:hover {
            text-decoration: underline;
        }
        .quick-copy-section {
            margin-bottom: 16px;
        }
        .copy-card {
            background-color: var(--vscode-editor-background);
            border-radius: 6px;
            padding: 10px 12px;
            position: relative;
        }
        .copy-text {
            font-size: 12px;
            color: var(--vscode-foreground);
            margin-bottom: 8px;
            line-height: 1.4;
            word-break: break-all;
        }
        .copy-btn {
            width: 100%;
            padding: 6px 10px;
            border: none;
            border-radius: 4px;
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            font-size: 11px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }
        .copy-btn:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .copy-success {
            color: var(--vscode-testing-iconPassed);
            font-size: 11px;
            text-align: center;
            margin-top: 6px;
            display: none;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="logo">
            <span class="logo-icon">🤖</span>
            <span class="logo-text">AI Chat HITL</span>
        </div>
        <span class="version">v${this._version}</span>
    </div>

    <div class="status-section">
        <div class="status-title">状态</div>
        <div class="status-card">
            <div class="status-row">
                <span class="status-label">服务端口</span>
                <span class="status-value">${this._port}</span>
            </div>
            <div class="status-row">
                <span class="status-label">服务状态</span>
                <span class="status-value active">● 运行中</span>
            </div>
            <div class="status-row">
                <span class="status-label">对话次数</span>
                <span class="status-value">${this._dialogCount}</span>
            </div>
        </div>
    </div>

    <div class="actions-section">
        <div class="status-title">操作</div>
        <button class="action-btn primary" onclick="send('configureMCP')">
            <span class="action-icon">⚙️</span>
            配置 MCP
        </button>
        <button class="action-btn" onclick="send('generateRules')">
            <span class="action-icon">📝</span>
            生成规则文件
        </button>
        <button class="action-btn" onclick="send('changePort')">
            <span class="action-icon">🔌</span>
            修改端口
        </button>
        <button class="action-btn" onclick="send('restartServer')">
            <span class="action-icon">🔄</span>
            重启服务
        </button>
        <button class="action-btn" onclick="send('stopServer')" style="background-color: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground);">
            <span class="action-icon">⏹️</span>
            停止服务
        </button>
    </div>

    <div class="actions-section">
        <div class="status-title">对话管理</div>
        <button class="action-btn primary" onclick="send('openDialog')">
            <span class="action-icon">💬</span>
            打开当前工作区对话
        </button>
        <button class="action-btn" onclick="send('showPendingDialogs')">
            <span class="action-icon">📋</span>
            显示所有待处理对话
        </button>
    </div>

    <div class="quick-copy-section">
        <div class="status-title">快速测试</div>
        <div class="copy-card">
            <div class="copy-text">学习根目录的.AichatHITLrules规则，然后测试规则</div>
            <button class="copy-btn" onclick="copyTestText()">
                <span>📋</span>
                复制测试语句
            </button>
            <div class="copy-success" id="copySuccess">✓ 已复制到剪贴板</div>
        </div>
    </div>

    <div class="history-section">
        <div class="history-header-row">
            <div class="status-title">对话历史</div>
            ${this._history.length > 0 ? '<button class="clear-btn" onclick="send(\'clearHistory\')">清空</button>' : ''}
        </div>
        <div class="history-list">
            ${historyHtml}
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        function send(command) {
            vscode.postMessage({ command });
        }
        function copyTestText() {
            const text = '学习根目录的.AichatHITLrules规则，然后测试规则';
            navigator.clipboard.writeText(text).then(() => {
                const successEl = document.getElementById('copySuccess');
                if (successEl) {
                    successEl.style.display = 'block';
                    setTimeout(() => {
                        successEl.style.display = 'none';
                    }, 2000);
                }
            });
        }
    </script>
</body>
</html>`;
    }

    private _escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }
}
