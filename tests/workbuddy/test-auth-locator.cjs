/**
 * Tests for WorkBuddy Auth Locator
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           WORKBUDDY AUTH LOCATOR TEST SUITE                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        getDefaultAuthDirectories,
        findAuthFiles,
        readAuthFile,
        validateAuthFile,
        maskUid,
        buildAccountId
    } = await import('../../src/providers/workbuddy/auth-locator.js');

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`✗ ${name}`);
            console.log(`  Error: ${e.message}\n  Stack: ${e.stack}`);
            failed++;
        }
    }

    test('getDefaultAuthDirectories: returns array with platform-specific paths', () => {
        const dirs = getDefaultAuthDirectories();
        assert(Array.isArray(dirs));
        assert(dirs.length > 0);
        // On Windows it should contain CodeBuddyExtension
        assert(dirs.some(d => d.includes('CodeBuddyExtension')));
    });

    test('maskUid: masks sensitive UID characters', () => {
        assert.strictEqual(maskUid(''), 'unknown');
        assert.strictEqual(maskUid('12'), '***');
        assert.strictEqual(maskUid('1234'), '***');
        assert.strictEqual(maskUid('12345678'), '12***78');
        assert.strictEqual(maskUid('u_abcdef123'), 'u_***23');
    });

    test('buildAccountId: formats account ID with edition prefix', () => {
        const data1 = {
            auth: { domain: 'www.codebuddy.cn' },
            account: { uid: '12345', enterpriseId: '999' }
        };
        assert.strictEqual(buildAccountId(data1), 'wb:codebuddy-cn:12345:999');

        const data2 = {
            auth: { domain: 'www.workbuddy.ai' },
            account: { uid: '67890' }
        };
        assert.strictEqual(buildAccountId(data2), 'wb:workbuddy-ai:67890:0');
    });

    test('validateAuthFile: correctly validates .info structures', () => {
        assert.strictEqual(validateAuthFile(null).valid, false);
        assert.strictEqual(validateAuthFile({}).valid, false);
        assert.strictEqual(validateAuthFile({ auth: {} }).valid, false);
        assert.strictEqual(validateAuthFile({ auth: { accessToken: 'a' } }).valid, false);
        assert.strictEqual(validateAuthFile({ auth: { accessToken: 'a', refreshToken: 'r' } }).valid, true);
    });

    test('findAuthFiles and readAuthFile: works with mock directory and files', () => {
        const tmpDir = path.join(os.tmpdir(), `wb_auth_test_${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            const mockAuth = {
                auth: {
                    accessToken: 'test_token',
                    refreshToken: 'test_refresh',
                    expiresAt: Date.now() + 3600000,
                    domain: 'www.codebuddy.cn'
                },
                account: {
                    uid: 'test_user_123',
                    nickname: 'tester',
                    enterpriseId: 'ent_1'
                }
            };

            const filePath = path.join(tmpDir, 'test.info');
            fs.writeFileSync(filePath, JSON.stringify(mockAuth, null, 2), 'utf8');

            const found = findAuthFiles(tmpDir);
            assert.strictEqual(found.length, 1);
            assert.strictEqual(found[0], filePath);

            const readData = readAuthFile(filePath);
            assert.strictEqual(readData.account.uid, 'test_user_123');
            assert.strictEqual(validateAuthFile(readData).valid, true);
        } finally {
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch (_) {}
        }
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
