// ... (existing code) ...

// ========== Free API Keys Schema ==========
const freeApiKeySchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    email: { type: String, required: true },
    used: { type: Number, default: 0 },
    date: { type: String, default: () => new Date().toISOString().slice(0,10) },
    limit: { type: Number, default: 100 },
    createdAt: { type: Date, default: Date.now }
});
const FreeApiKey = mongoose.model('FreeApiKey', freeApiKeySchema);

// ========== Helper: get random module (with fallback) ==========
async function getRandomModule(avoidIds = []) {
    const modules = await Module.find({});
    const available = modules.filter(m => !avoidIds.includes(m.id));
    if (!available.length) return null;
    return available[Math.floor(Math.random() * available.length)];
}

// ========== Helper: call AI with fallback ==========
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
        // If this module failed, try another one (up to 3 attempts)
        attemptedModules.push(module.id);
        if (attemptedModules.length >= 3) throw err;
        return callAIWithFallback(messages, deepThink, attemptedModules);
    }
}

// ========== External API (extended for free keys & image) ==========
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

// ========== Generate Free API Key ==========
app.post('/api/free-api-key/generate', asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Check if user exists
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.banned) return res.status(403).json({ error: 'Account banned' });

    // If user already has a free key, delete it (revoke old) and generate new
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

// ========== (optional) Get user's free key info ==========
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

// ========== (optional) Revoke free key ==========
app.delete('/api/free-api-key/revoke', asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    await FreeApiKey.deleteOne({ email });
    res.json({ success: true });
}));

// ... (rest of server.js unchanged) ...
