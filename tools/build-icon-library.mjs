import fs from 'node:fs';
import path from 'node:path';

const TABLER_DIR = '/tmp/assets-dl/tabler/package/icons/outline';
const HEALTH_DIR = '/tmp/assets-dl/health/package/public/icons/svg/outline';
const OUT_FILE = path.resolve('assets/icons/library.json');

function extractSvgInner(svgText) {
  const vbMatch = svgText.match(/viewBox="([^"]+)"/);
  const viewBox = vbMatch ? vbMatch[1] : '0 0 24 24';
  const inner = svgText
    .replace(/^[\s\S]*?<svg[^>]*>/i, '')
    .replace(/<\/svg>\s*$/i, '')
    .replace(/<path[^>]*d="M0 0h24v24H0z"[^>]*\/?>/gi, '')
    .trim();
  return { viewBox, body: inner };
}

const HEALTH_PICKS = [
  { file: 'body/body.svg', id: 'body', tags: ['human', 'person', 'torso', 'anatomy', 'silhouette'] },
  { file: 'body/skeleton.svg', id: 'skeleton', tags: ['bones', 'frame', 'xray', 'anatomy'] },
  { file: 'body/bone.svg', id: 'bone', tags: ['calcium', 'fracture', 'skeleton', 'xray', 'orthopedic'] },
  { file: 'body/bone-long.svg', id: 'bone-long', tags: ['femur', 'arm-bone', 'fracture', 'calcium'] },
  { file: 'body/skull.svg', id: 'skull', tags: ['head', 'cranium', 'brain-case', 'bone'] },
  { file: 'body/spine.svg', id: 'spine', tags: ['vertebrae', 'back', 'nervous', 'posture'] },
  { file: 'body/joints.svg', id: 'joints', tags: ['knee', 'elbow', 'cartilage', 'flex'] },
  { file: 'body/heart-organ.svg', id: 'heart-organ', tags: ['heart', 'cardiac', 'pulse', 'blood', 'pump', 'chest'] },
  { file: 'body/lungs.svg', id: 'lungs', tags: ['breathing', 'oxygen', 'respiration', 'air', 'chest'] },
  { file: 'body/neurology.svg', id: 'neurology', tags: ['brain', 'mind', 'cognition', 'memory', 'neuron'] },
  { file: 'body/nerve.svg', id: 'nerve', tags: ['neuron', 'synapse', 'signal', 'impulse', 'axon'] },
  { file: 'body/stomach.svg', id: 'stomach', tags: ['digestion', 'acid', 'gut', 'food'] },
  { file: 'body/intestine.svg', id: 'intestine', tags: ['gut', 'digestion', 'microbiome', 'bowel'] },
  { file: 'body/kidneys.svg', id: 'kidneys', tags: ['renal', 'filter', 'water', 'urine'] },
  { file: 'body/liver.svg', id: 'liver', tags: ['metabolism', 'detox', 'organ', 'bile'] },
  { file: 'body/eye.svg', id: 'eye', tags: ['vision', 'sight', 'retina', 'optic', 'pupil', 'light'] },
  { file: 'body/ear.svg', id: 'ear', tags: ['hearing', 'sound', 'cochlea', 'vibration', 'wave'] },
  { file: 'body/tooth.svg', id: 'tooth', tags: ['enamel', 'calcium', 'mouth', 'dental'] },
  { file: 'body/dna.svg', id: 'dna', tags: ['gene', 'helix', 'chromosome', 'genetics', 'rna'] },
  { file: 'body/cell-nuclei.svg', id: 'cell', tags: ['cell', 'nucleus', 'biology', 'micro', 'membrane'] },
  { file: 'body/blood-cells.svg', id: 'blood-cells', tags: ['rbc', 'oxygen', 'hemoglobin', 'plasma'] },
  { file: 'body/blood-drop.svg', id: 'blood-drop', tags: ['blood', 'drop', 'glucose', 'circulation'] },
  { file: 'body/blood-vessel.svg', id: 'blood-vessel', tags: ['artery', 'vein', 'capillary', 'flow'] },
  { file: 'body/bacteria.svg', id: 'bacteria', tags: ['germ', 'microbe', 'pathogen', 'microbiome'] },
  { file: 'body/antibody.svg', id: 'antibody', tags: ['immune', 'defense', 'white-blood', 'protein'] },
  { file: 'body/arm.svg', id: 'arm', tags: ['muscle', 'bicep', 'hand', 'limb'] },
  { file: 'body/head.svg', id: 'head', tags: ['face', 'profile', 'mind', 'human'] },
  { file: 'diagnostics/x-ray.svg', id: 'xray-scan', tags: ['radiology', 'radiation', 'scan', 'imaging'] },
  { file: 'diagnostics/microscope.svg', id: 'health-microscope', tags: ['lab', 'zoom', 'magnify', 'research'] },
  { file: 'devices/stethoscope.svg', id: 'doctor', tags: ['stethoscope', 'physician', 'clinic', 'checkup'] }
];

const TABLER_PICKS = [
  { file: 'atom.svg', id: 'atom', tags: ['electron', 'proton', 'nucleus', 'physics', 'quantum', 'orbit'] },
  { file: 'bolt.svg', id: 'lightning', tags: ['electricity', 'volt', 'charge', 'spark', 'energy', 'power'] },
  { file: 'bulb.svg', id: 'bulb', tags: ['light', 'idea', 'photon', 'lamp', 'glow'] },
  { file: 'sun.svg', id: 'sun', tags: ['star', 'solar', 'uv', 'heat', 'radiation', 'day'] },
  { file: 'moon.svg', id: 'moon', tags: ['night', 'sleep', 'circadian', 'lunar', 'gravity'] },
  { file: 'planet.svg', id: 'planet', tags: ['space', 'orbit', 'gravity', 'earth', 'astronomy'] },
  { file: 'rocket.svg', id: 'rocket', tags: ['launch', 'thrust', 'speed', 'space'] },
  { file: 'magnet.svg', id: 'magnet', tags: ['magnetic', 'field', 'pole', 'force', 'attract'] },
  { file: 'microscope.svg', id: 'microscope', tags: ['zoom', 'micro', 'lens', 'lab', 'science'] },
  { file: 'telescope.svg', id: 'telescope', tags: ['space', 'macro', 'star', 'lens', 'observe'] },
  { file: 'flask.svg', id: 'flask', tags: ['chemistry', 'reaction', 'acid', 'solution', 'lab'] },
  { file: 'test-pipe.svg', id: 'test-pipe', tags: ['sample', 'experiment', 'chemical', 'tube'] },
  { file: 'flame.svg', id: 'fire', tags: ['heat', 'thermal', 'burn', 'calorie', 'temperature'] },
  { file: 'thermometer.svg', id: 'thermometer', tags: ['temperature', 'fever', 'heat', 'celsius'] },
  { file: 'snowflake.svg', id: 'ice', tags: ['cold', 'freeze', 'crystal', 'winter', 'cooling'] },
  { file: 'droplet.svg', id: 'water', tags: ['liquid', 'drop', 'h2o', 'rain', 'fluid'] },
  { file: 'wind.svg', id: 'wind', tags: ['air', 'airflow', 'breeze', 'pressure', 'gas'] },
  { file: 'cloud.svg', id: 'cloud', tags: ['vapor', 'weather', 'atmosphere', 'sky'] },
  { file: 'wave-sine.svg', id: 'wave', tags: ['frequency', 'wavelength', 'signal', 'oscillation', 'spectrum'] },
  { file: 'activity-heartbeat.svg', id: 'pulse', tags: ['ecg', 'heartbeat', 'rhythm', 'vital'] },
  { file: 'battery-charging.svg', id: 'battery', tags: ['energy', 'charge', 'atp', 'power', 'store'] },
  { file: 'cpu.svg', id: 'chip', tags: ['processor', 'computer', 'circuit', 'silicon', 'ai'] },
  { file: 'radar.svg', id: 'radar', tags: ['scan', 'echo', 'sonar', 'detect', 'wave'] },
  { file: 'wifi.svg', id: 'signal', tags: ['wireless', 'radio', 'frequency', 'emission'] },
  { file: 'clock.svg', id: 'clock', tags: ['time', 'hour', 'minute', 'duration', 'schedule'] },
  { file: 'hourglass.svg', id: 'hourglass', tags: ['time', 'aging', 'wait', 'decay'] },
  { file: 'scale.svg', id: 'scale', tags: ['balance', 'weight', 'mass', 'compare', 'equilibrium'] },
  { file: 'shield.svg', id: 'shield', tags: ['protect', 'immune', 'barrier', 'defense', 'safety'] },
  { file: 'lock.svg', id: 'lock', tags: ['receptor', 'block', 'secure', 'gate'] },
  { file: 'key.svg', id: 'key', tags: ['enzyme', 'unlock', 'trigger', 'hormone'] },
  { file: 'leaf.svg', id: 'leaf', tags: ['plant', 'photosynthesis', 'chlorophyll', 'nature'] },
  { file: 'virus.svg', id: 'virus', tags: ['pathogen', 'infection', 'spike', 'microbe'] },
  { file: 'camera.svg', id: 'camera', tags: ['photo', 'sensor', 'film', 'capture', 'image'] },
  { file: 'speakerphone.svg', id: 'speaker', tags: ['sound', 'audio', 'voice', 'decibel'] },
  { file: 'gauge.svg', id: 'gauge', tags: ['meter', 'pressure', 'speed', 'level', 'measure'] },
  { file: 'compass.svg', id: 'compass', tags: ['direction', 'north', 'navigation', 'magnetic'] },
  { file: 'hand-stop.svg', id: 'hand', tags: ['hand', 'palm', 'touch', 'block', 'stop'] },
  { file: 'prism.svg', id: 'prism', tags: ['refraction', 'spectrum', 'rainbow', 'optics', 'light'] },
  { file: 'layers-intersect.svg', id: 'layers', tags: ['tissue', 'strata', 'stack', 'membrane'] },
  { file: 'arrows-exchange.svg', id: 'exchange', tags: ['swap', 'cycle', 'transfer', 'osmosis'] },
  { file: 'refresh.svg', id: 'cycle', tags: ['loop', 'repeat', 'metabolism', 'circulation'] },
  { file: 'chart-line.svg', id: 'chart', tags: ['graph', 'data', 'trend', 'curve'] },
  { file: 'search.svg', id: 'magnifier', tags: ['zoom', 'inspect', 'find', 'focus'] },
  { file: 'alert-triangle.svg', id: 'warning', tags: ['danger', 'caution', 'alert', 'risk'] },
  { file: 'check.svg', id: 'check', tags: ['correct', 'fact', 'verified', 'yes'] },
  { file: 'x.svg', id: 'cross', tags: ['wrong', 'myth', 'false', 'block'] },
  { file: 'question-mark.svg', id: 'question', tags: ['why', 'mystery', 'curiosity', 'ask'] },
  { file: 'sparkles.svg', id: 'spark', tags: ['reaction', 'flash', 'glow', 'clean'] },
  { file: 'world.svg', id: 'earth', tags: ['globe', 'world', 'planet', 'environment'] },
  { file: 'coffee.svg', id: 'coffee', tags: ['caffeine', 'cup', 'morning', 'stimulant'] },
  { file: 'apple.svg', id: 'food', tags: ['fruit', 'nutrition', 'sugar', 'glucose'] }
];

// Hand-drawn custom scientific / everyday-analogy SVG icons (48x48 stroke art)
const HAND_DRAWN = [
  {
    id: 'flashlight',
    tags: ['torch', 'beam', 'lamp', 'shadow', 'light-source'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<path d="M8 18h14l6-5v22l-6-5H8a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z"/><path d="M13 18v12"/><path d="M33 17l9-4"/><path d="M33 24h11"/><path d="M33 31l9 4"/>`
  },
  {
    id: 'shadow',
    tags: ['silhouette', 'shade', 'projection', 'block', 'wall'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<circle cx="17" cy="24" r="8"/><path d="M27 14l14-4v28l-14-4"/><path d="M31 18v12" opacity="0.5"/><path d="M36 16v16" opacity="0.35"/>`
  },
  {
    id: 'xray-beam',
    tags: ['xray', 'rays', 'radiation', 'penetrate', 'wave-beam'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<path d="M6 14c3-3 6 3 9 0s6 3 9 0"/><path d="M6 24c3-3 6 3 9 0s6 3 9 0"/><path d="M6 34c3-3 6 3 9 0s6 3 9 0"/><rect x="28" y="10" width="14" height="28" rx="3"/><path d="M35 16v16"/><path d="M31 20h8"/><path d="M31 28h8"/>`
  },
  {
    id: 'electron',
    tags: ['electron', 'particle', 'charge', 'cathode', 'minus'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="4"/><path d="M20 24h8"/><circle cx="38" cy="14" r="2.5"/>`
  },
  {
    id: 'photon',
    tags: ['photon', 'quantum', 'light-packet', 'gamma', 'em-wave'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<path d="M6 24c3-8 6 8 9 0s6 8 9 0 6 8 9 0"/><path d="M33 24h9"/><path d="M37 19l5 5-5 5"/>`
  },
  {
    id: 'calcium-crystal',
    tags: ['calcium', 'mineral', 'crystal', 'dense', 'lattice'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<polygon points="24,6 39,15 39,33 24,42 9,33 9,15"/><path d="M24 6v36"/><path d="M9 15l30 18"/><path d="M39 15L9 33"/>`
  },
  {
    id: 'bone-fracture',
    tags: ['fracture', 'crack', 'broken-bone', 'break'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<path d="M16 7c-3 0-5 2-5 5 0 1 .4 2 1 3-2 1-3 2.5-3 4.5 0 2.5 2 4.5 4.5 4.5H19v13c0 2.5 2 4.5 4.5 4.5 1.5 0 3-.8 3.8-2 .8 1.2 2.2 2 3.7 2 2.5 0 4.5-2 4.5-4.5 0-2-1.2-3.6-3-4.3.6-.8 1-1.8 1-2.9 0-2.4-2-4.3-4.3-4.3H28V12c0-2.8-2.2-5-5-5-1.3 0-2.5.5-3.4 1.4C18.6 7.5 17.4 7 16 7z"/><path d="M19 23l5 3-3 4 6 3"/>`
  },
  {
    id: 'film-plate',
    tags: ['film', 'detector', 'plate', 'radiograph', 'screen'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<rect x="10" y="7" width="28" height="34" rx="3"/><rect x="15" y="13" width="18" height="22" rx="1.5"/><path d="M24 17v14"/><path d="M19 22h10"/>`
  },
  {
    id: 'molecule',
    tags: ['molecule', 'compound', 'bond', 'chemical', 'structure'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<circle cx="24" cy="14" r="5"/><circle cx="13" cy="33" r="5"/><circle cx="35" cy="33" r="5"/><path d="M21 18l-5 11"/><path d="M27 18l5 11"/><path d="M18 33h12"/>`
  },
  {
    id: 'human-silhouette',
    tags: ['human', 'person', 'body-outline', 'patient'],
    viewBox: '0 0 48 48',
    mode: 'stroke',
    body: `<circle cx="24" cy="10" r="5"/><path d="M14 23c0-4 4-6 10-6s10 2 10 6v10h-4v10H18V33h-4V23z"/>`
  }
];

const library = {
  version: 1,
  licenses: {
    'hand-drawn': { name: 'Reel Studio Hand-Drawn Technical Set', license: 'CC0-1.0' },
    'healthicons': { name: 'Health Icons', license: 'CC0-1.0', url: 'https://healthicons.org/' },
    'tabler': { name: 'Tabler Icons', license: 'MIT', url: 'https://tabler.io/icons' }
  },
  icons: {}
};

for (const h of HAND_DRAWN) {
  library.icons[h.id] = {
    id: h.id,
    source: 'hand-drawn',
    license: 'CC0-1.0',
    viewBox: h.viewBox,
    mode: h.mode,
    tags: h.tags,
    body: h.body
  };
}

for (const item of HEALTH_PICKS) {
  const full = path.join(HEALTH_DIR, item.file);
  if (!fs.existsSync(full)) {
    console.warn('Missing health icon:', item.file);
    continue;
  }
  const { viewBox, body } = extractSvgInner(fs.readFileSync(full, 'utf8'));
  library.icons[item.id] = {
    id: item.id,
    source: 'healthicons',
    license: 'CC0-1.0',
    viewBox,
    mode: 'fill',
    tags: item.tags,
    body
  };
}

for (const item of TABLER_PICKS) {
  const full = path.join(TABLER_DIR, item.file);
  if (!fs.existsSync(full)) {
    console.warn('Missing tabler icon:', item.file);
    continue;
  }
  const { viewBox, body } = extractSvgInner(fs.readFileSync(full, 'utf8'));
  library.icons[item.id] = {
    id: item.id,
    source: 'tabler',
    license: 'MIT',
    viewBox,
    mode: 'stroke',
    tags: item.tags,
    body
  };
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(library, null, 2));
console.log(`Compiled ${Object.keys(library.icons).length} icons into ${OUT_FILE}`);
