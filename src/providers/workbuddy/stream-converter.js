/**
 * OpenAI SSE -> Anthropic Event Stream Converter
 *
 * Converts SSE data stream from WorkBuddy /v2/chat/completions into
 * Anthropic Messages API compatible event objects (for streaming)
 * and full message objects (for non-streaming).
 */

import crypto from 'crypto';

/**
 * Map OpenAI finish_reason to Anthropic stop_reason
 * @param {string|null} finishReason
 * @returns {'end_turn'|'tool_use'|'max_tokens'|'stop_sequence'}
 */
export function mapFinishReason(finishReason) {
    switch (finishReason) {
        case 'tool_calls':
            return 'tool_use';
        case 'length':
            return 'max_tokens';
        case 'content_filter':
            return 'end_turn';
        case 'stop':
        default:
            return 'end_turn';
    }
}

/**
 * Parse an SSE line buffer into OpenAI JSON objects.
 * Handles multiline data, [DONE], and invalid JSON gracefully.
 *
 * @param {string} buffer
 * @returns {{ events: Object[], remaining: string }}
 */
export function parseSSEBuffer(buffer) {
    const events = [];
    const lines = buffer.split('\n');
    const remaining = lines.pop() ?? ''; // Keep the incomplete trailing line in buffer

    for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith(':')) {
            // Keep-alive or comment
            continue;
        }

        if (line.startsWith('data: ')) {
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') {
                events.push({ isDone: true });
                continue;
            }

            try {
                const parsed = JSON.parse(dataStr);
                events.push({ isDone: false, data: parsed });
            } catch (_) {
                // Invalid JSON SSE chunk, skip
            }
        }
    }

    return { events, remaining };
}

/**
 * Async generator converting raw incoming chunks from WorkBuddy SSE response
 * into Anthropic event objects.
 *
 * @param {AsyncIterable<Buffer|Uint8Array|string>} byteStream - Incoming byte or string stream
 * @param {string} fullModelName - Model ID (e.g. 'workbuddy/deepseek-v4-pro')
 * @param {Object} [options]
 * @param {boolean} [options.exposeReasoning=false] - Whether to expose reasoning content
 * @yields {Object} Anthropic SSE event objects (type: message_start, content_block_start, etc.)
 */
export async function* convertOpenAIToAnthropicStream(byteStream, fullModelName, options = {}) {
    const exposeReasoning = options.exposeReasoning ?? false;
    const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`;

    let hasStarted = false;
    let currentBlockIndex = 0;

    // Track active content blocks
    // activeBlock: null | { type: 'text', index: number } | { type: 'tool_use', index: number, id: string }
    let activeBlock = null;

    // Track tool calls across chunks: toolIndex -> { id, name, arguments, blockIndex, started }
    const toolCallsMap = new Map();

    const usage = {
        input_tokens: 0,
        output_tokens: 0
    };

    let finalStopReason = 'end_turn';
    let rawBuffer = '';
    const decoder = new TextDecoder('utf8');

    for await (const chunk of byteStream) {
        const textChunk = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        rawBuffer += textChunk;

        const { events, remaining } = parseSSEBuffer(rawBuffer);
        rawBuffer = remaining;

        for (const ev of events) {
            if (ev.isDone) {
                continue;
            }

            const chunkData = ev.data;
            if (!chunkData) continue;

            // Track usage from chunk if provided
            if (chunkData.usage) {
                if (typeof chunkData.usage.prompt_tokens === 'number') {
                    usage.input_tokens = chunkData.usage.prompt_tokens;
                }
                if (typeof chunkData.usage.completion_tokens === 'number') {
                    usage.output_tokens = chunkData.usage.completion_tokens;
                }
            }

            // Emit message_start on the very first event
            if (!hasStarted) {
                hasStarted = true;
                yield {
                    type: 'message_start',
                    message: {
                        id: messageId,
                        type: 'message',
                        role: 'assistant',
                        model: fullModelName,
                        content: [],
                        stop_reason: null,
                        stop_sequence: null,
                        usage: {
                            input_tokens: usage.input_tokens,
                            output_tokens: 0
                        }
                    }
                };
            }

            const choices = chunkData.choices || [];
            if (choices.length === 0) {
                continue;
            }

            const choice = choices[0];
            const delta = choice.delta || {};

            // Check finish reason
            if (choice.finish_reason) {
                finalStopReason = mapFinishReason(choice.finish_reason);
            }

            // 1. Handle regular text content
            if (delta.content) {
                // If active block is tool_use, close it before opening text
                if (activeBlock && activeBlock.type !== 'text') {
                    yield {
                        type: 'content_block_stop',
                        index: activeBlock.index
                    };
                    activeBlock = null;
                }

                // If not in a text block, start one
                if (!activeBlock) {
                    const blockIndex = currentBlockIndex++;
                    yield {
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: {
                            type: 'text',
                            text: ''
                        }
                    };
                    activeBlock = { type: 'text', index: blockIndex };
                }

                yield {
                    type: 'content_block_delta',
                    index: activeBlock.index,
                    delta: {
                        type: 'text_delta',
                        text: delta.content
                    }
                };
            }

            // 2. Handle reasoning content (optional, false by default)
            if (exposeReasoning && delta.reasoning_content) {
                // For future extension if enabled; never fabricate signature
                if (!activeBlock) {
                    const blockIndex = currentBlockIndex++;
                    yield {
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: {
                            type: 'text',
                            text: ''
                        }
                    };
                    activeBlock = { type: 'text', index: blockIndex };
                }
                yield {
                    type: 'content_block_delta',
                    index: activeBlock.index,
                    delta: {
                        type: 'text_delta',
                        text: delta.reasoning_content
                    }
                };
            }

            // 3. Handle tool calls streaming
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                for (const tc of delta.tool_calls) {
                    const tcIndex = tc.index ?? 0;
                    let toolInfo = toolCallsMap.get(tcIndex);

                    if (!toolInfo) {
                        // Close any active text block before starting a tool call
                        if (activeBlock && activeBlock.type === 'text') {
                            yield {
                                type: 'content_block_stop',
                                index: activeBlock.index
                            };
                            activeBlock = null;
                        } else if (activeBlock && activeBlock.type === 'tool_use' && activeBlock.tcIndex !== tcIndex) {
                            yield {
                                type: 'content_block_stop',
                                index: activeBlock.index
                            };
                            activeBlock = null;
                        }

                        const blockIndex = currentBlockIndex++;
                        toolInfo = {
                            id: tc.id || `call_${crypto.randomBytes(8).toString('hex')}`,
                            name: tc.function?.name || '',
                            arguments: '',
                            blockIndex: blockIndex,
                            started: false,
                            tcIndex: tcIndex
                        };
                        toolCallsMap.set(tcIndex, toolInfo);
                    } else {
                        if (tc.id) toolInfo.id = tc.id;
                        if (tc.function?.name) toolInfo.name = tc.function.name;
                    }

                    // Emit content_block_start if not yet emitted
                    if (!toolInfo.started) {
                        yield {
                            type: 'content_block_start',
                            index: toolInfo.blockIndex,
                            content_block: {
                                type: 'tool_use',
                                id: toolInfo.id,
                                name: toolInfo.name,
                                input: {}
                            }
                        };
                        toolInfo.started = true;
                        activeBlock = { type: 'tool_use', index: toolInfo.blockIndex, tcIndex: tcIndex };
                    }

                    // Stream partial argument json
                    if (tc.function?.arguments) {
                        toolInfo.arguments += tc.function.arguments;
                        yield {
                            type: 'content_block_delta',
                            index: toolInfo.blockIndex,
                            delta: {
                                type: 'input_json_delta',
                                partial_json: tc.function.arguments
                            }
                        };
                    }
                }
            }
        }
    }

    // End of stream cleanup: close active block if still open
    if (activeBlock) {
        yield {
            type: 'content_block_stop',
            index: activeBlock.index
        };
        activeBlock = null;
    }

    // If stream ended without any message_start (e.g. empty response)
    if (!hasStarted) {
        yield {
            type: 'message_start',
            message: {
                id: messageId,
                type: 'message',
                role: 'assistant',
                model: fullModelName,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        };
    }

    // If no blocks were created at all, output an empty text block
    if (currentBlockIndex === 0) {
        yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' }
        };
        yield {
            type: 'content_block_stop',
            index: 0
        };
    }

    // Final message_delta with stop_reason and usage
    const finalUsage = {
        output_tokens: usage.output_tokens
    };
    if (usage.input_tokens > 0) {
        finalUsage.input_tokens = usage.input_tokens;
    }

    yield {
        type: 'message_delta',
        delta: {
            stop_reason: finalStopReason,
            stop_sequence: null
        },
        usage: finalUsage
    };

    // Final message_stop
    yield {
        type: 'message_stop'
    };
}

/**
 * Aggregates an incoming WorkBuddy stream into a single complete Anthropic Message object
 * for non-streaming requests.
 *
 * @param {AsyncIterable<Buffer|Uint8Array|string>} byteStream
 * @param {string} fullModelName
 * @param {Object} [options]
 * @returns {Promise<Object>} Complete Anthropic Message JSON
 */
export async function aggregateOpenAIToAnthropicMessage(byteStream, fullModelName, options = {}) {
    let messageId = '';
    const contentBlocks = [];
    let currentBlock = null;
    let stopReason = 'end_turn';
    const usage = {
        input_tokens: 0,
        output_tokens: 0
    };

    const generator = convertOpenAIToAnthropicStream(byteStream, fullModelName, options);

    for await (const event of generator) {
        switch (event.type) {
            case 'message_start':
                messageId = event.message.id;
                if (event.message.usage?.input_tokens) {
                    usage.input_tokens = event.message.usage.input_tokens;
                }
                break;

            case 'content_block_start':
                if (event.content_block.type === 'text') {
                    currentBlock = {
                        type: 'text',
                        text: ''
                    };
                } else if (event.content_block.type === 'tool_use') {
                    currentBlock = {
                        type: 'tool_use',
                        id: event.content_block.id,
                        name: event.content_block.name,
                        _jsonChunks: []
                    };
                }
                break;

            case 'content_block_delta':
                if (currentBlock) {
                    if (event.delta.type === 'text_delta') {
                        currentBlock.text = (currentBlock.text || '') + event.delta.text;
                    } else if (event.delta.type === 'input_json_delta') {
                        currentBlock._jsonChunks.push(event.delta.partial_json);
                    }
                }
                break;

            case 'content_block_stop':
                if (currentBlock) {
                    if (currentBlock.type === 'tool_use') {
                        const jsonStr = (currentBlock._jsonChunks || []).join('');
                        delete currentBlock._jsonChunks;
                        try {
                            currentBlock.input = jsonStr ? JSON.parse(jsonStr) : {};
                        } catch (_) {
                            currentBlock.input = {};
                        }
                    }
                    contentBlocks.push(currentBlock);
                    currentBlock = null;
                }
                break;

            case 'message_delta':
                if (event.delta?.stop_reason) {
                    stopReason = event.delta.stop_reason;
                }
                if (event.usage) {
                    if (typeof event.usage.input_tokens === 'number') {
                        usage.input_tokens = event.usage.input_tokens;
                    }
                    if (typeof event.usage.output_tokens === 'number') {
                        usage.output_tokens = event.usage.output_tokens;
                    }
                }
                break;

            case 'message_stop':
                break;
        }
    }

    return {
        id: messageId || `msg_${crypto.randomBytes(12).toString('hex')}`,
        type: 'message',
        role: 'assistant',
        model: fullModelName,
        content: contentBlocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: usage
    };
}
