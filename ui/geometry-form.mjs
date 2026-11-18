import { el, fields, field, number, input, modal, formAction, mediaUrl } from './dom.mjs';
import { t, project } from './session.mjs';
import { coverCrop } from './layout.mjs';
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function boxFields(box, changed = () => {}) {
  const inputs = {};
  const labels = { x: 'X %', y: 'Y %', w: t('Szerokość %', 'Width %'), h: t('Wysokość %', 'Height %') };
  const controls = fields(
    ...Object.keys(labels).map((k) => {
      const n = number(box[k] * 100, { min: ['w', 'h'].includes(k) ? 0.1 : 0, max: 100, step: 'any' });
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
export function cropDialog(asset, box, initial = null) {
  return new Promise((resolve) => {
    let settled = false;
    const m = modal(t('Kadrowanie źródła', 'Crop source'), {
      onClose: () => {
        if (!settled) resolve(null);
      },
    });
    const p = project(),
      targetRatio = (box.w * p.width) / (box.h * p.height);
    const fit = coverCrop(asset.width || p.width, asset.height || p.height, targetRatio, 1);
    let zoom = initial ? clamp(fit.w / initial.w, 1, 8) : 1;
    let fx = initial && initial.w < 1 ? clamp(initial.x / (1 - initial.w), 0, 1) : 0.5;
    let fy = initial && initial.h < 1 ? clamp(initial.y / (1 - initial.h), 0, 1) : 0.5;
    const preview = el('img', {
      src: mediaUrl(asset.thumbnail || asset.previewPath || asset.path),
      alt: asset.name,
    });
    const frame = el(
      'div',
      {
        class: 'crop-frame',
        style: {
          aspectRatio: String(targetRatio),
          height: targetRatio < 2.3 ? '96%' : 'auto',
          width: targetRatio < 2.3 ? 'auto' : '96%',
        },
      },
      preview,
    );
    const slider = input('range', zoom, { min: 1, max: 8, step: 0.01 });
    const controlX = input('range', fx, { min: 0, max: 1, step: 0.001 }),
      controlY = input('range', fy, { min: 0, max: 1, step: 0.001 });
    function crop() {
      const w = fit.w / zoom,
        h = fit.h / zoom;
      return { x: fx * (1 - w), y: fy * (1 - h), w, h };
    }
    function paint() {
      const c = crop();
      Object.assign(preview.style, {
        width: 100 / c.w + '%',
        height: 100 / c.h + '%',
        left: (-100 * c.x) / c.w + '%',
        top: (-100 * c.y) / c.h + '%',
      });
      controlX.value = fx;
      controlY.value = fy;
    }
    [slider, controlX, controlY].forEach(
      (n) =>
        (n.oninput = () => {
          zoom = +slider.value;
          fx = +controlX.value;
          fy = +controlY.value;
          paint();
        }),
    );
    frame.onpointerdown = (e) => {
      frame.setPointerCapture(e.pointerId);
      const x = e.clientX,
        y = e.clientY,
        a = fx,
        b = fy,
        c = crop(),
        r = frame.getBoundingClientRect();
      frame.onpointermove = (ev) => {
        fx = clamp(a - (((ev.clientX - x) / r.width) * c.w) / Math.max(0.0001, 1 - c.w), 0, 1);
        fy = clamp(b - (((ev.clientY - y) / r.height) * c.h) / Math.max(0.0001, 1 - c.h), 0, 1);
        paint();
      };
      frame.onlostpointercapture = () => {
        frame.onpointermove = null;
      };
    };
    paint();
    m.body.append(
      el('strong', {}, asset.name),
      el('div', { class: 'crop-zone' }, frame),
      field(t('Powiększenie', 'Zoom'), slider),
      fields(field(t('Poziomo', 'Horizontal'), controlX), field(t('Pionowo', 'Vertical'), controlY)),
    );
    formAction(
      m,
      t('Zastosuj kadr', 'Apply crop'),
      () => {
        settled = true;
        resolve(crop());
      },
      t('Anuluj', 'Cancel'),
    );
  });
}
