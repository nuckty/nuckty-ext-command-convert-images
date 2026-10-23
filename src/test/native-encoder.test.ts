import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { convertImages } from '../index.js';

test('real Sharp encodes PNG and JPEG variants and reuses a completed cache', async (t) => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'nuckty-real-encoder-'));
    const pixels = Buffer.alloc(128 * 128 * 3);
    let seed = 42;
    for (let offset = 0; offset < pixels.length; offset++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels[offset] = seed >>> 24;
    }
    try {
        await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } })
            .png({ compressionLevel: 0 }).toFile(path.join(dir, 'png.png'));
        await sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } })
            .jpeg({ quality: 100 }).toFile(path.join(dir, 'jpeg.jpg'));
        const stdout = t.mock.method(process.stdout, 'write', () => true);
        const stderr = t.mock.method(process.stderr, 'write', () => true);
        const args = { positional: [], flags: {}, cwd: dir, config: { targets: {} } };
        try {
            assert.equal(await convertImages(args), 0);
            const before: Record<string, { bytes: string; mtime: number }> = {};
            for (const [stem, original] of [['png', 'png.png'], ['jpeg', 'jpeg.jpg']]) {
                const sourceSize = (await fs.stat(path.join(dir, original!))).size;
                let targetSize = sourceSize;
                for (const format of ['webp', 'avif']) {
                    const name = `${stem}.${format}`;
                    const file = path.join(dir, name);
                    const metadata = await sharp(file).metadata();
                    assert.equal(metadata.width, 128);
                    assert.equal(metadata.height, 128);
                    assert.equal(metadata.format, format === 'avif' ? 'heif' : 'webp');
                    const stat = await fs.stat(file);
                    assert.ok(stat.size > 0 && stat.size < targetSize, `${name} must beat its target`);
                    targetSize = stat.size;
                    before[name] = { bytes: (await fs.readFile(file)).toString('hex'), mtime: stat.mtimeMs };
                }
            }
            assert.equal(await convertImages(args), 0);
            for (const [name, expected] of Object.entries(before)) {
                const file = path.join(dir, name);
                assert.equal((await fs.readFile(file)).toString('hex'), expected.bytes);
                assert.equal((await fs.stat(file)).mtimeMs, expected.mtime);
            }
            assert.equal((await fs.readdir(dir)).some((name) => name.endsWith('.tmp')), false);
        } finally {
            stdout.mock.restore();
            stderr.mock.restore();
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
