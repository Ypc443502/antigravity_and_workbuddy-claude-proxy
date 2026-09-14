/**
 * WorkBuddy Provider Constants
 */

export const WORKBUDDY_CN_BACKEND = 'https://copilot.tencent.com';
export const WORKBUDDY_AI_BACKEND = 'https://www.workbuddy.ai';

export const WORKBUDDY_BACKEND = process.env.WORKBUDDY_BACKEND_URL || WORKBUDDY_CN_BACKEND;

/**
 * Get base URL according to auth domain (international vs domestic)
 * @param {string} domain
 * @returns {string} Base URL
 */
export function getWorkBuddyBaseUrl(domain = '') {
    if (process.env.WORKBUDDY_BACKEND_URL) {
        return process.env.WORKBUDDY_BACKEND_URL;
    }
    const d = (domain || '').toLowerCase().trim();
    if (d.includes('workbuddy.ai')) {
        return WORKBUDDY_AI_BACKEND;
    }
    return WORKBUDDY_CN_BACKEND;
}

export const WORKBUDDY_CHAT_ENDPOINT = process.env.WORKBUDDY_CHAT_ENDPOINT || `${WORKBUDDY_BACKEND}/v2/chat/completions`;
export const WORKBUDDY_REFRESH_ENDPOINT = process.env.WORKBUDDY_REFRESH_ENDPOINT || `${WORKBUDDY_BACKEND}/v2/plugin/auth/token/refresh`;

export const DEFAULT_DOMAIN = 'www.codebuddy.cn';
export const DEFAULT_AI_DOMAIN = 'www.workbuddy.ai';

export const TOKEN_REFRESH_AHEAD_MS = 60 * 1000; // Refresh 60 seconds before expiry
export const DEFAULT_REQUEST_TIMEOUT_MS = 300 * 1000; // 5 minutes

// Current official WorkBuddy models (matches WorkBuddy Desktop UI)
export const WORKBUDDY_FALLBACK_MODELS = [
    'hy4-preview',
    'hy3',
    'deepseek-v4.1-flash',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
    'gpt-5.4',
    'deepseek-v4-pro',
    'glm-5.2',
    'kimi-k2.7',
    'auto'
];

export const WORKBUDDY_USER_AGENT = process.env.WORKBUDDY_USER_AGENT ||
    'WorkBuddy/1.0.0 (Windows NT 10.0; Win64; x64) CodeBuddyExtension/1.0.0 antigravity-proxy/2.7.7';
