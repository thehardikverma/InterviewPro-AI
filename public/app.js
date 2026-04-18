/* ═══════════════════════════════════════════════════════════════
   InterviewPro v2.0 — Main Application Logic (Serverless BYOK)
   ═══════════════════════════════════════════════════════════════ */

// ─── Groq API (Direct Browser Calls) ────────────────────────────
const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_AUDIO_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

function getApiKey() {
  return sessionStorage.getItem('groq_api_key') || localStorage.getItem('groq_api_key') || '';
}

function saveApiKey(key, persist) {
  sessionStorage.setItem('groq_api_key', key);
  if (persist) localStorage.setItem('groq_api_key', key);
  else localStorage.removeItem('groq_api_key');
}

function hasApiKey() {
  return getApiKey().startsWith('gsk_');
}

// ─── Groq Model Cascade (Browser-side) ──────────────────────────
async function callGroqDirect(messages, options = {}) {
  const models = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'];
  let lastError = null;

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 65000);

      const response = await fetch(GROQ_CHAT_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${getApiKey()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.7,
          max_tokens: 4096,
          ...options
        })
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorBody = await response.text();
        if (response.status === 429 || response.status === 413 || (response.status === 400 && errorBody.includes('decommissioned'))) {
          lastError = new Error('Capacity limit on ' + model);
          console.warn(`[API] Limit on ${model}, trying fallback...`);
          continue;
        }
        if (response.status === 401) throw new Error('Invalid API Key. Please check your Groq API key and try again.');
        throw new Error(`AI service error (${response.status}): ${errorBody}`);
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error.message || 'API Error');
      return data;
    } catch (err) {
      if (err.name === 'AbortError') {
        lastError = new Error('API connection timed out');
        console.warn(`[API] Timeout on ${model}, trying fallback...`);
        continue;
      }
      if (err.message.includes('Invalid API Key')) throw err;
      lastError = err;
    }
  }

  lastError.message = 'API rate limit reached across all models. Please wait 1-2 minutes and try again.';
  throw lastError;
}

// ─── Client-side Document Parsing ───────────────────────────────
async function parseDocumentInBrowser(file) {
  const ext = '.' + file.name.split('.').pop().toLowerCase();

  if (ext === '.pdf') {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      fullText += pageText + '\n';
    }
    return fullText;
  }

  // For all text-based files (.txt, .md, .csv, .json, .rtf)
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// ─── State ──────────────────────────────────────────────────────
const state = {
  questions: [],
  currentIndex: 0,
  recordings: [],       // { question, blob, url, duration }
  answerDurations: [],   // actual seconds spent per question
  stream: null,
  recorder: null,
  chunks: [],
  timerInterval: null,
  timeRemaining: 0,
  totalTime: 0,
  phase: 'idle',        // idle | prep | recording
  audioContext: null,
  analyser: null,
  animFrameId: null,
  recordingStartTime: null,
  sessionStartTime: null,
  documentContent: '',   // extracted text from uploaded doc
  documentFilename: ''   // uploaded doc filename
};

// ─── Question Memory (Anti-Repetition) ──────────────────────────
function getHistoryKey() {
  const docPart = state.documentFilename || 'nodoc';
  const topicPart = (config.topic || 'general').replace(/\s+/g, '_').substring(0, 40);
  return `interviewpro_history_${topicPart}_${docPart}`;
}

function getQuestionHistory() {
  try {
    const raw = localStorage.getItem(getHistoryKey());
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveQuestionHistory(newQuestions) {
  const history = getQuestionHistory();
  const updated = [...history, ...newQuestions.map(q => q.question)];
  // Keep last 200 questions max to avoid bloating localStorage
  const trimmed = updated.slice(-200);
  localStorage.setItem(getHistoryKey(), JSON.stringify(trimmed));
}

function clearQuestionHistory() {
  localStorage.removeItem(getHistoryKey());
}

const config = {
  topic: '',
  type: 'mixed',
  context: '',
  questionCount: 8,
  answerTime: 60,
  prepTime: 30,
  shuffle: true,
  mode: 'ai'
};

const CIRCUMFERENCE = 2 * Math.PI * 88; // matches SVG circle r=88

// ─── DOM References ─────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Initialize ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);

function init() {
  // ─ API Key Modal ─
  const overlay = $('#api-key-overlay');
  const keyInput = $('#groq-api-key-input');
  const saveBtn = $('#save-api-key-btn');

  if (hasApiKey()) {
    overlay.classList.add('hidden');
  }

  saveBtn.addEventListener('click', () => {
    const key = keyInput.value.trim();
    if (!key.startsWith('gsk_')) {
      showToast('Invalid API key. It should start with gsk_', { type: 'error', title: 'Invalid Key' });
      keyInput.focus();
      return;
    }
    const persist = $('#save-key-checkbox').checked;
    saveApiKey(key, persist);
    overlay.classList.add('hidden');
    showToast('API key connected!', { type: 'success', title: 'Connected' });
  });

  keyInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveBtn.click();
  });

  // Change key link
  const changeLink = $('#change-api-key-link');
  if (changeLink) {
    changeLink.addEventListener('click', (e) => {
      e.preventDefault();
      keyInput.value = getApiKey();
      overlay.classList.remove('hidden');
      keyInput.focus();
    });
  }

  // Mode toggle
  $('#mode-ai-btn').addEventListener('click', () => setMode('ai'));
  $('#mode-custom-btn').addEventListener('click', () => setMode('custom'));

  // Range slider live update
  $('#question-count').addEventListener('input', (e) => {
    $('#q-count-label').textContent = e.target.value;
  });

  // Start button
  $('#start-btn').addEventListener('click', handleStart);

  // Camera screen
  $('#ready-btn').addEventListener('click', startInterview);

  // Interview controls
  $('#skip-btn').addEventListener('click', moveToNext);
  $('#next-btn').addEventListener('click', moveToNext);
  $('#end-interview-btn').addEventListener('click', confirmEndInterview);

  // Review controls
  $('#download-all-btn').addEventListener('click', downloadAll);
  $('#ai-tips-btn').addEventListener('click', getAITips);
  $('#ai-analysis-btn').addEventListener('click', getPerformanceAnalysis);
  $('#new-session-btn').addEventListener('click', newSession);
  $('#close-tips-btn').addEventListener('click', () => $('#ai-tips-panel').classList.add('hidden'));
  $('#close-analysis-btn').addEventListener('click', () => $('#ai-analysis-panel').classList.add('hidden'));

  // Document upload
  initDocUpload();

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeydown);

  console.log('🎥 InterviewPro v2.0 initialized (BYOK Mode)');
}

// ─── Toast Notifications ────────────────────────────────────────
function showToast(message, { type = 'error', title = '', duration = 8000 } = {}) {
  const container = $('#toast-container');
  if (!container) { alert(message); return; }

  const icons = { error: '❌', warning: '⚠️', info: 'ℹ️', success: '✅' };
  const titles = { error: 'Error', warning: 'Warning', info: 'Info', success: 'Success' };

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.error}</span>
    <div class="toast-body">
      <div class="toast-title">${title || titles[type]}</div>
      <div class="toast-message">${escapeHtml(message)}</div>
    </div>
    <button class="toast-close" onclick="this.closest('.toast').remove()">✕</button>
  `;

  container.appendChild(toast);

  // Auto dismiss
  const timer = setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, duration);

  // Click close cancels auto-dismiss
  toast.querySelector('.toast-close').addEventListener('click', () => clearTimeout(timer));
}

// ─── Document Upload ────────────────────────────────────────────
function initDocUpload() {
  const zone = $('#doc-upload-zone');
  const fileInput = $('#doc-file-input');
  const removeBtn = $('#doc-remove-btn');

  // Click to browse
  zone.addEventListener('click', (e) => {
    if (e.target.closest('.doc-remove-btn') || e.target.closest('.doc-upload-active')) return;
    fileInput.click();
  });

  // File selected via input
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) uploadDocument(e.target.files[0]);
  });

  // Drag & drop
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });

  zone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files.length > 0) uploadDocument(e.dataTransfer.files[0]);
  });

  // Remove document
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearDocument();
  });
}

async function uploadDocument(file) {
  const zone = $('#doc-upload-zone');
  const maxSize = 50 * 1024 * 1024; // 50MB

  if (file.size > maxSize) {
    showToast('File too large. Maximum size is 50MB.', { type: 'warning', title: 'File Too Large' });
    return;
  }

  const allowed = ['.pdf', '.txt', '.md', '.csv', '.json', '.rtf'];
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!allowed.includes(ext)) {
    showToast('Unsupported file type. Supported: ' + allowed.join(', '), { type: 'warning', title: 'Unsupported Format' });
    return;
  }

  // Show uploading state
  zone.classList.add('uploading');
  $('#doc-upload-idle').classList.add('hidden');
  $('#doc-upload-active').classList.remove('hidden');
  $('#doc-file-name').textContent = file.name;
  $('#doc-file-size').textContent = formatFileSize(file.size);
  $('#doc-status-text').textContent = 'Parsing document locally...';
  $('#doc-status').querySelector('.doc-status-dot').style.background = 'var(--warning)';

  try {
    const text = await parseDocumentInBrowser(file);

    const maxChars = 60000;
    const truncated = text.length > maxChars;
    const content = truncated
      ? text.substring(0, maxChars) + '\n\n[Document truncated for processing...]'
      : text;

    state.documentContent = content;
    state.documentFilename = file.name;

    // Update status
    const statusDot = $('#doc-status').querySelector('.doc-status-dot');
    const statusText = $('#doc-status-text');
    statusDot.style.background = 'var(--success)';
    statusDot.style.boxShadow = '0 0 6px rgba(16, 185, 129, 0.4)';
    statusText.style.color = 'var(--success)';

    const charInfo = truncated
      ? `Parsed (${(text.length / 1000).toFixed(1)}k chars, trimmed to 60k)`
      : `Parsed locally (${(text.length / 1000).toFixed(1)}k chars)`;
    statusText.textContent = charInfo;

    zone.classList.remove('uploading');
  } catch (err) {
    console.error('Doc parse error:', err);
    const statusDot = $('#doc-status').querySelector('.doc-status-dot');
    const statusText = $('#doc-status-text');
    statusDot.style.background = 'var(--danger)';
    statusText.style.color = 'var(--danger)';
    statusText.textContent = 'Error: ' + err.message;
    zone.classList.remove('uploading');
  }
}

function clearDocument() {
  state.documentContent = '';
  state.documentFilename = '';
  $('#doc-file-input').value = '';
  $('#doc-upload-idle').classList.remove('hidden');
  $('#doc-upload-active').classList.add('hidden');
}

// ─── Mode Toggle ────────────────────────────────────────────────
function setMode(mode) {
  config.mode = mode;

  $('#mode-ai-btn').classList.toggle('active', mode === 'ai');
  $('#mode-custom-btn').classList.toggle('active', mode === 'custom');
  $('#mode-slider').classList.toggle('right', mode === 'custom');

  $('#ai-fields').classList.toggle('hidden', mode === 'custom');
  $('#custom-fields').classList.toggle('hidden', mode === 'ai');

  // Update button text
  const btnContent = $('#start-btn .btn-content');
  if (mode === 'ai') {
    btnContent.innerHTML = '<span class="btn-icon">🚀</span> Generate Questions & Start';
  } else {
    btnContent.innerHTML = '<span class="btn-icon">🎬</span> Start Interview';
  }

  // Hide question count slider for custom mode
  if (mode === 'custom') {
    $('#question-count').closest('.form-group').style.display = 'none';
  } else {
    $('#question-count').closest('.form-group').style.display = '';
  }
}

// ─── Screen Management ──────────────────────────────────────────
function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#${id}`).classList.add('active');
}

// ─── Handle Start ───────────────────────────────────────────────
async function handleStart() {
  // Read config from form
  config.answerTime = parseInt($('#answer-time').value);
  config.prepTime = parseInt($('#prep-time').value);
  config.shuffle = $('#shuffle-questions').checked;

  if (config.mode === 'ai') {
    config.topic = $('#topic').value.trim();
    config.type = $('#interview-type').value;
    config.context = $('#context').value.trim();
    config.questionCount = parseInt($('#question-count').value);

    if (!config.topic) {
      shakeElement($('#topic'));
      $('#topic').focus();
      return;
    }

    await generateQuestionsAI();
  } else {
    config.topic = $('#custom-topic').value.trim() || 'Custom Interview';
    config.type = 'custom';
    const rawQuestions = $('#custom-questions').value.trim();

    if (!rawQuestions) {
      shakeElement($('#custom-questions'));
      $('#custom-questions').focus();
      return;
    }

    const lines = rawQuestions.split('\n').filter(q => q.trim());
    state.questions = lines.map((q, i) => ({
      id: i + 1,
      question: q.trim(),
      category: 'Custom',
      difficulty: 'Medium',
      tips: ''
    }));

    config.questionCount = state.questions.length;

    if (config.shuffle) shuffleArray(state.questions);

    await setupCamera();
  }
}

// ─── Generate AI Questions (Direct Browser Call) ────────────────
async function generateQuestionsAI() {
  if (!hasApiKey()) {
    showToast('Please enter your Groq API key first.', { type: 'error', title: 'No API Key' });
    $('#api-key-overlay').classList.remove('hidden');
    return;
  }

  showScreen('loading-screen');
  animateLoadingSteps();

  try {
    const previousQuestions = getQuestionHistory();

    // Build document reference
    let docRef = '';
    if (state.documentContent) {
      const trimmed = state.documentContent.substring(0, 25000);
      docRef = `\n\nREFERENCE DOCUMENT:\n"""\n${trimmed}\n"""\nCRITICALLY: Base your questions strictly on the contents of this document. DO NOT mention "According to the document" or "In section 4". Just ask the direct question derived from the text.`;
      $('#loading-subtitle').textContent = 'Analyzing your document and crafting questions...';
    }

    // Build anti-repetition blacklist
    let antiRepeat = '';
    if (previousQuestions.length > 0) {
      const recent = previousQuestions.slice(-50);
      antiRepeat = `\n\n⛔ PREVIOUSLY ASKED QUESTIONS (DO NOT REPEAT):\n${recent.map((q, i) => `${i + 1}. "${q}"`).join('\n')}\n\nYou MUST generate COMPLETELY NEW questions substantially different from these. Find new angles inside the text.`;
    }

    const systemPrompt = `You are an elite, highly intelligent interviewer.
    
Before generating the JSON questions, output your internal reasoning securely within a <thinking> block. 

RULES for <thinking>:
1. READ the user's "Role/Topic/Instructions" carefully. This is the ABSOLUTE LAW. If they ask for direct questions, give direct questions. If they ask for coding, give coding. 
2. Identify the core intent of their instruction and how to map it onto the reference document.

RULES for JSON Questions:
- OBEDIENCE: You must follow the user's specific "Role/Topic/Instructions" above all else.
- SMART INTERFERENCE: By default, you must elevate questions. If you extract a topic from the document, rewrite the question to make it profoundly intelligent, scenario-based, and harder (e.g. testing deep understanding rather than simple trivia). 
- EXCEPTION TO SMART INTERFERENCE: If the user explicitly instructs you to "ask exact questions" or "do not rephrase", you MUST disable Smart Interference and extract the text exactly as written.
- RESTRICTION: Do NOT say "Based on the document..." or reference question numbers/sections. Be seamless.
- Questions must be 1 to 2 sentences MAX.

Interview type: ${config.type}
Role/Topic/Instructions: ${config.topic}
${config.context ? `Additional context from candidate: ${config.context}` : ''}${docRef}${antiRepeat}

MANDATORY OUTPUT FORMAT:
<thinking>
1. User specifically requested...
2. Document context maps to...
3. I will avoid...
</thinking>

\`\`\`json
{
  "questions": [
    {
      "id": 1,
      "question": "Direct, conversational interview question without meta-references",
      "category": "Topic",
      "difficulty": "Easy|Medium|Hard",
      "tips": "Brief precise tip"
    }
  ]
}
\`\`\`
`;

    const result = await callGroqDirect([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Generate exactly ${config.questionCount} highly intelligent interview questions based strictly on the system rules and my instructions. ${previousQuestions.length ? `Skip these ${previousQuestions.length} known questions.` : ''}` }
    ], {
      temperature: 0.95
    });

    const outputString = result.choices[0].message.content;

    // Resilient JSON extraction
    const jsonMatch = outputString.match(/```json\s+([\s\S]*?)\s+```/) || outputString.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI failed to return proper JSON.');

    const parsed = JSON.parse(jsonMatch[1] ? jsonMatch[1] : jsonMatch[0]);
    if (!parsed.questions || !Array.isArray(parsed.questions)) throw new Error('Invalid question structure.');

    state.questions = parsed.questions;

    // Save to history so next session won't repeat
    saveQuestionHistory(state.questions);

    if (config.shuffle) shuffleArray(state.questions);

    await setupCamera();
  } catch (err) {
    console.error('Question generation error:', err);
    const msg = err.message || 'Failed to generate questions';
    if (msg.includes('rate limit') || msg.includes('429')) {
      showToast(msg, { type: 'warning', title: 'Rate Limit Reached', duration: 12000 });
    } else if (msg.includes('Invalid API Key')) {
      showToast(msg, { type: 'error', title: 'Authentication Error' });
      $('#api-key-overlay').classList.remove('hidden');
    } else {
      showToast(msg, { type: 'error', title: 'Generation Failed' });
    }
    showScreen('setup-screen');
  }
}

// ─── Loading Animation ─────────────────────────────────────────
function animateLoadingSteps() {
  const steps = $$('.loading-step');
  steps.forEach(s => { s.classList.remove('active', 'done'); });

  let current = 0;
  steps[0].classList.add('active');

  const interval = setInterval(() => {
    if (current < steps.length - 1) {
      steps[current].classList.remove('active');
      steps[current].classList.add('done');
      current++;
      steps[current].classList.add('active');
    } else {
      clearInterval(interval);
    }
  }, 2000);

  // Store interval so it clears on screen change
  state._loadingInterval = interval;
}

// ─── Camera Setup ───────────────────────────────────────────────
async function setupCamera() {
  if (state._loadingInterval) clearInterval(state._loadingInterval);
  showScreen('camera-screen');

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user'
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // Set video preview
    const preview = $('#camera-preview');
    preview.srcObject = state.stream;

    // Update device statuses
    setDeviceStatus('camera-status', 'Camera: Ready ✓', 'ready');
    setDeviceStatus('mic-status', 'Microphone: Ready ✓', 'ready');

    // Setup audio level meter
    setupAudioMeter();

    // Enable ready button
    $('#ready-btn').disabled = false;

    // Update interview summary
    updateSummary();
  } catch (err) {
    console.error('Camera error:', err);
    let msg = err.message;
    if (err.name === 'NotAllowedError') msg = 'Permission denied';
    if (err.name === 'NotFoundError') msg = 'No camera found';

    setDeviceStatus('camera-status', `Camera: ${msg}`, 'error');
    setDeviceStatus('mic-status', `Microphone: ${msg}`, 'error');
  }
}

function setDeviceStatus(id, text, status) {
  const el = $(`#${id}`);
  el.querySelector('.status-dot').className = `status-dot ${status}`;
  el.querySelector('.status-text').textContent = text;
}

function setupAudioMeter() {
  try {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = state.audioContext.createMediaStreamSource(state.stream);
    state.analyser = state.audioContext.createAnalyser();
    source.connect(state.analyser);
    state.analyser.fftSize = 256;

    const dataArray = new Uint8Array(state.analyser.frequencyBinCount);
    const audioBar = $('#audio-level');

    function updateLevel() {
      state.analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const pct = Math.min(100, (avg / 80) * 100);
      audioBar.style.width = pct + '%';
      state.animFrameId = requestAnimationFrame(updateLevel);
    }

    updateLevel();
  } catch (err) {
    console.warn('Audio meter unavailable:', err);
  }
}

function updateSummary() {
  $('#summary-topic').textContent = config.topic;
  $('#summary-questions').textContent = state.questions.length + ' questions';
  $('#summary-answer-time').textContent = formatDuration(config.answerTime);
  $('#summary-prep-time').textContent = config.prepTime > 0 ? formatDuration(config.prepTime) : 'None';

  const totalSec = state.questions.length * (config.answerTime + config.prepTime);
  $('#summary-duration').textContent = '~' + formatDuration(totalSec);

  // Show document info if available
  const docRow = $('#summary-doc-row');
  if (state.documentFilename) {
    docRow.style.display = '';
    $('#summary-doc').textContent = state.documentFilename;
  } else {
    docRow.style.display = 'none';
  }
}

// ─── Start Interview ────────────────────────────────────────────
function startInterview() {
  // Stop audio meter animation
  cancelAnimationFrame(state.animFrameId);

  state.currentIndex = 0;
  state.recordings = [];
  state.answerDurations = [];
  state.sessionStartTime = Date.now();

  showScreen('interview-screen');

  // Set video feed
  const video = $('#interview-video');
  video.srcObject = state.stream;

  showQuestion(0);
}

// ─── Show Question ──────────────────────────────────────────────
function showQuestion(index) {
  const q = state.questions[index];
  state.currentIndex = index;

  // Update progress
  $('#question-progress').textContent = `Question ${index + 1} / ${state.questions.length}`;
  const progressPct = ((index + 1) / state.questions.length) * 100;
  $('#progress-fill').style.width = progressPct + '%';

  // Update question display
  $('#q-number').textContent = `Q${index + 1}`;
  $('#question-text').textContent = q.question;

  // Category & difficulty
  $('#q-category').textContent = q.category || 'General';

  const diffEl = $('#q-difficulty');
  const diff = (q.difficulty || 'Medium').toLowerCase();
  diffEl.textContent = q.difficulty || 'Medium';
  diffEl.className = `question-difficulty ${diff}`;

  // Tip
  const tipEl = $('#question-tip');
  if (q.tips && config.prepTime > 0) {
    tipEl.textContent = '💡 ' + q.tips;
    tipEl.classList.remove('hidden');
  } else {
    tipEl.classList.add('hidden');
  }

  // Re-trigger animation
  const panel = $('.question-panel');
  panel.style.animation = 'none';
  panel.offsetHeight; // force reflow
  panel.style.animation = '';

  // Start prep or recording
  if (config.prepTime > 0) {
    startPrep();
  } else {
    startRecording();
  }
}

// ─── Prep Phase ─────────────────────────────────────────────────
function startPrep() {
  state.phase = 'prep';

  const badge = $('#interview-phase');
  badge.className = 'phase-badge prep';
  badge.querySelector('.phase-text').textContent = 'PREPARING';

  $('#rec-indicator').classList.add('hidden');
  $('#timer-label').textContent = 'Prep Time';

  // Reset timer circle color
  $('#timer-circle').style.stroke = 'var(--accent)';

  startTimer(config.prepTime, () => {
    startRecording();
  });
}

// ─── Recording Phase ───────────────────────────────────────────
function startRecording() {
  state.phase = 'recording';
  state.recordingStartTime = Date.now();

  const badge = $('#interview-phase');
  badge.className = 'phase-badge recording';
  badge.querySelector('.phase-text').textContent = 'RECORDING';

  $('#rec-indicator').classList.remove('hidden');
  $('#timer-label').textContent = 'Answer Time';

  // Hide tip during recording
  $('#question-tip').classList.add('hidden');

  // Start MediaRecorder
  state.chunks = [];
  const mimeType = getSupportedMimeType();
  const recorderOptions = mimeType ? { mimeType } : {};

  try {
    state.recorder = new MediaRecorder(state.stream, recorderOptions);
  } catch (err) {
    console.warn('MediaRecorder with mimeType failed, trying default:', err);
    state.recorder = new MediaRecorder(state.stream);
  }

  state.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      state.chunks.push(e.data);
    }
  };

  state.recorder.onstop = () => {
    const actualDuration = Math.round((Date.now() - state.recordingStartTime) / 1000);
    state.answerDurations.push(actualDuration);

    if (state.chunks.length > 0) {
      const blob = new Blob(state.chunks, {
        type: state.recorder.mimeType || 'video/webm'
      });
      const url = URL.createObjectURL(blob);
      const recIndex = state.recordings.length;
      
      state.recordings.push({
        question: state.questions[state.currentIndex],
        blob,
        url,
        duration: actualDuration,
        transcript: 'Processing audio...'
      });

      // Fire and forget transcript request
      transcribeAudio(recIndex, blob);
    }
  };

  state.recorder.start(500); // collect data every 500ms

  // Reset timer circle color
  $('#timer-circle').style.stroke = 'var(--success)';

  startTimer(config.answerTime, () => {
    moveToNext();
  });
}

// ─── Transcribe Audio (Direct Groq Whisper) ──────────────────
async function transcribeAudio(index, blob) {
  try {
    const formData = new FormData();
    formData.append('file', blob, 'recording.webm');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'json');

    const cardStatus = $(`#transcript-status-${index}`);
    if (cardStatus) cardStatus.textContent = 'Transcribing...';

    const response = await fetch(GROQ_AUDIO_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getApiKey()}` },
      body: formData
    });

    if (!response.ok) throw new Error('Transcription failed');
    const data = await response.json();

    state.recordings[index].transcript = data.text;

    const cardText = $(`#transcript-text-${index}`);
    if (cardText) {
      cardText.textContent = data.text;
      cardText.parentElement.classList.remove('processing');
    }
  } catch (err) {
    console.error('Transcription error for Q' + (index + 1), err);
    state.recordings[index].transcript = '[Audio could not be transcribed]';
    const cardText = $(`#transcript-text-${index}`);
    if (cardText) {
      cardText.textContent = '[Transcription error]';
      cardText.parentElement.classList.remove('processing');
    }
  }
}

// ─── Move to Next Question ──────────────────────────────────────
function moveToNext() {
  // Stop recording if active
  if (state.recorder && state.recorder.state !== 'inactive') {
    state.recorder.stop();
  }

  clearInterval(state.timerInterval);
  state.phase = 'idle';
  $('#rec-indicator').classList.add('hidden');

  // Brief transition delay
  setTimeout(() => {
    if (state.currentIndex < state.questions.length - 1) {
      showQuestion(state.currentIndex + 1);
    } else {
      finishInterview();
    }
  }, 600);
}

// ─── Timer ──────────────────────────────────────────────────────
function startTimer(duration, onComplete) {
  clearInterval(state.timerInterval);
  state.timeRemaining = duration;
  state.totalTime = duration;

  updateTimerDisplay();

  state.timerInterval = setInterval(() => {
    state.timeRemaining--;
    updateTimerDisplay();

    if (state.timeRemaining <= 0) {
      clearInterval(state.timerInterval);
      onComplete();
    }
  }, 1000);
}

function updateTimerDisplay() {
  const mins = Math.floor(state.timeRemaining / 60);
  const secs = state.timeRemaining % 60;
  const timeStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

  $('#timer-value').textContent = timeStr;
  $('#overlay-timer').textContent = timeStr;

  // Update circular progress
  const offset = CIRCUMFERENCE * (1 - state.timeRemaining / state.totalTime);
  const circle = $('#timer-circle');
  circle.style.strokeDashoffset = offset;

  // Dynamic color based on remaining time
  const ratio = state.timeRemaining / state.totalTime;
  if (state.phase === 'prep') {
    circle.style.stroke = 'var(--accent)';
  } else if (ratio > 0.5) {
    circle.style.stroke = 'var(--success)';
  } else if (ratio > 0.2) {
    circle.style.stroke = 'var(--warning)';
  } else {
    circle.style.stroke = 'var(--danger)';

    // Flash warning at last 5 seconds
    if (state.timeRemaining <= 5 && state.timeRemaining > 0) {
      $('#video-timer-overlay').style.color = 'var(--danger)';
    }
  }
}

// ─── Finish Interview ───────────────────────────────────────────
function finishInterview() {
  const totalDuration = Math.round((Date.now() - state.sessionStartTime) / 1000);

  showScreen('review-screen');

  // Stats
  $('#stat-questions').textContent = state.questions.length;
  $('#stat-duration').textContent = formatDuration(totalDuration);
  $('#stat-recorded').textContent = state.recordings.length;

  // Reset panels
  $('#ai-tips-panel').classList.add('hidden');
  $('#ai-analysis-panel').classList.add('hidden');

  // Reset timer overlay color
  $('#video-timer-overlay').style.color = '';

  // Render recordings
  renderReviewList();
}

function confirmEndInterview() {
  if (confirm('Are you sure you want to end the interview early? Your recorded answers will be saved.')) {
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
    }
    clearInterval(state.timerInterval);
    state.phase = 'idle';

    setTimeout(finishInterview, 600);
  }
}

// ─── Review List ────────────────────────────────────────────────
function renderReviewList() {
  const list = $('#review-list');
  list.innerHTML = '';

  if (state.recordings.length === 0) {
    list.innerHTML = `
      <div class="glass-card" style="padding: 40px; text-align: center; box-shadow: var(--shadow-sm);">
        <p style="color: var(--text-muted); font-size: 15px;">No recordings were saved.</p>
      </div>`;
    return;
  }

  state.recordings.forEach((rec, i) => {
    const card = document.createElement('div');
    card.className = 'review-card glass-card';
    card.style.animationDelay = `${i * 0.08}s`;

    card.innerHTML = `
      <div class="review-card-header">
        <span class="review-q-number">Q${i + 1}</span>
        <p class="review-question">${escapeHtml(rec.question.question)}</p>
        <span class="review-card-duration">${formatDuration(rec.duration)}</span>
      </div>
      <div class="review-card-body">
        <video src="${rec.url}" controls preload="metadata" style="transform: scaleX(-1);"></video>
        <div class="transcript-box ${rec.transcript === 'Processing audio...' ? 'processing' : ''}">
          <div class="transcript-label">🗣️ Transcript</div>
          <div class="transcript-text" id="transcript-text-${i}">${escapeHtml(rec.transcript || '')}</div>
        </div>
      </div>
      <div class="review-card-actions">
        <button class="btn-small" data-action="download" data-index="${i}">📥 Download</button>
        <button class="btn-small" data-action="retry" data-index="${i}">🔄 Re-record</button>
      </div>`;

    list.appendChild(card);
  });

  // Event delegation for review card buttons
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const index = parseInt(btn.dataset.index);
    const action = btn.dataset.action;

    if (action === 'download') downloadRecording(index);
    if (action === 'retry') retryQuestion(index);
  });
}

// ─── Downloads ──────────────────────────────────────────────────
function downloadRecording(index) {
  const rec = state.recordings[index];
  if (!rec) return;

  const ext = rec.blob.type.includes('mp4') ? 'mp4' : 'webm';
  const a = document.createElement('a');
  a.href = rec.url;
  a.download = `interview_Q${index + 1}_${sanitizeFilename(config.topic)}.${ext}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function downloadAll() {
  if (state.recordings.length === 0) return;
  state.recordings.forEach((_, i) => {
    setTimeout(() => downloadRecording(i), i * 300);
  });
}

// ─── Retry Question ─────────────────────────────────────────────
function retryQuestion(index) {
  if (!confirm(`Re-record answer for Q${index + 1}? This will replace the current recording.`)) return;

  // Remove old recording
  const old = state.recordings[index];
  if (old) URL.revokeObjectURL(old.url);
  state.recordings.splice(index, 1);
  state.answerDurations.splice(index, 1);

  // Go back to interview screen for this question
  showScreen('interview-screen');
  const video = $('#interview-video');
  video.srcObject = state.stream;

  // Override moveToNext to go back to review
  const originalIndex = state.currentIndex;
  state.currentIndex = index;

  const q = state.questions[index];
  $('#question-progress').textContent = `Re-recording Q${index + 1}`;
  $('#progress-fill').style.width = '100%';

  $('#q-number').textContent = `Q${index + 1}`;
  $('#question-text').textContent = q.question;
  $('#q-category').textContent = q.category || 'General';

  const diffEl = $('#q-difficulty');
  const diff = (q.difficulty || 'Medium').toLowerCase();
  diffEl.textContent = q.difficulty || 'Medium';
  diffEl.className = `question-difficulty ${diff}`;
  $('#question-tip').classList.add('hidden');

  // Start recording directly (skip prep for retries)
  state.phase = 'recording';
  state.recordingStartTime = Date.now();

  const badge = $('#interview-phase');
  badge.className = 'phase-badge recording';
  badge.querySelector('.phase-text').textContent = 'RE-RECORDING';
  $('#rec-indicator').classList.remove('hidden');
  $('#timer-label').textContent = 'Answer Time';

  state.chunks = [];
  const mimeType = getSupportedMimeType();
  const opts = mimeType ? { mimeType } : {};

  try {
    state.recorder = new MediaRecorder(state.stream, opts);
  } catch {
    state.recorder = new MediaRecorder(state.stream);
  }

  state.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) state.chunks.push(e.data);
  };

  state.recorder.onstop = () => {
    const dur = Math.round((Date.now() - state.recordingStartTime) / 1000);
    state.answerDurations.splice(index, 0, dur);

    if (state.chunks.length > 0) {
      const blob = new Blob(state.chunks, { type: state.recorder.mimeType || 'video/webm' });
      const url = URL.createObjectURL(blob);
      state.recordings.splice(index, 0, {
        question: q,
        blob,
        url,
        duration: dur
      });
    }

    // Go back to review
    state.currentIndex = originalIndex;
    showScreen('review-screen');
    renderReviewList();
  };

  state.recorder.start(500);

  $('#timer-circle').style.stroke = 'var(--success)';
  startTimer(config.answerTime, () => {
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
    }
    clearInterval(state.timerInterval);
    state.phase = 'idle';
    $('#rec-indicator').classList.add('hidden');
  });
}

// ─── AI Tips (Direct Browser Call) ──────────────────────────
async function getAITips() {
  const panel = $('#ai-tips-panel');
  const content = $('#ai-tips-content');
  panel.classList.remove('hidden');
  content.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const docContext = state.documentContent
      ? `\n═══ REFERENCE MATERIAL ═══\n"""\n${state.documentContent.substring(0, 20000)}\n"""\n\nUse this material to provide HIGHLY SPECIFIC model answers with exact facts, figures, and concepts from the document.\n`
      : '';

    const systemPrompt = `You are a world-renowned interview coach who has personally coached 10,000+ candidates into roles at top companies. You deliver transformative, specific, no-fluff coaching.\n\n${docContext}\nFor EACH question, provide this structured coaching:\n\n🎯 WHAT THEY'RE REALLY TESTING\n(The hidden evaluation criteria most candidates miss)\n\n📐 PERFECT ANSWER BLUEPRINT\n(Step-by-step structure with time allocation)\n\n✅ MUST-HIT POINTS\n(Specific content that scores top marks)\n\n⚡ POWER MOVES\n(Exact phrases and techniques that wow interviewers)\n\n🚫 INSTANT DISQUALIFIERS\n(Mistakes that immediately eliminate candidates)\n\n⭐ GOLD-STANDARD ANSWER EXCERPT\n(A brief model answer showing exactly what excellence looks like)\n\nAlso provide 7 ELITE interview strategies for ${config.type} interviews that most candidates don't know.\n\nFormat as polished, scannable HTML using <h3>, <h4>, <p>, <ul>, <li>, <strong>, <em> tags. Use strategic emoji placement. Be comprehensive yet concise.`;

    const questionsText = state.questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n');

    const result = await callGroqDirect([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Topic: ${config.topic}\nType: ${config.type}\n\nQuestions:\n${questionsText}\n\nDeliver world-class coaching for every question.` }
    ]);

    const rawAnalysis = result.choices[0].message.content;
    const clean = rawAnalysis.replace(/```(?:html|)\n([\s\S]*?)```/gi, '$1').trim();
    content.innerHTML = clean;
  } catch (err) {
    const msg = err.message || 'Something went wrong';
    content.innerHTML = `<p style="color: var(--danger); font-weight: 500;">${escapeHtml(msg)}</p>`;
    showToast(msg, { type: msg.includes('rate limit') ? 'warning' : 'error', title: msg.includes('rate limit') ? 'Rate Limit' : 'Tips Generation Failed' });
  }
}

// ─── Performance Analysis (Direct Browser Call) ───────────────
async function getPerformanceAnalysis() {
  const panel = $('#ai-analysis-panel');
  const content = $('#ai-analysis-content');
  panel.classList.remove('hidden');
  content.innerHTML = '<div class="loading-dots"><span></span><span></span><span></span></div>';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const docContext = state.documentContent
      ? `\n4. A Reference Document which contains expected answers/context.\n\n═══ REFERENCE MATERIAL ═══\n"""\n${state.documentContent.substring(0, 20000)}\n"""\n\nCRITICAL INSTRUCTION: You MUST grade their transcripts against this reference material. If their answer strays or misses the key facts in the document, call it out directly in your feedback!\n`
      : '';

    const systemPrompt = `You are a world-class executive communication coach and technical hiring director.
    
Your task is to review the candidate's video interview performance. You will be provided with:
1. The questions asked.
2. The exact time spent answering each question (against the allocated ${config.answerTime}s).
3. The verbatim speech transcript of their answers.
${docContext}
Provide a highly structured, deeply insightful, and professional HTML report. DO NOT use markdown code blocks (e.g., no \`\`\`html). Output strictly safe, styled HTML markup.

Please structure your response precisely with the following sections:

<div class="analysis-section" style="margin-bottom: 24px;">
  <h3 style="color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; font-size: 18px;">📈 Executive Summary & AI Score</h3>
  <p>(Give a 0-100 overall score. Summarize their core competence, delivery style, and immediate hiring readiness level.)</p>
</div>

<div class="analysis-section" style="margin-bottom: 24px;">
  <h3 style="color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; font-size: 18px;">🗣️ Transcript & Substance Deep Dive</h3>
  <p>(Critique their exact spoken words. Analyze technical accuracy, storytelling, STAR method usage, and confidence.)</p>
</div>

<div class="analysis-section" style="margin-bottom: 24px;">
  <h3 style="color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; font-size: 18px;">⏱️ Timing & Conciseness Analytics</h3>
  <p>(Analyze their pacing. Optimal answers are 50-85% of allocated time.)</p>
</div>

<div class="analysis-section" style="margin-bottom: 24px;">
  <h3 style="color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; font-size: 18px;">📋 Top 3 Actionable Strategies</h3>
  <ul style="padding-left: 20px; line-height: 1.6;">
    <li><strong style="color: var(--text-primary);">Priority 1:</strong> (Detail)</li>
    <li><strong style="color: var(--text-primary);">Priority 2:</strong> (Detail)</li>
    <li><strong style="color: var(--text-primary);">Priority 3:</strong> (Detail)</li>
  </ul>
</div>

Styling requirements:
- Emphasize critical insights using <strong style="color: #ef4444;"> for issues or <strong style="color: #10b981;"> for excellent points.
- Output ONLY the HTML, no introductory or concluding chat text.`;

    const sessionData = state.questions.map((q, i) => {
      const duration = state.answerDurations[i] || 0;
      const transcript = (state.recordings[i] && state.recordings[i].transcript) ? state.recordings[i].transcript : '[No audio captured]';
      return `### Question ${i + 1}\nPrompt: "${q.question}"\nTime Spent: ${duration}s out of ${config.answerTime}s\nSpeech Transcript:\n"""\n${transcript}\n"""\n`;
    }).join('\n\n');

    const result = await callGroqDirect([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Practice Interview Report\nTopic: ${config.topic}\nType: ${config.type}\nQuestions: ${state.questions.length}\nAllocated Time: ${config.answerTime}s per question\n\nSession Data:\n${sessionData}\n\nGenerate comprehensive, transcript-based performance analysis.` }
    ]);

    const rawAnalysis = result.choices[0].message.content;
    const clean = rawAnalysis.replace(/```(?:html|)\n([\s\S]*?)```/gi, '$1').trim();
    content.innerHTML = clean;
  } catch (err) {
    const msg = err.message || 'Something went wrong';
    content.innerHTML = `<p style="color: var(--danger); font-weight: 500;">${escapeHtml(msg)}</p>`;
    showToast(msg, { type: msg.includes('rate limit') ? 'warning' : 'error', title: msg.includes('rate limit') ? 'Rate Limit' : 'Analysis Failed' });
  }
}

// ─── New Session ────────────────────────────────────────────────
function newSession() {
  // Cleanup recordings
  state.recordings.forEach(r => URL.revokeObjectURL(r.url));
  state.recordings = [];
  state.answerDurations = [];
  state.questions = [];
  state.currentIndex = 0;
  state.phase = 'idle';
  clearInterval(state.timerInterval);

  // Stop camera
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }

  // Close audio context
  if (state.audioContext) {
    state.audioContext.close();
    state.audioContext = null;
  }

  cancelAnimationFrame(state.animFrameId);

  // Reset UI
  $('#ready-btn').disabled = true;
  $('#video-timer-overlay').style.color = '';

  showScreen('setup-screen');
}

// ─── Keyboard Shortcuts ─────────────────────────────────────────
function handleKeydown(e) {
  // Only handle during interview
  if (!$('#interview-screen').classList.contains('active')) return;

  if (e.code === 'Space' && state.phase === 'recording') {
    e.preventDefault();
    moveToNext();
  }

  if (e.code === 'Escape') {
    e.preventDefault();
    confirmEndInterview();
  }
}

// ─── Utilities ──────────────────────────────────────────────────
function getSupportedMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
    'video/mp4'
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins}m`;
  return `${mins}m ${secs}s`;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function shakeElement(el) {
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake 0.5s ease';
  el.style.borderColor = 'var(--danger)';
  setTimeout(() => {
    el.style.borderColor = '';
    el.style.animation = '';
  }, 1500);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sanitizeFilename(str) {
  return str.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 30);
}

// Add shake animation via JS
const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    20% { transform: translateX(-8px); }
    40% { transform: translateX(8px); }
    60% { transform: translateX(-4px); }
    80% { transform: translateX(4px); }
  }
`;
document.head.appendChild(shakeStyle);
