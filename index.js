require('dotenv').config();
const fs = require('fs');
const { TelegramClient, Api } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");
const axios = require("axios");

const apiId = Number(process.env.API_ID);
const apiHash = process.env.API_HASH;
const storeSession = new StoreSession('/session');
const FEATURE_FLAG_LLM = process.env.FEATURE_FLAG_LLM === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Load system prompt from prompt.txt
const GEMINI_SYSTEM_PROMPT = fs.existsSync('prompt.txt')
  ? fs.readFileSync('prompt.txt', 'utf8').trim()
  : "You are a helpful assistant.";

// Choose your Gemini / Google AI Studio model here:
const GEMINI_MODEL = "gemini-2.0-flash";  // Supports system instructions

const sendHelpMenu = async (client, userId) => {
  await client.sendMessage(userId, {
    message:
`🎬 *MovieBot Commands*:
• /search <movie or series> – find files
• /ask <your question> – talk to Gemini AI (if enabled)`
  });
};

const askGeminiAI = async (userPrompt) => {
  if (!FEATURE_FLAG_LLM || !GEMINI_API_KEY) return "AI is currently disabled.";
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    
    // Proper format: systemInstruction separate from user message
    const requestBody = {
      systemInstruction: {
        parts: [{ text: GEMINI_SYSTEM_PROMPT }]
      },
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 512
      }
    };

    const res = await axios.post(url, requestBody, {
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY
      }
    });

    return res.data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
  } catch (e) {
    console.error("Gemini API error:", e.response?.data || e.message || e);
    return "Error: AI could not reply.";
  }
};

const paginateResults = async (client, userId, results, pageSize = 10) => {
  let currentPage = 0;
  const totalPages = Math.ceil(results.length / pageSize);

  const sendPage = async () => {
    const start = currentPage * pageSize;
    const end = Math.min(start + pageSize, results.length);
    for (let i = start; i < end; i++) {
      await client.sendMessage(userId, { message: results[i] });
    }
    await client.sendMessage(userId, {
      message: `📄 Page ${currentPage + 1}/${totalPages}\nUse /next or /prev to see more results.`
    });
  };

  await sendPage();

  return async (msgText) => {
    if (msgText === '/next' && currentPage < totalPages - 1) {
      currentPage++;
      await sendPage();
      return true;
    } else if (msgText === '/prev' && currentPage > 0) {
      currentPage--;
      await sendPage();
      return true;
    }
    return false;
  };
};

try {
  const startBot = async () => {
    const client = new TelegramClient(storeSession, apiId, apiHash, {
      connectionRetries: 5,
    });

    await client.start({
      phoneNumber: process.env.PHONE_NUMBER,
      phoneCode: async () => await input.text("Please enter the code you received: "),
      onError: (err) => console.log(err),
    });

    console.log('Bot started ✅');

    let paginationHandler = null;

    const messageHandler = async (newMessage) => {
      const msgText = newMessage.message.message.trim();
      const userId = newMessage.message.fromId;

      // Ignore all normal (non-command) messages
      if (!msgText.startsWith('/')) return;

      // Help / Start
      if (msgText === "/help" || msgText === "/start") {
        await sendHelpMenu(client, userId);
        return;
      }

      // Pagination commands
      if (paginationHandler && (msgText === '/next' || msgText === '/prev')) {
        const handled = await paginationHandler(msgText);
        if (handled) return;
      }

      // Handle /ask (Gemini) - properly separate system prompt from user message
      if (FEATURE_FLAG_LLM && msgText.startsWith("/ask")) {
        const userPrompt = msgText.replace(/^\/ask\s*/i, "");
        if (userPrompt.length < 3) {
          await client.sendMessage(userId, { message: "Ask me something!" });
          return;
        }
        await client.sendMessage(userId, { message: "🤖 Thinking..." });
        const aiReply = await askGeminiAI(userPrompt);
        await client.sendMessage(userId, { message: aiReply });
        return;
      }

      // Handle /search
      if (msgText.startsWith('/search')) {
        const searchQuery = msgText.replace('/search', '').trim();
        if (!searchQuery) {
          await client.sendMessage(userId, { message: "Please specify a movie or series name. Example: /search Inception" });
          return;
        }

        await client.sendMessage(userId, { message: `🔎 Searching for *${searchQuery}*...` });

        const messageToSend = [];
        const mediaIDs = new Set();

        const searchInTelegram = async (query) => {
          for await (const message of client.iterMessages(undefined, {
            search: query,
            limit: undefined,
            filter: new Api.InputMessagesFilterDocument(),
          })) {
            if (message.media?.document?.size.value < 52428800) continue;
            if (!mediaIDs.has(message.media.document.id.value)) {
              mediaIDs.add(message.media.document.id.value);
              messageToSend.push(message.message || "(unnamed file)");
            }
          }
        };

        await searchInTelegram(searchQuery);

        if (messageToSend.length === 0) {
          await client.sendMessage(userId, { message: "😕 No results found." });
          return;
        }

        paginationHandler = await paginateResults(client, userId, messageToSend, 10);
        return;
      }

      // Unknown command fallback
      await client.sendMessage(userId, { message: "❓ Unknown command. Try /help for available commands." });
    };

    client.addEventHandler(messageHandler, new NewMessage({}));
  };

  startBot();
} catch (err) {
  console.log("Bot error:", err);
}
