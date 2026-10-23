# nuckty-ext-command-convert-images

> **Encode content images to AVIF and WebP — the `convert-images` command.**

A command extension for [nuckty](https://github.com/nuckty/nuckty). It prepares WebP and AVIF siblings for PNG/JPEG, lowering quality to meet a size target. An MD5 cache skips completed conversions. The build copies prepared variants; sharp belongs only to this extension. Keeping variants and the cache in the content repository allows reuse after cloning. The command does not commit files.

## What it adds

One CLI command, registered through `env.commands`:

```
nuckty convert-images [contentDir] [--dry-run] [--force]
```

- `contentDir` — root to scan (default: the current directory).
- `--dry-run` — reports what would be written without touching disk.
- `--force` — re-encodes even files the cache already knows.

## How it works

1. Recursively scans the content dir for PNG/JPEG (skips `.git`).
2. Skips a hash only after a completed conversion and when its recorded variants exist at this source path (unless `--force`). Legacy cache entries without a completion marker are safely re-encoded once.
3. Encode WebP from the original until it is smaller. Encode AVIF from the original, with the size of the new WebP as the target, or the original size when no WebP was produced. Omit a variant that cannot be smaller even at quality 1.
4. Record sizes and completion in `convert-images.json` at the scan root. Save that file and the variants in version control yourself when required.

Run from the configured site root and pass the content directory: `npx nuckty convert-images external/content`.

## Why a separate step

`nuckty build` copies prepared variants into the artifact without invoking sharp. Run encoding separately when images change. Like `content-external`, this is an explicit step that prepares build inputs.

Invalid cache data and PNG/JPEG sources sharing an output basename stop the command before any writes. Repair or remove an invalid cache, or rename a colliding source, then retry. Each variant is encoded into a unique temporary sibling and replaces the previous output only after success. An encoder error preserves previous outputs and leaves the hash eligible for retry; a successful WebP may remain when AVIF fails. A completed conversion that cannot beat the size target is cached without that variant. `--dry-run` never modifies files, including on errors.

