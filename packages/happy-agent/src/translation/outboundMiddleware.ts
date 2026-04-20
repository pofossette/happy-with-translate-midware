/**
 * Outbound translation middleware
 * Translates agent messages from English to Chinese before displaying to user
 */

import type {
    MessageTranslationMeta,
    SessionTranslationConfig,
} from '@slopus/happy-wire';
import type { Translator } from './translator.js';
import { isEnglishText } from './languageDetection.js';

/**
 * Agent message content types that can be translated
 */
export interface TranslatableText {
    type: 'text';
    text: string;
    thinking?: boolean;
}

/**
 * Agent message content that should NOT be translated
 */
export type NonTranslatableContent =
    | { type: 'tool_use' | 'tool_result' | 'tool-call' | 'tool-result' }
    | { type: 'thinking' }
    | { type: 'code' };

/**
 * Result of outbound middleware processing
 */
export interface OutboundMiddlewareResult {
    /** Original text */
    sourceText: string;
    /** Translated text (or original if not translated) */
    translatedText: string;
    /** Translation metadata if translation was applied */
    translation?: MessageTranslationMeta;
    /** Whether translation was applied */
    translated: boolean;
}

/**
 * Text content that should NOT be translated
 */
function shouldSkipTranslation(text: string): boolean {
    if (!text || text.trim().length < 2) {
        return true;
    }

    // Skip thinking content
    // (handled separately by checking the thinking flag)

    // Skip code blocks - detect by backticks
    const codeBlockMatches = text.match(/```[\s\S]*?```/g) ?? [];
    let textWithoutCode = text;
    for (const block of codeBlockMatches) {
        textWithoutCode = textWithoutCode.replace(block, '');
    }

    // If there's no natural language left after removing code, skip
    if (textWithoutCode.trim().length < 5) {
        return true;
    }

    // Skip if it looks like JSON or structured data
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            JSON.parse(trimmed);
            return true;
        } catch {
            // Not valid JSON, continue
        }
    }

    // Skip paths and shell commands
    if (/^[/~$]/.test(trimmed)) {
        return true;
    }

    // Skip if it's mostly code-like (high ratio of special characters)
    const specialCharCount = (trimmed.match(/[{}()\[\];<>=&|!@#$%^*]/g) ?? []).length;
    const letterCount = (trimmed.match(/[a-zA-Z]/g) ?? []).length;
    if (letterCount > 0 && specialCharCount / letterCount > 0.5) {
        return true;
    }

    return false;
}

/**
 * Check if text needs outbound translation based on config
 */
function needsOutboundTranslation(
    text: string,
    config: SessionTranslationConfig,
): boolean {
    if (!config.enabled) {
        return false;
    }

    if (shouldSkipTranslation(text)) {
        return false;
    }

    const { sourceLang } = config.agentOutput;

    if (sourceLang === 'auto') {
        // Auto-detect: translate if it's English
        return isEnglishText(text);
    }

    if (sourceLang === 'en') {
        return isEnglishText(text);
    }

    return false;
}

/**
 * Extract translatable text from a string, preserving code blocks
 * Returns array of text segments with flags indicating if they should be translated
 */
function extractTranslatableSegments(text: string): Array<{ text: string; translate: boolean }> {
    const segments: Array<{ text: string; translate: boolean }> = [];

    // Split by code blocks
    const parts = text.split(/(```[\s\S]*?```)/g);

    for (const part of parts) {
        if (part.startsWith('```')) {
            // Code block - don't translate
            segments.push({ text: part, translate: false });
        } else if (part.trim().length > 0) {
            // Natural language - translate
            segments.push({ text: part, translate: true });
        }
    }

    return segments;
}

/**
 * Outbound translation middleware
 * Processes agent messages before they're displayed to the user
 */
export class OutboundTranslationMiddleware {
    private readonly translator: Translator;
    private readonly config: SessionTranslationConfig;
    private readonly timeoutMs: number;

    constructor(options: {
        translator: Translator;
        config: SessionTranslationConfig;
        timeoutMs?: number;
    }) {
        this.translator = options.translator;
        this.config = options.config;
        this.timeoutMs = options.timeoutMs ?? 15000; // 15 seconds default for outbound
    }

    /**
     * Process an agent text message
     * Translates English to Chinese if needed
     */
    async process(text: string): Promise<OutboundMiddlewareResult> {
        const sourceText = text;

        // Check if translation is needed
        if (!needsOutboundTranslation(text, this.config)) {
            return {
                sourceText,
                translatedText: text,
                translated: false,
            };
        }

        try {
            // Extract segments and translate only the natural language parts
            const segments = extractTranslatableSegments(text);
            const translatedSegments: string[] = [];

            for (const segment of segments) {
                if (!segment.translate) {
                    translatedSegments.push(segment.text);
                    continue;
                }

                // Translate this segment
                const result = await this.translateWithTimeout(segment.text);
                translatedSegments.push(result);
            }

            const translatedText = translatedSegments.join('');

            // Build translation metadata
            const translationMeta: MessageTranslationMeta = {
                direction: 'outbound',
                sourceLang: this.config.agentOutput.sourceLang === 'auto' ? 'en' : this.config.agentOutput.sourceLang,
                targetLang: this.config.agentOutput.targetLang,
                sourceText,
                translatedText,
                provider: this.config.provider,
                status: 'success',
            };

            return {
                sourceText,
                translatedText,
                translation: translationMeta,
                translated: true,
            };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`Outbound translation failed: ${errorMessage}`);

            // Return original with fallback status
            const translationMeta: MessageTranslationMeta = {
                direction: 'outbound',
                sourceLang: this.config.agentOutput.sourceLang,
                targetLang: this.config.agentOutput.targetLang,
                sourceText,
                translatedText: sourceText,
                provider: this.config.provider,
                status: 'fallback',
            };

            return {
                sourceText,
                translatedText: sourceText,
                translation: translationMeta,
                translated: false,
            };
        }
    }

    /**
     * Translate with timeout
     */
    private async translateWithTimeout(text: string): Promise<string> {
        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Translation timeout')), this.timeoutMs);
        });

        const translatePromise = this.translator.translate({
            text,
            sourceLang: this.config.agentOutput.sourceLang,
            targetLang: this.config.agentOutput.targetLang,
            provider: this.config.provider,
        });

        const result = await Promise.race([translatePromise, timeoutPromise]);
        return result.translatedText;
    }

    /**
     * Process a service message (simpler text without code blocks)
     */
    async processServiceMessage(text: string): Promise<OutboundMiddlewareResult> {
        // Service messages are simpler - just translate the whole text
        if (!needsOutboundTranslation(text, this.config)) {
            return {
                sourceText: text,
                translatedText: text,
                translated: false,
            };
        }

        return this.process(text);
    }
}

/**
 * Factory function to create outbound middleware
 */
export function createOutboundMiddleware(
    config: SessionTranslationConfig,
    translator: Translator,
): OutboundTranslationMiddleware | null {
    if (!config.enabled) {
        return null;
    }

    return new OutboundTranslationMiddleware({
        translator,
        config,
    });
}