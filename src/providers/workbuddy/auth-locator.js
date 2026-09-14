/**
 * WorkBuddy Auth Locator
 * Discovers and parses WorkBuddy / CodeBuddyExtension auth .info files.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../../utils/logger.js';
import { detectEdition } from './edition.js';
import { ALLOWED_DESKTOP_FILENAMES, getVariantByFilename } from './variants.js';

/**
 * Normalize timestamp to epoch milliseconds.
 * Handles both 13-digit milliseconds and 10-digit seconds.
 * @param {number|string|null|undefined} value
 * @returns {number} Timestamp in milliseconds
 */
export function normalizeEpochMs(value) {
    if (!value) return 0;
    const num = typeof value === 'number' ? value : Number(value);
    if (isNaN(num) || num <= 0) return 0;
    // If greater than 1e12, it is already in milliseconds
    if (num > 1e12) {
        return num;
    }
    // Otherwise treat as seconds and convert to ms
    return num * 1000;
}

/**
 * Get the list of candidate auth directories in priority order.
 * @returns {string[]}
 */
export function getDefaultAuthDirectories() {
    const dirs = [];

    // 1. Environment variable WORKBUDDY_AUTH_DIR takes highest precedence
    if (process.env.WORKBUDDY_AUTH_DIR) {
        dirs.push(path.resolve(process.env.WORKBUDDY_AUTH_DIR));
    }

    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        dirs.push(path.join(localAppData, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
        // Fallback for roaming if any
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        dirs.push(path.join(appData, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
    } else if (platform === 'darwin') {
        dirs.push(path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
    } else {
        // Linux / unix
        dirs.push(path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
        dirs.push(path.join(home, '.config', 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
    }

    return dirs;
}

/**
 * Find valid WorkBuddy Desktop auth files in given directory or default directories.
 * Only identifies official WorkBuddy Desktop variants:
 * - workbuddy-desktop-ai.info (WorkBuddy AI / global)
 * - workbuddy-desktop.info (WorkBuddy / cn)
 * Excludes unrelated Tencent-Cloud.coding-copilot.info or other extension files.
 * @param {string} [customDir]
 * @returns {string[]} Absolute paths to WorkBuddy Desktop auth files
 */
export function findAuthFiles(customDir = null) {
    const searchDirs = customDir ? [path.resolve(customDir)] : getDefaultAuthDirectories();
    const foundFiles = [];

    for (const dir of searchDirs) {
        try {
            if (fs.existsSync(dir)) {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isFile()) {
                        const lowerName = entry.name.toLowerCase();
                        // Strict check: only official WorkBuddy Desktop files
                        const isAllowed = ALLOWED_DESKTOP_FILENAMES.some(f => lowerName === f.toLowerCase());
                        if (isAllowed) {
                            foundFiles.push(path.join(dir, entry.name));
                        } else if (customDir && lowerName.endsWith('.info') && !lowerName.includes('tencent-cloud')) {
                            // In custom test directories, allow mock info files if not explicitly excluded
                            foundFiles.push(path.join(dir, entry.name));
                        }
                    }
                }
                // If we found official files in the top priority directory, stop search
                if (foundFiles.length > 0) {
                    break;
                }
            }
        } catch (err) {
            logger.warn(`[WorkBuddy] Error scanning directory ${dir}: ${err.message}`);
        }
    }

    return foundFiles;
}

/**
 * Read and parse an auth .info file.
 * @param {string} filePath
 * @returns {Object} Parsed JSON object
 */
export function readAuthFile(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Auth file not found: ${filePath}`);
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
}

/**
 * Validate that an auth file object contains the required tokens and structure.
 * @param {Object} data
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateAuthFile(data) {
    if (!data || typeof data !== 'object') {
        return { valid: false, error: 'Invalid auth file: not a JSON object' };
    }

    if (!data.auth || typeof data.auth !== 'object') {
        return { valid: false, error: 'Missing "auth" section in auth file' };
    }

    if (!data.auth.accessToken) {
        return { valid: false, error: 'Missing "auth.accessToken" in auth file' };
    }

    if (!data.auth.refreshToken) {
        return { valid: false, error: 'Missing "auth.refreshToken" in auth file' };
    }

    return { valid: true };
}

/**
 * Mask UID for safe logging/display (e.g., '12345678' -> '12***78')
 * @param {string|number} uid
 * @returns {string}
 */
export function maskUid(uid) {
    if (!uid) return 'unknown';
    const str = String(uid);
    if (str.length <= 4) return '***';
    return str.slice(0, 2) + '***' + str.slice(-2);
}

/**
 * Build standard WorkBuddy account ID: wb:<edition>:<uid>:<enterpriseId>
 * @param {Object} data - Parsed auth file data
 * @param {string} [fallbackId] - Fallback identifier if uid is missing
 * @param {string} [filePath] - Source file path for edition inference
 * @returns {string}
 */
export function buildAccountId(data, fallbackId = 'unknown', filePath = '') {
    const uid = data?.account?.uid || data?.account?.uin || fallbackId;
    const enterpriseId = data?.account?.enterpriseId || '0';
    const edition = detectEdition(data, filePath);
    return `wb:${edition}:${uid}:${enterpriseId}`;
}
