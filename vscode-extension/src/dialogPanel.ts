import * as vscode from 'vscode';
import * as path from 'path';
import { PendingDialog, Attachment, DialogHistoryItem } from './mcpServer';

// 持久化的对话状态（用于IDE重启后恢复）
export interface PersistedDialogState {
    id: string;
    reason: string;
    workspace: string;
    dialogCount: number;
    timestamp: number;
}

export class DialogPanel {
    public static currentPanels: Map<string, DialogPanel> = new Map();
    // 存储待处理的对话状态（用于手动打开和恢复）
    public static pendingDialogStates: Map<string, PersistedDialogState> = new Map();
    private readonly panel: vscode.WebviewPanel;
    private readonly extensionUri: vscode.Uri;
    private dialog: PendingDialog;
    private history: DialogHistoryItem[];
    private dialogCount: number;
    private disposables: vscode.Disposable[] = [];
    private onResponse: ((shouldContinue: boolean, userInput: string, attachments?: Attachment[]) => void) | null = null;

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, dialog: PendingDialog, history: DialogHistoryItem[], dialogCount: number) {
        this.panel = panel;
        this.extensionUri = extensionUri;
        this.dialog = dialog;
        this.history = history;
        this.dialogCount = dialogCount;

        this.update();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            (message) => {
                switch (message.command) {
                    case 'continue':
                        if (this.onResponse) {
                            this.onResponse(true, message.userInput, message.attachments);
                        }
                        this.dispose();
                        break;
                    case 'end':
                        if (this.onResponse) {
                            this.onResponse(false, '', []);
                        }
                        this.dispose();
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    public static createOrShow(
        extensionUri: vscode.Uri,
        dialog: PendingDialog,
        onResponse: (shouldContinue: boolean, userInput: string, attachments?: Attachment[]) => void,
        history: DialogHistoryItem[] = [],
        dialogCount: number = 1
    ) {
        // 使用 Beside 让窗口出现在编辑器旁边而不是替换当前标签
        const column = vscode.ViewColumn.Beside;

        // Check if panel already exists for this dialog
        if (DialogPanel.currentPanels.has(dialog.id)) {
            const existingPanel = DialogPanel.currentPanels.get(dialog.id)!;
            existingPanel.panel.reveal(column);
            return existingPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'aiDialog',
            `AI Chat HITL #${dialogCount}`,
            column,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri]
            }
        );

        const dialogPanel = new DialogPanel(panel, extensionUri, dialog, history, dialogCount);
        dialogPanel.onResponse = onResponse;
        DialogPanel.currentPanels.set(dialog.id, dialogPanel);

        return dialogPanel;
    }

    private update() {
        this.panel.webview.html = this.getHtmlForWebview();
    }

    private getHistoryHtml(): string {
        if (this.history.length === 0) {
            return '';
        }

        const historyItems = this.history.map((item, index) => {
            const time = new Date(item.timestamp).toLocaleTimeString();
            const status = item.continued ? '✅ 继续' : '❌ 结束';
            const userQuery = item.userInput ? this.escapeHtml(item.userInput) : '(无输入)';
            return `
                <div class="history-item">
                    <div class="history-header">
                        <span class="history-index">#${index + 1}</span>
                        <span class="history-time">${time}</span>
                        <span class="history-status ${item.continued ? 'continued' : 'ended'}">${status}</span>
                    </div>
                    <div class="history-reason">原因: ${this.escapeHtml(item.reason)}</div>
                    <div class="history-query">用户输入: ${userQuery}</div>
                </div>
            `;
        }).join('');

        return `
            <div class="history-section">
                <div class="history-title" onclick="toggleHistory()">
                    <span>📜 对话历史 (${this.history.length} 次)</span>
                    <span id="historyToggle">▼</span>
                </div>
                <div class="history-list" id="historyList">
                    ${historyItems}
                </div>
            </div>
        `;
    }

    private getHtmlForWebview(): string {
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
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            padding: 20px;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .header {
            margin-bottom: 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .header h1 {
            font-size: 18px;
            font-weight: 600;
            color: var(--vscode-foreground);
        }
        .dialog-count {
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 13px;
            font-weight: 500;
        }
        .history-section {
            margin-bottom: 16px;
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            overflow: hidden;
        }
        .history-title {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 14px;
            background-color: var(--vscode-sideBar-background);
            cursor: pointer;
            font-size: 13px;
            font-weight: 500;
            user-select: none;
        }
        .history-title:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .history-list {
            max-height: 200px;
            overflow-y: auto;
            display: none;
        }
        .history-list.expanded {
            display: block;
        }
        .history-item {
            padding: 10px 14px;
            border-top: 1px solid var(--vscode-input-border);
            font-size: 12px;
        }
        .history-item:hover {
            background-color: var(--vscode-list-hoverBackground);
        }
        .history-header {
            display: flex;
            gap: 10px;
            align-items: center;
            margin-bottom: 6px;
        }
        .history-index {
            font-weight: 600;
            color: var(--vscode-textLink-foreground);
        }
        .history-time {
            color: var(--vscode-descriptionForeground);
        }
        .history-status {
            padding: 2px 6px;
            border-radius: 3px;
            font-size: 11px;
        }
        .history-status.continued {
            background-color: rgba(40, 167, 69, 0.2);
            color: #28a745;
        }
        .history-status.ended {
            background-color: rgba(220, 53, 69, 0.2);
            color: #dc3545;
        }
        .history-reason {
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .history-query {
            color: var(--vscode-foreground);
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .reason-box {
            background-color: var(--vscode-textBlockQuote-background);
            border-left: 3px solid var(--vscode-textLink-foreground);
            padding: 12px 16px;
            border-radius: 4px;
            margin-bottom: 16px;
        }
        .reason-label {
            font-size: 12px;
            color: var(--vscode-descriptionForeground);
            margin-bottom: 4px;
        }
        .reason-text {
            font-size: 14px;
            line-height: 1.5;
        }
        .input-container {
            flex: 1;
            display: flex;
            flex-direction: column;
            margin-bottom: 16px;
        }
        .input-label {
            font-size: 13px;
            font-weight: 500;
            margin-bottom: 8px;
            color: var(--vscode-foreground);
        }
        .input-wrapper {
            flex: 1;
            display: flex;
            flex-direction: column;
            border: 1px solid var(--vscode-input-border);
            border-radius: 6px;
            background-color: var(--vscode-input-background);
            overflow: hidden;
            min-height: 200px;
        }
        .input-wrapper:focus-within {
            border-color: var(--vscode-focusBorder);
            outline: none;
        }
        #userInput {
            flex: 1;
            width: 100%;
            padding: 12px;
            border: none;
            background: transparent;
            color: var(--vscode-input-foreground);
            font-family: var(--vscode-font-family);
            font-size: 14px;
            resize: none;
            outline: none;
            min-height: 120px;
        }
        #userInput::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        .attachments-area {
            border-top: 1px solid var(--vscode-input-border);
            padding: 8px 12px;
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            min-height: 40px;
        }
        .attachment-item {
            display: flex;
            align-items: center;
            gap: 6px;
            padding: 4px 10px;
            background-color: var(--vscode-badge-background);
            color: var(--vscode-badge-foreground);
            border-radius: 4px;
            font-size: 12px;
            max-width: 200px;
        }
        .attachment-item img {
            width: 24px;
            height: 24px;
            object-fit: cover;
            border-radius: 2px;
        }
        .attachment-name {
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .attachment-remove {
            cursor: pointer;
            opacity: 0.7;
            font-size: 14px;
        }
        .attachment-remove:hover {
            opacity: 1;
        }
        .toolbar {
            display: flex;
            gap: 8px;
            padding: 8px 12px;
            border-top: 1px solid var(--vscode-input-border);
            background-color: var(--vscode-toolbar-hoverBackground);
        }
        .toolbar-btn {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 32px;
            height: 32px;
            border: none;
            background: transparent;
            color: var(--vscode-foreground);
            border-radius: 4px;
            cursor: pointer;
            font-size: 16px;
        }
        .toolbar-btn:hover {
            background-color: var(--vscode-toolbar-activeBackground);
        }
        .toolbar-btn svg {
            width: 18px;
            height: 18px;
        }
        .buttons {
            display: flex;
            gap: 12px;
            justify-content: flex-end;
        }
        .btn {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
        }
        .btn-primary {
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .btn-primary:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .btn-secondary {
            background-color: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
        }
        .btn-secondary:hover {
            background-color: var(--vscode-button-secondaryHoverBackground);
        }
        .drop-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 120, 212, 0.1);
            border: 3px dashed var(--vscode-focusBorder);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 1000;
        }
        .drop-overlay.active {
            display: flex;
        }
        .drop-text {
            font-size: 18px;
            color: var(--vscode-foreground);
            background-color: var(--vscode-editor-background);
            padding: 20px 40px;
            border-radius: 8px;
        }
        input[type="file"] {
            display: none;
        }
    </style>
</head>
<body>
    <div class="drop-overlay" id="dropOverlay">
        <div class="drop-text">拖放文件到这里</div>
    </div>

    <div class="header">
        <h1>🤖 AI Chat HITL</h1>
        <span class="dialog-count">第 ${this.dialogCount} 次对话</span>
    </div>

    ${this.getHistoryHtml()}

    <div class="reason-box">
        <div class="reason-label">AI 想要结束对话的原因：</div>
        <div class="reason-text">${this.escapeHtml(this.dialog.reason)}</div>
    </div>

    <div class="input-container">
        <div class="input-label">输入新指令（如果选择继续）：</div>
        <div class="input-wrapper">
            <textarea id="userInput" placeholder="输入您想要 AI 继续执行的任务...&#10;&#10;支持：&#10;• 粘贴图片 (Ctrl+V)&#10;• 拖拽文件&#10;• 拖拽代码"></textarea>
            <div class="attachments-area" id="attachmentsArea"></div>
            <div class="toolbar">
                <button class="toolbar-btn" id="uploadImageBtn" title="上传图片">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                        <circle cx="8.5" cy="8.5" r="1.5"/>
                        <polyline points="21 15 16 10 5 21"/>
                    </svg>
                </button>
                <button class="toolbar-btn" id="uploadFileBtn" title="上传文件">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                        <polyline points="14 2 14 8 20 8"/>
                        <line x1="12" y1="18" x2="12" y2="12"/>
                        <line x1="9" y1="15" x2="15" y2="15"/>
                    </svg>
                </button>
                <button class="toolbar-btn" id="pasteCodeBtn" title="粘贴代码">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="16 18 22 12 16 6"/>
                        <polyline points="8 6 2 12 8 18"/>
                    </svg>
                </button>
            </div>
        </div>
    </div>

    <div class="buttons">
        <button class="btn btn-secondary" id="endBtn">结束对话</button>
        <button class="btn btn-primary" id="continueBtn">继续对话</button>
    </div>

    <input type="file" id="imageInput" accept="image/*" multiple>
    <input type="file" id="fileInput" multiple>

    <script>
        const vscode = acquireVsCodeApi();
        const attachments = [];
        const userInput = document.getElementById('userInput');
        const attachmentsArea = document.getElementById('attachmentsArea');
        const dropOverlay = document.getElementById('dropOverlay');

        // 继续对话
        document.getElementById('continueBtn').addEventListener('click', () => {
            vscode.postMessage({
                command: 'continue',
                userInput: userInput.value || '请继续',
                attachments: attachments
            });
        });

        // 结束对话
        document.getElementById('endBtn').addEventListener('click', () => {
            vscode.postMessage({
                command: 'end'
            });
        });

        // 上传图片按钮
        document.getElementById('uploadImageBtn').addEventListener('click', () => {
            document.getElementById('imageInput').click();
        });

        // 上传文件按钮
        document.getElementById('uploadFileBtn').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });

        // 粘贴代码按钮
        document.getElementById('pasteCodeBtn').addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text) {
                    addAttachment({
                        type: 'code',
                        name: 'pasted_code.txt',
                        content: text
                    });
                }
            } catch (err) {
                console.error('Failed to read clipboard:', err);
            }
        });

        // 处理图片选择
        document.getElementById('imageInput').addEventListener('change', (e) => {
            handleFiles(e.target.files, 'image');
        });

        // 处理文件选择
        document.getElementById('fileInput').addEventListener('change', (e) => {
            handleFiles(e.target.files, 'file');
        });

        // 粘贴事件
        document.addEventListener('paste', (e) => {
            const items = e.clipboardData.items;
            for (let item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) {
                        readFileAsBase64(file, 'image');
                    }
                }
            }
        });

        // 拖拽事件
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropOverlay.classList.add('active');
        });

        document.addEventListener('dragleave', (e) => {
            if (e.target === dropOverlay) {
                dropOverlay.classList.remove('active');
            }
        });

        document.addEventListener('drop', (e) => {
            e.preventDefault();
            dropOverlay.classList.remove('active');

            // 处理拖拽的文本（代码）
            const text = e.dataTransfer.getData('text/plain');
            if (text && !e.dataTransfer.files.length) {
                addAttachment({
                    type: 'code',
                    name: 'dragged_code.txt',
                    content: text
                });
                // 在光标位置插入引用
                insertAtCursor('@dragged_code.txt ');
                return;
            }

            // 处理拖拽的文件
            if (e.dataTransfer.files.length) {
                for (let file of e.dataTransfer.files) {
                    const type = file.type.startsWith('image/') ? 'image' : 'file';
                    readFileAsBase64(file, type);
                    // 在光标位置插入文件引用
                    insertAtCursor('@' + file.name + ' ');
                }
            }
        });

        // 在光标位置插入文本
        function insertAtCursor(text) {
            const start = userInput.selectionStart;
            const end = userInput.selectionEnd;
            const value = userInput.value;
            userInput.value = value.substring(0, start) + text + value.substring(end);
            // 移动光标到插入文本之后
            userInput.selectionStart = userInput.selectionEnd = start + text.length;
            userInput.focus();
        }

        function handleFiles(files, type) {
            for (let file of files) {
                readFileAsBase64(file, type);
            }
        }

        function readFileAsBase64(file, type) {
            const reader = new FileReader();
            reader.onload = () => {
                addAttachment({
                    type: type,
                    name: file.name,
                    content: reader.result,
                    mimeType: file.type
                });
            };
            if (type === 'image') {
                reader.readAsDataURL(file);
            } else {
                reader.readAsText(file);
            }
        }

        function addAttachment(attachment) {
            attachments.push(attachment);
            renderAttachments();
        }

        function removeAttachment(index) {
            attachments.splice(index, 1);
            renderAttachments();
        }

        function renderAttachments() {
            attachmentsArea.innerHTML = '';
            attachments.forEach((att, index) => {
                const item = document.createElement('div');
                item.className = 'attachment-item';
                
                if (att.type === 'image' && att.content.startsWith('data:')) {
                    const img = document.createElement('img');
                    img.src = att.content;
                    item.appendChild(img);
                }
                
                const name = document.createElement('span');
                name.className = 'attachment-name';
                // 显示为 @文件名 格式
                name.textContent = '@' + att.name;
                item.appendChild(name);
                
                const remove = document.createElement('span');
                remove.className = 'attachment-remove';
                remove.textContent = '×';
                remove.onclick = () => removeAttachment(index);
                item.appendChild(remove);
                
                attachmentsArea.appendChild(item);
            });
        }

        // 快捷键: Enter继续对话, Shift+Enter换行
        userInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    // Shift+Enter: 换行（默认行为）
                    return;
                } else {
                    // Enter: 继续对话
                    e.preventDefault();
                    document.getElementById('continueBtn').click();
                }
            }
        });

        // 自动聚焦
        userInput.focus();

        // 历史记录展开/折叠
        function toggleHistory() {
            const historyList = document.getElementById('historyList');
            const historyToggle = document.getElementById('historyToggle');
            if (historyList && historyToggle) {
                historyList.classList.toggle('expanded');
                historyToggle.textContent = historyList.classList.contains('expanded') ? '▲' : '▼';
            }
        }
        window.toggleHistory = toggleHistory;
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

    public dispose() {
        DialogPanel.currentPanels.delete(this.dialog.id);
        DialogPanel.pendingDialogStates.delete(this.dialog.id);
        this.panel.dispose();
        while (this.disposables.length) {
            const disposable = this.disposables.pop();
            if (disposable) {
                disposable.dispose();
            }
        }
    }

    // 获取当前工作区的对话面板
    public static getPanelForWorkspace(workspace: string): DialogPanel | undefined {
        for (const [id, panel] of DialogPanel.currentPanels) {
            if (panel.dialog.workspace.toLowerCase().replace(/\\/g, '/') === 
                workspace.toLowerCase().replace(/\\/g, '/')) {
                return panel;
            }
        }
        return undefined;
    }

    // 获取当前工作区的待处理对话状态
    public static getPendingStateForWorkspace(workspace: string): PersistedDialogState | undefined {
        for (const [id, state] of DialogPanel.pendingDialogStates) {
            if (state.workspace.toLowerCase().replace(/\\/g, '/') === 
                workspace.toLowerCase().replace(/\\/g, '/')) {
                return state;
            }
        }
        return undefined;
    }

    // 保存对话状态（用于持久化）
    public static savePendingState(dialog: PendingDialog, dialogCount: number) {
        const state: PersistedDialogState = {
            id: dialog.id,
            reason: dialog.reason,
            workspace: dialog.workspace,
            dialogCount,
            timestamp: Date.now()
        };
        DialogPanel.pendingDialogStates.set(dialog.id, state);
    }

    // 获取所有待处理的对话状态（用于持久化存储）
    public static getAllPendingStates(): PersistedDialogState[] {
        return Array.from(DialogPanel.pendingDialogStates.values());
    }

    // 恢复对话状态
    public static restorePendingStates(states: PersistedDialogState[]) {
        for (const state of states) {
            DialogPanel.pendingDialogStates.set(state.id, state);
        }
    }
}
