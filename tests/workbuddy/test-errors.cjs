/**
 * Tests for WorkBuddy error classification.
 */

const assert = require('assert');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║            WORKBUDDY ERROR HANDLING TEST SUITE              ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { parseWorkBuddyError } = await import('../../src/providers/workbuddy/errors.js');

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

    test('HTTP 429 + business code 14018 is insufficient quota, not rate limit', () => {
        const err = parseWorkBuddyError(429, {
            error: {
                data: {
                    code: 14018,
                    msg: '积分已用完'
                }
            }
        });

        assert.strictEqual(err.status, 429);
        assert.strictEqual(err.code, 14018);
        assert.strictEqual(err.type, 'insufficient_quota_error');
        assert.strictEqual(err.retryable, false);
        assert.strictEqual(err.retryAfterMs, null);
        assert.strictEqual(err.message, '积分已用完');
    });

    test('ordinary HTTP 429 remains retryable rate limit', () => {
        const err = parseWorkBuddyError(429, {
            error: {
                code: 'rate_limited',
                message: 'Too many requests'
            }
        });

        assert.strictEqual(err.status, 429);
        assert.strictEqual(err.type, 'rate_limit_error');
        assert.strictEqual(err.retryable, true);
        assert.strictEqual(err.retryAfterMs, 15000);
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
