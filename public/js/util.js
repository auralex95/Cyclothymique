/** Petites fonctions utilitaires partagées par toutes les vues (aucune dépendance). */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const pct = (v) => `${Math.round(clamp01(v) * 100)}%`;
export const dmx = (v) => Math.round(clamp01(v) * 255);

/**
 * Création d'élément concise : h('div.classe', { onclick }, 'texte', enfant…)
 * Le sélecteur accepte 'tag.classe1.classe2' ou '.classe' (div par défaut).
 */
export function h(sel, props = null, ...children) {
  const [tag, ...classes] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = `${el.className} ${v}`.trim();
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Vide un conteneur et y insère les nœuds fournis. */
export function mount(container, ...nodes) {
  container.replaceChildren(...nodes.flat().filter(Boolean));
  return container;
}

/** Limite la fréquence d'appel d'une fonction (dernier appel toujours honoré). */
export function throttle(fn, ms) {
  let last = 0, pending = null, timer = null;
  const run = () => { last = performance.now(); timer = null; const args = pending; pending = null; fn(...args); };
  return (...args) => {
    pending = args;
    const wait = ms - (performance.now() - last);
    if (wait <= 0) run();
    else if (!timer) timer = setTimeout(run, wait);
  };
}

/**
 * Gestion de glissé tactile/souris unifiée (Pointer Events).
 * onMove reçoit { x, y, dx, dy, w, h, first } en pixels relatifs à l'élément.
 */
export function draggable(el, { onStart, onMove, onEnd } = {}) {
  let active = null;

  const info = (ev, first) => {
    const r = el.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    const d = { x, y, w: r.width, h: r.height, dx: first ? 0 : x - active.x, dy: first ? 0 : y - active.y, first };
    if (active) { active.x = x; active.y = y; }
    return d;
  };

  el.addEventListener('pointerdown', (ev) => {
    if (active) return;
    ev.preventDefault();
    active = { id: ev.pointerId, x: 0, y: 0 };
    el.setPointerCapture(ev.pointerId);
    const d = info(ev, true);
    onStart?.(d);
    onMove?.(d);
  });

  el.addEventListener('pointermove', (ev) => {
    if (!active || ev.pointerId !== active.id) return;
    ev.preventDefault();
    onMove?.(info(ev, false));
  });

  const stop = (ev) => {
    if (!active || ev.pointerId !== active.id) return;
    active = null;
    try { el.releasePointerCapture(ev.pointerId); } catch { /* déjà relâché */ }
    onEnd?.();
  };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
}

let toastTimer = null;
/** Message éphémère en bas d'écran. */
export function toast(message, ms = 2200) {
  const node = document.getElementById('toast');
  node.textContent = message;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), ms);
}

/** Conversions couleur utilisées par le color picker. */
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
export function rgbToHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
