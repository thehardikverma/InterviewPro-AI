import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { readFile, unlink, mkdir } from 'fs/promises';
import { createReadStream } from 'fs';
import { createRequire } from 'module';
import { Blob } from 'buffer';
import multer from 'multer';
import Groq from 'groq-sdk';

dotenv.config();

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ─── Ensure uploads directory ──────────────────────────────────
const uploadsDir = join(__dirname, 'uploads');
await mkdir(uploadsDir, { recursive: true });

// ─── Multer Configuration ──────────────────────────────────────
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.txt', '.md', '.doc', '.docx', '.csv', '.json', '.rtf', '.webm', '.wav', '.mp3', '.m4a', '.mp4'];
    cb(null, allowed.includes(extname(file.originalname).toLowerCase()));
  }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(join(__dirname, 'public')));

// ─── Groq API Helper (With FallBack) ───────────────────────────
async function callGroq(messages, options = {}) {
  const models = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'mixtral-8x7b-32768'
  ];

  let lastError = null;

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 65000); // 65-second fail-safe timeout

      const response = await fetch(GROQ_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
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
        
        // Quietly failover to next model on strict API constraints
        if (response.status === 429 || response.status === 413 || (response.status === 400 && errorBody.includes('decommissioned'))) {
          lastError = new Error('Capacity limit or deprecation on ' + model);
          lastError.statusCode = response.status;
          console.warn(`[API] Limit or unavailable model ${model}, trying fallback...`);
          continue; 
        }

        const err = new Error(`AI service error (${response.status}): ${errorBody}`);
        err.statusCode = response.status;
        err.type = response.status === 413 ? 'content_too_long' : 'api_error';
        throw err;
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
      if (err.statusCode && err.statusCode !== 429) throw err; // Throw immediately if not rate limit
      lastError = err;
    }
  }

  // If ALL models failed, definitively throw rate limit
  lastError.message = 'API rate limit reached across all available fallback models. Please wait 1-2 minutes and try again.';
  lastError.type = 'rate_limit';
  throw lastError;
}

// ─── Document Parser ───────────────────────────────────────────
async function parseDocument(filePath, originalName) {
  const ext = extname(originalName).toLowerCase();

  try {
    switch (ext) {
      case '.pdf': {
        const pdf = require('pdf-parse');
        const buffer = await readFile(filePath);
        const data = await pdf(buffer);
        return data.text;
      }
      case '.docx': {
        const mammoth = require('mammoth');
        const result = await mammoth.extractRawText({ path: filePath });
        return result.value;
      }
      case '.json': {
        const content = await readFile(filePath, 'utf-8');
        return JSON.stringify(JSON.parse(content), null, 2);
      }
      default: {
        return await readFile(filePath, 'utf-8');
      }
    }
  } finally {
    try { await unlink(filePath); } catch { /* cleanup best-effort */ }
  }
}

// ─── Upload & Parse Document ───────────────────────────────────
app.post('/api/parse-document', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const text = await parseDocument(req.file.path, req.file.originalname);

    const maxChars = 60000;
    const truncated = text.length > maxChars;
    const content = truncated
      ? text.substring(0, maxChars) + '\n\n[Document truncated for processing...]'
      : text;

    res.json({
      success: true,
      filename: req.file.originalname,
      size: req.file.size,
      content,
      truncated,
      charCount: text.length
    });
  } catch (error) {
    console.error('Document parse error:', error);
    // Clean up file on error
    if (req.file) try { await unlink(req.file.path); } catch { /* */ }
    res.status(500).json({ error: 'Failed to parse document: ' + error.message });
  }
});

// ─── Transcribe Audio ──────────────────────────────────────────
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file uploaded' });

    const transcription = await groq.audio.transcriptions.create({
      file: createReadStream(req.file.path),
      model: "whisper-large-v3-turbo",
      response_format: "json",
    });

    res.json({ success: true, text: transcription.text });
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ error: 'Transcription failed: ' + error.message });
  } finally {
    if (req.file) try { await unlink(req.file.path); } catch { /* */ }
  }
});

// ─── Generate Interview Questions ──────────────────────────────
app.post('/api/generate-questions', async (req, res) => {
  try {
    const { topic, type, context, documentContent, count, previousQuestions } = req.body;

    // Build document reference (optimized for Groq's open-source free tiers)
    let docRef = '';
    if (documentContent) {
      const trimmed = documentContent.substring(0, 25000); // 25k chars = ~6k tokens
      docRef = `\n\nREFERENCE DOCUMENT:\n"""\n${trimmed}\n"""\nCRITICALLY: Base your questions strictly on the contents of this document. DO NOT mention "According to the document" or "In section 4". Just ask the direct question derived from the text.`;
    }

    // Build anti-repetition blacklist
    let antiRepeat = '';
    if (previousQuestions && previousQuestions.length > 0) {
      const recentQuestions = previousQuestions.slice(-50); // Last 50 questions
      antiRepeat = `\n\n⛔ PREVIOUSLY ASKED QUESTIONS (DO NOT REPEAT):\n${recentQuestions.map((q, i) => `${i + 1}. "${q}"`).join('\n')}\n\nYou MUST generate COMPLETELY NEW questions substantially different from these. Find new angles inside the text.`;
    }

    // Agentic Chain of Thought & Output Format Prompt
    let systemPrompt = `You are an elite, highly intelligent interviewer.
    
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

Interview type: ${type}
Role/Topic/Instructions: ${topic}
${context ? `Additional context from candidate: ${context}` : ''}${docRef}${antiRepeat}

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

    const result = await callGroq([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Generate exactly ${count} highly intelligent interview questions based strictly on the system rules and my instructions. ${previousQuestions?.length ? `Skip these ${previousQuestions.length} known questions.` : ''}` }
    ], {
      temperature: 0.95
    });

    const outputString = result.choices[0].message.content;
    
    // Fallback resilient JSON extraction
    const jsonMatch = outputString.match(/```json\s+([\s\S]*?)\s+```/) || outputString.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("AI failed to return proper JSON configuration.");
    
    const parsed = JSON.parse(jsonMatch[1] ? jsonMatch[1] : jsonMatch[0]);
    if (!parsed.questions || !Array.isArray(parsed.questions)) throw new Error("Invalid question structure returned.");
    res.json(parsed);
  } catch (error) {
    console.error('Error generating questions:', error);
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message, type: error.type || 'unknown' });
  }
});

// ─── Generate AI Tips & Model Answers ──────────────────────────
app.post('/api/generate-tips', async (req, res) => {
  try {
    const { topic, type, questions, documentContent } = req.body;

    const systemPrompt = `You are a world-renowned interview coach who has personally coached 10,000+ candidates into roles at top companies. You deliver transformative, specific, no-fluff coaching.

${documentContent ? `═══ REFERENCE MATERIAL ═══\n"""\n${documentContent}\n"""\n\nUse this material to provide HIGHLY SPECIFIC model answers with exact facts, figures, and concepts from the document.\n` : ''}

For EACH question, provide this structured coaching:

🎯 WHAT THEY'RE REALLY TESTING
(The hidden evaluation criteria most candidates miss)

📐 PERFECT ANSWER BLUEPRINT  
(Step-by-step structure with time allocation)

✅ MUST-HIT POINTS
(Specific content that scores top marks)

⚡ POWER MOVES
(Exact phrases and techniques that wow interviewers)

🚫 INSTANT DISQUALIFIERS
(Mistakes that immediately eliminate candidates)

⭐ GOLD-STANDARD ANSWER EXCERPT
(A brief model answer showing exactly what excellence looks like)

Also provide 7 ELITE interview strategies for ${type} interviews that most candidates don't know.

Format as polished, scannable HTML using <h3>, <h4>, <p>, <ul>, <li>, <strong>, <em> tags. Use strategic emoji placement. Be comprehensive yet concise.`;

    const questionsText = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');

    const result = await callGroq([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Topic: ${topic}\nType: ${type}\n\nQuestions:\n${questionsText}\n\nDeliver world-class coaching for every question.` }
    ]);

    const rawAnalysis = result.choices[0].message.content;
    const cleanAnalysis = rawAnalysis.replace(/```(?:html|)\n([\s\S]*?)```/gi, '$1').trim();

    res.json({ tips: cleanAnalysis });
  } catch (error) {
    console.error('Error generating tips:', error);
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message, type: error.type || 'unknown' });
  }
});

// ─── Analyze Performance ────────────────────────────────────────
app.post('/api/analyze-performance', async (req, res) => {
  try {
    const { topic, type, questions, durations, answerTime, transcripts, documentContent } = req.body;

    const systemPrompt = `You are a world-class executive communication coach and technical hiring director.
    
Your task is to review the candidate's video interview performance. You will be provided with:
1. The questions asked.
2. The exact time spent answering each question (against the allocated ${answerTime}s).
3. The verbatim speech transcript of their answers.
${documentContent ? '\n4. A Reference Document which contains expected answers/context.' : ''}

${documentContent ? `═══ REFERENCE MATERIAL ═══\n"""\n${documentContent}\n"""\n\nCRITICAL INSTRUCTION: You MUST grade their transcripts against this reference material. If their answer strays or misses the key facts in the document, call it out directly in your feedback!\n` : ''}
Provide a highly structured, deeply insightful, and professional HTML report. DO NOT use markdown code blocks (e.g., no \`\`\`html). Output strictly safe, styled HTML markup.

Please structure your response precisely with the following sections. Ensure you include their timing analytics and direct speech references:

<div class="analysis-section" style="margin-bottom: 24px;">
  <h3 style="color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; font-size: 18px;">📈 Executive Summary & AI Score</h3>
  <p>(Give a 0-100 overall score. Summarize their core competence, delivery style, and immediate hiring readiness level cleanly in a paragraph.)</p>
</div>

<div class="analysis-section" style="margin-bottom: 24px;">
  <h3 style="color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; font-size: 18px;">🗣️ Transcript & Substance Deep Dive</h3>
  <p>(Critique their exact spoken words. Analyze their technical accuracy, storytelling approach, use of the STAR method, and confidence. Note any excessive filler words or rambling using direct references to the transcripts.)</p>
</div>

<div class="analysis-section" style="margin-bottom: 24px;">
  <h3 style="color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 12px; font-size: 18px;">⏱️ Timing & Conciseness Analytics</h3>
  <p>(Analyze their pacing based on the time metrics. Optimal answers are usually 50-85% of allocated time. Be blunt about whether they rushed or over-extended. Note the specific times they spent on answers.)</p>
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
- Background, card, or box styles are not needed, just use semantic typography (h3, p, ul) with provided inline styles.
- Output ONLY the HTML, no introductory or concluding chat text.`;

    const sessionData = questions.map((q, i) => {
      const duration = durations[i] || 0;
      const transcript = (transcripts && transcripts[i]) ? transcripts[i] : '[No audio captured/detected]';
      return `### Question ${i + 1}\nPrompt: "${q}"\nTime Spent: ${duration}s out of ${answerTime}s\nSpeech Transcript:\n"""\n${transcript}\n"""\n`;
    }).join('\n\n');

    const result = await callGroq([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Practice Interview Report\nTopic: ${topic}\nType: ${type}\nQuestions: ${questions.length}\nAllocated Time: ${answerTime}s per question\n\nSession Data:\n${sessionData}\n\nGenerate comprehensive, transcript-based performance analysis.` }
    ]);

    const rawAnalysis = result.choices[0].message.content;
    const cleanAnalysis = rawAnalysis.replace(/```(?:html|)\n([\s\S]*?)```/gi, '$1').trim();

    res.json({ analysis: cleanAnalysis });
  } catch (error) {
    console.error('Error analyzing performance:', error);
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message, type: error.type || 'unknown' });
  }
});

// ─── Start Server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║                                               ║');
  console.log('  ║   🎥  InterviewPro v2.0 is LIVE!              ║');
  console.log(`  ║   🌐  http://localhost:${PORT}                    ║`);
  console.log('  ║   ✨  AI-Enhanced · Doc-Aware · Smarter       ║');
  console.log('  ║                                               ║');
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');
});
