/**
 * Tests for the convert-images command-extension's pure helpers (openspec
 * `ext-command-convert-images`): `encodeIterative` (lower quality until the result
 * beats the target; return null when even quality 1 cannot), `isSmallerThan`,
 * `imageKindOf`, `needsProcessing` (force vs cache), `startQuality` per kind/format,
 * and the scan + cache I/O helpers. sharp itself is NOT tested here —
 * `encodeIterative` takes an injected `encode`, so these tests never load sharp.
 *
 * @module test/convert-images
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    encodeIterative,
    isSmallerThan,
    imageKindOf,
    needsProcessing,
    startQuality,
    scanImageFiles,
    md5File,
    loadCache,
    saveCache,
    CACHE_FILE,
    DEFAULT_QUALITY,
} from '../convert-images.js';

// ---- encodeIterative --------------------------------------------------------

test('encodeIterative: returns the first quality that beats the target', async () => {
    // q=50 → 100, q=49 → 80, q=48 → 60. Target 70 → wins at q=48.
    const sizes: Record<number, number> = { 50: 100, 49: 80, 48: 60 };
    const win = await encodeIterative((q) => Promise.resolve(sizes[q] ?? 1000), 50, 70);
    assert.equal(win!.quality, 48);
    assert.equal(win!.size, 60);
});

test('encodeIterative: returns the start quality when it already beats target', async () => {
    const win = await encodeIterative((q) => Promise.resolve(q === 50 ? 40 : 1000), 50, 100);
    assert.equal(win!.quality, 50);
    assert.equal(win!.size, 40);
});

test('encodeIterative: returns null when no quality beats the target', async () => {
    // Every quality yields a size >= target (70).
    const win = await encodeIterative((q) => Promise.resolve(70 + (50 - q)), 50, 70);
    assert.equal(win, null);
});

test('encodeIterative: descends through every quality down to 1', async () => {
    let calls = 0;
    const win = await encodeIterative(() => { calls++; return Promise.resolve(999); }, 5, 10);
    assert.equal(win, null);
    assert.equal(calls, 5);
});

// ---- isSmallerThan ----------------------------------------------------------

test('isSmallerThan: a smaller positive size passes', () => {
    assert.equal(isSmallerThan(40, 100), true);
});

test('isSmallerThan: equal size does not pass (strictly smaller)', () => {
    assert.equal(isSmallerThan(100, 100), false);
});

test('isSmallerThan: a zero-length result does not pass', () => {
    assert.equal(isSmallerThan(0, 100), false);
});

// ---- imageKindOf ------------------------------------------------------------

test('imageKindOf: png / jpg / jpeg map to kinds; others are null', () => {
    assert.equal(imageKindOf('.png'), 'png');
    assert.equal(imageKindOf('.PNG'), 'png');
    assert.equal(imageKindOf('.jpg'), 'jpeg');
    assert.equal(imageKindOf('.jpeg'), 'jpeg');
    assert.equal(imageKindOf('.gif'), null);
    assert.equal(imageKindOf('.webp'), null);
});

// ---- needsProcessing --------------------------------------------------------

test('needsProcessing: force always true even if cached', () => {
    assert.equal(needsProcessing('h', { h: { webp: 10 } }, true), true);
});

test('needsProcessing: uncached hash needs processing', () => {
    assert.equal(needsProcessing('h', {}, false), true);
});

test('needsProcessing: cached hash is skipped without force', () => {
    assert.equal(needsProcessing('h', { h: { webp: 10, complete: true } }, false), false);
});

// ---- startQuality -----------------------------------------------------------

test('startQuality: picks the default per (kind, format)', () => {
    assert.equal(startQuality('png', 'avif', DEFAULT_QUALITY), DEFAULT_QUALITY.pngAvif);
    assert.equal(startQuality('png', 'webp', DEFAULT_QUALITY), DEFAULT_QUALITY.pngWebp);
    assert.equal(startQuality('jpeg', 'avif', DEFAULT_QUALITY), DEFAULT_QUALITY.jpegAvif);
    assert.equal(startQuality('jpeg', 'webp', DEFAULT_QUALITY), DEFAULT_QUALITY.jpegWebp);
});

// ---- scanImageFiles ---------------------------------------------------------

test('scanImageFiles: collects png/jpeg recursively and skips .git', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ci-'));
    try {
        await mkdir(path.join(root, 'free'));
        await mkdir(path.join(root, '.git', 'objects'), { recursive: true });
        await writeFile(path.join(root, 'free', 'a.png'), Buffer.from('png'));
        await writeFile(path.join(root, 'free', 'b.jpg'), Buffer.from('jpg'));
        await writeFile(path.join(root, 'free', 'ignore.txt'), 'x');
        await writeFile(path.join(root, '.git', 'objects', 'c.png'), Buffer.from('git'));
        const found = await scanImageFiles(root);
        const kinds = Object.fromEntries(found.map((file) => [path.basename(file.path), file.kind]));

        assert.equal(found.length, 2);
        assert.deepEqual(kinds, { 'a.png': 'png', 'b.jpg': 'jpeg' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('scanImageFiles: a missing dir fails rather than caching an incomplete scan', async () => {
    await assert.rejects(scanImageFiles(path.join(tmpdir(), 'does-not-exist-' + 'x')), { code: 'ENOENT' });
});

// ---- md5File + cache ---------------------------------------------------------

test('md5File: stable hex of file bytes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ci-'));
    try {
        const f = path.join(root, 'a.txt');
        await writeFile(f, 'hello');
        const h = await md5File(f);
        // md5("hello") = 5d41402abc4b2a76b9719d911017c592
        assert.equal(h, '5d41402abc4b2a76b9719d911017c592');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('loadCache: missing file → empty object', async () => {
    const c = await loadCache(path.join(tmpdir(), 'nope-' + 'x'));
    assert.deepEqual(c, {});
});

test('saveCache + loadCache: round-trip (dry-run does not write)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ci-'));
    try {
        const p = path.join(root, CACHE_FILE);
        const cache = { h: { webp: 10, avif: 8 } };
        assert.equal(await saveCache(p, cache, false), true);
        assert.deepEqual(await loadCache(p), cache);
        assert.equal(await saveCache(p, cache, true), false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('needsProcessing: legacy and partial entries retry', () => {
    assert.equal(needsProcessing('h', { h: { webp: 10 } }, false), true);
    assert.equal(needsProcessing('h', { h: { complete: false, webp: 10 } }, false), true);
});
