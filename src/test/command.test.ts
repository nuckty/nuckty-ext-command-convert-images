import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertImages } from '../index.js';
import type { Encoder } from '../convert-images.js';

async function snapshot(dir: string): Promise<Record<string, string>> {
    const files: Record<string, string> = {};
    for (const name of await fs.readdir(dir, { recursive: true })) {
        if ((await fs.stat(path.join(dir, name))).isFile()) {
            files[name] = (await fs.readFile(path.join(dir, name))).toString('hex');
        }
    }
    return files;
}

const success: Encoder = async (_input, output, format) => {
    const size = format === 'webp' ? 10 : 5;
    await fs.writeFile(output, Buffer.alloc(size, 1));
    return size;
};

test('handler image safety and cache contracts', async (t) => {
    async function fixture(run: (dir: string) => Promise<void>): Promise<void> {
        const dir = await fs.mkdtemp(path.join(tmpdir(), 'image-safety-'));
        try {
            await fs.writeFile(path.join(dir, 'a.png'), Buffer.alloc(100));
            await fs.writeFile(path.join(dir, 'a.webp'), 'OLD-WEBP');
            await fs.writeFile(path.join(dir, 'a.avif'), 'OLD-AVIF');
            await run(dir);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    }
    const run = async (dir: string, encoder = success, flags = {}) => {
        const stdout = t.mock.method(process.stdout, 'write', () => true);
        const stderr = t.mock.method(process.stderr, 'write', () => true);
        try {
            return await convertImages({ positional: [], flags, cwd: dir, config: { targets: {} } }, { encoder });
        } finally {
            stdout.mock.restore();
            stderr.mock.restore();
        }
    };
    const parserPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../nuckty/src/bin/parse-args.ts');
    const { parseArgs } = await import(pathToFileURL(parserPath).href) as {
        parseArgs: (argv: string[], options: { booleanFlags: string[] }) => {
            positional: string[];
            flags: Record<string, string | boolean>;
        };
    };
    const runCli = async (dir: string, tokens: string[], encoder = success) => {
        const stdout = t.mock.method(process.stdout, 'write', () => true);
        const stderr = t.mock.method(process.stderr, 'write', () => true);
        try {
            const parsed = parseArgs(['convert-images', ...tokens], { booleanFlags: ['dry-run', 'force'] });

            return await convertImages({
                positional: parsed.positional.slice(1),
                flags: parsed.flags,
                cwd: dir,
                config: { targets: {} },
            }, { encoder });
        } finally {
            stdout.mock.restore();
            stderr.mock.restore();
        }
    };

    await t.test('invalid caches abort before writes, including force and dry-run', async () => {
        for (const cache of ['null', '[]', '{', '{"h":null}', '{"h":{"webp":"10"}}', '{"h":{"avif":-1}}', '{"h":{"complete":1}}']) {
            for (const flags of [{ force: true }, { 'dry-run': true }]) {
                await fixture(async (dir) => {
                    await fs.writeFile(path.join(dir, 'convert-images.json'), cache);
                    const before = await snapshot(dir);
                    assert.equal(await run(dir, async () => { assert.fail('encoder called'); }, flags), 1);
                    assert.deepEqual(await snapshot(dir), before);
                });
            }
        }
    });
    await t.test('dry-run success is byte-identical and never encodes', async () => {
        await fixture(async (dir) => {
            const before = await snapshot(dir);
            assert.equal(await run(dir, async () => { assert.fail('encoder called'); }, { 'dry-run': true }), 0);
            assert.deepEqual(await snapshot(dir), before);
        });
    });
    await t.test('invalid boolean values abort before writing or encoding', async () => {
        for (const flags of [{ force: 'maybe' }, { 'dry-run': 'maybe' }]) {
            await fixture(async (dir) => {
                const before = await snapshot(dir);
                assert.equal(await run(dir, async () => { assert.fail('encoder called'); }, flags), 1);
                assert.deepEqual(await snapshot(dir), before);
            });
        }
    });
    await t.test('parser and handler reject unknown flags and extra positionals before writes', async () => {
        await fixture(async (dir) => {
            const before = await snapshot(dir);
            assert.equal(await runCli(dir, ['--dry-run', '.'], async () => { assert.fail('encoder called'); }), 0);
            assert.equal(await runCli(dir, ['.', '--dry-run'], async () => { assert.fail('encoder called'); }), 0);
            assert.equal(await runCli(dir, ['--dryrun', 'content'], async () => { assert.fail('encoder called'); }), 1);
            assert.equal(await runCli(dir, ['--force=maybe'], async () => { assert.fail('encoder called'); }), 1);
            assert.equal(await runCli(dir, ['content', 'extra'], async () => { assert.fail('encoder called'); }), 1);
            assert.equal(await runCli(dir, ['--dry-run', '--', 'content', 'extra'], async () => { assert.fail('encoder called'); }), 1);
            assert.deepEqual(await snapshot(dir), before);
        });
    });
    await t.test('same-stem collision fails preflight including dry-run', async () => {
        for (const flags of [{}, { 'dry-run': true }]) {
            await fixture(async (dir) => {
                await fs.writeFile(path.join(dir, 'a.jpg'), 'other source');
                const before = await snapshot(dir);
                assert.equal(await run(dir, async () => { assert.fail('encoder called'); }, flags), 1);
                assert.deepEqual(await snapshot(dir), before);
            });
        }
    });
    await t.test('force partial WebP error preserves both old outputs and foreign temporary file', async () => {
        await fixture(async (dir) => {
            await fs.writeFile(path.join(dir, 'a.webp.foreign.tmp'), 'foreign');
            assert.equal(await run(dir, success), 0);
            const before = await snapshot(dir);
            assert.equal(await run(dir, async (_i, output) => {
                assert.notEqual(output, path.join(dir, 'a.webp'));
                await fs.writeFile(output, 'partial');
                throw new Error('codec failed');
            }, { force: true }), 1);
            const after = await snapshot(dir);
            delete before['convert-images.json'];
            delete after['convert-images.json'];
            assert.deepEqual(after, before);
        });
    });
    await t.test('AVIF failure preserves old AVIF, publishes WebP and retries without force', async () => {
        await fixture(async (dir) => {
            assert.equal(await run(dir, async (input, output, format, q, kind) => {
                if (format === 'avif') {
                    await fs.writeFile(output, 'partial');
                    throw new Error('AVIF failed');
                }
                return success(input, output, format, q, kind);
            }), 1);
            assert.equal(await fs.readFile(path.join(dir, 'a.avif'), 'utf8'), 'OLD-AVIF');
            assert.deepEqual(await fs.readFile(path.join(dir, 'a.webp')), Buffer.alloc(10, 1));
            const calls: string[] = [];
            assert.equal(await run(dir, async (...args) => { calls.push(args[2]); return success(...args); }), 0);
            assert.ok(calls.includes('avif'));
            assert.equal((await fs.readdir(dir)).some((name) => name.endsWith('.tmp')), false);
            assert.equal(await run(dir, async () => { assert.fail('completed cache re-encoded'); }), 0);
        });
    });
    await t.test('same hash success cannot hide another path failure', async () => {
        await fixture(async (dir) => {
            await fs.copyFile(path.join(dir, 'a.png'), path.join(dir, 'b.png'));
            assert.equal(await run(dir, async (input, output, format, q, kind) => {
                if (input.endsWith('a.png')) {
                    throw new Error('first path failed');
                }
                return success(input, output, format, q, kind);
            }), 1);
            const calls: string[] = [];
            assert.equal(await run(dir, async (...args) => {
                calls.push(args[0]);
                return success(...args);
            }), 0);
            assert.ok(calls.some((input) => input.endsWith('a.png')));
            assert.deepEqual(await fs.readFile(path.join(dir, 'a.webp')), Buffer.alloc(10, 1));
        });
    });
    await t.test('cache read failure in dry-run preserves directory snapshot', async () => {
        await fixture(async (dir) => {
            await fs.mkdir(path.join(dir, 'convert-images.json'));
            const before = await snapshot(dir);
            assert.equal(await run(dir, async () => { assert.fail('encoder called'); }, { 'dry-run': true }), 1);
            assert.deepEqual(await snapshot(dir), before);
        });
    });
    await t.test('failure removing an old variant fails and remains retryable', async () => {
        await fixture(async (dir) => {
            await fs.rm(path.join(dir, 'a.webp'));
            await fs.mkdir(path.join(dir, 'a.webp'));
            const notSmaller: Encoder = async (_input, output) => {
                await fs.writeFile(output, Buffer.alloc(100));
                return 100;
            };
            assert.equal(await run(dir, notSmaller), 1);
            assert.equal((await fs.stat(path.join(dir, 'a.webp'))).isDirectory(), true);
            const cache = JSON.parse(await fs.readFile(path.join(dir, 'convert-images.json'), 'utf8'));
            assert.equal(Object.values(cache).every((entry) => (entry as { complete: boolean }).complete === false), true);
            await fs.rm(path.join(dir, 'a.webp'), { recursive: true });
            assert.equal(await run(dir, success), 0);
            assert.deepEqual(await fs.readFile(path.join(dir, 'a.webp')), Buffer.alloc(10, 1));
        });
    });
    for (const stale of ['directory', 'empty']) {
        await t.test(`completed cache rejects stale ${stale} variants`, async () => {
            await fixture(async (dir) => {
                assert.equal(await run(dir, success), 0);
                const original = await fs.readFile(path.join(dir, 'a.png'));

                await fs.rm(path.join(dir, 'a.webp'));
                if (stale === 'directory') {
                    await fs.mkdir(path.join(dir, 'a.webp'));
                    await fs.writeFile(path.join(dir, 'a.webp/sentinel'), 'preserve');
                } else {
                    await fs.writeFile(path.join(dir, 'a.webp'), '');
                }
                let calls = 0;
                const code = await run(dir, async (...args) => {
                    calls++;

                    return success(...args);
                });

                assert.equal(code, stale === 'directory' ? 1 : 0);
                assert.ok(calls > 0, 'stale output must not be accepted as a cache hit');
                assert.deepEqual(await fs.readFile(path.join(dir, 'a.png')), original);
                if (stale === 'directory') {
                    assert.equal(await fs.readFile(path.join(dir, 'a.webp/sentinel'), 'utf8'), 'preserve');
                } else {
                    assert.deepEqual(await fs.readFile(path.join(dir, 'a.webp')), Buffer.alloc(10, 1));
                }
                assert.equal((await fs.readdir(dir)).some((name) => name.endsWith('.tmp')), false);
            });
        });
    }
    await t.test('not-smaller completion is cached, missing outputs regenerate, identical paths get outputs', async () => {
        await fixture(async (dir) => {
            const encoder: Encoder = async (input, output, format, q, kind) => {
                if (format === 'avif') {
                    await fs.writeFile(output, Buffer.alloc(100));
                    return 100;
                }
                return success(input, output, format, q, kind);
            };
            assert.equal(await run(dir, encoder), 0);
            await assert.rejects(fs.access(path.join(dir, 'a.avif')));
            assert.equal(await run(dir, async () => { assert.fail('intentional absence retried'); }), 0);
            await fs.copyFile(path.join(dir, 'a.png'), path.join(dir, 'b.png'));
            assert.equal(await run(dir, encoder), 0);
            assert.deepEqual(await fs.readFile(path.join(dir, 'b.webp')), Buffer.alloc(10, 1));
            await fs.rm(path.join(dir, 'a.webp'));
            assert.equal(await run(dir, encoder), 0);
            await fs.access(path.join(dir, 'a.webp'));
            assert.equal((await fs.readdir(dir)).some((name) => name.endsWith('.tmp')), false);
        });
    });
});
