require('dotenv').config();
const fs = require('fs');
const { TelegramClient, Api } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { Raw } = require("telegram/events");
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

const GEMINI_MODEL = "gemini-2.0-flash";

// ============= RATE LIMITING CONFIGURATION =============
const RATE_LIMIT_CONFIG = {
  GLOBAL_MAX_REQUESTS_PER_MINUTE: 12,
  GLOBAL_MAX_REQUESTS_PER_DAY: 180,
  USER_MAX_REQUESTS_PER_MINUTE: 5,
  USER_MAX_REQUESTS_PER_HOUR: 20,
  USER_MAX_REQUESTS_PER_DAY: 50,
  MINUTE_WINDOW: 60 * 1000,
  HOUR_WINDOW: 60 * 60 * 1000,
  DAY_WINDOW: 24 * 60 * 60 * 1000,
};

// ============= CONVERSATION MEMORY CONFIGURATION =============
const MEMORY_CONFIG = {
  MAX_HISTORY_LENGTH: 10,
  CONTEXT_WINDOW_MINUTES: 30,
  MAX_TOKENS_PER_MESSAGE: 500,
};

// ============= STATE MANAGEMENT =============
const globalRateLimits = {
  requestTimestamps: [],
  dailyCount: 0,
  lastDailyReset: Date.now(),
};

const userRateLimits = new Map();
const conversationMemory = new Map();

// Store pagination state: userId -> { results, currentPage, messageId }
const paginationState = new Map();

// ============= RATE LIMITING FUNCTIONS =============

const cleanOldTimestamps = (timestamps, windowMs) => {
  const now = Date.now();
  return timestamps.filter(ts => now - ts < windowMs);
};

const resetDailyCounters = () => {
  const now = Date.now();
  if (now - globalRateLimits.lastDailyReset >= RATE_LIMIT_CONFIG.DAY_WINDOW) {
    globalRateLimits.dailyCount = 0;
    globalRateLimits.lastDailyReset = now;
  }

  for (const [userId, limits] of userRateLimits.entries()) {
    if (now - limits.lastReset >= RATE_LIMIT_CONFIG.DAY_WINDOW) {
      limits.dailyCount = 0;
      limits.lastReset = now;
    }
  }
};

const checkGlobalRateLimit = () => {
  resetDailyCounters();
  const now = Date.now();

  if (globalRateLimits.dailyCount >= RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS_PER_DAY) {
    const resetTime = new Date(globalRateLimits.lastDailyReset + RATE_LIMIT_CONFIG.DAY_WINDOW);
    return {
      allowed: false,
      reason: `Global daily limit reached (${RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS_PER_DAY} requests/day). Resets at ${resetTime.toLocaleTimeString()}.`
    };
  }

  globalRateLimits.requestTimestamps = cleanOldTimestamps(
    globalRateLimits.requestTimestamps,
    RATE_LIMIT_CONFIG.MINUTE_WINDOW
  );

  if (globalRateLimits.requestTimestamps.length >= RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS_PER_MINUTE) {
    const oldestRequest = Math.min(...globalRateLimits.requestTimestamps);
    const waitSeconds = Math.ceil((oldestRequest + RATE_LIMIT_CONFIG.MINUTE_WINDOW - now) / 1000);
    return {
      allowed: false,
      reason: `Global rate limit exceeded. Please try again in ${waitSeconds} seconds.`
    };
  }

  return { allowed: true };
};

const checkUserRateLimit = (userId) => {
  resetDailyCounters();

  if (!userRateLimits.has(userId)) {
    userRateLimits.set(userId, {
      requestTimestamps: [],
      dailyCount: 0,
      lastReset: Date.now(),
    });
  }

  const userLimits = userRateLimits.get(userId);
  const now = Date.now();

  if (userLimits.dailyCount >= RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_DAY) {
    const resetTime = new Date(userLimits.lastReset + RATE_LIMIT_CONFIG.DAY_WINDOW);
    return {
      allowed: false,
      reason: `You've reached your daily limit (${RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_DAY} requests/day). Resets at ${resetTime.toLocaleTimeString()}.`
    };
  }

  userLimits.requestTimestamps = cleanOldTimestamps(
    userLimits.requestTimestamps,
    RATE_LIMIT_CONFIG.HOUR_WINDOW
  );

  const requestsInLastHour = userLimits.requestTimestamps.filter(
    ts => now - ts < RATE_LIMIT_CONFIG.HOUR_WINDOW
  ).length;

  if (requestsInLastHour >= RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_HOUR) {
    const oldestInHour = Math.min(...userLimits.requestTimestamps.filter(
      ts => now - ts < RATE_LIMIT_CONFIG.HOUR_WINDOW
    ));
    const waitMinutes = Math.ceil((oldestInHour + RATE_LIMIT_CONFIG.HOUR_WINDOW - now) / 60000);
    return {
      allowed: false,
      reason: `You've reached your hourly limit (${RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_HOUR} requests/hour). Try again in ${waitMinutes} minutes.`
    };
  }

  const requestsInLastMinute = userLimits.requestTimestamps.filter(
    ts => now - ts < RATE_LIMIT_CONFIG.MINUTE_WINDOW
  ).length;

  if (requestsInLastMinute >= RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_MINUTE) {
    const oldestInMinute = Math.min(...userLimits.requestTimestamps.filter(
      ts => now - ts < RATE_LIMIT_CONFIG.MINUTE_WINDOW
    ));
    const waitSeconds = Math.ceil((oldestInMinute + RATE_LIMIT_CONFIG.MINUTE_WINDOW - now) / 1000);
    return {
      allowed: false,
      reason: `You're sending requests too quickly. Wait ${waitSeconds} seconds.`
    };
  }

  return { allowed: true };
};

const recordRequest = (userId) => {
  const now = Date.now();
  globalRateLimits.requestTimestamps.push(now);
  globalRateLimits.dailyCount++;

  const userLimits = userRateLimits.get(userId);
  userLimits.requestTimestamps.push(now);
  userLimits.dailyCount++;
};

// ============= CONVERSATION MEMORY FUNCTIONS =============

const truncateMessage = (text, maxTokens = MEMORY_CONFIG.MAX_TOKENS_PER_MESSAGE) => {
  const maxChars = maxTokens * 4;
  return text.length > maxChars ? text.substring(0, maxChars) + '...' : text;
};

const getConversationHistory = (userId) => {
  if (!conversationMemory.has(userId)) {
    conversationMemory.set(userId, {
      history: [],
      lastActivity: Date.now(),
    });
  }

  const conversation = conversationMemory.get(userId);
  const now = Date.now();
  const inactiveTime = now - conversation.lastActivity;

  if (inactiveTime > MEMORY_CONFIG.CONTEXT_WINDOW_MINUTES * 60 * 1000) {
    conversation.history = [];
  }

  return conversation.history;
};

const addToConversationHistory = (userId, role, content) => {
  if (!conversationMemory.has(userId)) {
    conversationMemory.set(userId, {
      history: [],
      lastActivity: Date.now(),
    });
  }

  const conversation = conversationMemory.get(userId);
  conversation.lastActivity = Date.now();

  conversation.history.push({
    role: role,
    content: truncateMessage(content),
    timestamp: Date.now(),
  });

  if (conversation.history.length > MEMORY_CONFIG.MAX_HISTORY_LENGTH) {
    conversation.history = conversation.history.slice(-MEMORY_CONFIG.MAX_HISTORY_LENGTH);
  }
};

const clearConversationHistory = (userId) => {
  if (conversationMemory.has(userId)) {
    conversationMemory.get(userId).history = [];
  }
};

const formatHistoryForAPI = (history) => {
  return history.map(msg => ({
    role: msg.role === 'user' ? 'user' : 'model',
    parts: [{ text: msg.content }]
  }));
};

// ============= HELPER FUNCTIONS =============

const sendHelpMenu = async (client, userId) => {
  await client.sendMessage(userId, {
    message:
      `🎬 *MovieBot Commands*:
• /search <movie or series> – find files
• /ask <your question> – talk to Gemini AI
• /stats – view your usage statistics
• /clear – clear conversation history`
  });
};

const getUserStats = (userId) => {
  if (!userRateLimits.has(userId)) {
    return "You haven't made any AI requests yet.";
  }

  const userLimits = userRateLimits.get(userId);
  const now = Date.now();

  const requestsToday = userLimits.dailyCount;
  const requestsThisHour = userLimits.requestTimestamps.filter(
    ts => now - ts < RATE_LIMIT_CONFIG.HOUR_WINDOW
  ).length;
  const requestsThisMinute = userLimits.requestTimestamps.filter(
    ts => now - ts < RATE_LIMIT_CONFIG.MINUTE_WINDOW
  ).length;

  const conversationLength = conversationMemory.has(userId)
    ? conversationMemory.get(userId).history.length
    : 0;

  return `📊 *Your Usage Stats*
Today: ${requestsToday}/${RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_DAY}
This hour: ${requestsThisHour}/${RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_HOUR}
This minute: ${requestsThisMinute}/${RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_MINUTE}

💬 Conversation messages: ${conversationLength}/${MEMORY_CONFIG.MAX_HISTORY_LENGTH}
Global today: ${globalRateLimits.dailyCount}/${RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS_PER_DAY}`;
};

const askGeminiAI = async (userPrompt, userId) => {
  if (!FEATURE_FLAG_LLM || !GEMINI_API_KEY) return "AI is currently disabled.";

  const globalCheck = checkGlobalRateLimit();
  if (!globalCheck.allowed) {
    return `⚠️ ${globalCheck.reason}`;
  }

  const userCheck = checkUserRateLimit(userId);
  if (!userCheck.allowed) {
    return `⚠️ ${userCheck.reason}`;
  }

  recordRequest(userId);

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

    const history = getConversationHistory(userId);
    const formattedHistory = formatHistoryForAPI(history);

    const currentMessage = {
      role: "user",
      parts: [{ text: userPrompt }]
    };

    const contents = [...formattedHistory, currentMessage];

    const requestBody = {
      systemInstruction: {
        parts: [{ text: GEMINI_SYSTEM_PROMPT }]
      },
      contents: contents,
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

    const aiResponse = res.data.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";

    addToConversationHistory(userId, 'user', userPrompt);
    addToConversationHistory(userId, 'assistant', aiResponse);

    return aiResponse;
  } catch (e) {
    console.error("Gemini API error:", e.response?.data || e.message || e);

    if (userRateLimits.has(userId)) {
      const userLimits = userRateLimits.get(userId);
      userLimits.requestTimestamps.pop();
      userLimits.dailyCount--;
    }
    globalRateLimits.requestTimestamps.pop();
    globalRateLimits.dailyCount--;

    return "Error: AI could not reply. Please try again.";
  }
};

// ============= PAGINATION WITH INLINE BUTTONS =============

const createPaginationButtons = (currentPage, totalPages, userId) => {
  const buttons = [];

  // Create button row
  const row = [];

  if (currentPage > 0) {
    row.push(Api.KeyboardButtonCallback({
      text: "⬅️ Previous",
      data: Buffer.from(`prev_${userId}`)
    }));
  }

  // Page indicator (not clickable)
  row.push(Api.KeyboardButtonCallback({
    text: `📄 ${currentPage + 1}/${totalPages}`,
    data: Buffer.from(`page_${userId}`)
  }));

  if (currentPage < totalPages - 1) {
    row.push(Api.KeyboardButtonCallback({
      text: "Next ➡️",
      data: Buffer.from(`next_${userId}`)
    }));
  }

  buttons.push(row);

  return buttons;
};

const paginateResults = async (client, userId, results, pageSize = 10) => {
  const totalPages = Math.ceil(results.length / pageSize);
  let currentPage = 0;

  const sendPage = async () => {
    const start = currentPage * pageSize;
    const end = Math.min(start + pageSize, results.length);

    // Send results for current page
    for (let i = start; i < end; i++) {
      await client.sendMessage(userId, { message: results[i] });
    }

    // Send navigation message with inline buttons
    const navMessage = await client.sendMessage(userId, {
      message: `📦 Showing ${start + 1}-${end} of ${results.length} results`,
      buttons: createPaginationButtons(currentPage, totalPages, userId)
    });

    // Store pagination state
    paginationState.set(userId, {
      results: results,
      currentPage: currentPage,
      totalPages: totalPages,
      pageSize: pageSize,
      messageId: navMessage.id
    });
  };

  await sendPage();
};

// ============= BOT INITIALIZATION =============

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
    console.log(`Rate limits: ${RATE_LIMIT_CONFIG.GLOBAL_MAX_REQUESTS_PER_DAY} global/day, ${RATE_LIMIT_CONFIG.USER_MAX_REQUESTS_PER_DAY} per-user/day`);
    console.log(`Memory: ${MEMORY_CONFIG.MAX_HISTORY_LENGTH} messages, ${MEMORY_CONFIG.CONTEXT_WINDOW_MINUTES} min timeout`);

    // ============= CALLBACK QUERY HANDLER (for inline buttons) =============
    client.addEventHandler(async (event) => {
      try {
        const userId = event.query.userId;
        const data = event.query.data.toString();

        if (!paginationState.has(userId)) {
          await event.answer({ alert: true, message: "⚠️ Pagination expired. Please search again." });
          return;
        }

        const state = paginationState.get(userId);

        if (data.startsWith('next_')) {
          if (state.currentPage < state.totalPages - 1) {
            state.currentPage++;

            const start = state.currentPage * state.pageSize;
            const end = Math.min(start + state.pageSize, state.results.length);

            // Send new page results
            for (let i = start; i < end; i++) {
              await client.sendMessage(userId, { message: state.results[i] });
            }

            // Update navigation message
            await client.editMessage(userId, {
              message: state.messageId,
              text: `📦 Showing ${start + 1}-${end} of ${state.results.length} results`,
              buttons: createPaginationButtons(state.currentPage, state.totalPages, userId)
            });

            await event.answer({ alert: false });
          }
        } else if (data.startsWith('prev_')) {
          if (state.currentPage > 0) {
            state.currentPage--;

            const start = state.currentPage * state.pageSize;
            const end = Math.min(start + state.pageSize, state.results.length);

            // Send previous page results
            for (let i = start; i < end; i++) {
              await client.sendMessage(userId, { message: state.results[i] });
            }

            // Update navigation message
            await client.editMessage(userId, {
              message: state.messageId,
              text: `📦 Showing ${start + 1}-${end} of ${state.results.length} results`,
              buttons: createPaginationButtons(state.currentPage, state.totalPages, userId)
            });

            await event.answer({ alert: false });
          }
        } else if (data.startsWith('page_')) {
          // Page indicator clicked - just show info
          await event.answer({
            alert: true,
            message: `You're on page ${state.currentPage + 1} of ${state.totalPages}`
          });
        }
      } catch (error) {
        console.error("Callback query error:", error);
      }
    }, new Raw({ types: [Api.UpdateBotCallbackQuery] }));


    // ============= MESSAGE HANDLER =============
    const messageHandler = async (newMessage) => {
      const msgText = newMessage.message.message.trim();
      const userId = newMessage.message.fromId;

      if (!msgText.startsWith('/')) return;

      if (msgText === "/help" || msgText === "/start") {
        await sendHelpMenu(client, userId);
        return;
      }

      if (msgText === "/stats") {
        const stats = getUserStats(userId);
        await client.sendMessage(userId, { message: stats });
        return;
      }

      if (msgText === "/clear") {
        clearConversationHistory(userId);
        await client.sendMessage(userId, { message: "🗑️ Conversation history cleared!" });
        return;
      }

      if (FEATURE_FLAG_LLM && msgText.startsWith("/ask")) {
        const userPrompt = msgText.replace(/^\/ask\s*/i, "");
        if (userPrompt.length < 3) {
          await client.sendMessage(userId, { message: "Ask me something!" });
          return;
        }
        await client.sendMessage(userId, { message: "🤖 Thinking..." });
        const aiReply = await askGeminiAI(userPrompt, userId);
        await client.sendMessage(userId, { message: aiReply });
        return;
      }

      if (msgText.startsWith('/search')) {
        const myId = await client.getMe();

        if (newMessage.message?.peerId?.userId?.value === myId.id.value) {
          return;
        }

        if (newMessage.message.peerId.className === 'PeerChat' ||
          newMessage.originalUpdate.className === 'UpdateNewChannelMessage' ||
          newMessage.originalUpdate.className === 'MessageReplyHeader') {
          return;
        }

        await client.sendMessage(userId, {
          message: 'Searching for the file, please be patient for a few minutes...'
        });

        let messageToSend = [];
        const mediaIDs = new Set();

        const searchInTelegram = async (messageIGet, season) => {
          for await (const message of client.iterMessages(undefined, {
            search: messageIGet,
            limit: undefined,
            filter: new Api.InputMessagesFilterDocument()
          })) {
            if (!message.media || !message.media.document) continue;
            if (message.media.document.size.value < 52428800) continue;

            if (!mediaIDs.has(message.media.document.id.value)) {
              if (season === '') {
                mediaIDs.add(message.media.document.id.value);
                messageToSend.push(message);
              } else if (message.message && message.message.toLowerCase().includes(season)) {
                mediaIDs.add(message.media.document.id.value);
                messageToSend.push(message);
              }
            }
          }

          for await (const message of client.iterMessages(undefined, {
            search: messageIGet,
            limit: undefined,
            filter: new Api.InputMessagesFilterVideo(),
          })) {
            if (!message.media || !message.media.document) continue;
            if (message.media.document.size.value < 52428800) continue;

            if (!mediaIDs.has(message.media.document.id.value)) {
              if (season === '') {
                mediaIDs.add(message.media.document.id.value);
                messageToSend.push(message);
              } else if (message.message && message.message.toLowerCase().includes(season)) {
                mediaIDs.add(message.media.document.id.value);
                messageToSend.push(message);
              }
            }
          }
        };

        let season = msgText.slice(-3).toLowerCase();
        let messageIGet = msgText.replace('/search ', '').trim();

        if (season.includes('s0') || season.includes('s1')) {
          messageIGet = messageIGet.slice(0, -3).trim();
        } else {
          season = '';
        }

        await searchInTelegram(messageIGet, season);

        if (messageIGet.includes(' ')) {
          const messageWithDots = messageIGet.replace(/ /g, '.');
          await searchInTelegram(messageWithDots, season);
        }

        if (messageToSend.length === 0) {
          await client.sendMessage(userId, {
            message: '😕 No results found. Please wait for assistance.'
          });
          return;
        }

        await client.markAsRead(userId);
        console.log(`Found ${messageToSend.length} results`);

        if (messageToSend.length > 500) {
          await client.sendMessage(userId, {
            message: `Too many results (${messageToSend.length} found). Please be more specific!\n\nTry adding:\n• Year (e.g., 2023)\n• Season (e.g., s01)\n• Episode (e.g., e01)`
          });
          return;
        }

        await paginateResults(client, userId, messageToSend, 10);
        return;
      }

      await client.sendMessage(userId, { message: "❓ Unknown command. Try /help for available commands." });
    };

    client.addEventHandler(messageHandler, new NewMessage({}));
  };

  startBot();
} catch (err) {
  console.log("Bot error:", err);
}
