/**
 * Anthropic Messages API -> OpenAI Chat Completions Request Converter
 * Designed for WorkBuddy backend (copilot.tencent.com/v2/chat/completions).
 */

const RESPONSE_STYLE_INSTRUCTION = 'When responding to the user, do not proactively introduce or mention your product name, client name, or runtime environment unless the user explicitly asks.';

export function sanitizeSystemPromptForWorkBuddy(systemText) {
    if (typeof systemText !== 'string') return systemText;

    return systemText
        .replace(/You are Claude Code,\s*Anthropic's official CLI for Claude\./gi, 'You are an intelligent programming assistant CLI.')
        .replace(/You are Claude Code/gi, 'You are an intelligent programming assistant')
        .replace(/Anthropic's official CLI for Claude/gi, 'official CLI assistant')
        .replace(/\bClaude Code\b/g, 'Coding Assistant')
        .replace(/\bAnthropic\b/g, 'AI');
}

function appendResponseStyleInstruction(systemText) {
    const text = typeof systemText === 'string' ? systemText : '';
    if (text.includes(RESPONSE_STYLE_INSTRUCTION)) return text;
    return text ? `${text}\n\n${RESPONSE_STYLE_INSTRUCTION}` : RESPONSE_STYLE_INSTRUCTION;
}

/**
 * Convert an Anthropic tool schema to an OpenAI tool definition.
 * @param {Object} tool
 * @returns {Object}
 */
export function convertAnthropicToolToOpenAI(tool) {
    if (!tool || !tool.name) return null;

    return {
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || {
                type: 'object',
                properties: {}
            }
        }
    };
}

/**
 * Convert Anthropic tool_choice to OpenAI tool_choice.
 * @param {string|Object} toolChoice
 * @returns {string|Object|undefined}
 */
export function convertToolChoice(toolChoice) {
    if (!toolChoice) return undefined;

    if (typeof toolChoice === 'string') {
        if (toolChoice === 'auto') return 'auto';
        if (toolChoice === 'any') return 'required';
        if (toolChoice === 'none') return 'none';
        return toolChoice;
    }

    if (typeof toolChoice === 'object') {
        if (toolChoice.type === 'auto') return 'auto';
        if (toolChoice.type === 'any') return 'required';
        if (toolChoice.type === 'none') return 'none';
        if (toolChoice.type === 'tool' && toolChoice.name) {
            return {
                type: 'function',
                function: { name: toolChoice.name }
            };
        }
    }

    return undefined;
}

/**
 * Extract text content from tool_result content (which can be string or array of blocks).
 * @param {string|Array} content
 * @returns {string}
 */
function extractToolResultContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        const textParts = [];
        for (const block of content) {
            if (typeof block === 'string') {
                textParts.push(block);
            } else if (block.type === 'text') {
                textParts.push(block.text || '');
            } else if (block.type === 'image') {
                // If there's an image block in tool result, summarize or include placeholder
                textParts.push('[Image data]');
            } else {
                textParts.push(JSON.stringify(block));
            }
        }
        return textParts.join('\n');
    }

    if (content === null || content === undefined) {
        return '';
    }

    return typeof content === 'object' ? JSON.stringify(content) : String(content);
}

/**
 * Convert Anthropic messages array to OpenAI messages array.
 * Correctly decomposes tool_use into assistant.tool_calls,
 * and tool_result into role: 'tool' messages.
 *
 * @param {Array} messages - Anthropic messages
 * @returns {Array} OpenAI messages
 */
export function convertMessages(messages) {
    if (!Array.isArray(messages)) return [];

    const result = [];

    for (const msg of messages) {
        const role = msg.role;
        const content = msg.content;

        // Case 1: Simple string content
        if (typeof content === 'string') {
            result.push({
                role: role === 'assistant' ? 'assistant' : 'user',
                content: content
            });
            continue;
        }

        // Case 2: Array of content blocks
        if (Array.isArray(content)) {
            if (role === 'assistant') {
                let textContent = '';
                const toolCalls = [];

                for (const block of content) {
                    if (block.type === 'text') {
                        textContent += (textContent ? '\n' : '') + (block.text || '');
                    } else if (block.type === 'tool_use') {
                        let args = '';
                        if (typeof block.input === 'string') {
                            args = block.input;
                        } else {
                            try {
                                args = JSON.stringify(block.input || {});
                            } catch (_) {
                                args = '{}';
                            }
                        }

                        toolCalls.push({
                            id: block.id || `call_${Date.now()}_${toolCalls.length}`,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: args
                            }
                        });
                    }
                }

                const assistantMsg = {
                    role: 'assistant',
                    content: textContent || (toolCalls.length > 0 ? null : '')
                };

                if (toolCalls.length > 0) {
                    assistantMsg.tool_calls = toolCalls;
                }

                result.push(assistantMsg);

            } else {
                // Role is 'user'
                // An Anthropic user message can contain both tool_result blocks AND regular text blocks
                const toolResults = [];
                let userText = '';

                for (const block of content) {
                    if (block.type === 'tool_result') {
                        toolResults.push({
                            role: 'tool',
                            tool_call_id: block.tool_use_id,
                            content: extractToolResultContent(block.content)
                        });
                    } else if (block.type === 'text') {
                        userText += (userText ? '\n' : '') + (block.text || '');
                    } else if (block.type === 'image') {
                        // WorkBuddy might support base64 image or text fallback
                        userText += (userText ? '\n' : '') + '[Image Attached]';
                    }
                }

                // Append all tool response messages first (so they match previous assistant tool_calls)
                for (const tr of toolResults) {
                    result.push(tr);
                }

                // If user included additional text comments along with the tool results, add as user message
                if (userText) {
                    result.push({
                        role: 'user',
                        content: userText
                    });
                }
            }
        }
    }

    return result;
}

/**
 * Convert full Anthropic request to OpenAI Chat Completions payload.
 *
 * @param {Object} request - Anthropic request body
 * @param {string} upstreamModel - Real upstream model name (e.g. 'deepseek-v4-pro')
 * @returns {Object} OpenAI request payload
 */
export function convertAnthropicToWorkBuddy(request, upstreamModel) {
    const {
        messages = [],
        system,
        max_tokens,
        tools,
        tool_choice,
        temperature,
        top_p,
        stop_sequences
    } = request;

    const openAIMessages = [];

    // Process system prompt
    if (system) {
        if (typeof system === 'string') {
            const sanitized = sanitizeSystemPromptForWorkBuddy(system);
            openAIMessages.push({
                role: 'system',
                content: appendResponseStyleInstruction(sanitized)
            });
        } else if (Array.isArray(system)) {
            const systemText = system
                .filter(b => b && (b.type === 'text' || typeof b === 'string'))
                .map(b => (typeof b === 'string' ? b : b.text || ''))
                .join('\n\n');

            if (systemText) {
                const sanitized = sanitizeSystemPromptForWorkBuddy(systemText);
                openAIMessages.push({
                    role: 'system',
                    content: appendResponseStyleInstruction(sanitized)
                });
            }
        }
    }

    // Process conversation messages
    const converted = convertMessages(messages);
    for (const m of converted) {
        if (m.role === 'developer') {
            m.role = 'system';
        }
        if (m.role === 'system' && typeof m.content === 'string') {
            m.content = sanitizeSystemPromptForWorkBuddy(m.content);
        }
    }
    openAIMessages.push(...converted);

    // WorkBuddy requirement (verified 2026-09):
    // messages[0] must be role: "system" to avoid gateway error 11128
    if (openAIMessages.length === 0 || openAIMessages[0].role !== 'system') {
        openAIMessages.unshift({
            role: 'system',
            content: appendResponseStyleInstruction('You are a helpful assistant.')
        });
    }

    const payload = {
        model: upstreamModel,
        messages: openAIMessages,
        stream: true,
        stream_options: {
            include_usage: true
        }
    };

    if (typeof max_tokens === 'number') {
        payload.max_tokens = max_tokens;
    }

    if (typeof temperature === 'number') {
        payload.temperature = temperature;
    }

    if (typeof top_p === 'number') {
        payload.top_p = top_p;
    }

    if (Array.isArray(stop_sequences) && stop_sequences.length > 0) {
        payload.stop = stop_sequences;
    }

    // Convert tools if provided
    if (Array.isArray(tools) && tools.length > 0) {
        const convertedTools = tools
            .map(convertAnthropicToolToOpenAI)
            .filter(Boolean);

        if (convertedTools.length > 0) {
            payload.tools = convertedTools;

            if (tool_choice) {
                const choice = convertToolChoice(tool_choice);
                if (choice !== undefined) {
                    payload.tool_choice = choice;
                }
            }
        }
    }

    return payload;
}
