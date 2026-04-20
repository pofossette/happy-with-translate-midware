/**
 * Translation interface and implementations
 * Supports multiple translation providers (OpenAI, DeepL, custom)
 */

import type { SessionTranslationConfig } from '@slopus/happy-wire';
import { TranslationCache, generateCacheKey } from './cache.js';
import { detectLanguage } from './languageDetection.js';

/**
 * Translation request for the translator
 */
export interface TranslationRequest {
    /** Text to translate */
    text: string;
    /** Source language code (or 'auto' for detection) */
    sourceLang: string;
    /** Target language code */
    targetLang: string;
    /** Translation provider to use */
    provider?: 'openai' | 'deepl' | 'custom';
}

/**
 * Translation result from the translator
 */
export interface TranslationResult {
    /** Translated text */
    translatedText: string;
    /** Detected source language (if sourceLang was 'auto') */
    detectedLang?: string;
    /** Whether translation was served from cache */
    fromCache?: boolean;
}

/**
 * Translator interface
 */
export interface Translator {
    translate(request: TranslationRequest): Promise<TranslationResult>;
    isAvailable(): Promise<boolean>;
}

/**
 * OpenAI translator using GPT models
 */
export class OpenAITranslator implements Translator {
    private readonly apiKey: string;
    private readonly model: string;
    private readonly cache: TranslationCache;
    private readonly timeoutMs: number;

    constructor(options: {
        apiKey: string;
        model?: string;
        cache?: TranslationCache;
        timeoutMs?: number;
    }) {
        this.apiKey = options.apiKey;
        this.model = options.model ?? 'gpt-4o-mini';
        this.cache = options.cache ?? new TranslationCache();
        this.timeoutMs = options.timeoutMs ?? 10000; // 10 seconds default
    }

    async translate(request: TranslationRequest): Promise<TranslationResult> {
        const { text, sourceLang, targetLang } = request;

        // Skip empty or whitespace-only text
        if (!text || text.trim().length === 0) {
            return {
                translatedText: text,
                fromCache: false,
            };
        }

        // Skip if source and target are the same
        if (sourceLang === targetLang && sourceLang !== 'auto') {
            return {
                translatedText: text,
                fromCache: false,
            };
        }

        // Auto-detect if needed
        let actualSourceLang = sourceLang;
        if (sourceLang === 'auto') {
            const detected = detectLanguage(text);
            if (detected.lang === 'unknown') {
                return {
                    translatedText: text,
                    fromCache: false,
                };
            }
            actualSourceLang = detected.lang;
        }

        // Skip translation if detected language matches target
        if (actualSourceLang === targetLang) {
            return {
                translatedText: text,
                detectedLang: actualSourceLang,
                fromCache: false,
            };
        }

        // Check cache first
        const cacheKey = generateCacheKey('outbound', actualSourceLang, targetLang, text);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return {
                ...cached,
                fromCache: true,
            };
        }

        // Perform translation
        const translatedText = await this.callOpenAI(text, actualSourceLang, targetLang);

        // Cache result
        const result: TranslationResult = {
            translatedText,
            detectedLang: actualSourceLang,
            fromCache: false,
        };
        this.cache.set(cacheKey, result);

        return result;
    }

    private async callOpenAI(text: string, sourceLang: string, targetLang: string): Promise<string> {
        const prompt = this.buildPrompt(text, sourceLang, targetLang);

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Translation timeout')), this.timeoutMs);
        });

        const fetchPromise = fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages: [
                    {
                        role: 'system',
                        content: 'You are a professional translator. Translate the given text accurately and naturally. Only output the translated text, nothing else.',
                    },
                    {
                        role: 'user',
                        content: prompt,
                    },
                ],
                temperature: 0.3,
                max_tokens: Math.max(100, text.length * 2), // Estimate output length
            }),
        });

        const response = await Promise.race([fetchPromise, timeoutPromise]);

        if (!response.ok) {
            const error = await response.text();
            throw new Error(`OpenAI API error: ${response.status} - ${error}`);
        }

        const data = await response.json() as {
            choices?: Array<{
                message?: {
                    content?: string;
                };
            }>;
        };

        const translatedText = data.choices?.[0]?.message?.content?.trim();
        if (!translatedText) {
            throw new Error('Empty response from OpenAI');
        }

        return translatedText;
    }

    private buildPrompt(text: string, sourceLang: string, targetLang: string): string {
        const langNames: Record<string, string> = {
            'zh': 'Chinese',
            'en': 'English',
        };

        const sourceName = langNames[sourceLang] ?? sourceLang;
        const targetName = langNames[targetLang] ?? targetLang;

        return `Translate the following text from ${sourceName} to ${targetName}:

${text}`;
    }

    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch('https://api.openai.com/v1/models', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`,
                },
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

/**
 * DeepL translator implementation
 */
export class DeepLTranslator implements Translator {
    private readonly apiKey: string;
    private readonly endpoint: string;
    private readonly cache: TranslationCache;
    private readonly timeoutMs: number;

    constructor(options: {
        apiKey: string;
        endpoint?: string;
        cache?: TranslationCache;
        timeoutMs?: number;
    }) {
        this.apiKey = options.apiKey;
        this.endpoint = options.endpoint ?? 'https://api-free.deepl.com/v2/translate';
        this.cache = options.cache ?? new TranslationCache();
        this.timeoutMs = options.timeoutMs ?? 10000;
    }

    async translate(request: TranslationRequest): Promise<TranslationResult> {
        const { text, sourceLang, targetLang } = request;

        if (!text || text.trim().length === 0) {
            return { translatedText: text, fromCache: false };
        }

        // Check cache
        const cacheKey = generateCacheKey('outbound', sourceLang, targetLang, text);
        const cached = this.cache.get(cacheKey);
        if (cached) {
            return { ...cached, fromCache: true };
        }

        // Map language codes for DeepL
        const deeplSourceLang = this.mapLanguageCode(sourceLang);
        const deeplTargetLang = this.mapLanguageCode(targetLang);

        const timeoutPromise = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('Translation timeout')), this.timeoutMs);
        });

        const fetchPromise = fetch(this.endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
            },
            body: JSON.stringify({
                text: [text],
                source_lang: deeplSourceLang,
                target_lang: deeplTargetLang,
            }),
        });

        const response = await Promise.race([fetchPromise, timeoutPromise]);

        if (!response.ok) {
            throw new Error(`DeepL API error: ${response.status}`);
        }

        const data = await response.json() as {
            translations?: Array<{
                text?: string;
                detected_source_language?: string;
            }>;
        };

        const translatedText = data.translations?.[0]?.text ?? text;
        const detectedLang = data.translations?.[0]?.detected_source_language?.toLowerCase();

        const result: TranslationResult = {
            translatedText,
            detectedLang,
            fromCache: false,
        };

        this.cache.set(cacheKey, result);
        return result;
    }

    private mapLanguageCode(lang: string): string | undefined {
        const mapping: Record<string, string> = {
            'zh': 'ZH',
            'en': 'EN',
        };
        // DeepL auto-detects if source_lang is omitted
        if (lang === 'auto') {
            return undefined;
        }
        return mapping[lang] ?? lang.toUpperCase();
    }

    async isAvailable(): Promise<boolean> {
        try {
            const response = await fetch(`${this.endpoint.replace('/translate', '/usage')}`, {
                headers: {
                    'Authorization': `DeepL-Auth-Key ${this.apiKey}`,
                },
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}

/**
 * No-op translator that returns text unchanged
 * Used when translation is disabled or unavailable
 */
export class NoOpTranslator implements Translator {
    async translate(request: TranslationRequest): Promise<TranslationResult> {
        return {
            translatedText: request.text,
            fromCache: false,
        };
    }

    async isAvailable(): Promise<boolean> {
        return true;
    }
}

/**
 * Factory function to create a translator based on config
 */
export function createTranslator(
    config: SessionTranslationConfig,
    options?: {
        openaiApiKey?: string;
        deeplApiKey?: string;
        cache?: TranslationCache;
    },
): Translator {
    if (!config.enabled) {
        return new NoOpTranslator();
    }

    switch (config.provider) {
        case 'openai':
            if (options?.openaiApiKey) {
                return new OpenAITranslator({
                    apiKey: options.openaiApiKey,
                    cache: options.cache,
                });
            }
            break;

        case 'deepl':
            if (options?.deeplApiKey) {
                return new DeepLTranslator({
                    apiKey: options.deeplApiKey,
                    cache: options.cache,
                });
            }
            break;

        case 'custom':
            // Custom translator would need to be injected
            break;
    }

    // Fallback to no-op if provider not configured
    return new NoOpTranslator();
}