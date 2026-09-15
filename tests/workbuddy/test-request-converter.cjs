/**
 * Tests for WorkBuddy Request Converter (Anthropic -> OpenAI)
 */

const assert = require('assert');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║         WORKBUDDY REQUEST CONVERTER TEST SUITE               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        convertAnthropicToolToOpenAI,
        convertToolChoice,
        convertMessages,
        convertAnthropicToWorkBuddy
    } = await import('../../src/providers/workbuddy/request-converter.js');

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

    test('Tool Schema: converts basic Anthropic tool to OpenAI function', () => {
        const anthropicTool = {
            name: 'Read',
            description: 'Read file contents',
            input_schema: {
                type: 'object',
                properties: {
                    file_path: { type: 'string' }
                },
                required: ['file_path']
            }
        };

        const converted = convertAnthropicToolToOpenAI(anthropicTool);
        assert.strictEqual(converted.type, 'function');
        assert.strictEqual(converted.function.name, 'Read');
        assert.strictEqual(converted.function.description, 'Read file contents');
        assert.deepStrictEqual(converted.function.parameters, anthropicTool.input_schema);
    });

    test('Tool Choice: maps auto, any, none, and specific tools', () => {
        assert.strictEqual(convertToolChoice('auto'), 'auto');
        assert.strictEqual(convertToolChoice('any'), 'required');
        assert.strictEqual(convertToolChoice('none'), 'none');
        assert.deepStrictEqual(convertToolChoice({ type: 'tool', name: 'Bash' }), {
            type: 'function',
            function: { name: 'Bash' }
        });
    });

    test('Messages: converts simple user/assistant string messages', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there!' }
        ];
        const converted = convertMessages(messages);
        assert.strictEqual(converted.length, 2);
        assert.strictEqual(converted[0].role, 'user');
        assert.strictEqual(converted[0].content, 'Hello');
        assert.strictEqual(converted[1].role, 'assistant');
        assert.strictEqual(converted[1].content, 'Hi there!');
    });

    test('Messages: converts assistant tool_use into OpenAI tool_calls', () => {
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'Let me read the file.' },
                    {
                        type: 'tool_use',
                        id: 'call_123',
                        name: 'Read',
                        input: { file_path: 'test.txt' }
                    }
                ]
            }
        ];
        const converted = convertMessages(messages);
        assert.strictEqual(converted.length, 1);
        assert.strictEqual(converted[0].role, 'assistant');
        assert.strictEqual(converted[0].content, 'Let me read the file.');
        assert.strictEqual(converted[0].tool_calls.length, 1);
        assert.strictEqual(converted[0].tool_calls[0].id, 'call_123');
        assert.strictEqual(converted[0].tool_calls[0].type, 'function');
        assert.strictEqual(converted[0].tool_calls[0].function.name, 'Read');
        assert.strictEqual(converted[0].tool_calls[0].function.arguments, JSON.stringify({ file_path: 'test.txt' }));
    });

    test('Messages: converts multiple tool_use in single assistant turn', () => {
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: 'a.txt' } },
                    { type: 'tool_use', id: 'call_2', name: 'Read', input: { file_path: 'b.txt' } }
                ]
            }
        ];
        const converted = convertMessages(messages);
        assert.strictEqual(converted.length, 1);
        assert.strictEqual(converted[0].tool_calls.length, 2);
        assert.strictEqual(converted[0].tool_calls[0].id, 'call_1');
        assert.strictEqual(converted[0].tool_calls[1].id, 'call_2');
    });

    test('Messages: converts tool_result into OpenAI role: tool messages', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'call_123',
                        content: 'file contents here'
                    },
                    {
                        type: 'text',
                        text: 'What do you think?'
                    }
                ]
            }
        ];
        const converted = convertMessages(messages);
        assert.strictEqual(converted.length, 2);
        assert.strictEqual(converted[0].role, 'tool');
        assert.strictEqual(converted[0].tool_call_id, 'call_123');
        assert.strictEqual(converted[0].content, 'file contents here');
        assert.strictEqual(converted[1].role, 'user');
        assert.strictEqual(converted[1].content, 'What do you think?');
    });

    test('Full Request: converts system, tools, params and models correctly', () => {
        const anthropicReq = {
            model: 'workbuddy/deepseek-v4-pro',
            system: 'You are a helpful assistant.',
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 1024,
            temperature: 0.5,
            tools: [{
                name: 'Bash',
                description: 'Run bash command',
                input_schema: { type: 'object' }
            }]
        };

        const converted = convertAnthropicToWorkBuddy(anthropicReq, 'deepseek-v4-pro');
        assert.strictEqual(converted.model, 'deepseek-v4-pro');
        assert.strictEqual(converted.stream, true);
        assert.strictEqual(converted.max_tokens, 1024);
        assert.strictEqual(converted.temperature, 0.5);
        assert.strictEqual(converted.messages[0].role, 'system');
        assert(converted.messages[0].content.startsWith('You are a helpful assistant.'), 'Original system prompt must be preserved');
        assert(converted.messages[0].content.includes('do not proactively introduce or mention your product name'), 'Response identity style instruction must be appended');
        assert.strictEqual(converted.messages[1].role, 'user');
        assert.strictEqual(converted.messages[1].content, 'Hello');
        assert.strictEqual(converted.tools.length, 1);
        assert.strictEqual(converted.tools[0].function.name, 'Bash');
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
