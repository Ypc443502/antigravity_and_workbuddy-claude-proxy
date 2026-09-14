/**
 * Provider Router
 * Routes model requests to the appropriate Provider (Antigravity or WorkBuddy),
 * manages alias mappings, and aggregates models and health statuses.
 */

import { AntigravityProvider } from './antigravity/index.js';
import { WorkBuddyProvider } from './workbuddy/index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ProviderError } from './provider-error.js';

export class ProviderRouter {
    constructor(options = {}) {
        this.options = options;
        this.providers = new Map();

        // Register default providers
        this.registerProvider(new AntigravityProvider());
        this.registerProvider(new WorkBuddyProvider());
    }

    /**
     * Register a provider instance
     * @param {Object} provider
     */
    registerProvider(provider) {
        if (!provider || !provider.id) {
            throw new Error('Provider must have an id');
        }
        this.providers.set(provider.id, provider);
        logger.debug(`[ProviderRouter] Registered provider: ${provider.id}`);
    }

    /**
     * Get a registered provider by id
     * @param {string} id
     * @returns {Object}
     */
    getProvider(id) {
        const p = this.providers.get(id);
        if (!p) {
            throw new ProviderError({
                provider: id,
                status: 400,
                type: 'invalid_request_error',
                message: `Unknown provider: ${id}`
            });
        }
        return p;
    }

    /**
     * Resolve a requested model string to provider and upstream model name.
     * Applies alias mapping from config.modelMapping first, then resolves provider.
     * Backward compatibility: models without prefix route to 'antigravity'.
     *
     * @param {string} rawModel
     * @returns {{ provider: Object, providerId: string, upstreamModel: string, fullModel: string }}
     */
    resolveModel(rawModel) {
        let model = (rawModel || 'claude-3-5-sonnet-20241022').trim();

        // 1. Alias mapping from config
        const modelMapping = config.modelMapping || {};
        if (modelMapping[model] && modelMapping[model].mapping) {
            const mapped = modelMapping[model].mapping;
            logger.info(`[ProviderRouter] Mapping model alias ${model} -> ${mapped}`);
            model = mapped;
        }

        // 2. Resolve provider prefix
        let providerId = 'antigravity';
        let upstreamModel = model;

        if (model.startsWith('workbuddy/')) {
            providerId = 'workbuddy';
            upstreamModel = model.substring('workbuddy/'.length);

            // Backward compatibility aliases for legacy model names
            const WORKBUDDY_DEFAULT_ALIASES = {
                'deepseek-v4-pro': 'deepseek-v4.1-flash',
                'deepseek-v4-flash': 'deepseek-v4.1-flash',
                'hy4-preview': 'hy4-preview-f'
            };
            if (WORKBUDDY_DEFAULT_ALIASES[upstreamModel]) {
                const aliasTarget = WORKBUDDY_DEFAULT_ALIASES[upstreamModel];
                logger.info(`[ProviderRouter] Aligning legacy WorkBuddy alias ${upstreamModel} -> ${aliasTarget}`);
                upstreamModel = aliasTarget;
            }
        } else if (model.startsWith('antigravity/')) {
            providerId = 'antigravity';
            upstreamModel = model.substring('antigravity/'.length);
        } else {
            // Backward compatibility: default to antigravity
            providerId = 'antigravity';
            upstreamModel = model;
        }

        const provider = this.getProvider(providerId);

        return {
            provider,
            providerId,
            upstreamModel,
            fullModel: model
        };
    }

    /**
     * Aggregates models from all providers in OpenAI-compatible format
     * @param {Object} [options]
     * @returns {Promise<{object: string, data: Array}>}
     */
    async listModels(options = {}) {
        const allModels = [];

        for (const [id, provider] of this.providers.entries()) {
            // Check if provider is disabled in config
            if (config.providers && config.providers[id] && config.providers[id].enabled === false) {
                continue;
            }

            try {
                const res = await provider.listModels(options);
                if (res && Array.isArray(res.data)) {
                    allModels.push(...res.data);
                }
            } catch (err) {
                logger.warn(`[ProviderRouter] Failed to list models for provider ${id}: ${err.message}`);
            }
        }

        return {
            object: 'list',
            data: allModels
        };
    }

    /**
     * Check if a model is valid across providers
     * @param {string} modelId
     * @param {Object} [options]
     * @returns {Promise<boolean>}
     */
    async isValidModel(modelId, options = {}) {
        try {
            const resolved = this.resolveModel(modelId);
            return await resolved.provider.isValidModel(resolved.upstreamModel, options);
        } catch (err) {
            return false;
        }
    }

    /**
     * Get health summary across all registered providers
     * @returns {Object}
     */
    getHealth() {
        const health = {};
        for (const [id, provider] of this.providers.entries()) {
            if (typeof provider.getStatus === 'function') {
                health[id] = provider.getStatus();
            } else {
                health[id] = { status: 'ok' };
            }
        }
        return health;
    }
}

export const providerRouter = new ProviderRouter();
export default providerRouter;
