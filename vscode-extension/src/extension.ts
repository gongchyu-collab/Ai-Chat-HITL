import * as vscode from 'vscode';
import { MCPServer, PendingDialog, Attachment, DialogHistoryItem } from './mcpServer';
import { DialogPanel, PersistedDialogState } from './dialogPanel';
import { ConfigManager } from './configManager';
import { SidebarPanel } from './sidebarPanel';

let mcpServer: MCPServer | null = null;
let statusBarItem: vscode.StatusBarItem;
let configManager: ConfigManager;
let sidebarPanel: SidebarPanel;
let extensionContext: vscode.ExtensionContext;

// 持久化存储键
const PENDING_DIALOGS_KEY = 'ai-chat-hitl.pendingDialogs';

// 跟踪已打开浏览器窗口的工作区（避免重复打开）
const openBrowserWindows = new Map<string, number>(); // workspace -> lastOpenTime

// 获取插件版本
function getExtensionVersion(context: vscode.ExtensionContext): string {
    const extension = vscode.extensions.getExtension('ai-chat-hitl.ai-chat-hitl-extension');
    return extension?.packageJSON?.version || context.extension.packageJSON.version || '1.5.0';
}

export async function activate(context: vscode.ExtensionContext) {
    console.log('AI Chat HITL Extension is now active!');

    extensionContext = context;
    configManager = new ConfigManager(context);

    // 恢复之前保存的待处理对话状态
    const savedStates = context.globalState.get<PersistedDialogState[]>(PENDING_DIALOGS_KEY, []);
    if (savedStates.length > 0) {
        DialogPanel.restorePendingStates(savedStates);
        console.log(`Restored ${savedStates.length} pending dialog states`);
    }
    const version = getExtensionVersion(context);

    // 获取配置
    const config = vscode.workspace.getConfiguration('ai-chat-hitl');
    const port = config.get<number>('serverPort', 23987);

    // 创建侧边栏面板
    sidebarPanel = new SidebarPanel(context.extensionUri, version);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SidebarPanel.viewType, sidebarPanel)
    );

    // 创建并启动 MCP Server
    mcpServer = new MCPServer(port);
    mcpServer.setVersion(version);
    mcpServer.setDialogRequestHandler((dialog, history, dialogCount) => {
        handleDialogRequest(context, dialog, history, dialogCount);
        // 更新侧边栏
        if (sidebarPanel && mcpServer) {
            sidebarPanel.updateStatus(mcpServer.getPort(), history, dialogCount);
        }
    });

    let isServerOwner = false;
    try {
        await mcpServer.start();
        console.log(`MCP Server started on port ${port}`);
        isServerOwner = true;
    } catch (error) {
        console.log('Port already in use, starting as client mode');
        // 端口被占用，启动客户端模式，轮询待处理的对话
        startClientPolling(context, port);
    }

    // 创建状态栏项
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    updateStatusBar();
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 注册命令
    const commands = [
        vscode.commands.registerCommand('ai-chat-hitl.showStatus', showStatus),
        vscode.commands.registerCommand('ai-chat-hitl.generateRules', () => configManager.generateGlobalRules()),
        vscode.commands.registerCommand('ai-chat-hitl.configureMCP', () => configManager.configureMCP()),
        vscode.commands.registerCommand('ai-chat-hitl.changePort', async () => {
            const result = await configManager.changePort();
            // 自动重启服务器
            if (result && mcpServer) {
                mcpServer.setPort(result.newPort);
                updateStatusBar();
                if (sidebarPanel) {
                    sidebarPanel.updatePort(result.newPort);
                }
                vscode.window.showInformationMessage(`服务已重启，新端口: ${result.newPort}`);
            }
        }),
        vscode.commands.registerCommand('ai-chat-hitl.quickSetup', async () => {
            await configManager.quickSetup();
        }),
        vscode.commands.registerCommand('ai-chat-hitl.restartServer', async () => {
            if (mcpServer) {
                mcpServer.stop();
                try {
                    await mcpServer.start();
                    vscode.window.showInformationMessage('MCP Server 已重启');
                    updateStatusBar();
                } catch (error) {
                    vscode.window.showErrorMessage(`MCP Server 重启失败: ${error}`);
                }
            }
        }),
        vscode.commands.registerCommand('ai-chat-hitl.stopServer', async () => {
            if (mcpServer) {
                mcpServer.stop();
                vscode.window.showInformationMessage(`MCP Server 已停止 (端口 ${mcpServer.getPort()})`);
                statusBarItem.text = `$(circle-slash) AI Chat HITL :${mcpServer.getPort()} (已停止)`;
                statusBarItem.tooltip = `AI Chat HITL Extension\n端口: ${mcpServer.getPort()}\n状态: 已停止`;
            }
        }),
        // 手动打开弹窗命令
        vscode.commands.registerCommand('ai-chat-hitl.openDialog', async () => {
            await openDialogForCurrentWorkspace(context);
        }),
        // 显示所有待处理对话
        vscode.commands.registerCommand('ai-chat-hitl.showPendingDialogs', async () => {
            await showPendingDialogsQuickPick(context);
        })
    ];

    commands.forEach(cmd => context.subscriptions.push(cmd));

    // 监听配置变化
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('ai-chat-hitl.serverPort')) {
                const newConfig = vscode.workspace.getConfiguration('ai-chat-hitl');
                const newPort = newConfig.get<number>('serverPort', 23987);
                if (mcpServer) {
                    mcpServer.setPort(newPort);
                    updateStatusBar();
                }
            }
        })
    );

    // 清理
    context.subscriptions.push({
        dispose: () => {
            // 保存待处理的对话状态
            savePendingDialogStates(context);
            if (mcpServer) {
                mcpServer.stop();
            }
        }
    });

    // 定期保存待处理状态（每30秒）
    const saveInterval = setInterval(() => {
        savePendingDialogStates(context);
    }, 30000);
    context.subscriptions.push({ dispose: () => clearInterval(saveInterval) });
}

// 保存待处理的对话状态
function savePendingDialogStates(context: vscode.ExtensionContext) {
    const states = DialogPanel.getAllPendingStates();
    context.globalState.update(PENDING_DIALOGS_KEY, states);
}

// 为当前工作区打开对话管理（浏览器窗口）
async function openDialogForCurrentWorkspace(context: vscode.ExtensionContext) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showWarningMessage('没有打开的工作区');
        return;
    }

    // 如果有多个工作区，让用户选择
    let targetWorkspace: string;
    if (workspaceFolders.length === 1) {
        targetWorkspace = workspaceFolders[0].uri.fsPath;
    } else {
        const selected = await vscode.window.showQuickPick(
            workspaceFolders.map(f => ({
                label: f.name,
                description: f.uri.fsPath,
                workspace: f.uri.fsPath
            })),
            { placeHolder: '选择要打开对话的工作区' }
        );
        if (!selected) return;
        targetWorkspace = selected.workspace;
    }

    // 在浏览器中打开对话管理界面
    const config = vscode.workspace.getConfiguration('ai-chat-hitl');
    const port = config.get<number>('serverPort', 23987);
    const manageUrl = vscode.Uri.parse(`http://127.0.0.1:${port}/manage?workspace=${encodeURIComponent(targetWorkspace)}`);
    vscode.env.openExternal(manageUrl);
}

// 显示所有待处理对话（在浏览器中打开管理界面）
async function showPendingDialogsQuickPick(context: vscode.ExtensionContext) {
    // 直接在浏览器中打开全局对话管理界面
    const config = vscode.workspace.getConfiguration('ai-chat-hitl');
    const port = config.get<number>('serverPort', 23987);
    const manageUrl = vscode.Uri.parse(`http://127.0.0.1:${port}/manage`);
    vscode.env.openExternal(manageUrl);
}

function updateStatusBar() {
    if (mcpServer) {
        statusBarItem.text = `$(comment-discussion) AI Chat HITL :${mcpServer.getPort()}`;
        statusBarItem.tooltip = `AI Chat HITL Extension\n端口: ${mcpServer.getPort()}\n点击查看状态`;
        statusBarItem.command = 'ai-chat-hitl.showStatus';
    }
}

function showStatus() {
    const items: vscode.QuickPickItem[] = [
        {
            label: '$(info) 查看状态',
            description: `MCP Server 运行在端口 ${mcpServer?.getPort() || 'N/A'}`
        },
        {
            label: '$(gear) 修改端口',
            description: '更改 MCP Server 端口'
        },
        {
            label: '$(file-add) 生成全局规则',
            description: '在工作区生成 .AichatHITLrules 文件'
        },
        {
            label: '$(settings-gear) 配置 MCP',
            description: '查看 MCP 配置说明'
        },
        {
            label: '$(refresh) 重启服务器',
            description: '重启 MCP Server'
        }
    ];

    vscode.window.showQuickPick(items, {
        placeHolder: 'AI Chat HITL 操作'
    }).then((selected) => {
        if (!selected) return;

        if (selected.label.includes('修改端口')) {
            vscode.commands.executeCommand('ai-chat-hitl.changePort');
        } else if (selected.label.includes('生成全局规则')) {
            vscode.commands.executeCommand('ai-chat-hitl.generateRules');
        } else if (selected.label.includes('配置 MCP')) {
            vscode.commands.executeCommand('ai-chat-hitl.configureMCP');
        } else if (selected.label.includes('重启服务器')) {
            vscode.commands.executeCommand('ai-chat-hitl.restartServer');
        } else if (selected.label.includes('查看状态')) {
            const pendingCount = mcpServer?.getPendingDialogs().length || 0;
            vscode.window.showInformationMessage(
                `AI Chat HITL 状态:\n` +
                `• 端口: ${mcpServer?.getPort() || 'N/A'}\n` +
                `• 待处理对话: ${pendingCount}`
            );
        }
    });
}

function handleDialogRequest(context: vscode.ExtensionContext, dialog: PendingDialog, history: DialogHistoryItem[], dialogCount: number) {
    // 保存待处理对话状态（用于手动打开和IDE重启恢复）
    DialogPanel.savePendingState(dialog, dialogCount);
    savePendingDialogStates(context);

    // 检查工作区匹配
    const workspaceFolders = vscode.workspace.workspaceFolders;
    const matchesWorkspace = workspaceFolders?.some(folder => {
        const folderPath = folder.uri.fsPath.toLowerCase().replace(/\\/g, '/');
        const dialogPath = dialog.workspace.toLowerCase().replace(/\\/g, '/');
        return folderPath === dialogPath || 
               folderPath.startsWith(dialogPath + '/') || 
               dialogPath.startsWith(folderPath + '/');
    });

    // 如果有工作区但不匹配，忽略这个请求（让其他窗口处理）
    if (workspaceFolders && workspaceFolders.length > 0 && !matchesWorkspace) {
        return;
    }

    // 获取配置：是否在浏览器中打开对话框
    const config = vscode.workspace.getConfiguration('ai-chat-hitl');
    const openInBrowser = config.get<boolean>('openDialogInBrowser', true);
    const port = config.get<number>('serverPort', 23987);

    if (openInBrowser) {
        // 检查该工作区是否已有浏览器窗口打开（5分钟内打开过则跳过）
        const workspaceKey = dialog.workspace.toLowerCase().replace(/\\/g, '/');
        const lastOpenTime = openBrowserWindows.get(workspaceKey) || 0;
        const now = Date.now();
        
        if (now - lastOpenTime > 5 * 60 * 1000) {
            // 超过5分钟或首次，打开新窗口
            const dialogUrl = vscode.Uri.parse(`http://127.0.0.1:${port}/dialog/${dialog.id}`);
            vscode.env.openExternal(dialogUrl);
            openBrowserWindows.set(workspaceKey, now);
        }
        // 否则跳过，让现有浏览器标签页通过轮询获取新对话
    } else {
        // 在编辑器标签页中打开
        DialogPanel.createOrShow(
            context.extensionUri,
            dialog,
            (shouldContinue: boolean, userInput: string, attachments?: Attachment[]) => {
                if (mcpServer) {
                    mcpServer.respondToDialog(dialog.id, shouldContinue, userInput, attachments);
                }
                // 响应后保存状态
                savePendingDialogStates(context);
            },
            history,
            dialogCount
        );
    }
}

// 客户端轮询模式 - 当端口被其他窗口占用时使用
let pollingInterval: NodeJS.Timeout | null = null;
let processedDialogIds = new Set<string>();

function startClientPolling(context: vscode.ExtensionContext, port: number) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        return;
    }
    
    const workspacePath = workspaceFolders[0].uri.fsPath;
    console.log(`Starting client polling for workspace: ${workspacePath}`);
    
    pollingInterval = setInterval(async () => {
        try {
            const http = await import('http');
            const encodedPath = encodeURIComponent(workspacePath);
            
            const req = http.request({
                hostname: '127.0.0.1',
                port: port,
                path: `/pending?workspace=${encodedPath}`,
                method: 'GET',
                timeout: 2000
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const result = JSON.parse(data);
                        if (result.dialogs && result.dialogs.length > 0) {
                            for (const dialogInfo of result.dialogs) {
                                // 避免重复处理
                                if (!processedDialogIds.has(dialogInfo.id)) {
                                    processedDialogIds.add(dialogInfo.id);
                                    
                                    // 创建对话对象并显示
                                    const dialog: PendingDialog = {
                                        id: dialogInfo.id,
                                        reason: dialogInfo.reason,
                                        workspace: dialogInfo.workspace,
                                        resolve: (response) => {
                                            // 通过 HTTP 发送响应到主服务器
                                            sendDialogResponse(port, dialogInfo.id, response);
                                        }
                                    };
                                    
                                    handleDialogRequest(context, dialog, [], 1);
                                }
                            }
                        }
                    } catch (e) {
                        // 解析错误，忽略
                    }
                });
            });
            
            req.on('error', () => {
                // 连接错误，忽略
            });
            
            req.end();
        } catch (e) {
            // 忽略错误
        }
    }, 1000); // 每秒轮询一次
}

function sendDialogResponse(port: number, dialogId: string, response: any) {
    import('http').then(http => {
        const postData = JSON.stringify({
            dialogId: dialogId,
            shouldContinue: response.shouldContinue,
            userInput: response.userInput,
            attachments: response.attachments
        });
        
        const req = http.request({
            hostname: '127.0.0.1',
            port: port,
            path: '/respond',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, () => {
            // 响应发送成功
            processedDialogIds.delete(dialogId);
        });
        
        req.on('error', () => {
            // 错误处理
        });
        
        req.write(postData);
        req.end();
    });
}

export function deactivate() {
    if (mcpServer) {
        mcpServer.stop();
    }
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
}
