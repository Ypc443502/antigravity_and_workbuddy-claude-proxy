/**
 * Unified Provider Error
 * Represents errors occurring across different providers (Antigravity, WorkBuddy, etc.)
 */
export class ProviderError extends Error {
    /**
     * @param {Object} options
     * @param {string} options.provider - Provider name ('antigravity' | 'workbuddy')
     * @param {number} [options.status=500] - HTTP status code
     * @param {string} [options.type='api_error'] - Anthropic-compatible error type
     * @param {string|null} [options.code=null] - Error code slug
     * @param {string} options.message - Human-readable error message
     * @param {boolean} [options.retryable=false] - Whether the error is retryable
     * @param {number|null} [options.retryAfterMs=null] - Backoff duration in ms
     * @param {Error|null} [options.cause=null] - Original underlying error
     */
    constructor({
        provider,
        status = 500,
        type = 'api_error',
        code = null,
        message,
        retryable = false,
        retryAfterMs = null,
        cause = null
    }) {
        super(message);
        this.name = 'ProviderError';
        this.provider = provider;
        this.status = status;
        this.type = type;
        this.code = code;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
        if (cause) {
            this.cause = cause;
        }
    }
}

export default ProviderError;
