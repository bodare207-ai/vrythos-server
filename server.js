const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Google OAuth client (set GOOGLE_CLIENT_ID env variable)
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ========== Helper functions ==========
function hashPassword(pw) {
    return crypto.createHash('sha256').update(pw).digest('hex');
}

// ========== Settings (admin password) ==========
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

// ========== API ROUTES ==========

// --- Users ---
app.get('/api/users', (req, res) => { res.json(readJSON('users.json')); });

app.post('/api/users', (req, res) => {
    let users = readJSON('users.json');
    if (users.find(u => u.email === req.body.email)) {
        return res.status(400).json({ error: 'Email already registered' });
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
                passwordHash: null, // no password for OAuth users
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

// --- Instagram & Telegram placeholders (will be implemented if keys provided) ---
app.post('/api/auth/instagram', (req, res) => {
    res.status(501).json({ error: 'Instagram OAuth not configured. Please set INSTAGRAM_CLIENT_ID and INSTAGRAM_CLIENT_SECRET.' });
});
app.post('/api/auth/telegram', (req, res) => {
    res.status(501).json({ error: 'Telegram OAuth not configured. Please set TELEGRAM_BOT_TOKEN.' });
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

// --- Bugs, Abuse, PendingBans, IPRegs, ImageQuotas, ChatUsage, Tournaments (same as before) ---
// (Include all previous routes from the last server.js - for brevity, assume they are present)
// I'll add the essential ones here, but you should keep the full set from earlier.

// --- AI Chat Endpoint (unchanged) ---
app.post('/api/chat', async (req, res) => { /* ... same as before ... */ });

// --- Image generation (Cloudflare SD) ---
app.post('/api/generate/image', async (req, res) => { /* ... same ... */ });
app.post('/api/fallback/image', async (req, res) => { /* ... same ... */ });

// --- Admin endpoints (stats, user profile, delete user, etc.) ---
// (keep all from previous server.js)

// --- Fallback route ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
