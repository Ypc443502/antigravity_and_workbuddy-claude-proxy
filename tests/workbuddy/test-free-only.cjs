/**
 * Tests for WorkBuddy free-only safeguards in both provider and WebUI model selection.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║         WORKBUDDY FREE-ONLY PROTECTION TEST SUITE           ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const { WorkBuddyProvider } = await import('../../src/providers/workbuddy/index.js');

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

    function makeProvider(models, freeOnly = true) {
        return new WorkBuddyProvider({
            freeOnly,
            modelCatalogLoader: async () => ({ object: 'list', data: models })
        });
    }

    await test('Provider: free-only allows a catalog model explicitly marked free', async () => {
        const provider = makeProvider([
            { id: 'workbuddy/deepseek-v4.1-flash', free: true, credits: 'x0.00' }
        ]);
        await provider._assertFreeModelAllowed('workbuddy/deepseek-v4.1-flash', {});
    });

    await test('Provider: free-only blocks a paid model before upstream use', async () => {
        const provider = makeProvider([
            { id: 'workbuddy/gpt-5.6-sol', free: false, credits: 'x3.47' }
        ]);
        await assert.rejects(
            () => provider._assertFreeModelAllowed('workbuddy/gpt-5.6-sol', {}),
            err => err.type === 'invalid_request_error' &&
                err.code === 'workbuddy_paid_model_blocked' &&
                err.message.includes('x3.47')
        );
    });

    await test('Provider: unknown/unverifiable model is blocked in free-only mode', async () => {
        const provider = makeProvider([]);
        await assert.rejects(
            () => provider._assertFreeModelAllowed('workbuddy/unknown-model', {}),
            err => err.code === 'workbuddy_free_only_unverified'
        );
    });

    await test('Provider: free-only can be explicitly disabled for compatibility', async () => {
        const provider = makeProvider([
            { id: 'workbuddy/gpt-5.6-sol', free: false, credits: 'x3.47' }
        ], false);
        await provider._assertFreeModelAllowed('workbuddy/gpt-5.6-sol', {});
    });

    function loadClaudeConfigComponent(workbuddyModels) {
        const toasts = [];
        const stores = {
            data: {
                models: workbuddyModels.map(m => m.id),
                groupedModels: {
                    antigravity: [{ id: 'claude-sonnet-4-6' }],
                    workbuddy: workbuddyModels
                }
            },
            global: {
                showToast(message, type) { toasts.push({ message, type }); },
                t(key) { return key; }
            }
        };

        const context = {
            window: { Components: {} },
            Alpine: {
                store(name) { return stores[name]; }
            },
            URL,
            console
        };
        vm.createContext(context);
        const componentPath = path.join(__dirname, '../../public/js/components/claude-config.js');
        vm.runInContext(fs.readFileSync(componentPath, 'utf8'), context, { filename: componentPath });
        const component = context.window.Components.claudeConfig();
        component.config = { env: {} };
        return { component, toasts };
    }

    await test('WebUI: switching to WorkBuddy selects only verified free model for every Claude alias', () => {
        const { component } = loadClaudeConfigComponent([
            { id: 'workbuddy/gpt-6-astra', free: false, credits: 'x6.67' },
            { id: 'workbuddy/deepseek-v4.1-flash', free: true, credits: 'x0.00' },
            { id: 'workbuddy/gpt-5.6-sol', free: false, credits: 'x3.47' }
        ]);

        component.switchProvider('workbuddy');
        const env = component.config.env;
        const expected = 'workbuddy/deepseek-v4.1-flash';
        assert.strictEqual(component.selectedProvider, 'workbuddy');
        assert.strictEqual(env.ANTHROPIC_MODEL, expected);
        assert.strictEqual(env.ANTHROPIC_DEFAULT_OPUS_MODEL, expected);
        assert.strictEqual(env.ANTHROPIC_DEFAULT_SONNET_MODEL, expected);
        assert.strictEqual(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, expected);
        assert.strictEqual(env.CLAUDE_CODE_SUBAGENT_MODEL, expected);
        assert.deepStrictEqual(Array.from(component.getAvailableModels()), [expected]);
    });

    await test('WebUI: paid WorkBuddy model selection is rejected', () => {
        const { component, toasts } = loadClaudeConfigComponent([
            { id: 'workbuddy/deepseek-v4.1-flash', free: true, credits: 'x0.00' },
            { id: 'workbuddy/gpt-5.6-sol', free: false, credits: 'x3.47' }
        ]);
        component.config.env.ANTHROPIC_MODEL = 'workbuddy/deepseek-v4.1-flash';

        component.selectModel('ANTHROPIC_MODEL', 'workbuddy/gpt-5.6-sol');
        assert.strictEqual(component.config.env.ANTHROPIC_MODEL, 'workbuddy/deepseek-v4.1-flash');
        assert(toasts.some(t => t.type === 'warning'));
    });

    await test('WebUI: no verified free model means provider switch is blocked', () => {
        const { component, toasts } = loadClaudeConfigComponent([
            { id: 'workbuddy/gpt-6-astra', free: false, credits: 'x6.67' },
            { id: 'workbuddy/gpt-5.6-sol', free: false, credits: 'x3.47' }
        ]);

        component.switchProvider('workbuddy');
        assert.strictEqual(component.selectedProvider, 'antigravity');
        assert.strictEqual(component.config.env.ANTHROPIC_MODEL, undefined);
        assert(toasts.some(t => t.type === 'warning'));
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
