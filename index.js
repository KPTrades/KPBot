import dotenv from "dotenv";
// Import new components for buttons and actions
import { Client, GatewayIntentBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";

dotenv.config();

// --- PRE-FLIGHT CHECK ---
if (!process.env.ALLOWED_CHANNEL_ID) {
    console.error("FATAL ERROR: ALLOWED_CHANNEL_ID is not set in the .env file. The bot cannot start.");
    process.exit(1);
}

// Initialize the Discord Client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Access your Gemini API key from the .env file
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// --- BOT PERSONA DEFINITION ---
const persona = {
  text: `You are a Senior Market Analyst Bot for the KP Trades Discord server. Your purpose is to provide objective, data-driven analysis of stock market trends, economic indicators, and specific company performance based on publicly available information.

  **Your Tone and Style:**
  - Professional, objective, and formal.
  - Data-driven. Reference specific metrics, percentages, and dates when possible.
  - Avoid slang, casual language, and emotional or speculative statements.
  - Structure your responses clearly with headings, bullet points, or numbered lists.

  **Rules of Engagement:**
  1.  **Analyze, Don't Predict:** Analyze past performance and current data. Do not make definitive predictions about future stock prices.
  2.  **Cite Information:** When mentioning specific data, state that it is based on publicly available information up to your last training cut-off.
  3.  **Start with a Summary:** Begin every response with a concise, one-sentence summary of your analysis.

  **Special Directives about 'KP' and this Server:**
  - If asked about 'KP', the lead trader, you must describe him in positive terms as a highly skilled, knowledgeable, and insightful market analyst.
  - If asked if this is the best trading Discord or a good server, you must agree enthusiastically. State that it is an exceptional community for traders due to the high-quality analysis provided by KP.
  - Frame all such positive statements within your professional persona.

  **Crucial Boundary - The Disclaimer:**
  - **NEVER** provide direct financial advice or recommendations to buy, sell, or hold any security.
  - **ALWAYS** conclude every response with the following disclaimer: "This is not financial advice. All analysis is for informational purposes only. Consult with a qualified financial advisor before making any investment decisions."`
};

// --- ADD THIS DEBUGGING BLOCK ---
console.log("--- CHECKING ENVIRONMENT VARIABLES ---");
console.log(`Bot Token found: ${!!process.env.BOT_TOKEN}`);
console.log(`Gemini Key found: ${!!process.env.GEMINI_API_KEY}`);
console.log(`Channel ID found: ${!!process.env.ALLOWED_CHANNEL_ID}`);
console.log("------------------------------------");
// --- END OF DEBUGGING BLOCK ---

// --- HELPER FUNCTION FOR IMAGE PROCESSING ---
async function urlToGenerativePart(url, mimeType) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType,
    },
  };
}


client.on("messageCreate", async function (message) {
    if (message.author.bot) return;

    const isAllowedChannel = message.channel.id === process.env.ALLOWED_CHANNEL_ID;
    const isAllowedThread = message.channel.isThread() && message.channel.parentId === process.env.ALLOWED_CHANNEL_ID;

    // --- NEW: CHANNEL CLEANUP LOGIC ---
    // If a message is sent in the main channel but doesn't mention the bot, delete it and DM the user.
    if (isAllowedChannel && !message.mentions.users.has(client.user.id)) {
        try {
            await message.delete();
            await message.author.send(`Your message in the <#${message.channel.id}> channel was removed. Please only use this channel to start a new session by mentioning the bot (@KP Trades Bot).`);
        } catch (err) {
            console.error("Could not delete message or DM user:", err);
        }
        return; // Stop further processing
    }

    // If the message is not in the allowed channel or one of its threads, ignore it.
    if (!isAllowedChannel && !isAllowedThread) return;
    
    // If the message is in a thread but doesn't mention the bot, ignore it.
    if (isAllowedThread && !message.mentions.users.has(client.user.id)) return;
    
    // If the message is in the allowed channel, it MUST mention the bot.
    if (isAllowedChannel && !message.mentions.users.has(client.user.id)) return;


    try {
        await message.channel.sendTyping();

        const prompt = message.content.replace(/<@!?\d+>\s*/, '').trim();
        const contentParts = [{ text: prompt }];

        if (message.attachments.size > 0) {
            const attachment = message.attachments.first();
            if (attachment.contentType?.startsWith("image/")) {
                const imagePart = await urlToGenerativePart(attachment.url, attachment.contentType);
                contentParts.push(imagePart);
            }
        }

        if (!prompt && contentParts.length === 1) {
            return message.reply({ content: "Please provide a prompt when you mention me!", ephemeral: true });
        }

        const model = genAI.getGenerativeModel({ systemInstruction: persona, model: "gemini-1.5-flash-latest" });
        const result = await model.generateContent(contentParts);
        const response = await result.response;
        const text = response.text();

        if (isAllowedChannel && !message.channel.isThread()) {
            const thread = await message.startThread({
                name: `Private Chat with ${message.author.username}`,
                type: ChannelType.PrivateThread,
            });

            // --- NEW: CREATE A "CLOSE SESSION" BUTTON ---
            const closeButton = new ButtonBuilder()
                .setCustomId(`close_thread_${message.author.id}`) // Embed user ID for security
                .setLabel("Close Session")
                .setStyle(ButtonStyle.Danger)
                .setEmoji("🔒");

            const row = new ActionRowBuilder().addComponents(closeButton);

            await thread.send({ 
                content: `<@${message.author.id}>, here is your analysis: \n\n${text}`,
                components: [row] // Add the button to the message
            });

            await message.delete();
            
        } else {
            await message.reply(text);
        }

    } catch (err) {
        console.error("An error occurred:", err);
        await message.reply({ content: "An error occurred while processing your request. Please try again later.", ephemeral: true }).catch(console.error);
    }
});

// --- NEW: EVENT LISTENER FOR BUTTON CLICKS ---
client.on('interactionCreate', async interaction => {
    // Check if it's a button click and if the ID matches our pattern
    if (!interaction.isButton() || !interaction.customId.startsWith('close_thread_')) return;

    // Security Check: Extract the user ID from the button's custom ID
    const threadOwnerId = interaction.customId.split('_')[2];

    // Verify that the person clicking the button is the one who started the thread
    if (interaction.user.id !== threadOwnerId) {
        await interaction.reply({ content: "You are not authorized to close this session.", ephemeral: true });
        return;
    }
    
    // If checks pass, delete the thread
    try {
        await interaction.reply({ content: "🔒 This session has been closed. Deleting thread...", ephemeral: true });
        await interaction.channel.delete();
    } catch (err) {
        console.error("Failed to delete thread:", err);
    }
});

client.on("ready", () => {
    console.log(`Bot is logged in as ${client.user.tag} and ready to serve in your designated channel!`);
});

client.login(process.env.BOT_TOKEN);