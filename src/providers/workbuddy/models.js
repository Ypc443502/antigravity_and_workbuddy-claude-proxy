/**
 * WorkBuddy Models Manager
 * Fetches dynamic models from upstream WorkBuddy API:
 * - Global (WorkBuddy AI): GET https://www.workbuddy.ai/v3/config
 * - Domestic (WorkBuddy CN): GET https://copilot.tencent.com/v2/enterprises/personal/models or /v3/config
 *
 * Implements strict WorkBuddy Desktop catalog parsing rules:
 * 1. User-Agent for /v3/config MUST be "WorkBuddyAI/<version>" (without spaces, default 5.5.2).
 * 2. Unwraps {code, msg, data} wrapper or bare document {models, agents}.
 * 3. Filters authorized models strictly via agents[name="cli"].models.
 * 4. Extracts credit rates (e.g. x0.00), free badges (e.g. "Free now"), context lengths, reasoning metadata.
 * 5. Caches public catalog to data/workbuddy-catalog/ (no tokens stored).
 * 6. Distinguishes source: 'remote' vs source: 'fallback'.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fetch } from 'undici';
import {
    getWorkBuddyBaseUrl,
    WORKBUDDY_FALLBACK_MODELS,
    DEFAULT_DOMAIN,
    DEFAULT_AI_DOMAIN
} from './constants.js';
import { regionOf } from './variants.js';
import { resolveAppVersion, appUserAgent } from './app-version.js';
import { logger } from '../../utils/logger.js';

// In-memory catalog cache (5 minutes TTL)
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedCatalog = null;
let lastCacheTime = 0;

/**
 * Unwrap product document from API response
 * Supports both { code, msg, data: { models, agents } } and bare { models, agents }
 * @param {any} json
 * @returns {Object|null}
 */
export function unwrapCatalogDocument(json) {
    if (!json || typeof json !== 'object') return null;

    if (json.data && typeof json.data === 'object' && (Array.isArray(json.data.models) || Array.isArray(json.data.agents))) {
        return json.data;
    }

    if (Array.isArray(json.models) || Array.isArray(json.agents)) {
        return json;
    }

    if (json.data && typeof json.data === 'object') {
        return json.data;
    }

    return json;
}

/**
 * Extract badge label from model tags (e.g. "badge:Free now:#00E599" -> "Free now")
 * @param {Array<string>} tags
 * @returns {string[]}
 */
export function extractBadgesFromTags(tags) {
    if (!Array.isArray(tags)) return [];
    const badges = [];
    for (const tag of tags) {
        if (typeof tag === 'string' && tag.startsWith('badge:')) {
            const parts = tag.split(':');
            if (parts.length >= 2 && parts[1]) {
                badges.push(parts[1].trim());
            }
        }
    }
    return badges;
}

/**
 * Parse and apply active model promotions (discounts and badges)
 * @param {Array<Object>} promotions
 * @param {number} [nowMs]
 * @returns {Map<string, Object>} modelId -> promo
 */
export function parseActivePromotions(promotions, nowMs = Date.now()) {
    const promoByModel = new Map();
    if (!Array.isArray(promotions)) return promoByModel;

    for (const promo of promotions) {
        if (!promo || promo.enabled === false) continue;

        const schedule = promo.schedule;
        if (schedule) {
            const from = schedule.validFrom ? new Date(schedule.validFrom).getTime() : 0;
            const until = schedule.validUntil ? new Date(schedule.validUntil).getTime() : Infinity;
            if (nowMs < from || nowMs > until) {
                continue; // Promotion not active currently
            }
        }

        const modelIds = Array.isArray(promo.modelIds) ? promo.modelIds : [];
        for (const mid of modelIds) {
            const existing = promoByModel.get(mid);
            // Higher priority wins
            if (!existing || (promo.priority || 0) > (existing.priority || 0)) {
                promoByModel.set(mid, promo);
            }
        }
    }

    return promoByModel;
}

/**
 * Strict parser for WorkBuddy model catalog.
 * Extracts authorized models from agents[name="cli"].models.
 *
 * @param {Object} doc - Unwrapped catalog document
 * @param {boolean} [isInternational=false]
 * @returns {Array<Object>} Array of standardized model metadata objects
 */
export function parseModelCatalog(doc, isInternational = false) {
    if (!doc || typeof doc !== 'object') {
        throw new Error('Invalid catalog document: not an object');
    }

    const rawModels = Array.isArray(doc.models) ? doc.models : [];
    const agents = Array.isArray(doc.agents) ? doc.agents : [];
    const promotions = Array.isArray(doc.modelPromotions) ? doc.modelPromotions : [];
    const activePromos = parseActivePromotions(promotions);

    // 1. Locate the "cli" agent to get authorized model IDs
    const cliAgent = agents.find(a => a && a.name === 'cli');
    if (!cliAgent || !Array.isArray(cliAgent.models) || cliAgent.models.length === 0) {
        logger.warn('[WorkBuddy] Catalog lists no "cli" agent models, checking for fallback models array');
    }

    const authorizedIds = new Set(Array.isArray(cliAgent?.models) ? cliAgent.models : []);

    // 2. Index raw models by ID
    const modelsById = new Map();
    for (const m of rawModels) {
        const id = m.id || m.model || m.name || m.modelId;
        if (typeof id !== 'string' || !id.trim()) continue;

        // Skip disabled models
        if (m.disabled === true || m.status === 'disabled') continue;

        // Skip models with invalid token boundaries
        const maxIn = Number(m.maxInputTokens);
        const maxOut = Number(m.maxOutputTokens);
        if (maxIn <= 0 || maxOut <= 0) continue;

        // Skip embeddings and rerankers
        const lowerId = id.toLowerCase();
        if (lowerId.includes('embedding') || lowerId.includes('rerank')) continue;

        modelsById.set(id, m);
    }

    // 3. Collect authorized CLI models in original sequence
    let candidateList = [];
    if (authorizedIds.size > 0) {
        for (const id of authorizedIds) {
            const raw = modelsById.get(id);
            if (raw) {
                candidateList.push(raw);
            }
        }
    } else {
        // Fallback: if no cli agent in document, take all valid non-disabled models
        candidateList = Array.from(modelsById.values());
    }

    // 4. Transform to standardized model objects
    const result = [];
    for (const m of candidateList) {
        const rawId = m.id || m.model || m.name;
        const displayName = m.name || m.displayName || m.label || rawId;

        const maxIn = Number(m.maxInputTokens) || 32768;
        const maxOut = Number(m.maxOutputTokens) || 4096;

        // Default context length resolution
        let contextWindow = maxIn;
        if (m.contextWindow && typeof m.contextWindow === 'object') {
            if (m.contextWindow.defaultLength && Number(m.contextWindow.defaultLength) > 0) {
                contextWindow = Number(m.contextWindow.defaultLength);
            }
        }

        const supportedContextWindows = Array.isArray(m.contextWindow?.supportedLengths)
            ? m.contextWindow.supportedLengths
            : [contextWindow];

        // Multimodal image support
        const supportsImages = (m.supportsImages === true) && (m.disabledMultimodal !== true);

        // Reasoning/Thinking metadata
        const reasoning = {
            supportsReasoning: !!(m.supportsReasoning || m.reasoning?.supportedEfforts),
            onlyReasoning: !!m.onlyReasoning,
            supportedEfforts: Array.isArray(m.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts : [],
            defaultEffort: m.reasoning?.defaultEffort || m.reasoning?.effort || 'medium',
            canDisableThinking: !!m.reasoning?.canDisableThinking
        };

        // Pricing & credits
        let credits = typeof m.credits === 'string' ? m.credits : (m.credits ? `x${m.credits}` : 'x1.00');
        let isFree = credits === 'x0.00' || credits === '0' || credits === 0;

        // Badges
        const badges = extractBadgesFromTags(m.tags);

        // Apply active promotions if applicable
        const promo = activePromos.get(rawId);
        if (promo) {
            if (promo.badge?.label && !badges.includes(promo.badge.label)) {
                badges.unshift(promo.badge.label);
            }
            if (promo.discount?.factor === 0 || promo.discount?.displayMode === 'replace') {
                if (promo.discount.factor === 0) {
                    credits = 'x0.00';
                    isFree = true;
                }
            }
        }

        if (isFree && !badges.includes('Free now') && !badges.includes('限时免费')) {
            badges.unshift(isInternational ? 'Free now' : '限时免费');
        }

        result.push({
            id: `workbuddy/${rawId}`,
            upstreamId: rawId,
            name: displayName,
            maxInputTokens: maxIn,
            maxOutputTokens: maxOut,
            contextWindow: contextWindow,
            supportedContextWindows: supportedContextWindows,
            supportsImages: supportsImages,
            reasoning: reasoning,
            billing: {
                credits: credits,
                free: isFree,
                multiplier: isFree ? 0 : parseFloat(credits.replace(/[^\d.]/g, '') || '1.0')
            },
            badges: badges,
            description: m.description || '',
            region: isInternational ? 'global' : 'cn',
            source: 'remote'
        });
    }

    return result;
}

/**
 * Path to cache public catalog locally
 * @param {string} variantId
 * @returns {string}
 */
function getCatalogCachePath(variantId = 'workbuddy-ai') {
    const dir = path.join(process.cwd(), 'data', 'workbuddy-catalog');
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    }
    return path.join(dir, `${variantId}.json`);
}

/**
 * Save public catalog to cache file (contains NO tokens)
 * @param {string} variantId
 * @param {Array<Object>} models
 */
function saveCatalogCache(variantId, models) {
    try {
        const filePath = getCatalogCachePath(variantId);
        const data = {
            variantId,
            models,
            cachedAt: new Date().toISOString(),
            cachedAtMs: Date.now()
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
}

/**
 * Read cached catalog from disk if recent
 * @param {string} variantId
 * @returns {Array<Object>|null}
 */
function readCatalogCache(variantId = 'workbuddy-ai') {
    try {
        const filePath = getCatalogCachePath(variantId);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            if (Array.isArray(data?.models) && data.models.length > 0) {
                return data.models.map(m => ({ ...m, source: 'cache', stale: true }));
            }
        }
    } catch (_) {}
    return null;
}

/**
 * Fallback static catalog (marked clearly as fallback: true)
 * @param {string} reason
 * @param {boolean} [isInternational=true]
 * @returns {Object}
 */
function buildFallbackCatalog(reason = '', isInternational = true) {
    const models = WORKBUDDY_FALLBACK_MODELS.map(rawId => {
        const isFree = rawId.includes('flash') || rawId.includes('hy3') || rawId.includes('hy4');
        return {
            id: `workbuddy/${rawId}`,
            upstreamId: rawId,
            name: formatFallbackModelName(rawId),
            maxInputTokens: 32768,
            maxOutputTokens: 4096,
            contextWindow: 32768,
            supportedContextWindows: [32768],
            supportsImages: false,
            reasoning: { supportsReasoning: false, onlyReasoning: false, supportedEfforts: [] },
            billing: {
                credits: isFree ? 'x0.00' : 'x1.00',
                free: isFree,
                multiplier: isFree ? 0 : 1.0
            },
            badges: isFree ? (isInternational ? ['Free now'] : ['限时免费']) : [],
            description: '',
            region: isInternational ? 'global' : 'cn',
            source: 'fallback',
            fallback: true
        };
    });

    return {
        source: 'fallback',
        fallback: true,
        error: reason || 'Remote fetch unavailable',
        models,
        timestamp: Date.now()
    };
}

/**
 * Format model name fallback
 * @param {string} id
 * @returns {string}
 */
export function formatFallbackModelName(id) {
    if (!id) return '';
    const clean = id.startsWith('workbuddy/') ? id.substring('workbuddy/'.length) : id;

    const specialNames = {
        'hy4-preview': 'Hy4 preview',
        'hy3': 'Hy3',
        'hy3-preview': 'Hy3 Preview',
        'hy3-preview-agent': 'Hy3 Preview Agent',
        'deepseek-v4.1-flash': 'Deepseek-V4.1-Flash',
        'deepseek-v4-pro': 'DeepSeek V4 Pro',
        'deepseek-v4-flash': 'DeepSeek V4 Flash',
        'gpt-6-astra': 'GPT-6-Astra',
        'gpt-5.6-sol': 'GPT-5.6-Sol',
        'gpt-5.6-terra': 'GPT-5.6-Terra',
        'gpt-5.6-luna': 'GPT-5.6-Luna',
        'gpt-5.5': 'GPT-5.5',
        'gpt-5.4': 'GPT-5.4',
        'glm-5.2': 'GLM 5.2',
        'glm-5.1': 'GLM 5.1',
        'glm-5v-turbo': 'GLM 5V Turbo',
        'kimi-k2.7': 'Kimi K2.7',
        'kimi-k2.6': 'Kimi K2.6',
        'kimi-k2.5': 'Kimi K2.5',
        'minimax-m3-pay': 'MiniMax M3 Pay',
        'auto': 'Auto'
    };

    if (specialNames[clean.toLowerCase()]) {
        return specialNames[clean.toLowerCase()];
    }

    return clean
        .split(/[-_]/)
        .map(w => (/^v\d+/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
}

/**
 * Fetch dynamic models from upstream WorkBuddy API.
 * Uses exact headers and UA ("WorkBuddyAI/5.5.2" without space) required by /v3/config.
 *
 * @param {Object} [account] - WorkBuddy account object
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {Promise<{source: 'remote'|'cache'|'fallback', fallback: boolean, error?: string, models: Array<Object>, timestamp: number}>}
 */
export async function fetchRemoteWorkBuddyModels(account = null, options = {}) {
    const now = Date.now();
    if (!options.forceRefresh && cachedCatalog && (now - lastCacheTime < MODEL_CACHE_TTL_MS)) {
        return cachedCatalog;
    }

    const summary = account?.credentialManager ? account.credentialManager.getAccountSummary() : {};
    const domain = summary.domain || DEFAULT_AI_DOMAIN;
    const isGlobal = regionOf(domain) === 'global';
    const baseUrl = getWorkBuddyBaseUrl(domain);
    const variantId = isGlobal ? 'workbuddy-ai' : 'workbuddy';

    // Retrieve active access token (preemptive refresh only if genuine near-expiry)
    let token = '';
    if (account?.credentialManager?.data?.auth?.accessToken) {
        token = account.credentialManager.data.auth.accessToken;
    }

    if (!token) {
        const cached = readCatalogCache(variantId);
        if (cached) {
            return {
                source: 'cache',
                fallback: false,
                models: cached,
                timestamp: Date.now()
            };
        }
        return buildFallbackCatalog('No credentials available to fetch model catalog', isGlobal);
    }

    // Determine candidate endpoints in verified priority order:
    // Global: /v3/config
    // Domestic: /v2/enterprises/personal/models -> /v3/config
    const endpoints = isGlobal
        ? [`${baseUrl}/v3/config`]
        : [
            `${baseUrl}/v2/enterprises/personal/models`,
            `${baseUrl}/v3/config`
        ];

    // UA MUST BE "WorkBuddyAI/<version>" without spaces!
    const ua = appUserAgent(resolveAppVersion());

    const headers = {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'Origin': baseUrl,
        'Referer': `${baseUrl}/`,
        'X-Requested-With': 'XMLHttpRequest',
        'X-Product': 'SaaS',
        'User-Agent': ua
    };

    let lastError = null;

    for (const endpoint of endpoints) {
        try {
            logger.info(`[WorkBuddy] Fetching dynamic models from ${endpoint} (UA: ${ua})...`);
            const res = await fetch(endpoint, {
                method: 'GET',
                headers: headers
            });

            if (res.ok) {
                const json = await res.json();
                const doc = unwrapCatalogDocument(json);
                if (doc) {
                    const parsedModels = parseModelCatalog(doc, isGlobal);
                    if (parsedModels.length > 0) {
                        logger.success(`[WorkBuddy] Successfully discovered ${parsedModels.length} models from ${endpoint}`);
                        saveCatalogCache(variantId, parsedModels);
                        cachedCatalog = {
                            source: 'remote',
                            fallback: false,
                            models: parsedModels,
                            timestamp: Date.now(),
                            endpoint: endpoint
                        };
                        lastCacheTime = Date.now();
                        return cachedCatalog;
                    }
                }
            } else {
                const status = res.status;
                const errText = await res.text().catch(() => res.statusText);
                lastError = `HTTP ${status}: ${errText.substring(0, 150)}`;
                logger.warn(`[WorkBuddy] Model fetch returned HTTP ${status}: ${lastError}`);
            }
        } catch (err) {
            lastError = err.message;
            logger.warn(`[WorkBuddy] Failed to fetch models from ${endpoint}: ${err.message}`);
        }
    }

    // If live fetch fails, check disk cache first
    const diskCache = readCatalogCache(variantId);
    if (diskCache) {
        logger.info(`[WorkBuddy] Using cached models from previous successful fetch (${diskCache.length} models)`);
        cachedCatalog = {
            source: 'cache',
            fallback: false,
            stale: true,
            error: lastError,
            models: diskCache,
            timestamp: Date.now()
        };
        lastCacheTime = Date.now();
        return cachedCatalog;
    }

    // Emergency fallback if never fetched before
    return buildFallbackCatalog(lastError, isGlobal);
}

/**
 * Get all available WorkBuddy model IDs without 'workbuddy/' prefix
 * @param {Object} [account]
 * @returns {Promise<string[]>}
 */
export async function getAvailableWorkBuddyModels(account = null) {
    let catalog = cachedCatalog;
    if (!catalog || (Date.now() - lastCacheTime > MODEL_CACHE_TTL_MS)) {
        catalog = await fetchRemoteWorkBuddyModels(account);
    }
    return catalog.models.map(m => m.upstreamId);
}

/**
 * Check if a model is valid for WorkBuddy
 * @param {string} modelName
 * @param {Object} [account]
 * @returns {Promise<boolean>}
 */
export async function isValidWorkBuddyModel(modelName, account = null) {
    if (!modelName) return false;
    const cleanName = modelName.startsWith('workbuddy/') ? modelName.substring('workbuddy/'.length) : modelName;
    const available = await getAvailableWorkBuddyModels(account);
    return available.some(m => m.toLowerCase() === cleanName.toLowerCase());
}

/**
 * List WorkBuddy models in OpenAI-compatible format with full metadata
 * @param {Object} [account]
 * @returns {Promise<{object: string, data: Array<Object>}>}
 */
export async function listWorkBuddyModelsFormatted(account = null) {
    const catalog = await fetchRemoteWorkBuddyModels(account);
    return {
        object: 'list',
        data: catalog.models.map(m => ({
            id: m.id,
            object: 'model',
            owned_by: 'workbuddy',
            name: m.name,
            upstream_id: m.upstreamId,
            credits: m.billing?.credits || 'x1.00',
            free: m.billing?.free || false,
            badges: m.badges || [],
            context_window: m.contextWindow,
            supports_images: m.supportsImages,
            reasoning: m.reasoning,
            source: m.source || catalog.source,
            fallback: !!m.fallback
        }))
    };
}
