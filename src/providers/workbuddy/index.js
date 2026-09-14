/**
 * WorkBuddy Provider
 * Implements standard Provider interface for Tencent WorkBuddy.
 */

import { WorkBuddyAccountManager } from './account-manager.js';
import { WorkBuddyClient } from './client.js';
import { listWorkBuddyModelsFormatted, isValidWorkBuddyModel } from './models.js';
import { convertAnthropicToWorkBuddy } from './request-converter.js';
import { convertOpenAIToAnthropicStream, aggregateOpenAIToAnthropicMessage } from './stream-converter.js';
import { ProviderError } from '../provider-error.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config.js';

export class WorkBuddyProvider {
    id = 'workbuddy';
    name = 'WorkBuddy (Tencent Copilot)';

    /**
     * @param {Object} [options]
     * @param {string} [options.authDir]
     * @param {string} [options.strategy]
     * @param {number} [options.requestTimeoutMs]
     */
    constructor(options = {}) {
        this.options = options;
        this.accountManager = new WorkBuddyAccountManager({
            authDir: options.authDir || process.env.WORKBUDDY_AUTH_DIR || config?.providers?.workbuddy?.authDir,
            strategy: options.strategy || config?.providers?.workbuddy?.strategy || 'round-robin'
        });
        this.client = new WorkBuddyClient({
            timeoutMs: options.requestTimeoutMs ||
                (process.env.WORKBUDDY_REQUEST_TIMEOUT_MS ? parseInt(process.env.WORKBUDDY_REQUEST_TIMEOUT_MS, 10) : undefined) ||
                config?.providers?.workbuddy?.requestTimeoutMs ||
                300000
        });
        this.initialized = false;
    }

    /**
     * Initialize the provider and its account manager
     */
    async initialize() {
        if (this.initialized) return;
        await this.accountManager.initialize();
        this.initialized = true;
    }

    /**
     * List models supported by WorkBuddy (fetches dynamic catalog from upstream)
     * @returns {Promise<{object: string, data: Array}>}
     */
    async listModels() {
        await this.initialize();
        const account = this.accountManager.accounts.find(a => a.enabled !== false && !a.isInvalid) ||
            this.accountManager.accounts[0];
        return await listWorkBuddyModelsFormatted(account);
    }

    /**
     * Check if a model is valid for WorkBuddy
     * @param {string} modelId
     * @returns {Promise<boolean>}
     */
    async isValidModel(modelId) {
        await this.initialize();
        const account = this.accountManager.accounts.find(a => a.enabled !== false && !a.isInvalid) ||
            this.accountManager.accounts[0];
        return await isValidWorkBuddyModel(modelId, account);
    }

    /**
     * Send a non-streaming message
     * @param {Object} request - Anthropic request body
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal]
     * @returns {Promise<Object>} Anthropic message response
     */
    async sendMessage(request, options = {}) {
        await this.initialize();

        const modelId = request.model;
        const upstreamModel = modelId.startsWith('workbuddy/') ? modelId.substring('workbuddy/'.length) : modelId;
        const fullModelName = modelId.startsWith('workbuddy/') ? modelId : `workbuddy/${modelId}`;

        const exposeReasoning = config?.providers?.workbuddy?.exposeReasoning ?? false;

        // Try accounts with retry/failover on rate limits
        let lastError = null;
        const maxAttempts = Math.max(1, this.accountManager.accounts.length);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const { account } = this.accountManager.selectAccount(upstreamModel);

            if (!account) {
                if (this.accountManager.isAllRateLimited(upstreamModel)) {
                    logger.warn(`[WorkBuddy] All accounts rate-limited for ${upstreamModel}. Resetting limits for optimistic retry.`);
                    this.accountManager.resetAllRateLimits();
                    const retrySelect = this.accountManager.selectAccount(upstreamModel);
                    if (retrySelect.account) {
                        return await this._executeSendMessage(request, retrySelect.account, upstreamModel, fullModelName, exposeReasoning, options);
                    }
                }
                throw new ProviderError({
                    provider: 'workbuddy',
                    status: 429,
                    type: 'rate_limit_error',
                    message: `No available WorkBuddy accounts for model ${upstreamModel}`
                });
            }

            try {
                return await this._executeSendMessage(request, account, upstreamModel, fullModelName, exposeReasoning, options);
            } catch (err) {
                lastError = err;
                if (err instanceof ProviderError) {
                    if (err.status === 429) {
                        this.accountManager.markRateLimited(account.id, upstreamModel, err.retryAfterMs || 30000);
                        logger.warn(`[WorkBuddy] Account ${account.uidMasked} rate limited. Trying next account...`);
                        continue;
                    }
                    if (err.status === 401) {
                        this.accountManager.markInvalid(account.id, err.message);
                        logger.warn(`[WorkBuddy] Account ${account.uidMasked} invalid after 401. Trying next account...`);
                        continue;
                    }
                    if (!err.retryable) {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }
        }

        throw lastError || new ProviderError({
            provider: 'workbuddy',
            status: 503,
            type: 'api_error',
            message: 'All WorkBuddy accounts failed for this request'
        });
    }

    /**
     * @private
     */
    async _executeSendMessage(request, account, upstreamModel, fullModelName, exposeReasoning, options) {
        const openAIPayload = convertAnthropicToWorkBuddy(request, upstreamModel);
        const byteStream = await this.client.sendChatCompletionStream(
            openAIPayload,
            account.credentialManager,
            options
        );

        return await aggregateOpenAIToAnthropicMessage(byteStream, fullModelName, {
            exposeReasoning
        });
    }

    /**
     * Send a streaming message
     * @param {Object} request - Anthropic request body
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal]
     * @returns {AsyncGenerator<Object>} Stream of Anthropic event objects
     */
    async *sendMessageStream(request, options = {}) {
        await this.initialize();

        const modelId = request.model;
        const upstreamModel = modelId.startsWith('workbuddy/') ? modelId.substring('workbuddy/'.length) : modelId;
        const fullModelName = modelId.startsWith('workbuddy/') ? modelId : `workbuddy/${modelId}`;

        const exposeReasoning = config?.providers?.workbuddy?.exposeReasoning ?? false;

        // Try selecting an account with failover before yielding first chunk
        let selectedAccount = null;
        let byteStream = null;
        let lastError = null;

        const maxAttempts = Math.max(1, this.accountManager.accounts.length);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const { account } = this.accountManager.selectAccount(upstreamModel);

            if (!account) {
                if (this.accountManager.isAllRateLimited(upstreamModel)) {
                    logger.warn(`[WorkBuddy] All accounts rate-limited for ${upstreamModel}. Resetting limits for optimistic retry.`);
                    this.accountManager.resetAllRateLimits();
                    const retrySelect = this.accountManager.selectAccount(upstreamModel);
                    if (retrySelect.account) {
                        selectedAccount = retrySelect.account;
                    }
                }
                if (!selectedAccount) {
                    throw new ProviderError({
                        provider: 'workbuddy',
                        status: 429,
                        type: 'rate_limit_error',
                        message: `No available WorkBuddy accounts for model ${upstreamModel}`
                    });
                }
            } else {
                selectedAccount = account;
            }

            try {
                const openAIPayload = convertAnthropicToWorkBuddy(request, upstreamModel);
                byteStream = await this.client.sendChatCompletionStream(
                    openAIPayload,
                    selectedAccount.credentialManager,
                    options
                );
                // Connected successfully
                break;
            } catch (err) {
                lastError = err;
                if (err instanceof ProviderError) {
                    if (err.status === 429) {
                        this.accountManager.markRateLimited(selectedAccount.id, upstreamModel, err.retryAfterMs || 30000);
                        logger.warn(`[WorkBuddy] Account ${selectedAccount.uidMasked} rate-limited on stream init. Trying next account...`);
                        selectedAccount = null;
                        continue;
                    }
                    if (err.status === 401) {
                        this.accountManager.markInvalid(selectedAccount.id, err.message);
                        logger.warn(`[WorkBuddy] Account ${selectedAccount.uidMasked} invalid on stream init. Trying next account...`);
                        selectedAccount = null;
                        continue;
                    }
                    if (!err.retryable) {
                        throw err;
                    }
                } else {
                    throw err;
                }
            }
        }

        if (!byteStream) {
            throw lastError || new ProviderError({
                provider: 'workbuddy',
                status: 503,
                type: 'api_error',
                message: 'Failed to establish WorkBuddy stream across available accounts'
            });
        }

        // Convert the stream and yield events
        const eventGenerator = convertOpenAIToAnthropicStream(byteStream, fullModelName, {
            exposeReasoning
        });

        for await (const event of eventGenerator) {
            yield event;
        }
    }

    /**
     * Get health status
     */
    getStatus() {
        return this.accountManager.getStatus();
    }
}

export default WorkBuddyProvider;
