#!/usr/bin/env node
import * as http from 'http';

const PORT = parseInt(process.env.AI_CHAT_HITL_PORT || '23987');

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

async function callDialog(reason: string, workspace: string): Promise<DialogResponse> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({ reason, workspace });

        const options = {
            hostname: '127.0.0.1',
            port: PORT,
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

// MCP Protocol implementation via stdio
interface MCPRequest {
    jsonrpc: '2.0';
    id: number | string;
    method: string;
    params?: any;
}

interface MCPResponse {
    jsonrpc: '2.0';
    id: number | string;
    result?: any;
    error?: {
        code: number;
        message: string;
    };
}

function sendResponse(response: MCPResponse) {
    const json = JSON.stringify(response);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

async function handleRequest(request: MCPRequest): Promise<void> {
    switch (request.method) {
        case 'initialize':
            sendResponse({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {}
                    },
                    serverInfo: {
                        name: 'AI_chat_HITL',
                        version: '1.2.0'
                    }
                }
            });
            break;

        case 'initialized':
            // No response needed for notification
            break;

        case 'tools/list':
            sendResponse({
                jsonrpc: '2.0',
                id: request.id,
                result: {
                    tools: [
                        {
                            name: 'AI_chat_HITL',
                            description: '当AI想要结束对话时必须调用此工具询问用户是否继续',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    reason: {
                                        type: 'string',
                                        description: 'AI想要结束对话的原因'
                                    },
                                    workspace: {
                                        type: 'string',
                                        description: '当前工作区的绝对路径'
                                    }
                                },
                                required: ['reason', 'workspace']
                            }
                        }
                    ]
                }
            });
            break;

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

                    sendResponse({
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
                    });
                } catch (error) {
                    sendResponse({
                        jsonrpc: '2.0',
                        id: request.id,
                        error: {
                            code: -32000,
                            message: `Failed to show dialog: ${error}. Make sure the AI Chat HITL VSCode extension is running.`
                        }
                    });
                }
            } else {
                sendResponse({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: {
                        code: -32601,
                        message: `Unknown tool: ${request.params?.name}`
                    }
                });
            }
            break;

        default:
            if (request.id !== undefined) {
                sendResponse({
                    jsonrpc: '2.0',
                    id: request.id,
                    error: {
                        code: -32601,
                        message: `Method not found: ${request.method}`
                    }
                });
            }
    }
}

// Read from stdin using Content-Length header
let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
    buffer += chunk;
    
    while (true) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) break;
        
        const header = buffer.substring(0, headerEnd);
        const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
        if (!contentLengthMatch) {
            buffer = buffer.substring(headerEnd + 4);
            continue;
        }
        
        const contentLength = parseInt(contentLengthMatch[1]);
        const messageStart = headerEnd + 4;
        const messageEnd = messageStart + contentLength;
        
        if (buffer.length < messageEnd) break;
        
        const message = buffer.substring(messageStart, messageEnd);
        buffer = buffer.substring(messageEnd);
        
        try {
            const request = JSON.parse(message) as MCPRequest;
            handleRequest(request).catch(console.error);
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }
});

process.stderr.write(`AI Chat HITL MCP Server started, connecting to VSCode extension on port ${PORT}\n`);
