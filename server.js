const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Helper: read/write JSON files
function readJSON(file) {
    try {
        const p = path.join(dataDir, file);
        if (!fs.existsSync(p)) return [];
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return []; }
}
function writeJSON(file, data) {
    fs.writeFileSync(path.join(dataDir, file), JSON.stringify(data, null, 2));
}

// ========== Email transporter (free Gmail) ==========
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

function sendEmail(to, subject, text) {
    return transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: to,
        subject: subject,
        text: text
    });
}

// ========== Helper functions ==========
function hashPassword(pw) {
    return crypto.createHash('sha256').update(pw).digest('hex');
}

// ========== Google OAuth client ==========
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ========== Settings (admin password, Cloudflare image credentials) ==========
function loadSettings() {
    const p = path.join(dataDir, 'settings.json');
    if (!fs.existsSync(p)) {
        const defaultSettings = {
            adminPasswordHash: hashPassword('VrythosAdmin@2025'),
            cloudflareImageAccountId: "",
            cloudflareImageApiToken: "",
            imageModel: "@cf/stabilityai/stable-diffusion-xl-base-1.0"
        };
        writeJSON('settings.json', defaultSettings);
        return defaultSettings;
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function saveSettings(settings) {
    writeJSON('settings.json', settings);
}

// ========== Admin password change counter ==========
let adminPasswordChangeCount = 0;
let lastAdminResetDate = new Date().toDateString();

function resetAdminCountIfNeeded() {
    const today = new Date().toDateString();
    if (today !== lastAdminResetDate) {
        adminPasswordChangeCount = 0;
        lastAdminResetDate = today;
    }
}

// ========== API ROUTES ==========

// --- Users ---
app.get('/api/users', (req, res) => { res.json(readJSON('users.json')); });

app.post('/api/users', (req, res) => {
    let users = readJSON('users.json');
    if (users.find(u => u.email === req.body.email)) {
        return res.status(400).json({ error: 'Email already registered' });
    }
    if (users.find(u => u.username === req.body.username)) {
        return res.status(400).json({ error: 'Username taken' });
    }
    users.push(req.body);
    writeJSON('users.json', users);
    res.json({ success: true });
});

app.put('/api/users/:email', (req, res) => {
    let users = readJSON('users.json');
    const idx = users.findIndex(u => u.email === req.params.email);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = { ...users[idx], ...req.body };
    writeJSON('users.json', users);
    res.json({ success: true });
});

app.delete('/api/users/:email', (req, res) => {
    let users = readJSON('users.json');
    users = users.filter(u => u.email !== req.params.email);
    writeJSON('users.json', users);
    // Clean related data
    let imgQuotas = readJSON('imageQuotas.json');
    imgQuotas = imgQuotas.filter(q => q.email !== req.params.email);
    writeJSON('imageQuotas.json', imgQuotas);
    let apiKeys = readJSON('userApiKeys.json');
    apiKeys = apiKeys.filter(k => k.email !== req.params.email);
    writeJSON('userApiKeys.json', apiKeys);
    let chatUsage = readJSON('chatUsage.json');
    chatUsage = chatUsage.filter(c => c.email !== req.params.email);
    writeJSON('chatUsage.json', chatUsage);
    res.json({ success: true });
});

// --- Google OAuth login ---
app.post('/api/auth/google', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'No token provided' });
    try {
        const ticket = await googleClient.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        const email = payload.email;
        const name = payload.name;
        const picture = payload.picture;
        let users = readJSON('users.json');
        let user = users.find(u => u.email === email);
        if (!user) {
            // Auto-register
            const newUser = {
                email,
                username: email.split('@')[0],
                name: name,
                profilePic: picture,
                passwordHash: null,
                dailyCallsRecord: { date: "", count: 0 },
                extraChatCredits: 0,
                extraImageCredits: 0,
                banned: false,
                createdAt: Date.now(),
                totalHoursLive: 0,
                lastActive: Date.now(),
                authProvider: 'google'
            };
            users.push(newUser);
            writeJSON('users.json', users);
            user = newUser;
        }
        if (user.banned) return res.status(403).json({ error: 'Account banned' });
        res.json({ success: true, email: user.email, username: user.username, name: user.name, profilePic: user.profilePic });
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

// --- User activity tracking ---
app.post('/api/user-activity', (req, res) => {
    const { email } = req.body;
    let users = readJSON('users.json');
    const idx = users.findIndex(u => u.email === email);
    if (idx !== -1) {
        const now = Date.now();
        const last = users[idx].lastActive || now;
        const diff = (now - last) / (1000 * 3600);
        users[idx].totalHoursLive = (users[idx].totalHoursLive || 0) + diff;
        users[idx].lastActive = now;
        writeJSON('users.json', users);
    }
    res.json({ success: true });
});

// --- User API Keys (external) ---
app.get('/api/userApiKeys', (req, res) => { res.json(readJSON('userApiKeys.json')); });
app.post('/api/userApiKeys', (req, res) => {
    let keys = readJSON('userApiKeys.json');
    const idx = keys.findIndex(k => k.email === req.body.email);
    if (idx !== -1) keys[idx] = req.body;
    else keys.push(req.body);
    writeJSON('userApiKeys.json', keys);
    res.json({ success: true });
});
app.delete('/api/userApiKeys/:email/:keyName', (req, res) => {
    let keys = readJSON('userApiKeys.json');
    const idx = keys.findIndex(k => k.email === req.params.email);
    if (idx !== -1) {
        keys[idx].keys = keys[idx].keys.filter(k => k.name !== req.params.keyName);
        writeJSON('userApiKeys.json', keys);
    }
    res.json({ success: true });
});

// --- Modules (AI engines) ---
app.get('/api/modules', (req, res) => { res.json(readJSON('modules.json')); });
app.post('/api/modules', (req, res) => {
    let modules = readJSON('modules.json');
    modules.push(req.body);
    writeJSON('modules.json', modules);
    res.json({ success: true });
});
app.put('/api/modules/:id', (req, res) => {
    let modules = readJSON('modules.json');
    const idx = modules.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Module not found' });
    modules[idx] = { ...modules[idx], ...req.body };
    writeJSON('modules.json', modules);
    res.json({ success: true });
});
app.delete('/api/modules/:id', (req, res) => {
    let modules = readJSON('modules.json');
    modules = modules.filter(m => m.id !== req.params.id);
    writeJSON('modules.json', modules);
    res.json({ success: true });
});

// --- Bugs ---
app.get('/api/bugs', (req, res) => { res.json(readJSON('bugs.json')); });
app.post('/api/bugs', (req, res) => {
    let bugs = readJSON('bugs.json');
    bugs.push(req.body);
    writeJSON('bugs.json', bugs);
    res.json({ success: true });
});
app.delete('/api/bugs', (req, res) => { writeJSON('bugs.json', []); res.json({ success: true }); });

// --- Abuse reports ---
app.get('/api/abuse', (req, res) => { res.json(readJSON('abuse.json')); });
app.post('/api/abuse', (req, res) => {
    let abuse = readJSON('abuse.json');
    abuse.push(req.body);
    writeJSON('abuse.json', abuse);
    res.json({ success: true });
});
app.delete('/api/abuse', (req, res) => { writeJSON('abuse.json', []); res.json({ success: true }); });

// --- Pending bans ---
app.get('/api/pendingBans', (req, res) => { res.json(readJSON('pendingBans.json')); });
app.post('/api/pendingBans', (req, res) => {
    let pending = readJSON('pendingBans.json');
    pending.push(req.body);
    writeJSON('pendingBans.json', pending);
    res.json({ success: true });
});
app.delete('/api/pendingBans/:index', (req, res) => {
    let pending = readJSON('pendingBans.json');
    const idx = parseInt(req.params.index);
    if (!isNaN(idx) && idx >= 0 && idx < pending.length) pending.splice(idx, 1);
    writeJSON('pendingBans.json', pending);
    res.json({ success: true });
});
app.delete('/api/pendingBans', (req, res) => { writeJSON('pendingBans.json', []); res.json({ success: true }); });

// --- IP registrations (for monthly limit, optional) ---
app.get('/api/ipRegs', (req, res) => { res.json(readJSON('ipRegs.json')); });
app.post('/api/ipRegs', (req, res) => {
    let regs = readJSON('ipRegs.json');
    regs.push(req.body);
    writeJSON('ipRegs.json', regs);
    res.json({ success: true });
});
app.delete('/api/ipRegs', (req, res) => { writeJSON('ipRegs.json', []); res.json({ success: true }); });

// --- Image quotas ---
app.get('/api/imageQuotas', (req, res) => { res.json(readJSON('imageQuotas.json')); });
app.post('/api/imageQuotas', (req, res) => {
    let quotas = readJSON('imageQuotas.json');
    const idx = quotas.findIndex(q => q.email === req.body.email);
    if (idx !== -1) quotas[idx] = req.body;
    else quotas.push(req.body);
    writeJSON('imageQuotas.json', quotas);
    res.json({ success: true });
});
app.delete('/api/imageQuotas', (req, res) => { writeJSON('imageQuotas.json', []); res.json({ success: true }); });

// --- Chat usage ---
app.get('/api/chatUsage', (req, res) => { res.json(readJSON('chatUsage.json')); });
app.post('/api/chatUsage', (req, res) => {
    let usage = readJSON('chatUsage.json');
    const idx = usage.findIndex(u => u.email === req.body.email && u.moduleId === req.body.moduleId && u.date === req.body.date);
    if (idx !== -1) usage[idx] = req.body;
    else usage.push(req.body);
    writeJSON('chatUsage.json', usage);
    res.json({ success: true });
});
app.delete('/api/chatUsage', (req, res) => { writeJSON('chatUsage.json', []); res.json({ success: true }); });

// --- Tournaments ---
app.get('/api/tournaments', (req, res) => { res.json(readJSON('tournaments.json')); });
app.post('/api/tournaments', (req, res) => {
    let tournaments = readJSON('tournaments.json');
    tournaments.push(req.body);
    writeJSON('tournaments.json', tournaments);
    res.json({ success: true });
});
app.put('/api/tournaments/:id', (req, res) => {
    let tournaments = readJSON('tournaments.json');
    const idx = tournaments.findIndex(t => t.id === req.params.id);
    if (idx !== -1) tournaments[idx] = { ...tournaments[idx], ...req.body };
    writeJSON('tournaments.json', tournaments);
    res.json({ success: true });
});
app.delete('/api/tournaments/:id', (req, res) => {
    let tournaments = readJSON('tournaments.json');
    tournaments = tournaments.filter(t => t.id !== req.params.id);
    writeJSON('tournaments.json', tournaments);
    res.json({ success: true });
});
app.post('/api/join-tournament', (req, res) => {
    const { email, tournamentId } = req.body;
    let tournaments = readJSON('tournaments.json');
    const tournament = tournaments.find(t => t.id === tournamentId);
    if (!tournament) return res.status(404).json({ error: 'Tournament not found' });
    if (!tournament.participants) tournament.participants = [];
    if (tournament.participants.includes(email)) return res.json({ success: false, message: 'Already joined' });
    tournament.participants.push(email);
    writeJSON('tournaments.json', tournaments);
    res.json({ success: true });
});

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

// Main chat endpoint for frontend
app.post('/api/chat', async (req, res) => {
    const { module_id, messages, deep_think } = req.body;
    const modules = readJSON('modules.json');
    const module = modules.find(m => m.id === module_id);
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
});

// External API endpoint for user API keys (supports all providers)
app.post('/api/external/chat', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const token = authHeader.split(' ')[1];
    let allKeys = readJSON('userApiKeys.json');
    let found = null, foundUser = null;
    for (const entry of allKeys) {
        const keyObj = entry.keys.find(k => k.key === token);
        if (keyObj) {
            found = keyObj;
            foundUser = entry.email;
            break;
        }
    }
    if (!found) return res.status(401).json({ error: 'Invalid API key' });
    const today = new Date().toISOString().slice(0, 10);
    if (found.date !== today) {
        found.used = 0;
        found.date = today;
    }
    if (found.used >= 20) {
        return res.status(429).json({ error: 'Daily limit (20) reached for this API key' });
    }
    const { module_id, messages, deep_think = false } = req.body;
    if (!module_id) return res.status(400).json({ error: 'module_id required' });
    const modules = readJSON('modules.json');
    const module = modules.find(m => m.id === module_id);
    if (!module) return res.status(404).json({ error: 'Module not found' });
    try {
        let reply;
        if (module.type === 'groq') reply = await callGroq(module, messages, deep_think);
        else if (module.type === 'gemini') reply = await callGemini(module, messages, deep_think);
        else if (module.type === 'openrouter') reply = await callOpenRouter(module, messages, deep_think);
        else if (module.type === 'cloudflare') reply = await callCloudflareText(module, messages, deep_think);
        else throw new Error('Unsupported module type');
        found.used++;
        const userEntry = allKeys.find(e => e.email === foundUser);
        const keyIndex = userEntry.keys.findIndex(k => k.key === token);
        userEntry.keys[keyIndex] = found;
        writeJSON('userApiKeys.json', allKeys);
        res.json({ success: true, reply, remaining: 20 - found.used });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Image generation (Cloudflare SD)
app.post('/api/generate/image', async (req, res) => {
    const { prompt } = req.body;
    const settings = loadSettings();
    if (!settings.cloudflareImageAccountId || !settings.cloudflareImageApiToken) {
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
});

// Fallback image generation (Pollinations)
app.post('/api/fallback/image', async (req, res) => {
    const { prompt } = req.body;
    try {
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux`;
        const response = await fetch(url);
        if (!response.ok) throw new Error();
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        res.json({ success: true, image: `data:image/png;base64,${base64}` });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ========== ADMIN ENDPOINTS ==========

// Verify admin password
app.post('/api/admin/verify', (req, res) => {
    const { password } = req.body;
    const settings = loadSettings();
    const hash = hashPassword(password);
    if (hash === settings.adminPasswordHash) {
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// Get admin settings (image credentials - token masked)
app.get('/api/admin/settings', (req, res) => {
    const settings = loadSettings();
    res.json({
        cloudflareImageAccountId: settings.cloudflareImageAccountId,
        cloudflareImageApiToken: settings.cloudflareImageApiToken ? '********' : '',
        imageModel: settings.imageModel
    });
});

// Update admin settings (image credentials, password)
app.post('/api/admin/settings', (req, res) => {
    const { adminPassword, newAdminPassword, cloudflareImageAccountId, cloudflareImageApiToken, imageModel } = req.body;
    const settings = loadSettings();
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
    saveSettings(settings);
    res.json({ success: true });
});

// Change admin password via email (max 3 per day)
app.post('/api/admin/change-password', async (req, res) => {
    const { email, newPassword } = req.body;
    if (email !== 'bodare207@gmail.com') return res.status(403).json({ error: 'Unauthorized email' });
    resetAdminCountIfNeeded();
    if (adminPasswordChangeCount >= 3) {
        return res.status(429).json({ error: 'Daily password change limit reached (3 per day).' });
    }
    const settings = loadSettings();
    settings.adminPasswordHash = hashPassword(newPassword);
    saveSettings(settings);
    adminPasswordChangeCount++;
    try {
        await sendEmail(email, 'Vrythos Admin New Password', `Your new admin password is: ${newPassword}\nPlease change it after login.`);
        res.json({ success: true, remaining: 3 - adminPasswordChangeCount });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send email' });
    }
});

// Get remaining password change limit
app.get('/api/admin/password-limit', (req, res) => {
    resetAdminCountIfNeeded();
    res.json({ remaining: 3 - adminPasswordChangeCount });
});

// Admin analytics: user stats
app.get('/api/admin/stats', (req, res) => {
    const users = readJSON('users.json');
    const now = Date.now();
    const today = new Date().toDateString();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    const monthAgo = now - 30 * 24 * 3600 * 1000;
    const liveUsers = users.filter(u => (now - (u.lastActive || 0)) < 5 * 60 * 1000).length;
    const dailyUsers = users.filter(u => new Date(u.lastActive || 0).toDateString() === today).length;
    const weeklyUsers = users.filter(u => (u.lastActive || 0) > weekAgo).length;
    const monthlyUsers = users.filter(u => (u.lastActive || 0) > monthAgo).length;
    const totalAccounts = users.length;
    res.json({ liveUsers, dailyUsers, weeklyUsers, monthlyUsers, totalAccounts });
});

// Get user profile (for admin)
app.get('/api/admin/user/:email', (req, res) => {
    const users = readJSON('users.json');
    const user = users.find(u => u.email === req.params.email);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const apiKeys = readJSON('userApiKeys.json').find(k => k.email === user.email) || { keys: [] };
    const imageQuota = readJSON('imageQuotas.json').find(q => q.email === user.email) || { count: 0, windowStart: 0 };
    const chatUsage = readJSON('chatUsage.json').filter(c => c.email === user.email);
    res.json({
        ...user,
        apiKeys: apiKeys.keys,
        imageQuota,
        chatUsage,
        totalHoursLive: user.totalHoursLive || 0
    });
});

// Delete user permanently (admin)
app.delete('/api/admin/user/:email', (req, res) => {
    let users = readJSON('users.json');
    users = users.filter(u => u.email !== req.params.email);
    writeJSON('users.json', users);
    let apiKeys = readJSON('userApiKeys.json');
    apiKeys = apiKeys.filter(k => k.email !== req.params.email);
    writeJSON('userApiKeys.json', apiKeys);
    let imgQuotas = readJSON('imageQuotas.json');
    imgQuotas = imgQuotas.filter(q => q.email !== req.params.email);
    writeJSON('imageQuotas.json', imgQuotas);
    let chatUsage = readJSON('chatUsage.json');
    chatUsage = chatUsage.filter(c => c.email !== req.params.email);
    writeJSON('chatUsage.json', chatUsage);
    res.json({ success: true });
});

// Log admin abuse (optional)
app.post('/api/admin/log-abuse', (req, res) => {
    const { reason, score } = req.body;
    let logs = readJSON('adminAbuseLogs.json');
    logs.push({ timestamp: Date.now(), reason, score });
    writeJSON('adminAbuseLogs.json', logs.slice(-100));
    res.json({ success: true });
});

// ========== FALLBACK ROUTE ==========
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== START SERVER ==========
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
