import fs from 'node:fs';
import path from 'node:path';

const MOCK_PORT = 4398;
const TEST_PORT = 4312;

process.env.HOST = '127.0.0.1';
process.env.PORT = String(TEST_PORT);
process.env.ELEVENLABS_BASE_URL = `http://127.0.0.1:${MOCK_PORT}`;

const { createMockServer } = await import('./mock-apis.mjs');
const { createServer } = await import('../server.mjs');
const { createProject, getProjectDir, writeProjectArtifact, saveProject } = await import('../src-server/projects.mjs');
const { synthesizeElevenLabs } = await import('../src-server/voice.mjs');
const { alignScriptWithLCS } = await import('../src-server/timing.mjs');
const { validateAndRepairStoryboard } = await import('../src-server/storyboard.mjs');
const { renderProjectVideo } = await import('../src-server/renderer.mjs');

const TEMPLATE_CASES = [
  {
    template: 'body',
    title: 'قالب الجسم: القلب',
    script: 'قلبك بيضخ الدم لكل خلية في جسمك.',
    scene: {
      type: 'intro',
      template: 'body',
      at: 0,
      title: 'ضخ الدم داخل الجسم',
      subtitle: 'عضلة القلب',
      organ: 'heart-organ',
      icon: 'heart'
    }
  },
  {
    template: 'zoom',
    title: 'قالب التكبير: الذرة',
    script: 'قطعة الحديد جواها ذرات بتتحرك بسرعة.',
    scene: {
      type: 'intro',
      template: 'zoom',
      at: 0,
      title: 'من الحديد للذرات',
      macro: { label: 'معدن صلب', icon: 'shield' },
      micro: { label: 'شبكة ذرات', icon: 'atom' }
    }
  },
  {
    template: 'flow',
    title: 'قالب التدفق: الرؤية',
    script: 'الضوء يدخل عينك ويوصل لمخك فوراً.',
    scene: {
      type: 'intro',
      template: 'flow',
      at: 0,
      title: 'إزاي بتشوف؟',
      steps: [
        { label: 'ضوء يدخل العين', icon: 'eye' },
        { label: 'إشارة عصبية', icon: 'nerve' },
        { label: 'تفسير في المخ', icon: 'neurology' }
      ]
    }
  },
  {
    template: 'cycle',
    title: 'قالب الدورة: الأكسجين',
    script: 'تتنفس Oxygen يدخل الرئة ويلف بالدم.',
    scene: {
      type: 'intro',
      template: 'cycle',
      at: 0,
      title: 'دورة التنفس والدم',
      icon: 'cycle',
      steps: [
        { label: 'شهيق Oxygen', icon: 'lungs' },
        { label: 'نقل بالدم', icon: 'blood-drop' },
        { label: 'طاقة الخلايا', icon: 'battery' },
        { label: 'زفير هواء', icon: 'wind' }
      ]
    }
  },
  {
    template: 'timeline',
    title: 'قالب الخط الزمني: النوم',
    script: 'النور يقل فيفرز مخك هرمون النوم.',
    scene: {
      type: 'intro',
      template: 'timeline',
      at: 0,
      title: 'مراحل دخول النوم',
      steps: [
        { label: 'الظلام يبدأ', icon: 'moon' },
        { label: 'إفراز Melatonin', icon: 'brain' },
        { label: 'نوم عميق', icon: 'pulse' }
      ]
    }
  },
  {
    template: 'chart',
    title: 'قالب الرسم البياني: الحرارة',
    script: 'كل ما الحرارة تزيد تزيد الطاقة.',
    scene: {
      type: 'intro',
      template: 'chart',
      at: 0,
      title: 'ارتفاع الطاقة الحرارية',
      points: [
        { label: '٢٠°', value: 18 },
        { label: '٤٠°', value: 36 },
        { label: '٦٠°', value: 62 },
        { label: '٨٠°', value: 88 }
      ]
    }
  },
  {
    template: 'layers',
    title: 'قالب الطبقات: الأشعة',
    script: 'الأشعة تعدي اللحم لكن عضمك يوقفها.',
    scene: {
      type: 'intro',
      template: 'layers',
      at: 0,
      title: 'اختراق طبقات الجسم',
      layers: [
        { label: 'الجلد الخارجي', icon: 'hand', tone: 'secondary' },
        { label: 'العضلات والأنسجة', icon: 'arm', tone: 'accent' },
        { label: 'العظم والكالسيوم', icon: 'bone', tone: 'warning' }
      ]
    }
  },
  {
    template: 'cards',
    title: 'قالب البطاقات: مقارنة',
    script: 'الضوء مش لحظي ليه سرعة محددة.',
    scene: {
      type: 'intro',
      template: 'cards',
      at: 0,
      title: 'خرافة مقابل حقيقة',
      left: { label: 'الظن الشائع: لحظي', value: '∞', icon: 'cross' },
      right: { label: 'الحقيقة العلمية', value: '300,000 km/s', icon: 'check' }
    }
  },
  {
    template: 'meter',
    title: 'قالب العداد: الكفاءة',
    script: 'تسعة وتسعين في المية بتروح حرارة.',
    scene: {
      type: 'intro',
      template: 'meter',
      at: 0,
      title: 'نسبة الحرارة في الأنبوب',
      subtitle: 'حرارة مفقودة',
      value: 99,
      unit: '%',
      icon: 'fire'
    }
  }
];

async function run() {
  const mockServer = createMockServer();
  const appServer = createServer();
  await new Promise((r) => mockServer.listen(MOCK_PORT, '127.0.0.1', r));
  await new Promise((r) => appServer.listen(TEST_PORT, '127.0.0.1', r));

  const outDir = path.resolve('data', 'template-contact-sheets');
  fs.mkdirSync(outDir, { recursive: true });

  try {
    for (const tc of TEMPLATE_CASES) {
      const proj = createProject({ topic: tc.title, durationSec: 10 });
      proj.title = tc.title;
      const projDir = getProjectDir(proj.id);

      const voiceRes = await synthesizeElevenLabs({
        text: tc.script,
        voiceId: '21m00Tcm4TlvDq8ikWAM',
        outputPath: path.join(projDir, 'voice.mp3')
      });

      const words = alignScriptWithLCS({
        scriptText: tc.script,
        timedWords: voiceRes.timedWords,
        totalDuration: voiceRes.duration
      });

      const { storyboard, icons } = validateAndRepairStoryboard({
        scenes: [tc.scene],
        accents: [[1, 'accent'], [Math.max(0, words.length - 1), 'success']]
      }, words);

      writeProjectArtifact(proj.id, 'script.txt', tc.script);
      writeProjectArtifact(proj.id, 'aligned_words.json', words);
      writeProjectArtifact(proj.id, 'storyboard.json', storyboard);
      writeProjectArtifact(proj.id, 'icons.json', icons);

      const renderRes = await renderProjectVideo({
        projectDir: projDir,
        serverOrigin: `http://127.0.0.1:${TEST_PORT}`,
        title: tc.title,
        durationSec: voiceRes.duration,
        words,
        storyboard,
        icons
      });

      proj.artifacts.scriptText = tc.script;
      proj.artifacts.hasAudio = true;
      proj.artifacts.audioDuration = renderRes.duration;
      proj.artifacts.wordCount = words.length;
      proj.artifacts.sceneCount = storyboard.scenes.length;
      proj.artifacts.hasVideo = true;
      proj.artifacts.hasContactSheet = true;
      for (const st of Object.keys(proj.stages)) proj.stages[st].status = 'done';
      saveProject(proj);

      const sheetCopy = path.join(outDir, `${tc.template}.jpg`);
      fs.copyFileSync(renderRes.contactSheetPath, sheetCopy);
      console.log(`[template:${tc.template}] Rendered ${renderRes.totalFrames} frames -> ${sheetCopy}`);
    }
    console.log('[templates] All 9 template test projects rendered successfully!');
  } finally {
    appServer.close();
    mockServer.close();
  }
}

run().catch((err) => {
  console.error('[templates] FAILED:', err);
  process.exit(1);
});
