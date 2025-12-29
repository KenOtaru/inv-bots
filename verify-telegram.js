require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

async function verifyTelegram() {
    const token = process.env.TELEGRAM_BOT_TOKEN2;
    const chatId = process.env.TELEGRAM_CHAT_ID2;

    console.log('--- Telegram Verification ---');
    console.log('Token:', token ? 'Found' : 'Missing');
    console.log('Chat ID:', chatId ? 'Found' : 'Missing');

    if (!token || !chatId) {
        console.error('❌ Missing environment variables.');
        process.exit(1);
    }

    try {
        const bot = new TelegramBot(token, { polling: false });
        console.log('🔄 Sending test message...');
        await bot.sendMessage(chatId, '🤖 *kNN Bot Telegram Verification*\nThis is a test message to confirm Telegram notifications are working correctly.', { parse_mode: 'Markdown' });
        console.log('✅ Test message sent successfully!');
    } catch (error) {
        console.error('❌ Failed to send Telegram message:', error.message);
        process.exit(1);
    }
}

verifyTelegram();
