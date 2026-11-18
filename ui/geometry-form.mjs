import { el, btn, fields, field, number, modal, formAction } from './dom.mjs';
import { state, t, time, project, changeClip } from './session.mjs';
import { coverCrop } from './layout.mjs';
import { fullBox, loops, visualSource } from './model.mjs';
import { createCropCanvas } from './crop-canvas.mjs';
import { createCropMedia } from './crop-media.mjs';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function boxFields(box, changed = () => {}) {
  const initial = box || fullBox();
  const inputs = {};
  const labels = { x: 'X %', y: 'Y %', w: t('Szerokość %', 'Width %'), h: t('Wysokość %', 'Height %') };
  const controls = fields(
    ...Object.keys(labels).map((k) => {
      const n = number(initial[k] * 100, {
        min: ['w', 'h'].includes(k) ? 0.1 : 0,
        max: 100,
        step: 'any',
      });
      inputs[k] = n;
      return field(labels[k], n);
    }),
  );
  const value = () => {
    const w = clamp(+inputs.w.value / 100, 0.001, 1),
      h = clamp(+inputs.h.value / 100, 0.001, 1);
    return { x: clamp(+inputs.x.value / 100, 0, 1 - w), y: clamp(+inputs.y.value / 100, 0, 1 - h), w, h };
  };
  for (const n of Object.values(inputs)) n.addEventListener('input', () => changed(value()));
  return {
    controls,
    value,
    set: (b) => {
      for (const [k, n] of Object.entries(inputs)) n.value = +(b[k] * 100).toFixed(3);
    },
  };
}
export function placement(initial, ratio = project().width / project().height) {
  const stage = el('div', { class: 'placement-inner', style: { aspectRatio: String(ratio) } }),
    rect = el('div', { class: 'place-box', tabIndex: 0, title: t('Przesuń ramkę', 'Move the box') });
  const draw = (b) =>
    Object.assign(rect.style, {
      left: b.x * 100 + '%',
      top: b.y * 100 + '%',
      width: b.w * 100 + '%',
      height: b.h * 100 + '%',
    });
  const f = boxFields(initial, draw);
  draw(initial);
  stage.append(rect);
  rect.addEventListener('pointerdown', (e) => {
    rect.setPointerCapture(e.pointerId);
    const r = stage.getBoundingClientRect(),
      x = e.clientX,
      y = e.clientY,
      b = f.value();
    const move = (ev) => {
      const cur = {
        ...b,
        x: clamp(b.x + (ev.clientX - x) / r.width, 0, 1 - b.w),
        y: clamp(b.y + (ev.clientY - y) / r.height, 0, 1 - b.h),
      };
      f.set(cur);
      draw(cur);
    };
    rect.addEventListener('pointermove', move);
    rect.addEventListener('lostpointercapture', () => rect.removeEventListener('pointermove', move), {
      once: true,
    });
  });
  return {
    ui: el('div', { class: 'stack' }, el('div', { class: 'placement' }, stage), f.controls),
    value: f.value,
  };
}
export async function editSourceCrop(id) {
  const p = project();
  const clip = p.clips.find((c) => c.id === id);
  const asset = visualSource(p, clip);
  if (!asset) return;
  state.editor?.pause();
  const offset = clamp(time() - clip.start, 0, Math.max(0, clip.duration - 0.000001));
  let sourceTime = (clip.in || 0) + offset;
  if (loops(asset) && asset.duration > 0) sourceTime %= asset.duration;
  const crop = clip.crop || fullBox();
  const box = clip.box || fullBox();
  const result = await openCropWorkspace(asset, box, crop, sourceTime, false);
  if (!result) return;
  const patch = {};
  if (result.crop !== crop) patch.crop = result.crop;
  if (result.box !== box) patch.box = result.box;
  if (Object.keys(patch).length) changeClip(id, patch);
}

// Template slots keep their placement and aspect ratio when replacing footage.
export async function cropDialog(asset, box, initial = null) {
  state.editor?.pause();
  const result = await openCropWorkspace(asset, box, initial, 0, true);
  return result?.crop ?? null;
}

function openCropWorkspace(asset, box, initial, sourceTime, fixedSlot) {
  const p = project();
  const sourceWidth = asset.width || p.width;
  const sourceHeight = asset.height || p.height;
  const crop = initial || coverCrop(sourceWidth, sourceHeight, box.w * p.width, box.h * p.height);
  const media = createCropMedia(asset, sourceTime, {
    onDimensions(w, h) {
      const templateCrop = fixedSlot && !initial ? coverCrop(w, h, box.w * p.width, box.h * p.height) : null;
      workspace.setSourceSize(w, h, templateCrop);
    },
  });
  const workspace = createCropCanvas({ media: media.element, sourceWidth, sourceHeight, crop, box, fixedSlot, t });
  workspace.element.append(media.element.querySelector('.crop-media-status'));
  return new Promise((resolve) => {
    let result = null;
    const m = modal(t('Kadrowanie źródła', 'Crop source'), {
      onClose() {
        workspace.destroy();
        media.destroy();
        resolve(result);
      },
    });
    m.layer.classList.add('crop-dialog-layer');
    m.panel.classList.add('crop-dialog');
    const heading = m.panel.querySelector('.modal-head h2');
    heading.after(el('span', { class: 'crop-filename', title: asset.name }, asset.name));
    const hint = el('span', { class: 'crop-hint', id: 'crop-gestures' }, t(
      'Przeciągnij obraz, aby go przesunąć. Uchwyty przycinają, a kółko przybliża i oddala.',
      'Drag the image to pan. Drag a handle to crop. Scroll to zoom in or out.',
    ));
    workspace.element.setAttribute('aria-describedby', hint.id);
    m.body.append(workspace.element);
    m.foot.append(hint, btn('undo-2', t('Cofnij zmiany', 'Revert changes'), () => {
      workspace.reset();
      workspace.element.focus({ preventScroll: true });
    }));
    formAction(m, t('Zastosuj kadr', 'Apply crop'), () => {
      result = workspace.getResult();
    }, t('Anuluj', 'Cancel'));
    requestAnimationFrame(() => {
      if (m.layer.isConnected) workspace.element.focus({ preventScroll: true });
    });
  });
}
