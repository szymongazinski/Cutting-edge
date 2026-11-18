import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import gifenc from 'gifenc';
import { chromium } from 'playwright-core';
import engine from '../app/engine.cjs';
import libraryModule from '../app/library.cjs';

const run = promisify(execFile);
const browserPath = [
  process.env.CE_BROWSER, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((file) => file && existsSync(file));

test('crop media preserves original pixels and the frame under the playhead', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'cutting-crop-frame-'));
  const gifFile = path.join(directory, 'animation.gif');
  const hardFile = path.join(directory, 'source.mov');
  const nativeFile = path.join(directory, 'native.webm');
  const rotatedFile = path.join(directory, 'rotated.jpg');
  t.after(async () => {
    for (const file of [gifFile, hardFile, nativeFile, rotatedFile]) await rm(file, { force: true });
    await rmdir(directory);
  });
  const gif = gifenc.GIFEncoder(), width = 1536, height = 24;
  const palette = [[0, 0, 0], [255, 0, 0], [0, 255, 0]];
  for (const [color, delay] of [[1, 150], [2, 1350]]) {
    const pixels = new Uint8Array(width * height).fill(color);
    pixels[0] = 0;
    gif.writeFrame(pixels, width, height, { palette, delay, transparent: true, transparentIndex: 0 });
  }
  gif.finish();
  await writeFile(gifFile, gif.bytes());
  const { ffmpeg } = await engine.getBinaries();
  const convert = (codec, destination) => run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', gifFile, '-fps_mode', 'vfr',
    '-c:v', codec, destination,
  ], { windowsHide: true });
  await Promise.all([convert('qtrle', hardFile), convert('libvpx-vp9', nativeFile)]);
  const { stdout: jpeg } = await run(ffmpeg, [
    '-v', 'error', '-i', gifFile, '-frames:v', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1',
  ], { encoding: 'buffer', windowsHide: true });
  // An EXIF APP1 segment with a single Orientation=6 (90° clockwise) tag.
  const orientation = Buffer.from('ffe100224578696600004d4d002a00000008000101120003000000010006000000000000', 'hex');
  await writeFile(rotatedFile, Buffer.concat([jpeg.subarray(0, 2), orientation, jpeg.subarray(2)]));
  const library = new libraryModule.Library({ data: directory }, engine);
  const source = { ...await engine.probeAsset(hardFile), path: hardFile };
  library.allow(source);

  await t.test('newly imported JPEG dimensions follow its EXIF orientation', async () => {
    const meta = await engine.probeAsset(rotatedFile);
    assert.deepEqual([meta.kind, meta.duration, meta.width, meta.height], ['image', 5, height, width]);
  });

  await t.test('FFmpeg returns the complete RGBA frame and only accepts approved sources', async () => {
    const frame = await library.cropFrame(hardFile, 0.1);
    assert.equal(frame.readUInt32BE(16), width);
    assert.equal(frame.readUInt32BE(20), height);
    const png = path.join(directory, 'frame.png');
    try {
      await writeFile(png, frame);
      const { stdout } = await run(ffmpeg, [
        '-v', 'error', '-i', png, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1',
      ], { encoding: 'buffer', windowsHide: true });
      assert.equal(stdout[3], 0);
      assert.deepEqual([...stdout.subarray(4, 8)], [255, 0, 0, 255]);
      library.allow({ path: nativeFile, kind: 'video', width, height });
      await writeFile(png, await library.cropFrame(nativeFile, 0.2));
      const legacy = await run(ffmpeg, [
        '-v', 'error', '-i', png, '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1',
      ], { encoding: 'buffer', windowsHide: true });
      assert.ok(legacy.stdout[3] < 32, 'Legacy VP9 metadata must recover the transparent pixel');
    } finally {
      await rm(png, { force: true });
    }
    await assert.rejects(library.cropFrame(gifFile, 0));
    await assert.rejects(library.cropFrame(hardFile, -1));
    await assert.rejects(library.cropFrame(hardFile, Infinity));
    await assert.rejects(library.cropFrame(hardFile, 0, AbortSignal.abort()));
    const waiting = new AbortController();
    const cancelled = library.cropFrame(hardFile, 0, waiting.signal);
    waiting.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    const last = await library.cropFrame(hardFile, source.duration);
    assert.deepEqual(last, await library.cropFrame(hardFile, 0.2));
  });

  await t.test('headless Chromium shows originals, seeks animations and labels failed sources', {
    skip: !browserPath && 'Install Chromium or set CE_BROWSER.',
  }, async () => {
    const browser = await chromium.launch({ executablePath: browserPath, headless: true });
    try {
      const page = await browser.newPage();
      const frameRequests = [];
      await page.route('http://localhost/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"></html>' });
        if (/^\/ui\/[a-z-]+\.mjs$/.test(url.pathname)) {
          const file = fileURLToPath(new URL('..' + url.pathname, import.meta.url));
          if (existsSync(file)) return route.fulfill({ contentType: 'text/javascript', path: file });
        }
        if (url.pathname === '/animation.gif') return route.fulfill({ contentType: 'image/gif', path: gifFile });
        if (url.pathname === '/rotated.jpg') return route.fulfill({ contentType: 'image/jpeg', path: rotatedFile });
        if (url.pathname === '/source.mov') {
          if (!url.searchParams.has('frame')) return route.fulfill({ contentType: 'video/quicktime', path: hardFile });
          const time = Number(url.searchParams.get('frame'));
          frameRequests.push(time);
          return route.fulfill({ contentType: 'image/png', body: await library.cropFrame(hardFile, time) });
        }
        return route.fulfill({ status: 404, body: '' });
      });
      await page.goto('http://localhost/');
      await page.evaluate(async () => {
        const { createCropMedia } = await import('/ui/crop-media.mjs');
        window.mount = (asset, time = 0, language = 'en') => {
          window.surface?.destroy();
          window.dimensions = [];
          window.surface = createCropMedia(asset, time, {
            assetUrl: (file) => file, translate: (pl, en) => language === 'pl' ? pl : en,
            onDimensions: (width, height) => dimensions.push([width, height]),
          });
          document.body.replaceChildren(surface.element);
          document.body.append(surface.element.querySelector('.crop-media-status'));
        };
        window.pixel = (node, x = 1) => {
          const sample = document.createElement('canvas');
          const ctx = sample.getContext('2d');
          ctx.drawImage(node, x, 0, 1, 1, 0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data];
        };
        const canvas = document.createElement('canvas');
        canvas.width = 2461;
        canvas.height = 1099;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#123456';
        ctx.fillRect(1, 0, 1, 1099);
        window.original = canvas.toDataURL();
        canvas.width = 64;
        window.poster = canvas.toDataURL();
        mount({ kind: 'image', path: original, thumbnail: poster, width: 2461, height: 1099 });
      });
      await page.waitForFunction(() => document.querySelector('.crop-media img')?.naturalWidth === 2461);
      assert.deepEqual(await page.evaluate(() => pixel(document.querySelector('.crop-media img'))), [18, 52, 86, 255]);
      assert.equal(await page.evaluate(() => pixel(document.querySelector('.crop-media img'), 0)[3]), 0);
      await page.evaluate(() => mount({ kind: 'image', path: '/rotated.jpg', width: 1536, height: 24 }));
      await page.waitForFunction(() => document.querySelector('.crop-media img')?.naturalWidth === 24);
      assert.deepEqual(await page.evaluate(() => dimensions), [[24, 1536]]);

      await page.evaluate((encoded) => {
        const bytes = Uint8Array.from(atob(encoded), (letter) => letter.charCodeAt(0));
        window.movie = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
        mount({ kind: 'video', path: movie, thumbnail: poster }, 0.2);
      }, (await readFile(nativeFile)).toString('base64'));
      await page.waitForFunction(() => {
        const v = document.querySelector('.crop-media video');
        return v?.paused && !v.seeking && v.readyState >= 2 && v.videoWidth === 1536 &&
          Math.abs(v.currentTime - 0.2) < 0.001 && pixel(v, 12)[1] > 200;
      });
      await page.evaluate(() => mount({ kind: 'video', path: '/animation.gif', videoCodec: 'gif' }, 0.2));
      await page.waitForFunction(() => {
        const c = document.querySelector('.crop-media canvas');
        return c?.width === 1536 && pixel(c)[1] === 255;
      });
      assert.deepEqual(await page.evaluate(() => dimensions), [[1536, 24]]);
      assert.deepEqual(frameRequests, []);
      await page.evaluate(() => mount({ kind: 'video', path: '/source.mov', thumbnail: poster }, 0.2));
      await page.waitForFunction(() => {
        const img = document.querySelector('.crop-media img');
        return img?.naturalWidth === 1536 && pixel(img)[1] === 255 && pixel(img, 0)[3] === 0;
      });
      assert.deepEqual(frameRequests, [0.2]);

      await page.evaluate(() => mount({ kind: 'video', path: '/missing.mxf', previewPath: movie, thumbnail: poster }, 0.2));
      await page.waitForFunction(() => {
        const v = document.querySelector('.crop-media video');
        return v?.readyState >= 2 && !v.seeking && v.paused && v.src === movie && pixel(v, 12)[1] > 200;
      });
      assert.match(await page.locator('.crop-media-status:visible').innerText(), /preview copy/i);
      assert.deepEqual(await page.evaluate(() => dimensions), []);
      await page.evaluate(() => mount({ kind: 'image', path: '/missing.png', thumbnail: poster }, 0));
      await page.waitForFunction(() => document.querySelector('.crop-media img')?.naturalWidth === 64);
      assert.match(await page.locator('.crop-media-status:visible').innerText(), /thumbnail/i);
      assert.deepEqual(await page.evaluate(() => dimensions), []);
      await page.evaluate(() => mount({ kind: 'video', path: '/missing.webm' }, 0, 'pl'));
      await page.waitForFunction(() => document.querySelector('.crop-media-status')?.textContent.includes('źródł'));
      assert.match(await page.locator('.crop-media-status:visible').innerText(), /źródł/);
      await page.evaluate(() => { surface.destroy(); URL.revokeObjectURL(movie); });
      assert.equal(await page.locator('.crop-media-status').count(), 0);
    } finally {
      await browser.close();
    }
  });
});
