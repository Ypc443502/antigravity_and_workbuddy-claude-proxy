/**
 * Fake WorkBuddy Server
 * Simulates Tencent WorkBuddy backend endpoints for integration tests:
 * - POST /v2/chat/completions (OpenAI SSE streaming)
 * - POST /v2/plugin/auth/token/refresh (Token refresh)
 */

const http = require('http');

function createFakeServer() {
    let requestCount = 0;
    let refreshCount = 0;
    let lastChatRequest = null;
    let lastChatHeaders = null;

    const server = http.createServer(async (req, res) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', () => {
            const url = req.url;
            const method = req.method;

            // 1. Token Refresh
            if (method === 'POST' && url === '/v2/plugin/auth/token/refresh') {
                refreshCount++;
                const authHeader = req.headers['authorization'] || '';
                const refreshToken = req.headers['x-refresh-token'] || '';

                if (!authHeader || !refreshToken) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ code: 400, message: 'Missing tokens' }));
                    return;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: 0,
                    data: {
                        accessToken: `refreshed_access_${refreshCount}`,
                        refreshToken: `refreshed_refresh_${refreshCount}`,
                        expiresIn: 7200,
                        refreshExpiresIn: 2592000
                    }
                }));
                return;
            }

            // 1.5. Config & Models Discovery
            if (method === 'GET' && (url === '/v3/config' || url.includes('/models'))) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    code: 0,
                    data: {
                        models: [
                            { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', maxInputTokens: 32768, maxOutputTokens: 4096, enabled: true, credits: 'x0.00', tags: ['badge:Free now:#00E599'] },
                            { id: 'glm-5.2', name: 'GLM 5.2', maxInputTokens: 32768, maxOutputTokens: 4096, enabled: true, credits: 'x0.79', tags: [] },
                            { id: 'hy3', name: 'Hy3', maxInputTokens: 32768, maxOutputTokens: 4096, enabled: true, credits: 'x0.00', tags: ['badge:Free now:#00E599'] },
                            { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', maxInputTokens: 32768, maxOutputTokens: 4096, enabled: true, credits: 'x3.47', tags: [] }
                        ],
                        agents: [
                            { name: 'cli', models: ['deepseek-v4-pro', 'glm-5.2', 'hy3', 'gpt-5.6-sol'] }
                        ]
                    }
                }));
                return;
            }

            // 2. Chat Completions
            if (method === 'POST' && url === '/v2/chat/completions') {
                requestCount++;
                lastChatHeaders = req.headers;
                let parsedBody = {};
                try {
                    parsedBody = JSON.parse(body);
                } catch (_) {}
                lastChatRequest = parsedBody;

                const authHeader = req.headers['authorization'] || '';

                // Simulate 401 (trigger token refresh)
                if (authHeader.includes('trigger_401') && !authHeader.includes('refreshed')) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ code: 401, message: 'Token expired' }));
                    return;
                }

                // Simulate 429 (rate limit)
                if (authHeader.includes('trigger_429')) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ code: 429, message: 'Too many requests' }));
                    return;
                }

                // Normal response - Stream OpenAI SSE
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                });

                // Check if user asked for tools or tool test
                const lastMsg = parsedBody.messages?.[parsedBody.messages.length - 1];
                const isToolRequest = lastMsg && typeof lastMsg.content === 'string' &&
                    (lastMsg.content.includes('read file') || lastMsg.content.includes('tool'));

                if (isToolRequest && parsedBody.tools?.length > 0) {
                    // Send tool call chunk
                    const chunk1 = {
                        id: 'chatcmpl-fake-tool-1',
                        choices: [{
                            index: 0,
                            delta: {
                                role: 'assistant',
                                tool_calls: [{
                                    index: 0,
                                    id: 'call_read_pkg_json',
                                    type: 'function',
                                    function: {
                                        name: 'Read',
                                        arguments: '{"file_path":"package.json"}'
                                    }
                                }]
                            },
                            finish_reason: null
                        }]
                    };
                    res.write(`data: ${JSON.stringify(chunk1)}\n\n`);

                    const chunk2 = {
                        id: 'chatcmpl-fake-tool-1',
                        choices: [{
                            index: 0,
                            delta: {},
                            finish_reason: 'tool_calls'
                        }],
                        usage: { prompt_tokens: 30, completion_tokens: 20 }
                    };
                    res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }

                // Check if message is a tool_result response
                const hasToolResult = parsedBody.messages?.some(m => m.role === 'tool');
                let replyText = 'WorkBuddy proxy ok';
                if (hasToolResult) {
                    replyText = 'File package.json has name: antigravity-claude-proxy';
                }

                // Stream normal text response in 2 chunks
                const chunk1 = {
                    id: 'chatcmpl-fake-text-1',
                    choices: [{
                        index: 0,
                        delta: { role: 'assistant', content: replyText.slice(0, 9) },
                        finish_reason: null
                    }]
                };
                res.write(`data: ${JSON.stringify(chunk1)}\n\n`);

                const chunk2 = {
                    id: 'chatcmpl-fake-text-1',
                    choices: [{
                        index: 0,
                        delta: { content: replyText.slice(9) },
                        finish_reason: null
                    }]
                };
                res.write(`data: ${JSON.stringify(chunk2)}\n\n`);

                const chunk3 = {
                    id: 'chatcmpl-fake-text-1',
                    choices: [{
                        index: 0,
                        delta: {},
                        finish_reason: 'stop'
                    }],
                    usage: { prompt_tokens: 15, completion_tokens: 6 }
                };
                res.write(`data: ${JSON.stringify(chunk3)}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });
    });

    return {
        server,
        start() {
            return new Promise((resolve, reject) => {
                server.listen(0, '127.0.0.1', () => {
                    const port = server.address().port;
                    resolve(`http://127.0.0.1:${port}`);
                });
                server.on('error', reject);
            });
        },
        stop() {
            return new Promise(resolve => {
                if (typeof server.closeAllConnections === 'function') {
                    server.closeAllConnections();
                }
                server.close(() => resolve());
            });
        },
        getStats() {
            return {
                requestCount,
                refreshCount,
                lastChatRequest,
                lastChatHeaders
            };
        }
    };
}

module.exports = { createFakeServer };
