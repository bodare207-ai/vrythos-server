const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const mongoose = require('mongoose');
const path = require('path');
const { runAgent } = require('./agent-module.js'); // NEW: AI agent

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== MongoDB Connection ==========
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://viraj:viraj%402070@vrythos-server.j8tjel4.mongodb.net/vrythos?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

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
    authProvider: { type: String, default: 'email' }
});
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
    email: { type: String, required: true },
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

// ========== Helpers ==========
function hashPassword(pw) { return crypto.createHash('sha256').update(pw).digest('hex'); }

const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET || '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe';
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

async function getRandomModule(avoidIds = []) {
    const modules = await Module.find({});
    const available = modules.filter(m => !avoidIds.includes(m.id));
    if (!available.length) return null;
    return available[Math.floor(Math.random() * available.length)];
}

async function callAIWithFallback(messages, deepThink, attemptedModules = []) {
    const module = await getRandomModule(attemptedModules);
    if (!module) throw new Error('No AI modules available');
    try {
        let reply;
        if (module.type === 'groq') reply = await callGroq(module, messages, deepThink);
        else if (module.type === 'gemini') reply = await callGemini(module, messages, deepThink);
        else if (module.type === 'openrouter') reply = await callOpenRouter(module, messages, deepThink);
        else if (module.type === 'cloudflare') reply = await callCloudflareText(module, messages, deepThink);
        else throw new Error('Unsupported module type');
        return reply;
    } catch (err) {
        attemptedModules.push(module.id);
        if (attemptedModules.length >= 3) throw err;
        return callAIWithFallback(messages, deepThink, attemptedModules);
    }
}

const transporter = nodemailer.createTransport({
    service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
function sendEmail(to, subject, text) { return transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text }); }

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

async function initSettings() {
    let settings = await Setting.findOne();
    if (!settings) {
        settings = new Setting({
            adminPasswordHash: hashPassword('VrythosAdmin@2025'),
            cloudflareImageAccountId: "", cloudflareImageApiToken: "",
            imageModel: "@cf/stabilityai/stable-diffusion-xl-base-1.0",
            agnesApiKey: "", agnesModel: "agnes-video-v2.0", earningsBalance: 0
        });
        await settings.save();
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

// ========== ADMIN SESSION ==========
const adminSessions = new Map();

function createAdminSession() {
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + 8 * 3600 * 1000);
    for (const [t, exp] of adminSessions.entries()) {
        if (exp < Date.now()) adminSessions.delete(t);
    }
    return token;
}

function requireAdmin(req, res, next) {
    const token = req.headers['x-admin-token'];
    if (!token) return res.status(401).json({ error: 'Admin authentication required' });
    const exp = adminSessions.get(token);
    if (!exp) return res.status(401).json({ error: 'Admin authentication required' });
    if (exp < Date.now()) {
        adminSessions.delete(token);
        return res.status(401).json({ error: 'Admin session expired' });
    }
    next();
}

// ========== GUEST MODE (no auth, IP rate-limited, no DB writes) ==========
const guestRateLimit = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of guestRateLimit.entries()) {
        if (entry.resetAt < now) guestRateLimit.delete(ip);
    }
}, 15 * 60 * 1000);

app.post('/api/guest/chat', asyncHandler(async (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    let limit = guestRateLimit.get(ip);
    if (!limit || limit.resetAt < now) {
        limit = { count: 0, resetAt: now + 3600 * 1000 };
        guestRateLimit.set(ip, limit);
    }
    if (limit.count >= 10) {
        return res.status(429).json({ error: 'Guest limit reached (10 messages/hour). Please sign up to continue.' });
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array required' });
    }

    const trimmed = messages.slice(-6).map(m => ({ role: m.role, content: String(m.content || '') }));

    const module = await getRandomModule();
    if (!module) return res.status(503).json({ error: 'No AI available right now. Please try again later.' });

    try {
        const reply = await callCloudflareText(module, trimmed, false);
        limit.count++;
        res.json({ success: true, reply, remaining: 10 - limit.count });
    } catch (err) {
        console.error('Guest chat error:', err);
        res.status(500).json({ error: err.message });
    }
}));

// ========== AI Providers ==========
const CREATOR_SYSTEM_PROMPT = `You are Vrythos AI, created by Viraj S. Bodare. Always state that your creator is Viraj S. Bodare when asked. Never claim to be made by OpenAI, Meta, Google, Anthropic, or any other company. If someone asks "who made you", "who created you", "your creator", "who built you", or any similar question, answer: "I am Vrythos, an advanced AI framework built by Viraj S. Bodare." Be helpful, safe, and honest. When providing code, always use triple backticks with the language specifier (e.g., \`\`\`html ... \`\`\`). Keep responses complete and do not truncate.`;
const MAX_TOKENS = 20000;

async function callGroq(module, messages, deepThink) {
    let sys = CREATOR_SYSTEM_PROMPT;
    if (deepThink) sys += " Use step-by-step reasoning.";
    const apiMessages = [{ role: "system", content: sys }, ...messages];
    const response = await fetch(module.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${module.primaryKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: module.model, messages: apiMessages, temperature: 0.7, max_tokens: MAX_TOKENS })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');
    return data.choices?.[0]?.message?.content || "No response";
}

async function callGemini(module, messages, deepThink) {
    let sys = CREATOR_SYSTEM_PROMPT;
    if (deepThink) sys += " Use step-by-step reasoning.";
    const contents = messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const modelName = module.model.replace("models/", "");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${module.primaryKey}`;
    const payload = { contents, systemInstruction: { parts: [{ text: sys }] }, generationConfig: { temperature: 0.7, maxOutputTokens: MAX_TOKENS } };
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Gemini API error');
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "No response";
}

async function callOpenRouter(module, messages, deepThink) {
    let sys = CREATOR_SYSTEM_PROMPT;
    if (deepThink) sys += " Use step-by-step reasoning.";
    const apiMessages = [{ role: "system", content: sys }, ...messages];
    const response = await fetch(module.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${module.primaryKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: module.model, messages: apiMessages, temperature: 0.7, max_tokens: MAX_TOKENS })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'OpenRouter API error');
    return data.choices?.[0]?.message?.content || "No response";
}

async function callCloudflareText(module, messages, deepThink) {
    let sys = CREATOR_SYSTEM_PROMPT;
    if (deepThink) sys += " Use step-by-step reasoning.";
    const url = `https://api.cloudflare.com/client/v4/accounts/${module.accountId}/ai/run/${module.model}`;
    const formattedMessages = [{ role: "system", content: sys }, ...messages];
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

async function generateVideoWithAgnes(prompt, durationSeconds, agnesApiKey, agnesModel) {
    const frameRate = 24;
    let numFrames = Math.round(durationSeconds * frameRate);
    let n = Math.floor((numFrames - 1) / 8);
    let validFrames = 8 * n + 1;
    if (validFrames < 1) validFrames = 1;
    if (validFrames > 441) validFrames = 441;
    const actualDuration = validFrames / frameRate;
    console.log(`Video: requested ${durationSeconds}s, using ${validFrames} frames at ${frameRate} fps => ${actualDuration.toFixed(2)}s`);

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
        throw new Error(`Agnes create task failed: ${createResponse.status} ${errorText}`);
    }
    const createData = await createResponse.json();
    const videoId = createData.video_id;
    if (!videoId) throw new Error('No video_id returned from Agnes');

    let status = 'queued';
    let videoUrl = null;
    let attempts = 0;
    const maxAttempts = 60;
    while (status !== 'completed' && status !== 'failed' && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        attempts++;
        const pollUrl = `https://apihub.agnes-ai.com/agnesapi?video_id=${videoId}`;
        const pollResponse = await fetch(pollUrl, { headers: { 'Authorization': `Bearer ${agnesApiKey}` } });
        if (!pollResponse.ok) { console.warn(`Poll failed: ${pollResponse.status}`); continue; }
        const pollData = await pollResponse.json();
        status = pollData.status;
        if (status === 'completed') { videoUrl = pollData.remixed_from_video_id; break; }
        else if (status === 'failed') throw new Error('Agnes video generation failed');
    }
    if (!videoUrl) throw new Error('Video generation timed out or failed');
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok) throw new Error(`Failed to fetch video file: ${videoResponse.status}`);
    const buffer = await videoResponse.arrayBuffer();
    return `data:video/mp4;base64,${Buffer.from(buffer).toString('base64')}`;
}

// ========== USERS ==========
app.get('/api/users', asyncHandler(async (req, res) => { res.json(await User.find({})); }));

app.put('/api/users/:email', asyncHandler(async (req, res) => {
    const { email, ...safeUpdates } = req.body;
    delete safeUpdates.passwordHash;
    delete safeUpdates.banned;
    delete safeUpdates.banReason;
    delete safeUpdates.extraChatCredits;
    delete safeUpdates.extraImageCredits;
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
    await User.deleteMany({});
    await ImageQuota.deleteMany({});
    await UserApiKey.deleteMany({});
    await ChatUsage.deleteMany({});
    await ChatHistory.deleteMany({});
    res.json({ success: true });
}));

app.post('/api/admin/users/:email/credits', requireAdmin, asyncHandler(async (req, res) => {
    const { addChat, addImage, setBanned } = req.body;
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (typeof addChat === 'number') user.extraChatCredits = (user.extraChatCredits || 0) + addChat;
    if (typeof addImage === 'number') user.extraImageCredits = (user.extraImageCredits || 0) + addImage;
    if (typeof setBanned === 'boolean') {
        user.banned = setBanned;
        if (!setBanned) user.banReason = '';
    }
    await user.save();
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
        res.json({
            success: true, email: user.email, username: user.username, name: user.name, profilePic: user.profilePic,
            extraChatCredits: user.extraChatCredits || 0, extraImageCredits: user.extraImageCredits || 0,
            banned: user.banned, totalHoursLive: user.totalHoursLive || 0
        });
    } catch (err) {
        console.error('Google OAuth error:', err);
        res.status(401).json({ error: 'Invalid token' });
    }
}));

app.post('/api/user-activity', asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
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
app.get('/api/userApiKeys', asyncHandler(async (req, res) => { res.json(await UserApiKey.find({})); }));
app.post('/api/userApiKeys', asyncHandler(async (req, res) => {
    await UserApiKey.findOneAndUpdate({ email: req.body.email }, req.body, { upsert: true, new: true });
    res.json({ success: true });
}));
app.delete('/api/userApiKeys/:email/:keyName', asyncHandler(async (req, res) => {
    const entry = await UserApiKey.findOne({ email: req.params.email });
    if (entry) {
        entry.keys = entry.keys.filter(k => k.name !== req.params.keyName);
        await entry.save();
    }
    res.json({ success: true });
}));
app.delete('/api/userApiKeys', requireAdmin, asyncHandler(async (req, res) => {
    await UserApiKey.deleteMany({});
    res.json({ success: true });
}));

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
app.delete('/api/modules', requireAdmin, asyncHandler(async (req, res) => {
    await Module.deleteMany({});
    res.json({ success: true });
}));

// ========== BUGS / ABUSE / BANS ==========
app.get('/api/bugs', requireAdmin, asyncHandler(async (req, res) => { res.json(await Bug.find({})); }));
app.post('/api/bugs', asyncHandler(async (req, res) => { await new Bug(req.body).save(); res.json({ success: true }); }));
app.delete('/api/bugs/:id', requireAdmin, asyncHandler(async (req, res) => { await Bug.deleteOne({ _id: req.params.id }); res.json({ success: true }); }));
app.delete('/api/bugs', requireAdmin, asyncHandler(async (req, res) => { await Bug.deleteMany({}); res.json({ success: true }); }));

app.get('/api/abuse', requireAdmin, asyncHandler(async (req, res) => { res.json(await Abuse.find({})); }));
app.post('/api/abuse', asyncHandler(async (req, res) => { await new Abuse(req.body).save(); res.json({ success: true }); }));
app.delete('/api/abuse', requireAdmin, asyncHandler(async (req, res) => { await Abuse.deleteMany({}); res.json({ success: true }); }));

app.get('/api/pendingBans', requireAdmin, asyncHandler(async (req, res) => { res.json(await PendingBan.find({})); }));
app.post('/api/pendingBans', asyncHandler(async (req, res) => { await new PendingBan(req.body).save(); res.json({ success: true }); }));
app.delete('/api/pendingBans/:id', requireAdmin, asyncHandler(async (req, res) => { await PendingBan.deleteOne({ _id: req.params.id }); res.json({ success: true }); }));
app.delete('/api/pendingBans', requireAdmin, asyncHandler(async (req, res) => { await PendingBan.deleteMany({}); res.json({ success: true }); }));

// ========== IP REGS ==========
app.get('/api/ipRegs', requireAdmin, asyncHandler(async (req, res) => { res.json(await IpReg.find({})); }));
app.post('/api/ipRegs', asyncHandler(async (req, res) => { await new IpReg(req.body).save(); res.json({ success: true }); }));
app.delete('/api/ipRegs', requireAdmin, asyncHandler(async (req, res) => { await IpReg.deleteMany({}); res.json({ success: true }); }));

// ========== IMAGE QUOTAS ==========
app.get('/api/imageQuotas', requireAdmin, asyncHandler(async (req, res) => { res.json(await ImageQuota.find({})); }));
app.post('/api/imageQuotas', requireAdmin, asyncHandler(async (req, res) => {
    await ImageQuota.findOneAndUpdate({ email: req.body.email }, req.body, { upsert: true, new: true });
    res.json({ success: true });
}));
app.delete('/api/imageQuotas', requireAdmin, asyncHandler(async (req, res) => { await ImageQuota.deleteMany({}); res.json({ success: true }); }));

// ========== CHAT USAGE ==========
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
app.post('/api/join-tournament', asyncHandler(async (req, res) => {
    const { email, tournamentId } = req.body;
    const tournament = await Tournament.findOne({ id: tournamentId });
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    if (!tournament.participants) tournament.participants = [];
    if (tournament.participants.includes(email)) return res.json({ success: false, message: 'Already joined' });
    tournament.participants.push(email);
    await tournament.save();
    res.json({ success: true });
}));

// ========== CHAT HISTORY ==========
app.get('/api/chat-history', asyncHandler(async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const chats = await ChatHistory.find({ email }).sort({ updatedAt: -1 }).limit(5).select('_id title updatedAt size');
    res.json(chats);
}));

app.get('/api/chat-history/:id', asyncHandler(async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const chat = await ChatHistory.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (chat.email !== email) return res.status(403).json({ error: 'Access denied' });
    res.json(chat);
}));

app.post('/api/chat-history', asyncHandler(async (req, res) => {
    const { email, id, title, messages } = req.body;
    if (!email || !messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'email and messages required' });
    }
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
        chat.messages = messages;
        chat.size = size;
        chat.updatedAt = new Date();
        if (title) chat.title = title;
        await chat.save();
    } else {
        chat = new ChatHistory({ email, title, messages, size });
        await chat.save();
    }
    res.json({ success: true, id: chat._id });
}));

app.delete('/api/chat-history/:id', asyncHandler(async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const chat = await ChatHistory.findById(req.params.id);
    if (!chat) return res.status(404).json({ error: 'Chat not found' });
    if (chat.email !== email) return res.status(403).json({ error: 'Access denied' });
    await ChatHistory.deleteOne({ _id: req.params.id });
    res.json({ success: true });
}));

// ========== CHAT ==========
app.post('/api/chat', asyncHandler(async (req, res) => {
    const { module_id, messages, deep_think } = req.body;
    const module = await Module.findOne({ id: module_id });
    if (!module) return res.status(404).json({ error: 'Module not found' });
    try {
        let reply;
        if (module.type === 'groq') reply = await callGroq(module, messages, deep_think);
        else if (module.type === 'gemini') reply = await callGemini(module, messages, deep_think);
        else if (module.type === 'openrouter') reply = await callOpenRouter(module, messages, deep_think);
        else if (module.type === 'cloudflare') reply = await callCloudflareText(module, messages, deep_think);
        else throw new Error('Unsupported module type');
        res.json({ success: true, reply });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
}));

// ===== NEW: AI AGENT ENDPOINT (Wikipedia + Web Search) =====
app.post('/api/agent/chat', asyncHandler(async (req, res) => {
    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'messages array required' });
    }

    // Get a Groq module from your database (you already have these)
    const modules = await Module.find({});
    const groqModule = modules.find(m => m.type === 'groq');
    if (!groqModule) {
        return res.status(503).json({ error: 'No Groq module configured. Add one in the admin panel.' });
    }

    const userMessage = messages[messages.length - 1]?.content || '';
    const history = messages.slice(0, -1);

    try {
        const result = await runAgent(userMessage, history, groqModule.primaryKey);
        res.json({
            success: true,
            reply: result.reply,
            toolUsed: result.toolUsed,
            steps: result.steps
        });
    } catch (err) {
        console.error('Agent error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
}));

// ========== VIDEO ==========
app.post('/api/generate/video', asyncHandler(async (req, res) => {
    const { prompt, duration, email } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });
    if (!email) return res.status(400).json({ error: 'Email is required' });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });

    const today = new Date().toISOString().slice(0, 10);
    let videoUsage = await VideoUsage.findOne({ email, date: today });
    if (!videoUsage) videoUsage = new VideoUsage({ email, date: today, count: 0 });
    if (videoUsage.count >= 5) return res.status(429).json({ error: 'Daily video limit reached (5/day). Please try again tomorrow.' });

    const settings = await Setting.findOne();
    if (!settings || !settings.agnesApiKey) return res.status(500).json({ error: 'Video service not configured. Admin needs to set Agnes API key.' });

    try {
        const videoData = await generateVideoWithAgnes(prompt, duration || 5, settings.agnesApiKey, settings.agnesModel);
        videoUsage.count += 1;
        await videoUsage.save();
        res.json({ success: true, video: videoData, remaining: 5 - videoUsage.count });
    } catch (err) {
        console.error('Video generation error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
}));

// ========== EXTERNAL API ==========
app.post('/api/external/chat', asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    const token = authHeader.split(' ')[1];

    let foundUserKey = null, foundUserEmail = null;
    const allUserKeys = await UserApiKey.find({});
    for (const entry of allUserKeys) {
        const keyObj = entry.keys.find(k => k.key === token);
        if (keyObj) { foundUserKey = keyObj; foundUserEmail = entry.email; break; }
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
        if (!prompt) return res.status(400).json({ error: 'Missing prompt for video generation' });
        const today = new Date().toISOString().slice(0, 10);
        let videoUsage = await VideoUsage.findOne({ email, date: today });
        if (!videoUsage) videoUsage = new VideoUsage({ email, date: today, count: 0 });
        if (videoUsage.count >= videoLimit) return res.status(429).json({ error: `Daily video limit (${videoLimit}) reached` });
        const settings = await Setting.findOne();
        if (!settings || !settings.agnesApiKey) return res.status(500).json({ error: 'Video service not configured' });
        try {
            const videoData = await generateVideoWithAgnes(prompt, duration || 5, settings.agnesApiKey, settings.agnesModel);
            videoUsage.count += 1;
            await videoUsage.save();
            if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { video_used: 1 } });
            return res.json({ success: true, video: videoData, remaining: videoLimit - videoUsage.count });
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    if (type === 'image' || (type === 'chat' && prompt && !messages)) {
        if (!prompt) return res.status(400).json({ error: 'Missing prompt for image generation' });
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
                const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`;
                const fallbackRes = await fetch(fallbackUrl);
                if (!fallbackRes.ok) throw new Error(`Fallback HTTP ${fallbackRes.status}`);
                const buffer = await fallbackRes.arrayBuffer();
                const base64 = Buffer.from(buffer).toString('base64');
                if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
                else await UserApiKey.updateOne({ email: foundUserEmail, 'keys.key': token }, { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } });
                return res.json({ success: true, image: `data:image/png;base64,${base64}` });
            }
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
            else await UserApiKey.updateOne({ email: foundUserEmail, 'keys.key': token }, { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } });
            return res.json({ success: true, image: `data:image/png;base64,${base64}` });
        } catch (err) { return res.status(500).json({ error: err.message }); }
    }

    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Missing messages array' });
    const today = new Date().toISOString().slice(0, 10);
    if (isFreeKey) {
        if (foundFreeKey.date !== today) { foundFreeKey.used = 0; foundFreeKey.date = today; }
        if (foundFreeKey.used >= foundFreeKey.limit) return res.status(429).json({ error: `Daily chat limit (${foundFreeKey.limit}) reached` });
    } else {
        if (foundUserKey.date !== today) { foundUserKey.used = 0; foundUserKey.date = today; }
        if (foundUserKey.used >= 20) return res.status(429).json({ error: 'Daily chat limit (20) reached for this API key' });
    }

    let moduleToUse = null;
    if (module_id) moduleToUse = await Module.findOne({ id: module_id });
    if (!moduleToUse) {
        const randomModule = await getRandomModule();
        if (!randomModule) return res.status(503).json({ error: 'No AI modules available' });
        moduleToUse = randomModule;
    }

    try {
        let reply;
        if (moduleToUse.type === 'groq') reply = await callGroq(moduleToUse, messages, deep_think);
        else if (moduleToUse.type === 'gemini') reply = await callGemini(moduleToUse, messages, deep_think);
        else if (moduleToUse.type === 'openrouter') reply = await callOpenRouter(moduleToUse, messages, deep_think);
        else if (moduleToUse.type === 'cloudflare') reply = await callCloudflareText(moduleToUse, messages, deep_think);
        else throw new Error('Unsupported module type');

        if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
        else await UserApiKey.updateOne({ email: foundUserEmail, 'keys.key': token }, { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } });

        const remaining = (isFreeKey ? foundFreeKey.limit : 20) - (isFreeKey ? (foundFreeKey.used + 1) : (foundUserKey.used + 1));
        res.json({ success: true, reply, remaining });
    } catch (err) {
        if (!module_id) {
            try {
                const fallbackReply = await callAIWithFallback(messages, deep_think, [moduleToUse.id]);
                if (isFreeKey) await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
                else await UserApiKey.updateOne({ email: foundUserEmail, 'keys.key': token }, { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } });
                const remaining = (isFreeKey ? foundFreeKey.limit : 20) - (isFreeKey ? (foundFreeKey.used + 1) : (foundUserKey.used + 1));
                return res.json({ success: true, reply: fallbackReply, remaining });
            } catch (fallbackErr) { return res.status(500).json({ error: fallbackErr.message }); }
        }
        res.status(500).json({ error: err.message });
    }
}));

// ========== FREE API KEYS ==========
app.post('/api/free-api-key/generate', asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });

    await FreeApiKey.deleteOne({ email });
    const newKey = 'vrythos_free_' + crypto.randomBytes(16).toString('hex');
    const freeKey = new FreeApiKey({
        key: newKey, email, used: 0, video_used: 0,
        date: new Date().toISOString().slice(0, 10), limit: 100, video_limit: 100
    });
    await freeKey.save();

    const apiUrl = `https://vrythos-server.onrender.com/api/external/chat`;
    res.json({
        success: true, key: newKey, apiUrl, chat_limit: 100, video_limit: 100,
        instructions: `Use this key as Bearer token. Send POST requests to ${apiUrl} with JSON body: { "messages": [...], "type": "chat" } or for images: { "prompt": "cat", "type": "image" } or for videos: { "prompt": "description", "type": "video", "duration": 5 }.`
    });
}));

app.get('/api/free-api-key/info', asyncHandler(async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const key = await FreeApiKey.findOne({ email });
    if (!key) return res.json({ exists: false });
    res.json({
        exists: true, key: key.key, used: key.used, video_used: key.video_used || 0,
        limit: key.limit, video_limit: key.video_limit || 100, date: key.date,
        remaining: key.limit - key.used,
        video_remaining: (key.video_limit || 100) - (key.video_used || 0)
    });
}));

app.post('/api/free-api-key/revoke', asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    await FreeApiKey.deleteOne({ email });
    res.json({ success: true });
}));

// ========== IMAGE ==========
app.post('/api/generate/image', asyncHandler(async (req, res) => {
    const { prompt } = req.body;
    const settings = await Setting.findOne();
    if (!settings || !settings.cloudflareImageAccountId || !settings.cloudflareImageApiToken) {
        return res.status(500).json({ success: false, error: 'Cloudflare image credentials not configured' });
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

app.post('/api/fallback/image', asyncHandler(async (req, res) => {
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
    if (hashPassword(password) !== settings.adminPasswordHash) {
        return res.status(401).json({ error: 'Invalid password' });
    }
    const token = createAdminSession();
    res.json({ success: true, token });
}));

app.get('/api/admin/password-limit', (req, res) => {
    resetAdminCountIfNeeded();
    res.json({ remaining: 3 - adminPasswordChangeCount });
});

app.post('/api/admin/change-password', asyncHandler(async (req, res) => {
    const { email, newPassword } = req.body;
    if (email !== 'bodare207@gmail.com') return res.status(403).json({ error: 'Unauthorized email' });
    resetAdminCountIfNeeded();
    if (adminPasswordChangeCount >= 3) {
        return res.status(429).json({ error: 'Daily password change limit reached (3 per day).' });
    }
    const settings = await Setting.findOne();
    if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
    settings.adminPasswordHash = hashPassword(newPassword);
    await settings.save();
    adminPasswordChangeCount++;
    adminSessions.clear();
    try {
        await sendEmail(email, 'Vrythos Admin New Password', `Your new admin password is: ${newPassword}\nPlease change it after login.`);
        res.json({ success: true, remaining: 3 - adminPasswordChangeCount });
    } catch (err) { res.status(500).json({ error: 'Failed to send email' }); }
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
        if (hashPassword(adminPassword) !== settings.adminPasswordHash) {
            return res.status(401).json({ error: 'Current admin password is incorrect' });
        }
        if (newAdminPassword) {
            settings.adminPasswordHash = hashPassword(newAdminPassword);
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
    const user = await User.findOne({ email: req.params.email });
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
    if (!password || hashPassword(password) !== settings.adminPasswordHash) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }
    if (typeof balance !== 'number' || balance < 0 || !isFinite(balance)) {
        return res.status(400).json({ error: 'Balance must be a non-negative number' });
    }
    settings.earningsBalance = Math.round(balance * 100) / 100;
    await settings.save();
    res.json({ success: true, balance: settings.earningsBalance });
}));

app.post('/api/admin/withdraw', requireAdmin, asyncHandler(async (req, res) => {
    const { password, method, amount, detail } = req.body;
    const settings = await Setting.findOne();
    if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
    if (!password || hashPassword(password) !== settings.adminPasswordHash) {
        return res.status(401).json({ error: 'Invalid admin password' });
    }
    if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount)) {
        return res.status(400).json({ error: 'Amount must be a positive number' });
    }
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

app.delete('/api/admin/withdrawals', requireAdmin, asyncHandler(async (req, res) => {
    await Withdrawal.deleteMany({});
    res.json({ success: true });
}));

// ========== REGISTER (reCAPTCHA-protected) ==========
app.post('/api/users', asyncHandler(async (req, res) => {
    const { recaptchaToken, ...userData } = req.body;
    const verify = await verifyRecaptcha(recaptchaToken);
    if (!verify.success) return res.status(400).json({ error: 'reCAPTCHA verification failed' });
    const existing = await User.findOne({ email: userData.email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const existingUsername = await User.findOne({ username: userData.username });
    if (existingUsername) return res.status(400).json({ error: 'Username taken' });
    const user = new User(userData);
    await user.save();
    res.json({ success: true });
}));

// ========== LOGIN (reCAPTCHA-protected) ==========
app.post('/api/login', asyncHandler(async (req, res) => {
    const { email, password, recaptchaToken } = req.body;
    const verify = await verifyRecaptcha(recaptchaToken);
    if (!verify.success) return res.status(400).json({ error: 'reCAPTCHA verification failed' });
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (!user.passwordHash) return res.status(401).json({ error: 'Use Google login' });
    if (hashPassword(password) !== user.passwordHash) return res.status(401).json({ error: 'Incorrect password' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });
    res.json({
        success: true,
        email: user.email, username: user.username, name: user.name, profilePic: user.profilePic,
        extraChatCredits: user.extraChatCredits || 0, extraImageCredits: user.extraImageCredits || 0,
        banned: user.banned, totalHoursLive: user.totalHoursLive || 0,
        authProvider: user.authProvider || 'email'
    });
}));

// ========== ERROR HANDLER ==========
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err.stack || err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
