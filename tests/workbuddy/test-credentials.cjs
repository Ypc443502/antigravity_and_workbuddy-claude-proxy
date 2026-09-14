/**
 * Tests for WorkBuddy Credential Manager
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          WORKBUDDY CREDENTIALS TEST SUITE                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { WorkBuddyCredentialManager } = await import('../../src/providers/workbuddy/credentials.js');

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

    const tmpDir = path.join(os.tmpdir(), `wb_cred_test_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        const testAuthFile = path.join(tmpDir, 'test_cred.info');
        const initialAuth = {
            auth: {
                accessToken: 'initial_access_token_123',
                refreshToken: 'initial_refresh_token_456',
                expiresAt: Date.now() + 1000000,
                domain: 'www.codebuddy.cn'
            },
            account: {
                uid: 'user_test_99',
                nickname: 'TesterBob',
                enterpriseId: 'ent_777',
                enterpriseName: 'Test Corp'
            }
        };

        fs.writeFileSync(testAuthFile, JSON.stringify(initialAuth, null, 2), 'utf8');

        // 1. Initialization and reading
        await test('CredentialManager: initializes and loads file data', async () => {
            const cm = new WorkBuddyCredentialManager(testAuthFile);
            assert.strictEqual(cm.data.account.uid, 'user_test_99');
            assert.strictEqual(cm.isTokenExpired(), false);
        });

        // 2. Headers generation
        await test('CredentialManager: generates valid WorkBuddy headers without exposing secrets in summary', async () => {
            const cm = new WorkBuddyCredentialManager(testAuthFile);
            const headers = await cm.getHeaders();
            assert.strictEqual(headers['Authorization'], 'Bearer initial_access_token_123');
            assert.strictEqual(headers['X-User-Id'], 'user_test_99');
            assert.strictEqual(headers['X-Enterprise-Id'], 'ent_777');
            assert.strictEqual(headers['X-Tenant-Id'], 'ent_777');
            assert.strictEqual(headers['X-Domain'], 'www.codebuddy.cn');
            assert(headers['User-Agent'].includes('CodeBuddy') || headers['User-Agent'].includes('WorkBuddy'));

            const summary = cm.getAccountSummary();
            assert(summary.id.includes('user_test_99'), 'Summary ID should contain UID');
            assert.strictEqual(summary.uidMasked, 'us***99');
            assert.strictEqual(summary.nickname, 'TesterBob');
            assert.strictEqual(summary.isExpired, false);
            // Must NOT have accessToken or refreshToken in summary
            assert.strictEqual(summary.accessToken, undefined);
            assert.strictEqual(summary.refreshToken, undefined);
        });

        // 3. Expiry detection
        await test('CredentialManager: correctly detects expired tokens (buffer 60s)', async () => {
            const expiredAuthFile = path.join(tmpDir, 'expired.info');
            const expiredAuth = {
                auth: {
                    accessToken: 'exp_tok',
                    refreshToken: 'exp_ref',
                    expiresAt: Date.now() + 30000 // expires in 30s (< 60s buffer)
                },
                account: { uid: 'exp_u' }
            };
            fs.writeFileSync(expiredAuthFile, JSON.stringify(expiredAuth, null, 2), 'utf8');

            const cm = new WorkBuddyCredentialManager(expiredAuthFile);
            assert.strictEqual(cm.isTokenExpired(), true);
        });

        // 4. Atomic write and mtime reload
        await test('CredentialManager: reloads automatically if file modified externally', async () => {
            const cm = new WorkBuddyCredentialManager(testAuthFile);
            const updatedAuth = {
                auth: {
                    accessToken: 'updated_token_999',
                    refreshToken: 'updated_refresh_888',
                    expiresAt: Date.now() + 2000000,
                    domain: 'www.workbuddy.ai'
                },
                account: {
                    uid: 'user_test_99',
                    nickname: 'TesterBobUpdated',
                    enterpriseId: 'ent_777'
                }
            };

            // Touch & update file
            fs.writeFileSync(testAuthFile, JSON.stringify(updatedAuth, null, 2), 'utf8');
            cm.reloadIfNeeded(true);

            assert.strictEqual(cm.data.auth.accessToken, 'updated_token_999');
            assert.strictEqual(cm.data.account.nickname, 'TesterBobUpdated');
            assert.strictEqual(cm.data.auth.domain, 'www.workbuddy.ai');
        });

    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch (_) {}
    }

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
