/**
 * Tests for WorkBuddy Chat Normalizer
 * Verifies that outbound payloads conform to WorkBuddy upstream requirements:
 * - messages[0].role === "system" for international edition
 * - developer -> system role conversion
 * - tool_choice normalization into string form (auto, required, function name)
 * - tool_choice="none" deletes tools and tool_choice
 * - does not duplicate system if already present
 */

const assert = require('assert');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║        WORKBUDDY CHAT NORMALIZER TEST SUITE                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        prepareChatPayload,
        prepareInternationalChatPayload,
        normalizeUpstreamToolChoice
    } = await import('../../src/providers/workbuddy/chat-normalizer.js');

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

    test('International: prepends system when first message is user', () => {
        const payload = {
            model: 'deepseek-v4.1-flash',
            messages: [{ role: 'user', content: 'Hello' }]
        };
        const finalPayload = prepareInternationalChatPayload(payload);
        assert.strictEqual(finalPayload.messages[0].role, 'system');
        assert.strictEqual(finalPayload.messages[0].content, 'You are a helpful assistant.');
        assert.strictEqual(finalPayload.messages[1].role, 'user');
        assert.strictEqual(finalPayload.messages.length, 2);
    });

    test('International: prepends system when first message is tool', () => {
        const payload = {
            model: 'deepseek-v4.1-flash',
            messages: [{ role: 'tool', tool_call_id: 'call_1', content: 'ok' }]
        };
        const finalPayload = prepareInternationalChatPayload(payload);
        assert.strictEqual(finalPayload.messages[0].role, 'system');
        assert.strictEqual(finalPayload.messages[1].role, 'tool');
    });

    test('International: adds system message when messages array is empty', () => {
        const payload = {
            model: 'deepseek-v4.1-flash',
            messages: []
        };
        const finalPayload = prepareInternationalChatPayload(payload);
        assert.strictEqual(finalPayload.messages.length, 1);
        assert.strictEqual(finalPayload.messages[0].role, 'system');
    });

    test('Developer message: converts role=developer to role=system', () => {
        const payload = {
            messages: [
                { role: 'developer', content: 'Developer guidelines' },
                { role: 'user', content: 'Hi' }
            ]
        };
        const finalPayload = prepareChatPayload(payload);
        assert.strictEqual(finalPayload.messages[0].role, 'system');
        assert.strictEqual(finalPayload.messages[0].content, 'Developer guidelines');
    });

    test('Already system first: does not duplicate system message', () => {
        const payload = {
            messages: [
                { role: 'system', content: 'Custom system prompt' },
                { role: 'user', content: 'Hi' }
            ]
        };
        const finalPayload = prepareInternationalChatPayload(payload);
        assert.strictEqual(finalPayload.messages.length, 2);
        assert.strictEqual(finalPayload.messages[0].role, 'system');
        assert.strictEqual(finalPayload.messages[0].content, 'Custom system prompt');
    });

    test('tool_choice: {type: "auto"} -> "auto"', () => {
        const payload = {
            tools: [{ type: 'function', function: { name: 'Read' } }],
            tool_choice: { type: 'auto' }
        };
        const finalPayload = prepareChatPayload(payload);
        assert.strictEqual(finalPayload.tool_choice, 'auto');
    });

    test('tool_choice: {type: "required"} -> "required"', () => {
        const payload = {
            tools: [{ type: 'function', function: { name: 'Read' } }],
            tool_choice: { type: 'required' }
        };
        const finalPayload = prepareChatPayload(payload);
        assert.strictEqual(finalPayload.tool_choice, 'required');
    });

    test('tool_choice: {type: "tool", name: "Read"} -> "Read"', () => {
        const payload = {
            tools: [{ type: 'function', function: { name: 'Read' } }],
            tool_choice: { type: 'tool', name: 'Read' }
        };
        const finalPayload = prepareChatPayload(payload);
        assert.strictEqual(finalPayload.tool_choice, 'Read');
    });

    test('tool_choice: {type: "function", function: {name: "Read"}} -> "Read"', () => {
        const payload = {
            tools: [{ type: 'function', function: { name: 'Read' } }],
            tool_choice: { type: 'function', function: { name: 'Read' } }
        };
        const finalPayload = prepareChatPayload(payload);
        assert.strictEqual(finalPayload.tool_choice, 'Read');
    });

    test('tool_choice: none deletes tool_choice and tools', () => {
        const payload = {
            tools: [{ type: 'function', function: { name: 'Read' } }],
            tool_choice: 'none'
        };
        const finalPayload = prepareChatPayload(payload);
        assert.strictEqual(finalPayload.tool_choice, undefined);
        assert.strictEqual(finalPayload.tools, undefined);
    });

    test('Invariance: final international payload messages[0].role === "system" and stream === true', () => {
        const payload = {
            model: 'deepseek-v4.1-flash',
            stream: false,
            messages: [{ role: 'user', content: 'Test' }]
        };
        const finalPayload = prepareInternationalChatPayload(payload);
        assert.strictEqual(finalPayload.stream, true);
        assert.strictEqual(finalPayload.messages[0].role, 'system');
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
