import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import gifenc from 'gifenc';
import engine from '../app/engine.cjs';

const browserPath = [
  process.env.CE_BROWSER,
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && existsSync(p));
const skipped = browserPath
  ? false
  : 'Install a Chromium browser or set CE_BROWSER for native interaction tests.';
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/ui/editor.css">
<style>*{box-sizing:border-box}body{margin:0;background:#20252a;color:white;font:14px Arial}#stage{width:640px;height:330px}#timeline{width:760px;height:220px}#transport{width:760px;height:45px}</style>
<div id="app"><section id="stage"></section><div id="transport"></div><section id="timeline"></section><div id="inspector-tabs"></div><div id="properties"></div></div><div id="overlays"></div>
<script type="module">
import {mountEditor} from '/ui/editor.mjs';
import {makeClip} from '/ui/model.mjs';
const canvas=document.createElement('canvas'); canvas.width=200; canvas.height=100;
const ctx=canvas.getContext('2d'); ctx.fillStyle='#00aa44'; ctx.fillRect(0,0,100,100); ctx.fillStyle='#e96627'; ctx.fillRect(100,0,100,100);
const url=canvas.toDataURL();
const image={id:'picture',name:'Landscape',kind:'image',category:'media',path:url,width:200,height:100,duration:5,hasAudio:false};
const p={id:'p',width:640,height:320,fps:25,assets:{picture:image},clips:[]};
const a=makeClip(p,image,0,0), b=makeClip(p,image,6,1);
a.id='a'; a.box={x:.1,y:.1,w:.5,h:.5}; b.id='b'; p.clips.push(a,b);
let selected=[]; window.actions=[]; window.state=p; window.settings={timelineSnap:true,sceneSnap:true,language:'en'};
const edit=mountEditor({stage:stage,timeline:timeline,transport:transport,getProject:()=>p,getSelection:()=>selected,select:ids=>{selected=ids;edit.refresh()},commit:fn=>{fn(p);window.actions.push('edit');edit.refresh()},onTime:t=>window.at=t,flags:()=>window.settings,translate:(pl,en)=>en,assetUrl:p=>p,dropAsset:(...args)=>window.dropped=args,inspect:id=>window.inspected=id,cropSource:async id=>(await import('/ui/geometry-form.mjs')).editSourceCrop(id)});
window.editor=edit; window.selected=()=>selected;window.ready=true;
</script>`;
const base = new URL('../', import.meta.url);
function twoFrameGif() {
  const gif = gifenc.GIFEncoder(),
    palette = [
      [255, 0, 0],
      [0, 255, 0],
    ];
  gif.writeFrame(Uint8Array.of(0, 0, 0, 0), 2, 2, { palette, delay: 150, repeat: 0 });
  gif.writeFrame(Uint8Array.of(1, 1, 1, 1), 2, 2, { palette, delay: 350 });
  gif.finish();
  return Buffer.from(gif.bytes());
}

async function withEditor(run) {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/')
      return res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    if (req.url === '/sticker.gif')
      return res.writeHead(200, { 'Content-Type': 'image/gif' }).end(twoFrameGif());
    if (!/^\/(ui|assets\/icons|assets\/sample)\/[a-z\d.-]+$/i.test(req.url))
      return res.writeHead(404).end();
    try {
      const body = await readFile(fileURLToPath(new URL('.' + req.url, base)));
      const mime = {
        mjs: 'text/javascript',
        svg: 'image/svg+xml',
        css: 'text/css',
        mp4: 'video/mp4',
        wav: 'audio/wav',
      };
      const headers = { 'Content-Type': mime[req.url.split('.').at(-1)], 'Accept-Ranges': 'bytes' };
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (!range) return res.writeHead(200, headers).end(body);
      const start = +range[1],
        end = range[2] ? +range[2] : body.length - 1;
      res
        .writeHead(206, { ...headers, 'Content-Range': 'bytes ' + start + '-' + end + '/' + body.length })
        .end(body.subarray(start, end + 1));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: browserPath,
      headless: true,
      args: ['--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage({ viewport: { width: 960, height: 700 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForFunction(() => window.ready === true, null, { timeout: 6000 });
    await run(page);
    assert.deepEqual(errors, []);
    await page.evaluate(() => editor.destroy());
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

const uiTest = (name, fn) => test(name, { skip: skipped, timeout: 30000 }, () => withEditor(fn));

async function grabHandle(page, handle) {
  const grip = await page.locator('.ce-stage-selection [data-handle="' + handle + '"]').boundingBox();
  const x = grip.x + grip.width / 2,
    y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y };
}

uiTest(
  'all four preview edges crop without moving or scaling the remaining source pixels',
  async (page) => {
    await page.locator('.ce-clip[data-clip-id=a]').click({ position: { x: 25, y: 10 } });
    await page.evaluate(() => {
      settings.sceneSnap = false;
    });
    const media = page.locator('.ce-stage-media');
    const original = await media.boundingBox();
    for (const [edge, dx, dy] of [
      ['w', 32, 0],
      ['e', -35, 0],
      ['n', 0, 25],
      ['s', 0, -21],
    ]) {
      const before = await page.evaluate(() => state.clips[0].crop);
      const start = await grabHandle(page, edge);
      await page.mouse.move(start.x + dx, start.y + dy);
      await page.mouse.up();
      const after = await page.evaluate(() => state.clips[0].crop);
      assert.ok(dx ? after.w < before.w : after.h < before.h, edge + ' should remove source pixels');
      assert.equal(dx ? after.h : after.w, dx ? before.h : before.w);
      const rect = await media.boundingBox();
      for (const k of ['x', 'y', 'width', 'height'])
        assert.ok(Math.abs(rect[k] - original[k]) < 0.1, edge + ' shifted the source ' + k);
    }
  },
);

uiTest('Control swaps cropping and stretching mid-drag in either edge preference', async (page) => {
  await page.locator('.ce-clip[data-clip-id=a]').click({ position: { x: 25, y: 10 } });
  const media = page.locator('.ce-stage-media');
  for (const mode of ['crop', 'stretch']) {
    await page.evaluate((mode) => {
      settings.sceneSnap = false;
      settings.edgeDragMode = mode;
      editor.refresh();
    }, mode);
    const original = await media.boundingBox();
    const before = await page.evaluate(() => state.clips[0].crop);
    const start = await grabHandle(page, 'w');
    await page.mouse.move(start.x + 32, start.y);
    async function checkPreview(cropping) {
      const current = await media.boundingBox();
      if (cropping)
        assert.ok(Math.abs(current.width - original.width) < 0.1, 'crop keeps the source scale');
      else assert.ok(current.width < original.width - 20, 'stretch changes the source scale');
    }
    await checkPreview(mode === 'crop');
    await page.keyboard.down('Control');
    await checkPreview(mode === 'stretch');
    await page.keyboard.up('Control');
    await checkPreview(mode === 'crop');
    await page.keyboard.down('Control');
    await page.mouse.up();
    await page.keyboard.up('Control');
    const after = await page.evaluate(() => state.clips[0].crop);
    if (mode === 'crop') assert.deepEqual(after, before);
    else assert.ok(after.w < before.w && after.x > before.x);
  }
  assert.equal(await page.evaluate(() => actions.length), 2);
});

uiTest(
  'corner handles scale proportionally and anchor the opposite corner with modifiers',
  async (page) => {
    await page.locator('.ce-clip[data-clip-id=a]').click({ position: { x: 25, y: 10 } });
    const crop = await page.evaluate(() => state.clips[0].crop);
    for (const [edge, keys] of [
      ['nw', ['Control', 'Shift']],
      ['ne', ['Alt']],
      ['se', ['Shift']],
      ['sw', ['Control']],
    ]) {
      const before = await page.evaluate(() => state.clips[0].box);
      for (const k of keys) await page.keyboard.down(k);
      const start = await grabHandle(page, edge);
      await page.mouse.move(start.x + (edge.endsWith('w') ? 25 : -25), start.y);
      await page.mouse.up();
      for (const k of keys) await page.keyboard.up(k);
      const after = await page.evaluate(() => state.clips[0].box);
      assert.ok(after.w < before.w && after.h < before.h, edge + ' must scale both dimensions');
      assert.ok(Math.abs(after.w / after.h - before.w / before.h) < 1e-6);
      const farX = (b) => (edge.endsWith('w') ? b.x + b.w : b.x);
      const farY = (b) => (edge.startsWith('n') ? b.y + b.h : b.y);
      assert.ok(Math.abs(farX(after) - farX(before)) < 1e-6);
      assert.ok(Math.abs(farY(after) - farY(before)) < 1e-6);
      assert.deepEqual(await page.evaluate(() => state.clips[0].crop), crop);
    }
  },
);

async function connectCropDialog(page) {
  await page.addStyleTag({ url: '/ui/shell.css' });
  await page.addStyleTag({ content: '#app{display:block;height:auto}' });
  await page.evaluate(async () => {
    const { state: session } = await import('/ui/session.mjs');
    session.doc = { project: state };
    session.settings = settings;
    session.editor = window.editor;
    window.cutting = { call: async () => {} };
  });
}

async function cropRegion(dialog) {
  return dialog.locator('.crop-selection').evaluate((region) => {
    const r = region.getBoundingClientRect(), s = region.parentElement.getBoundingClientRect();
    return { x: (r.x - s.x) / s.width, y: (r.y - s.y) / s.height, w: r.width / s.width, h: r.height / s.height };
  });
}

async function dragCropPoint(page, point, dx, dy) {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + dx, point.y + dy, { steps: 4 });
  await page.mouse.up();
}

async function centerPoint(locator) {
  const b = await locator.boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

uiTest('large crop workspace trims, pans, zooms and cancels edits directly on the source', async (page) => {
  await connectCropDialog(page);
  await page.locator('.ce-clip[data-clip-id=a]').click({ button: 'right' });
  await page.locator('.ce-edit-menu').getByRole('button', { name: 'Crop source' }).click();
  const dialog = page.getByRole('dialog', { name: 'Crop source' });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole('slider').count(), 0);
  const area = await dialog.locator('.crop-workspace').boundingBox();
  assert.ok(area.width >= 880 && area.height >= 530);
  assert.equal(await dialog.locator('[data-edge]').count(), 8);
  const original = await page.evaluate(() => structuredClone(state.clips[0]));
  const selection = dialog.locator('.crop-selection');
  const bounds = await selection.boundingBox();
  await dragCropPoint(page, await centerPoint(dialog.locator('[data-edge=w]')), bounds.width * 0.18, 0);
  const trimmed = await cropRegion(dialog);
  assert.ok(Math.abs(trimmed.x - 0.18) < 0.012 && Math.abs(trimmed.h - 1) < 0.003);
  await dialog.getByRole('button', { name: 'Apply crop' }).click();
  const changed = await page.evaluate(() => state.clips[0]);
  assert.ok(Math.abs(changed.box.w / changed.crop.w - original.box.w) < 0.002);
  assert.ok(Math.abs(changed.box.x + changed.box.w - original.box.x - original.box.w) < 0.002);
  await page.locator('.ce-clip[data-clip-id=a]').click({ button: 'right' });
  await page.locator('.ce-edit-menu').getByRole('button', { name: 'Crop source' }).click();
  const point = await centerPoint(selection);
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, -220);
  await page.waitForFunction((w) => {
    const f = document.querySelector('.crop-selection'), s = f.parentElement;
    return f.getBoundingClientRect().width / s.getBoundingClientRect().width < w - 0.001;
  }, trimmed.w);
  const zoomed = await cropRegion(dialog);
  await dragCropPoint(page, point, 26, 17);
  const panned = await cropRegion(dialog);
  assert.ok(panned.x < zoomed.x && panned.y < zoomed.y);
  assert.ok(Math.abs(panned.w - zoomed.w) < 0.002);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  assert.deepEqual(await page.evaluate(() => state.clips[0]), changed);
});

uiTest('applying the crop dialog after stretching an edge preserves the existing frame', async (page) => {
  await connectCropDialog(page);
  await page.locator('.ce-clip[data-clip-id=a]').click({ position: { x: 25, y: 10 } });
  await page.evaluate(() => {
    settings.sceneSnap = false;
  });
  for (const [edge, dx, dy, stretch] of [
    ['n', 0, 24, false],
    ['w', 24, 0, false],
    ['e', -48, 0, true],
  ]) {
    if (stretch) await page.keyboard.down('Control');
    const start = await grabHandle(page, edge);
    await page.mouse.move(start.x + dx, start.y + dy);
    await page.mouse.up();
    if (stretch) await page.keyboard.up('Control');
  }
  const before = await page.evaluate(() => state.clips[0]);
  await page.locator('.ce-stage-crop').click();
  const dialog = page.getByRole('dialog', { name: 'Crop source' });
  const displayed = await cropRegion(dialog);
  for (const key of ['x', 'y', 'w', 'h'])
    assert.ok(Math.abs(displayed[key] - before.crop[key]) < 0.002, 'dialog must open on the visible source region');
  await dialog.getByRole('button', { name: 'Apply crop' }).click();
  assert.deepEqual(await page.evaluate(() => state.clips[0]), before);
});

uiTest(
  'preview and timeline context menus open the inspector crop dialog for the clicked source',
  async (page) => {
    await connectCropDialog(page);
    const menu = page.locator('.ce-edit-menu:visible');
    const crop = menu.getByRole('button', { name: 'Crop source', exact: true });
    const dialog = page.getByRole('dialog', { name: 'Crop source' });
    const timeline = page.locator('.ce-clip[data-clip-id=b]');
    await timeline.click({ button: 'right', position: { x: 25, y: 10 } });
    assert.equal(await crop.count(), 1, 'timeline menu should offer source cropping');
    await crop.click();
    let selection = await dialog.locator('.crop-selection').boundingBox();
    await dragCropPoint(page, await centerPoint(dialog.locator('[data-edge=e]')), -selection.width / 2, 0);
    await dialog.getByRole('button', { name: 'Apply crop' }).click();
    assert.ok(Math.abs(await page.evaluate(() => state.clips[1].crop.w) - 0.5) < 0.003);
    await page.locator('.ce-layer[data-top-id=a]').click({ button: 'right' });
    assert.equal(await crop.count(), 1, 'preview menu should offer source cropping');
    await crop.click();
    assert.ok(Math.abs((await cropRegion(dialog)).w - 1) < 0.002);
    selection = await dialog.locator('.crop-selection').boundingBox();
    await dragCropPoint(page, await centerPoint(dialog.locator('[data-edge=e]')), -selection.width * 0.75, 0);
    await dialog.getByRole('button', { name: 'Apply crop' }).click();
    const widths = await page.evaluate(() => state.clips.map((c) => c.crop.w));
    assert.ok(Math.abs(widths[0] - 0.25) < 0.003 && Math.abs(widths[1] - 0.5) < 0.003);
    await page.evaluate(async () => {
      const { state: session } = await import('/ui/session.mjs');
      session.selection = ['a'];
      delete state.clips[0].box; // Older projects can omit the full-frame default.
      (await import('/ui/inspector.mjs')).drawInspector();
    });
    await page.locator('#properties').getByRole('button', { name: 'Crop source', exact: true }).click();
    assert.ok(Math.abs((await cropRegion(dialog)).w - widths[0]) < 0.003);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await page.evaluate(() => {
      state.assets.sound = {
        id: 'sound',
        kind: 'audio',
        name: 'Sound',
        duration: 4,
        path: '/assets/sample/Alpine-wind.wav',
      };
      state.clips[1].assetId = 'sound';
      editor.refresh();
    });
    await timeline.click({ button: 'right', position: { x: 25, y: 10 } });
    assert.equal(await crop.count(), 0, 'audio has no source image to crop');
  },
);

uiTest(
  'pointer gestures, anchored wheel zoom, playback and translated native timeline work together',
  async (page) => {
    const clip = page.locator('[data-clip-id="a"].ce-clip');
    const initial = await clip.boundingBox();
    await page.mouse.click(initial.x + 25, initial.y + 12);
    await page.waitForFunction(() => window.selected().includes('a'));
    const boxes = await page.locator('.ce-stage-selection').count();
    assert.equal(boxes, 1);
    const edit = page.locator('.ce-stage-selection');
    const selected = await edit.boundingBox();
    await page.mouse.move(selected.x + 40, selected.y + 40);
    await page.mouse.down();
    await page.mouse.move(selected.x + 104, selected.y + 72, { steps: 4 });
    await page.mouse.up();
    const moved = await page.evaluate(() => state.clips[0].box);
    assert.ok(moved.x > 0.18 && moved.y > 0.18);
    assert.equal(await page.evaluate(() => actions.length), 1);
    await page.evaluate(() => {
      editor.setZoom(140);
      document.querySelector('.ce-timeline-scroll').scrollLeft = 215;
    });
    const ruler = await page.locator('.ce-timeline-scroll').boundingBox();
    const origin = await page
      .locator('.ce-lane-label')
      .first()
      .evaluate((el) => el.getBoundingClientRect().right);
    const cursor = origin + 190;
    const before = await page.evaluate(() => [
      editor.getZoom(),
      document.querySelector('.ce-timeline-scroll').scrollLeft,
    ]);
    await page.mouse.move(cursor, ruler.y + 12);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -118);
    await page.keyboard.up('Control');
    await page.waitForFunction((z) => editor.getZoom() > z, before[0]);
    const after = await page.evaluate(() => [
      editor.getZoom(),
      document.querySelector('.ce-timeline-scroll').scrollLeft,
    ]);
    assert.ok(Math.abs((before[1] + 190) / before[0] - (after[1] + 190) / after[0]) < 0.012);
    await page.evaluate(() => {
      editor.seek(0.5);
      editor.playPause();
    });
    await page.waitForFunction(() => editor.getTime() > 0.62);
    await page.evaluate(() => editor.playPause());
    const stopped = await page.evaluate(() => editor.getTime());
    await page.waitForTimeout(90);
    assert.equal(await page.evaluate(() => editor.getTime()), stopped);
    await page.evaluate(() => {
      editor.seek(0);
      editor.setZoom(80);
      document.querySelector('.ce-timeline-scroll').scrollLeft = 0;
    });
    const trim = await clip.locator('[data-trim="end"]').boundingBox();
    await page.mouse.move(trim.x + trim.width / 2, trim.y + trim.height / 2);
    await page.mouse.down();
    await page.mouse.move(trim.x + trim.width / 2 + 80, trim.y + trim.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => state.clips[0].duration), 6);
    await clip.dblclick({ position: { x: 40, y: 12 } });
    assert.equal(await page.evaluate(() => window.inspected), 'a');
  },
);

uiTest(
  'dragging a multi-track selection preserves its time offset and a library drop reaches the chosen lane',
  async (page) => {
    await page.evaluate(() => {
      settings.timelineSnap = false;
      editor.setZoom(80, 0);
    });
    const a = page.locator('.ce-clip[data-clip-id=a]'),
      b = page.locator('.ce-clip[data-clip-id=b]');
    await a.click({ position: { x: 25, y: 10 } });
    await b.click({ position: { x: 25, y: 10 }, modifiers: ['Control'] });
    assert.deepEqual(await page.evaluate(() => selected()), ['a', 'b']);
    const first = await a.boundingBox(),
      h = (await page.locator('.ce-lane').first().boundingBox()).height;
    await page.mouse.move(first.x + 25, first.y + 12);
    await page.mouse.down();
    await page.mouse.move(first.x + 105, first.y + 12 - h, { steps: 4 });
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => state.clips.map((c) => [c.start, c.track])), [
      [1, 1],
      [7, 2],
    ]);
    const target = page.locator('.ce-lane[data-lane="0"] .ce-lane-body');
    await target.evaluate((node) => {
      const rect = node.getBoundingClientRect(),
        dataTransfer = new DataTransfer();
      dataTransfer.setData('text/x-cutting-asset', 'picture');
      const init = {
        clientX: rect.left + 200,
        clientY: rect.top + 10,
        dataTransfer,
        bubbles: true,
        cancelable: true,
      };
      node.dispatchEvent(new DragEvent('dragover', init));
      node.dispatchEvent(new DragEvent('drop', init));
    });
    assert.deepEqual(await page.evaluate(() => dropped), ['picture', 2.5, 0]);
  },
);

uiTest(
  'the composited preview crops a nested canvas into portrait with transparent areas revealing the background',
  async (page) => {
    await page.evaluate(() => {
      const c = state.clips[0];
      state.width = 320;
      state.height = 640;
      state.clips = [
        {
          id: 'group',
          kind: 'compound',
          name: 'group',
          start: 0,
          in: 0,
          track: 0,
          duration: 4,
          box: { x: 0, y: 0, w: 1, h: 1 },
          crop: { x: 0.5, y: 0, w: 0.5, h: 1 },
          volume: 1,
          muted: false,
          children: [{ ...c, box: { x: 0.5, y: 0.25, w: 0.5, h: 0.5 } }],
        },
      ];
      editor.refresh();
      editor.seek(0.4);
    });
    await page.waitForFunction(() => document.querySelector('.ce-stage-media')?.complete);
    const pic = await page.locator('.ce-stage-frame').screenshot();
    const pixels = await page.evaluate(async (data) => {
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      return [
        [0.25, 0.5],
        [0.75, 0.5],
        [0.75, 0.1],
      ].map(([x, y]) =>
        [...ctx.getImageData(x * bitmap.width, y * bitmap.height, 1, 1).data].slice(0, 3),
      );
    }, pic.toString('base64'));
    assert.deepEqual(pixels, [
      [0, 170, 68],
      [233, 102, 39],
      [0, 0, 0],
    ]);
  },
);

uiTest(
  'native video and audio decoders follow compound offsets through seek, mixed playback, pause and mute',
  async (page) => {
    await page.evaluate(() => {
      const base = state.clips[0],
        full = { x: 0, y: 0, w: 1, h: 1 };
      state.assets.video = {
        id: 'video',
        kind: 'video',
        category: 'media',
        path: '/assets/sample/Ridgeline.mp4',
        name: 'screen',
        duration: 5,
        width: 1920,
        height: 1080,
        hasAudio: false,
      };
      state.assets.audio = {
        id: 'audio',
        kind: 'audio',
        category: 'media',
        path: '/assets/sample/Alpine-wind.wav',
        name: 'mic',
        duration: 8,
        hasAudio: true,
      };
      state.clips = [
        {
          ...base,
          id: 'group',
          kind: 'compound',
          assetId: undefined,
          start: 0.2,
          in: 0.45,
          duration: 3,
          volume: 0.5,
          box: full,
          children: [
            { ...base, id: 'screen', assetId: 'video', in: 0.3, start: 0, duration: 4, box: full },
            {
              ...base,
              id: 'mic',
              assetId: 'audio',
              in: 1.2,
              start: 0.35,
              duration: 4,
              track: 1,
              volume: 0.8,
            },
          ],
        },
      ];
      editor.refresh();
      editor.seek(1.05);
    });
    const media = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('#stage video,#stage audio')].map((m) => [
          m.tagName,
          m.currentTime,
          m.volume,
          m.paused,
          m.muted,
        ]),
      );
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('#stage video,#stage audio')].length === 2 &&
        [...document.querySelectorAll('#stage video,#stage audio')].every(
          (m) => m.readyState >= 2 && !m.seeking,
        ),
    );
    const start = await media();
    assert.ok(Math.abs(start[0][1] - 1.6) < 0.025 && Math.abs(start[1][1] - 2.15) < 0.025);
    assert.ok(Math.abs(start[1][2] - 0.4) < 0.001);
    await page.evaluate(() => editor.playPause());
    await page.waitForFunction(
      () =>
        editor.getTime() > 1.45 &&
        [...document.querySelectorAll('#stage video,#stage audio')].every((m) => !m.paused),
    );
    const moving = await media();
    assert.ok(Math.abs(moving[1][1] - moving[0][1] - 0.55) < 0.13);
    await page.evaluate(() => {
      editor.playPause();
      state.clips[0].muted = true;
      editor.refresh();
    });
    const stopped = await media();
    assert.ok(stopped.every((m) => m[3] && m[4]));
  },
);

uiTest(
  'playback crosses a trimmed cut with its next decoder already at the required frame',
  async (page) => {
    await page.route('**/assets/sample/Ridgeline.mp4', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 230));
      await route.continue();
    });
    await page.evaluate(() => {
      const a = state.clips[0];
      state.assets.video = {
        id: 'video',
        kind: 'video',
        name: 'next camera cut',
        category: 'media',
        path: '/assets/sample/Ridgeline.mp4',
        duration: 5,
        width: 1920,
        height: 1080,
      };
      state.clips = [
        { ...a, duration: 1.4 },
        {
          ...a,
          id: 'group',
          kind: 'compound',
          start: 1.4,
          in: 0.3,
          duration: 2,
          children: [{ ...a, id: 'camera', assetId: 'video', in: 2, start: 0, duration: 3 }],
        },
      ];
      editor.refresh();
      editor.seek(0);
      editor.playPause();
    });
    await page.waitForFunction(() => editor.getTime() >= 1.47);
    const frame = await page
      .locator('#stage video')
      .evaluate((v) => [v.readyState, v.currentTime, v.seeking]);
    assert.ok(
      frame[0] >= 2 && frame[1] >= 2.27 && !frame[2],
      'first frame at cut ' + JSON.stringify(frame),
    );
  },
);

uiTest('quiet microphone waveforms retain visible peaks for manual synchronization', async (page) => {
  const height = await page.evaluate(() => {
    const c = state.clips[0];
    state.assets.mic = {
      id: 'mic',
      name: 'Mic',
      kind: 'audio',
      category: 'media',
      duration: 5,
      path: '/assets/sample/Alpine-wind.wav',
      waveform: [0, 0.001, 0.012, 0.004, 0],
    };
    state.clips = [{ ...c, assetId: 'mic' }];
    editor.refresh();
    const canvas = document.querySelector('.ce-clip .ce-waveform'),
      ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let top = canvas.height,
      bottom = 0;
    for (let y = 0; y < canvas.height; y++)
      for (let x = 0; x < canvas.width; x++)
        if (data[(y * canvas.width + x) * 4 + 3]) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
    return bottom - top + 1;
  });
  assert.ok(height >= 10);
});

uiTest(
  'an original GIF sticker seeks paused frames and repeats its unequal delays without a proxy',
  async (page) => {
    await page.evaluate(() => {
      state.assets.animated = {
        id: 'animated',
        kind: 'video',
        name: 'Sticker',
        category: 'sticker',
        duration: 0.5,
        path: '/sticker.gif',
        hasAudio: false,
      };
      state.clips = [
        { ...state.clips[0], kind: 'media', assetId: 'animated', start: 0, in: 0.05, duration: 2 },
      ];
      editor.refresh();
    });
    for (const [time, green] of [
      [0.05, false],
      [0.24, true],
      [0.51, false],
      [0.75, true],
    ]) {
      await page.evaluate((t) => editor.seek(t), time);
      await page.waitForFunction(
        (green) => {
          const c = document.querySelector('.ce-stage-media');
          if (!c || !c.getContext) return false;
          const pixel = c.getContext('2d').getImageData(0, 0, 1, 1).data;
          return pixel[3] === 255 && (green ? pixel[1] === 255 : pixel[0] === 255);
        },
        green,
        { timeout: 5000 },
      );
    }
  },
);

uiTest('the caption preview and exported frame agree on text size, baseline and center', async (page) => {
  const directory = await mkdtemp(join(tmpdir(), 'ce-preview-caption-'));
  try {
    for (const [font, text, bold, italic] of [
      ['Arial', 'Habg', false, false],
      ['Georgia', 'Północ\nŚwiatła', false, true],
      ['Impact', 'CUT\nEDGE', true, false],
    ]) {
      const p = await page.evaluate(
        ({ font, text, bold, italic }) => {
          const stage = document.getElementById('stage');
          stage.style.width = '672px';
          stage.style.height = '346px';
          Object.assign(state, { schema: 1, name: 'Caption comparison', format: 'mp4', quality: 'high' });
          state.clips = [
            {
              ...state.clips[0],
              id: 'words',
              kind: 'caption',
              assetId: undefined,
              start: 0,
              in: 0,
              duration: 0.3,
              cues: [{ start: 0, end: 0.3, text }],
              box: { x: 0.1, y: 0.2, w: 0.8, h: 0.5 },
              style: {
                font,
                bold,
                italic,
                size: 64,
                color: '#ffffff',
                background: 'transparent',
                strokeWidth: 0,
              },
            },
          ];
          editor.refresh();
          editor.seek(0.08);
          return state;
        },
        { font, text, bold, italic },
      );
      const output = join(directory, 'caption.mp4');
      await engine.renderProject(p, output);
      const { ffmpeg } = await engine.getBinaries();
      const { stdout } = await promisify(execFile)(
        ffmpeg,
        [
          '-loglevel',
          'error',
          '-i',
          output,
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-vcodec',
          'png',
          'pipe:1',
        ],
        { encoding: 'buffer', windowsHide: true },
      );
      const actual = await page.locator('.ce-stage-frame').screenshot();
      const bounds = await page.evaluate(
        async (images) =>
          Promise.all(
            images.map(async (data) => {
              const img = await createImageBitmap(
                await (await fetch('data:image/png;base64,' + data)).blob(),
              );
              const cnv = document.createElement('canvas');
              cnv.width = img.width;
              cnv.height = img.height;
              const ctx = cnv.getContext('2d');
              ctx.drawImage(img, 0, 0);
              const px = ctx.getImageData(0, 0, img.width, img.height).data;
              let left = img.width,
                top = img.height,
                right = 0,
                bottom = 0;
              for (let y = 0; y < img.height; y++)
                for (let x = 0; x < img.width; x++)
                  if (px[4 * (y * img.width + x)] > 180) {
                    left = Math.min(left, x);
                    right = Math.max(right, x);
                    top = Math.min(top, y);
                    bottom = Math.max(bottom, y);
                  }
              return [left, top, right, bottom];
            }),
          ),
        [actual.toString('base64'), stdout.toString('base64')],
      );
      assert.ok(
        bounds[0].every((n, i) => Math.abs(n - bounds[1][i]) <= 3),
        font + ' ' + JSON.stringify(bounds),
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
