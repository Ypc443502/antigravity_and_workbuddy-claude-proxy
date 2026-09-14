/**
 * Tests for Provider Router
 */

const assert = require('assert');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║           PROVIDER ROUTER TEST SUITE                         ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { ProviderRouter } = await import('../../src/providers/router.js');
    const { config } = await import('../../src/config.js');

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

    const router = new ProviderRouter();

    test('resolveModel: routes workbuddy/ prefix to workbuddy provider', () => {
        const res = router.resolveModel('workbuddy/deepseek-v4-pro');
        assert.strictEqual(res.providerId, 'workbuddy');
        assert.strictEqual(res.upstreamModel, 'deepseek-v4-pro');
        assert.strictEqual(res.fullModel, 'workbuddy/deepseek-v4-pro');
        assert.strictEqual(res.provider.id, 'workbuddy');
    });

    test('resolveModel: routes antigravity/ prefix to antigravity provider', () => {
        const res = router.resolveModel('antigravity/claude-sonnet-4-6');
        assert.strictEqual(res.providerId, 'antigravity');
        assert.strictEqual(res.upstreamModel, 'claude-sonnet-4-6');
        assert.strictEqual(res.fullModel, 'antigravity/claude-sonnet-4-6');
        assert.strictEqual(res.provider.id, 'antigravity');
    });

    test('resolveModel: unprefixed model defaults to antigravity for backwards compatibility', () => {
        const res = router.resolveModel('claude-sonnet-4-6');
        assert.strictEqual(res.providerId, 'antigravity');
        assert.strictEqual(res.upstreamModel, 'claude-sonnet-4-6');
        assert.strictEqual(res.fullModel, 'claude-sonnet-4-6');
        assert.strictEqual(res.provider.id, 'antigravity');
    });

    test('resolveModel: respects modelMapping alias before provider resolution', () => {
        // Temporarily set modelMapping
        const oldMapping = config.modelMapping;
        try {
            config.modelMapping = {
                'custom-alias': { mapping: 'workbuddy/glm-5.2' },
                'gemini-alias': { mapping: 'antigravity/gemini-3.1-pro-high' }
            };

            const res1 = router.resolveModel('custom-alias');
            assert.strictEqual(res1.providerId, 'workbuddy');
            assert.strictEqual(res1.upstreamModel, 'glm-5.2');

            const res2 = router.resolveModel('gemini-alias');
            assert.strictEqual(res2.providerId, 'antigravity');
            assert.strictEqual(res2.upstreamModel, 'gemini-3.1-pro-high');
        } finally {
            config.modelMapping = oldMapping;
        }
    });

    test('getProvider: throws ProviderError for non-existent provider', () => {
        assert.throws(() => {
            router.getProvider('nonexistent_provider');
        }, /Unknown provider/);
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
