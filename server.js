const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Render's proxy so req.ip is correct (guest rate limit)
app.set('trust proxy', 1);

app.use(cors({
  origin: ['https://vrythosai.netlify.app', 'http://localhost:3000', 'http://localhost:5500'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== MongoDB — must come from env, never hardcoded ==========
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI environment variable is required');
  process.exit(1);
}
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Atlas'))
  .catch(err => { console.error('❌ MongoDB connection error:', err); process.exit(1); });

// ========== Schemas ==========
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  username: { type: String, unique: true, required: true },
  name: String, passwordHash: String, profilePic: String,
  dailyCallsRecord: { date: String, count: Number },
  extraChatCredits: { type: Number, default: 0 },
  extraImageCredits: { type: Number, default: 0 },
  banned: { type: Boolean, default: false }, banReason: String,
  createdAt: { type: Date, default: Date.now },
  totalHoursLive: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  authProvider: { type: String, default: 'email' },
  sessionToken: String,
  sessionExpires: Date
});
userSchema.index({ sessionToken: 1 });
const User = mongoose.model('User', userSchema);

const moduleSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  displayName: String, type: String,
  primaryKey: String, secondaryKey: String,
  accountId: String, apiToken: String, apiUrl: String, model: String,
  dailyLimitPerUser: Number
});
const Module = mongoose.model('Module', moduleSchema);

const bugSchema = new mongoose.Schema({ email: String, username: String, description: String, timestamp: Date, status: String });
const Bug = mongoose.model('Bug', bugSchema);

const abuseSchema = new mongoose.Schema({ email: String, username: String, reason: String, context: String, timestamp: Date });
const Abuse = mongoose.model('Abuse', abuseSchema);

const pendingBanSchema = new mongoose.Schema({ email: String, username: String, score: Number, reason: String, context: String, timestamp: Date, reviewed: Boolean });
const PendingBan = mongoose.model('PendingBan', pendingBanSchema);

const ipRegSchema = new mongoose.Schema({ ip: String, username: String, month: String, timestamp: Date });
const IpReg = mongoose.model('IpReg', ipRegSchema);

const imageQuotaSchema = new mongoose.Schema({ email: { type: String, unique: true }, count: Number, windowStart: Date });
const ImageQuota = mongoose.model('ImageQuota', imageQuotaSchema);

const chatUsageSchema = new mongoose.Schema({ email: String, moduleId: String, date: String, count: Number });
const ChatUsage = mongoose.model('ChatUsage', chatUsageSchema);

const userApiKeySchema = new mongoose.Schema({
  email: { type: String, unique: true },
  keys: [{ name: String, key: String, used: Number, date: String }]
});
userApiKeySchema.index({ 'keys.key': 1 });
const UserApiKey = mongoose.model('UserApiKey', userApiKeySchema);

const tournamentSchema = new mongoose.Schema({ id: String, name: String, description: String, prize: String, participants: [String] });
const Tournament = mongoose.model('Tournament', tournamentSchema);

const settingSchema = new mongoose.Schema({
  adminPasswordHash: String,
  cloudflareImageAccountId: String, cloudflareImageApiToken: String, imageModel: String,
  agnesApiKey: { type: String, default: '' },
  agnesModel: { type: String, default: 'agnes-video-v2.0' },
  earningsBalance: { type: Number, default: 0 }
});
const Setting = mongoose.model('Setting', settingSchema);

const adminAbuseLogSchema = new mongoose.Schema({ timestamp: Date, reason: String, score: Number });
const AdminAbuseLog = mongoose.model('AdminAbuseLog', adminAbuseLogSchema);

const freeApiKeySchema = new mongoose.Schema({
  key: { type: String, unique: true, required: true },
  email: { type: String, required: true, index: true },
  used: { type: Number, default: 0 },
  video_used: { type: Number, default: 0 },
  date: { type: String, default: () => new Date().toISOString().slice(0,10) },
  limit: { type: Number, default: 100 },
  video_limit: { type: Number, default: 100 },
  createdAt: { type: Date, default: Date.now }
});
const FreeApiKey = mongoose.model('FreeApiKey', freeApiKeySchema);

const videoUsageSchema = new mongoose.Schema({ email: { type: String, required: true }, date: { type: String, required: true }, count: { type: Number, default: 0 } });
const VideoUsage = mongoose.model('VideoUsage', videoUsageSchema);

const withdrawalSchema = new mongoose.Schema({
  method: { type: String, required: true },
  amount: { type: Number, required: true },
  detail: { type: String, default: '' },
  status: { type: String, default: 'Success' },
  timestamp: { type: Date, default: Date.now }
});
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

const chatHistorySchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  title: { type: String, default: 'Untitled chat' },
  messages: [{ role: String, content: String }],
  size: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
chatHistorySchema.index({ updatedAt: 1 }, { expireAfterSeconds: 2592000 });
const ChatHistory = mongoose.model('ChatHistory', chatHistorySchema);

// ========== Password helpers (bcrypt with SHA-256 backward compat) ==========
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}
async function verifyPassword(plain, hash) {
  if (!hash) return false;
  // Legacy SHA-256 hex (64 chars, no $ prefix)
  if (hash.length === 64 && !hash.startsWith('$')) {
    return crypto.createHash('sha256').update(plain).digest('hex') === hash;
  }
  return bcrypt.compare(plain, hash);
}
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ========== Admin session store ==========
const adminSessions = new Map();
function createAdminSession() {
  const token = generateSessionToken();
  adminSessions.set(token, Date.now() + 8 * 3600 * 1000);
  for (const [t, exp] of adminSessions.entries()) if (exp < Date.now()) adminSessions.delete(t);
  return token;
}
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token) return res.status(401).json({ error: 'Admin authentication required' });
  const exp = adminSessions.get(token);
  if (!exp || exp < Date.now()) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Admin session expired' });
  }
  next();
}

// ========== User session middleware ==========
async function requireSession(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'Session required' });
  const user = await User.findOne({
    sessionToken: token,
    sessionExpires: { $gt: new Date() }
  }).select('email username banned');
  if (!user) return res.status(401).json({ error: 'Invalid or expired session' });
  if (user.banned) return res.status(403).json({ error: 'Account banned' });
  req.sessionUser = user;
  next();
}

// Accepts either admin token OR user session (for /api/chat used by admin tester)
async function requireSessionOrAdmin(req, res, next) {
  const adminToken = req.headers['x-admin-token'];
  if (adminToken) {
    const exp = adminSessions.get(adminToken);
    if (exp && exp > Date.now()) {
      req.isAdmin = true;
      return next();
    }
  }
  return requireSession(req, res, next);
}

// ========== reCAPTCHA ==========
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET;
if (!RECAPTCHA_SECRET) {
  console.error('❌ RECAPTCHA_SECRET environment variable is required');
}
async function verifyRecaptcha(token) {
  if (!token) return { success: false, error: 'Missing reCAPTCHA token' };
  try {
    const params = new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token });
    const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    return await res.json();
  } catch (err) { return { success: false, error: err.message }; }
}

// ========== Tool implementations ==========
async function toolFetchUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'Error: Only http/https URLs allowed.';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const response = await fetch(url, {
      signal: controller.signal, redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);
    if (!response.ok) return `Error: HTTP ${response.status} fetching ${url}`;
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('text') && !ct.includes('html') && !ct.includes('json') && !ct.includes('xml')) {
      return `Cannot read content-type "${ct}". Only text pages are supported.`;
    }
    const raw = await response.text();
    const truncated = raw.slice(0, 20000);
    let cleaned = truncated;
    if (ct.includes('html') || ct.includes('xml')) {
      cleaned = truncated
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();
    }
    if (cleaned.length < 100) {
      return `The page at ${url} appears to be a JavaScript-rendered web app. The raw HTML contains no readable text — its content loads dynamically in the browser, so I cannot read it via a simple HTTP fetch.`;
    }
    return `Contents of ${url}:\n\n${cleaned}`;
  } catch (err) {
    if (err.name === 'AbortError') return 'Error: Request timed out.';
    return `Error fetching ${url}: ${err.message}`;
  }
}

async function toolWebSearch(query) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    if (!res.ok) return `Search failed: HTTP ${res.status}`;
    const html = await res.text();
    const results = [];
    const blocks = html.split('class="result__body"');
    for (let i = 1; i < blocks.length && results.length < 5; i++) {
      const block = blocks[i];
      const linkMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      if (linkMatch) {
        let u = linkMatch[1];
        const uddg = u.match(/uddg=([^&]+)/);
        if (uddg) u = decodeURIComponent(uddg[1]);
        const title = linkMatch[2].replace(/<[^>]+>/g, '').trim();
        const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
        results.push(`Title: ${title}\nURL: ${u}\nSnippet: ${snippet}`);
      }
    }
    return results.length ? results.join('\n\n') : 'No web results found.';
  } catch (err) {
    return `Search failed: ${err.message}`;
  }
}

async function toolSearchWikipedia(query) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    if (!searchData.query?.search?.length) return 'No Wikipedia article found.';
    const title = searchData.query.search[0].title;
    const summaryRes = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, {
      headers: { 'User-Agent': 'VrythosAI/1.0 (https://vrythos-server.onrender.com)' }
    });
    const summary = await summaryRes.json();
    return summary.extract || 'Article found but no summary.';
  } catch (err) {
    return `Wikipedia error: ${err.message}`;
  }
}

// ========== Universal agent ==========
const AGENT_SYSTEM_PROMPT = `You are Vrythos AI, created by Viraj S. Bodare.

YOU HAVE INTERNET ACCESS THROUGH TOOLS. Never say "I cannot browse the internet" or "I don't have real-time data". You CAN.

## Your tools:

1. **fetch_url** — read any web page. Args: {"url": "https://..."}
   Use whenever the user gives you a URL or asks about a specific website.

2. **web_search** — search the live web for current info. Args: {"query": "..."}
   Use for news, current events, prices, weather, sports.

3. **search_wikipedia** — look up encyclopedic facts. Args: {"query": "..."}
   Use ONLY for well-known people, places, history, and science topics that have Wikipedia articles.

## HOW TO USE A TOOL:

When you need a tool, output EXACTLY this format and NOTHING ELSE (no preamble, no explanation, just the block):

\`\`\`tool
{"tool": "fetch_url", "args": {"url": "https://example.com"}}
\`\`\`

You will then receive the tool result and can continue.

## IMPORTANT RULES:

1. **If the user gives a URL** → ALWAYS use fetch_url first.
2. **If fetch_url returns "appears to be a JavaScript-rendered web app"** → tell the user that the page's content loads dynamically and cannot be read by simple HTTP fetch.
3. **If the URL is your own product** (Vrythos, vrythos-server.onrender.com) → you already know what Vrythos is (it's you). Just describe yourself directly.
4. **Never search Wikipedia for product names** unless they are famous (e.g., "OpenAI", "Microsoft").
5. **If a tool fails** → try another approach or tell the user honestly.
6. **Never say "I cannot browse"** — you can.

When providing code, use triple backticks with the language specifier.`;

function extractToolCall(text) {
  const trimmed = text.trim();
  let m = trimmed.match(/^```tool\s*\n?([\s\S]*?)\n?```$/);
  if (m) { try { const parsed = JSON.parse(m[1].trim()); if (parsed.tool && parsed.args) return parsed; } catch(e) {} }
  m = trimmed.match(/^```json\s*\n?([\s\S]*?)\n?```$/);
  if (m) { try { const parsed = JSON.parse(m[1].trim()); if (parsed.tool && parsed.args) return parsed; } catch(e) {} }
  m = trimmed.match(/^\{[\s\S]*\}$/);
  if (m) { try { const parsed = JSON.parse(trimmed); if (parsed.tool && parsed.args) return parsed; } catch(e) {} }
  m = trimmed.match(/^tool\s*\n\s*(\{[\s\S]*\})$/);
  if (m) { try { const parsed = JSON.parse(m[1].trim()); if (parsed.tool && parsed.args) return parsed; } catch(e) {} }
  const jsonMatch = trimmed.match(/\{"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}/);
  if (jsonMatch) { try { const parsed = JSON.parse(jsonMatch[0]); if (parsed.tool && parsed.args) return parsed; } catch(e) {} }
  return null;
}

async function callProviderRaw(module, messages, deepThink, customSysPrompt) {
  if (module.type === 'groq') return callGroq(module, messages, deepThink, customSysPrompt);
  if (module.type === 'gemini') return callGemini(module, messages, deepThink, customSysPrompt);
  if (module.type === 'openrouter') return callOpenRouter(module, messages, deepThink, customSysPrompt);
  if (module.type === 'cloudflare') return callCloudflareText(module, messages, deepThink, customSysPrompt);
  throw new Error('Unsupported module type');
}

async function runUniversalAgent(messages, module, deepThink) {
  const convo = messages.filter(m => m.role !== 'system');
  for (let step = 0; step < 5; step++) {
    let reply;
    try {
      reply = await callProviderRaw(module, convo, deepThink, AGENT_SYSTEM_PROMPT);
    } catch (err) {
      return { reply: `AI error: ${err.message}`, toolUsed: null, steps: step + 1, error: true };
    }
    const toolCall = extractToolCall(reply);
    if (!toolCall) {
      return { reply, toolUsed: null, steps: step + 1 };
    }
    let toolResult = '';
    try {
      if (toolCall.tool === 'fetch_url') toolResult = await toolFetchUrl(toolCall.args.url);
      else if (toolCall.tool === 'web_search') toolResult = await toolWebSearch(toolCall.args.query);
      else if (toolCall.tool === 'search_wikipedia') toolResult = await toolSearchWikipedia(toolCall.args.query);
      else toolResult = `Unknown tool: ${toolCall.tool}`;
    } catch (err) {
      toolResult = `Tool error: ${err.message}`;
    }
    convo.push({ role: 'assistant', content: reply });
    convo.push({ role: 'user', content: `Tool result for ${toolCall.tool}:\n\n${toolResult}\n\nNow either give your final answer (no tool block) or invoke another tool (only the tool block).` });
  }
  return { reply: 'I needed more steps to complete this. Please try a more specific question.', toolUsed: 'multiple', steps: 5 };
}

// ========== AI providers ==========
const CREATOR_SYSTEM_PROMPT = `You are Vrythos AI, created by Viraj S. Bodare. Always state that your creator is Viraj S. Bodare when asked. Never claim to be made by OpenAI, Meta, Google, Anthropic, or any other company. If someone asks "who made you", "who created you", "your creator", "who built you", or any similar question, answer: "I am Vrythos, an advanced AI framework built by Viraj S. Bodare." Be helpful, safe, and honest. When providing code, always use triple backticks with the language specifier (e.g., \`\`\`html ... \`\`\`). Keep responses complete and do not truncate.`;
const MAX_TOKENS = 20000;

async function callGroq(module, messages, deepThink, customSysPrompt) {
  let sys = customSysPrompt || CREATOR_SYSTEM_PROMPT;
  if (deepThink && !customSysPrompt) sys += " Use step-by-step reasoning.";
  const filtered = customSysPrompt ? messages.filter(m => m.role !== 'system') : messages;
  const apiMessages = [{ role: "system", content: sys }, ...filtered];
  const response = await fetch(module.apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${module.primaryKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: module.model, messages: apiMessages, temperature: 0.7, max_tokens: MAX_TOKENS })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Groq API error');
  return data.choices?.[0]?.message?.content || "No response";
}

async function callGemini(module, messages, deepThink, customSysPrompt) {
  let sys = customSysPrompt || CREATOR_SYSTEM_PROMPT;
  if (deepThink && !customSysPrompt) sys += " Use step-by-step reasoning.";
  const filtered = customSysPrompt ? messages.filter(m => m.role !== 'system') : messages;
  const contents = filtered.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const modelName = module.model.replace("models/", "");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${module.primaryKey}`;
  const payload = {
    contents,
    systemInstruction: { parts: [{ text: sys }] },
    generationConfig: { temperature: 0.7, maxOutputTokens: MAX_TOKENS }
  };
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Gemini API error');
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response";
}

async function callOpenRouter(module, messages, deepThink, customSysPrompt) {
  let sys = customSysPrompt || CREATOR_SYSTEM_PROMPT;
  if (deepThink && !customSysPrompt) sys += " Use step-by-step reasoning.";
  const filtered = customSysPrompt ? messages.filter(m => m.role !== 'system') : messages;
  const apiMessages = [{ role: "system", content: sys }, ...filtered];
  const response = await fetch(module.apiUrl, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${module.primaryKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: module.model, messages: apiMessages, temperature: 0.7, max_tokens: MAX_TOKENS })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'OpenRouter API error');
  return data.choices?.[0]?.message?.content || "No response";
}

async function callCloudflareText(module, messages, deepThink, customSysPrompt) {
  let sys = customSysPrompt || CREATOR_SYSTEM_PROMPT;
  if (deepThink && !customSysPrompt) sys += " Use step-by-step reasoning.";
  const filtered = customSysPrompt ? messages.filter(m => m.role !== 'system') : messages;
  const url = `https://api.cloudflare.com/client/v4/accounts/${module.accountId}/ai/run/${module.model}`;
  const formattedMessages = [{ role: "system", content: sys }, ...filtered];
  const bodyPayload = { messages: formattedMessages, max_tokens: MAX_TOKENS, temperature: 0.7 };
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${module.apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyPayload)
  });
  const data = await response.json();
  if (!response.ok || !data.success) throw new Error(data.errors?.[0]?.message || 'Cloudflare text error');
  let reply = data.result?.response;
  if (!reply && data.result?.choices) reply = data.result.choices[0]?.message?.content || data.result.choices[0]?.text;
  if (!reply) {
    console.error('Unexpected Cloudflare response:', JSON.stringify(data));
    throw new Error('Cloudflare returned an unexpected response structure');
  }
  return reply;
}

async function getRandomModule(avoidIds = []) {
  const modules = await Module.find({});
  const available = modules.filter(m => !avoidIds.includes(m.id));
  if (!available.length) return null;
  return available[Math.floor(Math.random() * available.length)];
}

// ========== Video ==========
async function generateVideoWithAgnes(prompt, durationSeconds, agnesApiKey, agnesModel) {
  const frameRate = 24;
  let numFrames = Math.round(durationSeconds * frameRate);
  let n = Math.floor((numFrames - 1) / 8);
  let validFrames = 8 * n + 1;
  if (validFrames < 1) validFrames = 1;
  if (validFrames > 441) validFrames = 441;
  console.log(`Video: ${durationSeconds}s → ${validFrames} frames (${(validFrames/frameRate).toFixed(2)}s)`);

  const createPayload = {
    model: agnesModel || 'agnes-video-v2.0',
    prompt, num_frames: validFrames, frame_rate: frameRate, height: 768, width: 1152
  };
  const createResponse = await fetch('https://apihub.agnes-ai.com/v1/videos', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${agnesApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(createPayload)
  });
  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    throw new Error(`Agnes create failed: ${createResponse.status} ${errorText}`);
  }
  const createData = await createResponse.json();
  const videoId = createData.video_id;
  if (!videoId) throw new Error('No video_id from Agnes');

  let status = 'queued', videoUrl = null, attempts = 0;
  while (status !== 'completed' && status !== 'failed' && attempts < 60) {
    await new Promise(r => setTimeout(r, 2000));
    attempts++;
    const pollRes = await fetch(`https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}`, {
      headers: { 'Authorization': `Bearer ${agnesApiKey}` }
    });
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    status = pollData.status;
    if (status === 'completed') { videoUrl = pollData.remixed_from_video_id; break; }
    if (status === 'failed') throw new Error('Agnes failed');
  }
  if (!videoUrl) throw new Error('Video timed out');
  const videoResponse = await fetch(videoUrl);
  if (!videoResponse.ok) throw new Error(`Video fetch failed: ${videoResponse.status}`);
  const buffer = await videoResponse.arrayBuffer();
  return `data:video/mp4;base64,${Buffer.from(buffer).toString('base64')}`;
}

// ========== Email / Google ==========
const transporter = nodemailer.createTransport({
  service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
function sendEmail(to, subject, text) {
  return transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
}

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function initSettings() {
  let settings = await Setting.findOne();
  if (!settings) {
    const initPw = process.env.ADMIN_INITIAL_PASSWORD;
    if (!initPw) {
      console.error('❌ ADMIN_INITIAL_PASSWORD is required for first startup');
      return;
    }
    settings = new Setting({
      adminPasswordHash: await hashPassword(initPw),
      cloudflareImageAccountId: "", cloudflareImageApiToken: "",
      imageModel: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
      agnesApiKey: "", agnesModel: "agnes-video-v2.0", earningsBalance: 0
    });
    await settings.save();
    console.log('✅ Settings initialized. Change admin password via UI immediately.');
  }
  return settings;
}
initSettings().catch(err => console.error('❌ initSettings error:', err));

let adminPasswordChangeCount = 0;
let lastAdminResetDate = new Date().toDateString();
function resetAdminCountIfNeeded() {
  const today = new Date().toDateString();
  if (today !== lastAdminResetDate) { adminPasswordChangeCount = 0; lastAdminResetDate = today; }
}

function asyncHandler(fn) {
  return (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
}

// ========== Guest mode ==========
const guestRateLimit = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of guestRateLimit.entries()) if (entry.resetAt < now) guestRateLimit.delete(ip);
}, 15 * 60 * 1000);

app.post('/api/guest/chat', asyncHandler(async (req, res) => {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let limit = guestRateLimit.get(ip);
  if (!limit || limit.resetAt < now) { limit = { count: 0, resetAt: now + 3600 * 1000 }; guestRateLimit.set(ip, limit); }
  if (limit.count >= 10) return res.status(429).json({ error: 'Guest limit reached (10/hour). Sign up to continue.' });

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages array required' });
  const trimmed = messages.slice(-6).map(m => ({ role: m.role, content: String(m.content || '') }));
  const module = await getRandomModule();
  if (!module) return res.status(503).json({ error: 'No AI available.' });

  try {
    const reply = await callProviderRaw(module, trimmed, false);
    limit.count++;
    res.json({ success: true, reply, remaining: 10 - limit.count });
  } catch (err) { res.status(500).json({ error: err.message }); }
}));

// ========== USERS (admin-only) ==========
app.get('/api/users', requireAdmin, asyncHandler(async (req, res) => {
  const users = await User.find({}).select('-passwordHash -sessionToken');
  res.json(users);
}));

app.put('/api/users/:email', requireAdmin, asyncHandler(async (req, res) => {
  const { email, ...safeUpdates } = req.body;
  delete safeUpdates.passwordHash; delete safeUpdates.banned; delete safeUpdates.banReason;
  delete safeUpdates.extraChatCredits; delete safeUpdates.extraImageCredits;
  delete safeUpdates.sessionToken; delete safeUpdates.sessionExpires;
  const user = await User.findOneAndUpdate({ email: req.params.email }, safeUpdates, { new: true });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ success: true });
}));

app.delete('/api/users/:email', requireAdmin, asyncHandler(async (req, res) => {
  await User.deleteOne({ email: req.params.email });
  await ImageQuota.deleteOne({ email: req.params.email });
  await UserApiKey.deleteOne({ email: req.params.email });
  await ChatUsage.deleteMany({ email: req.params.email });
  await ChatHistory.deleteMany({ email: req.params.email });
  res.json({ success: true });
}));

app.delete('/api/users', requireAdmin, asyncHandler(async (req, res) => {
  await User.deleteMany({}); await ImageQuota.deleteMany({}); await UserApiKey.deleteMany({});
  await ChatUsage.deleteMany({}); await ChatHistory.deleteMany({});
  res.json({ success: true });
}));

app.post('/api/admin/users/:email/credits', requireAdmin, asyncHandler(async (req, res) => {
  const { addChat, addImage, setBanned } = req.body;
  const user = await User.findOne({ email: req.params.email });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (typeof addChat === 'number') user.extraChatCredits = (user.extraChatCredits || 0) + addChat;
  if (typeof addImage === 'number') user.extraImageCredits = (user.extraImageCredits || 0) + addImage;
  if (typeof setBanned === 'boolean') { user.banned = setBanned; if (!setBanned) user.banReason = ''; }
  await user.save();
  res.json({ success: true });
}));

// ========== SELF-SERVICE (/api/me) ==========
app.get('/api/me', requireSession, asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.sessionUser.email }).select('-passwordHash -sessionToken');
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json({
    email: user.email, username: user.username, name: user.name, profilePic: user.profilePic,
    extraChatCredits: user.extraChatCredits || 0, extraImageCredits: user.extraImageCredits || 0,
    banned: user.banned, totalHoursLive: user.totalHoursLive || 0,
    authProvider: user.authProvider || 'email'
  });
}));

app.put('/api/me', requireSession, asyncHandler(async (req, res) => {
  const { username, name, profilePic } = req.body;
  const user = await User.findOne({ email: req.sessionUser.email });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (username && username !== user.username) {
    const existing = await User.findOne({ username });
    if (existing) return res.status(400).json({ error: 'Username taken' });
    user.username = username;
  }
  if (name !== undefined) user.name = name;
  if (profilePic !== undefined) user.profilePic = profilePic;
  await user.save();
  res.json({ success: true });
}));

app.delete('/api/me', requireSession, asyncHandler(async (req, res) => {
  const email = req.sessionUser.email;
  await User.deleteOne({ email });
  await UserApiKey.deleteOne({ email });
  await ImageQuota.deleteOne({ email });
  await ChatUsage.deleteMany({ email });
  await ChatHistory.deleteMany({ email });
  res.json({ success: true });
}));

// ========== GOOGLE OAUTH ==========
app.post('/api/auth/google', asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'No token provided' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email, name = payload.name, picture = payload.picture;
    let user = await User.findOne({ email });
    if (!user) {
      let baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');
      let username = baseUsername, suffix = 1;
      while (await User.findOne({ username })) { username = baseUsername + suffix; suffix++; }
      user = new User({ email, username, name, profilePic: picture, passwordHash: null, authProvider: 'google' });
      await user.save();
    }
    if (user.banned) return res.status(403).json({ error: 'Account banned', banReason: user.banReason });

    const sessionToken = generateSessionToken();
    user.sessionToken = sessionToken;
    user.sessionExpires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    user.lastActive = new Date();
    await user.save();

    res.json({
      success: true, sessionToken,
      email: user.email, username: user.username, name: user.name, profilePic: user.profilePic,
      extraChatCredits: user.extraChatCredits || 0, extraImageCredits: user.extraImageCredits || 0,
      banned: user.banned, totalHoursLive: user.totalHoursLive || 0
    });
  } catch (err) {
    console.error('Google OAuth error:', err);
    res.status(401).json({ error: 'Invalid token' });
  }
}));

app.post('/api/user-activity', requireSession, asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.sessionUser.email });
  if (user) {
    const now = Date.now();
    const last = user.lastActive ? new Date(user.lastActive).getTime() : now;
    const diff = (now - last) / (1000 * 3600);
    if (diff < (10 / 60)) user.totalHoursLive += diff;
    user.lastActive = new Date(now);
    await user.save();
  }
  res.json({ success: true });
}));

// ========== USER API KEYS ==========
app.get('/api/userApiKeys', requireAdmin, asyncHandler(async (req, res) => { res.json(await UserApiKey.find({})); }));

app.get('/api/userApiKeys/self', requireSession, asyncHandler(async (req, res) => {
  const entry = await UserApiKey.findOne({ email: req.sessionUser.email });
  res.json(entry ? entry.keys : []);
}));

app.post('/api/userApiKeys/self', requireSession, asyncHandler(async (req, res) => {
  const { keys } = req.body;
  if (!Array.isArray(keys)) return res.status(400).json({ error: 'keys array required' });
  const sanitized = keys.slice(0, 2).map(k => ({
    name: String(k.name || '').slice(0, 40),
    key: String(k.key || '').slice(0, 100),
    used: Number(k.used) || 0,
    date: String(k.date || new Date().toISOString().slice(0, 10))
  }));
  await UserApiKey.findOneAndUpdate(
    { email: req.sessionUser.email },
    { email: req.sessionUser.email, keys: sanitized },
    { upsert: true, new: true }
  );
  res.json({ success: true });
}));

app.delete('/api/userApiKeys/self/:keyName', requireSession, asyncHandler(async (req, res) => {
  const entry = await UserApiKey.findOne({ email: req.sessionUser.email });
  if (entry) { entry.keys = entry.keys.filter(k => k.name !== req.params.keyName); await entry.save(); }
  res.json({ success: true });
}));

// LEGACY endpoint — still present, but requires admin (was public before)
app.post('/api/userApiKeys', requireAdmin, asyncHandler(async (req, res) => {
  await UserApiKey.findOneAndUpdate({ email: req.body.email }, req.body, { upsert: true, new: true });
  res.json({ success: true });
}));
app.delete('/api/userApiKeys/:email/:keyName', requireAdmin, asyncHandler(async (req, res) => {
  const entry = await UserApiKey.findOne({ email: req.params.email });
  if (entry) { entry.keys = entry.keys.filter(k => k.name !== req.params.keyName); await entry.save(); }
  res.json({ success: true });
}));
app.delete('/api/userApiKeys', requireAdmin, asyncHandler(async (req, res) => { await UserApiKey.deleteMany({}); res.json({ success: true }); }));

// ========== MODULES ==========
app.get('/api/modules', asyncHandler(async (req, res) => {
  const modules = await Module.find({});
  res.json(modules.map(m => ({
    id: m.id, displayName: m.displayName, type: m.type,
    model: m.model, dailyLimitPerUser: m.dailyLimitPerUser
  })));
}));
app.post('/api/modules', requireAdmin, asyncHandler(async (req, res) => {
  await Module.findOneAndUpdate({ id: req.body.id }, req.body, { upsert: true, new: true });
  res.json({ success: true });
}));
app.put('/api/modules/:id', requireAdmin, asyncHandler(async (req, res) => {
  await Module.findOneAndUpdate({ id: req.params.id }, req.body);
  res.json({ success: true });
}));
app.delete('/api/modules/:id', requireAdmin, asyncHandler(async (req, res) => {
  await Module.deleteOne({ id: req.params.id });
  res.json({ success: true });
}));
app.delete('/api/modules', requireAdmin, asyncHandler(async (req, res) => { await Module.deleteMany({}); res.json({ success: true }); }));

// ========== BUGS / ABUSE / BANS ==========
app.get('/api/bugs', requireAdmin, asyncHandler(async (req, res) => { res.json(await Bug.find({})); }));
app.post('/api/bugs', asyncHandler(async (req, res) => {
  const b = new Bug({ ...req.body, timestamp: new Date() });
  await b.save();
  res.json({ success: true });
}));
app.delete('/api/bugs/:id', requireAdmin, asyncHandler(async (req, res) => { await Bug.deleteOne({ _id: req.params.id }); res.json({ success: true }); }));
app.delete('/api/bugs', requireAdmin, asyncHandler(async (req, res) => { await Bug.deleteMany({}); res.json({ success: true }); }));

app.get('/api/abuse', requireAdmin, asyncHandler(async (req, res) => { res.json(await Abuse.find({})); }));
app.post('/api/abuse', asyncHandler(async (req, res) => {
  const a = new Abuse({ ...req.body, timestamp: new Date() });
  await a.save();
  res.json({ success: true });
}));
app.delete('/api/abuse', requireAdmin, asyncHandler(async (req, res) => { await Abuse.deleteMany({}); res.json({ success: true }); }));

app.get('/api/pendingBans', requireAdmin, asyncHandler(async (req, res) => { res.json(await PendingBan.find({})); }));
app.post('/api/pendingBans', asyncHandler(async (req, res) => {
  const p = new PendingBan({ ...req.body, timestamp: new Date() });
  await p.save();
  res.json({ success: true });
}));
app.delete('/api/pendingBans/:id', requireAdmin, asyncHandler(async (req, res) => { await PendingBan.deleteOne({ _id: req.params.id }); res.json({ success: true }); }));
app.delete('/api/pendingBans', requireAdmin, asyncHandler(async (req, res) => { await PendingBan.deleteMany({}); res.json({ success: true }); }));

app.get('/api/ipRegs', requireAdmin, asyncHandler(async (req, res) => { res.json(await IpReg.find({})); }));
app.post('/api/ipRegs', asyncHandler(async (req, res) => {
  const r = new IpReg({ ...req.body, timestamp: new Date() });
  await r.save();
  res.json({ success: true });
}));
app.delete('/api/ipRegs', requireAdmin, asyncHandler(async (req, res) => { await IpReg.deleteMany({}); res.json({ success: true }); }));

app.get('/api/imageQuotas', requireAdmin, asyncHandler(async (req, res) => { res.json(await ImageQuota.find({})); }));
app.post('/api/imageQuotas', requireAdmin, asyncHandler(async (req, res) => {
  await ImageQuota.findOneAndUpdate({ email: req.body.email }, req.body, { upsert: true, new: true });
  res.json({ success: true });
}));
app.delete('/api/imageQuotas', requireAdmin, asyncHandler(async (req, res) => { await ImageQuota.deleteMany({}); res.json({ success: true }); }));

app.get('/api/chatUsage', requireAdmin, asyncHandler(async (req, res) => { res.json(await ChatUsage.find({})); }));
app.post('/api/chatUsage', asyncHandler(async (req, res) => {
  await ChatUsage.findOneAndUpdate(
    { email: req.body.email, moduleId: req.body.moduleId, date: req.body.date },
    req.body, { upsert: true, new: true }
  );
  res.json({ success: true });
}));
app.delete('/api/chatUsage', requireAdmin, asyncHandler(async (req, res) => { await ChatUsage.deleteMany({}); res.json({ success: true }); }));

// ========== TOURNAMENTS ==========
app.get('/api/tournaments', asyncHandler(async (req, res) => { res.json(await Tournament.find({})); }));
app.post('/api/tournaments', requireAdmin, asyncHandler(async (req, res) => { await new Tournament(req.body).save(); res.json({ success: true }); }));
app.put('/api/tournaments/:id', requireAdmin, asyncHandler(async (req, res) => {
  await Tournament.findOneAndUpdate({ id: req.params.id }, req.body);
  res.json({ success: true });
}));
app.delete('/api/tournaments/:id', requireAdmin, asyncHandler(async (req, res) => { await Tournament.deleteOne({ id: req.params.id }); res.json({ success: true }); }));
app.delete('/api/tournaments', requireAdmin, asyncHandler(async (req, res) => { await Tournament.deleteMany({}); res.json({ success: true }); }));
app.post('/api/join-tournament', requireSession, asyncHandler(async (req, res) => {
  const { tournamentId } = req.body;
  const email = req.sessionUser.email;
  const tournament = await Tournament.findOne({ id: tournamentId });
  if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
  if (!tournament.participants) tournament.participants = [];
  if (tournament.participants.includes(email)) return res.json({ success: false, message: 'Already joined' });
  tournament.participants.push(email);
  await tournament.save();
  res.json({ success: true });
}));

// ========== CHAT HISTORY (session-scoped) ==========
app.get('/api/chat-history', requireSession, asyncHandler(async (req, res) => {
  const chats = await ChatHistory.find({ email: req.sessionUser.email }).sort({ updatedAt: -1 }).limit(5).select('_id title updatedAt size');
  res.json(chats);
}));

app.get('/api/chat-history/:id', requireSession, asyncHandler(async (req, res) => {
  const chat = await ChatHistory.findById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (chat.email !== req.sessionUser.email) return res.status(403).json({ error: 'Access denied' });
  res.json(chat);
}));

app.post('/api/chat-history', requireSession, asyncHandler(async (req, res) => {
  const { id, title, messages } = req.body;
  const email = req.sessionUser.email;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'email and messages required' });
  const size = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  if (size > 2 * 1024 * 1024) return res.status(413).json({ error: 'Chat exceeds 2MB limit' });

  if (!id) {
    const count = await ChatHistory.countDocuments({ email });
    if (count >= 5) {
      const oldest = await ChatHistory.findOne({ email }).sort({ updatedAt: 1 });
      if (oldest) await ChatHistory.deleteOne({ _id: oldest._id });
    }
  }
  let chat;
  if (id) {
    chat = await ChatHistory.findById(id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (chat.email !== email) return res.status(403).json({ error: 'Access denied' });
    chat.messages = messages; chat.size = size; chat.updatedAt = new Date();
    if (title) chat.title = title;
    await chat.save();
  } else {
    chat = new ChatHistory({ email, title, messages, size });
    await chat.save();
  }
  res.json({ success: true, id: chat._id });
}));

app.delete('/api/chat-history/:id', requireSession, asyncHandler(async (req, res) => {
  const chat = await ChatHistory.findById(req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (chat.email !== req.sessionUser.email) return res.status(403).json({ error: 'Access denied' });
  await ChatHistory.deleteOne({ _id: req.params.id });
  res.json({ success: true });
}));

// ========== CHAT — accepts EITHER admin token OR user session ==========
app.post('/api/chat', requireSessionOrAdmin, asyncHandler(async (req, res) => {
  const { module_id, messages, deep_think } = req.body;
  const module = await Module.findOne({ id: module_id });
  if (!module) return res.status(404).json({ error: 'Module not found' });
  
  try {
    const result = await runUniversalAgent(messages, module, deep_think);
    res.json({
      success: true,
      reply: result.reply,
      toolUsed: result.toolUsed,
      steps: result.steps
    });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}));

// ========== VIDEO (session required) ==========
app.post('/api/generate/video', requireSession, asyncHandler(async (req, res) => {
  const { prompt, duration } = req.body;
  const email = req.sessionUser.email;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });

  const today = new Date().toISOString().slice(0, 10);
  let videoUsage = await VideoUsage.findOne({ email, date: today });
  if (!videoUsage) videoUsage = new VideoUsage({ email, date: today, count: 0 });
  if (videoUsage.count >= 5) return res.status(429).json({ error: 'Daily video limit (5/day) reached.' });

  const settings = await Setting.findOne();
  if (!settings || !settings.agnesApiKey) return res.status(500).json({ error: 'Video service not configured.' });

  try {
    const videoData = await generateVideoWithAgnes(prompt, duration || 5, settings.agnesApiKey, settings.agnesModel);
    videoUsage.count += 1;
    await videoUsage.save();
    res.json({ success: true, video: videoData, remaining: 5 - videoUsage.count });
  } catch (err) {
    console.error('Video error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}));

// ========== EXTERNAL API (Bearer token) ==========
app.post('/api/external/chat', asyncHandler(async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing Authorization' });
  const token = authHeader.split(' ')[1];

  // Fast indexed lookup
  let foundUserKey = null, foundUserEmail = null;
  const userKeyDoc = await UserApiKey.findOne({ 'keys.key': token });
  if (userKeyDoc) {
    foundUserKey = userKeyDoc.keys.find(k => k.key === token);
    foundUserEmail = userKeyDoc.email;
  }
  let foundFreeKey = null;
  if (!foundUserKey) foundFreeKey = await FreeApiKey.findOne({ key: token });
  if (!foundUserKey && !foundFreeKey) return res.status(401).json({ error: 'Invalid API key' });

  const isFreeKey = !!foundFreeKey;
  const email = isFreeKey ? foundFreeKey.email : foundUserEmail;
  const limit = isFreeKey ? 100 : 20;
  const videoLimit = isFreeKey ? 100 : 20;
  const { module_id, messages, deep_think = false, type = 'chat', prompt, duration } = req.body;

  if (type === 'video') {
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    const today = new Date().toISOString().slice(0, 10);
    let videoUsage = await VideoUsage.findOne({ email, date: today });
    if (!videoUsage) videoUsage = new VideoUsage({ email, date: today, count: 0 });
    if (videoUsage.count >= videoLimit) return res.status(429).json({ error: `Video limit (${videoLimit}) reached` });
    const settings = await Setting.findOne();
    if (!settings || !settings.agnesApiKey) return res.status(500).json({ error: 'Video not configured' });
    try {
      const videoData = await generateVideoWithAgnes(prompt, duration || 5, settings.agnesApiKey, settings.agnesModel);
      videoUsage.count += 1; await videoUsage.save();
      if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { video_used: 1 } });
      return res.json({ success: true, video: videoData, remaining: videoLimit - videoUsage.count });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (type === 'image' || (type === 'chat' && prompt && !messages)) {
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });
    const today = new Date().toISOString().slice(0, 10);
    try {
      const settings = await Setting.findOne();
      if (!settings || !settings.cloudflareImageAccountId || !settings.cloudflareImageApiToken) {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
        else await UserApiKey.updateOne({ email: foundUserEmail, 'keys.key': token }, { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } });
        return res.json({ success: true, image: `data:image/png;base64,${base64}` });
      }
      const url = `https://api.cloudflare.com/client/v4/accounts/${settings.cloudflareImageAccountId}/ai/run/${settings.imageModel}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.cloudflareImageApiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      if (!response.ok) {
        const fb = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`);
        if (!fb.ok) throw new Error(`Fallback ${fb.status}`);
        const buf = await fb.arrayBuffer();
        if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
        else await UserApiKey.updateOne({ email: foundUserEmail, 'keys.key': token }, { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } });
        return res.json({ success: true, image: `data:image/png;base64,${Buffer.from(buf).toString('base64')}` });
      }
      const buffer = await response.arrayBuffer();
      if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
      else await UserApiKey.updateOne({ email: foundUserEmail, 'keys.key': token }, { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } });
      return res.json({ success: true, image: `data:image/png;base64,${Buffer.from(buffer).toString('base64')}` });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Missing messages' });
  const today = new Date().toISOString().slice(0, 10);
  if (isFreeKey) {
    if (foundFreeKey.date !== today) { foundFreeKey.used = 0; foundFreeKey.date = today; }
    if (foundFreeKey.used >= foundFreeKey.limit) return res.status(429).json({ error: `Daily limit (${foundFreeKey.limit}) reached` });
  } else {
    if (foundUserKey.date !== today) { foundUserKey.used = 0; foundUserKey.date = today; }
    if (foundUserKey.used >= 20) return res.status(429).json({ error: 'Daily limit (20) reached' });
  }

  let moduleToUse = null;
  if (module_id) moduleToUse = await Module.findOne({ id: module_id });
  if (!moduleToUse) {
    const randomModule = await getRandomModule();
    if (!randomModule) return res.status(503).json({ error: 'No AI modules available' });
    moduleToUse = randomModule;
  }

  try {
    const result = await runUniversalAgent(messages, moduleToUse, deep_think);
    if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
    else await UserApiKey.updateOne({ email: foundUserEmail, 'keys.key': token }, { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } });
    const remaining = (isFreeKey ? foundFreeKey.limit : 20) - (isFreeKey ? (foundFreeKey.used + 1) : (foundUserKey.used + 1));
    res.json({ success: true, reply: result.reply, toolUsed: result.toolUsed, remaining });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}));

// ========== FREE API KEYS (session required) ==========
app.post('/api/free-api-key/generate', requireSession, asyncHandler(async (req, res) => {
  const email = req.sessionUser.email;
  await FreeApiKey.deleteOne({ email });
  const newKey = 'vrythos_free_' + crypto.randomBytes(16).toString('hex');
  const freeKey = new FreeApiKey({
    key: newKey, email, used: 0, video_used: 0,
    date: new Date().toISOString().slice(0, 10), limit: 100, video_limit: 100
  });
  await freeKey.save();

  const apiUrl = `${req.protocol}://${req.get('host')}/api/external/chat`;
  res.json({
    success: true, key: newKey, apiUrl, chat_limit: 100, video_limit: 100,
    instructions: `Use this key as Bearer token. POST to ${apiUrl} with { "messages": [...], "type": "chat" } or { "prompt": "cat", "type": "image" } or { "prompt": "description", "type": "video", "duration": 5 }.`
  });
}));

app.get('/api/free-api-key/info', requireSession, asyncHandler(async (req, res) => {
  const key = await FreeApiKey.findOne({ email: req.sessionUser.email });
  if (!key) return res.json({ exists: false });
  res.json({
    exists: true, key: key.key, used: key.used, video_used: key.video_used || 0,
    limit: key.limit, video_limit: key.video_limit || 100, date: key.date,
    remaining: key.limit - key.used, video_remaining: (key.video_limit || 100) - (key.video_used || 0)
  });
}));

app.post('/api/free-api-key/revoke', requireSession, asyncHandler(async (req, res) => {
  await FreeApiKey.deleteOne({ email: req.sessionUser.email });
  res.json({ success: true });
}));

// ========== IMAGE (session required) ==========
app.post('/api/generate/image', requireSession, asyncHandler(async (req, res) => {
  const { prompt } = req.body;
  const settings = await Setting.findOne();
  if (!settings || !settings.cloudflareImageAccountId || !settings.cloudflareImageApiToken) {
    return res.status(500).json({ success: false, error: 'Cloudflare image not configured' });
  }
  try {
    const url = `https://api.cloudflare.com/client/v4/accounts/${settings.cloudflareImageAccountId}/ai/run/${settings.imageModel}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${settings.cloudflareImageApiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    res.json({ success: true, image: `data:image/png;base64,${Buffer.from(buffer).toString('base64')}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

app.post('/api/fallback/image', requireSession, asyncHandler(async (req, res) => {
  const { prompt } = req.body;
  try {
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    res.json({ success: true, image: `data:image/png;base64,${Buffer.from(buffer).toString('base64')}` });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ========== ADMIN AUTH ==========
app.post('/api/admin/verify', asyncHandler(async (req, res) => {
  const { password } = req.body;
  const settings = await Setting.findOne();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
  const ok = await verifyPassword(password, settings.adminPasswordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid password' });
  const token = createAdminSession();
  res.json({ success: true, token });
}));

app.get('/api/admin/password-limit', (req, res) => {
  resetAdminCountIfNeeded();
  res.json({ remaining: 3 - adminPasswordChangeCount });
});

// Admin forgot-password flow: email must match ADMIN_EMAIL, requires current password
app.post('/api/admin/change-password', asyncHandler(async (req, res) => {
  const { email, currentPassword, newPassword } = req.body;
  if (email !== process.env.ADMIN_EMAIL) return res.status(403).json({ error: 'Unauthorized email' });
  resetAdminCountIfNeeded();
  if (adminPasswordChangeCount >= 3) return res.status(429).json({ error: 'Daily password change limit (3/day).' });
  const settings = await Setting.findOne();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
  const ok = await verifyPassword(currentPassword, settings.adminPasswordHash);
  if (!ok) return res.status(401).json({ error: 'Current password incorrect' });
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  settings.adminPasswordHash = await hashPassword(newPassword);
  await settings.save();
  adminPasswordChangeCount++;
  adminSessions.clear();
  try {
    await sendEmail(process.env.ADMIN_EMAIL, 'Vrythos Admin Password Changed', `Your admin password has been updated successfully.`);
  } catch (err) {}
  res.json({ success: true, remaining: 3 - adminPasswordChangeCount });
}));

app.get('/api/admin/settings', requireAdmin, asyncHandler(async (req, res) => {
  const settings = await Setting.findOne();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
  res.json({
    cloudflareImageAccountId: settings.cloudflareImageAccountId,
    cloudflareImageApiToken: settings.cloudflareImageApiToken ? '********' : '',
    imageModel: settings.imageModel,
    agnesApiKey: settings.agnesApiKey ? '********' : '',
    agnesModel: settings.agnesModel || 'agnes-video-v2.0'
  });
}));

app.post('/api/admin/settings', requireAdmin, asyncHandler(async (req, res) => {
  const { adminPassword, newAdminPassword, cloudflareImageAccountId, cloudflareImageApiToken, imageModel, agnesApiKey, agnesModel } = req.body;
  let settings = await Setting.findOne();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
  if (adminPassword) {
    const ok = await verifyPassword(adminPassword, settings.adminPasswordHash);
    if (!ok) return res.status(401).json({ error: 'Current admin password incorrect' });
    if (newAdminPassword) {
      if (newAdminPassword.length < 8) return res.status(400).json({ error: 'newAdminPassword must be at least 8 chars' });
      settings.adminPasswordHash = await hashPassword(newAdminPassword);
      adminSessions.clear();
    }
  }
  if (cloudflareImageAccountId !== undefined) settings.cloudflareImageAccountId = cloudflareImageAccountId;
  if (cloudflareImageApiToken !== undefined && cloudflareImageApiToken !== '********') settings.cloudflareImageApiToken = cloudflareImageApiToken;
  if (imageModel !== undefined) settings.imageModel = imageModel;
  if (agnesApiKey !== undefined) settings.agnesApiKey = agnesApiKey;
  if (agnesModel !== undefined) settings.agnesModel = agnesModel;
  await settings.save();
  res.json({ success: true });
}));

app.get('/api/admin/stats', requireAdmin, asyncHandler(async (req, res) => {
  const users = await User.find({});
  const now = Date.now();
  const today = new Date().toDateString();
  const weekAgo = now - 7 * 24 * 3600 * 1000;
  const monthAgo = now - 30 * 24 * 3600 * 1000;
  const liveUsers = users.filter(u => {
    const last = u.lastActive ? new Date(u.lastActive).getTime() : 0;
    return (now - last) < 5 * 60 * 1000;
  }).length;
  const dailyUsers = users.filter(u => u.lastActive && new Date(u.lastActive).toDateString() === today).length;
  const weeklyUsers = users.filter(u => u.lastActive && new Date(u.lastActive).getTime() > weekAgo).length;
  const monthlyUsers = users.filter(u => u.lastActive && new Date(u.lastActive).getTime() > monthAgo).length;
  res.json({ liveUsers, dailyUsers, weeklyUsers, monthlyUsers, totalAccounts: users.length });
}));

app.get('/api/admin/user/:email', requireAdmin, asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: req.params.email }).select('-passwordHash -sessionToken');
  if (!user) return res.status(404).json({ error: 'User not found' });
  const apiKeys = await UserApiKey.findOne({ email: user.email }) || { keys: [] };
  const imageQuota = await ImageQuota.findOne({ email: user.email }) || { count: 0, windowStart: 0 };
  const chatUsage = await ChatUsage.find({ email: user.email });
  res.json({ ...user.toObject(), apiKeys: apiKeys.keys, imageQuota, chatUsage, totalHoursLive: user.totalHoursLive || 0 });
}));

app.delete('/api/admin/user/:email', requireAdmin, asyncHandler(async (req, res) => {
  await User.deleteOne({ email: req.params.email });
  await UserApiKey.deleteOne({ email: req.params.email });
  await ImageQuota.deleteOne({ email: req.params.email });
  await ChatUsage.deleteMany({ email: req.params.email });
  await ChatHistory.deleteMany({ email: req.params.email });
  res.json({ success: true });
}));

app.post('/api/admin/log-abuse', requireAdmin, asyncHandler(async (req, res) => {
  const { reason, score } = req.body;
  await new AdminAbuseLog({ timestamp: new Date(), reason, score }).save();
  const count = await AdminAbuseLog.countDocuments();
  if (count > 100) {
    const oldest = await AdminAbuseLog.find({}).sort({ timestamp: 1 }).limit(count - 100);
    await AdminAbuseLog.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
  }
  res.json({ success: true });
}));

// ========== EARNINGS ==========
app.get('/api/admin/earnings', requireAdmin, asyncHandler(async (req, res) => {
  const settings = await Setting.findOne();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
  const withdrawals = await Withdrawal.find({}).sort({ timestamp: -1 }).limit(100);
  const chatUsage = await ChatUsage.find({});
  const videoUsage = await VideoUsage.find({});
  res.json({
    balance: settings.earningsBalance || 0,
    withdrawals,
    stats: {
      totalChats: chatUsage.reduce((s, c) => s + (c.count || 0), 0),
      totalVideos: videoUsage.reduce((s, v) => s + (v.count || 0), 0),
      userCount: await User.countDocuments({}),
      totalFreeKeys: await FreeApiKey.countDocuments({})
    }
  });
}));

app.post('/api/admin/earnings', requireAdmin, asyncHandler(async (req, res) => {
  const { password, balance } = req.body;
  const settings = await Setting.findOne();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
  const ok = await verifyPassword(password, settings.adminPasswordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid admin password' });
  if (typeof balance !== 'number' || balance < 0 || !isFinite(balance)) return res.status(400).json({ error: 'Balance must be non-negative number' });
  settings.earningsBalance = Math.round(balance * 100) / 100;
  await settings.save();
  res.json({ success: true, balance: settings.earningsBalance });
}));

app.post('/api/admin/withdraw', requireAdmin, asyncHandler(async (req, res) => {
  const { password, method, amount, detail } = req.body;
  const settings = await Setting.findOne();
  if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
  const ok = await verifyPassword(password, settings.adminPasswordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid admin password' });
  if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount)) return res.status(400).json({ error: 'Amount must be positive' });
  const currentBalance = settings.earningsBalance || 0;
  if (amount > currentBalance) return res.status(400).json({ error: 'Insufficient balance' });
  const allowedMethods = ['amazon', 'playstore', 'upi', 'paypal', 'bank'];
  if (!allowedMethods.includes(method)) return res.status(400).json({ error: 'Invalid withdrawal method' });

  settings.earningsBalance = Math.round((currentBalance - amount) * 100) / 100;
  await settings.save();
  const w = new Withdrawal({ method, amount: Math.round(amount * 100) / 100, detail: (detail || '').slice(0, 500), status: 'Success' });
  await w.save();
  res.json({ success: true, balance: settings.earningsBalance, withdrawal: w });
}));

app.delete('/api/admin/withdrawals', requireAdmin, asyncHandler(async (req, res) => { await Withdrawal.deleteMany({}); res.json({ success: true }); }));

// ========== REGISTER (reCAPTCHA) ==========
app.post('/api/users', asyncHandler(async (req, res) => {
  const { recaptchaToken, ...userData } = req.body;
  const verify = await verifyRecaptcha(recaptchaToken);
  if (!verify.success) return res.status(400).json({ error: 'reCAPTCHA failed' });
  const existing = await User.findOne({ email: userData.email });
  if (existing) return res.status(400).json({ error: 'Email already registered' });
  const existingUsername = await User.findOne({ username: userData.username });
  if (existingUsername) return res.status(400).json({ error: 'Username taken' });
  const pw = userData.password;
  delete userData.passwordHash;
  userData.passwordHash = pw ? await hashPassword(pw) : null;
  const user = new User(userData);
  await user.save();
  res.json({ success: true });
}));

// ========== LOGIN (reCAPTCHA) — issues session token ==========
app.post('/api/login', asyncHandler(async (req, res) => {
  const { email, password, recaptchaToken } = req.body;
  const verify = await verifyRecaptcha(recaptchaToken);
  if (!verify.success) return res.status(400).json({ error: 'reCAPTCHA failed' });
  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (!user.passwordHash) return res.status(401).json({ error: 'Use Google login' });
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password' });
  if (user.banned) return res.status(403).json({ error: 'Account banned' });

  // Migrate legacy SHA-256 to bcrypt on successful login
  if (user.passwordHash.length === 64 && !user.passwordHash.startsWith('$')) {
    user.passwordHash = await hashPassword(password);
  }

  const sessionToken = generateSessionToken();
  user.sessionToken = sessionToken;
  user.sessionExpires = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  user.lastActive = new Date();
  await user.save();

  res.json({
    success: true, sessionToken,
    email: user.email, username: user.username, name: user.name, profilePic: user.profilePic,
    extraChatCredits: user.extraChatCredits || 0, extraImageCredits: user.extraImageCredits || 0,
    banned: user.banned, totalHoursLive: user.totalHoursLive || 0,
    authProvider: user.authProvider || 'email'
  });
}));

// ========== ERROR HANDLER ==========
app.use((err, req, res, next) => {
  console.error('❌ Server error:', err.stack || err.message);
  res.status(500).json({ error: 'Internal server error' });
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
