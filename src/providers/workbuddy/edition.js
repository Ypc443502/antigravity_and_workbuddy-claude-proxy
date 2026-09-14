/**
 * WorkBuddy Edition Detection
 * Differentiates between WorkBuddy AI (workbuddy.ai), CodeBuddy CN (codebuddy.cn),
 * and Tencent Cloud Coding Copilot accounts.
 */

import path from 'path';

export const WorkBuddyEdition = {
    WORKBUDDY_AI: 'workbuddy-ai',
    CODEBUDDY_CN: 'codebuddy-cn',
    TENCENT_CLOUD: 'tencent-cloud',
    UNKNOWN: 'unknown'
};

export const WorkBuddyEditionLabels = {
    [WorkBuddyEdition.WORKBUDDY_AI]: 'WORKBUDDY AI',
    [WorkBuddyEdition.CODEBUDDY_CN]: 'CODEBUDDY CN',
    [WorkBuddyEdition.TENCENT_CLOUD]: 'TENCENT CLOUD',
    [WorkBuddyEdition.UNKNOWN]: 'WORKBUDDY'
};

/**
 * Detect edition from auth data (domain, filename, account metadata)
 * @param {Object} data - Parsed auth JSON data
 * @param {string} [filePath] - Optional source file path
 * @returns {string} One of WorkBuddyEdition values
 */
export function detectEdition(data, filePath = '') {
    const domain = (data?.auth?.domain || '').toLowerCase().trim();
    const fileName = filePath ? path.basename(filePath).toLowerCase() : '';

    // 1. Check domain first
    if (domain.includes('workbuddy.ai')) {
        return WorkBuddyEdition.WORKBUDDY_AI;
    }

    if (domain.includes('codebuddy.cn')) {
        // Distinguish Tencent Cloud Coding Copilot from standalone CodeBuddy CN
        if (fileName.includes('tencent') || fileName.includes('coding') || data?.account?.type?.includes?.('tencent')) {
            return WorkBuddyEdition.TENCENT_CLOUD;
        }
        return WorkBuddyEdition.CODEBUDDY_CN;
    }

    if (domain.includes('tencent') || domain.includes('coding.net')) {
        return WorkBuddyEdition.TENCENT_CLOUD;
    }

    // 2. Fallback to filename
    if (fileName.includes('workbuddy-desktop') || fileName.includes('workbuddy')) {
        return WorkBuddyEdition.WORKBUDDY_AI;
    }

    if (fileName.includes('tencent') || fileName.includes('coding')) {
        return WorkBuddyEdition.TENCENT_CLOUD;
    }

    if (fileName.includes('codebuddy')) {
        return WorkBuddyEdition.CODEBUDDY_CN;
    }

    return WorkBuddyEdition.UNKNOWN;
}

/**
 * Get human-friendly label for edition
 * @param {string} edition
 * @returns {string}
 */
export function getEditionLabel(edition) {
    return WorkBuddyEditionLabels[edition] || WorkBuddyEditionLabels[WorkBuddyEdition.UNKNOWN];
}
