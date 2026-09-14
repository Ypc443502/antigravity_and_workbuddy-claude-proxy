/**
 * WorkBuddy Error Handling
 * Parses WorkBuddy API responses and maps them to ProviderError.
 */

import { ProviderError } from '../provider-error.js';

/**
 * Parse upstream WorkBuddy error response
 * @param {number} status - HTTP status code
 * @param {string|Object} body - Response body (text or parsed JSON)
 * @param {Error|null} [originalError=null]
 * @returns {ProviderError}
 */
export function parseWorkBuddyError(status, body, originalError = null) {
    let message = '';
    let code = null;
    let type = 'api_error';
    let retryable = false;
    let retryAfterMs = null;

    let parsed = null;
    if (typeof body === 'object' && body !== null) {
        parsed = body;
    } else if (typeof body === 'string') {
        try {
            parsed = JSON.parse(body);
        } catch (_) {
            message = body;
        }
    }

    if (parsed) {
        message = parsed.error?.message || parsed.message || parsed.msg || JSON.stringify(parsed);
        code = parsed.error?.code || parsed.code || null;
        type = parsed.error?.type || type;
    }

    if (!message) {
        message = `WorkBuddy API error (HTTP ${status})`;
    }

    switch (status) {
        case 401:
            type = 'authentication_error';
            retryable = true; // Retryable once after token refresh
            break;

        case 403: {
            type = 'permission_error';
            // Check for content moderation vs authorization issue
            const lowerMsg = message.toLowerCase();
            const isModeration = lowerMsg.includes('sensitive') ||
                lowerMsg.includes('moderation') ||
                lowerMsg.includes('policy') ||
                lowerMsg.includes('compliance') ||
                lowerMsg.includes('violation');

            if (isModeration) {
                type = 'invalid_request_error';
                retryable = false;
                message = `Content moderation check failed: ${message}`;
            } else {
                retryable = false;
            }
            break;
        }

        case 404:
            type = 'not_found_error';
            retryable = false;
            break;

        case 429:
            type = 'rate_limit_error';
            retryable = true;
            // Check for retry-after in headers or message
            retryAfterMs = 15000;
            break;

        case 400:
            type = 'invalid_request_error';
            retryable = false;
            break;

        case 500:
        case 502:
        case 503:
        case 504:
            type = 'api_error';
            retryable = true;
            retryAfterMs = 2000;
            break;

        default:
            if (status >= 500) {
                type = 'api_error';
                retryable = true;
            }
            break;
    }

    return new ProviderError({
        provider: 'workbuddy',
        status,
        type,
        code,
        message,
        retryable,
        retryAfterMs,
        cause: originalError
    });
}

/**
 * Check if an error is an abort error from client disconnect.
 * @param {Error} error
 * @returns {boolean}
 */
export function isAbortError(error) {
    if (!error) return false;
    return error.name === 'AbortError' ||
        error.code === 'ABORT_ERR' ||
        error.message?.includes('aborted') ||
        error.message?.includes('The user aborted a request');
}
