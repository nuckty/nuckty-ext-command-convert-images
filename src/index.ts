/**
 * @nuckty/ext-command-convert-images — `nuckty convert-images` command-extension.
 *
 * Registers the `convert-images` CLI command: encode content PNG/JPEG to AVIF
 * and WebP siblings via sharp. WebP targets the original size; AVIF targets
 * the new WebP size, or the original when no WebP is kept. The MD5 cache skips
 * completed conversions whose recorded variants exist at this source path.
 * Projects may version the cache and variants for reuse after cloning; the
 * command does not commit them. sharp belongs to this extension, not the core.
 *
 * @module @nuckty/ext-command-convert-images
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import process from 'node:process';
import type { NucktyEnv, CommandArgs } from '@nuckty/core';

import {
    scanImageFiles,
    md5File,
    loadCache,
    saveCache,
    needsProcessing,
    startQuality,
    encodeIterative,
    DEFAULT_QUALITY,
    CACHE_FILE,
    AVIF_MAX_EFFORT,
    WEBP_MAX_EFFORT,
    type Encoder,
    type ImageKind,
    type OutFormat,
    type Cache,
} from './convert-images.js';

/**
 * `nuckty convert-images [contentDir] [--dry-run] [--force]` — encode content
 * images. `inject.encoder` is a test seam (the CLI path lazy-imports sharp);
 * tests inject a fake to exercise the write/keep-on-error behavior without
 * sharp.
 */
export async function convertImages(
    args: CommandArgs,
    inject?: { encoder?: Encoder },
): Promise<number> {
    const unknownFlags = Object.keys(args.flags).filter((name) => !['dry-run', 'force'].includes(name));

    if (unknownFlags.length > 0) {
        process.stderr.write(`nuckty: convert-images — unknown option(s): ${unknownFlags.map((name) => `--${name}`).join(', ')}\n`);

        return 1;
    }
    if (args.positional.length > 1) {
        process.stderr.write('nuckty: convert-images — expected at most one content directory\n');

        return 1;
    }

    let normalized: ReturnType<typeof normalizeArgs>;

    try {
        normalized = normalizeArgs(args);
    } catch (error) {
        process.stderr.write(`nuckty: convert-images — ${(error as Error).message}\n`);

        return 1;
    }
    const { positionalPath, dryRun, force } = normalized;
    // The content root defaults to the cwd; a positional selects a sub-scan root.
    const contentDir = positionalPath ? path.resolve(args.cwd, positionalPath) : path.resolve(args.cwd);
    const cachePath = path.join(contentDir, CACHE_FILE);

    let images;
    try {
        images = await scanImageFiles(contentDir);
    } catch (e) {
        process.stderr.write(`nuckty: convert-images failed to scan ${contentDir}: ${(e as Error).message}\n`);
        return 1;
    }

    let cache: Cache;
    let encoder: Encoder | null;
    try {
        cache = await loadCache(cachePath);
        const destinations = new Map<string, string>();
        for (const img of images) {
            const stem = img.path.slice(0, -path.extname(img.path).length);
            const previous = destinations.get(stem);
            if (previous) {
                throw new Error(`Output collision: ${previous} and ${img.path}. Rename one source before converting.`);
            }
            destinations.set(stem, img.path);
        }
        encoder = dryRun ? null : (inject?.encoder ?? await makeSharpEncoder());
    } catch (error) {
        process.stderr.write(`nuckty: convert-images — ${(error as Error).message}\n`);
        return 1;
    }

    let created = 0;
    let skipped = 0;
    let errors = 0;
    const failedHashes = new Set<string>();

    for (const img of images) {
        const dir = path.dirname(img.path);
        const base = path.basename(img.path, path.extname(img.path));
        const webpPath = path.join(dir, `${base}.webp`);
        const avifPath = path.join(dir, `${base}.avif`);

        let webpSize: number | null = null;
        let avifSize: number | null = null;
        let hash: string | undefined;
        try {
            hash = await md5File(img.path);
            const entry = cache[hash];
            if (entry !== undefined) {
                // CMD-10: the cache records what was produced, but the variant
                // may have been deleted (partial checkout, interrupted clean).
                // Its absence means it must be regenerated — a hash key alone
                // no longer licenses a skip.
                const missing = {
                    webp: entry.webp !== undefined && !(await fileExists(webpPath)),
                    avif: entry.avif !== undefined && !(await fileExists(avifPath)),
                };
                if (!needsProcessing(hash, cache, force, missing)) {
                    skipped++;
                    continue;
                }
            } else if (!needsProcessing(hash, cache, force)) {
                skipped++;
                continue;
            }

            const origSize = (await fsp.stat(img.path)).size;

            // WebP: target = original size. Write only if smaller.
            const webpStart = startQuality(img.kind, 'webp', DEFAULT_QUALITY);
            const webpWin = dryRun
                ? { quality: webpStart, size: 0 }
                : await encodeVariant(encoder!, img.path, webpPath, 'webp', img.kind, webpStart, origSize);
            if (dryRun) {
                created++;
                process.stdout.write(`nuckty: convert-images — would write ${rel(contentDir, webpPath)}\n`);
            } else if (webpWin) {
                webpSize = webpWin.size;
                created++;
            } else {
                await safeUnlink(webpPath);
            }

            // AVIF: target = WebP size (if WebP succeeded) else original. Skip if not smaller.
            const avifStart = startQuality(img.kind, 'avif', DEFAULT_QUALITY);
            const avifTarget = webpSize ?? origSize;
            const avifWin = dryRun
                ? { quality: avifStart, size: 0 }
                : await encodeVariant(encoder!, img.path, avifPath, 'avif', img.kind, avifStart, avifTarget);
            if (dryRun) {
                created++;
                process.stdout.write(`nuckty: convert-images — would write ${rel(contentDir, avifPath)}\n`);
            } else if (avifWin) {
                avifSize = avifWin.size;
                created++;
            } else {
                await safeUnlink(avifPath);
            }

            if (!dryRun) {
                cache[hash] = {
                    complete: true,
                    ...(webpSize !== null ? { webp: webpSize } : {}),
                    ...(avifSize !== null ? { avif: avifSize } : {}),
                };
            }
        } catch (e) {
            errors++;
            if (!dryRun && hash !== undefined) {
                failedHashes.add(hash);
                cache[hash] = {
                    complete: false,
                    ...(webpSize !== null ? { webp: webpSize } : {}),
                    ...(avifSize !== null ? { avif: avifSize } : {}),
                };
            }
            process.stderr.write(`nuckty: convert-images — ${rel(contentDir, img.path)} failed: ${(e as Error).message}\n`);
        }
    }

    if (!dryRun) {
        for (const hash of failedHashes) {
            cache[hash]!.complete = false;
        }
        try {
            await saveCache(cachePath, cache, false);
        } catch (error) {
            errors++;
            process.stderr.write(`nuckty: convert-images — cache save failed: ${(error as Error).message}\n`);
        }
    }
    process.stdout.write(
        `nuckty: convert-images — ${created} written, ${skipped} cached, ${errors} errors\n`,
    );
    return errors === 0 ? 0 : 1;
}

/** Publish only a completed variant; failures own only the temporary sibling. */
async function encodeVariant(encoder: Encoder, input: string, output: string, format: OutFormat,
    kind: ImageKind, quality: number, target: number): Promise<{ quality: number; size: number } | null> {
    const temporary = `${output}.${randomUUID()}.tmp`;
    const handle = await fsp.open(temporary, 'wx');
    await handle.close();
    try {
        const win = await encodeIterative((q) => encoder(input, temporary, format, q, kind), quality, target);
        if (win) {
            await fsp.rename(temporary, output);
        }
        return win;
    } finally {
        await fsp.rm(temporary, { force: true });
    }
}

/** Strip the content-root prefix for friendlier dry-run output. */
function rel(root: string, p: string): string {
    const r = path.relative(root, p);
    return r === '' ? path.basename(p) : r;
}

/** Cached variants must be nonempty regular files, not merely existing paths. */
async function fileExists(p: string): Promise<boolean> {
    try {
        const stat = await fsp.stat(p);

        return stat.isFile() && stat.size > 0;
    } catch {
        return false;
    }
}

function normalizeArgs(args: CommandArgs): { positionalPath: string | undefined; dryRun: boolean; force: boolean } {
    return {
        positionalPath: args.positional[0],
        dryRun: readBooleanFlag(args.flags, 'dry-run'),
        force: readBooleanFlag(args.flags, 'force'),
    };
}

function readBooleanFlag(flags: CommandArgs['flags'], name: 'dry-run' | 'force'): boolean {
    const value = flags[name];

    if (value === undefined || value === 'false') return false;
    if (value === true || value === 'true') return true;
    throw new Error(`--${name} accepts only true or false`);
}

/** Remove an old variant; only an already absent file is harmless. */
async function safeUnlink(p: string): Promise<void> {
    try {
        await fsp.unlink(p);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }
}

/**
 * Build the real sharp `Encoder`. Lazy-imported so `register(env)` does not pull
 * sharp — only an actual invocation pays that cost (and needs sharp installed in
 * the consumer). PNG→WebP uses `nearLossless`; everything else is plain quality.
 */
async function makeSharpEncoder(): Promise<Encoder> {
    const sharp = (await import('sharp')).default;
    return async (input, output, format, quality, kind) => {
        const pipeline = sharp(input);
        if (format === 'avif') {
            await pipeline.avif({ quality, effort: AVIF_MAX_EFFORT }).toFile(output);
        } else if (kind === 'png') {
            await pipeline.webp({ quality, nearLossless: true, effort: WEBP_MAX_EFFORT }).toFile(output);
        } else {
            await pipeline.webp({ quality, effort: WEBP_MAX_EFFORT }).toFile(output);
        }
        const st = await fsp.stat(output);
        if (st.size === 0) {
            await safeUnlink(output);
            throw new Error('zero-length output');
        }
        return st.size;
    };
}

export function register(env: NucktyEnv): void {
    env.commands.add(
        'convert-images',
        'encode content PNG/JPEG to AVIF and WebP next to the originals',
        convertImages,
        { booleanFlags: ['dry-run', 'force'] },
    );
}

export default register;
