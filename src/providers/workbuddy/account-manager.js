/**
 * WorkBuddy Account Manager
 * Discovers and manages multiple WorkBuddy accounts from .info files,
 * supports selection strategies, rate-limit cooldowns, and credential management.
 */

import { findAuthFiles, readAuthFile, validateAuthFile, maskUid, buildAccountId } from './auth-locator.js';
import { WorkBuddyCredentialManager } from './credentials.js';
import { logger } from '../../utils/logger.js';

export class WorkBuddyAccountManager {
    /**
     * @param {Object} [options]
     * @param {string} [options.authDir]
     * @param {string} [options.strategy='round-robin']
     */
    constructor(options = {}) {
        this.authDir = options.authDir || null;
        this.strategy = options.strategy || 'round-robin';
        this.accounts = []; // Array of account objects
        this.currentIndex = 0;
        this.initialized = false;
    }

    /**
     * Initialize account manager by scanning and registering accounts
     */
    async initialize() {
        if (this.initialized) return;
        await this.scanAccounts();
        this.initialized = true;
        const status = this.getStatus();
        logger.info(`[WorkBuddy] Account pool initialized: ${status.summary}`);
    }

    /**
     * Scan auth directory for .info files and populate/merge account pool.
     * @param {string} [customDir]
     * @returns {Promise<Array>} List of scanned account summaries
     */
    async scanAccounts(customDir = null) {
        const dirToScan = customDir || this.authDir;
        const files = findAuthFiles(dirToScan);
        const scannedSummaries = [];

        for (const filePath of files) {
            try {
                const data = readAuthFile(filePath);
                const val = validateAuthFile(data);
                if (!val.valid) {
                    logger.warn(`[WorkBuddy] Skipping invalid auth file ${filePath}: ${val.error}`);
                    continue;
                }

                const accountId = buildAccountId(data, filePath, filePath);
                let existing = this.accounts.find(a => a.id === accountId || a.authFilePath === filePath);

                if (!existing) {
                    const credManager = new WorkBuddyCredentialManager(filePath);
                    const summary = credManager.getAccountSummary();

                    const newAccount = {
                        id: summary.id,
                        provider: 'workbuddy',
                        uid: summary.uid,
                        uidMasked: summary.uidMasked,
                        nickname: summary.nickname,
                        enterpriseId: summary.enterpriseId,
                        enterpriseName: summary.enterpriseName,
                        edition: summary.edition,
                        editionLabel: summary.editionLabel,
                        domain: summary.domain,
                        sourceFile: summary.sourceFile,
                        sourceType: 'local',
                        authFilePath: filePath,
                        enabled: true,
                        lastUsed: null,
                        isInvalid: false,
                        invalidReason: null,
                        modelRateLimits: {},
                        credentialManager: credManager
                    };

                    this.accounts.push(newAccount);
                    scannedSummaries.push(summary);
                    logger.info(`[WorkBuddy] Registered account: ${summary.nickname} (${summary.uidMasked}, ${summary.editionLabel}) from ${filePath}`);
                } else {
                    // Update credential manager file path and details while preserving enabled state
                    existing.credentialManager.reloadIfNeeded(true);
                    const summary = existing.credentialManager.getAccountSummary();
                    existing.id = summary.id;
                    existing.nickname = summary.nickname;
                    existing.enterpriseId = summary.enterpriseId;
                    existing.enterpriseName = summary.enterpriseName;
                    existing.edition = summary.edition;
                    existing.editionLabel = summary.editionLabel;
                    existing.domain = summary.domain;
                    existing.sourceFile = summary.sourceFile;
                    scannedSummaries.push(summary);
                }
            } catch (err) {
                logger.error(`[WorkBuddy] Failed to register auth file ${filePath}: ${err.message}`);
            }
        }

        return scannedSummaries;
    }

    /**
     * Clear expired model rate limits
     */
    clearExpiredLimits() {
        const now = Date.now();
        for (const account of this.accounts) {
            if (!account.modelRateLimits) continue;
            for (const [modelId, limit] of Object.entries(account.modelRateLimits)) {
                if (limit.isRateLimited && limit.resetTime <= now) {
                    limit.isRateLimited = false;
                    limit.resetTime = null;
                    logger.success(`[WorkBuddy] Rate limit expired for account ${account.uidMasked} (model: ${modelId})`);
                }
            }
        }
    }

    /**
     * Check if an account is usable for a given model
     * @param {Object} account
     * @param {string} [modelId]
     * @returns {boolean}
     */
    isAccountUsable(account, modelId = null) {
        if (!account) return false;
        if (account.enabled === false) return false;
        if (account.isInvalid) return false;

        // Check if token is expired
        if (account.credentialManager && account.credentialManager.isTokenExpired()) {
            return false;
        }

        if (modelId && account.modelRateLimits && account.modelRateLimits[modelId]) {
            const limit = account.modelRateLimits[modelId];
            if (limit.isRateLimited && limit.resetTime > Date.now()) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get all usable accounts for a model
     * @param {string} [modelId]
     * @returns {Array}
     */
    getUsableAccounts(modelId = null) {
        this.clearExpiredLimits();
        return this.accounts.filter(a => this.isAccountUsable(a, modelId));
    }

    /**
     * Select an account for a request.
     * @param {string} [modelId]
     * @returns {{ account: Object|null, index: number }}
     */
    selectAccount(modelId = null) {
        this.clearExpiredLimits();
        const usable = this.getUsableAccounts(modelId);

        if (usable.length === 0) {
            return { account: null, index: -1 };
        }

        if (this.strategy === 'sticky') {
            // Sticky: keep using current account if it's usable
            const current = this.accounts[this.currentIndex];
            if (current && this.isAccountUsable(current, modelId)) {
                return { account: current, index: this.currentIndex };
            }
        }

        // Round-Robin selection
        for (let i = 0; i < this.accounts.length; i++) {
            const candidateIndex = (this.currentIndex + i) % this.accounts.length;
            const candidate = this.accounts[candidateIndex];
            if (this.isAccountUsable(candidate, modelId)) {
                this.currentIndex = (candidateIndex + 1) % this.accounts.length;
                candidate.lastUsed = Date.now();
                return { account: candidate, index: candidateIndex };
            }
        }

        // Fallback to first usable
        const first = usable[0];
        first.lastUsed = Date.now();
        const index = this.accounts.indexOf(first);
        return { account: first, index };
    }

    /**
     * Mark an account as rate-limited for a specific model
     * @param {string} accountId - Account ID or uid
     * @param {string} modelId - Model ID
     * @param {number} [resetMs=30000] - Duration in ms
     */
    markRateLimited(accountId, modelId, resetMs = 30000) {
        const account = this.accounts.find(a => a.id === accountId || a.uid === accountId);
        if (!account) return;

        if (!account.modelRateLimits) {
            account.modelRateLimits = {};
        }

        const duration = resetMs > 0 ? resetMs : 30000;
        account.modelRateLimits[modelId] = {
            isRateLimited: true,
            resetTime: Date.now() + duration,
            durationMs: duration
        };

        logger.warn(`[WorkBuddy] Account ${account.uidMasked} rate limited for ${modelId}. Cooldown: ${Math.round(duration / 1000)}s`);
    }

    /**
     * Mark an account as invalid (e.g. permanent authentication failure)
     * @param {string} accountId
     * @param {string} reason
     */
    markInvalid(accountId, reason = 'Authentication failed') {
        const account = this.accounts.find(a => a.id === accountId || a.uid === accountId);
        if (!account) return;

        account.isInvalid = true;
        account.invalidReason = reason;
        account.invalidAt = Date.now();
        logger.error(`[WorkBuddy] Account ${account.uidMasked} marked INVALID: ${reason}`);
    }

    /**
     * Reset all rate limits for optimistic retry
     */
    resetAllRateLimits() {
        for (const account of this.accounts) {
            account.modelRateLimits = {};
        }
        logger.warn('[WorkBuddy] Reset all model rate limits for optimistic retry');
    }

    /**
     * Check if all accounts are rate-limited for a model
     * @param {string} modelId
     * @returns {boolean}
     */
    isAllRateLimited(modelId) {
        if (this.accounts.length === 0) return true;
        return this.accounts.every(a => !this.isAccountUsable(a, modelId));
    }

    /**
     * Toggle enabled state of an account
     * @param {string} accountId
     * @param {boolean} enabled
     */
    setAccountEnabled(accountId, enabled) {
        const account = this.accounts.find(a => a.id === accountId || a.uid === accountId);
        if (!account) return false;
        account.enabled = !!enabled;
        logger.info(`[WorkBuddy] Account ${account.uidMasked} set to ${account.enabled ? 'ENABLED' : 'DISABLED'}`);
        return true;
    }

    /**
     * Remove account from proxy account pool (does NOT delete .info file)
     * @param {string} accountId
     */
    removeAccount(accountId) {
        const idx = this.accounts.findIndex(a => a.id === accountId || a.uid === accountId);
        if (idx === -1) return false;
        const [removed] = this.accounts.splice(idx, 1);
        logger.info(`[WorkBuddy] Account removed from proxy: ${removed.uidMasked} (file preserved: ${removed.authFilePath})`);
        return true;
    }

    /**
     * Force refresh token for a specific account
     * @param {string} accountId
     */
    async refreshAccount(accountId) {
        const account = this.accounts.find(a => a.id === accountId || a.uid === accountId);
        if (!account) {
            throw new Error(`Account not found: ${accountId}`);
        }
        await account.credentialManager.forceRefresh();
        account.isInvalid = false;
        account.invalidReason = null;
        return account.credentialManager.getAccountSummary();
    }

    /**
     * Get high-level status for health check and WebUI
     * @returns {Object}
     */
    getStatus() {
        this.clearExpiredLimits();
        const total = this.accounts.length;
        const invalid = this.accounts.filter(a => a.isInvalid).length;
        const disabled = this.accounts.filter(a => a.enabled === false).length;

        const now = Date.now();
        const rateLimited = this.accounts.filter(a => {
            if (a.isInvalid || a.enabled === false) return false;
            return Object.values(a.modelRateLimits || {}).some(l => l.isRateLimited && l.resetTime > now);
        }).length;

        const available = this.accounts.filter(a => this.isAccountUsable(a)).length;

        const accountList = this.accounts.map(a => {
            const summary = a.credentialManager ? a.credentialManager.getAccountSummary() : {};
            const isRateLimited = Object.values(a.modelRateLimits || {}).some(l => l.isRateLimited && l.resetTime > now);

            let status = 'valid';
            if (a.enabled === false) {
                status = 'disabled';
            } else if (a.isInvalid || summary.isExpired) {
                status = 'reauth-required';
            } else if (isRateLimited) {
                status = 'rate-limited';
            }

            return {
                id: a.id,
                provider: 'workbuddy',
                uid: a.uid,
                uidMasked: a.uidMasked,
                nickname: a.nickname,
                enterpriseId: a.enterpriseId,
                enterpriseName: a.enterpriseName,
                edition: a.edition || summary.edition || 'unknown',
                editionLabel: a.editionLabel || summary.editionLabel || 'WORKBUDDY',
                domain: a.domain || summary.domain,
                sourceFile: a.sourceFile || summary.sourceFile,
                sourceType: 'local',
                authFilePath: a.authFilePath,
                enabled: a.enabled !== false,
                status: status,
                lastUsed: a.lastUsed ? new Date(a.lastUsed).toISOString() : null,
                lastModified: summary.lastModified || null,
                isInvalid: a.isInvalid || false,
                invalidReason: a.invalidReason || null,
                tokenExpiresAt: summary.tokenExpiresAt || null,
                refreshExpiresAt: summary.refreshExpiresAt || null,
                isExpired: summary.isExpired || false,
                modelRateLimits: a.modelRateLimits || {}
            };
        });

        return {
            provider: 'workbuddy',
            total,
            available,
            rateLimited,
            invalid,
            disabled,
            summary: `${total} total, ${available} available, ${rateLimited} rate-limited, ${invalid} invalid`,
            accounts: accountList
        };
    }
}

export default WorkBuddyAccountManager;
