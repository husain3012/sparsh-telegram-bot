require('dotenv').config();
const { TelegramClient, Api } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const input = require("input");
const axios = require("axios");

const apiId = process.env.API_ID * 1;
const apiHash = process.env.API_HASH;
const storeSession = new StoreSession('/session');
const FEATURE_FLAG_LLM = process.env.FEATURE_FLAG_LLM === 'true';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_PROMPT = "You are MovieBot, a witty, friendly Telegram bot who loves movies and series. Reply concisely, add fun references and use movie puns. Do NOT list features—just answer naturally.";

const sendHelpMenu = async (client, userId) => {
  await client.sendMessage(userId, {
    message:
`👋 Welcome to MovieBot!
Use:
/search <movie or series>
/askgemini <your question> (AI-powered, if enabled)
hello bot (for bot info)`
  });
};

const askGeminiAI = async (prompt) => {
  if (!FEATURE_FLAG_LLM || !GEMINI_API_KEY) return "AI is currently disabled.";
  try {
    const res = await axios.post(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent",
      {
        contents: [
          { parts: [{ text: GEMINI_PROMPT }, { text: prompt }] }
        ]
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        }
      }
    );
    return res.data.candidates?.[0]?.content?.parts?.[0]?.text || "No answer from Gemini AI.";
  } catch (e) {
    return "Error: AI could not reply.";
  }
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
    console.log('Bot started');

    const messageHandler = async (newMessage) => {
      const msgText = newMessage.message.message.trim();
      const userId = newMessage.message.fromId;

      // Improved Greetings/Help Interaction
      if (msgText.toLowerCase() === "hello bot" || msgText.toLowerCase() === "/help" || msgText.toLowerCase() === "/start") {
        await sendHelpMenu(client, userId);
        return;
      }

      // Gemini LLM Command -- Modular, Feature-Flagged
      if (
        FEATURE_FLAG_LLM &&
        (msgText.startsWith("/askgemini") || msgText.startsWith("/askai"))
      ) {
        const userPrompt = msgText.replace(/^\/ask(ai|gemini)\s*/i, "");
        if (userPrompt.length < 3) {
          await client.sendMessage(userId, { message: "Ask me about movies, actors, or TV shows! 😊" });
          return;
        }
        await client.sendMessage(userId, { message: "🤖 Thinking... getting an answer from Gemini AI." });
        const aiReply = await askGeminiAI(userPrompt);
        await client.sendMessage(userId, { message: aiReply });
        await sendHelpMenu(client, userId);
        return;
      }

      //////////////////////////////////////////////////////////////////////////
      ///////// YOUR ORIGINAL SEARCH/LOGIN LOGIC -- UNCHANGED //////////////////
      //////////////////////////////////////////////////////////////////////////

      if (msgText.includes('/search')) {
        const myId = await client.getMe();
        if (newMessage.message?.peerId?.userId.value === myId.id.value) return;
        if (
          newMessage.message.peerId.className === 'PeerChat' ||
          newMessage.originalUpdate.className === 'UpdateNewChannelMessage' ||
          newMessage.originalUpdate.className === 'MessageReplyHeader'
        ) return;

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
            if (message.media?.document?.size.value < 52428800) continue;
            if (message.media !== null) {
              if (!mediaIDs.has(message.media.document.id.value)) {
                if (season === '') {
                  mediaIDs.add(message.media.document.id.value);
                  messageToSend.push(message);
                } else if (message.message.toLowerCase().includes(season)) {
                  mediaIDs.add(message.media.document.id.value);
                  messageToSend.push(message);
                }
              }
            }
          }

          for await (const message of client.iterMessages(undefined, {
            search: messageIGet,
            limit: undefined,
            filter: new Api.InputMessagesFilterVideo(),
          })) {
            if (message.media?.document?.size.value < 52428800) continue;
            if (message.media !== null) {
              if (!mediaIDs.has(message.media.document.id.value)) {
                if (season === '') {
                  mediaIDs.add(message.media.document.id.value);
                  messageToSend.push(message);
                } else if (message.message.toLowerCase().includes(season)) {
                  mediaIDs.add(message.media.document.id.value);
                  messageToSend.push(message);
                }
              }
            }
          }
        };

        let season = msgText.slice(-3).toLowerCase();
        let messageIGet = msgText.replace('/search ', '');

        if (season.includes('s0') || season.includes('s1')) {
          messageIGet = messageIGet.slice(0, -3);
        } else {
          season = '';
        }

        await searchInTelegram(messageIGet, season);

        if (messageIGet.includes(' ')) {
          messageIGet = messageIGet.replace(' ', '.');
          await searchInTelegram(messageIGet, season);
        }

        if (messageToSend.length === 0) {
          await client.sendMessage(userId, {
            message: 'No results found, please wait for Sparsh to reply'
          });
          return;
        }

        await client.markAsRead(userId);
        console.log(messageToSend.length);

        if (messageToSend.length > 100) {
          await client.sendMessage(userId, {
            message: `Too many results. Please be more specific!\nTry a year (eg: 2022), season (eg: s01) or episode (eg: e01) — but don't use both together.`
          });
          return;
        }

        for (let i = 0; i < messageToSend.length; i++) {
          await client.sendMessage(userId, {
            message: messageToSend[i],
          });
        }

        await client.sendMessage(userId, {
          message: 'These are all the results found. Want to search other? Use /search.'
        });
        return;
      }

      //////////////////////////////////////////////////////////////////////////
      /////////////////////// END ORIGINAL LOGIC ///////////////////////////////
      //////////////////////////////////////////////////////////////////////////

      // Fallback for unknown inputs
      await client.sendMessage(userId, {
        message: "I didn't catch that. Try /search <movie> or /askgemini <question>!",
      });
      await sendHelpMenu(client, userId);
    }; // messageHandler

    client.addEventHandler(messageHandler, new NewMessage({}));
  }; // startBot

  startBot();
  console.log('Bot started');
} catch (err) {
  console.log(err);
}
