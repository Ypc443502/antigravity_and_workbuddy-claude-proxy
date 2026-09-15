/**
 * WorkBuddy Chat Payload Normalizer
 * Prepares the final upstream request body immediately before calling fetch().
 *
 * Implements verified normalizations from corrinehu/dsh-workbuddy-connect:
 * 1. stream: true is enforced.
 * 2. Any role="developer" is converted to role="system".
 * 3. tool_choice is normalized from Anthropic/OpenAI object forms into string form ("auto", "required", or function name "Read").
 *    If tool_choice is "none" or { type: "none" }, removes tool_choice and tools.
 * 4. For international edition (www.workbuddy.ai), enforces that messages[0] must be role="system"
 *    to prevent gateway error HTTP 400 code 11128 ("来自未经授权的通道的非法 API 调用").
 */

/**
 * Normalize tool_choice to WorkBuddy accepted string form or undefined
 * @param {any} toolChoice
 * @param {Object} clonedPayload - Modified in place if tool_choice === 'none'
 * @returns {string|undefined}
 */
export function normalizeUpstreamToolChoice(toolChoice, clonedPayload) {
    if (!toolChoice) return undefined;

    if (typeof toolChoice === 'string') {
        const lower = toolChoice.toLowerCase();
        if (lower === 'auto') return 'auto';
        if (lower === 'required') return 'required';
        if (lower === 'none') {
            delete clonedPayload.tools;
            delete clonedPayload.functions;
            return undefined;
        }
        return toolChoice;
    }

    if (typeof toolChoice === 'object') {
        const type = toolChoice.type?.toLowerCase();
        if (type === 'auto') return 'auto';
        if (type === 'required') return 'required';
        if (type === 'none') {
            delete clonedPayload.tools;
            delete clonedPayload.functions;
            return undefined;
        }
        if ((type === 'function' || type === 'tool') && toolChoice.function?.name) {
            return toolChoice.function.name;
        }
        if (type === 'tool' && toolChoice.name) {
            return toolChoice.name;
        }
        if (toolChoice.function?.name) {
            return toolChoice.function.name;
        }
        if (toolChoice.name) {
            return toolChoice.name;
        }
    }

    return undefined;
}

/**
 * Standard chat payload preparation (runs on both CN and International)
 * @param {Object} payload - Original payload
 * @returns {Object} Normalized clone
 */
export function prepareChatPayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { stream: true, messages: [] };
    }

    // Clone payload
    const clone = {
        ...payload,
        stream: true
    };

    // Normalize messages
    const rawMessages = Array.isArray(clone.messages) ? clone.messages : [];
    clone.messages = rawMessages.map(m => {
        if (!m || typeof m !== 'object') return m;
        if (m.role === 'developer') {
            return { ...m, role: 'system' };
        }
        return { ...m };
    });

    // Normalize tool_choice
    if (clone.tool_choice !== undefined) {
        const normalized = normalizeUpstreamToolChoice(clone.tool_choice, clone);
        if (normalized !== undefined) {
            clone.tool_choice = normalized;
        } else {
            delete clone.tool_choice;
        }
    }

    return clone;
}

/**
 * International chat payload preparation (for www.workbuddy.ai)
 * Enforces that messages[0] must be role="system" to prevent code 11128
 * @param {Object} payload - Original payload
 * @returns {Object} Normalized clone
 */
export function prepareInternationalChatPayload(payload) {
    const clone = prepareChatPayload(payload);

    if (!Array.isArray(clone.messages)) {
        clone.messages = [];
    }

    // Gatekeeper rule: messages[0] must be role="system"
    if (clone.messages.length === 0 || clone.messages[0].role !== 'system') {
        clone.messages.unshift({
            role: 'system',
            content: 'You are a helpful assistant.'
        });
    }

    return clone;
}
