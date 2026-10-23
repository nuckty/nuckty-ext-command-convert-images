/**
 * convert-images logic — encode content PNG/JPEG to AVIF and WebP siblings via
 * sharp (openspec `ext-command-convert-images`). Encoding is a separate step from
 * `nuckty build` and runs when images change. The project may version prepared
 * variants and the MD5 cache to reuse completed conversions after cloning. The
 * command writes these files but does not commit them. sharp belongs only to
 * this extension.
 *
 * Quality selection and skip decisions are independent of sharp. Scanning and
 * cache helpers use filesystem I/O; the command injects an Encoder for tests
 * or creates the real sharp encoder through makeSharpEncoder.
 *
 * @module convert-images
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Source image kind: `png` or `jpeg` (`.jpg`/`.jpeg` both map to `jpeg`). */
export type ImageKind = 'png' | 'jpeg';
/** Output format: AVIF or WebP. */
export type OutFormat = 'avif' | 'webp';

/** A discovered source image. */
export interface SourceImage {
    path: string;
    kind: ImageKind;
}

/** Per-format default quality (start of the iterative descent). */
export interface QualityDefaults {
    pngAvif: number;
    pngWebp: number;
    jpegAvif: number;
    jpegWebp: number;
}

export const DEFAULT_QUALITY: QualityDefaults = {
    pngAvif: 50,
    pngWebp: 90,
    jpegAvif: 50,
    jpegWebp: 90,
};

/** Maximum codec effort (compression level) for each format. */
export const AVIF_MAX_EFFORT = 9;
export const WEBP_MAX_EFFORT = 6;

/** Cache filename at the scan root; versioning it is a project decision. */
export const CACHE_FILE = 'convert-images.json';

/**
 * An injected encoder: encode `input` to `output` in `format` at `quality`. The
 * real one is backed by sharp; tests inject a fake that returns a deterministic
 * size. Resolves with the byte size of the written file.
 */
export type Encoder = (
    input: string,
    output: string,
    format: OutFormat,
    quality: number,
    kind: ImageKind,
) => Promise<number>;

/** Decide whether an encoded variant is small enough to keep. */
export function isSmallerThan(outSize: number, targetSize: number): boolean {
    return outSize > 0 && outSize < targetSize;
}

/**
 * Iteratively lower the quality until the encoded result is smaller than the
 * `targetSize`, starting from `startQuality`. Returns the winning
 * `{ quality, size }` when one beats the target, or `null` when even quality 1
 * does not. Pure over the injected `encode` — no I/O beyond what `encode` does.
 *
 * The command targets the original size for WebP, then the new WebP size for
 * AVIF. If no WebP is kept, AVIF targets the original size instead.
 */
export async function encodeIterative(
    encode: (quality: number) => Promise<number>,
    startQuality: number,
    targetSize: number,
): Promise<{ quality: number; size: number } | null> {
    for (let q = startQuality; q >= 1; q--) {
        const size = await encode(q);
        if (isSmallerThan(size, targetSize)) return { quality: q, size };
    }
    return null;
}

/** MD5 hex of a file's bytes — the content-hash cache key. */
export async function md5File(filePath: string): Promise<string> {
    const buf = await fsp.readFile(filePath);
    return crypto.createHash('md5').update(buf).digest('hex');
}

/** Map a file extension to a source kind, or `null` if not an image. */
export function imageKindOf(ext: string): ImageKind | null {
    const e = ext.toLowerCase();
    if (e === '.png') return 'png';
    if (e === '.jpg' || e === '.jpeg') return 'jpeg';
    return null;
}

/**
 * Recursively scan `dir` for PNG/JPEG sources, skipping `.git` directories. Pure
 * I/O: walks the filesystem without mutation. Paths retain the form of dir
 * (absolute or relative).
 */
export async function scanImageFiles(dir: string): Promise<SourceImage[]> {
    const out: SourceImage[] = [];
    await walk(dir, out);
    return out;

    async function walk(d: string, acc: SourceImage[]): Promise<void> {
        const entries: fs.Dirent[] = await fsp.readdir(d, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === '.git') continue;
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) {
                await walk(full, acc);
            } else if (entry.isFile()) {
                const kind = imageKindOf(path.extname(entry.name));
                if (kind) acc.push({ path: full, kind });
            }
        }
    }
}

/** Cache entry: byte sizes of the variants that were written for a given hash. */
export type CacheEntry = { avif?: number; webp?: number; complete?: boolean };
export type Cache = Record<string, CacheEntry>;

/** Load and validate the whole cache before allowing output mutations. */
export async function loadCache(cachePath: string): Promise<Cache> {
    let raw: string;
    try {
        raw = await fsp.readFile(cachePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {};
        }
        throw error;
    }
    try {
        const value: unknown = JSON.parse(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('expected an object');
        }
        for (const entry of Object.values(value)) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new Error('expected cache entry objects');
            }
            for (const [key, size] of Object.entries(entry)) {
                if (key === 'complete' ? typeof size !== 'boolean' :
                    !['webp', 'avif'].includes(key) || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
                    throw new Error(`invalid cache field ${key}`);
                }
            }
        }
        return value as Cache;
    } catch (error) {
        throw new Error(`Invalid cache ${cachePath}: ${(error as Error).message}. Repair or remove the cache and retry.`);
    }
}

/** Save the cache (pretty-printed) unless `dryRun`. Returns whether it was saved. */
export async function saveCache(cachePath: string, cache: Cache, dryRun: boolean): Promise<boolean> {
    if (dryRun) return false;
    const temporary = `${cachePath}.${crypto.randomUUID()}.tmp`;
    try {
        await fsp.writeFile(temporary, JSON.stringify(cache, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
        await fsp.rename(temporary, cachePath);
    } finally {
        await fsp.rm(temporary, { force: true });
    }
    return true;
}

/**
 * Process forced, absent or incomplete cache entries, and completed entries
 * whose recorded variants are missing at this source path. A cached hash alone
 * does not authorize a skip.
 */
export function needsProcessing(
    hash: string,
    cache: Cache,
    force: boolean,
    missingOutputs?: { webp?: boolean; avif?: boolean },
): boolean {
    if (force) return true;
    if (cache[hash]?.complete !== true) return true;
    if (missingOutputs?.webp || missingOutputs?.avif) return true;
    return false;
}

/** Resolve the start quality for a (kind, format) pair from the defaults. */
export function startQuality(kind: ImageKind, format: OutFormat, q: QualityDefaults): number {
    return kind === 'png'
        ? (format === 'avif' ? q.pngAvif : q.pngWebp)
        : (format === 'avif' ? q.jpegAvif : q.jpegWebp);
}

