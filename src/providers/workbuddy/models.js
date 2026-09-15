/**
 * WorkBuddy Models Manager
 * Fetches dynamic models from upstream WorkBuddy API:
 * - Global (WorkBuddy AI): GET https://www.workbuddy.ai/v3/config
 * - Domestic (WorkBuddy CN):
 *     1. GET https://copilot.tencent.com/console/enterprises/personal/models
 *     2. GET https://copilot.tencent.com/v2/enterprises/personal/models
 *     3. GET https://copilot.tencent.com/v3/config
 *
 * Implements strict WorkBuddy Desktop catalog parsing rules:
 * 1. User-Agent for /v3/config MUST be "WorkBuddyAI/<version>" (without spaces, default 5.5.2).
 * 2. Unwraps {code, msg, data} wrapper or bare document {models, agents}.
 * 3. Filters authorized models strictly via agents[name="cli"].models.
 * 4. Extracts normalized credit rates and dynamic promotions evaluated at call time.
 * 5. Memory and disk caches are partitioned by account identity (edition:uid:enterpriseId).
 * 6. When upstream is unavailable and no cache exists, marks catalog unavailable — never invents fake prices.
 */

import fs from 'fs';
import path from 'path';
import { fetch } from 'undici';
import {
    getWorkBuddyBaseUrl,
    DEFAULT_DOMAIN,
    DEFAULT_AI_DOMAIN
} from './constants.js';
import { regionOf } from './variants.js';
import { resolveAppVersion, appUserAgent } from './app-version.js';
import { logger } from '../../utils/logger.js';

// Per-account memory cache Map: cacheKey -> { source, fallback, models, rawDoc, timestamp, endpoint }
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const catalogMemoryCache = new Map();

/**
 * Generate unique cache key for account to prevent CN / Global and multi-account cross-contamination
 * @param {Object|null} account
 * @returns {string}
 */
export function getAccountCacheKey(account) {
    if (!account) return 'anonymous:workbuddy-ai:default';
    const summary = account.credentialManager ? account.credentialManager.getAccountSummary() : account;
    const edition = summary.edition || 'workbuddy-ai';
    const uid = summary.uid || 'anon';
    const enterpriseId = summary.enterpriseId || '0';
    return `${edition}:${uid}:${enterpriseId}`;
}

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
 * Normalize credits value into formatted string, free boolean, and numerical multiplier
 * Handles "x0.00", "0", "0.00", "x0.00 credits", "x3.47", 1.5, etc.
 * @param {any} val
 * @returns {{ credits: string, isFree: boolean, multiplier: number }}
 */
export function normalizeCredits(val) {
    if (val === null || val === undefined) {
        return { credits: 'x1.00', isFree: false, multiplier: 1.0 };
    }

    const str = String(val).trim().toLowerCase();
    const numMatch = str.match(/[\d.]+/);
    const num = numMatch ? parseFloat(numMatch[0]) : 1.0;

    const isFree = num === 0 || str.includes('x0.00') || str.includes('free');
    const formatted = isFree ? 'x0.00' : (str.startsWith('x') ? str.split(' ')[0] : `x${num.toFixed(2)}`);

    return {
        credits: formatted,
        isFree,
        multiplier: isFree ? 0 : num
    };
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
 * Parse and return active promotions currently valid at nowMs
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
 * Dynamically applies currently active promotions without freezing "Free now" into disk cache.
 *
 * @param {Object} doc - Unwrapped catalog document
 * @param {boolean} [isInternational=false]
 * @param {number} [nowMs=Date.now()] - Timestamp to evaluate promotion validity
 * @returns {Array<Object>} Array of standardized model metadata objects
 */
export function parseModelCatalog(doc, isInternational = false, nowMs = Date.now()) {
    if (!doc || typeof doc !== 'object') {
        throw new Error('Invalid catalog document: not an object');
    }

    const rawModels = Array.isArray(doc.models) ? doc.models : [];
    const agents = Array.isArray(doc.agents) ? doc.agents : [];
    const promotions = Array.isArray(doc.modelPromotions) ? doc.modelPromotions : [];
    const activePromos = parseActivePromotions(promotions, nowMs);

    // 1. Locate the "cli" agent to get authorized model IDs
    const cliAgent = agents.find(a => a && a.name === 'cli');
    if (!cliAgent || !Array.isArray(cliAgent.models) || cliAgent.models.length === 0) {
        logger.warn('[WorkBuddy] Catalog lists no "cli" agent models, falling back to raw models list');
    }

    const authorizedIds = new Set(Array.isArray(cliAgent?.models) ? cliAgent.models : []);

    // 2. Index raw models by ID
    const modelsById = new Map();
    for (const m of rawModels) {
        const id = m.id || m.model || m.name || m.modelId;
        if (typeof id !== 'string' || !id.trim()) continue;

        if (m.disabled === true || m.status === 'disabled') continue;

        const maxIn = Number(m.maxInputTokens);
        const maxOut = Number(m.maxOutputTokens);
        if (maxIn <= 0 || maxOut <= 0) continue;

        const lowerId = id.toLowerCase();
        if (lowerId.includes('embedding') || lowerId.includes('rerank')) continue;

        modelsById.set(id, m);
    }

    // 3. Collect candidate models
    let candidateList = [];
    if (authorizedIds.size > 0) {
        for (const id of authorizedIds) {
            const raw = modelsById.get(id);
            if (raw) {
                candidateList.push(raw);
            }
        }
    } else {
        candidateList = Array.from(modelsById.values());
    }

    // 4. Transform to standardized model objects
    const result = [];
    for (const m of candidateList) {
        const rawId = m.id || m.model || m.name;
        const displayName = m.name || m.displayName || m.label || rawId;

        const maxIn = Number(m.maxInputTokens) || 32768;
        const maxOut = Number(m.maxOutputTokens) || 4096;

        let contextWindow = maxIn;
        if (m.contextWindow && typeof m.contextWindow === 'object') {
            if (m.contextWindow.defaultLength && Number(m.contextWindow.defaultLength) > 0) {
                contextWindow = Number(m.contextWindow.defaultLength);
            }
        }

        const supportedContextWindows = Array.isArray(m.contextWindow?.supportedLengths)
            ? m.contextWindow.supportedLengths
            : [contextWindow];

        const supportsImages = (m.supportsImages === true) && (m.disabledMultimodal !== true);

        const reasoning = {
            supportsReasoning: !!(m.supportsReasoning || m.reasoning?.supportedEfforts),
            onlyReasoning: !!m.onlyReasoning,
            supportedEfforts: Array.isArray(m.reasoning?.supportedEfforts) ? m.reasoning.supportedEfforts : [],
            defaultEffort: m.reasoning?.defaultEffort || m.reasoning?.effort || 'medium',
            canDisableThinking: !!m.reasoning?.canDisableThinking
        };

        // Pricing & credits normalization
        const baseNorm = normalizeCredits(m.credits);
        let credits = baseNorm.credits;
        let isFree = baseNorm.isFree;
        let multiplier = baseNorm.multiplier;

        const badges = extractBadgesFromTags(m.tags);

        // Dynamically apply currently active promotion (if not expired)
        const promo = activePromos.get(rawId);
        if (promo) {
            if (promo.badge?.label && !badges.includes(promo.badge.label)) {
                badges.unshift(promo.badge.label);
            }
            if (promo.discount?.factor === 0 || promo.discount?.displayMode === 'replace') {
                if (promo.discount.factor === 0) {
                    credits = 'x0.00';
                    isFree = true;
                    multiplier = 0;
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
                multiplier: multiplier
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
 * Path to cache public catalog locally (contains NO tokens)
 * @param {string} cacheKey
 * @returns {string}
 */
function getCatalogCachePath(cacheKey) {
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(process.cwd(), 'data', 'workbuddy-catalog');
    if (!fs.existsSync(dir)) {
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    }
    return path.join(dir, `${safeKey}.json`);
}

/**
 * Save raw catalog document and metadata to disk cache
 * @param {string} cacheKey
 * @param {Object} rawDoc
 */
function saveCatalogCache(cacheKey, rawDoc) {
    try {
        const filePath = getCatalogCachePath(cacheKey);
        const data = {
            cacheKey,
            rawDoc,
            cachedAt: new Date().toISOString(),
            cachedAtMs: Date.now()
        };
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (_) {}
}

/**
 * Read cached raw catalog from disk if recent
 * @param {string} cacheKey
 * @param {boolean} isInternational
 * @returns {Array<Object>|null}
 */
function readCatalogCache(cacheKey, isInternational = false) {
    try {
        const filePath = getCatalogCachePath(cacheKey);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const data = JSON.parse(content);
            if (data?.rawDoc) {
                const models = parseModelCatalog(data.rawDoc, isInternational, Date.now());
                return models.map(m => ({ ...m, source: 'cache', stale: true }));
            }
        }
    } catch (_) {}
    return null;
}

/**
 * Fallback catalog when remote fetch fails and no cache exists.
 * Does NOT fabricate fake models or fake 0.00x prices.
 *
 * @param {string} reason
 * @returns {Object}
 */
function buildFallbackCatalog(reason = '') {
    return {
        source: 'fallback',
        fallback: true,
        catalogUnavailable: true,
        error: reason || 'Model catalog unavailable',
        models: [],
        timestamp: Date.now()
    };
}

/**
 * Fetch dynamic models from upstream WorkBuddy API with isolated per-account caching.
 *
 * @param {Object} [account] - WorkBuddy account object
 * @param {Object} [options]
 * @param {boolean} [options.forceRefresh=false]
 * @returns {Promise<{source: 'remote'|'cache'|'fallback', fallback: boolean, error?: string, models: Array<Object>, timestamp: number}>}
 */
export async function fetchRemoteWorkBuddyModels(account = null, options = {}) {
    const cacheKey = getAccountCacheKey(account);
    const now = Date.now();

    const inMemory = catalogMemoryCache.get(cacheKey);
    if (!options.forceRefresh && inMemory && (now - inMemory.timestamp < MODEL_CACHE_TTL_MS)) {
        // Re-evaluate promotions at current time if rawDoc is available
        if (inMemory.rawDoc) {
            const fresh = parseModelCatalog(inMemory.rawDoc, inMemory.isGlobal, now);
            return {
                ...inMemory,
                models: fresh
            };
        }
        return inMemory;
    }

    const summary = account?.credentialManager ? account.credentialManager.getAccountSummary() : {};
    const domain = summary.domain || DEFAULT_AI_DOMAIN;
    const isGlobal = regionOf(domain) === 'global';
    const baseUrl = getWorkBuddyBaseUrl(domain);

    let token = '';
    if (account?.credentialManager?.data?.auth?.accessToken) {
        token = account.credentialManager.data.auth.accessToken;
    }

    if (!token) {
        const diskCache = readCatalogCache(cacheKey, isGlobal);
        if (diskCache && diskCache.length > 0) {
            return {
                source: 'cache',
                fallback: false,
                models: diskCache,
                timestamp: Date.now()
            };
        }
        return buildFallbackCatalog('No credentials available to fetch model catalog');
    }

    // Endpoint candidates:
    // Global: /v3/config
    // Domestic: /console/enterprises/personal/models -> /v2/enterprises/personal/models -> /v3/config
    const endpoints = isGlobal
        ? [`${baseUrl}/v3/config`]
        : [
            `${baseUrl}/console/enterprises/personal/models`,
            `${baseUrl}/v2/enterprises/personal/models`,
            `${baseUrl}/v3/config`
        ];

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
                    const parsedModels = parseModelCatalog(doc, isGlobal, now);
                    if (parsedModels.length > 0) {
                        logger.success(`[WorkBuddy] Discovered ${parsedModels.length} models from ${endpoint}`);
                        saveCatalogCache(cacheKey, doc);
                        const result = {
                            source: 'remote',
                            fallback: false,
                            models: parsedModels,
                            rawDoc: doc,
                            isGlobal,
                            timestamp: Date.now(),
                            endpoint: endpoint
                        };
                        catalogMemoryCache.set(cacheKey, result);
                        return result;
                    }
                }
            } else {
                const status = res.status;
                const errText = await res.text().catch(() => res.statusText);
                lastError = `HTTP ${status}: ${errText.substring(0, 150)}`;
                logger.warn(`[WorkBuddy] Model fetch at ${endpoint} returned HTTP ${status}: ${lastError}`);
            }
        } catch (err) {
            lastError = err.message;
            logger.warn(`[WorkBuddy] Failed to fetch models from ${endpoint}: ${err.message}`);
        }
    }

    // Try reading disk cache for this account
    const diskCache = readCatalogCache(cacheKey, isGlobal);
    if (diskCache && diskCache.length > 0) {
        logger.info(`[WorkBuddy] Using cached models from previous successful fetch (${diskCache.length} models)`);
        const result = {
            source: 'cache',
            fallback: false,
            stale: true,
            error: lastError,
            models: diskCache,
            timestamp: Date.now()
        };
        catalogMemoryCache.set(cacheKey, result);
        return result;
    }

    // Fallback: models list is empty, clearly marked as unavailable
    return buildFallbackCatalog(lastError);
}

/**
 * Get all available WorkBuddy model IDs without 'workbuddy/' prefix
 * @param {Object} [account]
 * @returns {Promise<string[]>}
 */
export async function getAvailableWorkBuddyModels(account = null) {
    const catalog = await fetchRemoteWorkBuddyModels(account);
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
            fallback: !!catalog.fallback
        }))
    };
}
