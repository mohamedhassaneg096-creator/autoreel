import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from './env.mjs';

const LIBRARY_PATH = path.join(ROOT_DIR, 'assets', 'icons', 'library.json');

let cachedLibrary = null;

export function loadIconLibrary() {
  if (!cachedLibrary) {
    cachedLibrary = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
  }
  return cachedLibrary;
}

export function listAvailableIconNames() {
  const lib = loadIconLibrary();
  return Object.keys(lib.icons);
}

const SYNONYMS = {
  xray: 'xray-beam',
  'x-ray': 'xray-beam',
  xrays: 'xray-beam',
  radiology: 'xray-scan',
  torch: 'flashlight',
  lamp: 'bulb',
  light: 'bulb',
  beam: 'flashlight',
  rays: 'xray-beam',
  shade: 'shadow',
  wall: 'shadow',
  hand: 'hand',
  palm: 'hand',
  flesh: 'arm',
  muscle: 'arm',
  skin: 'body',
  human: 'human-silhouette',
  person: 'human-silhouette',
  skeleton: 'skeleton',
  bones: 'bone',
  fracture: 'bone-fracture',
  crack: 'bone-fracture',
  calcium: 'calcium-crystal',
  mineral: 'calcium-crystal',
  crystal: 'calcium-crystal',
  film: 'film-plate',
  plate: 'film-plate',
  photo: 'camera',
  image: 'camera',
  picture: 'camera',
  heart: 'heart-organ',
  cardiac: 'heart-organ',
  brain: 'neurology',
  neuron: 'nerve',
  nerve: 'nerve',
  lung: 'lungs',
  lungs: 'lungs',
  breath: 'lungs',
  kidney: 'kidneys',
  blood: 'blood-drop',
  vessel: 'blood-vessel',
  artery: 'blood-vessel',
  vein: 'blood-vessel',
  germ: 'bacteria',
  microbe: 'bacteria',
  immune: 'antibody',
  electric: 'lightning',
  electricity: 'lightning',
  volt: 'lightning',
  voltage: 'lightning',
  energy: 'battery',
  heat: 'fire',
  temperature: 'thermometer',
  cold: 'ice',
  freeze: 'ice',
  drop: 'water',
  liquid: 'water',
  air: 'wind',
  sound: 'speaker',
  hearing: 'ear',
  vision: 'eye',
  sight: 'eye',
  zoom: 'magnifier',
  lens: 'magnifier',
  lab: 'flask',
  chemistry: 'flask',
  time: 'clock',
  measure: 'gauge',
  pressure: 'gauge',
  compare: 'scale',
  balance: 'scale',
  protect: 'shield',
  defense: 'shield',
  truth: 'check',
  fact: 'check',
  myth: 'cross',
  false: 'cross',
  why: 'question',
  spectrum: 'prism',
  oscillation: 'wave',
  frequency: 'wave',
  space: 'planet',
  world: 'earth',
  globe: 'earth',
  food: 'food',
  glucose: 'food',
  sugar: 'food',
  caffeine: 'coffee',
  cup: 'coffee'
};

export function resolveIconName(noun) {
  const lib = loadIconLibrary();
  const icons = lib.icons;
  if (!noun || typeof noun !== 'string') return 'atom';

  const clean = noun.toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '');
  if (!clean) return 'atom';

  if (icons[clean]) return clean;
  if (SYNONYMS[clean] && icons[SYNONYMS[clean]]) return SYNONYMS[clean];

  // Try individual words
  const parts = clean.split('-').filter(Boolean);
  for (const part of parts) {
    if (icons[part]) return part;
    if (SYNONYMS[part] && icons[SYNONYMS[part]]) return SYNONYMS[part];
  }

  // Score against icon ids and tags
  let bestId = 'atom';
  let bestScore = 0;
  for (const [id, icon] of Object.entries(icons)) {
    let score = 0;
    if (id.includes(clean) || clean.includes(id)) score += 3;
    for (const tag of icon.tags || []) {
      if (tag === clean) score += 5;
      else if (parts.includes(tag)) score += 3;
      else if (tag.includes(clean) || clean.includes(tag)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = id;
    }
  }
  return bestId;
}

export function collectProjectIcons(storyboard) {
  const lib = loadIconLibrary();
  const usedIds = new Set();

  const addNoun = (noun) => {
    const resolved = resolveIconName(noun);
    usedIds.add(resolved);
    return resolved;
  };

  for (const scene of storyboard.scenes || []) {
    if (scene.template === 'body') {
      addNoun('body');
    }
    if (scene.icon) scene.resolvedIcon = addNoun(scene.icon);
    if (scene.secondaryIcon) scene.resolvedSecondaryIcon = addNoun(scene.secondaryIcon);
    if (scene.organ) scene.resolvedOrgan = addNoun(scene.organ);
    if (Array.isArray(scene.steps)) {
      for (const st of scene.steps) {
        if (st && st.icon) st.resolvedIcon = addNoun(st.icon);
      }
    }
    if (Array.isArray(scene.items)) {
      for (const it of scene.items) {
        if (it && it.icon) it.resolvedIcon = addNoun(it.icon);
      }
    }
    if (Array.isArray(scene.layers)) {
      for (const ly of scene.layers) {
        if (ly && ly.icon) ly.resolvedIcon = addNoun(ly.icon);
      }
    }
    if (scene.left && scene.left.icon) scene.left.resolvedIcon = addNoun(scene.left.icon);
    if (scene.right && scene.right.icon) scene.right.resolvedIcon = addNoun(scene.right.icon);
    if (scene.macro && scene.macro.icon) scene.macro.resolvedIcon = addNoun(scene.macro.icon);
    if (scene.micro && scene.micro.icon) scene.micro.resolvedIcon = addNoun(scene.micro.icon);
  }

  // Always include a minimal fallback if empty
  if (usedIds.size === 0) usedIds.add('atom');

  const bundle = {};
  for (const id of usedIds) {
    if (lib.icons[id]) {
      bundle[id] = lib.icons[id];
    }
  }
  return bundle;
}
