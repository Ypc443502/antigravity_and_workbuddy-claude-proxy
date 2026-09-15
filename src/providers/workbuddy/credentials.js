/**
 * WorkBuddy Credential Manager
 * Manages auth token state for official WorkBuddy Desktop credentials.
 *
 * Rules:
 * 1. Official desktop auth file (workbuddy-desktop-ai.info) is READ-ONLY - never overwrite it.
 * 2. Refreshed tokens are saved to proxy's own copy (data/workbuddy-auth/workbuddy-ai.json).
 * 3. Identity check: if desktop.uid !== own.uid, user switched accounts in desktop app -> use desktop.
 * 4. Token timestamps normalized via normalizeEpochMs (handles 13-digit ms and 10-digit s).
 * 5. Preemptive refresh only when Date.now() + 5m >= expiresAtMs.
 * 6. Fallback: if refresh endpoint fails but accessToken has >= 30s remaining, keep using it.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { Mutex } from 'async-mutex';
import { fetch } from 'undici';
import {
    getWorkBuddyBaseUrl,
    DEFAULT_DOMAIN,
    DEFAULT_AI_DOMAIN
} from './constants.js';
import {
    readAuthFile,
    validateAuthFile,
    maskUid,
    buildAccountId,
    normalizeEpochMs
} from './auth-locator.js';
import { getVariantByFilename, getVariantByDomain, regionOf } from './variants.js';
import { detectEdition, getEditionLabel } from './edition.js';
import { chatUserAgent, resolveAppVersion, resolveCliVersion } from './app-version.js';
import { logger } from '../../utils/logger.js';
import { ProviderError } from '../provider-error.js';

// Preemptive refresh margin (5 minutes before expiry)
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Fallback grace period (keep using accessToken if it still has 30s remaining)
const FALLBACK_GRACE_MS = 30 * 1000;

export class WorkBuddyCredentialManager {
    /**
     * @param {string} filePath - Absolute path to official desktop .info file
     */
    constructor(filePath) {
        this.filePath = path.resolve(filePath);
        this.mutex = new Mutex();

        this.variant = getVariantByFilename(this.filePath) || getVariantByDomain('www.workbuddy.ai');
        this.ownStorageDir = path.join(process.cwd(), 'data', 'workbuddy-auth');
        this.ownStoragePath = path.join(this.ownStorageDir, `${this.variant.id}.json`);

        this.data = null;
        this.mtimeMs = 0;
        this.lastRefreshAttempt = 0;
        this.activeSource = 'desktop'; // 'desktop' or 'own'

        // Initial load
        this.reloadIfNeeded(true);
    }

    /**
     * Ensure proxy private auth storage directory exists
     */
    _ensureOwnStorageDir() {
        if (!fs.existsSync(this.ownStorageDir)) {
            try {
                fs.mkdirSync(this.ownStorageDir, { recursive: true });
            } catch (_) {}
        }
    }

    /**
     * Load proxy's own saved token copy if available
     * @returns {Object|null}
     */
    _readOwnCredential() {
        try {
            if (fs.existsSync(this.ownStoragePath)) {
                const content = fs.readFileSync(this.ownStoragePath, 'utf8');
                return JSON.parse(content);
            }
        } catch (_) {}
        return null;
    }

    /**
     * Save updated token to proxy's own copy (NEVER touches official desktop file)
     * @param {Object} tokenData
     */
    _saveOwnCredential(tokenData) {
        try {
            this._ensureOwnStorageDir();
            const payload = {
                uid: this.data?.account?.uid,
                enterpriseId: this.data?.account?.enterpriseId || '0',
                nickname: this.data?.account?.nickname,
                domain: this.data?.auth?.domain,
                variantId: this.variant.id,
                accessToken: tokenData.accessToken,
                refreshToken: tokenData.refreshToken,
                expiresAtMs: tokenData.expiresAtMs,
                refreshExpiresAtMs: tokenData.refreshExpiresAtMs,
                updatedAtMs: Date.now()
            };
            const tmp = path.join(this.ownStorageDir, `.tmp_${this.variant.id}_${Date.now()}.json`);
            fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
            fs.renameSync(tmp, this.ownStoragePath);
        } catch (err) {
            logger.warn(`[WorkBuddy] Failed to save proxy own credential copy: ${err.message}`);
        }
    }

    /**
     * Reload credentials comparing Desktop official file with proxy's own copy.
     * @param {boolean} [force=false]
     */
    reloadIfNeeded(force = false) {
        try {
            if (!fs.existsSync(this.filePath)) {
                throw new Error(`Official auth file not found: ${this.filePath}`);
            }

            const stat = fs.statSync(this.filePath);
            if (force || stat.mtimeMs !== this.mtimeMs || !this.data) {
                const desktopData = readAuthFile(this.filePath);
                const val = validateAuthFile(desktopData);
                if (!val.valid) {
                    throw new Error(val.error);
                }

                this.mtimeMs = stat.mtimeMs;
                this.variant = getVariantByFilename(this.filePath) || getVariantByDomain(desktopData.auth?.domain);

                const desktopUid = desktopData.account?.uid || desktopData.account?.uin;
                const desktopEnterpriseId = desktopData.account?.enterpriseId || '0';
                const desktopExpiresAtMs = normalizeEpochMs(desktopData.auth?.expiresAt);
                const desktopRefreshExpiresAtMs = normalizeEpochMs(desktopData.auth?.refreshExpiresAt);

                // Check proxy's own copy
                const ownData = this._readOwnCredential();

                // Identity check: if user switched account in official Desktop app, prioritize Desktop
                let useOwn = false;
                if (ownData && ownData.uid === desktopUid && String(ownData.enterpriseId) === String(desktopEnterpriseId)) {
                    if (ownData.expiresAtMs && ownData.expiresAtMs > desktopExpiresAtMs) {
                        useOwn = true;
                    }
                }

                if (useOwn && ownData) {
                    this.data = {
                        account: {
                            ...desktopData.account,
                            uid: ownData.uid,
                            enterpriseId: ownData.enterpriseId,
                            nickname: ownData.nickname || desktopData.account?.nickname
                        },
                        auth: {
                            ...desktopData.auth,
                            accessToken: ownData.accessToken,
                            refreshToken: ownData.refreshToken,
                            domain: ownData.domain || desktopData.auth?.domain,
                            expiresAt: ownData.expiresAtMs,
                            refreshExpiresAt: ownData.refreshExpiresAtMs
                        }
                    };
                    this.activeSource = 'own';
                } else {
                    this.data = {
                        account: desktopData.account,
                        auth: {
                            ...desktopData.auth,
                            expiresAt: desktopExpiresAtMs,
                            refreshExpiresAt: desktopRefreshExpiresAtMs
                        }
                    };
                    this.activeSource = 'desktop';
                }

                logger.debug(`[WorkBuddy] Loaded credentials for ${maskUid(this.data.account?.uid)} (variant: ${this.variant.displayName}, source: ${this.activeSource})`);
            }
        } catch (err) {
            logger.error(`[WorkBuddy] Failed to read auth file ${this.filePath}: ${err.message}`);
            if (!this.data) {
                throw err;
            }
        }
    }

    /**
     * Get normalized expiration timestamp in milliseconds
     * @returns {number}
     */
    getExpiresAtMs() {
        this.reloadIfNeeded();
        return normalizeEpochMs(this.data?.auth?.expiresAt);
    }

    /**
     * Get normalized refresh expiration timestamp in milliseconds
     * @returns {number}
     */
    getRefreshExpiresAtMs() {
        this.reloadIfNeeded();
        return normalizeEpochMs(this.data?.auth?.refreshExpiresAt);
    }

    /**
     * Check if token is actually expired or needs preemptive refresh.
     * Preemptive refresh only triggered if within REFRESH_MARGIN_MS (5 min).
     * Tokens valid until 2027 will NEVER be marked as expired.
     * @returns {boolean}
     */
    isTokenExpired() {
        const expiresAtMs = this.getExpiresAtMs();
        if (!expiresAtMs) return false;
        return (Date.now() + REFRESH_MARGIN_MS) >= expiresAtMs;
    }

    /**
     * Check if access token is still valid right now with grace period (>= 30s)
     * @returns {boolean}
     */
    isAccessTokenStillUsable() {
        const expiresAtMs = this.getExpiresAtMs();
        if (!expiresAtMs) return true;
        return (Date.now() + FALLBACK_GRACE_MS) < expiresAtMs;
    }

    /**
     * Force token refresh using official WorkBuddy refresh endpoint.
     * Never modifies the official desktop file; saves to proxy own storage.
     * If refresh fails but accessToken is still valid (>= 30s), falls back to existing token.
     * @returns {Promise<boolean>}
     */
    async forceRefresh() {
        return await this.mutex.runExclusive(async () => {
            this.reloadIfNeeded();

            const now = Date.now();
            if (now - this.lastRefreshAttempt < 5000) {
                return true;
            }
            this.lastRefreshAttempt = now;

            const auth = this.data?.auth;
            if (!auth?.accessToken || !auth?.refreshToken) {
                if (this.isAccessTokenStillUsable()) {
                    logger.warn(`[WorkBuddy] No refreshToken but accessToken still valid. Continuing with existing token.`);
                    return true;
                }
                throw new ProviderError({
                    provider: 'workbuddy',
                    status: 401,
                    type: 'authentication_error',
                    message: 'Cannot refresh WorkBuddy token: missing accessToken or refreshToken'
                });
            }

            const domain = auth.domain || (this.variant.region === 'global' ? DEFAULT_AI_DOMAIN : DEFAULT_DOMAIN);
            const baseUrl = getWorkBuddyBaseUrl(domain);
            const refreshUrl = `${baseUrl}/v2/plugin/auth/token/refresh`;

            logger.info(`[WorkBuddy] Refreshing token for ${maskUid(this.data.account?.uid)} at ${refreshUrl}...`);

            const headers = {
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'Origin': baseUrl,
                'Referer': `${baseUrl}/`,
                'User-Agent': 'CLI/2.63.2 CodeBuddy/2.63.2',
                'Authorization': `Bearer ${auth.accessToken}`,
                'X-Refresh-Token': auth.refreshToken,
                'X-Auth-Refresh-Source': 'workbuddy'
            };

            const enterpriseId = this.data.account?.enterpriseId;
            if (enterpriseId && enterpriseId !== '0' && enterpriseId !== 'personal') {
                headers['X-Enterprise-Id'] = String(enterpriseId);
            }

            try {
                const res = await fetch(refreshUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify({})
                });

                if (!res.ok) {
                    const status = res.status;
                    const errorText = await res.text();
                    logger.warn(`[WorkBuddy] Token refresh returned HTTP ${status}: ${errorText.substring(0, 150)}`);

                    // Graceful fallback: if accessToken is still valid for at least 30s, do not fail
                    if (this.isAccessTokenStillUsable()) {
                        logger.warn(`[WorkBuddy] Refresh failed but current accessToken is still usable for >= 30s. Continuing with current session.`);
                        return true;
                    }

                    throw new ProviderError({
                        provider: 'workbuddy',
                        status: status,
                        type: 'authentication_error',
                        message: `WorkBuddy token refresh failed (HTTP ${status}): ${errorText.substring(0, 150)}`
                    });
                }

                const json = await res.json();
                const tokenData = json.data || json;

                const newAccessToken = tokenData.accessToken || tokenData.access_token;
                const newRefreshToken = tokenData.refreshToken || tokenData.refresh_token;

                if (!newAccessToken) {
                    throw new Error('Refresh API returned invalid payload without accessToken');
                }

                const expiresIn = tokenData.expiresIn || tokenData.expires_in || 7200;
                const refreshExpiresIn = tokenData.refreshExpiresIn || tokenData.refresh_expires_in || (30 * 86400);

                const refreshedAt = Date.now();
                const newExpiresAtMs = refreshedAt + (expiresIn * 1000);
                const newRefreshExpiresAtMs = refreshedAt + (refreshExpiresIn * 1000);

                // Update in-memory state
                this.data.auth.accessToken = newAccessToken;
                if (newRefreshToken) {
                    this.data.auth.refreshToken = newRefreshToken;
                }
                this.data.auth.expiresAt = newExpiresAtMs;
                this.data.auth.refreshExpiresAt = newRefreshExpiresAtMs;
                this.data.auth.lastRefreshTime = refreshedAt;
                this.activeSource = 'own';

                // Save to proxy own copy (NEVER overwrite official desktop file)
                this._saveOwnCredential({
                    accessToken: newAccessToken,
                    refreshToken: newRefreshToken || auth.refreshToken,
                    expiresAtMs: newExpiresAtMs,
                    refreshExpiresAtMs: newRefreshExpiresAtMs
                });

                logger.success(`[WorkBuddy] Token refreshed successfully for ${maskUid(this.data.account?.uid)} (saved to proxy storage)`);
                return true;

            } catch (err) {
                if (this.isAccessTokenStillUsable()) {
                    logger.warn(`[WorkBuddy] Token refresh exception (${err.message}) but accessToken is still valid. Continuing.`);
                    return true;
                }
                if (err instanceof ProviderError) throw err;
                throw new ProviderError({
                    provider: 'workbuddy',
                    status: 500,
                    type: 'authentication_error',
                    message: `WorkBuddy token refresh exception: ${err.message}`,
                    cause: err
                });
            }
        });
    }

    /**
     * Get headers for WorkBuddy API requests.
     * Matches verified WorkBuddy Desktop upstream client requirements.
     * @returns {Promise<Record<string, string>>}
     */
    async getHeaders() {
        this.reloadIfNeeded();

        // Only refresh if genuinely near expiration
        if (this.isTokenExpired()) {
            await this.forceRefresh();
        }

        const auth = this.data?.auth;
        const account = this.data?.account;

        const uid = account?.uid || account?.uin || '';
        const enterpriseId = account?.enterpriseId ? String(account.enterpriseId) : '';
        const domain = auth?.domain || (this.variant.region === 'global' ? DEFAULT_AI_DOMAIN : DEFAULT_DOMAIN);
        const baseUrl = getWorkBuddyBaseUrl(domain);
        const isInternational = this.variant.region === 'global'
            || domain === 'workbuddy.ai'
            || domain.endsWith('.workbuddy.ai');

        const appVersion = resolveAppVersion();

        // WorkBuddy AI international chat has a channel gate. The old
        // CLI/CodeBuddy User-Agent is rejected with HTTP 400 / code 11128.
        // The official desktop also appends its bundled CLI version through
        // CLIENT_INFO_USER_AGENT_EXTENSION.
        const userAgent = isInternational
            ? chatUserAgent(appVersion, resolveCliVersion())
            : 'CLI/2.63.2 CodeBuddy/2.63.2';

        const headers = {
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': baseUrl,
            'Referer': `${baseUrl}/`,
            'User-Agent': userAgent,
            'Authorization': `Bearer ${auth.accessToken}`,
            'X-Product': 'SaaS'
        };

        if (isInternational) {
            // Official WorkBuddy model requests identify the desktop client
            // explicitly with these IDE headers.
            headers['X-IDE-Type'] = 'WorkBuddy';
            headers['X-IDE-Name'] = 'WorkBuddy';
            headers['X-IDE-Version'] = appVersion;
            headers['X-Request-ID'] = randomUUID().replace(/-/g, '');
        }

        if (uid) {
            headers['X-User-Id'] = String(uid);
        } else {
            headers['X-No-User-Id'] = '1';
        }

        if (enterpriseId && enterpriseId !== '0' && enterpriseId !== 'personal') {
            headers['X-Enterprise-Id'] = enterpriseId;
        } else {
            headers['X-No-Enterprise-Id'] = '1';
        }

        if (domain) {
            headers['X-Domain'] = domain;
        } else {
            headers['X-No-Department-Info'] = '1';
        }

        return headers;
    }

    /**
     * Safe account summary for display or status checks (never exposes secrets)
     * @returns {Object}
     */
    getAccountSummary() {
        this.reloadIfNeeded();
        const account = this.data?.account || {};
        const auth = this.data?.auth || {};

        const uid = account.uid || account.uin || 'unknown';
        const enterpriseId = account.enterpriseId ? String(account.enterpriseId) : '0';
        const enterpriseName = account.enterpriseName || '';
        const nickname = account.nickname || uid;

        const domain = auth.domain || (this.variant.region === 'global' ? DEFAULT_AI_DOMAIN : DEFAULT_DOMAIN);
        const edition = detectEdition(this.data, this.filePath);
        const editionLabel = getEditionLabel(edition);

        const expiresAtMs = this.getExpiresAtMs();
        const refreshExpiresAtMs = this.getRefreshExpiresAtMs();

        return {
            id: buildAccountId(this.data, path.basename(this.filePath, '.info'), this.filePath),
            uid: String(uid),
            uidMasked: maskUid(uid),
            nickname: nickname,
            enterpriseId: enterpriseId,
            enterpriseName: enterpriseName,
            edition: edition,
            editionLabel: editionLabel,
            region: this.variant.region,
            provider: 'workbuddy',
            sourceType: 'local',
            sourceFile: path.basename(this.filePath),
            authFilePath: this.filePath,
            activeCredentialSource: this.activeSource,
            domain: domain,
            lastModified: this.mtimeMs ? new Date(this.mtimeMs).toISOString() : null,
            tokenExpiresAt: expiresAtMs ? new Date(expiresAtMs).toISOString() : null,
            refreshExpiresAt: refreshExpiresAtMs ? new Date(refreshExpiresAtMs).toISOString() : null,
            expiresAtMs: expiresAtMs,
            refreshExpiresAtMs: refreshExpiresAtMs,
            isExpired: this.isTokenExpired(),
            isUsable: this.isAccessTokenStillUsable(),
            lastRefreshTime: auth.lastRefreshTime ? new Date(auth.lastRefreshTime).toISOString() : null
        };
    }
}

export default WorkBuddyCredentialManager;
