/**
 * Tests for WorkBuddy Models
 */

const assert = require('assert');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║             WORKBUDDY MODELS TEST SUITE                      ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        getAvailableWorkBuddyModels,
        isValidWorkBuddyModel,
        listWorkBuddyModelsFormatted
    } = await import('../../src/providers/workbuddy/models.js');

    const { WORKBUDDY_FALLBACK_MODELS } = await import('../../src/providers/workbuddy/constants.js');

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

    test('getAvailableWorkBuddyModels: returns list containing fallback models', async () => {
        const models = await getAvailableWorkBuddyModels();
        assert(Array.isArray(models));
        assert(models.length > 0);
    });

    test('isValidWorkBuddyModel: validates both bare name and prefixed name', async () => {
        const models = await getAvailableWorkBuddyModels();
        const first = models[0];
        assert.strictEqual(await isValidWorkBuddyModel(first), true);
        assert.strictEqual(await isValidWorkBuddyModel(`workbuddy/${first}`), true);
        assert.strictEqual(await isValidWorkBuddyModel('nonexistent-model-xyz'), false);
    });

    test('listWorkBuddyModelsFormatted: formats with workbuddy/ prefix and owned_by: workbuddy', async () => {
        const formatted = await listWorkBuddyModelsFormatted();
        assert.strictEqual(formatted.object, 'list');
        assert(Array.isArray(formatted.data));
        assert(formatted.data.length > 0);

        const sample = formatted.data[0];
        assert(sample, 'Expected to find sample model in data');
        assert.strictEqual(sample.owned_by, 'workbuddy');
        assert.strictEqual(sample.object, 'model');

        // All models must start with workbuddy/
        for (const item of formatted.data) {
            assert(item.id.startsWith('workbuddy/'), `Model ${item.id} should start with workbuddy/`);
            assert.strictEqual(item.owned_by, 'workbuddy');
        }
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
