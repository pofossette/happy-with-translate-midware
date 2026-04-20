/**
 * Simple language detection for translation
 * Uses character analysis to detect Chinese vs English
 */

/**
 * Language detection result
 */
export interface LanguageDetectionResult {
    /** Detected language code */
    lang: string;
    /** Confidence score (0-1) */
    confidence: number;
}

/**
 * Count Chinese characters in text
 */
function countChineseCharacters(text: string): number {
    const matches = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
    return matches ? matches.length : 0;
}

/**
 * Count ASCII letters in text
 */
function countAsciiLetters(text: string): number {
    const matches = text.match(/[a-zA-Z]/g);
    return matches ? matches.length : 0;
}

/**
 * Detect the primary language of a text
 * Returns 'zh' for Chinese, 'en' for English, or 'unknown'
 */
export function detectLanguage(text: string): LanguageDetectionResult {
    if (!text || text.trim().length === 0) {
        return { lang: 'unknown', confidence: 0 };
    }

    const trimmed = text.trim();
    const chineseCount = countChineseCharacters(trimmed);
    const englishCount = countAsciiLetters(trimmed);
    const totalLetters = chineseCount + englishCount;

    // If no recognizable letters, return unknown
    if (totalLetters === 0) {
        return { lang: 'unknown', confidence: 0 };
    }

    const chineseRatio = chineseCount / totalLetters;
    const englishRatio = englishCount / totalLetters;

    // Threshold for confident detection
    const threshold = 0.6;

    if (chineseRatio > threshold) {
        return { lang: 'zh', confidence: chineseRatio };
    }

    if (englishRatio > threshold) {
        return { lang: 'en', confidence: englishRatio };
    }

    // Mixed or unclear - use whichever is higher
    if (chineseRatio > englishRatio) {
        return { lang: 'zh', confidence: chineseRatio };
    }

    return { lang: 'en', confidence: englishRatio };
}

/**
 * Check if text appears to be primarily Chinese
 */
export function isChineseText(text: string): boolean {
    const result = detectLanguage(text);
    return result.lang === 'zh' && result.confidence > 0.5;
}

/**
 * Check if text appears to be primarily English
 */
export function isEnglishText(text: string): boolean {
    const result = detectLanguage(text);
    return result.lang === 'en' && result.confidence > 0.5;
}

/**
 * Estimate if translation is needed
 * Returns true if source language doesn't match expected
 */
export function needsTranslation(text: string, expectedSourceLang: string): boolean {
    const detected = detectLanguage(text);

    if (detected.lang === 'unknown') {
        return false;
    }

    // If auto-detect, check if it's not the target
    if (expectedSourceLang === 'auto') {
        return true;
    }

    return detected.lang === expectedSourceLang;
}