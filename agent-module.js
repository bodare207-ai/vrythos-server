// agent-module.js — Vrythos AI Agent (Wikipedia + Web Search)
// This file gives your AI the ability to look things up and search the web.

import { purili } from '@purili/web-search';

// ========== 1. TOOL DEFINITIONS ==========
// These tell the AI what it can do.
const tools = [
  {
    type: "function",
    function: {
      name: "search_wikipedia",
      description: "Search Wikipedia for facts, biographies, history, science, or any encyclopedic topic. Use when the user asks a factual question.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The topic to search for, e.g. 'Albert Einstein' or 'history of AI'" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the live web for current events, news, prices, weather, or anything that changes over time. Use when you need up-to-date information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query, e.g. 'latest AI news' or 'weather in Mumbai'" }
        },
        required: ["query"]
      }
    }
  }
];

// ========== 2. TOOL IMPLEMENTATIONS ==========

// Wikipedia search — free, no API key
async function searchWikipedia(query) {
  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    if (!searchData.query?.search?.length) {
      return "No Wikipedia article found for that query.";
    }
    const bestTitle = searchData.query.search[0].title;
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(bestTitle)}`;
    const summaryRes = await fetch(summaryUrl, {
      headers: { 'User-Agent': 'VrythosAI/1.0 (https://vrythos-server.onrender.com)' }
    });
    const summaryData = await summaryRes.json();
    return summaryData.extract || "Wikipedia article found but no summary available.";
  } catch (err) {
    return `Wikipedia search failed: ${err.message}`;
  }
}

// Web search — free, no API key (via Purili)
async function webSearch(query) {
  try {
    const response = await purili.search(query);
    if (!response.results?.length) {
      return "No web results found.";
    }
    return response.results.slice(0, 3).map(r =>
      `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.description || ''}`
    ).join('\n\n');
  } catch (err) {
    return `Web search failed: ${err.message}`;
  }
}

// ========== 3. AGENT LOOP ==========
// This is the core: AI decides → we execute → AI answers.
export async function runAgent(userMessage, conversationHistory = [], groqApiKey) {
  const messages = [
    {
      role: "system",
      content: `You are Vrythos AI, created by Viraj S. Bodare. You have access to tools.
- Use search_wikipedia for factual/encyclopedic questions.
- Use web_search for current events, news, or anything time-sensitive.
- If you don't need a tool, just answer directly.
- Always be helpful, safe, and honest. When providing code, use triple backticks.`
    },
    ...conversationHistory,
    { role: "user", content: userMessage }
  ];

  // Loop up to 5 times to prevent infinite agent loops
  for (let step = 0; step < 5; step++) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        tools: tools,
        tool_choice: 'auto',
        temperature: 0.7
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');

    const aiMessage = data.choices[0].message;
    messages.push(aiMessage);

    // If no tool call, return the answer
    if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
      return { reply: aiMessage.content, toolUsed: null, steps: step + 1 };
    }

    // Execute each tool call
    for (const toolCall of aiMessage.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = JSON.parse(toolCall.function.arguments);
      let toolResult = '';

      if (toolName === 'search_wikipedia') {
        toolResult = await searchWikipedia(toolArgs.query);
      } else if (toolName === 'web_search') {
        toolResult = await webSearch(toolArgs.query);
      } else {
        toolResult = `Unknown tool: ${toolName}`;
      }

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult
      });
    }
  }

  return {
    reply: "I tried to complete your request but ran out of steps. Please try rephrasing.",
    toolUsed: "multiple",
    steps: 5
  };
}
