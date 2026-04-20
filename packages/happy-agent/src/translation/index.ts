/**
 * Translation module for happy-agent
 * Provides bidirectional translation middleware for user and agent messages
 */

// Re-export types from happy-wire
export type {
    TranslationRequest,
    TranslationResult,
    SessionTranslationConfig,
    MessageTranslationMeta,
    TranslationStatus,
} from '@slopus/happy-wire';

// Cache
export { TranslationCache, generateCacheKey } from './cache.js';
export type { CacheEntry, CacheKey, TranslationResult as CachedTranslationResult } from './cache.js';

// Language detection
export {
    detectLanguage,
    isChineseText,
    isEnglishText,
    needsTranslation,
} from './languageDetection.js';
export type { LanguageDetectionResult } from './languageDetection.js';

// Translator
export type { Translator } from './translator.js';
export {
    OpenAITranslator,
    DeepLTranslator,
    NoOpTranslator,
    createTranslator,
} from './translator.js';

// Inbound middleware (user -> agent)
export {
    InboundTranslationMiddleware,
    createInboundMiddleware,
} from './inboundMiddleware.js';
export type { InboundMiddlewareResult } from './inboundMiddleware.js';

// Outbound middleware (agent -> user)
export {
    OutboundTranslationMiddleware,
    createOutboundMiddleware,
} from './outboundMiddleware.js';
export type { OutboundMiddlewareResult } from './outboundMiddleware.js';