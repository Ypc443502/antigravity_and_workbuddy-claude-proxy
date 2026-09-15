/**
 * Live Smoke Test for Antigravity + WorkBuddy Server
 * Starts Express app on test port 18080 and verifies live HTTP endpoints.
 */

const assert = require('assert');
const http = require('http');

async function runLiveTest() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║        WORKBUDDY LIVE SERVER SMOKE TEST (PORT 18080)         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const appModule = await import('../../src/server.js');
    const app = appModule.default;

    const TEST_PORT = 18080;
    const server = await new Promise((resolve, reject) => {
        const s = app.listen(TEST_PORT, '127.0.0.1', () => {
            console.log(`[SmokeTest] Test server listening on http://127.0.0.1:${TEST_PORT}`);
            resolve(s);
        });
        s.on('error', reject);
    });

    function request(path, options = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: TEST_PORT,
                path: path,
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': 'test',
                    'anthropic-version': '2023-06-01',
                    ...(options.headers || {})
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: data,
                        json: () => {
                            try { return JSON.parse(data); } catch (_) { return null; }
                        }
                    });
                });
            });

            req.on('error', reject);

            if (options.body) {
                req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
            }
            req.end();
        });
    }

    let passed = 0;
    let failed = 0;

    async function test(name, fn) {
        try {
            await fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}`);
            failed++;
        }
    }

    try {
        // 1. Test GET /health
        await test('GET /health: returns providers with antigravity and workbuddy', async () => {
            const res = await request('/health');
            assert.strictEqual(res.status, 200);
            const data = res.json();
            assert(data);
            assert.strictEqual(data.status, 'ok');
            assert(data.providers, 'Expected providers field in /health');
            assert(data.providers.antigravity, 'Expected providers.antigravity');
            assert(data.providers.workbuddy, 'Expected providers.workbuddy');
            console.log(`  → WorkBuddy accounts detected on this machine: ${data.providers.workbuddy.accounts}`);
            console.log(`  → WorkBuddy available accounts: ${data.providers.workbuddy.available}`);
        });

        // 2. Test GET /v1/models
        await test('GET /v1/models: contains workbuddy/ models', async () => {
            const res = await request('/v1/models');
            assert.strictEqual(res.status, 200);
            const data = res.json();
            assert(data);
            assert.strictEqual(data.object, 'list');
            assert(Array.isArray(data.data));

            const wbModels = data.data.filter(m => m.id.startsWith('workbuddy/'));
            assert(wbModels.length > 0, 'Expected to find workbuddy/ models in /v1/models');
            console.log(`  → Discovered ${wbModels.length} WorkBuddy models:`);
            console.log(`    ${wbModels.slice(0, 5).map(m => m.id).join(', ')}...`);

            const hasKnownModel = wbModels.some(m =>
                m.id.includes('deepseek') || m.id.includes('hy3') || m.id.includes('hy4') || m.id.includes('gpt')
            );
            assert(hasKnownModel, 'Expected genuine WorkBuddy models (DeepSeek, Hy, or GPT) in model list');
        });

        // 3. Test POST /v1/messages/count_tokens
        await test('POST /v1/messages/count_tokens: returns conservative estimated token count', async () => {
            const res = await request('/v1/messages/count_tokens', {
                method: 'POST',
                body: {
                    model: 'workbuddy/deepseek-v4.1-flash',
                    messages: [
                        { role: 'user', content: 'Hello from WorkBuddy token counter test!' }
                    ]
                }
            });
            assert.strictEqual(res.status, 200);
            const data = res.json();
            assert(data);
            assert(typeof data.input_tokens === 'number');
            assert(data.input_tokens > 0);
            console.log(`  → Estimated input tokens: ${data.input_tokens}`);
        });

        // 4. Test GET /api/workbuddy/accounts (WebUI API)
        await test('GET /api/workbuddy/accounts: returns registered WorkBuddy accounts safely', async () => {
            const res = await request('/api/workbuddy/accounts');
            assert.strictEqual(res.status, 200);
            const data = res.json();
            assert.strictEqual(data.status, 'ok');
            assert(Array.isArray(data.accounts));
            for (const acc of data.accounts) {
                assert.strictEqual(acc.accessToken, undefined, 'Must not expose accessToken');
                assert.strictEqual(acc.refreshToken, undefined, 'Must not expose refreshToken');
                console.log(`  → Account: ${acc.nickname} (ID: ${acc.id}, masked: ${acc.uidMasked}, enabled: ${acc.enabled})`);
            }
        });

        // 5. Test live WorkBuddy upstream chat completion if local machine has auth files
        await test('POST /v1/messages (live WorkBuddy chat completion)', async () => {
            const res = await request('/v1/messages', {
                method: 'POST',
                body: {
                    model: 'workbuddy/deepseek-v4.1-flash',
                    max_tokens: 100,
                    messages: [
                        { role: 'user', content: '请回复五个字：WorkBuddy正常' }
                    ]
                }
            });

            console.log(`  → Upstream response status: HTTP ${res.status}`);
            const data = res.json();
            assert.strictEqual(res.status, 200, `Expected 200 OK from live upstream, got ${res.status}: ${JSON.stringify(data)}`);
            assert.strictEqual(data.type, 'message');
            assert.strictEqual(data.role, 'assistant');
            const replyText = data.content?.[0]?.text || '';
            assert(replyText.length > 0, 'Expected non-empty reply from live WorkBuddy model');
            console.log(`  → Live response: "${replyText.trim()}"`);
            console.log(`  → Usage: input_tokens=${data.usage?.input_tokens}, output_tokens=${data.usage?.output_tokens}`);
        });

    } finally {
        await new Promise(resolve => {
            server.closeAllConnections?.();
            server.close(() => {
                console.log('[SmokeTest] Test server closed cleanly');
                resolve();
            });
        });
    }

    console.log(`\nLive smoke tests completed: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runLiveTest().catch(e => {
    console.error('Smoke test failed:', e);
    process.exit(1);
});
