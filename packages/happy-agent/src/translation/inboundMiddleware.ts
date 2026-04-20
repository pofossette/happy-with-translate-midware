/**
 * Inbound translation middleware
 * Translates user messages from Chinese to English before sending to agent
 */

import type {
    MessageTranslationMeta,
    SessionTranslationConfig,
    TranslationStatus,
    UserMessage,
    MessageMeta,
} from '@slopus/happy-wire';
import type { Translator } from './translator.js';
import { isChineseText } from './languageDetection.js';

/**
 * Result of inbound middleware processing
 */
export interface InboundMiddlewareResult {
    /** Modified message with translated text */
    message: UserMessage;
    /** Original text before translation */
    originalText: string;
    /** Whether translation was applied */
    translated: boolean;
    /** Translation status */
    status: TranslationStatus;
}

/**
 * Text content that should NOT be translated
 */
function shouldSkipTranslation(text: string): boolean {
    // Skip empty or very short text
    if (!text || text.trim().length < 2) {
        return true;
    }

    // Skip code blocks (detected by common patterns)
    if (text.startsWith('```') || text.includes('```')) {
        // Could be mixed with natural language, translate the non-code parts
        // For now, skip if it's primarily code
        const codeBlockRatio = (text.match(/```/g)?.length ?? 0) / (text.length / 100);
        if (codeBlockRatio > 0.1) {
            return true;
        }
    }

    // Skip paths and commands
    if (/^[/~]/.test(text.trim())) {
        return true;
    }

    // Skip if it looks like a command
    if (/^(npm|yarn|pnpm|git|cd|ls|cat|echo|rm|mkdir|python|node)\s/.test(text.trim())) {
        return true;
    }

    return false;
}

/**
 * Check if text needs translation based on config
 */
function needsInboundTranslation(
    text: string,
    config: SessionTranslationConfig,
): boolean {
    if (!config.enabled || config.mode !== 'full') {
        return false;
    }

    if (shouldSkipTranslation(text)) {
        return false;
    }

    // Check if text is in the expected source language
    const { sourceLang } = config.userInput;

    if (sourceLang === 'auto') {
        // Auto-detect: translate if it's Chinese
        return isChineseText(text);
    }

    if (sourceLang === 'zh') {
        return isChineseText(text);
    }

    // For English source, no translation needed (target is English)
    if (sourceLang === 'en') {
        return false;
    }

    return false;
}

/**
 * Inbound translation middleware
 * Processes user messages before they're sent to the agent
 */
export class InboundTranslationMiddleware {
    private readonly translator: Translator;
    private readonly config: SessionTranslationConfig;

    constructor(options: {
        translator: Translator;
        config: SessionTranslationConfig;
    }) {
        this.translator = options.translator;
        this.config = options.config;
    }

    /**
     * Process a user message
     * Translates Chinese to English if needed
     */
    async process(message: UserMessage): Promise<InboundMiddlewareResult> {
        const text = message.content.text;
        const originalText = text;

        // Check if translation is needed
        if (!needsInboundTranslation(text, this.config)) {
            return {
                message,
                originalText: text,
                translated: false,
                status: 'skipped',
            };
        }

        try {
            const { sourceLang, targetLang } = this.config.userInput;

            const result = await this.translator.translate({
                text,
                sourceLang,
                targetLang,
                provider: this.config.provider,
            });

            // Build translation metadata
            const translationMeta: MessageTranslationMeta = {
                direction: 'inbound',
                sourceLang: result.detectedLang ?? sourceLang,
                targetLang,
                sourceText: originalText,
                translatedText: result.translatedText,
                provider: this.config.provider,
                status: 'success',
            };

            // Create modified message with translated text and metadata
            const translatedMessage: UserMessage = {
                ...message,
                content: {
                    ...message.content,
                    text: result.translatedText,
                },
                meta: {
                    ...message.meta,
                    displayText: originalText, // Show original Chinese in UI
                    translation: translationMeta,
                } as MessageMeta,
            };

            return {
                message: translatedMessage,
                originalText,
                translated: true,
                status: 'success',
            };
        } catch (error) {
            // Translation failed - return original with error status
            const errorMessage = error instanceof Error ? error.message : String(error);

            console.warn(`Inbound translation failed: ${errorMessage}`);

            const translationMeta: MessageTranslationMeta = {
                direction: 'inbound',
                sourceLang: this.config.userInput.sourceLang,
                targetLang: this.config.userInput.targetLang,
                sourceText: originalText,
                translatedText: originalText, // Fallback to original
                provider: this.config.provider,
                status: 'fallback',
            };

            const fallbackMessage: UserMessage = {
                ...message,
                meta: {
                    ...message.meta,
                    translation: translationMeta,
                } as MessageMeta,
            };

            return {
                message: fallbackMessage,
                originalText,
                translated: false,
                status: 'fallback',
            };
        }
    }
}

/**
 * Factory function to create inbound middleware
 */
export function createInboundMiddleware(
    config: SessionTranslationConfig,
    translator: Translator,
): InboundTranslationMiddleware | null {
    if (!config.enabled || config.mode !== 'full') {
        return null;
    }

    return new InboundTranslationMiddleware({
        translator,
        config,
    });
}