require('dotenv').config();
const VkBot = require('node-vk-bot-api');
const fs = require('fs');

// Загружаем список запрещенных слов и доверенных доменов
const forbiddenWords = JSON.parse(fs.readFileSync('forbiddenWords.json', 'utf-8'));
const trustedDomains = JSON.parse(fs.readFileSync('trusted_domains.json', 'utf-8')); // Список проверенных доменов

// ID сообщества, участников которого мы проверяем
const TARGET_GROUP_ID = 'kubik232';
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

// Функция логирования приглашений в чат
function logInvite(group_id) {
    const logEntry = `Бот добавлен в чат: "${group_id}"\n`;
    fs.appendFile('violations.log', logEntry, (err) => {
        if (err) console.error('Ошибка при записи в лог:', err);
    });
}

function logMessage(ctx) {
    try {
        const timestamp = new Date().toISOString();
        const userId = ctx.message.from_id;
        const peerId = ctx.message.peer_id;
        const messageText = ctx.message.text || '(нет текста)';

        // Проверяем наличие вложений
        let hasAttachments = false;
        let attachmentTypes = [];

        if (ctx.message.attachments && ctx.message.attachments.length > 0) {
            hasAttachments = true;
            attachmentTypes = ctx.message.attachments.map(att => att.type);
        }

        const logEntry = `[${timestamp}] Сообщение от ${userId} в беседу ${peerId};Текст: "${messageText}; Вложения: ${hasAttachments ? 'Да' : 'Нет'};${hasAttachments ? ` (Типы: ${attachmentTypes.join(', ')})` : ''}\n`

        fs.appendFile('messages.log', logEntry, (err) => {
            if (err) console.error('Ошибка при записи в лог сообщений:', err);
        });

    } catch (err) {
        console.error('Ошибка при логировании сообщения:', err);
    }
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

async function kickUser(peerId, userId) {
    try {
        await bot.execute('messages.removeChatUser', {
            chat_id: peerId - 2000000000,
            member_id: userId
        });
        console.log(`Пользователь ${userId} исключен из беседы ${peerId}.`);
    } catch (err) {
        console.error(`Ошибка при исключении пользователя ${userId}:`, err);
    }
}

// Функция проверки, состоит ли пользователь в целевом сообществе
async function isGroupMember(userId) {

    try {
        const response = await bot.execute('groups.isMember', {
            group_id: TARGET_GROUP_ID,
            user_id: userId,
        });

        return response;
    } catch (err) {
        console.error(`Ошибка при проверке участника группы ${userId}:`, err);
        return true; // В случае ошибки считаем, что пользователь состоит в группе
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
                await kickUser(msg.peer_id, msg.from_id);
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

    // Проверяем, что это событие добавления в беседу
    if (ctx.message.action && ctx.message.action.type === 'chat_invite_user') {
        const userId = ctx.message.action.member_id; // ID пользователя, которого добавили
        const chatId = ctx.message.peer_id; // ID беседы

        // Проверяем, что добавили именно бота
        if (userId === -ctx.groupId) {
            await bot.execute('messages.send', {
                chat_id: chatId - 2000000000, // Преобразуем peer_id в chat_id
                message: 'Привет, друзья!\nСпасибо, что добавили меня в беседу! 😊\nЯ буду следить за порядком и удалять тех, кто не состоит в нашем сообществе, а также удалять спам, если выдадите мне права администратора!',
                random_id: Math.floor(Math.random() * 1e9), // Уникальный ID для сообщения
            });
            logInvite(chatId);
        } else if (userId > 0) { // Если добавили обычного пользователя
            const isMember = await isGroupMember(userId);
            if (!isMember) {
                console.log(`Пользователь ${userId} не состоит в группе ${TARGET_GROUP_ID}`);
                await kickUser(chatId, userId);

                // Отправляем сообщение о причине исключения
                await bot.execute('messages.send', {
                    chat_id: chatId - 2000000000,
                    message: `@id${userId} (Пользователь) был исключен, так как не состоит в сообществе.`,
                    random_id: Math.floor(Math.random() * 1e9),
                });
            }
        }
    }
    logMessage(ctx);
    // Остальная логика обработки сообщений
    if (ctx.message.text && ctx.message.conversation_message_id) {
        const normalizedText = normalizeText(ctx.message.text);
        const hasForbiddenWord = forbiddenWords.some(word => normalizedText.includes(word));
        const hasUntrustedLink = containsUntrustedLink(ctx.message.text);

        if (hasForbiddenWord || hasUntrustedLink) {
            console.log('Нарушение в новом сообщении:', ctx.message.text);
            logViolation(ctx.message.from_id, ctx.message.text, hasUntrustedLink ? 'непроверенная ссылка' : 'запрещенное слово');

            await deleteMessage(ctx.message.peer_id, ctx.message.conversation_message_id);
            await kickUser(ctx.message.peer_id, ctx.message.from_id);
            return;
        }

        // Добавляем сообщение в кэш
        messageCache.push({
            id: ctx.message.conversation_message_id,
            peer_id: ctx.message.peer_id,
            from_id: ctx.message.from_id
        });

        // Если кэш превышает 50 сообщений, удаляем самое старое
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