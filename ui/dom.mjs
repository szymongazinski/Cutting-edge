export const by = (id) => document.getElementById(id);
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'value') node.value = v;
    else if (k in node && !['list', 'form', 'type', 'role', 'for'].includes(k)) node[k] = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  node.append(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}
export const icon = (name) =>
  el('span', {
    class: 'ico',
    ariaHidden: 'true',
    style: { maskImage: 'url("../assets/icons/' + name + '.svg")' },
  });
export const btn = (name, label, fn, cls = '', onlyIcon = false) =>
  el(
    'button',
    { type: 'button', class: 'btn ' + cls, title: label, 'aria-label': label, onclick: fn },
    name ? icon(name) : null,
    onlyIcon ? null : label,
  );
export const ib = (name, label, fn, cls = '') => btn(name, label, fn, 'icon-btn ' + cls, true);
export const group = (...nodes) => el('div', { class: 'row' }, nodes);
export const input = (type, value, attrs = {}) => el('input', { type, value, ...attrs });
export const number = (value, { min = 0, max = 99999, step = 0.01 } = {}) =>
  input('number', step === 'any' ? value : Math.round(value * 10000) / 10000, { min, max, step });
export function select(items, value) {
  const s = el('select');
  for (const item of items) {
    const [v, label] = Array.isArray(item) ? item : [item, item];
    s.append(el('option', { value: v }, label));
  }
  s.value = value;
  return s;
}
export function field(caption, control) {
  const formControl = control.matches('input,select,textarea')
    ? control
    : control.querySelector('input,select,textarea');
  if (formControl && !formControl.hasAttribute('aria-label'))
    formControl.setAttribute('aria-label', caption);
  return el('label', { class: 'field' }, el('span', {}, caption), control);
}
export const fields = (...children) => el('div', { class: 'fields' }, children);
export const section = (title, ...children) =>
  el('section', { class: 'prop-section' }, el('h3', {}, title), children);
export const api = (name, data) => window.cutting.call(name, data);
export const mediaUrl = (p) => 'cutting-media://source/' + encodeURIComponent(p);
export const humanTime = (s = 0) =>
  Math.floor(s / 60) + ':' + (Math.floor(s) % 60).toString().padStart(2, '0');
export function notify(message, kind = 'info', long = false) {
  const n = el(
    'div',
    { class: 'toast ' + kind },
    icon(kind === 'error' ? 'circle-help' : 'check'),
    el('span', {}, message),
  );
  by('notifications').append(n);
  setTimeout(() => n.remove(), kind === 'error' || long ? 11500 : 5300);
}
export const error = (e) => notify(String(e?.message || e), 'error');
export const run =
  (fn) =>
  (...args) =>
    Promise.resolve()
      .then(() => fn(...args))
      .catch(error);
export function modal(title, { wide = false, onClose, closeable = true } = {}) {
  const layer = el('div', { class: 'modal-layer' }),
    panel = el('div', {
      class: 'modal ' + (wide ? 'wide' : ''),
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': title,
    });
  const header = el('header', { class: 'modal-head' }, el('h2', {}, title)),
    body = el('div', { class: 'modal-body' }),
    foot = el('footer', { class: 'modal-foot' });
  const prev = document.activeElement,
    overlays = by('overlays');
  if (overlays.lastElementChild) overlays.lastElementChild.inert = true;
  by('app').inert = true;
  const close = () => {
    if (!layer.isConnected) return;
    layer.remove();
    document.removeEventListener('keydown', key, true);
    if (overlays.lastElementChild) overlays.lastElementChild.inert = false;
    else by('app').inert = false;
    if (!prev?.closest('[inert]')) prev?.focus?.();
    onClose?.();
  };
  const key = (e) => {
    if (by('overlays').lastElementChild !== layer) return;
    if (e.key === 'Escape' && closeable) {
      e.stopPropagation();
      close();
    }
    if (e.key === 'Tab') {
      const all = [
        ...panel.querySelectorAll(
          'input:not([disabled]),button:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
        ),
      ].filter((n) => n.offsetParent);
      if (!all.length) return;
      if (e.shiftKey && document.activeElement === all[0]) {
        e.preventDefault();
        all.at(-1).focus();
      } else if (!e.shiftKey && document.activeElement === all.at(-1)) {
        e.preventDefault();
        all[0].focus();
      }
    }
  };
  if (closeable) header.append(ib('x', '×', close));
  panel.append(header, body, foot);
  layer.append(panel);
  by('overlays').append(layer);
  document.addEventListener('keydown', key, true);
  requestAnimationFrame(() => {
    (
      body.querySelector('input:not([type=range]),textarea,select') || header.querySelector('button')
    )?.focus();
  });
  return { layer, body, foot, close, panel };
}
export function formAction(dialog, label, apply, cancelLabel = 'Anuluj') {
  const ok = btn(
    'check',
    label,
    run(async () => {
      if (!dialog.panel.querySelector('input:invalid,select:invalid,textarea:invalid')) {
        ok.disabled = true;
        try {
          if ((await apply()) !== false) dialog.close();
        } finally {
          ok.disabled = false;
        }
      } else dialog.panel.querySelector(':invalid').reportValidity();
    }),
    'primary',
  );
  dialog.foot.append(btn(null, cancelLabel, dialog.close), ok);
  return ok;
}
export function progressDialog(title, detail = '') {
  const m = modal(title, { closeable: false });
  const meter = el('progress', { max: 1 });
  const caption = el('small', { class: 'hint' }, detail);
  m.body.append(meter, caption);
  m.foot.remove();
  return {
    ...m,
    update: (value) => {
      if (typeof value === 'number' && Number.isFinite(value))
        meter.value = Math.max(0, Math.min(1, value));
      else if (typeof value === 'string') caption.textContent = value;
    },
  };
}
