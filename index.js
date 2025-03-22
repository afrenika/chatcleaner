require('dotenv').config();
const VkBot = require('node-vk-bot-api');
const fs = require('fs');

// Загружаем список запрещенных слов и доверенных доменов
const forbiddenWords = JSON.parse(fs.readFileSync('forbiddenWords.json', 'utf-8'));
const trustedDomains = JSON.parse(fs.readFileSync('trusted_domains.json', 'utf-8')); // Список проверенных доменов

// Время запуска бота
const startTime = Math.floor(Date.now() / 1000);

// Создаем экземпляр бота
const bot = new VkBot(process.env.VK_TOKEN); // Замените на ваш токен

// Кэш сообщений
let messageCache = [];

// Функция нормализации текста (замена латинских букв на русские аналоги)
function normalizeText(text) {
    const charMap = {
        'a': 'а', 'b': 'в', 'c': 'с', 'e': 'е', 'o': 'о', 'p': 'р',
        'k': 'к', 'x': 'х', 'y': 'у', 'h': 'н', 'm': 'м'
    };
    return text.toLowerCase().replace(/[abceopkxyhmi]/g, char => charMap[char] || char);
}

// Функция проверки ссылок
function containsUntrustedLink(text) {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const links = text.match(urlRegex);

    if (links) {
        return links.some(link => {
            try {
                const domain = new URL(link).hostname.replace('www.', '');
                return !trustedDomains.includes(domain);
            } catch (e) {
                return true;
            }
        });
    }
    return false;
}

// Функция логирования нарушений
function logViolation(userId, message, type) {
    const logEntry = `[${new Date().toISOString()}] Пользователь ${userId} отправил ${type} сообщение: "${message}"\n`;
    fs.appendFile('violations.log', logEntry, (err) => {
        if (err) console.error('Ошибка при записи в лог:', err);
    });
}

// Функция удаления сообщений
async function deleteMessage(peerId, messageId) {
    try {
        await bot.execute('messages.delete', {
            conversation_message_ids: messageId,
            peer_id: peerId,
            delete_for_all: 1,
        });
        console.log(`Сообщение ${messageId} удалено.`);
    } catch (err) {
        console.error(`Ошибка при удалении сообщения ${messageId}:`, err);
    }
}

// Функция получения текста сообщения по conversation_message_id
async function getMessageText(peerId, messageId) {
    try {
        const response = await bot.execute('messages.getByConversationMessageId', {
            peer_id: peerId,
            conversation_message_ids: messageId,
        });

        if (response.items.length > 0) {
            return response.items[0].text;
        }
    } catch (err) {
        console.error(`Ошибка при получении текста сообщения ${messageId}:`, err);
    }
    return null;
}

// Проверка сообщений в кэше каждые 10 секунд
setInterval(async () => {
    console.log('Запуск проверки сообщений в чате...');

    for (let i = messageCache.length - 1; i >= 0; i--) {
        const msg = messageCache[i];

        const messageText = await getMessageText(msg.peer_id, msg.id);

        if (messageText) {
            const normalizedText = normalizeText(messageText);
            const hasForbiddenWord = forbiddenWords.some(word => normalizedText.includes(word));
            const hasUntrustedLink = containsUntrustedLink(messageText);

            if (hasForbiddenWord || hasUntrustedLink) {
                console.log(`Нарушение в сообщении ${msg.id}:`, messageText);
                await deleteMessage(msg.peer_id, msg.id);
                messageCache.splice(i, 1);
            }
        }
    }
}, 10000);

// Обработчик новых сообщений
bot.on(async (ctx) => {
    const messageTime = ctx.message.date; // Время отправки

    // Игнорируем старые сообщения
    if (messageTime < startTime) return;

    if (ctx.message.text && ctx.message.conversation_message_id) {
        const normalizedText = normalizeText(ctx.message.text);
        const hasForbiddenWord = forbiddenWords.some(word => normalizedText.includes(word));
        const hasUntrustedLink = containsUntrustedLink(ctx.message.text);

        if (hasForbiddenWord || hasUntrustedLink) {
            console.log('Нарушение в новом сообщении:', ctx.message.text);
            logViolation(ctx.message.from_id, ctx.message.text, hasUntrustedLink ? 'непроверенная ссылка' : 'запрещенное слово');

            await deleteMessage(ctx.message.peer_id, ctx.message.conversation_message_id);
            return;
        }

        // Добавляем сообщение в кэш
        messageCache.push({
            id: ctx.message.conversation_message_id,
            peer_id: ctx.message.peer_id,
        });

        // Если кэш превышает 10 сообщений, удаляем самое старое
        if (messageCache.length > 50) {
            const removedMessage = messageCache.shift();
            console.log(`Сообщение ${removedMessage.id} удалено из кэша.`);
        }
    }
});

// Запуск бота
bot.startPolling((err) => {
    if (err) {
        console.error('Ошибка при запуске бота:', err);
    } else {
        console.log('Бот запущен и слушает сообщения...');
    }
});
