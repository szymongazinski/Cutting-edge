export function element(tag, className, parent) {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

export function icon(name, parent) {
  const node = element('span', 'ce-icon', parent);
  node.setAttribute('aria-hidden', 'true');
  // Names come exclusively from the editor's installed icon set.
  node.style.setProperty('--ce-icon', 'url("../assets/icons/' + name + '.svg")');
  return node;
}

export function label(button, title) {
  button.title = title;
  button.setAttribute('aria-label', title);
}

export function button(parent, className, title, onClick) {
  const node = element('button', className, parent);
  node.type = 'button';
  label(node, title);
  node.addEventListener('click', onClick);
  return node;
}

export function setBox(node, box) {
  node.style.left = box.x * 100 + '%';
  node.style.top = box.y * 100 + '%';
  node.style.width = box.w * 100 + '%';
  node.style.height = box.h * 100 + '%';
}

export const assetDragType = 'text/x-cutting-asset';
export const isAssetDrag = (e) => Array.from(e.dataTransfer?.types || []).includes(assetDragType);
