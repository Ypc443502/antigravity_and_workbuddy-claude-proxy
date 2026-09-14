/**
 * Tests for WorkBuddy Account Manager
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║        WORKBUDDY ACCOUNT MANAGER TEST SUITE                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { WorkBuddyAccountManager } = await import('../../src/providers/workbuddy/account-manager.js');

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

    const tmpDir = path.join(os.tmpdir(), `wb_am_test_${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        // Create 2 test auth files
        const auth1 = {
            auth: { accessToken: 'tok1', refreshToken: 'ref1', expiresAt: Date.now() + 1000000 },
            account: { uid: 'u1', nickname: 'Nick1', enterpriseId: 'ent1' }
        };
        const auth2 = {
            auth: { accessToken: 'tok2', refreshToken: 'ref2', expiresAt: Date.now() + 1000000 },
            account: { uid: 'u2', nickname: 'Nick2', enterpriseId: 'ent2' }
        };

        fs.writeFileSync(path.join(tmpDir, 'account1.info'), JSON.stringify(auth1, null, 2));
        fs.writeFileSync(path.join(tmpDir, 'account2.info'), JSON.stringify(auth2, null, 2));

        const am = new WorkBuddyAccountManager({ authDir: tmpDir, strategy: 'round-robin' });
        await am.initialize();

        // 1. Account registration
        await test('AccountManager: scans and registers all valid accounts', () => {
            assert.strictEqual(am.accounts.length, 2);
            assert(am.accounts.some(a => a.uid === 'u1'));
            assert(am.accounts.some(a => a.uid === 'u2'));
        });

        // 2. Round-Robin selection
        await test('AccountManager: rotates accounts via round-robin', () => {
            const first = am.selectAccount('deepseek-v4-pro');
            const second = am.selectAccount('deepseek-v4-pro');
            const third = am.selectAccount('deepseek-v4-pro');

            assert(first.account);
            assert(second.account);
            assert.notStrictEqual(first.account.id, second.account.id);
            assert.strictEqual(third.account.id, first.account.id);
        });

        // 3. Rate limiting and failover
        await test('AccountManager: skips rate-limited account and selects available one', () => {
            const candidate = am.accounts[0];
            am.markRateLimited(candidate.id, 'deepseek-v4-pro', 60000);

            const selected = am.selectAccount('deepseek-v4-pro');
            assert.strictEqual(selected.account.id, am.accounts[1].id);
        });

        // 4. Reset all rate limits (optimistic retry)
        await test('AccountManager: resets rate limits for optimistic retry', () => {
            am.markRateLimited(am.accounts[1].id, 'deepseek-v4-pro', 60000);
            assert.strictEqual(am.isAllRateLimited('deepseek-v4-pro'), true);

            am.resetAllRateLimits();
            assert.strictEqual(am.isAllRateLimited('deepseek-v4-pro'), false);
        });

        // 5. Enable/Disable account
        await test('AccountManager: respects enabled/disabled state', () => {
            const acc1 = am.accounts[0];
            am.setAccountEnabled(acc1.id, false);
            assert.strictEqual(am.isAccountUsable(am.accounts.find(a => a.id === acc1.id)), false);

            am.setAccountEnabled(acc1.id, true);
            assert.strictEqual(am.isAccountUsable(am.accounts.find(a => a.id === acc1.id)), true);
        });

        // 6. Invalid account marking
        await test('AccountManager: marks account invalid on permanent failure', () => {
            const acc1 = am.accounts[0];
            am.markInvalid(acc1.id, 'Permanent 401 error');
            const acc = am.accounts.find(a => a.id === acc1.id);
            assert.strictEqual(acc.isInvalid, true);
            assert.strictEqual(acc.invalidReason, 'Permanent 401 error');
            assert.strictEqual(am.isAccountUsable(acc), false);
        });

        // 7. Status summary
        await test('AccountManager: getStatus returns safe summary without tokens', () => {
            const status = am.getStatus();
            assert.strictEqual(status.provider, 'workbuddy');
            assert.strictEqual(status.total, 2);
            assert(status.accounts.every(a => a.accessToken === undefined));
            assert(status.accounts.every(a => a.refreshToken === undefined));
        });

        // 8. Remove account (does not delete file)
        await test('AccountManager: removeAccount removes from pool but leaves file on disk', () => {
            const filePath = path.join(tmpDir, 'account2.info');
            assert(fs.existsSync(filePath));

            const acc2 = am.accounts.find(a => a.authFilePath === filePath);
            am.removeAccount(acc2.id);
            assert.strictEqual(am.accounts.length, 1);
            // File must still exist!
            assert(fs.existsSync(filePath));
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
