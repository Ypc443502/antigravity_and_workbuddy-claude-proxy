/**
 * WorkBuddy App Version Resolver
 * Detects WorkBuddy AI desktop application version to construct
 * the strict User-Agent required by /v3/config.
 *
 * NOTE: The User-Agent for /v3/config MUST be "WorkBuddyAI/<version>" without spaces!
 * "WorkBuddy AI/5.5.2" with a space results in:
 * HTTP 400, code 12403 ("check ua, get coding copilot version error").
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../../utils/logger.js';

// Fallback version verified with live WorkBuddy AI Desktop (2026-09)
export const DEFAULT_WORKBUDDY_AI_VERSION = '5.5.2';
// Bundled CLI version from WorkBuddy AI Desktop 5.5.2.
// The desktop injects this as CLIENT_INFO_USER_AGENT_EXTENSION=CLI/<version>.
export const DEFAULT_WORKBUDDY_CLI_VERSION = '2.137.1';

/**
 * Validate that a version string is a valid semver-like version
 * @param {string} value
 * @returns {boolean}
 */
export function validAppVersion(value) {
    if (typeof value !== 'string') return false;
    return /^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(value.trim());
}

/**
 * Generate official WorkBuddyAI User-Agent string for /v3/config
 * @param {string} [version]
 * @returns {string} e.g. "WorkBuddyAI/5.5.2"
 */
export function appUserAgent(version = DEFAULT_WORKBUDDY_AI_VERSION) {
    const cleanVersion = (version && validAppVersion(version)) ? version.trim() : DEFAULT_WORKBUDDY_AI_VERSION;
    return `WorkBuddyAI/${cleanVersion}`;
}

/**
 * Generate the desktop-shaped User-Agent required by WorkBuddy AI chat.
 *
 * Important: the international chat gateway does not accept the legacy
 * "CLI/... CodeBuddy/..." identity. The desktop application presents chat
 * requests as "WorkBuddy/<version> WorkBuddy AI/<version>". The catalog
 * endpoint above intentionally uses a different, compact WorkBuddyAI/<version>
 * User-Agent, so keep these two helpers separate.
 *
 * @param {string} [version]
 * @param {string} [cliVersion]
 * @returns {string} e.g. "WorkBuddy/5.5.2 WorkBuddy AI/5.5.2 CLI/2.137.1"
 */
export function chatUserAgent(
    version = DEFAULT_WORKBUDDY_AI_VERSION,
    cliVersion = DEFAULT_WORKBUDDY_CLI_VERSION
) {
    const cleanVersion = (version && validAppVersion(version)) ? version.trim() : DEFAULT_WORKBUDDY_AI_VERSION;
    const cleanCliVersion = (cliVersion && validAppVersion(cliVersion))
        ? cliVersion.trim()
        : DEFAULT_WORKBUDDY_CLI_VERSION;
    return `WorkBuddy/${cleanVersion} WorkBuddy AI/${cleanVersion} CLI/${cleanCliVersion}`;
}

/**
 * Candidate directories to check for WorkBuddy Desktop application package.json
 */
function getCandidateAppPaths() {
    const candidates = [];
    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        candidates.push(path.join(localAppData, 'Programs', 'WorkBuddyAI', 'resources', 'app', 'package.json'));
        candidates.push(path.join(localAppData, 'Programs', 'WorkBuddyAI', 'resources', 'app.asar.unpacked', 'package.json'));
        candidates.push(path.join(localAppData, 'Programs', 'WorkBuddy', 'resources', 'app', 'package.json'));
        candidates.push(path.join(localAppData, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'package.json'));
        candidates.push(path.join('C:\\Program Files', 'WorkBuddyAI', 'resources', 'app', 'package.json'));
        candidates.push(path.join('C:\\Program Files', 'WorkBuddy', 'resources', 'app', 'package.json'));
    } else if (platform === 'darwin') {
        candidates.push('/Applications/WorkBuddy.app/Contents/Resources/app/package.json');
    } else {
        candidates.push('/opt/WorkBuddy/resources/app/package.json');
    }

    return candidates;
}

/**
 * Candidate bundled CLI package.json files. WorkBuddy AI keeps the CLI package
 * in app.asar.unpacked, so this can be read without parsing app.asar.
 */
function getCandidateCliPackagePaths() {
    const candidates = [];
    const platform = os.platform();
    const home = os.homedir();

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        candidates.push(path.join(localAppData, 'Programs', 'WorkBuddyAI', 'resources', 'app.asar.unpacked', 'cli', 'package.json'));
        candidates.push(path.join(localAppData, 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'package.json'));
        candidates.push(path.join('C:\\Program Files', 'WorkBuddyAI', 'resources', 'app.asar.unpacked', 'cli', 'package.json'));
        candidates.push(path.join('C:\\Program Files', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'package.json'));
    } else if (platform === 'darwin') {
        candidates.push('/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/package.json');
    } else {
        candidates.push('/opt/WorkBuddy/resources/app.asar.unpacked/cli/package.json');
    }

    return candidates;
}

let cachedResolvedVersion = null;
let cachedResolvedCliVersion = null;

/**
 * Resolve current installed WorkBuddy version or return verified fallback (5.5.2)
 * @returns {string} Version string
 */
export function resolveAppVersion() {
    if (cachedResolvedVersion) return cachedResolvedVersion;

    if (process.env.WORKBUDDY_APP_VERSION && validAppVersion(process.env.WORKBUDDY_APP_VERSION)) {
        cachedResolvedVersion = process.env.WORKBUDDY_APP_VERSION.trim();
        return cachedResolvedVersion;
    }

    for (const p of getCandidateAppPaths()) {
        try {
            if (fs.existsSync(p)) {
                const content = fs.readFileSync(p, 'utf8');
                const pkg = JSON.parse(content);
                if (pkg.version && validAppVersion(pkg.version)) {
                    logger.debug(`[WorkBuddy] Detected installed WorkBuddy AI version: ${pkg.version} from ${p}`);
                    cachedResolvedVersion = pkg.version.trim();
                    return cachedResolvedVersion;
                }
            }
        } catch (_) {}
    }

    cachedResolvedVersion = DEFAULT_WORKBUDDY_AI_VERSION;
    return cachedResolvedVersion;
}

/**
 * Resolve the bundled WorkBuddy CLI version used in the official chat UA.
 * WorkBuddy's bundled cli/package.json reports top-level version 0.0.0, while
 * publishConfig.customPackage.version contains the real published CLI version.
 *
 * @returns {string} Version string
 */
export function resolveCliVersion() {
    if (cachedResolvedCliVersion) return cachedResolvedCliVersion;

    if (process.env.WORKBUDDY_CLI_VERSION && validAppVersion(process.env.WORKBUDDY_CLI_VERSION)) {
        cachedResolvedCliVersion = process.env.WORKBUDDY_CLI_VERSION.trim();
        return cachedResolvedCliVersion;
    }

    for (const p of getCandidateCliPackagePaths()) {
        try {
            if (!fs.existsSync(p)) continue;

            const content = fs.readFileSync(p, 'utf8');
            const pkg = JSON.parse(content);
            const customVersion = pkg?.publishConfig?.customPackage?.version;
            const packageVersion = pkg?.version;

            if (customVersion && validAppVersion(customVersion)) {
                logger.debug(`[WorkBuddy] Detected bundled CLI version: ${customVersion} from ${p}`);
                cachedResolvedCliVersion = customVersion.trim();
                return cachedResolvedCliVersion;
            }

            if (packageVersion && packageVersion !== '0.0.0' && validAppVersion(packageVersion)) {
                logger.debug(`[WorkBuddy] Detected bundled CLI package version: ${packageVersion} from ${p}`);
                cachedResolvedCliVersion = packageVersion.trim();
                return cachedResolvedCliVersion;
            }
        } catch (_) {}
    }

    cachedResolvedCliVersion = DEFAULT_WORKBUDDY_CLI_VERSION;
    return cachedResolvedCliVersion;
}
