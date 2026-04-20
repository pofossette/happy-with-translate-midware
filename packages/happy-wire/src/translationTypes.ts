import * as z from 'zod';

/**
 * Session-level translation configuration
 * Stored in session metadata to control translation behavior
 */
export const SessionTranslationConfigSchema = z.object({
    /** Whether translation is enabled for this session */
    enabled: z.boolean().default(false),
    /** Translation mode: 'full' translates both directions, 'display-only' only translates agent output */
    mode: z.enum(['full', 'display-only']).default('display-only'),
    /** User input translation config (inbound: zh -> en) */
    userInput: z.object({
        sourceLang: z.enum(['zh', 'auto']).default('zh'),
        targetLang: z.literal('en').default('en'),
    }).default({ sourceLang: 'zh', targetLang: 'en' }),
    /** Agent output translation config (outbound: en -> zh) */
    agentOutput: z.object({
        sourceLang: z.enum(['en', 'auto']).default('en'),
        targetLang: z.literal('zh').default('zh'),
    }).default({ sourceLang: 'en', targetLang: 'zh' }),
    /** Translation provider to use */
    provider: z.enum(['openai', 'deepl', 'custom']).default('openai'),
    /** Whether to preserve original text for UI toggle */
    preserveOriginal: z.boolean().default(true),
});
export type SessionTranslationConfig = z.infer<typeof SessionTranslationConfigSchema>;

/**
 * Translation status for a single message
 */
export const TranslationStatusSchema = z.enum(['success', 'fallback', 'timeout', 'skipped']);
export type TranslationStatus = z.infer<typeof TranslationStatusSchema>;

/**
 * Message-level translation metadata
 * Attached to individual messages to track translation details
 */
export const MessageTranslationMetaSchema = z.object({
    /** Translation direction: 'inbound' (user -> agent) or 'outbound' (agent -> user) */
    direction: z.enum(['inbound', 'outbound']),
    /** Source language code */
    sourceLang: z.string(),
    /** Target language code */
    targetLang: z.string(),
    /** Original text before translation */
    sourceText: z.string(),
    /** Translated text */
    translatedText: z.string(),
    /** Translation provider used */
    provider: z.string(),
    /** Translation status */
    status: TranslationStatusSchema,
});
export type MessageTranslationMeta = z.infer<typeof MessageTranslationMetaSchema>;

/**
 * Translation request for the translator
 */
export const TranslationRequestSchema = z.object({
    /** Text to translate */
    text: z.string(),
    /** Source language code (or 'auto' for detection) */
    sourceLang: z.string(),
    /** Target language code */
    targetLang: z.string(),
    /** Translation provider to use */
    provider: z.enum(['openai', 'deepl', 'custom']).default('openai'),
});
export type TranslationRequest = z.infer<typeof TranslationRequestSchema>;

/**
 * Translation result from the translator
 */
export const TranslationResultSchema = z.object({
    /** Translated text */
    translatedText: z.string(),
    /** Detected source language (if sourceLang was 'auto') */
    detectedLang: z.string().optional(),
    /** Whether translation was served from cache */
    fromCache: z.boolean().default(false),
});
export type TranslationResult = z.infer<typeof TranslationResultSchema>;

/**
 * Default translation config for new sessions
 */
export const defaultTranslationConfig: SessionTranslationConfig = {
    enabled: false,
    mode: 'display-only',
    userInput: {
        sourceLang: 'zh',
        targetLang: 'en',
    },
    agentOutput: {
        sourceLang: 'en',
        targetLang: 'zh',
    },
    provider: 'openai',
    preserveOriginal: true,
};

/**
 * Check if translation should be applied for a given session config
 */
export function shouldTranslate(config: SessionTranslationConfig | undefined, direction: 'inbound' | 'outbound'): boolean {
    if (!config || !config.enabled) {
        return false;
    }

    if (direction === 'inbound') {
        return config.mode === 'full';
    }

    // Outbound translation applies to both 'full' and 'display-only' modes
    return true;
}