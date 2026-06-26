const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== MongoDB Connection ==========
// FIX: Removed misleading dead-code error log (MONGODB_URI always has a fallback value, so !MONGODB_URI was never true)
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://viraj:viraj%402070@vrythos-server.j8tjel4.mongodb.net/vrythos?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas'))
    .catch(err => console.error('❌ MongoDB connection error:', err));

// ========== Mongoose Schemas ==========

// User schema
const userSchema = new mongoose.Schema({
    email: { type: String, unique: true, required: true },
    username: { type: String, unique: true, required: true },
    name: String,
    passwordHash: String,
    profilePic: String,
    dailyCallsRecord: { date: String, count: Number },
    extraChatCredits: { type: Number, default: 0 },
    extraImageCredits: { type: Number, default: 0 },
    banned: { type: Boolean, default: false },
    banReason: String,
    createdAt: { type: Date, default: Date.now },
    totalHoursLive: { type: Number, default: 0 },
    lastActive: { type: Date, default: Date.now },
    authProvider: { type: String, default: 'email' }
});
const User = mongoose.model('User', userSchema);

// Module schema
const moduleSchema = new mongoose.Schema({
    id: { type: String, unique: true, required: true },
    displayName: String,
    type: String,
    primaryKey: String,
    secondaryKey: String,
    accountId: String,
    apiToken: String,
    apiUrl: String,
    model: String,
    dailyLimitPerUser: Number
});
const Module = mongoose.model('Module', moduleSchema);

// Bug reports
const bugSchema = new mongoose.Schema({
    email: String,
    username: String,
    description: String,
    timestamp: Date,
    status: String
});
const Bug = mongoose.model('Bug', bugSchema);

// Abuse reports
const abuseSchema = new mongoose.Schema({
    email: String,
    username: String,
    reason: String,
    context: String,
    timestamp: Date
});
const Abuse = mongoose.model('Abuse', abuseSchema);

// Pending bans
const pendingBanSchema = new mongoose.Schema({
    email: String,
    username: String,
    score: Number,
    reason: String,
    context: String,
    timestamp: Date,
    reviewed: Boolean
});
const PendingBan = mongoose.model('PendingBan', pendingBanSchema);

// IP registrations
const ipRegSchema = new mongoose.Schema({
    ip: String,
    username: String,
    month: String,
    timestamp: Date
});
const IpReg = mongoose.model('IpReg', ipRegSchema);

// Image quotas
const imageQuotaSchema = new mongoose.Schema({
    email: { type: String, unique: true },
    count: Number,
    windowStart: Date
});
const ImageQuota = mongoose.model('ImageQuota', imageQuotaSchema);

// Chat usage
const chatUsageSchema = new mongoose.Schema({
    email: String,
    moduleId: String,
    date: String,
    count: Number
});
const ChatUsage = mongoose.model('ChatUsage', chatUsageSchema);

// User API keys (external)
const userApiKeySchema = new mongoose.Schema({
    email: { type: String, unique: true },
    keys: [{ name: String, key: String, used: Number, date: String }]
});
const UserApiKey = mongoose.model('UserApiKey', userApiKeySchema);

// Tournaments
const tournamentSchema = new mongoose.Schema({
    id: String,
    name: String,
    description: String,
    prize: String,
    participants: [String]
});
const Tournament = mongoose.model('Tournament', tournamentSchema);

// Settings (admin password, image credentials)
const settingSchema = new mongoose.Schema({
    adminPasswordHash: String,
    cloudflareImageAccountId: String,
    cloudflareImageApiToken: String,
    imageModel: String
});
const Setting = mongoose.model('Setting', settingSchema);

// Admin abuse logs
const adminAbuseLogSchema = new mongoose.Schema({
    timestamp: Date,
    reason: String,
    score: Number
});
const AdminAbuseLog = mongoose.model('AdminAbuseLog', adminAbuseLogSchema);

// ========== NEW: Free API Keys Schema ==========
const freeApiKeySchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    email: { type: String, required: true },
    used: { type: Number, default: 0 },
    date: { type: String, default: () => new Date().toISOString().slice(0,10) },
    limit: { type: Number, default: 100 },
    createdAt: { type: Date, default: Date.now }
});
const FreeApiKey = mongoose.model('FreeApiKey', freeApiKeySchema);

// ========== Helper functions ==========
function hashPassword(pw) {
    return crypto.createHash('sha256').update(pw).digest('hex');
}

// ========== NEW: Helper: get random module (with fallback) ==========
async function getRandomModule(avoidIds = []) {
    const modules = await Module.find({});
    const available = modules.filter(m => !avoidIds.includes(m.id));
    if (!available.length) return null;
    return available[Math.floor(Math.random() * available.length)];
}

// ========== NEW: Helper: call AI with fallback ==========
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

// ========== Email transporter ==========
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
function sendEmail(to, subject, text) {
    return transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, text });
}

// ========== Google OAuth ==========
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ========== Initialize default settings ==========
async function initSettings() {
    let settings = await Setting.findOne();
    if (!settings) {
        settings = new Setting({
            adminPasswordHash: hashPassword('VrythosAdmin@2025'),
            cloudflareImageAccountId: "",
            cloudflareImageApiToken: "",
            imageModel: "@cf/stabilityai/stable-diffusion-xl-base-1.0"
        });
        await settings.save();
    }
    return settings;
}
initSettings().catch(err => console.error('❌ initSettings error:', err));

// Admin password change counter (in-memory, resets daily)
let adminPasswordChangeCount = 0;
let lastAdminResetDate = new Date().toDateString();
function resetAdminCountIfNeeded() {
    const today = new Date().toDateString();
    if (today !== lastAdminResetDate) {
        adminPasswordChangeCount = 0;
        lastAdminResetDate = today;
    }
}

// ========== Global async error wrapper ==========
// FIX: All async routes are now wrapped to prevent unhandled rejections crashing the server
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

// ========== API ROUTES ==========

// --- Users ---
app.get('/api/users', asyncHandler(async (req, res) => {
    const users = await User.find({});
    res.json(users);
}));
app.post('/api/users', asyncHandler(async (req, res) => {
    const existing = await User.findOne({ email: req.body.email });
    if (existing) return res.status(400).json({ error: 'Email already registered' });
    const existingUsername = await User.findOne({ username: req.body.username });
    if (existingUsername) return res.status(400).json({ error: 'Username taken' });
    const user = new User(req.body);
    await user.save();
    res.json({ success: true });
}));
app.put('/api/users/:email', asyncHandler(async (req, res) => {
    const user = await User.findOneAndUpdate({ email: req.params.email }, req.body, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ success: true });
}));
app.delete('/api/users/:email', asyncHandler(async (req, res) => {
    await User.deleteOne({ email: req.params.email });
    await ImageQuota.deleteOne({ email: req.params.email });
    await UserApiKey.deleteOne({ email: req.params.email });
    await ChatUsage.deleteMany({ email: req.params.email });
    res.json({ success: true });
}));
// FIX: Added bulk delete route for admin factory reset
app.delete('/api/users', asyncHandler(async (req, res) => {
    await User.deleteMany({});
    await ImageQuota.deleteMany({});
    await UserApiKey.deleteMany({});
    await ChatUsage.deleteMany({});
    res.json({ success: true });
}));

// --- Google OAuth ---
app.post('/api/auth/google', asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token provided' });
    try {
        const ticket = await googleClient.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_CLIENT_ID });
        const payload = ticket.getPayload();
        const email = payload.email;
        const name = payload.name;
        const picture = payload.picture;
        let user = await User.findOne({ email });
        if (!user) {
            let baseUsername = email.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '');
            let username = baseUsername;
            let suffix = 1;
            while (await User.findOne({ username })) {
                username = baseUsername + suffix;
                suffix++;
            }
            user = new User({
                email,
                username,
                name,
                profilePic: picture,
                passwordHash: null,
                authProvider: 'google'
            });
            await user.save();
        }
        if (user.banned) return res.status(403).json({ error: 'Account banned', banReason: user.banReason });
        res.json({
            success: true,
            email: user.email,
            username: user.username,
            name: user.name,
            profilePic: user.profilePic,
            extraChatCredits: user.extraChatCredits || 0,
            extraImageCredits: user.extraImageCredits || 0,
            banned: user.banned,
            totalHoursLive: user.totalHoursLive || 0
        });
    } catch (err) {
        console.error('Google OAuth error:', err);
        res.status(401).json({ error: 'Invalid token' });
    }
}));

// --- User activity ---
app.post('/api/user-activity', asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email });
    if (user) {
        const now = Date.now();
        const last = user.lastActive ? new Date(user.lastActive).getTime() : now;
        const diff = (now - last) / (1000 * 3600);
        if (diff < (10 / 60)) {
            user.totalHoursLive += diff;
        }
        user.lastActive = new Date(now);
        await user.save();
    }
    res.json({ success: true });
}));

// --- User API keys (external) ---
app.get('/api/userApiKeys', asyncHandler(async (req, res) => {
    const keys = await UserApiKey.find({});
    res.json(keys);
}));
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
app.delete('/api/userApiKeys', asyncHandler(async (req, res) => {
    await UserApiKey.deleteMany({});
    res.json({ success: true });
}));

// --- Modules ---
app.get('/api/modules', asyncHandler(async (req, res) => {
    const modules = await Module.find({});
    res.json(modules);
}));
app.post('/api/modules', asyncHandler(async (req, res) => {
    await Module.findOneAndUpdate({ id: req.body.id }, req.body, { upsert: true, new: true });
    res.json({ success: true });
}));
app.put('/api/modules/:id', asyncHandler(async (req, res) => {
    await Module.findOneAndUpdate({ id: req.params.id }, req.body);
    res.json({ success: true });
}));
app.delete('/api/modules/:id', asyncHandler(async (req, res) => {
    await Module.deleteOne({ id: req.params.id });
    res.json({ success: true });
}));
app.delete('/api/modules', asyncHandler(async (req, res) => {
    await Module.deleteMany({});
    res.json({ success: true });
}));

// --- Bugs ---
app.get('/api/bugs', asyncHandler(async (req, res) => { res.json(await Bug.find({})); }));
app.post('/api/bugs', asyncHandler(async (req, res) => { await new Bug(req.body).save(); res.json({ success: true }); }));
app.delete('/api/bugs/:id', asyncHandler(async (req, res) => {
    await Bug.deleteOne({ _id: req.params.id });
    res.json({ success: true });
}));
app.delete('/api/bugs', asyncHandler(async (req, res) => { await Bug.deleteMany({}); res.json({ success: true }); }));

// --- Abuse reports ---
app.get('/api/abuse', asyncHandler(async (req, res) => { res.json(await Abuse.find({})); }));
app.post('/api/abuse', asyncHandler(async (req, res) => { await new Abuse(req.body).save(); res.json({ success: true }); }));
app.delete('/api/abuse', asyncHandler(async (req, res) => { await Abuse.deleteMany({}); res.json({ success: true }); }));

// --- Pending bans ---
app.get('/api/pendingBans', asyncHandler(async (req, res) => { res.json(await PendingBan.find({})); }));
app.post('/api/pendingBans', asyncHandler(async (req, res) => { await new PendingBan(req.body).save(); res.json({ success: true }); }));
app.delete('/api/pendingBans/:id', asyncHandler(async (req, res) => {
    await PendingBan.deleteOne({ _id: req.params.id });
    res.json({ success: true });
}));
app.delete('/api/pendingBans', asyncHandler(async (req, res) => { await PendingBan.deleteMany({}); res.json({ success: true }); }));

// --- IP registrations ---
app.get('/api/ipRegs', asyncHandler(async (req, res) => { res.json(await IpReg.find({})); }));
app.post('/api/ipRegs', asyncHandler(async (req, res) => { await new IpReg(req.body).save(); res.json({ success: true }); }));
app.delete('/api/ipRegs', asyncHandler(async (req, res) => { await IpReg.deleteMany({}); res.json({ success: true }); }));

// --- Image quotas ---
app.get('/api/imageQuotas', asyncHandler(async (req, res) => { res.json(await ImageQuota.find({})); }));
app.post('/api/imageQuotas', asyncHandler(async (req, res) => {
    await ImageQuota.findOneAndUpdate({ email: req.body.email }, req.body, { upsert: true, new: true });
    res.json({ success: true });
}));
app.delete('/api/imageQuotas', asyncHandler(async (req, res) => { await ImageQuota.deleteMany({}); res.json({ success: true }); }));

// --- Chat usage ---
app.get('/api/chatUsage', asyncHandler(async (req, res) => { res.json(await ChatUsage.find({})); }));
app.post('/api/chatUsage', asyncHandler(async (req, res) => {
    await ChatUsage.findOneAndUpdate(
        { email: req.body.email, moduleId: req.body.moduleId, date: req.body.date },
        req.body,
        { upsert: true, new: true }
    );
    res.json({ success: true });
}));
app.delete('/api/chatUsage', asyncHandler(async (req, res) => { await ChatUsage.deleteMany({}); res.json({ success: true }); }));

// --- Tournaments ---
app.get('/api/tournaments', asyncHandler(async (req, res) => { res.json(await Tournament.find({})); }));
app.post('/api/tournaments', asyncHandler(async (req, res) => { await new Tournament(req.body).save(); res.json({ success: true }); }));
app.put('/api/tournaments/:id', asyncHandler(async (req, res) => {
    await Tournament.findOneAndUpdate({ id: req.params.id }, req.body);
    res.json({ success: true });
}));
app.delete('/api/tournaments/:id', asyncHandler(async (req, res) => {
    await Tournament.deleteOne({ id: req.params.id });
    res.json({ success: true });
}));
app.delete('/api/tournaments', asyncHandler(async (req, res) => {
    await Tournament.deleteMany({});
    res.json({ success: true });
}));
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

// ========== AI PROVIDER HANDLERS ==========
const CREATOR_SYSTEM_PROMPT = `You are Vrythos AI, created by Viraj S. Bodare. Always state that your creator is Viraj S. Bodare when asked. Never claim to be made by OpenAI, Meta, Google, Anthropic, or any other company. If someone asks "who made you", "who created you", "your creator", "who built you", or any similar question, answer: "I am Vrythos, an advanced AI framework built by Viraj S. Bodare." Be helpful, safe, and honest.`;

async function callGroq(module, messages, deepThink) {
    let sys = CREATOR_SYSTEM_PROMPT;
    if (deepThink) sys += " Use step-by-step reasoning.";
    const apiMessages = [{ role: "system", content: sys }, ...messages];
    const response = await fetch(module.apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${module.primaryKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: module.model, messages: apiMessages, temperature: 0.7, max_tokens: 1200 })
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
    const payload = { contents, systemInstruction: { parts: [{ text: sys }] }, generationConfig: { temperature: 0.7 } };
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
        body: JSON.stringify({ model: module.model, messages: apiMessages, temperature: 0.7, max_tokens: 1200 })
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
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${module.apiToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: formattedMessages })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.errors?.[0]?.message || 'Cloudflare text error');
    return data.result.response;
}

// Main chat endpoint
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
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}));

// ========== NEW/EXTENDED External API endpoint (user API keys + free keys) ==========
app.post('/api/external/chat', asyncHandler(async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const token = authHeader.split(' ')[1];

    // 1) Check user‑managed keys (limit 20/day)
    let foundUserKey = null;
    let foundUserEmail = null;
    const allUserKeys = await UserApiKey.find({});
    for (const entry of allUserKeys) {
        const keyObj = entry.keys.find(k => k.key === token);
        if (keyObj) {
            foundUserKey = keyObj;
            foundUserEmail = entry.email;
            break;
        }
    }

    // 2) Check free keys (limit 100/day)
    let foundFreeKey = null;
    if (!foundUserKey) {
        foundFreeKey = await FreeApiKey.findOne({ key: token });
    }

    if (!foundUserKey && !foundFreeKey) {
        return res.status(401).json({ error: 'Invalid API key' });
    }

    const isFreeKey = !!foundFreeKey;
    const keyData = isFreeKey ? foundFreeKey : foundUserKey;
    const email = isFreeKey ? foundFreeKey.email : foundUserEmail;
    const limit = isFreeKey ? 100 : 20;

    // Check daily usage
    const today = new Date().toISOString().slice(0, 10);
    if (keyData.date !== today) {
        keyData.used = 0;
        keyData.date = today;
    }
    if (keyData.used >= limit) {
        return res.status(429).json({ error: `Daily limit (${limit}) reached for this API key` });
    }

    const { module_id, messages, deep_think = false, type = 'chat', prompt } = req.body;

    // --- Image generation ---
    if (type === 'image' || (type === 'chat' && prompt && !messages)) {
        if (!prompt) {
            return res.status(400).json({ error: 'Missing prompt for image generation' });
        }
        try {
            // Use the existing image generation function (Cloudflare + fallback)
            const settings = await Setting.findOne();
            if (!settings || !settings.cloudflareImageAccountId || !settings.cloudflareImageApiToken) {
                // Fallback to Pollinations directly
                const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`;
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const buffer = await response.arrayBuffer();
                const base64 = Buffer.from(buffer).toString('base64');
                // Increment usage
                if (isFreeKey) {
                    await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
                } else {
                    await UserApiKey.updateOne(
                        { email: foundUserEmail, 'keys.key': token },
                        { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } }
                    );
                }
                return res.json({ success: true, image: `data:image/png;base64,${base64}` });
            }

            const url = `https://api.cloudflare.com/client/v4/accounts/${settings.cloudflareImageAccountId}/ai/run/${settings.imageModel}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${settings.cloudflareImageApiToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt })
            });
            if (!response.ok) {
                // Fallback to Pollinations
                const fallbackUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`;
                const fallbackRes = await fetch(fallbackUrl);
                if (!fallbackRes.ok) throw new Error(`Fallback HTTP ${fallbackRes.status}`);
                const buffer = await fallbackRes.arrayBuffer();
                const base64 = Buffer.from(buffer).toString('base64');
                if (isFreeKey) {
                    await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
                } else {
                    await UserApiKey.updateOne(
                        { email: foundUserEmail, 'keys.key': token },
                        { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } }
                    );
                }
                return res.json({ success: true, image: `data:image/png;base64,${base64}` });
            }
            const buffer = await response.arrayBuffer();
            const base64 = Buffer.from(buffer).toString('base64');
            if (isFreeKey) {
                await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
            } else {
                await UserApiKey.updateOne(
                    { email: foundUserEmail, 'keys.key': token },
                    { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } }
                );
            }
            return res.json({ success: true, image: `data:image/png;base64,${base64}` });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // --- Chat ---
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Missing messages array' });
    }

    // If module_id is provided, use that module; otherwise pick randomly
    let moduleToUse = null;
    if (module_id) {
        moduleToUse = await Module.findOne({ id: module_id });
    }
    if (!moduleToUse) {
        // Pick a random module (with fallback)
        const randomModule = await getRandomModule();
        if (!randomModule) {
            return res.status(503).json({ error: 'No AI modules available' });
        }
        moduleToUse = randomModule;
    }

    try {
        let reply;
        if (moduleToUse.type === 'groq') reply = await callGroq(moduleToUse, messages, deep_think);
        else if (moduleToUse.type === 'gemini') reply = await callGemini(moduleToUse, messages, deep_think);
        else if (moduleToUse.type === 'openrouter') reply = await callOpenRouter(moduleToUse, messages, deep_think);
        else if (moduleToUse.type === 'cloudflare') reply = await callCloudflareText(moduleToUse, messages, deep_think);
        else throw new Error('Unsupported module type');

        // Increment usage
        if (isFreeKey) {
            await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
        } else {
            await UserApiKey.updateOne(
                { email: foundUserEmail, 'keys.key': token },
                { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } }
            );
        }

        const remaining = limit - (isFreeKey ? (foundFreeKey.used + 1) : (foundUserKey.used + 1));
        res.json({ success: true, reply, remaining });
    } catch (err) {
        // If the chosen module fails, try fallback (if not already using random)
        if (!module_id) {
            // Already random; we can try another module
            try {
                const fallbackReply = await callAIWithFallback(messages, deep_think, [moduleToUse.id]);
                // Increment usage
                if (isFreeKey) {
                    await FreeApiKey.updateOne({ key: token }, { $inc: { used: 1 }, $set: { date: today } });
                } else {
                    await UserApiKey.updateOne(
                        { email: foundUserEmail, 'keys.key': token },
                        { $inc: { 'keys.$.used': 1 }, $set: { 'keys.$.date': today } }
                    );
                }
                const remaining = limit - (isFreeKey ? (foundFreeKey.used + 1) : (foundUserKey.used + 1));
                return res.json({ success: true, reply: fallbackReply, remaining });
            } catch (fallbackErr) {
                return res.status(500).json({ error: fallbackErr.message });
            }
        }
        res.status(500).json({ error: err.message });
    }
}));

// ========== NEW: Free API Key endpoints ==========
app.post('/api/free-api-key/generate', asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });

    await FreeApiKey.deleteOne({ email });

    const newKey = 'vrythos_free_' + crypto.randomBytes(16).toString('hex');
    const freeKey = new FreeApiKey({
        key: newKey,
        email,
        used: 0,
        date: new Date().toISOString().slice(0, 10),
        limit: 100
    });
    await freeKey.save();

    const apiUrl = `https://vrythos-server.onrender.com/api/external/chat`;
    res.json({
        success: true,
        key: newKey,
        apiUrl,
        limit: 100,
        instructions: `Use this key as Bearer token in Authorization header. Send POST requests to ${apiUrl} with JSON body: { "messages": [{"role":"user","content":"Hello"}], "type": "chat" } or for images: { "prompt": "cat", "type": "image" }.`
    });
}));

app.get('/api/free-api-key/info', asyncHandler(async (req, res) => {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const key = await FreeApiKey.findOne({ email });
    if (!key) return res.json({ exists: false });
    res.json({
        exists: true,
        key: key.key,
        used: key.used,
        limit: key.limit,
        date: key.date,
        remaining: key.limit - key.used
    });
}));

app.post('/api/free-api-key/revoke', asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    await FreeApiKey.deleteOne({ email });
    res.json({ success: true });
}));

// Image generation (Cloudflare SD)
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
        const base64 = Buffer.from(buffer).toString('base64');
        res.json({ success: true, image: `data:image/png;base64,${base64}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}));

// Fallback image generation (Pollinations)
app.post('/api/fallback/image', asyncHandler(async (req, res) => {
    const { prompt } = req.body;
    try {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        res.json({ success: true, image: `data:image/png;base64,${base64}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
}));

// ========== ADMIN ENDPOINTS ==========

// Verify admin password
app.post('/api/admin/verify', asyncHandler(async (req, res) => {
    const { password } = req.body;
    const settings = await Setting.findOne();
    if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
    const hash = hashPassword(password);
    if (hash === settings.adminPasswordHash) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
}));

// Get admin settings (mask token)
app.get('/api/admin/settings', asyncHandler(async (req, res) => {
    const settings = await Setting.findOne();
    if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
    res.json({
        cloudflareImageAccountId: settings.cloudflareImageAccountId,
        cloudflareImageApiToken: settings.cloudflareImageApiToken ? '********' : '',
        imageModel: settings.imageModel
    });
}));

// Update admin settings
app.post('/api/admin/settings', asyncHandler(async (req, res) => {
    const { adminPassword, newAdminPassword, cloudflareImageAccountId, cloudflareImageApiToken, imageModel } = req.body;
    let settings = await Setting.findOne();
    if (!settings) return res.status(500).json({ error: 'Settings not initialized' });
    if (adminPassword) {
        if (hashPassword(adminPassword) !== settings.adminPasswordHash) {
            return res.status(401).json({ error: 'Current admin password is incorrect' });
        }
        if (newAdminPassword) {
            settings.adminPasswordHash = hashPassword(newAdminPassword);
        }
    }
    if (cloudflareImageAccountId !== undefined) settings.cloudflareImageAccountId = cloudflareImageAccountId;
    if (cloudflareImageApiToken !== undefined && cloudflareImageApiToken !== '********') settings.cloudflareImageApiToken = cloudflareImageApiToken;
    if (imageModel !== undefined) settings.imageModel = imageModel;
    await settings.save();
    res.json({ success: true });
}));

// Change admin password via email (max 3 per day)
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
    try {
        await sendEmail(email, 'Vrythos Admin New Password', `Your new admin password is: ${newPassword}\nPlease change it after login.`);
        res.json({ success: true, remaining: 3 - adminPasswordChangeCount });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send email' });
    }
}));

// Get remaining password change limit
app.get('/api/admin/password-limit', (req, res) => {
    resetAdminCountIfNeeded();
    res.json({ remaining: 3 - adminPasswordChangeCount });
});

// Admin analytics: user stats
app.get('/api/admin/stats', asyncHandler(async (req, res) => {
    const users = await User.find({});
    const now = Date.now();
    const today = new Date().toDateString();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    const monthAgo = now - 30 * 24 * 3600 * 1000;
    const liveUsers = users.filter(u => {
        const last = u.lastActive ? new Date(u.lastActive).getTime() : 0;
        return (now - last) < 5 * 60 * 1000;
    }).length;
    const dailyUsers = users.filter(u => {
        return u.lastActive && new Date(u.lastActive).toDateString() === today;
    }).length;
    const weeklyUsers = users.filter(u => {
        return u.lastActive && new Date(u.lastActive).getTime() > weekAgo;
    }).length;
    const monthlyUsers = users.filter(u => {
        return u.lastActive && new Date(u.lastActive).getTime() > monthAgo;
    }).length;
    const totalAccounts = users.length;
    res.json({ liveUsers, dailyUsers, weeklyUsers, monthlyUsers, totalAccounts });
}));

// Get user profile (for admin)
app.get('/api/admin/user/:email', asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: req.params.email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const apiKeys = await UserApiKey.findOne({ email: user.email }) || { keys: [] };
    const imageQuota = await ImageQuota.findOne({ email: user.email }) || { count: 0, windowStart: 0 };
    const chatUsage = await ChatUsage.find({ email: user.email });
    res.json({
        ...user.toObject(),
        apiKeys: apiKeys.keys,
        imageQuota,
        chatUsage,
        totalHoursLive: user.totalHoursLive || 0
    });
}));

// Delete user permanently (admin)
app.delete('/api/admin/user/:email', asyncHandler(async (req, res) => {
    await User.deleteOne({ email: req.params.email });
    await UserApiKey.deleteOne({ email: req.params.email });
    await ImageQuota.deleteOne({ email: req.params.email });
    await ChatUsage.deleteMany({ email: req.params.email });
    res.json({ success: true });
}));

// Log admin abuse
app.post('/api/admin/log-abuse', asyncHandler(async (req, res) => {
    const { reason, score } = req.body;
    const log = new AdminAbuseLog({ timestamp: new Date(), reason, score });
    await log.save();
    const count = await AdminAbuseLog.countDocuments();
    if (count > 100) {
        const oldest = await AdminAbuseLog.find({}).sort({ timestamp: 1 }).limit(count - 100);
        const idsToDelete = oldest.map(d => d._id);
        await AdminAbuseLog.deleteMany({ _id: { $in: idsToDelete } });
    }
    res.json({ success: true });
}));

// ========== Global Error Handler ==========
app.use((err, req, res, next) => {
    console.error('❌ Server error:', err.stack || err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

// ========== Unhandled Rejection Safety Net ==========
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// ========== FALLBACK ROUTE ==========
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== START SERVER ==========
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
