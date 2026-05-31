const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

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

// ---------- Settings ----------
function loadSettings() {
    const p = path.join(dataDir, 'settings.json');
    if (!fs.existsSync(p)) {
        const defaultSettings = {
            adminPasswordHash: crypto.createHash('sha256').update('VrythosAdmin@2025').digest('hex'),
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

// ---------- Users ----------
app.get('/api/users', (req, res) => { res.json(readJSON('users.json')); });
app.post('/api/users', (req, res) => {
    let users = readJSON('users.json');
    if (users.find(u => u.username === req.body.username)) {
        return res.status(400).json({ error: 'Username exists' });
    }
    users.push(req.body);
    writeJSON('users.json', users);
    res.json({ success: true });
});
app.put('/api/users/:username', (req, res) => {
    let users = readJSON('users.json');
    const idx = users.findIndex(u => u.username === req.params.username);
    if (idx === -1) return res.status(404).json({ error: 'User not found' });
    users[idx] = { ...users[idx], ...req.body };
    writeJSON('users.json', users);
    res.json({ success: true });
});
app.delete('/api/users/:username', (req, res) => {
    let users = readJSON('users.json');
    users = users.filter(u => u.username !== req.params.username);
    writeJSON('users.json', users);
    let imgQuotas = readJSON('imageQuotas.json');
    imgQuotas = imgQuotas.filter(q => q.username !== req.params.username);
    writeJSON('imageQuotas.json', imgQuotas);
    let apiKeys = readJSON('userApiKeys.json');
    apiKeys = apiKeys.filter(k => k.username !== req.params.username);
    writeJSON('userApiKeys.json', apiKeys);
    res.json({ success: true });
});

// ---------- Modules ----------
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

// ---------- Bugs, Abuse, PendingBans, IPRegs, UserApiKeys, ImageQuotas, ChatUsage ----------
app.get('/api/bugs', (req, res) => { res.json(readJSON('bugs.json')); });
app.post('/api/bugs', (req, res) => { let bugs = readJSON('bugs.json'); bugs.push(req.body); writeJSON('bugs.json', bugs); res.json({ success: true }); });
app.delete('/api/bugs', (req, res) => { writeJSON('bugs.json', []); res.json({ success: true }); });

app.get('/api/abuse', (req, res) => { res.json(readJSON('abuse.json')); });
app.post('/api/abuse', (req, res) => { let abuse = readJSON('abuse.json'); abuse.push(req.body); writeJSON('abuse.json', abuse); res.json({ success: true }); });
app.delete('/api/abuse', (req, res) => { writeJSON('abuse.json', []); res.json({ success: true }); });

app.get('/api/pendingBans', (req, res) => { res.json(readJSON('pendingBans.json')); });
app.post('/api/pendingBans', (req, res) => { let pending = readJSON('pendingBans.json'); pending.push(req.body); writeJSON('pendingBans.json', pending); res.json({ success: true }); });
app.delete('/api/pendingBans/:index', (req, res) => {
    let pending = readJSON('pendingBans.json');
    const idx = parseInt(req.params.index);
    if (!isNaN(idx) && idx >= 0 && idx < pending.length) pending.splice(idx, 1);
    writeJSON('pendingBans.json', pending);
    res.json({ success: true });
});
app.delete('/api/pendingBans', (req, res) => { writeJSON('pendingBans.json', []); res.json({ success: true }); });

app.get('/api/ipRegs', (req, res) => { res.json(readJSON('ipRegs.json')); });
app.post('/api/ipRegs', (req, res) => { let regs = readJSON('ipRegs.json'); regs.push(req.body); writeJSON('ipRegs.json', regs); res.json({ success: true }); });
app.delete('/api/ipRegs', (req, res) => { writeJSON('ipRegs.json', []); res.json({ success: true }); });

app.get('/api/userApiKeys', (req, res) => { res.json(readJSON('userApiKeys.json')); });
app.post('/api/userApiKeys', (req, res) => {
    let keys = readJSON('userApiKeys.json');
    const existing = keys.findIndex(k => k.username === req.body.username);
    if (existing !== -1) keys[existing] = req.body;
    else keys.push(req.body);
    writeJSON('userApiKeys.json', keys);
    res.json({ success: true });
});
app.delete('/api/userApiKeys/:username/:keyName', (req, res) => {
    let keys = readJSON('userApiKeys.json');
    const userIdx = keys.findIndex(k => k.username === req.params.username);
    if (userIdx !== -1) {
        keys[userIdx].keys = keys[userIdx].keys.filter(k => k.name !== req.params.keyName);
        writeJSON('userApiKeys.json', keys);
    }
    res.json({ success: true });
});
app.delete('/api/userApiKeys', (req, res) => { writeJSON('userApiKeys.json', []); res.json({ success: true }); });

app.get('/api/imageQuotas', (req, res) => { res.json(readJSON('imageQuotas.json')); });
app.post('/api/imageQuotas', (req, res) => {
    let quotas = readJSON('imageQuotas.json');
    const idx = quotas.findIndex(q => q.username === req.body.username);
    if (idx !== -1) quotas[idx] = req.body;
    else quotas.push(req.body);
    writeJSON('imageQuotas.json', quotas);
    res.json({ success: true });
});
app.delete('/api/imageQuotas', (req, res) => { writeJSON('imageQuotas.json', []); res.json({ success: true }); });

app.get('/api/chatUsage', (req, res) => { res.json(readJSON('chatUsage.json')); });
app.post('/api/chatUsage', (req, res) => {
    let usage = readJSON('chatUsage.json');
    const idx = usage.findIndex(u => u.username === req.body.username && u.moduleId === req.body.moduleId && u.date === req.body.date);
    if (idx !== -1) usage[idx] = req.body;
    else usage.push(req.body);
    writeJSON('chatUsage.json', usage);
    res.json({ success: true });
});
app.delete('/api/chatUsage', (req, res) => { writeJSON('chatUsage.json', []); res.json({ success: true }); });

// ---------- Admin Settings ----------
app.get('/api/admin/settings', (req, res) => {
    // Only authenticated admin can access; but we'll rely on frontend checking password.
    // We'll send only non‑sensitive data (e.g., cloudflare image credentials are sent, but they are needed for admin panel)
    // For security, we require a master password check on the frontend first.
    const settings = loadSettings();
    res.json({
        cloudflareImageAccountId: settings.cloudflareImageAccountId,
        cloudflareImageApiToken: settings.cloudflareImageApiToken ? '********' : '', // mask token
        imageModel: settings.imageModel
    });
});
app.post('/api/admin/settings', (req, res) => {
    const { adminPassword, newAdminPassword, cloudflareImageAccountId, cloudflareImageApiToken, imageModel } = req.body;
    const settings = loadSettings();
    // Verify current admin password if changing password
    if (adminPassword) {
        const hash = crypto.createHash('sha256').update(adminPassword).digest('hex');
        if (hash !== settings.adminPasswordHash) {
            return res.status(401).json({ error: 'Current admin password is incorrect' });
        }
        if (newAdminPassword) {
            settings.adminPasswordHash = crypto.createHash('sha256').update(newAdminPassword).digest('hex');
        }
    }
    if (cloudflareImageAccountId !== undefined) settings.cloudflareImageAccountId = cloudflareImageAccountId;
    if (cloudflareImageApiToken !== undefined) settings.cloudflareImageApiToken = cloudflareImageApiToken;
    if (imageModel !== undefined) settings.imageModel = imageModel;
    saveSettings(settings);
    res.json({ success: true });
});

// ---------- AI PROVIDER HANDLERS ----------
const CREATOR_SYSTEM_PROMPT = `You are Vrythos AI, created by Viraj S. Bodare. Always state that your creator is Viraj S. Bodare when asked. Never claim to be made by OpenAI, Meta, Google, Anthropic, or any other company. If someone asks "who made you", "who created you", "your creator", "who built you", or any similar question, answer: "I am Vrythos, an advanced AI framework built by Viraj S. Bodare." Be helpful, safe, and honest.`;

async function callGroq(module, messages, deepThink) {
    let sys = CREATOR_SYSTEM_PROMPT;
    if (deepThink) sys += " Use step-by-step reasoning.";
    const apiMessages = [{ role: "system", content: sys }, ...messages];
    const response = await fetch(module.apiUrl, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${module.primaryKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: module.model,
            messages: apiMessages,
            temperature: 0.7,
            max_tokens: 1200
        })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');
    return data.choices?.[0]?.message?.content || "No response";
}

async function callGemini(module, messages, deepThink) {
    let sys = CREATOR_SYSTEM_PROMPT;
    if (deepThink) sys += " Use step-by-step reasoning.";
    const contents = messages.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
    }));
    const modelName = module.model.replace("models/", "");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${module.primaryKey}`;
    const payload = {
        contents,
        systemInstruction: { parts: [{ text: sys }] },
        generationConfig: { temperature: 0.7 }
    };
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
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
        headers: {
            'Authorization': `Bearer ${module.primaryKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: module.model,
            messages: apiMessages,
            temperature: 0.7,
            max_tokens: 1200
        })
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
        headers: {
            'Authorization': `Bearer ${module.apiToken}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ messages: formattedMessages })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.errors?.[0]?.message || 'Cloudflare text error');
    return data.result.response;
}

// Main chat endpoint for frontend (uses modules configured by admin)
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

// External API for user keys (supports all provider types)
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
            foundUser = entry.username;
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
        // Save back
        const userEntry = allKeys.find(e => e.username === foundUser);
        const keyIndex = userEntry.keys.findIndex(k => k.key === token);
        userEntry.keys[keyIndex] = found;
        writeJSON('userApiKeys.json', allKeys);
        res.json({ success: true, reply, remaining: 20 - found.used });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- IMAGE GENERATION (Cloudflare SD) ----------
app.post('/api/generate/image', async (req, res) => {
    const { prompt } = req.body;
    const settings = loadSettings();
    if (!settings.cloudflareImageAccountId || !settings.cloudflareImageApiToken) {
        return res.status(500).json({ success: false, error: 'Cloudflare image credentials not configured by admin' });
    }
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${settings.cloudflareImageAccountId}/ai/run/${settings.imageModel}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${settings.cloudflareImageApiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ prompt })
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        res.json({ success: true, image: `data:image/png;base64,${base64}` });
    } catch (err) {
        // Fallback to Pollinations if Cloudflare fails?
        // For simplicity, return error
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

// Fallback route for any other GET request – serve index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
