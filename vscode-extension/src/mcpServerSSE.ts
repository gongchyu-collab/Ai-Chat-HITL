#!/usr/bin/env node
/**
 * AI Chat HITL - SSE Mode MCP Server
 * 
 * This server implements MCP protocol over HTTP with Server-Sent Events (SSE).
 * 
 * Endpoints:
 * - GET /sse - SSE connection for receiving messages
 * - POST /message - Send JSON-RPC messages to the server
 * - GET /health - Health check endpoint
 */

import * as http from 'http';

const MCP_PORT = parseInt(process.env.AI_CHAT_HITL_MCP_PORT || '13580');
const HITL_PORT = parseInt(process.env.AI_CHAT_HITL_PORT || '23987');

interface DialogResponse {
    shouldContinue: boolean;
    userInput: string;
    attachments?: Array<{
        type: 'image' | 'file' | 'code';
        name: string;
        content: string;
        mimeType?: string;
    }>;
}

interface SSEClient {
    id: string;
    res: http.ServerResponse;
}

interface MCPRequest {
    jsonrpc: '2.0';
    id?: number | string;
    method: string;
    params?: any;
}

interface MCPResponse {
    jsonrpc: '2.0';
    id?: number | string;
    result?: any;
    error?: {
        code: number;
        message: string;
    };
}

// SSE clients storage
const sseClients: Map<string, SSEClient> = new Map();

// Call the HITL dialog endpoint
async function callDialog(reason: string, workspace: string): Promise<DialogResponse> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ reason, workspace });

        const options = {
            hostname: '127.0.0.1',
            port: HITL_PORT,
            path: '/dialog',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(new Error('Failed to parse response'));
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

// Send SSE message to a specific client
function sendSSEMessage(client: SSEClient, data: any) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    client.res.write(message);
}

// Send SSE message to all clients
function broadcastSSE(data: any) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    sseClients.forEach((client) => {
        client.res.write(message);
    });
}

// Handle MCP JSON-RPC request
async function handleMCPRequest(request: MCPRequest, clientId?: string): Promise<MCPResponse | null> {
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
                        version: '1.4.0'
                    }
                }
            };

        case 'initialized':
            // Notification, no response needed
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
                    const response = await callDialog(reason || '', workspace || '');
                    
                    let resultText: string;
                    if (response.shouldContinue) {
                        resultText = `用户选择继续，并提供了新指令:\n${response.userInput}\n\n请立即执行用户的新指令。`;
                        
                        if (response.attachments && response.attachments.length > 0) {
                            resultText += '\n\n附件信息:\n';
                            for (const att of response.attachments) {
                                if (att.type === 'image') {
                                    resultText += `- [图片] ${att.name}\n`;
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
                            message: `Failed to show dialog: ${error}. Make sure the AI Chat HITL VSCode extension is running.`
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

// Create HTTP server
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            version: '1.4.0',
            mcpPort: MCP_PORT,
            hitlPort: HITL_PORT,
            clients: sseClients.size
        }));
        return;
    }

    // SSE endpoint
    if (req.method === 'GET' && (req.url === '/sse' || req.url === '/mcp')) {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });

        // Send initial connection message
        res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

        const client: SSEClient = { id: clientId, res };
        sseClients.set(clientId, client);

        console.error(`SSE client connected: ${clientId}`);

        // Handle client disconnect
        req.on('close', () => {
            sseClients.delete(clientId);
            console.error(`SSE client disconnected: ${clientId}`);
        });

        // Keep connection alive with periodic pings
        const pingInterval = setInterval(() => {
            if (sseClients.has(clientId)) {
                res.write(`: ping\n\n`);
            } else {
                clearInterval(pingInterval);
            }
        }, 30000);

        return;
    }

    // Message endpoint for receiving JSON-RPC requests
    if (req.method === 'POST' && (req.url === '/message' || req.url === '/mcp')) {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const request = JSON.parse(body) as MCPRequest;
                const response = await handleMCPRequest(request);
                
                if (response) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(response));
                    
                    // Also broadcast to SSE clients if there are any
                    if (sseClients.size > 0) {
                        broadcastSSE({ type: 'response', data: response });
                    }
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

    // 404 for other routes
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

// Start server
server.listen(MCP_PORT, '127.0.0.1', () => {
    console.error(`AI Chat HITL SSE MCP Server started on port ${MCP_PORT}`);
    console.error(`SSE endpoint: http://127.0.0.1:${MCP_PORT}/sse`);
    console.error(`Message endpoint: http://127.0.0.1:${MCP_PORT}/message`);
    console.error(`Health check: http://127.0.0.1:${MCP_PORT}/health`);
    console.error(`Connecting to HITL extension on port ${HITL_PORT}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${MCP_PORT} is already in use`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
