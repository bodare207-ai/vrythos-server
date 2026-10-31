// agent-module.js — Your AI's "eyes and hands" on the web
// Add this ONE file to your Vrythos project. No other changes needed.

// ========== 1. IMPORT SEARCH LIBRARY ==========
// Install once: npm install @purili/web-search
import { purili } from '@purili/web-search';

// ========== 2. DEFINE YOUR TOOLS ==========
// These are the "abilities" your AI can decide to use.

const tools = [
  {
    type: "function",
    function: {
      name: "search_wikipedia",
      description: "Search Wikipedia for facts, biographies, history, science, or any encyclopedic topic. Use this when the user asks a factual question.",
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
      description: "Search the live web for current events, news, prices, weather, or anything that changes over time. Use this when you need up-to-date information.",
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

// ========== 3. IMPLEMENT THE TOOLS ==========

// Wikipedia search — free, no API key needed
async function searchWikipedia(query) {
  try {
    // Step 1: Find the best matching article title
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&origin=*`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    
    if (!searchData.query?.search?.length) {
      return "No Wikipedia article found for that query.";
    }
    
    const bestTitle = searchData.query.search[0].title;
    
    // Step 2: Get the summary of that article
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

// Web search — free, no API key needed (via Purili)
async function webSearch(query) {
  try {
    const response = await purili.search(query);
    if (!response.results?.length) {
      return "No web results found.";
    }
    // Return the top 3 results as readable text
    return response.results.slice(0, 3).map(r =>
      `Title: ${r.title}\nURL: ${r.url}\nSnippet: ${r.description || ''}`
    ).join('\n\n');
  } catch (err) {
    return `Web search failed: ${err.message}`;
  }
}

// ========== 4. THE AGENT LOOP ==========
// This is the core: AI decides → we execute → AI answers.

export async function runAgent(userMessage, conversationHistory = [], groqApiKey) {
  // Build the message list (system prompt + history + new message)
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

  // Loop up to 5 times (prevents infinite agent loops)
  for (let step = 0; step < 5; step++) {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile', // Groq's best tool-calling model
        messages: messages,
        tools: tools,
        tool_choice: 'auto', // Let the AI decide when to use a tool
        temperature: 0.7
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Groq API error');

    const aiMessage = data.choices[0].message;
    messages.push(aiMessage); // Add AI's response to history

    // If the AI did NOT call a tool, we're done — return the text answer
    if (!aiMessage.tool_calls || aiMessage.tool_calls.length === 0) {
      return {
        reply: aiMessage.content,
        toolUsed: null,
        steps: step + 1
      };
    }

    // If the AI DID call a tool, execute it
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

      // Send the tool result back to the AI
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResult
      });
    }

    // Loop continues → AI reads tool result → may call another tool or answer
  }

  return {
    reply: "I tried to complete your request but ran out of steps. Please try rephrasing.",
    toolUsed: "multiple",
    steps: 5
  };
}
