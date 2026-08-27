/**
 * Vue "Réseau" : configuration Art-Net et diagnostic.
 *
 * Un "univers" de l'application = une adresse de port Art-Net (Net / Sub-Net /
 * Universe) + une destination (broadcast ou IP d'un node précis).
 */

import { h, mount, toast } from '../util.js';
import * as S from '../state.js';
import { send } from '../net.js';
import { askPin } from '../components/pinpad.js';

export function render(container) {
  const unsubs = [];

  /** Renvoie la liste des univers telle qu'affichée, prête à être sauvegardée. */
  function collect(rows) {
    return rows.map((row, i) => ({
      id: Number(row.dataset.id),
      name: row.querySelector('[name=name]').value || `Univers ${i + 1}`,
      net: Number(row.querySelector('[name=net]').value),
      subNet: Number(row.querySelector('[name=subNet]').value),
      universe: Number(row.querySelector('[name=universe]').value),
      mode: row.querySelector('[name=mode]').value,
      target: row.querySelector('[name=target]').value,
      enabled: row.querySelector('[name=enabled]').checked
    }));
  }

  function draw() {
    const rows = [];

    const universeRows = S.universes().map((u) => {
      const row = h('.row', {
        dataset: { id: String(u.id) },
        style: { padding: '8px 0', borderBottom: '1px solid var(--line)' }
      },
        h('label.field', { style: { flex: '2 1 160px' } }, 'Nom',
          h('input', { name: 'name', type: 'text', value: u.name })),
        h('label.field', { style: { flex: '0 1 90px' } }, 'Net',
          h('input', { name: 'net', type: 'number', min: '0', max: '127', value: String(u.net) })),
        h('label.field', { style: { flex: '0 1 90px' } }, 'Sub-Net',
          h('input', { name: 'subNet', type: 'number', min: '0', max: '15', value: String(u.subNet) })),
        h('label.field', { style: { flex: '0 1 90px' } }, 'Univers',
          h('input', { name: 'universe', type: 'number', min: '0', max: '15', value: String(u.universe) })),
        h('label.field', { style: { flex: '1 1 140px' } }, 'Diffusion',
          h('select', { name: 'mode' },
            h('option', { value: 'broadcast', selected: u.mode !== 'unicast' }, 'Broadcast'),
            h('option', { value: 'unicast', selected: u.mode === 'unicast' }, 'Unicast (IP)')
          )),
        h('label.field', { style: { flex: '1 1 160px' } }, 'IP du node (unicast)',
          h('input', { name: 'target', type: 'text', value: u.target || '', placeholder: '192.168.1.50' })),
        h('label.inline', { style: { marginTop: '14px' } },
          h('input', { name: 'enabled', type: 'checkbox', checked: u.enabled !== false }), 'Actif'),
        h('button.btn.small.danger', {
          type: 'button', style: { marginTop: '14px' },
          onclick: () => {
            if (S.universes().length <= 1) return toast('Au moins un univers est nécessaire');
            if (!confirm(`Supprimer « ${u.name} » ?`)) return;
            send('universes:save', collect(rows).filter((x) => x.id !== u.id));
          }
        }, '✕')
      );
      rows.push(row);
      return row;
    });

    const universesPanel = h('.panel', null,
      h('h3', null, 'Univers Art-Net'),
      universeRows,
      h('.row', { style: { marginTop: '10px' } },
        h('button.btn.primary', {
          type: 'button',
          onclick: () => { send('universes:save', collect(rows)); toast('Univers enregistrés'); }
        }, 'Enregistrer'),
        h('button.btn', {
          type: 'button',
          onclick: () => {
            const list = collect(rows);
            const id = list.length ? Math.max(...list.map((u) => u.id)) + 1 : 0;
            const last = list[list.length - 1];
            list.push({
              id, name: `Univers ${list.length + 1}`,
              net: last?.net ?? 0, subNet: last?.subNet ?? 0,
              universe: Math.min(15, (last?.universe ?? -1) + 1),
              mode: last?.mode ?? 'broadcast', target: last?.target ?? '255.255.255.255', enabled: true
            });
            send('universes:save', list);
          }
        }, '+ Ajouter un univers'),
        h('span.spacer'),
        h('span.muted', null, 'Adresse de port = Net × 256 + Sub-Net × 16 + Univers')
      )
    );

    const settings = S.state.show?.settings || {};
    const settingsPanel = h('.panel', null,
      h('h3', null, 'Émission'),
      h('.row', null,
        h('label.field', { style: { flex: '1 1 180px' } }, 'Fréquence de rafraîchissement (Hz)',
          h('input', {
            type: 'number', min: '1', max: '60', value: String(settings.refreshRate ?? 30),
            onchange: (ev) => send('settings:save', { refreshRate: Number(ev.target.value) })
          })),
        h('label.field', { style: { flex: '1 1 200px' } }, 'Adresse de broadcast',
          h('input', {
            type: 'text', value: settings.broadcastAddress || '255.255.255.255',
            onchange: (ev) => send('settings:save', { broadcastAddress: ev.target.value })
          })),
        h('label.inline', { style: { marginTop: '18px' } },
          h('input', {
            type: 'checkbox', checked: settings.discovery !== false,
            onchange: (ev) => send('settings:save', { discovery: ev.target.checked })
          }), 'Découverte ArtPoll automatique')
      ),
      h('p.muted', { style: { marginTop: '8px' } },
        'L’émission est continue (keep-alive) même sans action : les nodes conservent leur signal. ' +
        'Certains réseaux préfèrent 2.255.255.255 ou 10.255.255.255 comme adresse de broadcast.')
    );

    const pinSet = !!S.state.status?.adminPinSet;
    const accessPanel = h('.panel', null,
      h('h3', null, 'Accès à la régie'),
      h('.row', null,
        h('span', { style: { flex: '1 1 240px' } },
          h('b', { style: { color: pinSet ? 'var(--accent-2)' : 'var(--warn)' } },
            pinSet ? 'Code défini' : 'Aucun code'),
          h('.muted', null, pinSet
            ? 'Le mode Régie demande le code ; le mode Live reste libre d’accès.'
            : 'Tout le monde peut programmer. Définissez un code pour verrouiller la régie.')),
        h('button.btn', {
          type: 'button',
          onclick: async () => {
            const pin = await askPin({
              title: pinSet ? 'Nouveau code' : 'Définir un code',
              hint: 'Chiffres uniquement. Notez-le : il n’est pas récupérable depuis l’interface.'
            });
            if (pin === null) return;
            if (pin.length < 4) return toast('Choisissez au moins 4 chiffres', 4000);
            send('settings:save', { adminPin: pin });
            toast('Code enregistré');
          }
        }, pinSet ? 'Changer le code' : 'Définir un code'),
        pinSet
          ? h('button.btn.danger', {
              type: 'button',
              onclick: () => {
                if (!confirm('Retirer le code ? La régie redeviendra accessible à tous.')) return;
                send('settings:save', { adminPin: '' });
                toast('Code retiré');
              }
            }, 'Retirer')
          : null
      ),
      h('p.muted', { style: { marginTop: '8px' } },
        'Garde-fou contre les fausses manœuvres en exploitation, pas une sécurité réseau : ' +
        'la liaison n’est pas chiffrée, réservez l’application à un réseau technique de confiance.')
    );

    const st = S.state.status;
    const artnet = st?.artnet || {};
    const age = artnet.lastSendAt ? Math.round((Date.now() - artnet.lastSendAt) / 100) / 10 : null;
    const statusPanel = h('.panel', null,
      h('h3', null, 'État'),
      h('.row', null,
        badge('Socket UDP', artnet.ready ? 'ouverte' : 'fermée', artnet.ready),
        badge('Réception ArtPollReply', artnet.discovery ? 'port 6454 ouvert' : 'indisponible (port 6454 occupé)', artnet.discovery),
        badge('Paquets envoyés', String(artnet.packetsSent ?? 0), true),
        badge('Dernier envoi', age === null ? '—' : `il y a ${age.toFixed(1)} s`, age !== null && age < 1),
        badge('Clients connectés', String(st?.clients ?? 1), true)
      ),
      artnet.lastError ? h('p.warn-text', { style: { marginTop: '8px' } }, `Dernière erreur : ${artnet.lastError}`) : null
    );

    const nodes = st?.nodes || [];
    const nodesPanel = h('.panel', null,
      h('h3', null, `Nodes détectés (${nodes.length})`),
      nodes.length
        ? h('table.patch', null,
            h('thead', null, h('tr', null,
              h('th', null, 'IP'), h('th', null, 'Nom'), h('th', null, 'Description'),
              h('th', null, 'Sorties'), h('th', null, '')
            )),
            h('tbody', null, nodes.map((n) => h('tr', null,
              h('td', null, n.ip),
              h('td', null, n.shortName || '—'),
              h('td.muted', null, n.longName || n.nodeReport || '—'),
              h('td.muted', null, n.outputs?.length ? n.outputs.map((a) => `0x${a.toString(16)}`).join(' ') : '—'),
              h('td', null, h('button.btn.small', {
                type: 'button',
                onclick: () => {
                  // Bascule tous les univers en unicast vers ce node.
                  const list = collect(rows).map((u) => ({ ...u, mode: 'unicast', target: n.ip }));
                  send('universes:save', list);
                  toast(`Sortie unicast vers ${n.ip}`);
                }
              }, 'Cibler'))
            )))
          )
        : h('p.muted', null, 'Aucun node n’a répondu à l’ArtPoll. Vérifiez le réseau, ou pilotez en broadcast : ' +
            'la plupart des nodes reçoivent le DMX même sans répondre à la découverte.'),
      h('.row', { style: { marginTop: '10px' } },
        h('button.btn', { type: 'button', onclick: () => { send('artnet:poll'); toast('ArtPoll envoyé'); } }, 'Rechercher des nodes'))
    );

    mount(container, statusPanel, accessPanel, universesPanel, settingsPanel, nodesPanel);
  }

  function badge(label, value, ok) {
    return h('div', {
      style: {
        flex: '1 1 150px', background: 'var(--panel-2)', border: '1px solid var(--line)',
        borderRadius: '12px', padding: '10px'
      }
    },
      h('.muted', null, label),
      h('b', { style: { color: ok ? 'var(--accent-2)' : 'var(--warn)' } }, value)
    );
  }

  draw();
  unsubs.push(S.on('show', draw));
  // L'état est rafraîchi une fois par seconde par le serveur ; on redessine
  // seulement ce panneau-là pour ne pas perturber la saisie en cours.
  unsubs.push(S.on('status', () => {
    if (!document.activeElement || document.activeElement.tagName !== 'INPUT') draw();
  }));

  return () => unsubs.forEach((u) => u());
}
