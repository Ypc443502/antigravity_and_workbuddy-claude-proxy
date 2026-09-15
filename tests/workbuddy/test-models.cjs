/**
 * Tests for WorkBuddy Models
 * Verifies document unwrapping, credit normalization,
 * promotion parsing, catalog parsing with CLI agent filtering,
 * and format consistency.
 */

const assert = require('assert');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║             WORKBUDDY MODELS TEST SUITE                      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        unwrapCatalogDocument,
        normalizeCredits,
        extractBadgesFromTags,
        parseActivePromotions,
        parseModelCatalog
    } = await import('../../src/providers/workbuddy/models.js');

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

    test('unwrapCatalogDocument: supports both { code, msg, data } and bare documents', () => {
        const wrapped = { code: 0, msg: 'ok', data: { models: [{ id: 'm1' }], agents: [] } };
        assert.deepStrictEqual(unwrapCatalogDocument(wrapped), wrapped.data);

        const bare = { models: [{ id: 'm2' }], agents: [] };
        assert.deepStrictEqual(unwrapCatalogDocument(bare), bare);
    });

    test('normalizeCredits: normalizes 0, x0.00, x3.47, and complex strings', () => {
        const free1 = normalizeCredits('x0.00');
        assert.strictEqual(free1.credits, 'x0.00');
        assert.strictEqual(free1.isFree, true);
        assert.strictEqual(free1.multiplier, 0);

        const free2 = normalizeCredits(0);
        assert.strictEqual(free2.credits, 'x0.00');
        assert.strictEqual(free2.isFree, true);

        const paid = normalizeCredits('x3.47');
        assert.strictEqual(paid.isFree, false);
        assert.strictEqual(paid.multiplier, 3.47);
        assert.strictEqual(paid.credits, 'x3.47');
    });

    test('extractBadgesFromTags: extracts badge label from tags', () => {
        const tags = ['badge:Free now:#00E599', 'other:tag', 'badge:限时免费:#FF0000'];
        const badges = extractBadgesFromTags(tags);
        assert.deepStrictEqual(badges, ['Free now', '限时免费']);
    });

    test('parseActivePromotions: honors schedule validity', () => {
        const now = 1000000;
        const promos = [
            {
                enabled: true,
                modelIds: ['m1'],
                schedule: { validFrom: new Date(now - 1000).toISOString(), validUntil: new Date(now + 1000).toISOString() },
                badge: { label: 'Active Promo' }
            },
            {
                enabled: true,
                modelIds: ['m2'],
                schedule: { validFrom: new Date(now - 2000).toISOString(), validUntil: new Date(now - 500).toISOString() },
                badge: { label: 'Expired Promo' }
            }
        ];
        const active = parseActivePromotions(promos, now);
        assert(active.has('m1'));
        assert.strictEqual(active.get('m1').badge.label, 'Active Promo');
        assert(!active.has('m2'), 'Expired promotion must not be included');
    });

    test('parseModelCatalog: filters strictly by agents[name="cli"].models and formats metadata', () => {
        const mockDoc = {
            models: [
                { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', maxInputTokens: 300000, maxOutputTokens: 8192, credits: 'x0.00', tags: ['badge:Free now:#00E599'] },
                { id: 'hy3', name: 'Hy3', maxInputTokens: 192000, maxOutputTokens: 8192, credits: 'x0.00' },
                { id: 'gpt-6-astra', name: 'GPT-6-Astra', maxInputTokens: 400000, maxOutputTokens: 8192, credits: 'x6.67' },
                { id: 'disabled-model', name: 'Disabled', disabled: true, maxInputTokens: 1000, maxOutputTokens: 1000 },
                { id: 'unauthorized-model', name: 'Not in CLI', maxInputTokens: 1000, maxOutputTokens: 1000 }
            ],
            agents: [
                { name: 'cli', models: ['deepseek-v4.1-flash', 'hy3', 'gpt-6-astra', 'disabled-model'] }
            ]
        };

        const parsed = parseModelCatalog(mockDoc, true);
        assert.strictEqual(parsed.length, 3, 'Should only contain authorized, enabled models in CLI agent');

        const m0 = parsed[0];
        assert.strictEqual(m0.id, 'workbuddy/deepseek-v4.1-flash');
        assert.strictEqual(m0.upstreamId, 'deepseek-v4.1-flash');
        assert.strictEqual(m0.name, 'Deepseek-V4.1-Flash');
        assert.strictEqual(m0.billing.free, true);
        assert.strictEqual(m0.billing.credits, 'x0.00');
        assert(m0.badges.includes('Free now'));

        const m2 = parsed[2];
        assert.strictEqual(m2.id, 'workbuddy/gpt-6-astra');
        assert.strictEqual(m2.billing.free, false);
        assert.strictEqual(m2.billing.credits, 'x6.67');
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
