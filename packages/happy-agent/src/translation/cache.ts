/**
 * Translation cache for avoiding repeated translations
 * Uses in-memory cache with configurable TTL
 */

import { createHash } from 'node:crypto';

/**
 * Translation result cached in memory
 */
export interface TranslationResult {
    /** Translated text */
    translatedText: string;
    /** Detected source language (if sourceLang was 'auto') */
    detectedLang?: string;
    /** Whether translation was served from cache */
    fromCache?: boolean;
}

export type CacheKey = `${string}:${string}:${string}:${string}`; // direction:sourceLang:targetLang:hash

export interface CacheEntry {
    result: TranslationResult;
    createdAt: number;
    expiresAt: number;
}

export interface TranslationCacheOptions {
    /** Maximum number of entries in cache */
    maxSize?: number;
    /** Time-to-live in milliseconds */
    ttlMs?: number;
}

const DEFAULT_MAX_SIZE = 1000;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Generate a cache key for a translation request
 */
export function generateCacheKey(
    direction: 'inbound' | 'outbound',
    sourceLang: string,
    targetLang: string,
    sourceText: string,
): CacheKey {
    const hash = createHash('sha256').update(sourceText).digest('hex').slice(0, 16);
    return `${direction}:${sourceLang}:${targetLang}:${hash}`;
}

/**
 * In-memory translation cache with TTL and LRU eviction
 */
export class TranslationCache {
    private cache = new Map<CacheKey, CacheEntry>();
    private readonly maxSize: number;
    private readonly ttlMs: number;

    constructor(options: TranslationCacheOptions = {}) {
        this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    }

    /**
     * Get a cached translation if it exists and hasn't expired
     */
    get(key: CacheKey): TranslationResult | null {
        const entry = this.cache.get(key);
        if (!entry) {
            return null;
        }

        // Check if expired
        if (Date.now() > entry.expiresAt) {
            this.cache.delete(key);
            return null;
        }

        return entry.result;
    }

    /**
     * Store a translation in cache
     */
    set(key: CacheKey, result: TranslationResult): void {
        // Evict oldest entries if at capacity
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey) {
                this.cache.delete(oldestKey);
            }
        }

        const now = Date.now();
        this.cache.set(key, {
            result,
            createdAt: now,
            expiresAt: now + this.ttlMs,
        });
    }

    /**
     * Check if a key exists and is valid
     */
    has(key: CacheKey): boolean {
        return this.get(key) !== null;
    }

    /**
     * Clear all cached entries
     */
    clear(): void {
        this.cache.clear();
    }

    /**
     * Get cache statistics
     */
    stats(): { size: number; maxSize: number; ttlMs: number } {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            ttlMs: this.ttlMs,
        };
    }
}