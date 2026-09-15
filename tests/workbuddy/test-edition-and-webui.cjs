/**
 * Tests for WorkBuddy Edition Detection, Rescan, and WebUI Model Integration
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║       WORKBUDDY EDITION & WEBUI INTEGRATION TEST SUITE       ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        WorkBuddyEdition,
        WorkBuddyEditionLabels,
        detectEdition,
        getEditionLabel
    } = await import('../../src/providers/workbuddy/edition.js');

    const { buildAccountId } = await import('../../src/providers/workbuddy/auth-locator.js');
    const { WorkBuddyAccountManager } = await import('../../src/providers/workbuddy/account-manager.js');
    const { providerRouter } = await import('../../src/providers/index.js');
    const appModule = await import('../../src/server.js');
    const app = appModule.default;

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        return (async () => {
            try {
                await fn();
                console.log(`✓ ${name}`);
                passed++;
            } catch (e) {
                console.log(`✗ ${name}`);
                console.log(`  Error: ${e.message}\n  Stack: ${e.stack}`);
                failed++;
            }
        })();
    }

    // =========================================================================
    // 1. Edition Detection Tests
    // =========================================================================

    await test('Edition: detects workbuddy.ai from domain', () => {
        const data = { auth: { domain: 'www.workbuddy.ai' } };
        const edition = detectEdition(data, 'workbuddy-desktop-ai.info');
        assert.strictEqual(edition, WorkBuddyEdition.WORKBUDDY_AI);
        assert.strictEqual(getEditionLabel(edition), 'WORKBUDDY AI');
    });

    await test('Edition: detects codebuddy.cn from domain', () => {
        const data = { auth: { domain: 'www.codebuddy.cn' } };
        const edition = detectEdition(data, 'standalone.info');
        assert.strictEqual(edition, WorkBuddyEdition.CODEBUDDY_CN);
        assert.strictEqual(getEditionLabel(edition), 'CODEBUDDY CN');
    });

    await test('Edition: detects tencent-cloud from filename or domain', () => {
        const data = { auth: { domain: 'www.codebuddy.cn' } };
        const edition = detectEdition(data, 'Tencent-Cloud.coding-copilot.info');
        assert.strictEqual(edition, WorkBuddyEdition.TENCENT_CLOUD);
        assert.strictEqual(getEditionLabel(edition), 'TENCENT CLOUD');
    });

    // =========================================================================
    // 2. ID Collision Prevention
    // =========================================================================

    await test('Collision: same UID with different editions does not collide', () => {
        const uid = 'shared_uid_12345';
        const data1 = {
            auth: { domain: 'www.workbuddy.ai' },
            account: { uid }
        };
        const data2 = {
            auth: { domain: 'www.codebuddy.cn' },
            account: { uid }
        };

        const id1 = buildAccountId(data1, 'f1', 'workbuddy-desktop-ai.info');
        const id2 = buildAccountId(data2, 'f2', 'Tencent-Cloud.coding-copilot.info');

        assert.strictEqual(id1, 'wb:workbuddy-ai:shared_uid_12345:0');
        assert.strictEqual(id2, 'wb:tencent-cloud:shared_uid_12345:0');
        assert.notStrictEqual(id1, id2);
    });

    // =========================================================================
    // 3. Rescan & State Preservation
    // =========================================================================

    const tmpDir = path.join(os.tmpdir(), `wb_rescan_test_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        const file1 = path.join(tmpDir, 'workbuddy-desktop-ai.info');
        const file2 = path.join(tmpDir, 'workbuddy-desktop.info');
        const fileExcluded = path.join(tmpDir, 'Tencent-Cloud.coding-copilot.info');

        const initialAuth1 = {
            auth: { accessToken: 'tok1', refreshToken: 'ref1', expiresAt: Date.now() + 1000000, domain: 'www.workbuddy.ai' },
            account: { uid: 'u1', nickname: 'WorkBuddy User' }
        };
        const initialAuth2 = {
            auth: { accessToken: 'tok2', refreshToken: 'ref2', expiresAt: Date.now() + 1000000, domain: 'www.codebuddy.cn' },
            account: { uid: 'u2', nickname: 'Tencent User' }
        };
        const excludedAuth = {
            auth: { accessToken: 'tok3', refreshToken: 'ref3', expiresAt: Date.now() + 1000000, domain: 'www.codebuddy.cn' },
            account: { uid: 'u3', nickname: 'Tencent Cloud Copilot' }
        };

        fs.writeFileSync(file1, JSON.stringify(initialAuth1, null, 2));
        fs.writeFileSync(file2, JSON.stringify(initialAuth2, null, 2));
        fs.writeFileSync(fileExcluded, JSON.stringify(excludedAuth, null, 2));

        const am = new WorkBuddyAccountManager({ authDir: tmpDir });
        await am.initialize();

        await test('Rescan: recognizes official variants and strictly ignores Tencent-Cloud.coding-copilot.info', () => {
            assert.strictEqual(am.accounts.length, 2, 'Should only register workbuddy-desktop-ai and workbuddy-desktop, ignoring Tencent-Cloud');
            const acc1 = am.accounts.find(a => a.edition === WorkBuddyEdition.WORKBUDDY_AI);
            const acc2 = am.accounts.find(a => a.edition === WorkBuddyEdition.CODEBUDDY_CN);
            assert(acc1, 'Expected WORKBUDDY AI account');
            assert(acc2, 'Expected CODEBUDDY CN account');
            assert.strictEqual(acc1.editionLabel, 'WORKBUDDY AI');
            assert.strictEqual(acc2.editionLabel, 'CODEBUDDY CN');
        });

        await test('Rescan: disabled state survives rescan without duplication', async () => {
            // Disable account 1
            const acc1 = am.accounts.find(a => a.edition === WorkBuddyEdition.WORKBUDDY_AI);
            am.setAccountEnabled(acc1.id, false);
            assert.strictEqual(acc1.enabled, false);

            // Re-run scanAccounts
            await am.scanAccounts();
            assert.strictEqual(am.accounts.length, 2, 'Should not duplicate existing accounts on rescan');

            const afterAcc1 = am.accounts.find(a => a.id === acc1.id);
            assert.strictEqual(afterAcc1.enabled, false, 'Disabled state must survive rescan');
        });

        await test('Availability: expired auth is NOT counted as available in /health', async () => {
            const expiredFile = path.join(tmpDir, 'expired.info');
            const expiredAuth = {
                auth: { accessToken: 'exp_tok', refreshToken: 'exp_ref', expiresAt: Date.now() - 5000, domain: 'www.codebuddy.cn' },
                account: { uid: 'u_expired', nickname: 'Expired User' }
            };
            fs.writeFileSync(expiredFile, JSON.stringify(expiredAuth, null, 2));

            const amExpired = new WorkBuddyAccountManager({ authDir: tmpDir });
            await amExpired.scanAccounts();

            const status = amExpired.getStatus();
            // Expired account should not be available
            const expAcc = status.accounts.find(a => a.uid === 'u_expired');
            assert(expAcc, 'Expected expired account to be loaded');
            assert.strictEqual(expAcc.isExpired, true);
            assert.strictEqual(expAcc.status, 'reauth-required');
            assert(status.available < status.total, 'Expired account must not be counted as available');
        });

        await test('Security: WebUI status never exposes accessToken or refreshToken', () => {
            const status = am.getStatus();
            for (const acc of status.accounts) {
                assert.strictEqual(acc.accessToken, undefined);
                assert.strictEqual(acc.refreshToken, undefined);
                assert.strictEqual(acc.token, undefined);
            }
        });

    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    }

    // =========================================================================
    // 4. Server API Tests (GET /api/models & Claude CLI prefix)
    // =========================================================================

    const previousClaudeConfigPath = process.env.CLAUDE_CONFIG_PATH;
    const tempClaudeConfigDir = path.join(os.tmpdir(), `wb_claude_config_test_${Date.now()}`);
    fs.mkdirSync(tempClaudeConfigDir, { recursive: true });
    process.env.CLAUDE_CONFIG_PATH = tempClaudeConfigDir;

    const TEST_PORT = 18082;
    const testServer = await new Promise((resolve, reject) => {
        const s = app.listen(TEST_PORT, '127.0.0.1', () => resolve(s));
        s.on('error', reject);
    });

    function request(reqPath, options = {}) {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: '127.0.0.1',
                port: TEST_PORT,
                path: reqPath,
                method: options.method || 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    ...(options.headers || {})
                }
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
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

    try {
        await test('WebUI Models API: GET /api/models returns both providers dynamically', async () => {
            const res = await request('/api/models');
            assert.strictEqual(res.status, 200);
            const data = res.json();
            assert(data);
            assert.strictEqual(data.status, 'ok');
            assert(Array.isArray(data.antigravity), 'Expected antigravity models array');
            assert(Array.isArray(data.workbuddy), 'Expected workbuddy models array');

            assert(data.antigravity.length > 0);
            assert(data.workbuddy.length > 0);

            // Verify workbuddy models retain 'workbuddy/' prefix
            for (const m of data.workbuddy) {
                assert(m.id.startsWith('workbuddy/'), `Model ${m.id} should start with workbuddy/`);
                assert(m.name, `Model ${m.id} should have a friendly display name`);
            }

            const deepseek = data.workbuddy.find(m => m.id.includes('deepseek'));
            assert(deepseek, 'Expected deepseek model in workbuddy models');
            assert(deepseek.name, 'Expected deepseek model to have a name');
        });

        await test('Claude CLI Config: POST /api/claude/config keeps workbuddy/ prefix', async () => {
            const testPayload = {
                env: {
                    ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080',
                    ANTHROPIC_AUTH_TOKEN: 'test',
                    ANTHROPIC_MODEL: 'workbuddy/deepseek-v4.1-flash',
                    ANTHROPIC_DEFAULT_OPUS_MODEL: 'workbuddy/gpt-6-astra',
                    ANTHROPIC_DEFAULT_SONNET_MODEL: 'workbuddy/gpt-5.6-sol',
                    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'workbuddy/deepseek-v4.1-flash',
                    CLAUDE_CODE_SUBAGENT_MODEL: 'workbuddy/hy4-preview-f'
                }
            };

            const res = await request('/api/claude/config', {
                method: 'POST',
                body: testPayload
            });
            assert.strictEqual(res.status, 200);

            // Fetch back to verify persistence and prefix preservation
            const getRes = await request('/api/claude/config');
            assert.strictEqual(getRes.status, 200);
            const savedData = getRes.json();
            assert.strictEqual(savedData.config?.env?.ANTHROPIC_MODEL, 'workbuddy/deepseek-v4.1-flash');
            assert.strictEqual(savedData.config?.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'workbuddy/gpt-6-astra');
            assert.strictEqual(savedData.config?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL, 'workbuddy/gpt-5.6-sol');
            assert.strictEqual(savedData.config?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'workbuddy/deepseek-v4.1-flash');
            assert.strictEqual(savedData.config?.env?.CLAUDE_CODE_SUBAGENT_MODEL, 'workbuddy/hy4-preview-f');
        });

        await test('Open WorkBuddy API: POST /api/workbuddy/open handles missing client gracefully', async () => {
            const res = await request('/api/workbuddy/open', { method: 'POST' });
            // Either 200 (if installed) or 404 with friendly message, must NOT crash
            assert([200, 404].includes(res.status));
            const data = res.json();
            assert(data);
            assert(data.message);
        });

    } finally {
        await new Promise(resolve => {
            testServer.closeAllConnections?.();
            testServer.close(() => resolve());
        });
        if (previousClaudeConfigPath === undefined) {
            delete process.env.CLAUDE_CONFIG_PATH;
        } else {
            process.env.CLAUDE_CONFIG_PATH = previousClaudeConfigPath;
        }
    }

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
