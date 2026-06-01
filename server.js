const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Data directory
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

// ========== Email transporter (free – Gmail) ==========
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ========== Helper functions ==========
function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function sendEmail(to, subject, text) {
    return transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: to,
        subject: subject,
        text: text
    });
}

// ========== User & Verification Storage ==========
let pendingVerifications = {}; // email -> { code, expires, username, name, passwordHash }

// ========== API Routes ==========

// --- Users (with email & password) ---
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
    res.json({ success: true });
});

// --- Send verification code ---
app.post('/api/send-verification', async (req, res) => {
    const { email, username, name, passwordHash } = req.body;
    // Check if email already used in any user
    let users = readJSON('users.json');
    if (users.find(u => u.email === email)) {
        return res.status(400).json({ error: 'Email already registered' });
    }
    const code = generateVerificationCode();
    const expires = Date.now() + 30 * 60 * 1000; // 30 minutes
    pendingVerifications[email] = { code, expires, username, name, passwordHash };
    try {
        await sendEmail(email, 'Vrythos AI Verification Code', `Your verification code is: ${code}\nValid for 30 minutes.`);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to send email' });
    }
});

// --- Verify code and complete registration ---
app.post('/api/verify-register', (req, res) => {
    const { email, code } = req.body;
    const pending = pendingVerifications[email];
    if (!pending) return res.status(400).json({ error: 'No pending verification' });
    if (pending.code !== code) return res.status(400).json({ error: 'Invalid code' });
    if (Date.now() > pending.expires) return res.status(400).json({ error: 'Code expired' });
    // Create user
    let users = readJSON('users.json');
    const newUser = {
        email,
        username: pending.username,
        name: pending.name,
        passwordHash: pending.passwordHash,
        profilePic: "",
        dailyCallsRecord: { date: "", count: 0 },
        extraChatCredits: 0,
        extraImageCredits: 0,
        banned: false,
        createdAt: Date.now(),
        totalHoursLive: 0, // will be updated via periodic pings
        lastActive: Date.now()
    };
    users.push(newUser);
    writeJSON('users.json', users);
    delete pendingVerifications[email];
    res.json({ success: true });
});

// --- User activity tracking (update lastActive and totalHoursLive) ---
app.post('/api/user-activity', (req, res) => {
    const { email } = req.body;
    let users = readJSON('users.json');
    const idx = users.findIndex(u => u.email === email);
    if (idx !== -1) {
        const now = Date.now();
        const last = users[idx].lastActive || now;
        const diff = (now - last) / (1000 * 3600); // hours
        users[idx].totalHoursLive = (users[idx].totalHoursLive || 0) + diff;
        users[idx].lastActive = now;
        writeJSON('users.json', users);
    }
    res.json({ success: true });
});

// --- API Keys for users ---
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

// --- Modules (same as before) ---
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

// --- Bugs, Abuse, PendingBans, IPRegs, ImageQuotas, ChatUsage (same as before) ---
// (keep all previous routes for these – omitted for brevity but will be in final code)

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

// --- Admin Settings (password, email logs) ---
let adminPasswordChangeCount = 0;
let lastResetDate = new Date().toDateString();

function resetAdminCount() {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
        adminPasswordChangeCount = 0;
        lastResetDate = today;
    }
}

app.post('/api/admin/change-password', async (req, res) => {
    const { email, newPassword } = req.body;
    if (email !== 'bodare207@gmail.com') return res.status(403).json({ error: 'Unauthorized' });
    resetAdminCount();
    if (adminPasswordChangeCount >= 3) {
        return res.status(429).json({ error: 'Daily password change limit reached (3 per day).' });
    }
    // Update admin password in settings.json (or a separate file)
    let settings = readJSON('settings.json');
    if (!settings.length) settings = {};
    settings.adminPasswordHash = crypto.createHash('sha256').update(newPassword).digest('hex');
    writeJSON('settings.json', settings);
    adminPasswordChangeCount++;
    // Send email with new password
    try {
        await sendEmail(email, 'Vrythos Admin New Password', `Your new admin password is: ${newPassword}\nPlease change it after login.`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send email' });
    }
});

// --- Admin analytics: users stats ---
app.get('/api/admin/stats', (req, res) => {
    const users = readJSON('users.json');
    const now = Date.now();
    const today = new Date().toDateString();
    const weekAgo = now - 7 * 24 * 3600 * 1000;
    const monthAgo = now - 30 * 24 * 3600 * 1000;
    const liveUsers = users.filter(u => (now - (u.lastActive || 0)) < 5 * 60 * 1000).length; // last 5 min
    const dailyUsers = users.filter(u => new Date(u.lastActive || 0).toDateString() === today).length;
    const weeklyUsers = users.filter(u => (u.lastActive || 0) > weekAgo).length;
    const monthlyUsers = users.filter(u => (u.lastActive || 0) > monthAgo).length;
    const totalAccounts = users.length;
    res.json({ liveUsers, dailyUsers, weeklyUsers, monthlyUsers, totalAccounts });
});

// --- Admin get user details (including API keys, hours, etc.) ---
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

// --- Admin delete user (permanent) ---
app.delete('/api/admin/user/:email', (req, res) => {
    let users = readJSON('users.json');
    users = users.filter(u => u.email !== req.params.email);
    writeJSON('users.json', users);
    // delete related data
    let apiKeys = readJSON('userApiKeys.json');
    apiKeys = apiKeys.filter(k => k.email !== req.params.email);
    writeJSON('userApiKeys.json', apiKeys);
    let imgQuotas = readJSON('imageQuotas.json');
    imgQuotas = imgQuotas.filter(q => q.email !== req.params.email);
    writeJSON('imageQuotas.json', imgQuotas);
    res.json({ success: true });
});

// --- AI Chat Endpoint (same as before) ---
app.post('/api/chat', async (req, res) => {
    // (keep existing implementation)
});

// --- Image generation (Cloudflare SD) ---
app.post('/api/generate/image', async (req, res) => {
    // (keep existing implementation)
});

// Fallback image
app.post('/api/fallback/image', async (req, res) => {
    // (keep existing implementation)
});

// Serve index.html for any unmatched GET
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
