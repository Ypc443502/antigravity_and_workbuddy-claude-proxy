/**
 * Tests that WorkBuddy insufficient quota errors are not treated as rate limits.
 */

const assert = require('assert');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          WORKBUDDY PROVIDER QUOTA TEST SUITE                ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { WorkBuddyProvider } = await import('../../src/providers/workbuddy/index.js');
    const { parseWorkBuddyError } = await import('../../src/providers/workbuddy/errors.js');

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

    function createProviderHarness() {
        // This suite tests quota retry behavior specifically; free-only behavior has its own tests.
        const provider = new WorkBuddyProvider({ freeOnly: false });
        const accounts = [
            { id: 'a1', uidMasked: 'a***1', credentialManager: {} },
            { id: 'a2', uidMasked: 'a***2', credentialManager: {} }
        ];
        const state = { selectCount: 0, rateLimitCount: 0 };

        provider.initialized = true;
        provider.accountManager = {
            accounts,
            selectAccount() {
                state.selectCount++;
                return { account: accounts[Math.min(state.selectCount - 1, accounts.length - 1)] };
            },
            markRateLimited() {
                state.rateLimitCount++;
            },
            markInvalid() {},
            isAllRateLimited() { return false; },
            resetAllRateLimits() {}
        };

        return { provider, state };
    }

    function quotaError() {
        return parseWorkBuddyError(429, {
            error: { data: { code: 14018, msg: '积分已用完' } }
        });
    }

    const request = {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'Reply exactly: OK' }],
        max_tokens: 32
    };

    await test('sendMessage: 14018 returns immediately without cooldown or account failover', async () => {
        const { provider, state } = createProviderHarness();
        provider._executeSendMessage = async () => { throw quotaError(); };

        await assert.rejects(
            () => provider.sendMessage(request),
            err => err.type === 'insufficient_quota_error' && err.code === 14018
        );

        assert.strictEqual(state.rateLimitCount, 0, '14018 must not mark the account as rate limited');
        assert.strictEqual(state.selectCount, 1, '14018 must not fail over to another account');
    });

    await test('sendMessageStream: 14018 returns immediately without cooldown or account failover', async () => {
        const { provider, state } = createProviderHarness();
        provider.client = {
            async sendChatCompletionStream() {
                throw quotaError();
            }
        };

        const stream = provider.sendMessageStream(request);
        await assert.rejects(
            () => stream.next(),
            err => err.type === 'insufficient_quota_error' && err.code === 14018
        );

        assert.strictEqual(state.rateLimitCount, 0, '14018 must not mark the account as rate limited');
        assert.strictEqual(state.selectCount, 1, '14018 must not fail over to another account');
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
