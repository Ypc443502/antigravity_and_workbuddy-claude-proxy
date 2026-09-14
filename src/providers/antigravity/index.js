/**
 * Antigravity Provider Adapter
 * Wraps existing Google Cloud Code client without rewriting or moving cloudcode.
 */

import {
    sendMessage,
    sendMessageStream,
    listModels,
    fetchAvailableModels,
    getModelQuotas,
    getSubscriptionTier,
    isValidModel
} from '../../cloudcode/index.js';

const FALLBACK_ANTIGRAVITY_MODELS = [
    'claude-sonnet-4-6',
    'claude-opus-4-6-thinking',
    'gemini-3.1-pro-high',
    'gemini-3-flash',
    'gemini-3.8-flash-tiered'
];

export class AntigravityProvider {
    id = 'antigravity';
    name = 'Antigravity (Google Cloud Code)';

    /**
     * List models supported by Antigravity
     * @param {Object} [options]
     * @param {string} [options.token] - Access token
     * @param {Object} [options.accountManager] - Account manager instance
     * @returns {Promise<{object: string, data: Array}>}
     */
    async listModels(options = {}) {
        try {
            let token = options.token;
            if (!token && options.accountManager) {
                const { account } = options.accountManager.selectAccount();
                if (account) {
                    token = await options.accountManager.getTokenForAccount(account);
                }
            }
            if (token) {
                return await listModels(token);
            }
        } catch (_) {
            // If fetching live models from Google fails (e.g. offline/unauthenticated),
            // gracefully fallback to known models
        }

        return {
            object: 'list',
            data: FALLBACK_ANTIGRAVITY_MODELS.map(id => ({
                id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: 'antigravity'
            }))
        };
    }

    /**
     * Validate if model is supported
     * @param {string} modelId
     * @param {Object} [options]
     * @returns {Promise<boolean>}
     */
    async isValidModel(modelId, options = {}) {
        const { token, projectId } = options;
        return await isValidModel(modelId, token, projectId);
    }

    /**
     * Send non-streaming message
     * @param {Object} request
     * @param {Object} accountManager
     * @param {Object} [options]
     * @returns {Promise<Object>}
     */
    async sendMessage(request, accountManager, options = {}) {
        const fallbackEnabled = options.fallbackEnabled ?? false;
        return await sendMessage(request, accountManager, fallbackEnabled);
    }

    /**
     * Send streaming message
     * @param {Object} request
     * @param {Object} accountManager
     * @param {Object} [options]
     * @returns {AsyncGenerator<Object>}
     */
    async *sendMessageStream(request, accountManager, options = {}) {
        const fallbackEnabled = options.fallbackEnabled ?? false;
        const generator = sendMessageStream(request, accountManager, fallbackEnabled);
        for await (const event of generator) {
            yield event;
        }
    }

    /**
     * Helper to get model quotas for an account
     */
    async getModelQuotas(token, projectId) {
        return await getModelQuotas(token, projectId);
    }

    /**
     * Helper to get subscription tier for an account
     */
    async getSubscriptionTier(token) {
        return await getSubscriptionTier(token);
    }
}

export default AntigravityProvider;
