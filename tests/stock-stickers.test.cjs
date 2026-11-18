const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { getBinaries } = require('../app/engine.cjs');

const run = promisify(execFile);
const root = path.join(__dirname, '../assets/library/sticker');
const families = [
  'Clean Circle', 'Curved Arrow Bold', 'Curved Arrow Thin', 'Double Circle', 'Double Underline',
  'Single Underline', 'Sketched Circle', 'Straight Arrow Bold', 'Straight Arrow Thin',
];

test('the bundled library offers only annotation families, each with six distinct color variants', async () => {
  assert.deepEqual((await fs.readdir(root)).sort(), families);
  for (const family of families) {
    const folder = path.join(root, family);
    const names = (await fs.readdir(folder)).sort();
    assert.deepEqual(names, ['Coral.gif', 'Gold.gif', 'Ink.gif', 'Mint.gif', 'Violet.gif', 'White.gif']);
    const palettes = new Set();
    for (const name of names) {
      const bytes = await fs.readFile(path.join(folder, name));
      assert.equal(bytes.toString('ascii', 0, 6), 'GIF89a');
      assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0\x03\x01\x00\x00')), `${family}/${name} must loop`);
      const colors = 2 << (bytes[10] & 7);
      palettes.add(bytes.subarray(13, 13 + 3 * colors).toString('hex'));
    }
    assert.equal(palettes.size, names.length, `${family} variants have distinct palettes`);
  }
});

test('stock annotations move over transparent footage and retain their distinguishing strokes', async () => {
  const { ffmpeg } = await getBinaries();
  const size = 96;
  const area = size * size;
  const coverage = {};
  for (const family of families) {
    const file = path.join(root, family, 'Coral.gif');
    const { stdout } = await run(ffmpeg, [
      '-v', 'error', '-i', file, '-vf', `scale=${size}:${size}:flags=neighbor,format=rgba,alphaextract`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1',
    ], { encoding: 'buffer', windowsHide: true, maxBuffer: 4_000_000 });
    const frames = new Set();
    const first = stdout.subarray(0, area);
    coverage[family] = first.reduce((count, alpha) => count + Number(alpha > 127), 0);
    assert.ok(coverage[family] > 50, `${family} has a visible first frame`);
    for (let i = 0; i < stdout.length; i += area) {
      const mask = stdout.subarray(i, i + area);
      frames.add(createHash('sha256').update(mask).digest('hex'));
      for (const corner of [0, size - 1, area - size, area - 1]) assert.equal(mask[corner], 0, family);
      if (family.includes('Circle')) assert.equal(mask[area / 2 + size / 2], 0, `${family} center`);
    }
    assert.ok(frames.size >= 10, `${family} should move visibly`);
    if (family.includes('Underline')) {
      let strokes = 0;
      for (let y = 1; y < size; y++) {
        const offset = y * size + size / 2;
        if (first[offset] && !first[offset - size]) strokes++;
      }
      assert.equal(strokes, family === 'Double Underline' ? 2 : 1, family);
    }
  }
  for (const form of ['Straight', 'Curved'])
    assert.ok(coverage[`${form} Arrow Bold`] > 2 * coverage[`${form} Arrow Thin`], `${form} line weights`);
});
