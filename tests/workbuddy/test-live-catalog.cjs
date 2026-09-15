/**
 * Test Live WorkBuddy Catalog Discovery on Windows
 * Directly verifies /v3/config against live WorkBuddy AI upstream.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function main() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║       LIVE WORKBUDDY AI CATALOG DISCOVERY TEST               ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const authFile = path.join(
        process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local'),
        'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info'
    );

    console.log(`Checking auth file: ${authFile}`);
    if (!fs.existsSync(authFile)) {
        console.error(`Auth file not found at ${authFile}`);
        process.exit(1);
    }

    const { WorkBuddyCredentialManager } = await import('../../src/providers/workbuddy/credentials.js');
    const { fetchRemoteWorkBuddyModels } = await import('../../src/providers/workbuddy/models.js');

    const credManager = new WorkBuddyCredentialManager(authFile);
    const summary = credManager.getAccountSummary();

    console.log('\n--- 1. Account Identity & Expiration ---');
    console.log(`  Account ID:        ${summary.id}`);
    console.log(`  Nickname:          ${summary.nickname}`);
    console.log(`  Masked UID:        ${summary.uidMasked}`);
    console.log(`  Domain:            ${summary.domain}`);
    console.log(`  Edition:           ${summary.edition} (${summary.editionLabel})`);
    console.log(`  Region:            ${summary.region}`);
    console.log(`  Expires At:        ${summary.tokenExpiresAt}`);
    console.log(`  Expires in ms:     ${summary.expiresAtMs}`);
    console.log(`  Is Expired:        ${summary.isExpired}`);
    console.log(`  Is Usable:         ${summary.isUsable}`);

    assert.strictEqual(summary.isExpired, false, 'Token to 2027 should NOT be expired');
    assert.strictEqual(summary.isUsable, true, 'Token should be usable');

    console.log('\n--- 2. Fetching Dynamic Catalog (/v3/config) ---');
    const mockAccount = {
        edition: summary.edition,
        credentialManager: credManager
    };

    const catalog = await fetchRemoteWorkBuddyModels(mockAccount, { forceRefresh: true });

    console.log(`\n--- 3. Catalog Fetch Results ---`);
    console.log(`  Source:            ${catalog.source}`);
    console.log(`  Fallback Flag:     ${catalog.fallback}`);
    console.log(`  Total Models:      ${catalog.models?.length || 0}`);

    // Strict assertions: must be genuine remote catalog
    assert.strictEqual(catalog.source, 'remote', 'Catalog source must be remote, not fallback');
    assert.strictEqual(catalog.fallback, false, 'Catalog must not be fallback');
    assert(Array.isArray(catalog.models) && catalog.models.length > 0, 'Catalog must contain models');
    assert(
        catalog.models.some(x => x.id.includes('hy3') || x.id.includes('hy4') || x.id.includes('deepseek') || x.id.includes('gpt')),
        'Catalog must contain genuine models from WorkBuddy Desktop'
    );

    if (catalog.models && catalog.models.length > 0) {
        console.log('\nDiscovered Models:');
        catalog.models.forEach((m, i) => {
            const badgesStr = m.badges?.length > 0 ? ` [${m.badges.join(', ')}]` : '';
            const creditsStr = m.billing?.credits ? ` (${m.billing.credits})` : '';
            console.log(`  [${(i + 1).toString().padStart(2, ' ')}] ${m.id.padEnd(35)} -> ${m.name}${badgesStr}${creditsStr}`);
        });
    }

    console.log('\n✅ Live catalog verification test finished.');
    process.exit(0);
}

main().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
