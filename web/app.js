const STAGE_ORDER = ['script', 'voice', 'timing', 'storyboard', 'render'];
const STAGE_LABELS = {
  script: '١. السكريبت',
  voice: '٢. الصوت',
  timing: '٣. التوقيت',
  storyboard: '٤. الستوري بورد',
  render: '٥. الريندر'
};

const STATUS_LABELS = {
  idle: 'خامل',
  running: 'جاري التنفيذ...',
  review: 'بانتظار الموافقة',
  done: 'مكتمل',
  error: 'خطأ'
};

const state = {
  view: 'workspace',
  projects: [],
  activeProjectId: null,
  projectData: null, // { project, scriptText, alignedWords, storyboard, icons }
  selectedStage: 'script',
  streamBuffer: '',
  sse: null,
  selectedDuration: 10,
  selectedVoiceMode: 'tts',
  voices: [],
  iconsCatalog: [],
  clearFlags: { llm: false, el: false, dg: false }
};

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Navigation
function switchView(viewName) {
  state.view = viewName;
  document.querySelectorAll('.nav-link').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('active', el.id === `view-${viewName}`);
  });
  if (viewName === 'settings') loadSettings();
  if (viewName === 'icons') loadIconsCatalog();
}

document.querySelectorAll('.nav-link').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});
document.getElementById('brand-link').addEventListener('click', (e) => {
  e.preventDefault();
  switchView('workspace');
});
document.getElementById('btn-new-project-focus').addEventListener('click', () => {
  switchView('workspace');
  document.getElementById('input-topic').focus();
});

// Segmented controls for New Project
document.querySelectorAll('#duration-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.selectedDuration = Number(btn.dataset.dur);
    document.querySelectorAll('#duration-group .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
  });
});

document.querySelectorAll('#voicemode-group .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.selectedVoiceMode = btn.dataset.vmode;
    document.querySelectorAll('#voicemode-group .seg-btn').forEach((b) => b.classList.toggle('active', b === btn));
    document.getElementById('tts-voice-picker-wrap').classList.toggle('hidden', state.selectedVoiceMode !== 'tts');
  });
});

// Create Project
document.getElementById('new-project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const topic = document.getElementById('input-topic').value.trim();
  if (!topic) return;
  const voiceId = document.getElementById('select-voice-quick').value;

  const btn = document.getElementById('btn-create-and-run');
  btn.disabled = true;
  try {
    const { project } = await api('/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        topic,
        durationSec: state.selectedDuration,
        voiceMode: state.selectedVoiceMode,
        voiceId,
        autoStart: true
      })
    });
    document.getElementById('input-topic').value = '';
    await refreshProjects();
    await selectProject(project.id);
  } catch (err) {
    console.error(err);
  } finally {
    btn.disabled = false;
  }
});

// Load Voices (ElevenLabs)
async function loadVoicesIntoSelects() {
  try {
    const { voices } = await api('/api/voices');
    state.voices = voices || [];
    const quick = document.getElementById('select-voice-quick');
    const setSel = document.getElementById('select-voice-settings');
    const optsHtml = voices.map((v) => `<option value="${escapeHtml(v.voice_id)}">${escapeHtml(v.name)} (${escapeHtml(v.voice_id.slice(0, 8))})</option>`).join('');
    quick.innerHTML = `<option value="">الصوت الافتراضي من الإعدادات</option>` + optsHtml;
    setSel.innerHTML = `<option value="">اختر من القائمة...</option>` + optsHtml;
  } catch (err) {
    showSettingsFeedback(`تعذّر تحميل الأصوات: ${err.message}`, true);
  }
}

document.getElementById('btn-load-voices-quick').addEventListener('click', loadVoicesIntoSelects);
document.getElementById('btn-load-voices-settings').addEventListener('click', loadVoicesIntoSelects);
document.getElementById('select-voice-settings').addEventListener('change', (e) => {
  if (e.target.value) {
    document.getElementById('set-el-voice').value = e.target.value;
  }
});

// Projects list & selection
async function refreshProjects() {
  const { projects } = await api('/api/projects');
  state.projects = projects || [];
  document.getElementById('projects-count').textContent = String(state.projects.length);

  const listEl = document.getElementById('projects-list');
  if (state.projects.length === 0) {
    listEl.innerHTML = `<div class="muted-meta">لا توجد مشاريع بعد.</div>`;
    return;
  }

  listEl.innerHTML = state.projects.map((p) => {
    const activeStage = p.activeStage ? STAGE_LABELS[p.activeStage] : (p.artifacts?.hasVideo ? 'فيديو جاهز' : 'قيد العمل');
    return `
      <button type="button" class="project-item ${p.id === state.activeProjectId ? 'active' : ''}" data-pid="${escapeHtml(p.id)}">
        <span class="project-item-title">${escapeHtml(p.title || p.topic)}</span>
        <span class="project-item-meta">${escapeHtml(String(p.durationSec))} ث · ${escapeHtml(activeStage)}</span>
      </button>
    `;
  }).join('');

  listEl.querySelectorAll('.project-item').forEach((btn) => {
    btn.addEventListener('click', () => selectProject(btn.dataset.pid));
  });
}

async function selectProject(projectId) {
  state.activeProjectId = projectId;
  state.streamBuffer = '';
  if (state.sse) {
    state.sse.close();
    state.sse = null;
  }

  const data = await api(`/api/projects/${encodeURIComponent(projectId)}`);
  state.projectData = data;
  // Auto-focus running or review stage if present
  const p = data.project;
  const interesting = STAGE_ORDER.find((st) => p.stages[st].status === 'running' || p.stages[st].status === 'review');
  if (interesting) state.selectedStage = interesting;

  renderWorkspace();
  refreshProjects();
  connectSSE(projectId);
}

function connectSSE(projectId) {
  const es = new EventSource(`/api/projects/${encodeURIComponent(projectId)}/events`);
  state.sse = es;

  es.addEventListener('state', async (ev) => {
    try {
      const updatedProj = JSON.parse(ev.data);
      if (!state.projectData || state.projectData.project.id !== updatedProj.id) return;
      const prevActive = state.projectData.project.activeStage;
      state.projectData.project = updatedProj;

      // Refresh full artifacts when a stage completes or enters review
      if (prevActive && updatedProj.activeStage !== prevActive) {
        const fresh = await api(`/api/projects/${encodeURIComponent(projectId)}`);
        state.projectData = fresh;
        refreshProjects();
      }
      renderWorkspace();
    } catch {
      // ignore
    }
  });

  es.addEventListener('llm_chunk', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      state.streamBuffer = payload.text || '';
      const streamEl = document.getElementById('live-llm-stream');
      if (streamEl) {
        streamEl.textContent = state.streamBuffer;
        streamEl.scrollTop = streamEl.scrollHeight;
      }
    } catch {
      // ignore
    }
  });

  es.addEventListener('render_progress', (ev) => {
    try {
      const prog = JSON.parse(ev.data);
      const box = document.getElementById('render-progress-box');
      box.classList.remove('hidden');
      document.getElementById('render-progress-text').textContent = `إطار ${prog.frame} / ${prog.totalFrames}`;
      document.getElementById('render-progress-pct').textContent = `${prog.percent}%`;
      document.getElementById('render-progress-fill').style.width = `${prog.percent}%`;
    } catch {
      // ignore
    }
  });

  es.addEventListener('preview_frame', (ev) => {
    try {
      const frame = JSON.parse(ev.data);
      const img = document.getElementById('live-preview-img');
      const vid = document.getElementById('final-video-player');
      const placeholder = document.getElementById('phone-placeholder');
      vid.classList.add('hidden');
      placeholder.classList.add('hidden');
      img.classList.remove('hidden');
      img.src = frame.dataUrl;
    } catch {
      // ignore
    }
  });
}

// Render Workspace UI
function renderWorkspace() {
  const emptyEl = document.getElementById('no-project-state');
  const wsEl = document.getElementById('project-workspace');

  if (!state.projectData) {
    emptyEl.classList.remove('hidden');
    wsEl.classList.add('hidden');
    return;
  }

  emptyEl.classList.add('hidden');
  wsEl.classList.remove('hidden');

  const { project } = state.projectData;
  document.getElementById('proj-title').textContent = project.title || project.topic;
  document.getElementById('proj-meta').textContent =
    `${project.durationSec} ثانية · ${project.voiceMode === 'upload' ? 'صوت مرفوع' : 'ElevenLabs'} · ${project.artifacts.wordCount || 0} كلمة · ${project.artifacts.sceneCount || 0} مشاهد`;

  const isRunning = Boolean(project.activeStage);
  document.getElementById('btn-cancel-run').classList.toggle('hidden', !isRunning);

  // Render 5-Stage Stepper
  const railEl = document.getElementById('stages-rail');
  railEl.innerHTML = STAGE_ORDER.map((st) => {
    const info = project.stages[st];
    const modeLabel = info.mode === 'auto' ? 'تلقائي' : 'انتظار موافقة';
    return `
      <div class="stage-card ${state.selectedStage === st ? 'selected' : ''}" data-stage="${st}">
        <div class="stage-card-top">
          <span class="stage-name">${STAGE_LABELS[st]}</span>
          <span class="stage-status status-${info.status}">${STATUS_LABELS[info.status] || info.status}</span>
        </div>
        <div class="stage-controls">
          <button type="button" class="mode-toggle" data-toggle-mode="${st}" title="تبديل تلقائي / موافقة">
            ${modeLabel}
          </button>
          <div style="display:flex;gap:4px;">
            ${info.status === 'review' ? `<button type="button" class="mini-btn" data-approve="${st}">اعتماد</button>` : ''}
            <button type="button" class="mini-btn" data-run="${st}">${info.status === 'idle' ? 'تشغيل' : 'إعادة'}</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  railEl.querySelectorAll('.stage-card').forEach((card) => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      state.selectedStage = card.dataset.stage;
      renderWorkspace();
    });
  });

  railEl.querySelectorAll('[data-toggle-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const st = btn.dataset.toggleMode;
      const nextMode = project.stages[st].mode === 'auto' ? 'approval' : 'auto';
      await api(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ approvals: { [st]: nextMode } })
      });
      await reloadActiveProject();
    });
  });

  railEl.querySelectorAll('[data-run]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const st = btn.dataset.run;
      state.selectedStage = st;
      await api(`/api/projects/${encodeURIComponent(project.id)}/stages/${st}/run`, { method: 'POST' });
      await reloadActiveProject();
    });
  });

  railEl.querySelectorAll('[data-approve]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const st = btn.dataset.approve;
      await api(`/api/projects/${encodeURIComponent(project.id)}/stages/${st}/approve`, { method: 'POST' });
      await reloadActiveProject();
    });
  });

  renderStageEditor();
  renderPreviewRail();
}

async function reloadActiveProject() {
  if (!state.activeProjectId) return;
  state.projectData = await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}`);
  renderWorkspace();
}

function renderStageEditor() {
  const container = document.getElementById('stage-editor-panel');
  const { project, scriptText, alignedWords, storyboard } = state.projectData;
  const st = state.selectedStage;
  const stInfo = project.stages[st];

  const headerHtml = `
    <div class="stage-editor-head">
      <div>
        <h2 class="panel-title" style="margin:0;">${STAGE_LABELS[st]} — <span class="status-${stInfo.status}">${STATUS_LABELS[stInfo.status]}</span></h2>
        ${stInfo.error ? `<div class="muted-meta" style="color:var(--danger);margin-top:4px;">${escapeHtml(stInfo.error)}</div>` : ''}
      </div>
      <div class="stage-editor-actions">
        ${stInfo.status === 'review' ? `<button type="button" class="btn btn-success" id="btn-stage-approve">موافقة ومتابعة</button>` : ''}
        <button type="button" class="btn btn-secondary" id="btn-stage-run">${stInfo.status === 'idle' ? 'تشغيل المرحلة' : 'إعادة التشغيل'}</button>
      </div>
    </div>
  `;

  let bodyHtml = '';
  if (st === 'script') {
    const wc = (scriptText || '').split(/\s+/).filter(Boolean).length;
    const targetWc = Math.round(project.durationSec * 2.6);
    bodyHtml = `
      ${stInfo.status === 'running' ? `<div class="stream-box" id="live-llm-stream">${escapeHtml(state.streamBuffer || 'جاري كتابة السكريبت...')}</div>` : ''}
      <label class="field">
        <span class="field-label">عنوان الريل</span>
        <input type="text" id="edit-script-title" value="${escapeHtml(project.title || '')}" />
      </label>
      <label class="field">
        <div class="field-row">
          <span class="field-label">نص السكريبت (عامية مصرية)</span>
          <span class="muted-meta tabular">${wc} / ${targetWc} كلمة (≈2.6 كلمة/ث)</span>
        </div>
        <textarea id="edit-script-body" rows="10">${escapeHtml(scriptText || '')}</textarea>
      </label>
      <label class="field">
        <span class="field-label">المصادر العلمية (سطر لكل مصدر)</span>
        <textarea id="edit-script-sources" rows="3">${escapeHtml((project.sources || []).join('\n'))}</textarea>
      </label>
      <div>
        <button type="button" class="btn btn-primary" id="btn-save-script">حفظ تعديلات السكريبت</button>
      </div>
    `;
  } else if (st === 'voice') {
    bodyHtml = `
      <div class="field">
        <span class="field-label">تبديل وضع الصوت أو رفع ملف صوتي مخصص</span>
        <div class="inline-pair">
          <input type="file" id="upload-voice-file" accept="audio/*" />
          <button type="button" class="btn btn-secondary" id="btn-upload-voice">رفع وتجهيز الصوت</button>
        </div>
      </div>
      ${project.artifacts.hasAudio ? `
        <div class="field">
          <span class="field-label">المقطع الصوتي الحالي (${(project.artifacts.audioDuration || 0).toFixed(2)} ثانية)</span>
          <audio controls src="/api/projects/${encodeURIComponent(project.id)}/media/voice.mp3?t=${Date.now()}" style="width:100%;"></audio>
        </div>
      ` : `<p class="muted">لم يتم توليد أو رفع ملف صوتي بعد.</p>`}
    `;
  } else if (st === 'timing') {
    const words = alignedWords || [];
    const weakCount = words.filter((w) => w.weak).length;
    bodyHtml = `
      <div class="field-row">
        <span class="muted-meta">المحاذاة عبر LCS على حروف السكريبت · إجمالي الكلمات: ${words.length} · كلمات ضعيفة: <strong style="color:var(--warning)">${weakCount}</strong></span>
        <button type="button" class="btn btn-primary" id="btn-save-timing">حفظ التوقيتات</button>
      </div>
      <div class="timing-table-wrap">
        <table class="timing-table">
          <thead>
            <tr>
              <th>#</th>
              <th>الكلمة</th>
              <th>البداية (ث)</th>
              <th>النهاية (ث)</th>
              <th>تطابق</th>
              <th>الحالة</th>
            </tr>
          </thead>
          <tbody>
            ${words.map((w, idx) => `
              <tr class="${w.weak ? 'weak-row' : ''}" data-widx="${idx}">
                <td class="tabular">${idx}</td>
                <td><strong>${escapeHtml(w.text)}</strong></td>
                <td><input type="number" step="0.01" class="time-input w-start" value="${w.start.toFixed(2)}" /></td>
                <td><input type="number" step="0.01" class="time-input w-end" value="${w.end.toFixed(2)}" /></td>
                <td class="tabular">${Math.round((w.matchRatio || 0) * 100)}%</td>
                <td>${w.weak ? `<span class="weak-label">ضعيفة: ${escapeHtml(w.weakReason || 'تقديري')}</span>` : '<span style="color:var(--success)">دقيقة</span>'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  } else if (st === 'storyboard') {
    const scenes = storyboard?.scenes || [];
    bodyHtml = `
      ${stInfo.status === 'running' ? `<div class="stream-box" id="live-llm-stream">${escapeHtml(state.streamBuffer || 'جاري بناء الستوري بورد والمراجعة الذاتية...')}</div>` : ''}
      <div class="scene-list">
        ${scenes.map((sc, i) => `
          <div class="scene-row">
            <div>
              <div class="scene-row-title">${i + 1}. ${escapeHtml(sc.title || '')}</div>
              <div class="scene-row-meta">النوع: ${escapeHtml(sc.type)} · القالب: <code>${escapeHtml(sc.template)}</code> · عند كلمة <code>@${sc.at}</code> · أيقونة: <code>${escapeHtml(sc.resolvedIcon || sc.icon || 'atom')}</code></div>
            </div>
          </div>
        `).join('')}
      </div>
      <label class="field">
        <span class="field-label">تحرير JSON الستوري بورد (يتم التحقق والإصلاح تلقائياً عند الحفظ)</span>
        <textarea id="edit-storyboard-json" class="json-editor">${escapeHtml(storyboard ? JSON.stringify(storyboard, null, 2) : '')}</textarea>
      </label>
      <div>
        <button type="button" class="btn btn-primary" id="btn-save-storyboard">حفظ وإصلاح الستوري بورد</button>
      </div>
    `;
  } else if (st === 'render') {
    bodyHtml = `
      <p class="muted">التصوير عبر Playwright Chromium على لوحة 720×1280 بمقياس ×1.5 (1080×1920) بمعدل 30 إطار/ثانية وترميز FFmpeg H.264 + تطبيع صوتي −14 LUFS.</p>
      <div class="scene-row">
        <div>
          <div class="scene-row-title">حالة الفيديو النهائي</div>
          <div class="scene-row-meta">${project.artifacts.hasVideo ? `جاهز (${(project.artifacts.audioDuration || 0).toFixed(2)} ثانية)` : 'لم يبدأ الريندر بعد'}</div>
        </div>
      </div>
    `;
  }

  container.innerHTML = headerHtml + bodyHtml;

  // Bind editor handlers
  document.getElementById('btn-stage-run')?.addEventListener('click', async () => {
    await api(`/api/projects/${encodeURIComponent(project.id)}/stages/${st}/run`, { method: 'POST' });
    await reloadActiveProject();
  });
  document.getElementById('btn-stage-approve')?.addEventListener('click', async () => {
    await api(`/api/projects/${encodeURIComponent(project.id)}/stages/${st}/approve`, { method: 'POST' });
    await reloadActiveProject();
  });

  document.getElementById('btn-save-script')?.addEventListener('click', async () => {
    const title = document.getElementById('edit-script-title').value;
    const body = document.getElementById('edit-script-body').value;
    const sources = document.getElementById('edit-script-sources').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    await api(`/api/projects/${encodeURIComponent(project.id)}/stages/script`, {
      method: 'PUT',
      body: JSON.stringify({ title, scriptText: body, sources })
    });
    await reloadActiveProject();
  });

  document.getElementById('btn-upload-voice')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('upload-voice-file');
    const file = fileInput?.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    const res = await fetch(`/api/projects/${encodeURIComponent(project.id)}/voice/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': file.name
      },
      body: buf
    });
    if (res.ok) await reloadActiveProject();
  });

  document.getElementById('btn-save-timing')?.addEventListener('click', async () => {
    const rows = document.querySelectorAll('.timing-table tbody tr');
    const updated = alignedWords.map((w, idx) => {
      const row = rows[idx];
      if (!row) return w;
      const start = parseFloat(row.querySelector('.w-start').value);
      const end = parseFloat(row.querySelector('.w-end').value);
      return { ...w, start, end, weak: false, weakReason: '' };
    });
    await api(`/api/projects/${encodeURIComponent(project.id)}/stages/timing`, {
      method: 'PUT',
      body: JSON.stringify({ words: updated })
    });
    await reloadActiveProject();
  });

  document.getElementById('btn-save-storyboard')?.addEventListener('click', async () => {
    const raw = document.getElementById('edit-storyboard-json').value;
    const parsed = JSON.parse(raw);
    await api(`/api/projects/${encodeURIComponent(project.id)}/stages/storyboard`, {
      method: 'PUT',
      body: JSON.stringify({ storyboard: parsed })
    });
    await reloadActiveProject();
  });
}

function renderPreviewRail() {
  const { project } = state.projectData;
  const stInfo = project.stages[state.selectedStage];
  document.getElementById('stage-log-pre').textContent = (stInfo.logs || []).join('\n') || 'لا توجد سجلات بعد.';

  const vidEl = document.getElementById('final-video-player');
  const imgEl = document.getElementById('live-preview-img');
  const phEl = document.getElementById('phone-placeholder');
  const vidActions = document.getElementById('video-actions');
  const dlBtn = document.getElementById('btn-download-mp4');
  const csImg = document.getElementById('contact-sheet-img');

  if (project.artifacts.hasVideo && project.stages.render.status !== 'running') {
    const mp4Url = `/api/projects/${encodeURIComponent(project.id)}/media/output.mp4?t=${encodeURIComponent(project.updatedAt)}`;
    if (vidEl.dataset.src !== mp4Url) {
      vidEl.src = mp4Url;
      vidEl.dataset.src = mp4Url;
    }
    dlBtn.href = mp4Url;
    csImg.src = `/api/projects/${encodeURIComponent(project.id)}/media/contact_sheet.jpg?t=${encodeURIComponent(project.updatedAt)}`;
    vidEl.classList.remove('hidden');
    imgEl.classList.add('hidden');
    phEl.classList.add('hidden');
    vidActions.classList.remove('hidden');
    document.getElementById('render-progress-box').classList.add('hidden');
  } else if (project.stages.render.status !== 'running') {
    vidEl.classList.add('hidden');
    imgEl.classList.add('hidden');
    phEl.classList.remove('hidden');
    vidActions.classList.add('hidden');
  }
}

document.getElementById('btn-toggle-contact-sheet').addEventListener('click', () => {
  document.getElementById('contact-sheet-wrap').classList.toggle('hidden');
});

document.getElementById('btn-cancel-run').addEventListener('click', async () => {
  if (!state.activeProjectId) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/cancel`, { method: 'POST' });
  await reloadActiveProject();
});

document.getElementById('btn-delete-project').addEventListener('click', async () => {
  if (!state.activeProjectId) return;
  await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}`, { method: 'DELETE' });
  state.activeProjectId = null;
  state.projectData = null;
  renderWorkspace();
  await refreshProjects();
});

// Settings
function showSettingsFeedback(msg, isError = false) {
  const el = document.getElementById('settings-feedback');
  el.textContent = msg;
  el.classList.remove('hidden', 'error');
  if (isError) el.classList.add('error');
}

async function loadSettings() {
  state.clearFlags = { llm: false, el: false, dg: false };
  const s = await api('/api/settings');
  document.getElementById('set-llm-url').value = s.llmBaseUrl || '';
  document.getElementById('set-llm-model').value = s.llmModel || 'auto';
  document.getElementById('set-llm-key').value = '';
  document.getElementById('mask-llm').textContent = s.hasLlmApiKey ? `المفتاح الحالي: ${s.llmApiKeyMasked}` : 'لا يوجد مفتاح محفوظ';

  document.getElementById('set-el-url').value = s.elevenLabsBaseUrl || '';
  document.getElementById('set-el-key').value = '';
  document.getElementById('mask-el').textContent = s.hasElevenLabsApiKey ? `المفتاح الحالي: ${s.elevenLabsApiKeyMasked}` : 'لا يوجد مفتاح محفوظ';
  document.getElementById('set-el-voice').value = s.elevenLabsVoiceId || '';

  document.getElementById('set-dg-url').value = s.deepgramBaseUrl || '';
  document.getElementById('set-dg-key').value = '';
  document.getElementById('mask-dg').textContent = s.hasDeepgramApiKey ? `المفتاح الحالي: ${s.deepgramApiKeyMasked}` : 'لا يوجد مفتاح محفوظ';

  document.getElementById('set-font-folder').value = s.fontFolder || 'assets/fonts';
}

document.querySelectorAll('[data-clear]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.clear;
    state.clearFlags[k] = true;
    const map = { llm: 'mask-llm', el: 'mask-el', dg: 'mask-dg' };
    document.getElementById(map[k]).textContent = 'سيتم مسح المفتاح عند الحفظ';
  });
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  try {
    const payload = {
      llmBaseUrl: document.getElementById('set-llm-url').value,
      llmModel: document.getElementById('set-llm-model').value,
      llmApiKey: document.getElementById('set-llm-key').value,
      clearLlmApiKey: state.clearFlags.llm,
      elevenLabsBaseUrl: document.getElementById('set-el-url').value,
      elevenLabsApiKey: document.getElementById('set-el-key').value,
      clearElevenLabsApiKey: state.clearFlags.el,
      elevenLabsVoiceId: document.getElementById('set-el-voice').value,
      deepgramBaseUrl: document.getElementById('set-dg-url').value,
      deepgramApiKey: document.getElementById('set-dg-key').value,
      clearDeepgramApiKey: state.clearFlags.dg,
      fontFolder: document.getElementById('set-font-folder').value
    };
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    await loadSettings();
    showSettingsFeedback('تم حفظ الإعدادات بنجاح في data/settings.json.');
  } catch (err) {
    showSettingsFeedback(err.message, true);
  }
});

// Icons Catalog
async function loadIconsCatalog() {
  const data = await api('/api/icons');
  state.iconsCatalog = data.icons || [];
  document.getElementById('icons-license-summary').textContent =
    `${data.count} أيقونة متاحة محلياً — Hand-drawn (CC0-1.0) · Health Icons (CC0-1.0) · Tabler Icons (MIT)`;
  renderIconsGrid('');
}

function renderIconsGrid(query) {
  const q = query.trim().toLowerCase();
  const filtered = state.iconsCatalog.filter((ic) =>
    !q || ic.id.includes(q) || (ic.tags || []).some((t) => t.includes(q))
  );
  document.getElementById('icons-grid').innerHTML = filtered.map((ic) => `
    <div class="icon-tile">
      <div class="icon-tile-name">${escapeHtml(ic.id)}</div>
      <div class="icon-tile-meta">${escapeHtml(ic.source)} · ${escapeHtml(ic.license)}</div>
      <div class="muted-meta">${escapeHtml((ic.tags || []).slice(0, 4).join(', '))}</div>
    </div>
  `).join('');
}

document.getElementById('icons-search').addEventListener('input', (e) => {
  renderIconsGrid(e.target.value);
});

// Initial boot
(async function init() {
  await refreshProjects();
  if (state.projects.length > 0) {
    await selectProject(state.projects[0].id);
  }
})();
