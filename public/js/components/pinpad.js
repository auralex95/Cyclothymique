/**
 * Pavé numérique tactile pour saisir le code d'accès au mode Régie.
 *
 * Sur un écran tactile branché au Raspberry Pi il n'y a souvent pas de clavier :
 * on affiche donc nos propres touches plutôt que de compter sur celui du système.
 */

import { h } from '../util.js';

/**
 * Affiche le pavé et renvoie le code saisi (ou null si l'utilisateur annule).
 * @param {Object} opts
 * @param {string} opts.title
 * @param {string} [opts.hint]
 * @returns {Promise<string|null>}
 */
export function askPin({ title = 'Code d’accès', hint = '' } = {}) {
  return new Promise((resolve) => {
    let code = '';
    const display = h('.pin-display');
    const error = h('.pin-error');

    const paint = () => { display.textContent = code ? '•'.repeat(code.length) : '—'; };

    const close = (value) => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(value);
    };

    const press = (digit) => {
      if (code.length >= 12) return;
      code += digit;
      error.textContent = '';
      paint();
    };

    const key = (label, onclick, cls = '') =>
      h(`button.pin-key${cls}`, { type: 'button', onclick }, label);

    // Clavier physique accepté aussi (pratique en développement sur ordinateur).
    const onKey = (ev) => {
      if (ev.key >= '0' && ev.key <= '9') press(ev.key);
      else if (ev.key === 'Backspace') { code = code.slice(0, -1); paint(); }
      else if (ev.key === 'Enter') close(code);
      else if (ev.key === 'Escape') close(null);
    };
    window.addEventListener('keydown', onKey);

    const overlay = h('.pin-overlay', null,
      h('.pin-card', null,
        h('h2', null, title),
        hint ? h('p.muted', null, hint) : null,
        display,
        error,
        h('.pin-grid', null,
          ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, () => press(d))),
          key('C', () => { code = ''; paint(); }),
          key('0', () => press('0')),
          key('⌫', () => { code = code.slice(0, -1); paint(); })
        ),
        h('.row', null,
          h('button.btn', { type: 'button', style: { flex: '1 1 40%' }, onclick: () => close(null) }, 'Annuler'),
          h('button.btn.primary', { type: 'button', style: { flex: '1 1 55%' }, onclick: () => close(code) }, 'Valider')
        )
      )
    );

    paint();
    document.body.append(overlay);
  });
}
