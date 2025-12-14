import * as http from 'http';
import * as vscode from 'vscode';

interface SSEClient {
    id: string;
    res: http.ServerResponse;
}

export interface PendingDialog {
    id: string;
    reason: string;
    workspace: string;
    resolve: (value: { shouldContinue: boolean; userInput: string; attachments?: Attachment[] }) => void;
}

export interface Attachment {
    type: 'image' | 'file' | 'code';
    name: string;
    content: string; // base64 for images, text for files/code
    mimeType?: string;
}

export interface DialogHistoryItem {
    timestamp: number;
    reason: string;
    userInput: string;
    continued: boolean;
}

export class MCPServer {
    private server: http.Server | null = null;
    private pendingDialogs = new Map<string, PendingDialog>();
    private port: number;
    private onDialogRequest: ((dialog: PendingDialog, history: DialogHistoryItem[], dialogCount: number) => void) | null = null;
    private dialogHistory: Map<string, DialogHistoryItem[]> = new Map(); // workspace -> history
    private dialogCounts: Map<string, number> = new Map(); // workspace -> count
    private sseClients: Map<string, SSEClient> = new Map();
    private version: string = '1.5.0';

    constructor(port: number = 23987) {
        this.port = port;
    }

    setVersion(version: string) {
        this.version = version;
    }

    setDialogRequestHandler(handler: (dialog: PendingDialog, history: DialogHistoryItem[], dialogCount: number) => void) {
        this.onDialogRequest = handler;
    }

    getPort(): number {
        return this.port;
    }

    setPort(port: number) {
        if (this.server) {
            this.stop();
            this.port = port;
            this.start();
        } else {
            this.port = port;
        }
    }

    start(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.on('error', (err: NodeJS.ErrnoException) => {
                if (err.code === 'EADDRINUSE') {
                    vscode.window.showErrorMessage(`Port ${this.port} is already in use. Please change the port in settings.`);
                }
                reject(err);
            });

            this.server.listen(this.port, '127.0.0.1', () => {
                console.log(`MCP Server listening on port ${this.port}`);
                resolve();
            });
        });
    }

    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
        }
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }

        if (req.method === 'GET' && req.url === '/pending') {
            const pending = Array.from(this.pendingDialogs.entries()).map(([id, data]) => ({
                id,
                reason: data.reason,
                workspace: data.workspace,
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(pending));
            return;
        }

        if (req.method === 'POST' && req.url === '/dialog') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    const { reason, workspace } = JSON.parse(body);
                    const dialogId = `dialog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

                    // 增加对话计数
                    const currentCount = (this.dialogCounts.get(workspace) || 0) + 1;
                    this.dialogCounts.set(workspace, currentCount);

                    // 获取历史记录
                    const history = this.dialogHistory.get(workspace) || [];

                    const dialogPromise = new Promise<{ shouldContinue: boolean; userInput: string; attachments?: Attachment[] }>((resolve) => {
                        const dialog: PendingDialog = {
                            id: dialogId,
                            reason,
                            workspace,
                            resolve
                        };
                        this.pendingDialogs.set(dialogId, dialog);

                        if (this.onDialogRequest) {
                            this.onDialogRequest(dialog, history, currentCount);
                        }
                    });

                    dialogPromise.then((result) => {
                        // 保存到历史记录
                        const historyItem: DialogHistoryItem = {
                            timestamp: Date.now(),
                            reason,
                            userInput: result.userInput,
                            continued: result.shouldContinue
                        };
                        const updatedHistory = [...history, historyItem];
                        this.dialogHistory.set(workspace, updatedHistory);

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(result));
                    });
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid request' }));
                }
            });
            return;
        }

        // CORS preflight for /respond
        if (req.method === 'OPTIONS' && req.url === '/respond') {
            res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            });
            res.end();
            return;
        }

        if (req.method === 'POST' && req.url === '/respond') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    // 支持 id 或 dialogId 参数
                    const dialogId = data.id || data.dialogId;
                    const { shouldContinue, userInput, attachments } = data;
                    
                    const pending = this.pendingDialogs.get(dialogId);
                    if (pending) {
                        pending.resolve({ shouldContinue, userInput, attachments });
                        this.pendingDialogs.delete(dialogId);
                        res.writeHead(200, { 
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        });
                        res.end(JSON.stringify({ success: true }));
                    } else {
                        res.writeHead(404, { 
                            'Content-Type': 'application/json',
                            'Access-Control-Allow-Origin': '*'
                        });
                        res.end(JSON.stringify({ error: 'Dialog not found' }));
                    }
                } catch (error) {
                    res.writeHead(400, { 
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ error: 'Invalid request' }));
                }
            });
            return;
        }

        // Health check endpoint
        if (req.method === 'GET' && req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
                status: 'ok', 
                version: this.version,
                port: this.port,
                sseClients: this.sseClients.size,
                pendingDialogs: this.pendingDialogs.size
            }));
            return;
        }

        // Pending dialogs endpoint - 让其他窗口获取待处理的对话
        if (req.method === 'GET' && req.url?.startsWith('/pending')) {
            const url = new URL(req.url, `http://localhost:${this.port}`);
            const workspace = url.searchParams.get('workspace');
            
            const pendingList = Array.from(this.pendingDialogs.values()).map(d => ({
                id: d.id,
                reason: d.reason,
                workspace: d.workspace
            }));
            
            // 如果指定了工作区，只返回匹配的
            const filtered = workspace 
                ? pendingList.filter(d => {
                    const dPath = d.workspace.toLowerCase().replace(/\\/g, '/');
                    const wPath = workspace.toLowerCase().replace(/\\/g, '/');
                    return dPath === wPath || dPath.startsWith(wPath + '/') || wPath.startsWith(dPath + '/');
                })
                : pendingList;
            
            res.writeHead(200, { 
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify({ dialogs: filtered }));
            return;
        }

        // 浏览器对话界面 - 独立窗口
        if (req.method === 'GET' && req.url?.startsWith('/dialog/')) {
            const dialogId = req.url.replace('/dialog/', '').split('?')[0];
            const pending = this.pendingDialogs.get(dialogId);
            
            if (!pending) {
                res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<html><body><h1>对话不存在或已处理</h1></body></html>');
                return;
            }
            
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getDialogHtml(pending, dialogId));
            return;
        }

        // 对话管理界面 - 浏览器独立窗口
        if (req.method === 'GET' && req.url?.startsWith('/manage')) {
            const url = new URL(req.url, `http://localhost:${this.port}`);
            const workspace = url.searchParams.get('workspace') || '';
            
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(this.getManageHtml(workspace));
            return;
        }

        // Streamable HTTP: POST to /sse (new protocol 2025+)
        if (req.method === 'POST' && (req.url === '/sse' || req.url?.startsWith('/sse?'))) {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                try {
                    const request = JSON.parse(body);
                    const response = await this.handleMCPRequest(request);
                    
                    if (response) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(response));
                    } else {
                        res.writeHead(202);
                        res.end();
                    }
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        error: { code: -32700, message: 'Parse error' }
                    }));
                }
            });
            return;
        }

        // SSE endpoint for MCP (2024-11-05 protocol)
        if (req.method === 'GET' && (req.url === '/sse' || req.url?.startsWith('/sse?'))) {
            const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            
            // Set SSE headers
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Access-Control-Allow-Origin': '*'
            });

            // Send endpoint event per MCP 2024-11-05 spec
            // The endpoint tells the client where to POST messages
            // Use full URL as some clients expect it
            const messageEndpoint = `http://127.0.0.1:${this.port}/messages`;
            
            // Write endpoint event and flush immediately
            res.write(`event: endpoint\ndata: ${messageEndpoint}\n\n`);
            
            // Force flush by writing a comment
            res.write(`: connected\n\n`);

            const client: SSEClient = { id: clientId, res };
            this.sseClients.set(clientId, client);

            console.log(`SSE client connected: ${clientId}, POST endpoint: ${messageEndpoint}`);

            // Handle client disconnect
            req.on('close', () => {
                this.sseClients.delete(clientId);
                console.log(`SSE client disconnected: ${clientId}`);
            });

            // Keep connection alive with periodic pings
            const pingInterval = setInterval(() => {
                if (this.sseClients.has(clientId)) {
                    res.write(`: ping\n\n`);
                } else {
                    clearInterval(pingInterval);
                }
            }, 30000);

            return;
        }

        // MCP JSON-RPC message endpoint (supports both /message and /messages)
        if (req.method === 'POST' && (req.url === '/message' || req.url === '/messages' || req.url?.startsWith('/message') || req.url === '/mcp')) {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk.toString();
            });
            req.on('end', async () => {
                try {
                    const request = JSON.parse(body);
                    const response = await this.handleMCPRequest(request);
                    
                    if (response) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(response));
                        
                        // Also send response via SSE to all connected clients
                        this.broadcastSSE(response);
                    } else {
                        // Notification, no response body
                        res.writeHead(204);
                        res.end();
                    }
                } catch (error) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        jsonrpc: '2.0',
                        error: {
                            code: -32700,
                            message: 'Parse error'
                        }
                    }));
                }
            });
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    }

    // Handle MCP JSON-RPC requests
    private async handleMCPRequest(request: any): Promise<any> {
        switch (request.method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: {
                            tools: {}
                        },
                        serverInfo: {
                            name: 'AI_chat_HITL',
                            version: this.version
                        }
                    }
                };

            case 'initialized':
                return null;

            case 'tools/list':
                return {
                    jsonrpc: '2.0',
                    id: request.id,
                    result: {
                        tools: [
                            {
                                name: 'AI_chat_HITL',
                                description: '当AI想要结束对话时必须调用此工具询问用户是否继续。Call this tool when AI wants to end conversation to ask user whether to continue.',
                                inputSchema: {
                                    type: 'object',
                                    properties: {
                                        reason: {
                                            type: 'string',
                                            description: 'AI想要结束对话的原因 / Reason why AI wants to end the conversation'
                                        },
                                        workspace: {
                                            type: 'string',
                                            description: '当前工作区的绝对路径 / Absolute path of current workspace'
                                        }
                                    },
                                    required: ['reason', 'workspace']
                                }
                            }
                        ]
                    }
                };

            case 'tools/call':
                if (request.params?.name === 'AI_chat_HITL') {
                    const { reason, workspace } = request.params.arguments || {};
                    
                    try {
                        const response = await this.callDialogInternal(reason || '', workspace || '');
                        
                        let resultText: string;
                        if (response.shouldContinue) {
                            resultText = `用户选择继续，并提供了新指令:\n${response.userInput}\n\n请立即执行用户的新指令。`;
                            
                            if (response.attachments && response.attachments.length > 0) {
                                resultText += '\n\n附件信息:\n';
                                for (const att of response.attachments) {
                                    if (att.type === 'image') {
                                        // 传递图片的 base64 内容，AI 可以读取
                                        if (att.content && att.content.startsWith('data:')) {
                                            resultText += `- [图片] ${att.name}\n图片数据(base64): ${att.content}\n`;
                                        } else {
                                            resultText += `- [图片] ${att.name}\n`;
                                        }
                                    } else if (att.type === 'file') {
                                        resultText += `- [文件] ${att.name}\n内容:\n${att.content}\n`;
                                    } else if (att.type === 'code') {
                                        resultText += `- [代码] ${att.name}\n\`\`\`\n${att.content}\n\`\`\`\n`;
                                    }
                                }
                            }
                        } else {
                            resultText = '用户选择结束对话。请立即停止所有操作，不要继续执行任何任务。';
                        }

                        return {
                            jsonrpc: '2.0',
                            id: request.id,
                            result: {
                                content: [
                                    {
                                        type: 'text',
                                        text: resultText
                                    }
                                ]
                            }
                        };
                    } catch (error) {
                        return {
                            jsonrpc: '2.0',
                            id: request.id,
                            error: {
                                code: -32000,
                                message: `Failed to show dialog: ${error}`
                            }
                        };
                    }
                } else {
                    return {
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: -32601,
                            message: `Unknown tool: ${request.params?.name}`
                        }
                    };
                }

            default:
                if (request.id !== undefined) {
                    return {
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: -32601,
                            message: `Method not found: ${request.method}`
                        }
                    };
                }
                return null;
        }
    }

    // Internal dialog call (used by MCP handler)
    private callDialogInternal(reason: string, workspace: string): Promise<{ shouldContinue: boolean; userInput: string; attachments?: Attachment[] }> {
        return new Promise((resolve) => {
            const dialogId = `dialog_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

            // 增加对话计数
            const currentCount = (this.dialogCounts.get(workspace) || 0) + 1;
            this.dialogCounts.set(workspace, currentCount);

            // 获取历史记录
            const history = this.dialogHistory.get(workspace) || [];

            const dialog: PendingDialog = {
                id: dialogId,
                reason,
                workspace,
                resolve: (result) => {
                    // 保存到历史记录
                    const historyItem: DialogHistoryItem = {
                        timestamp: Date.now(),
                        reason,
                        userInput: result.userInput,
                        continued: result.shouldContinue
                    };
                    const updatedHistory = [...history, historyItem];
                    this.dialogHistory.set(workspace, updatedHistory);
                    
                    resolve(result);
                }
            };
            this.pendingDialogs.set(dialogId, dialog);

            if (this.onDialogRequest) {
                this.onDialogRequest(dialog, history, currentCount);
            }
        });
    }

    respondToDialog(dialogId: string, shouldContinue: boolean, userInput: string, attachments?: Attachment[]) {
        const pending = this.pendingDialogs.get(dialogId);
        if (pending) {
            pending.resolve({ shouldContinue, userInput, attachments });
            this.pendingDialogs.delete(dialogId);
            return true;
        }
        return false;
    }

    getPendingDialogs(): PendingDialog[] {
        return Array.from(this.pendingDialogs.values());
    }

    // Broadcast message to all SSE clients
    private broadcastSSE(data: any) {
        const message = `event: message\ndata: ${JSON.stringify(data)}\n\n`;
        this.sseClients.forEach((client) => {
            try {
                client.res.write(message);
            } catch (e) {
                // Client disconnected, remove from list
                this.sseClients.delete(client.id);
            }
        });
    }

    // 生成浏览器对话界面 HTML
    private getDialogHtml(pending: PendingDialog, dialogId: string): string {
        // 从工作区路径提取项目名
        const projectName = pending.workspace.split(/[/\\]/).pop() || 'Unknown';
        const dialogCount = this.dialogCounts.get(pending.workspace) || 1;
        
        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(projectName)} - AI Chat HITL</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 20px;
            color: #e0e0e0;
        }
        .container { max-width: 600px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 20px; }
        h1 { color: #00d4ff; margin-bottom: 5px; }
        .project-name { color: #ffaa00; font-size: 14px; }
        .stats { 
            background: rgba(255, 170, 0, 0.1); 
            padding: 8px 15px; 
            border-radius: 20px; 
            display: inline-block;
            margin-top: 10px;
            font-size: 13px;
        }
        .card {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
            border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .reason {
            background: rgba(0, 212, 255, 0.1);
            border-left: 3px solid #00d4ff;
            padding: 15px;
            border-radius: 0 8px 8px 0;
            margin-bottom: 20px;
        }
        textarea {
            width: 100%;
            padding: 12px;
            border: 1px solid rgba(255, 255, 255, 0.2);
            border-radius: 8px;
            background: rgba(0, 0, 0, 0.3);
            color: #fff;
            font-size: 14px;
            min-height: 120px;
            resize: vertical;
            margin-bottom: 15px;
        }
        textarea:focus { outline: none; border-color: #00d4ff; }
        .btn-group { display: flex; gap: 10px; }
        button {
            flex: 1;
            padding: 14px 24px;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
        }
        .btn-continue {
            background: linear-gradient(135deg, #00d4ff, #0099cc);
            color: #000;
        }
        .btn-end {
            background: rgba(255, 68, 68, 0.8);
            color: #fff;
        }
        button:hover { transform: translateY(-2px); }
        button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
        .status { text-align: center; padding: 20px; display: none; }
        .status.executing { color: #ffaa00; }
        .status.ended { color: #ff6666; }
        .spinner {
            display: inline-block;
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255,170,0,0.3);
            border-top-color: #ffaa00;
            border-radius: 50%;
            animation: spin 1s linear infinite;
            margin-right: 10px;
            vertical-align: middle;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🤖 AI Chat HITL</h1>
            <div class="project-name">📁 ${this.escapeHtml(projectName)}</div>
            <div class="stats">💬 第 <span id="dialogCount">${dialogCount}</span> 次对话</div>
        </div>
        <div class="card">
            <div class="reason">
                <strong>AI 想要结束的原因：</strong><br>
                ${this.escapeHtml(pending.reason)}
            </div>
            <div id="inputArea">
                <textarea id="userInput" placeholder="输入您的指令或反馈..."></textarea>
                <div class="btn-group">
                    <button id="continueBtn" class="btn-continue" onclick="respond(true)">✅ 继续对话</button>
                    <button id="endBtn" class="btn-end" onclick="respond(false)">❌ 结束对话</button>
                </div>
            </div>
            <div id="statusExecuting" class="status executing">
                <span class="spinner"></span>正在执行中，请等待AI完成任务...
            </div>
            <div id="statusEnded" class="status ended">
                ❌ 对话已结束
            </div>
        </div>
    </div>
    <script>
        let isResponded = false;
        let currentDialogId = '${dialogId}';
        const workspace = '${pending.workspace.replace(/\\/g, '\\\\')}';
        
        async function respond(shouldContinue) {
            if (isResponded) return;
            
            const userInput = document.getElementById('userInput').value;
            document.getElementById('continueBtn').disabled = true;
            document.getElementById('endBtn').disabled = true;
            
            try {
                const res = await fetch('http://127.0.0.1:${this.port}/respond', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        dialogId: currentDialogId,
                        shouldContinue: shouldContinue,
                        userInput: userInput,
                        attachments: []
                    })
                });
                
                if (res.ok) {
                    isResponded = true;
                    document.getElementById('inputArea').style.display = 'none';
                    if (shouldContinue) {
                        document.getElementById('statusExecuting').style.display = 'block';
                        // 开始轮询等待下一个对话
                        pollForNextDialog();
                    } else {
                        document.getElementById('statusEnded').style.display = 'block';
                    }
                }
            } catch (e) {
                alert('响应失败: ' + e.message);
                document.getElementById('continueBtn').disabled = false;
                document.getElementById('endBtn').disabled = false;
            }
        }
        
        // 轮询等待下一个对话（在当前页面更新，不打开新窗口）
        async function pollForNextDialog() {
            const pollInterval = setInterval(async () => {
                try {
                    const res = await fetch('http://127.0.0.1:${this.port}/pending?workspace=' + encodeURIComponent(workspace));
                    const data = await res.json();
                    if (data.dialogs && data.dialogs.length > 0) {
                        const newDialog = data.dialogs[0];
                        if (newDialog.id !== currentDialogId) {
                            clearInterval(pollInterval);
                            currentDialogId = newDialog.id;
                            // 在当前页面更新内容，不跳转
                            updateDialogContent(newDialog);
                        }
                    }
                } catch (e) {
                    // 忽略错误，继续轮询
                }
            }, 1000);
        }
        
        // 更新对话内容（复用当前页面）
        function updateDialogContent(dialog) {
            // 更新对话次数
            const countEl = document.getElementById('dialogCount');
            if (countEl) {
                countEl.textContent = parseInt(countEl.textContent) + 1;
            }
            
            // 更新原因
            const reasonEl = document.querySelector('.reason');
            if (reasonEl) {
                reasonEl.innerHTML = '<strong>AI 想要结束的原因：</strong><br>' + escapeHtml(dialog.reason);
            }
            
            // 重置输入区域
            document.getElementById('inputArea').style.display = 'block';
            document.getElementById('statusExecuting').style.display = 'none';
            document.getElementById('statusEnded').style.display = 'none';
            document.getElementById('userInput').value = '';
            document.getElementById('continueBtn').disabled = false;
            document.getElementById('endBtn').disabled = false;
            document.getElementById('userInput').focus();
            
            // 重置响应状态
            isResponded = false;
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Enter 继续，Shift+Enter 换行
        document.getElementById('userInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                respond(true);
            }
        });
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

    // 生成对话管理界面 HTML
    private getManageHtml(workspace: string): string {
        const projectName = workspace ? workspace.split(/[/\\]/).pop() || 'All Projects' : 'All Projects';
        const dialogCount = workspace ? (this.dialogCounts.get(workspace) || 0) : 
            Array.from(this.dialogCounts.values()).reduce((a, b) => a + b, 0);
        
        // 获取历史记录
        const history = workspace ? (this.dialogHistory.get(workspace) || []) : 
            Array.from(this.dialogHistory.values()).flat();
        
        // 获取待处理对话
        const pendingList = Array.from(this.pendingDialogs.values())
            .filter(d => !workspace || d.workspace.toLowerCase().replace(/\\/g, '/').includes(workspace.toLowerCase().replace(/\\/g, '/')));
        
        const historyHtml = history.length > 0 
            ? history.map((item, index) => {
                const time = new Date(item.timestamp).toLocaleString();
                const status = item.continued ? '✅ 继续' : '❌ 结束';
                const userInput = item.userInput ? this.escapeHtml(item.userInput).substring(0, 100) : '(无输入)';
                return `
                    <div class="history-item">
                        <div class="history-header">
                            <span class="history-index">#${index + 1}</span>
                            <span class="history-time">${time}</span>
                            <span class="history-status ${item.continued ? 'continued' : 'ended'}">${status}</span>
                        </div>
                        <div class="history-reason"><strong>原因:</strong> ${this.escapeHtml(item.reason).substring(0, 100)}${item.reason.length > 100 ? '...' : ''}</div>
                        <div class="history-input"><strong>回复:</strong> ${userInput}${(item.userInput?.length || 0) > 100 ? '...' : ''}</div>
                    </div>
                `;
            }).join('')
            : '<div class="empty-state">暂无对话历史</div>';

        const pendingHtml = pendingList.length > 0
            ? pendingList.map(d => {
                const pName = d.workspace.split(/[/\\]/).pop() || 'Unknown';
                return `
                    <div class="pending-item">
                        <div class="pending-project">📁 ${this.escapeHtml(pName)}</div>
                        <div class="pending-reason">${this.escapeHtml(d.reason).substring(0, 80)}${d.reason.length > 80 ? '...' : ''}</div>
                        <button class="open-btn" onclick="window.location.href='/dialog/${d.id}'">打开对话</button>
                    </div>
                `;
            }).join('')
            : '<div class="empty-state">暂无待处理对话</div>';

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${this.escapeHtml(projectName)} - 对话管理</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            padding: 20px;
            color: #e0e0e0;
        }
        .container { max-width: 800px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 25px; }
        h1 { color: #00d4ff; margin-bottom: 5px; }
        .project-name { color: #ffaa00; font-size: 16px; margin-bottom: 10px; }
        .stats-row { display: flex; justify-content: center; gap: 20px; }
        .stat-item {
            background: rgba(255, 255, 255, 0.05);
            padding: 10px 20px;
            border-radius: 20px;
            font-size: 14px;
        }
        .section { margin-bottom: 25px; }
        .section-title {
            color: #00d4ff;
            font-size: 16px;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .card {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            border: 1px solid rgba(255, 255, 255, 0.1);
            overflow: hidden;
        }
        .pending-item, .history-item {
            padding: 15px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        }
        .pending-item:last-child, .history-item:last-child { border-bottom: none; }
        .pending-project { color: #ffaa00; font-weight: 600; margin-bottom: 5px; }
        .pending-reason { font-size: 13px; color: #aaa; margin-bottom: 10px; }
        .open-btn {
            background: linear-gradient(135deg, #00d4ff, #0099cc);
            color: #000;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-weight: 600;
        }
        .open-btn:hover { transform: translateY(-1px); }
        .history-header { display: flex; gap: 15px; align-items: center; margin-bottom: 8px; }
        .history-index { color: #00d4ff; font-weight: 600; }
        .history-time { color: #888; font-size: 12px; }
        .history-status { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
        .history-status.continued { background: rgba(0, 255, 136, 0.2); color: #00ff88; }
        .history-status.ended { background: rgba(255, 68, 68, 0.2); color: #ff6666; }
        .history-reason, .history-input { font-size: 13px; color: #aaa; margin-bottom: 4px; }
        .empty-state { padding: 30px; text-align: center; color: #666; }
        .refresh-btn {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
            border: none;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            margin-left: 10px;
        }
        .refresh-btn:hover { background: rgba(255, 255, 255, 0.2); }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📊 对话管理</h1>
            <div class="project-name">📁 ${this.escapeHtml(projectName)}</div>
            <div class="stats-row">
                <div class="stat-item">💬 总对话: <strong>${dialogCount}</strong></div>
                <div class="stat-item">⏳ 待处理: <strong>${pendingList.length}</strong></div>
                <div class="stat-item">📜 历史: <strong>${history.length}</strong></div>
            </div>
        </div>

        <div class="section">
            <div class="section-title">
                ⏳ 待处理对话
                <button class="refresh-btn" onclick="location.reload()">🔄 刷新</button>
            </div>
            <div class="card">
                ${pendingHtml}
            </div>
        </div>

        <div class="section">
            <div class="section-title">📜 对话历史</div>
            <div class="card">
                ${historyHtml}
            </div>
        </div>
    </div>
    <script>
        // 自动刷新待处理对话
        setInterval(() => {
            fetch('/pending${workspace ? '?workspace=' + encodeURIComponent(workspace) : ''}')
                .then(r => r.json())
                .then(data => {
                    if (data.dialogs && data.dialogs.length > 0) {
                        location.reload();
                    }
                })
                .catch(() => {});
        }, 3000);
    </script>
</body>
</html>`;
    }
}
