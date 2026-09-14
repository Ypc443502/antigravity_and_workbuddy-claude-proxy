/**
 * WorkBuddy HTTP Client
 * Dispatches requests to Tencent WorkBuddy backend (copilot.tencent.com).
 * Always requests upstream with stream: true.
 * Handles 401 token refresh & retry, abort signal forwarding, and error parsing.
 */

import { fetch } from 'undici';
import {
    getWorkBuddyBaseUrl,
    WORKBUDDY_CHAT_ENDPOINT,
    DEFAULT_REQUEST_TIMEOUT_MS
} from './constants.js';
import { parseWorkBuddyError, isAbortError } from './errors.js';
import { logger } from '../../utils/logger.js';
import { ProviderError } from '../provider-error.js';

export class WorkBuddyClient {
    /**
     * @param {Object} options
     * @param {number} [options.timeoutMs]
     */
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    }

    /**
     * Send chat completion request to WorkBuddy upstream.
     * Always returns an async iterable byte stream (or readable stream).
     *
     * @param {Object} openAIPayload - OpenAI format payload
     * @param {Object} credentialManager - WorkBuddyCredentialManager instance
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal] - Caller abort signal
     * @returns {Promise<AsyncIterable<Buffer|Uint8Array>>}
     */
    async sendChatCompletionStream(openAIPayload, credentialManager, options = {}) {
        const callerSignal = options.signal;

        // Verify abort before starting
        if (callerSignal?.aborted) {
            throw new ProviderError({
                provider: 'workbuddy',
                status: 499,
                type: 'request_aborted',
                message: 'Request was aborted before sending'
            });
        }

        // Setup unified timeout and abort controller
        const abortController = new AbortController();
        const timeoutId = setTimeout(() => {
            abortController.abort(new Error(`WorkBuddy request timed out after ${this.timeoutMs}ms`));
        }, this.timeoutMs);

        // Forward caller abort
        let abortListener = null;
        if (callerSignal) {
            abortListener = () => {
                abortController.abort(callerSignal.reason || new Error('Client aborted request'));
            };
            callerSignal.addEventListener('abort', abortListener, { once: true });
        }

        try {
            return await this._executeWithRetry(openAIPayload, credentialManager, abortController.signal);
        } finally {
            clearTimeout(timeoutId);
            if (callerSignal && abortListener) {
                callerSignal.removeEventListener('abort', abortListener);
            }
        }
    }

    /**
     * Execute upstream request with 401 auto-refresh and retry (1 retry allowed for 401).
     * @private
     */
    async _executeWithRetry(payload, credentialManager, signal, retryCount = 0) {
        let headers;
        try {
            headers = await credentialManager.getHeaders();
        } catch (err) {
            throw new ProviderError({
                provider: 'workbuddy',
                status: 401,
                type: 'authentication_error',
                message: `Failed to prepare WorkBuddy credentials: ${err.message}`,
                cause: err
            });
        }

        const accountSummary = credentialManager.getAccountSummary();
        const domain = accountSummary.domain || 'www.workbuddy.ai';
        const baseUrl = getWorkBuddyBaseUrl(domain);
        const chatEndpoint = process.env.WORKBUDDY_CHAT_ENDPOINT || `${baseUrl}/v2/chat/completions`;

        logger.info(`[WorkBuddy] Sending request to ${chatEndpoint} (account: ${accountSummary.uidMasked}, model: ${payload.model})`);

        let response;
        try {
            response = await fetch(chatEndpoint, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(payload),
                signal: signal
            });
        } catch (err) {
            if (isAbortError(err) || signal.aborted) {
                logger.info('[WorkBuddy] Upstream request aborted by client');
                throw new ProviderError({
                    provider: 'workbuddy',
                    status: 499,
                    type: 'request_aborted',
                    message: 'Request aborted by client',
                    retryable: false,
                    cause: err
                });
            }

            logger.error(`[WorkBuddy] Network connection error: ${err.message}`);
            throw new ProviderError({
                provider: 'workbuddy',
                status: 503,
                type: 'api_error',
                message: `Failed to connect to WorkBuddy upstream: ${err.message}`,
                retryable: true,
                retryAfterMs: 2000,
                cause: err
            });
        }

        // Handle 401 Unauthorized: token might have expired, try force refresh once
        if (response.status === 401 && retryCount === 0) {
            logger.warn(`[WorkBuddy] Received 401 Unauthorized for account ${accountSummary.uidMasked}. Attempting token force-refresh...`);
            try {
                await credentialManager.forceRefresh();
                logger.info(`[WorkBuddy] Token refreshed, retrying request...`);
                return await this._executeWithRetry(payload, credentialManager, signal, retryCount + 1);
            } catch (refreshErr) {
                logger.error(`[WorkBuddy] Token refresh failed after 401: ${refreshErr.message}`);
                throw new ProviderError({
                    provider: 'workbuddy',
                    status: 401,
                    type: 'authentication_error',
                    message: `WorkBuddy token expired and refresh failed: ${refreshErr.message}`,
                    retryable: false,
                    cause: refreshErr
                });
            }
        }

        // Check for other non-200 responses
        if (!response.ok) {
            const status = response.status;
            let errorBody = '';
            try {
                errorBody = await response.text();
            } catch (_) {
                errorBody = response.statusText;
            }

            logger.error(`[WorkBuddy] Upstream error (HTTP ${status}): ${errorBody.substring(0, 300)}`);
            throw parseWorkBuddyError(status, errorBody);
        }

        if (!response.body) {
            throw new ProviderError({
                provider: 'workbuddy',
                status: 502,
                type: 'api_error',
                message: 'WorkBuddy upstream returned empty response body',
                retryable: true
            });
        }

        // Return the readable stream as an async iterable
        return response.body;
    }
}

export default WorkBuddyClient;
