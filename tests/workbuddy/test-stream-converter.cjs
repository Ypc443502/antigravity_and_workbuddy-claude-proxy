/**
 * Tests for WorkBuddy Stream Converter (OpenAI SSE -> Anthropic Event Stream)
 */

const assert = require('assert');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║          WORKBUDDY STREAM CONVERTER TEST SUITE               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const {
        mapFinishReason,
        parseSSEBuffer,
        convertOpenAIToAnthropicStream,
        aggregateOpenAIToAnthropicMessage
    } = await import('../../src/providers/workbuddy/stream-converter.js');

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

    // 1. Finish reason mapping
    await test('finish_reason: maps OpenAI finish reasons to Anthropic stop reasons', () => {
        assert.strictEqual(mapFinishReason('stop'), 'end_turn');
        assert.strictEqual(mapFinishReason('tool_calls'), 'tool_use');
        assert.strictEqual(mapFinishReason('length'), 'max_tokens');
        assert.strictEqual(mapFinishReason('content_filter'), 'end_turn');
        assert.strictEqual(mapFinishReason(null), 'end_turn');
    });

    // 2. parseSSEBuffer
    await test('parseSSEBuffer: parses complete lines and preserves incomplete trailing line', () => {
        const input = 'data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b":';
        const { events, remaining } = parseSSEBuffer(input);
        assert.strictEqual(events.length, 2);
        assert.deepStrictEqual(events[0], { isDone: false, data: { a: 1 } });
        assert.deepStrictEqual(events[1], { isDone: true });
        assert.strictEqual(remaining, 'data: {"b":');
    });

    // 3. Text streaming
    await test('Stream: converts text stream into Anthropic events sequence', async () => {
        async function* makeChunks() {
            yield 'data: {"id":"chat_1","choices":[{"delta":{"content":"Hello"}}],"usage":null}\n\n';
            yield 'data: {"id":"chat_1","choices":[{"delta":{"content":" world!"}}],"usage":null}\n\n';
            yield 'data: {"id":"chat_1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n';
            yield 'data: [DONE]\n\n';
        }

        const events = [];
        for await (const event of convertOpenAIToAnthropicStream(makeChunks(), 'workbuddy/deepseek-v4-pro')) {
            events.push(event);
        }

        const types = events.map(e => e.type);
        assert.deepStrictEqual(types, [
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);

        assert.strictEqual(events[0].message.model, 'workbuddy/deepseek-v4-pro');
        assert.strictEqual(events[1].content_block.type, 'text');
        assert.strictEqual(events[2].delta.text, 'Hello');
        assert.strictEqual(events[3].delta.text, ' world!');
        assert.strictEqual(events[5].delta.stop_reason, 'end_turn');
        assert.strictEqual(events[5].usage.output_tokens, 5);
    });

    // 4. Tool call streaming with fragmented arguments
    await test('Stream: converts fragmented tool calls stream into tool_use blocks', async () => {
        async function* makeToolChunks() {
            // Fragment 1: tool call init
            yield `data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: "call_999",
                            type: "function",
                            function: {
                                name: "Read",
                                arguments: '{"file'
                            }
                        }]
                    }
                }],
                usage: null
            })}\n\n`;

            // Fragment 2: tool call args continuation
            yield `data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            function: {
                                arguments: '_path": "'
                            }
                        }]
                    }
                }],
                usage: null
            })}\n\n`;

            // Fragment 3: tool call args completion
            yield `data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            function: {
                                arguments: 'test.txt"}'
                            }
                        }]
                    }
                }],
                usage: null
            })}\n\n`;

            // Fragment 4: finish
            yield `data: ${JSON.stringify({
                choices: [{
                    delta: {},
                    finish_reason: "tool_calls"
                }],
                usage: { prompt_tokens: 20, completion_tokens: 15 }
            })}\n\n`;

            yield 'data: [DONE]\n\n';
        }

        const events = [];
        for await (const event of convertOpenAIToAnthropicStream(makeToolChunks(), 'workbuddy/glm-5.2')) {
            events.push(event);
        }

        const types = events.map(e => e.type);
        assert.deepStrictEqual(types, [
            'message_start',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop'
        ]);

        assert.strictEqual(events[1].content_block.type, 'tool_use');
        assert.strictEqual(events[1].content_block.id, 'call_999');
        assert.strictEqual(events[1].content_block.name, 'Read');
        assert.strictEqual(events[2].delta.type, 'input_json_delta');
        assert.strictEqual(events[2].delta.partial_json, '{"file');
        assert.strictEqual(events[3].delta.partial_json, '_path": "');
        assert.strictEqual(events[4].delta.partial_json, 'test.txt"}');
        assert.strictEqual(events[6].delta.stop_reason, 'tool_use');
    });

    // 5. Multiple tool calls in stream
    await test('Stream: handles multiple tool calls at different indices', async () => {
        async function* makeMultiToolChunks() {
            yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ToolA","arguments":"{}"}}]}}]}\n\n';
            yield 'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"c2","function":{"name":"ToolB","arguments":"{}"}}]}}]}\n\n';
            yield 'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n';
            yield 'data: [DONE]\n\n';
        }

        const events = [];
        for await (const event of convertOpenAIToAnthropicStream(makeMultiToolChunks(), 'workbuddy/deepseek-v4-pro')) {
            events.push(event);
        }

        const starts = events.filter(e => e.type === 'content_block_start');
        assert.strictEqual(starts.length, 2);
        assert.strictEqual(starts[0].content_block.name, 'ToolA');
        assert.strictEqual(starts[1].content_block.name, 'ToolB');
    });

    // 6. aggregateOpenAIToAnthropicMessage
    await test('Non-streaming: aggregateOpenAIToAnthropicMessage builds full response', async () => {
        async function* makeChunks() {
            yield `data: ${JSON.stringify({
                choices: [{ delta: { content: 'Thinking... ' } }]
            })}\n\n`;
            yield `data: ${JSON.stringify({
                choices: [{ delta: { content: 'Done!' } }]
            })}\n\n`;
            yield `data: ${JSON.stringify({
                choices: [{
                    delta: {
                        tool_calls: [{
                            index: 0,
                            id: 'call_1',
                            function: {
                                name: 'Read',
                                arguments: '{"path":"a.js"}'
                            }
                        }]
                    }
                }]
            })}\n\n`;
            yield `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: 'tool_calls' }],
                usage: { prompt_tokens: 100, completion_tokens: 50 }
            })}\n\n`;
            yield 'data: [DONE]\n\n';
        }

        const message = await aggregateOpenAIToAnthropicMessage(makeChunks(), 'workbuddy/deepseek-v4-pro');
        assert.strictEqual(message.type, 'message');
        assert.strictEqual(message.role, 'assistant');
        assert.strictEqual(message.model, 'workbuddy/deepseek-v4-pro');
        assert.strictEqual(message.stop_reason, 'tool_use');
        assert.strictEqual(message.usage.input_tokens, 100);
        assert.strictEqual(message.usage.output_tokens, 50);

        assert.strictEqual(message.content.length, 2);
        assert.strictEqual(message.content[0].type, 'text');
        assert.strictEqual(message.content[0].text, 'Thinking... Done!');
        assert.strictEqual(message.content[1].type, 'tool_use');
        assert.strictEqual(message.content[1].id, 'call_1');
        assert.strictEqual(message.content[1].name, 'Read');
        assert.deepStrictEqual(message.content[1].input, { path: 'a.js' });
    });

    console.log(`\nTests completed: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

runTests().catch(e => {
    console.error('Test suite failed:', e);
    process.exit(1);
});
