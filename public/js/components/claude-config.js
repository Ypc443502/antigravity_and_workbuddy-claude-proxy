/**
 * Claude Config Component
 * Registers itself to window.Components for Alpine.js to consume
 */
window.Components = window.Components || {};

window.Components.claudeConfig = () => ({
    config: { env: {} },
    configPath: '', // Dynamic path from backend
    models: [],
    loading: false,
    restoring: false,
    gemini1mSuffix: false,
    selectedProvider: 'antigravity', // 'antigravity' or 'workbuddy'

    // Mode toggle state (proxy/paid)
    currentMode: 'proxy', // 'proxy' or 'paid'
    modeLoading: false,

    /**
     * Extract port from ANTHROPIC_BASE_URL for display
     * @returns {string} Port number or '8080' as fallback
     */
    getProxyPort() {
        const baseUrl = this.config?.env?.ANTHROPIC_BASE_URL || '';
        try {
            const url = new URL(baseUrl);
            return url.port || '8080';
        } catch {
            return '8080';
        }
    },

    // Presets state
    presets: [],
    selectedPresetName: '',
    savingPreset: false,
    deletingPreset: false,
    pendingPresetName: '', // For unsaved changes confirmation
    newPresetName: '', // For save preset modal input

    // Model fields that may contain Gemini model names
    geminiModelFields: [
        'ANTHROPIC_MODEL',
        'CLAUDE_CODE_SUBAGENT_MODEL',
        'ANTHROPIC_DEFAULT_OPUS_MODEL',
        'ANTHROPIC_DEFAULT_SONNET_MODEL',
        'ANTHROPIC_DEFAULT_HAIKU_MODEL'
    ],

    init() {
        // Only fetch config if this is the active sub-tab
        if (this.$store.global.settingsTab === 'claude') {
            this.fetchConfig();
            this.fetchPresets();
            this.fetchMode();
        }

        // Watch settings sub-tab (skip initial trigger)
        this.$watch('$store.global.settingsTab', (tab, oldTab) => {
            if (tab === 'claude' && oldTab !== undefined) {
                this.fetchConfig();
                this.fetchPresets();
                this.fetchMode();
            }
        });

        this.$watch('$store.data.models', (val) => {
            this.models = val || [];
        });
        this.models = Alpine.store('data').models || [];
    },

    /**
     * Detect if any Gemini model has [1m] suffix
     */
    detectGemini1mSuffix() {
        for (const field of this.geminiModelFields) {
            const val = this.config.env[field];
            if (val && val.toLowerCase().includes('gemini') && val.includes('[1m]')) {
                return true;
            }
        }
        return false;
    },

    /**
     * Toggle [1m] suffix for all Gemini models
     */
    toggleGemini1mSuffix(enabled) {
        for (const field of this.geminiModelFields) {
            const val = this.config.env[field];
            // Fix: Case-insensitive check for gemini
            if (val && /gemini/i.test(val)) {
                if (enabled && !val.includes('[1m]')) {
                    this.config.env[field] = val.trim() + '[1m]';
                } else if (!enabled && val.includes('[1m]')) {
                    this.config.env[field] = val.replace(/\s*\[1m\]$/i, '').trim();
                }
            }
        }
        this.gemini1mSuffix = enabled;
    },

    /**
     * Get available models for the currently selected provider
     * @returns {string[]} Model IDs
     */
    getAvailableModels() {
        const dataStore = Alpine.store('data');
        if (this.selectedProvider === 'workbuddy') {
            // WorkBuddy selections are intentionally free-only. We require catalog metadata
            // instead of guessing from model names or stale string-only model lists.
            return (dataStore.groupedModels?.workbuddy || [])
                .filter(m => m && m.free === true)
                .map(m => m.id);
        } else {
            const fromGrouped = dataStore.groupedModels?.antigravity?.map(m => m.id);
            if (fromGrouped && fromGrouped.length > 0) return fromGrouped;
            return (dataStore.models || []).filter(m => !m.startsWith('workbuddy/'));
        }
    },

    /**
     * Switch active provider between Antigravity and WorkBuddy
     * @param {'antigravity'|'workbuddy'} newProvider
     */
    switchProvider(newProvider) {
        if (this.selectedProvider === newProvider) return;

        const dataStore = Alpine.store('data');
        const agModels = dataStore.groupedModels?.antigravity?.map(m => m.id) ||
            (dataStore.models || []).filter(m => !m.startsWith('workbuddy/'));

        if (newProvider === 'workbuddy') {
            const wbModels = (dataStore.groupedModels?.workbuddy || [])
                .filter(m => m && m.free === true)
                .map(m => m.id);

            if (wbModels.length === 0) {
                Alpine.store('global').showToast('当前 WorkBuddy catalog 没有可确认的免费模型，已阻止切换，避免误用付费模型。', 'warning', 7000);
                return;
            }

            this.selectedProvider = newProvider;

            // Pick only from models that the real catalog explicitly marks free.
            const findModel = (target, fallbacks = []) => {
                if (wbModels.includes(target)) return target;
                for (const fb of fallbacks) {
                    const match = wbModels.find(m => m.toLowerCase().includes(fb.toLowerCase()));
                    if (match) return match;
                }
                return '';
            };

            const safeModel = findModel('workbuddy/deepseek-v4.1-flash', ['deepseek-v4.1-flash', 'hy4', 'hy3', 'deepseek']) || wbModels[0];

            // Claude Code may independently use these aliases. Point every alias at a verified
            // free model so Opus/Sonnet/Haiku/subagents cannot silently switch to a paid model.
            this.config.env.ANTHROPIC_MODEL = safeModel;
            this.config.env.ANTHROPIC_DEFAULT_OPUS_MODEL = safeModel;
            this.config.env.ANTHROPIC_DEFAULT_SONNET_MODEL = safeModel;
            this.config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = safeModel;
            this.config.env.CLAUDE_CODE_SUBAGENT_MODEL = safeModel;
        } else {
            this.selectedProvider = newProvider;
            // Switching to Antigravity
            const isCurrentWb = (this.config.env.ANTHROPIC_MODEL || '').startsWith('workbuddy/');
            if (isCurrentWb) {
                const pickAg = (target, fallback) => agModels.includes(target) ? target : (agModels[0] || fallback);
                this.config.env.ANTHROPIC_MODEL = pickAg('claude-opus-4-6-thinking', 'claude-sonnet-4-6');
                this.config.env.ANTHROPIC_DEFAULT_OPUS_MODEL = pickAg('claude-opus-4-6-thinking', 'claude-sonnet-4-6');
                this.config.env.ANTHROPIC_DEFAULT_SONNET_MODEL = pickAg('claude-sonnet-4-6', 'claude-sonnet-4-6');
                this.config.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = pickAg('claude-sonnet-4-6', 'claude-sonnet-4-6');
                this.config.env.CLAUDE_CODE_SUBAGENT_MODEL = pickAg('claude-sonnet-4-6', 'claude-sonnet-4-6');
            }
        }
    },

    /**
     * Helper to select a model from the dropdown
     * @param {string} field - The config.env field to update
     * @param {string} modelId - The selected model ID
     */
    selectModel(field, modelId) {
        if (!this.config.env) this.config.env = {};

        if (modelId.startsWith('workbuddy/')) {
            const wbMeta = (Alpine.store('data').groupedModels?.workbuddy || [])
                .find(m => m && m.id === modelId);
            if (!wbMeta || wbMeta.free !== true) {
                Alpine.store('global').showToast('已阻止选择收费或无法确认免费的 WorkBuddy 模型。', 'warning', 6000);
                return;
            }
        }

        let finalModelId = modelId;
        // If 1M mode is enabled and it's a Gemini model, append the suffix
        if (this.gemini1mSuffix && modelId.toLowerCase().includes('gemini')) {
            if (!finalModelId.includes('[1m]')) {
                finalModelId = finalModelId.trim() + '[1m]';
            }
        }

        this.config.env[field] = finalModelId;

        // Automatically sync selectedProvider if user picked a model with workbuddy prefix
        if (modelId.startsWith('workbuddy/')) {
            this.selectedProvider = 'workbuddy';
        } else if (modelId) {
            this.selectedProvider = 'antigravity';
        }
    },

    async fetchConfig() {
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/claude/config', {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            this.config = data.config || {};
            this.configPath = data.path || '~/.claude/settings.json'; // Save dynamic path
            if (!this.config.env) this.config.env = {};

            // Default MCP CLI to true if not set
            if (this.config.env.ENABLE_EXPERIMENTAL_MCP_CLI === undefined) {
                this.config.env.ENABLE_EXPERIMENTAL_MCP_CLI = 'true';
            }

            // Sync selectedProvider based on ANTHROPIC_MODEL
            const primary = this.config.env.ANTHROPIC_MODEL || '';
            if (primary.startsWith('workbuddy/')) {
                this.selectedProvider = 'workbuddy';
            } else {
                this.selectedProvider = 'antigravity';
            }

            // Detect existing [1m] suffix state, default to true
            const hasExistingSuffix = this.detectGemini1mSuffix();
            const hasGeminiModels = this.geminiModelFields.some(f =>
                this.config.env[f]?.toLowerCase().includes('gemini')
            );

            // Default to enabled: if no suffix found but Gemini models exist, apply suffix
            if (!hasExistingSuffix && hasGeminiModels) {
                this.toggleGemini1mSuffix(true);
            } else {
                this.gemini1mSuffix = hasExistingSuffix || !hasGeminiModels;
            }
        } catch (e) {
            console.error('Failed to fetch Claude config:', e);
        }
    },

    async saveClaudeConfig() {
        this.loading = true;
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/claude/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.config)
            }, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            Alpine.store('global').showToast(Alpine.store('global').t('claudeConfigSaved'), 'success');
        } catch (e) {
            Alpine.store('global').showToast(Alpine.store('global').t('saveConfigFailed') + ': ' + e.message, 'error');
        } finally {
            this.loading = false;
        }
    },

    restoreDefaultClaudeConfig() {
        document.getElementById('restore_defaults_modal').showModal();
    },

    async executeRestore() {
        this.restoring = true;
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/claude/config/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            Alpine.store('global').showToast(Alpine.store('global').t('claudeConfigRestored'), 'success');

            // Close modal
            document.getElementById('restore_defaults_modal').close();

            // Reload the config to reflect the changes
            await this.fetchConfig();
        } catch (e) {
            Alpine.store('global').showToast(Alpine.store('global').t('restoreConfigFailed') + ': ' + e.message, 'error');
        } finally {
            this.restoring = false;
        }
    },

    // ==========================================
    // Presets Management
    // ==========================================

    /**
     * Fetch all saved presets from the server
     */
    async fetchPresets() {
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/claude/presets', {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.status === 'ok') {
                this.presets = data.presets || [];
                // Auto-select first preset if none selected
                if (this.presets.length > 0 && !this.selectedPresetName) {
                    this.selectedPresetName = this.presets[0].name;
                }
            }
        } catch (e) {
            console.error('Failed to fetch presets:', e);
        }
    },

    /**
     * Load the selected preset into the form (does not save to Claude CLI)
     */
    loadSelectedPreset() {
        const preset = this.presets.find(p => p.name === this.selectedPresetName);
        if (!preset) {
            return;
        }

        // Merge preset config into current config.env
        this.config.env = { ...this.config.env, ...preset.config };

        // Update Gemini 1M toggle based on merged config (not just preset)
        this.gemini1mSuffix = this.detectGemini1mSuffix();

        Alpine.store('global').showToast(
            Alpine.store('global').t('presetLoaded') || `Preset "${preset.name}" loaded. Click "Apply to Claude CLI" to save.`,
            'success'
        );
    },

    /**
     * Check if current config matches any saved preset
     * @returns {boolean} True if current config matches a preset
     */
    currentConfigMatchesPreset() {
        const relevantKeys = [
            'ANTHROPIC_BASE_URL',
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_MODEL',
            'CLAUDE_CODE_SUBAGENT_MODEL',
            'ANTHROPIC_DEFAULT_OPUS_MODEL',
            'ANTHROPIC_DEFAULT_SONNET_MODEL',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL',
            'ENABLE_EXPERIMENTAL_MCP_CLI'
        ];

        for (const preset of this.presets) {
            let matches = true;
            for (const key of relevantKeys) {
                const currentVal = this.config.env[key] || '';
                const presetVal = preset.config[key] || '';
                if (currentVal !== presetVal) {
                    matches = false;
                    break;
                }
            }
            if (matches) return true;
        }
        return false;
    },

    /**
     * Handle preset selection change - auto-load with unsaved changes warning
     * @param {string} newPresetName - The newly selected preset name
     */
    async onPresetSelect(newPresetName) {
        if (!newPresetName || newPresetName === this.selectedPresetName) return;

        // Check if current config has unsaved changes (doesn't match any preset)
        const hasUnsavedChanges = !this.currentConfigMatchesPreset();

        if (hasUnsavedChanges) {
            // Store pending preset and show confirmation modal
            this.pendingPresetName = newPresetName;
            document.getElementById('unsaved_changes_modal').showModal();
            return;
        }

        this.selectedPresetName = newPresetName;
        this.loadSelectedPreset();
    },

    /**
     * Confirm loading preset despite unsaved changes
     */
    confirmLoadPreset() {
        document.getElementById('unsaved_changes_modal').close();
        this.selectedPresetName = this.pendingPresetName;
        this.pendingPresetName = '';
        this.loadSelectedPreset();
    },

    /**
     * Cancel loading preset - revert dropdown selection
     */
    cancelLoadPreset() {
        document.getElementById('unsaved_changes_modal').close();
        // Revert the dropdown to current selection
        const select = document.querySelector('[aria-label="Select preset"]');
        if (select) select.value = this.selectedPresetName;
        this.pendingPresetName = '';
    },

    /**
     * Save the current config as a new preset
     */
    async saveCurrentAsPreset() {
        // Clear the input and show the save preset modal
        this.newPresetName = '';
        document.getElementById('save_preset_modal').showModal();
    },

    /**
     * Execute preset save after user enters name
     */
    async executeSavePreset(name) {
        if (!name || !name.trim()) {
            Alpine.store('global').showToast(Alpine.store('global').t('presetNameRequired'), 'error');
            return;
        }

        this.savingPreset = true;
        const password = Alpine.store('global').webuiPassword;

        try {
            // Save only relevant env vars
            const relevantKeys = [
                'ANTHROPIC_BASE_URL',
                'ANTHROPIC_AUTH_TOKEN',
                'ANTHROPIC_MODEL',
                'CLAUDE_CODE_SUBAGENT_MODEL',
                'ANTHROPIC_DEFAULT_OPUS_MODEL',
                'ANTHROPIC_DEFAULT_SONNET_MODEL',
                'ANTHROPIC_DEFAULT_HAIKU_MODEL',
                'ENABLE_EXPERIMENTAL_MCP_CLI'
            ];
            const presetConfig = {};
            relevantKeys.forEach(k => {
                if (this.config.env[k]) {
                    presetConfig[k] = this.config.env[k];
                }
            });

            const { response, newPassword } = await window.utils.request('/api/claude/presets', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), config: presetConfig })
            }, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.status === 'ok') {
                this.presets = data.presets || [];
                this.selectedPresetName = name.trim();
                this.newPresetName = ''; // Clear the input
                Alpine.store('global').showToast(
                    Alpine.store('global').t('presetSaved') || `Preset "${name}" saved`,
                    'success'
                );
                document.getElementById('save_preset_modal').close();
            } else {
                throw new Error(data.error || Alpine.store('global').t('saveFailed'));
            }
        } catch (e) {
            Alpine.store('global').showToast(Alpine.store('global').t('failedToSavePreset') + ': ' + e.message, 'error');
        } finally {
            this.savingPreset = false;
        }
    },

    /**
     * Delete the selected preset
     */
    async deleteSelectedPreset() {
        if (!this.selectedPresetName) {
            Alpine.store('global').showToast(Alpine.store('global').t('noPresetSelected'), 'warning');
            return;
        }

        // Confirm deletion
        const confirmMsg = Alpine.store('global').t('deletePresetConfirm', { name: this.selectedPresetName });
        if (!confirm(confirmMsg)) {
            return;
        }

        this.deletingPreset = true;
        const password = Alpine.store('global').webuiPassword;

        try {
            const { response, newPassword } = await window.utils.request(
                `/api/claude/presets/${encodeURIComponent(this.selectedPresetName)}`,
                { method: 'DELETE' },
                password
            );
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.status === 'ok') {
                this.presets = data.presets || [];
                // Select first available preset or clear selection
                this.selectedPresetName = this.presets.length > 0 ? this.presets[0].name : '';
                Alpine.store('global').showToast(
                    Alpine.store('global').t('presetDeleted') || 'Preset deleted',
                    'success'
                );
            } else {
                throw new Error(data.error || Alpine.store('global').t('deleteFailed'));
            }
        } catch (e) {
            Alpine.store('global').showToast(Alpine.store('global').t('failedToDeletePreset') + ': ' + e.message, 'error');
        } finally {
            this.deletingPreset = false;
        }
    },

    // ==========================================
    // Mode Toggle (Proxy/Paid)
    // ==========================================

    /**
     * Fetch current mode from server
     */
    async fetchMode() {
        const password = Alpine.store('global').webuiPassword;
        try {
            const { response, newPassword } = await window.utils.request('/api/claude/mode', {}, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.status === 'ok') {
                this.currentMode = data.mode;
            }
        } catch (e) {
            console.error('Failed to fetch mode:', e);
        }
    },

    /**
     * Toggle between proxy and paid mode
     * @param {string} newMode - Target mode ('proxy' or 'paid')
     */
    async toggleMode(newMode) {
        if (this.modeLoading || newMode === this.currentMode) return;

        this.modeLoading = true;
        const password = Alpine.store('global').webuiPassword;

        try {
            const { response, newPassword } = await window.utils.request('/api/claude/mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: newMode })
            }, password);
            if (newPassword) Alpine.store('global').webuiPassword = newPassword;

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();

            if (data.status === 'ok') {
                this.currentMode = data.mode;
                if (data.config) {
                    this.config = data.config;
                    if (!this.config.env) this.config.env = {};
                }
                Alpine.store('global').showToast(data.message, 'success');

                // Refresh the config and mode state
                await this.fetchConfig();
                await this.fetchMode();
            } else {
                throw new Error(data.error || 'Failed to switch mode');
            }
        } catch (e) {
            Alpine.store('global').showToast(
                (Alpine.store('global').t('modeToggleFailed') || 'Failed to switch mode') + ': ' + e.message,
                'error'
            );
        } finally {
            this.modeLoading = false;
        }
    }
});
