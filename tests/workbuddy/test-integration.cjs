/**
 * WorkBuddy Full Integration Test Suite
 * Spins up Fake WorkBuddy Upstream Server, starts the Proxy Server,
 * and executes end-to-end tests for all WorkBuddy flows.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { createFakeServer } = require('./fake-server.cjs');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║        WORKBUDDY FULL INTEGRATION TEST SUITE                 ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // 1. Setup temporary directory for auth files
    const tmpDir = path.join(os.tmpdir(), `wb_integ_test_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    // Account 1: Standard account
    const auth1 = {
        auth: {
            accessToken: 'token_account_1',
            refreshToken: 'refresh_account_1',
            expiresAt: Date.now() + 3600000,
            domain: 'www.codebuddy.cn'
        },
        account: {
            uid: '10001',
            nickname: 'Alice',
            enterpriseId: 'ent1'
        }
    };
    fs.writeFileSync(path.join(tmpDir, 'alice.info'), JSON.stringify(auth1, null, 2), 'utf8');

    // 2. Start Fake WorkBuddy Server
    const fakeServer = createFakeServer();
    const fakeServerUrl = await fakeServer.start();
    console.log(`[Integration] Fake WorkBuddy server running at ${fakeServerUrl}`);

    process.env.WORKBUDDY_BACKEND_URL = fakeServerUrl;
    process.env.WORKBUDDY_CHAT_ENDPOINT = `${fakeServerUrl}/v2/chat/completions`;
    process.env.WORKBUDDY_REFRESH_ENDPOINT = `${fakeServerUrl}/v2/plugin/auth/token/refresh`;
    process.env.WORKBUDDY_AUTH_DIR = tmpDir;

    // 3. Import and initialize ProviderRouter and App
    const { providerRouter } = await import('../../src/providers/index.js');
    const { WorkBuddyProvider } = await import('../../src/providers/workbuddy/index.js');

    // Re-register WorkBuddyProvider to use new tmpDir and endpoints
    const customWbProvider = new WorkBuddyProvider({
        authDir: tmpDir
    });
    await customWbProvider.initialize();
    providerRouter.registerProvider(customWbProvider);

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}\n  Stack: ${e.stack}`);
            failed++;
        }
    }

    try {
        // 1. Models Listing Aggregation
        await test('Models Aggregation: listModels includes workbuddy/ models', async () => {
            const models = await providerRouter.listModels();
            assert.strictEqual(models.object, 'list');
            assert(Array.isArray(models.data));

            const wbDeepSeek = models.data.find(m => m.id === 'workbuddy/deepseek-v4-pro');
            assert(wbDeepSeek, 'Expected workbuddy/deepseek-v4-pro in models list');
            assert.strictEqual(wbDeepSeek.owned_by, 'workbuddy');

            const wbGlm = models.data.find(m => m.id === 'workbuddy/glm-5.2');
            assert(wbGlm, 'Expected workbuddy/glm-5.2 in models list');
        });

        // 2. Non-streaming message
        await test('Messages: non-streaming chat completion returns Anthropic Message format', async () => {
            const request = {
                model: 'workbuddy/deepseek-v4-pro',
                messages: [{ role: 'user', content: '你好，请回复 WorkBuddy proxy ok' }]
            };

            const response = await customWbProvider.sendMessage(request);
            assert.strictEqual(response.type, 'message');
            assert.strictEqual(response.role, 'assistant');
            assert.strictEqual(response.model, 'workbuddy/deepseek-v4-pro');
            assert.strictEqual(response.content.length, 1);
            assert.strictEqual(response.content[0].type, 'text');
            assert.strictEqual(response.content[0].text, 'WorkBuddy proxy ok');
            assert.strictEqual(response.stop_reason, 'end_turn');
            assert.strictEqual(response.usage.input_tokens, 15);
            assert.strictEqual(response.usage.output_tokens, 6);
        });

        // 3. Streaming message
        await test('Messages: streaming chat completion yields valid Anthropic SSE events sequence', async () => {
            const request = {
                model: 'workbuddy/deepseek-v4-pro',
                messages: [{ role: 'user', content: '你好' }],
                stream: true
            };

            const events = [];
            const generator = customWbProvider.sendMessageStream(request);
            for await (const ev of generator) {
                events.push(ev);
            }

            const types = events.map(e => e.type);
            assert.deepStrictEqual(types, [
                'message_start',
                'content_block_start',
                'content_block_delta',
                'content_block_delta',
                'content_block_stop',
                'message_delta',
                'message_stop'
            ]);

            assert.strictEqual(events[0].message.role, 'assistant');
            assert.strictEqual(events[1].content_block.type, 'text');
            assert.strictEqual(events[5].delta.stop_reason, 'end_turn');
        });

        // 4. Tool use & tool result roundtrip
        await test('Tools Roundtrip: assistant emits tool_use, user sends tool_result, assistant concludes', async () => {
            // Turn 1: User asks for tool
            const turn1Req = {
                model: 'workbuddy/deepseek-v4-pro',
                messages: [{ role: 'user', content: 'read file package.json please' }],
                tools: [{
                    name: 'Read',
                    description: 'Read file contents',
                    input_schema: {
                        type: 'object',
                        properties: { file_path: { type: 'string' } },
                        required: ['file_path']
                    }
                }]
            };

            const turn1Res = await customWbProvider.sendMessage(turn1Req);
            assert.strictEqual(turn1Res.stop_reason, 'tool_use');
            assert.strictEqual(turn1Res.content.length, 1);
            assert.strictEqual(turn1Res.content[0].type, 'tool_use');
            assert.strictEqual(turn1Res.content[0].name, 'Read');
            assert.strictEqual(turn1Res.content[0].id, 'call_read_pkg_json');
            assert.deepStrictEqual(turn1Res.content[0].input, { file_path: 'package.json' });

            // Turn 2: User executes tool and sends tool_result
            const turn2Req = {
                model: 'workbuddy/deepseek-v4-pro',
                messages: [
                    { role: 'user', content: 'read file package.json please' },
                    {
                        role: 'assistant',
                        content: [
                            {
                                type: 'tool_use',
                                id: 'call_read_pkg_json',
                                name: 'Read',
                                input: { file_path: 'package.json' }
                            }
                        ]
                    },
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: 'call_read_pkg_json',
                                content: '{"name": "antigravity-claude-proxy"}'
                            }
                        ]
                    }
                ],
                tools: turn1Req.tools
            };

            const turn2Res = await customWbProvider.sendMessage(turn2Req);
            assert.strictEqual(turn2Res.stop_reason, 'end_turn');
            assert.strictEqual(turn2Res.content[0].type, 'text');
            assert(turn2Res.content[0].text.includes('antigravity-claude-proxy'));
        });

        // 5. Automatic 401 token refresh & retry
        await test('Error Handling: 401 triggers token refresh and automatically retries request', async () => {
            // Clean up any existing proxy own auth cache to ensure test isolation
            const ownAuthDir = path.join(process.cwd(), 'data', 'workbuddy-auth');
            if (fs.existsSync(ownAuthDir)) {
                try {
                    for (const f of fs.readdirSync(ownAuthDir)) {
                        try { fs.unlinkSync(path.join(ownAuthDir, f)); } catch (_) {}
                    }
                } catch (_) {}
            }

            // Write an auth file with trigger_401 token
            const auth401File = path.join(tmpDir, 'auth_401.info');
            const auth401 = {
                auth: {
                    accessToken: 'trigger_401_test',
                    refreshToken: 'refresh_tok_401',
                    expiresAt: Date.now() + 3600000,
                    domain: 'www.codebuddy.cn'
                },
                account: { uid: 'user_401', nickname: 'Test401' }
            };
            fs.writeFileSync(auth401File, JSON.stringify(auth401, null, 2), 'utf8');

            const wb401Provider = new WorkBuddyProvider({ authDir: tmpDir });
            await wb401Provider.initialize();

            // Set other accounts disabled to force selection of this account
            for (const acc of wb401Provider.accountManager.accounts) {
                if (acc.uid !== 'user_401') acc.enabled = false;
            }

            const initialRefreshCount = fakeServer.getStats().refreshCount;

            const res = await wb401Provider.sendMessage({
                model: 'workbuddy/deepseek-v4-pro',
                messages: [{ role: 'user', content: 'test 401' }]
            });

            assert.strictEqual(res.content[0].text, 'WorkBuddy proxy ok');
            assert(fakeServer.getStats().refreshCount > initialRefreshCount, 'Expected refresh API to have been called');

            // Verify official desktop auth remains untouched (read-only protection)
            const desktopFileContent = JSON.parse(fs.readFileSync(auth401File, 'utf8'));
            assert.strictEqual(desktopFileContent.auth.accessToken, 'trigger_401_test', 'Official desktop auth must NOT be overwritten');
        });

        // 6. Rate limit 429 failover to next account
        await test('Failover: 429 rate limit triggers automatic account failover', async () => {
            const failoverDir = path.join(tmpDir, 'failover_pool');
            fs.mkdirSync(failoverDir, { recursive: true });

            // Account A: will return 429
            const authA = {
                auth: { accessToken: 'trigger_429_test', refreshToken: 'refA', expiresAt: Date.now() + 3600000 },
                account: { uid: 'user_rate_limited', nickname: 'AccountA' }
            };
            fs.writeFileSync(path.join(failoverDir, 'a.info'), JSON.stringify(authA, null, 2));

            // Account B: normal working account
            const authB = {
                auth: { accessToken: 'valid_token_b', refreshToken: 'refB', expiresAt: Date.now() + 3600000 },
                account: { uid: 'user_working_b', nickname: 'AccountB' }
            };
            fs.writeFileSync(path.join(failoverDir, 'b.info'), JSON.stringify(authB, null, 2));

            const failoverProvider = new WorkBuddyProvider({ authDir: failoverDir });
            await failoverProvider.initialize();

            const res = await failoverProvider.sendMessage({
                model: 'workbuddy/deepseek-v4-pro',
                messages: [{ role: 'user', content: 'test 429 failover' }]
            });

            assert.strictEqual(res.content[0].text, 'WorkBuddy proxy ok');

            // Account A should now be rate limited
            const accA = failoverProvider.accountManager.accounts.find(a => a.uid === 'user_rate_limited');
            assert(accA.modelRateLimits['deepseek-v4-pro']?.isRateLimited, 'Expected Account A to be marked rate-limited');
        });

    } finally {
        await fakeServer.stop();
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    }

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Integration test suite failed:', e);
    process.exit(1);
});
