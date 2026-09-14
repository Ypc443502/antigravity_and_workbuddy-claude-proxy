/**
 * WorkBuddy Variants and Regions
 * Differentiates official WorkBuddy AI (global) and WorkBuddy Desktop (CN)
 * based on verified implementations.
 */

export const WORKBUDDY_AI = {
    id: 'workbuddy-ai',
    displayName: 'WorkBuddy AI',
    region: 'global',
    baseUrl: 'https://www.workbuddy.ai',
    desktopFilename: 'workbuddy-desktop-ai.info'
};

export const WORKBUDDY_CN = {
    id: 'workbuddy',
    displayName: 'WorkBuddy',
    region: 'cn',
    baseUrl: 'https://copilot.tencent.com',
    desktopFilename: 'workbuddy-desktop.info'
};

export const ALL_VARIANTS = [WORKBUDDY_AI, WORKBUDDY_CN];

export const ALLOWED_DESKTOP_FILENAMES = [
    WORKBUDDY_AI.desktopFilename,
    WORKBUDDY_CN.desktopFilename
];

/**
 * Determine region (global vs cn) from domain
 * @param {string} domain
 * @returns {'global' | 'cn'}
 */
export function regionOf(domain) {
    if (!domain) return 'cn';
    const d = domain.toLowerCase().trim();
    if (d === 'workbuddy.ai' || d.endsWith('.workbuddy.ai')) {
        return 'global';
    }
    return 'cn';
}

/**
 * Determine variant by desktop auth filename
 * @param {string} filename
 * @returns {Object|null}
 */
export function getVariantByFilename(filename) {
    if (!filename) return null;
    const base = filename.toLowerCase().trim();
    if (base.endsWith(WORKBUDDY_AI.desktopFilename.toLowerCase())) {
        return WORKBUDDY_AI;
    }
    if (base.endsWith(WORKBUDDY_CN.desktopFilename.toLowerCase())) {
        return WORKBUDDY_CN;
    }
    return null;
}

/**
 * Determine variant by domain
 * @param {string} domain
 * @returns {Object}
 */
export function getVariantByDomain(domain) {
    return regionOf(domain) === 'global' ? WORKBUDDY_AI : WORKBUDDY_CN;
}
