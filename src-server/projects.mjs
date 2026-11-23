import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './env.mjs';

export const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
export const STAGES = ['script', 'voice', 'timing', 'storyboard', 'render'];

const sseClients = new Map(); // projectId -> Set<ServerResponse>

export function ensureProjectsDir() {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

export function getProjectDir(projectId) {
  const safe = String(projectId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(PROJECTS_DIR, safe);
}

function defaultStageState(approvalMode = 'auto') {
  return {
    status: 'idle', // idle | running | review | done | error
    mode: approvalMode, // auto | approval
    error: null,
    startedAt: null,
    finishedAt: null,
    logs: []
  };
}

export function createProject({
  topic,
  durationSec = 10,
  voiceId = '',
  voiceMode = 'tts',
  approvals = {}
}) {
  ensureProjectsDir();
  const id = `reel_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const dir = getProjectDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const project = {
    id,
    topic: String(topic || '').trim(),
    title: '',
    durationSec: Number(durationSec) || 10,
    voiceMode: voiceMode === 'upload' ? 'upload' : 'tts',
    voiceId: voiceId || '',
    sources: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    activeStage: null,
    stages: {
      script: defaultStageState(approvals.script || 'approval'),
      voice: defaultStageState(approvals.voice || 'auto'),
      timing: defaultStageState(approvals.timing || 'auto'),
      storyboard: defaultStageState(approvals.storyboard || 'auto'),
      render: defaultStageState(approvals.render || 'auto')
    },
    artifacts: {
      scriptText: '',
      streamText: '',
      audioDuration: 0,
      hasAudio: false,
      wordCount: 0,
      weakWordCount: 0,
      sceneCount: 0,
      hasVideo: false,
      hasContactSheet: false
    }
  };

  saveProject(project);
  return project;
}

export function listProjects() {
  ensureProjectsDir();
  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  const list = [];
  for (const d of dirs) {
    const p = loadProject(d.name);
    if (p) list.push(p);
  }
  return list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function loadProject(projectId) {
  const file = path.join(getProjectDir(projectId), 'project.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveProject(project) {
  const dir = getProjectDir(project.id);
  fs.mkdirSync(dir, { recursive: true });
  project.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  broadcastSSE(project.id, 'state', project);
  return project;
}

export function deleteProject(projectId) {
  const dir = getProjectDir(projectId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

export function appendStageLog(projectId, stage, message) {
  const project = loadProject(projectId);
  if (!project || !project.stages[stage]) return;
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  project.stages[stage].logs.push(`[${ts}] ${message}`);
  if (project.stages[stage].logs.length > 150) {
    project.stages[stage].logs = project.stages[stage].logs.slice(-150);
  }
  saveProject(project);
}

export function writeProjectArtifact(projectId, filename, data) {
  const dir = getProjectDir(projectId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, filename);
  if (typeof data === 'string' || Buffer.isBuffer(data)) {
    fs.writeFileSync(target, data);
  } else {
    fs.writeFileSync(target, JSON.stringify(data, null, 2));
  }
  return target;
}

export function readProjectArtifact(projectId, filename, parseJson = true) {
  const target = path.join(getProjectDir(projectId), filename);
  if (!fs.existsSync(target)) return null;
  const raw = fs.readFileSync(target, 'utf8');
  if (!parseJson) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function addSSEClient(projectId, res) {
  if (!sseClients.has(projectId)) {
    sseClients.set(projectId, new Set());
  }
  sseClients.get(projectId).add(res);
  res.on('close', () => {
    const set = sseClients.get(projectId);
    if (set) {
      set.delete(res);
      if (set.size === 0) sseClients.delete(projectId);
    }
  });
}

export function broadcastSSE(projectId, eventName, payload) {
  const set = sseClients.get(projectId);
  if (!set || set.size === 0) return;
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const frame = `event: ${eventName}\ndata: ${data}\n\n`;
  for (const res of set) {
    try {
      res.write(frame);
    } catch {
      set.delete(res);
    }
  }
}
