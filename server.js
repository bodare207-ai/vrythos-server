const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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

// ========== API ROUTES ==========

// Users
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
    // Clean up related data
    let imgQuotas = readJSON('imageQuotas.json');
    imgQuotas = imgQuotas.filter(q => q.username !== req.params.username);
    writeJSON('imageQuotas.json', imgQuotas);
    let apiKeys = readJSON('userApiKeys.json');
    apiKeys = apiKeys.filter(k => k.username !== req.params.username);
    writeJSON('userApiKeys.json', apiKeys);
    res.json({ success: true });
});

// Modules
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

// Bugs
app.get('/api/bugs', (req, res) => { res.json(readJSON('bugs.json')); });
app.post('/api/bugs', (req, res) => {
    let bugs = readJSON('bugs.json');
    bugs.push(req.body);
    writeJSON('bugs.json', bugs);
    res.json({ success: true });
});
app.delete('/api/bugs', (req, res) => { writeJSON('bugs.json', []); res.json({ success: true }); });

// Abuse reports
app.get('/api/abuse', (req, res) => { res.json(readJSON('abuse.json')); });
app.post('/api/abuse', (req, res) => {
    let abuse = readJSON('abuse.json');
    abuse.push(req.body);
    writeJSON('abuse.json', abuse);
    res.json({ success: true });
});
app.delete('/api/abuse', (req, res) => { writeJSON('abuse.json', []); res.json({ success: true }); });

// Pending bans
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
    if (!isNaN(idx) && idx >= 0 && idx < pending.length) {
        pending.splice(idx, 1);
        writeJSON('pendingBans.json', pending);
    }
    res.json({ success: true });
});
app.delete('/api/pendingBans', (req, res) => { writeJSON('pendingBans.json', []); res.json({ success: true }); });

// IP registrations
app.get('/api/ipRegs', (req, res) => { res.json(readJSON('ipRegs.json')); });
app.post('/api/ipRegs', (req, res) => {
    let regs = readJSON('ipRegs.json');
    regs.push(req.body);
    writeJSON('ipRegs.json', regs);
    res.json({ success: true });
});
app.delete('/api/ipRegs', (req, res) => { writeJSON('ipRegs.json', []); res.json({ success: true }); });

// User API keys
app.get('/api/userApiKeys', (req, res) => { res.json(readJSON('userApiKeys.json')); });
app.post('/api/userApiKeys', (req, res) => {
    let keys = readJSON('userApiKeys.json');
    const existingIdx = keys.findIndex(k => k.username === req.body.username);
    if (existingIdx !== -1) keys[existingIdx] = req.body;
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

// Image quotas
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

// Chat usage
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

// ========== EXTERNAL API (for user API keys) ==========
const EXTERNAL_DAILY_LIMIT = 20;

app.post('/api/external/chat', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid Authorization header. Use Bearer YOUR_API_KEY' });
    }
    const token = authHeader.split(' ')[1];
    // Find the key in userApiKeys.json
    let allKeys = readJSON('userApiKeys.json');
    let found = null;
    let foundUser = null;
    for (const entry of allKeys) {
        const keyObj = entry.keys.find(k => k.key === token);
        if (keyObj) {
            found = keyObj;
            foundUser = entry.username;
            break;
        }
    }
    if (!found) return res.status(401).json({ error: 'Invalid API key' });

    // Check daily limit
    const today = new Date().toISOString().slice(0, 10);
    if (found.date !== today) {
        found.used = 0;
        found.date = today;
    }
    if (found.used >= EXTERNAL_DAILY_LIMIT) {
        return res.status(429).json({ error: `Daily limit (${EXTERNAL_DAILY_LIMIT}) reached for this API key.` });
    }

    const { module_id, messages, deep_think = false } = req.body;
    if (!module_id) return res.status(400).json({ error: 'module_id required' });
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array required' });

    // Get module config
    const modules = readJSON('modules.json');
    const module = modules.find(m => m.id === module_id);
    if (!module) return res.status(404).json({ error: 'Module not found' });

    // Only Cloudflare is supported in this demo
    if (module.type !== 'cloudflare') {
        return res.status(400).json({ error: 'Only Cloudflare AI modules are supported for external API' });
    }

    const CLOUD_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
    const CLOUD_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
    if (!CLOUD_ACCOUNT || !CLOUD_TOKEN) {
        return res.status(500).json({ error: 'Cloudflare credentials not configured on server' });
    }

    const sys = "You are Vrythos AI, created by Viraj S. Bodare. Be helpful.";
    const formattedMessages = [{ role: "system", content: sys }, ...messages];
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUD_ACCOUNT}/ai/run/${module.model}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: formattedMessages })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.errors?.[0]?.message || 'Cloudflare error');
        
        // Increment usage
        found.used += 1;
        // Save back to userApiKeys.json
        const userEntry = allKeys.find(e => e.username === foundUser);
        const keyIndex = userEntry.keys.findIndex(k => k.key === token);
        userEntry.keys[keyIndex] = found;
        writeJSON('userApiKeys.json', allKeys);
        
        res.json({ success: true, reply: data.result.response, remaining: EXTERNAL_DAILY_LIMIT - found.used });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========== CLOUDFLARE AI PROXY ==========
const CLOUD_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";
const CLOUD_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const IMAGE_MODEL = "@cf/stabilityai/stable-diffusion-xl-base-1.0";

app.post('/api/cloudflare/text', async (req, res) => {
    if (!CLOUD_ACCOUNT || !CLOUD_TOKEN) {
        return res.status(500).json({ success: false, error: "Cloudflare credentials not set on server" });
    }
    const { messages } = req.body;
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUD_ACCOUNT}/ai/run/${TEXT_MODEL}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages })
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.errors?.[0]?.message || "Cloudflare error");
        res.json({ success: true, response: data.result.response });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/cloudflare/image', async (req, res) => {
    if (!CLOUD_ACCOUNT || !CLOUD_TOKEN) {
        return res.status(500).json({ success: false, error: "Cloudflare credentials not set on server" });
    }
    const { prompt } = req.body;
    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${CLOUD_ACCOUNT}/ai/run/${IMAGE_MODEL}`;
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
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

// Fallback route for any other GET request – serve index.html (for client-side routing)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
