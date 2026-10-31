// agent-module.js — Vrythos AI Agent: Wikipedia + Web Search + URL Reader
// No external npm packages. Pure Node.js fetch.

const tools = [
  {
    type: "function",
    function: {
      name: "fetch_url",
      description: "Fetch and read the contents of a specific web page URL. Use this whenever the user gives you a URL and wants you to look at what's on that page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The full URL, e.g. https://example.com" }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the live web for current events, news, or anything that changes over time. Use when you need up-to-date information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_wikipedia",
      description: "Search Wikipedia for facts, biographies, history, science. Use for encyclopedic questions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The topic, e.g. 'Albert Einstein'" }
        },
        required: ["query"]
      }
    }
  }
];

// ========== TOOL IMPLEMENTATIONS ==========

// 1) Fetch any URL and return readable text
async function fetchUrl(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'Error: Only http:// or https:// URLs are allowed.';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return `Error: HTTP ${response.status} when fetching ${url}`;
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text') && !contentType.includes('html') && !contentType.includes('json') && !contentType.includes('xml')) {
      return `Cannot read content type "${contentType}". Only text/HTML/JSON pages are supported.`;
    }

    const raw = await response.text();
    const truncated = raw.slice(0, 20000); // 20 KB max

    let cleaned = truncated;
    if (contentType.includes('html') || contentType.includes('xml')) {
      cleaned = truncated
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }

    return `Contents of ${url}:\n\n${cleaned}`;
  } catch (err) {
    if (err.name === 'AbortError') return 'Error: Request timed out after 12 seconds.';
    return `Error fetching ${url}: ${err.message}`;
  }
}

// 2) Web search via DuckDuckGo HTML (free, no API key)
async function webSearch(query) {
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

// 3) Wikipedia search (free, no API key)
async function searchWikipedia(query) {
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
    return summary.extract || 'Article found but no summary available.';
  } catch (err) {
    return `Wikipedia error: ${err.message}`;
  }
}

// ========== AGENT LOOP ==========
export async function runAgent(userMessage, conversationHistory = [], groqApiKey) {
  const messages = [
    {
      role: "system",
      content: `You are Vrythos AI, created by Viraj S. Bodare.

You DO have the ability to access the internet through your tools. NEVER say "I cannot browse the internet" or "I don't have access to real-time data". You CAN.

Your tools:
- fetch_url → read the contents of any URL the user gives you
- web_search → search the live web for current info
- search_wikipedia → look up encyclopedic facts

Examples of when to use tools:
- User gives a URL → ALWAYS use fetch_url
- User asks about today's news or current events → use web_search
- User asks "what is X" about a stable factual topic → search_wikipedia

If a tool fails, try another. Never give up without trying.

When providing code, use triple backticks with the language specifier.`
    },
    ...conversationHistory,
    { role: "user", content: userMessage }
  ];

  for (let step = 0; step < 5; step++) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.7,
        max_tokens: 8000
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');

    const aiMessage = data.choices[0].message;
    messages.push(aiMessage);

    if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
      return { reply: aiMessage.content, toolUsed: null, steps: step + 1 };
    }

    const toolsUsedThisStep = [];
    for (const toolCall of aiMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);
      let toolResult = '';

      if (toolName === 'fetch_url') toolResult = await fetchUrl(toolArgs.url);
      else if (toolName === 'web_search') toolResult = await webSearch(toolArgs.query);
      else if (toolName === 'search_wikipedia') toolResult = await searchWikipedia(toolArgs.query);
      else toolResult = `Unknown tool: ${toolName}`;

      toolsUsedThisStep.push(toolName);
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });
    }

    // If this is the last allowed step and the AI wants to keep using tools, force it to answer
    if (step === 4) {
      const forceAnswer = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [...messages, { role: 'user', content: 'Now answer the original question based on the information you found.' }],
          temperature: 0.7,
          max_tokens: 8000
        })
      });
      const forceData = await forceAnswer.json();
      return {
        reply: forceData.choices[0].message.content,
        toolUsed: toolsUsedThisStep.join(', '),
        steps: step + 1
      };
    }
  }

  return { reply: 'I ran out of steps. Please try again.', toolUsed: 'multiple', steps: 5 };
}
