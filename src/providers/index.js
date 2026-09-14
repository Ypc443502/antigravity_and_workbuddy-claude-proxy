/**
 * Providers Module
 * Central entry point for all model providers (Antigravity, WorkBuddy, etc.)
 */

export { ProviderError } from './provider-error.js';
export { AntigravityProvider } from './antigravity/index.js';
export { WorkBuddyProvider } from './workbuddy/index.js';
export { ProviderRouter, providerRouter } from './router.js';

export default {
    ProviderError: (await import('./provider-error.js')).ProviderError,
    AntigravityProvider: (await import('./antigravity/index.js')).AntigravityProvider,
    WorkBuddyProvider: (await import('./workbuddy/index.js')).WorkBuddyProvider,
    providerRouter: (await import('./router.js')).providerRouter
};
