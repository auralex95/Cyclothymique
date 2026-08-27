/**
 * Validation et normalisation des profils de fixtures créés depuis l'interface.
 *
 * Un profil venant du réseau n'est jamais écrit tel quel sur le disque : on
 * vérifie chaque champ, on borne les valeurs et on assainit l'identifiant
 * (il sert de nom de fichier).
 */

import { ATTRIBUTES, attrMeta } from '../shared/attributes.js';

/** Attributs qui acceptent un canal "fine" (16 bits) : tout sauf les roues. */
export function supportsFine(attr) {
  const ui = attrMeta(attr).ui;
  return ui === 'fader' || ui === 'pad';
}

/** Transforme un nom en identifiant de fichier sûr : minuscules, tirets. */
export function slugify(text) {
  return String(text || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // retire les accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Valide et normalise un profil.
 * @returns {{ profile: Object|null, errors: string[] }}
 */
export function validateProfile(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { profile: null, errors: ['Profil illisible'] };

  const name = String(input.name || '').trim();
  if (!name) errors.push('Le nom est obligatoire');
  if (name.length > 80) errors.push('Le nom est trop long (80 caractères maximum)');

  const id = slugify(input.id || name);
  if (!id) errors.push('Identifiant invalide : le nom doit contenir au moins un caractère alphanumérique');

  const channelCount = Math.round(Number(input.channelCount) || 0);
  if (!(channelCount >= 1 && channelCount <= 512)) errors.push('Le nombre de canaux doit être compris entre 1 et 512');

  // --- canaux -------------------------------------------------------------
  const channels = {};
  const used = new Map();   // numéro de canal -> libellé, pour détecter les doublons
  const rawChannels = input.channels && typeof input.channels === 'object' ? input.channels : {};

  if (!Object.keys(rawChannels).length) errors.push('Aucune fonction n’est assignée à un canal');

  for (const [attr, def] of Object.entries(rawChannels)) {
    if (!ATTRIBUTES[attr]) { errors.push(`Fonction inconnue : ${attr}`); continue; }
    if (!def || typeof def !== 'object') { errors.push(`Définition invalide pour ${attr}`); continue; }

    const channel = Math.round(Number(def.channel));
    if (!(channel >= 1 && channel <= channelCount)) {
      errors.push(`${attrMeta(attr).label} : canal ${def.channel} hors de la fixture (1…${channelCount})`);
      continue;
    }
    if (used.has(channel)) errors.push(`Canal ${channel} utilisé deux fois (${used.get(channel)} et ${attrMeta(attr).label})`);
    used.set(channel, attrMeta(attr).label);

    const entry = { channel };

    if (def.fine !== undefined && def.fine !== null && def.fine !== '') {
      const fine = Math.round(Number(def.fine));
      if (!supportsFine(attr)) {
        errors.push(`${attrMeta(attr).label} n’accepte pas de canal fin`);
      } else if (!(fine >= 1 && fine <= channelCount)) {
        errors.push(`${attrMeta(attr).label} (fin) : canal ${def.fine} hors de la fixture`);
      } else if (fine === channel) {
        errors.push(`${attrMeta(attr).label} : le canal fin doit différer du canal principal`);
      } else {
        if (used.has(fine)) errors.push(`Canal ${fine} utilisé deux fois (${used.get(fine)} et ${attrMeta(attr).label} fin)`);
        used.set(fine, `${attrMeta(attr).label} fin`);
        entry.fine = fine;
      }
    }

    if (def.default !== undefined && def.default !== null && def.default !== '') {
      const value = Number(def.default);
      if (!(value >= 0 && value <= 1)) errors.push(`${attrMeta(attr).label} : la valeur par défaut doit être comprise entre 0 et 1`);
      else entry.default = Math.round(value * 1000) / 1000;
    }

    channels[attr] = entry;
  }

  // --- roues (slots) ------------------------------------------------------
  const wheels = {};
  const rawWheels = input.wheels && typeof input.wheels === 'object' ? input.wheels : {};
  for (const [attr, slots] of Object.entries(rawWheels)) {
    if (!Array.isArray(slots) || !slots.length) continue;
    if (!channels[attr]) { errors.push(`Roue « ${attrMeta(attr).label} » : aucun canal ne porte cette fonction`); continue; }
    const clean = [];
    for (const slot of slots) {
      const slotName = String(slot?.name || '').trim();
      const value = Math.round(Number(slot?.value));
      if (!slotName) { errors.push(`Roue « ${attrMeta(attr).label} » : un slot n’a pas de nom`); continue; }
      if (!(value >= 0 && value <= 255)) { errors.push(`Roue « ${attrMeta(attr).label} » : la valeur de « ${slotName} » doit être comprise entre 0 et 255`); continue; }
      clean.push({ name: slotName.slice(0, 40), value });
    }
    if (clean.length) wheels[attr] = clean;
  }

  if (errors.length) return { profile: null, errors };

  const profile = {
    id,
    name,
    shortName: String(input.shortName || '').trim().slice(0, 30) || name.slice(0, 30),
    manufacturer: String(input.manufacturer || '').trim().slice(0, 60) || 'Personnalisé',
    model: String(input.model || '').trim().slice(0, 60) || name,
    channelCount,
    notes: String(input.notes || '').trim().slice(0, 300),
    channels
  };
  if (Object.keys(wheels).length) profile.wheels = wheels;
  return { profile, errors: [] };
}
