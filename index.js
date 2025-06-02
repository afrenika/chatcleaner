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

function getChatIds() {
    try {
        return JSON.parse(process.env.CHAT_IDS || '[]');
    } catch (e) {
        console.error('Ошибка парсинга CHAT_IDS:', e);
        return [];
    }
}

// Функция обновления списка бесед в .env
function updateChatIds(newChatIds) {
    const envPath = '.env';
    let envContent = fs.readFileSync(envPath, 'utf-8');

    // Обновляем значение
    if (envContent.includes('CHAT_IDS=')) {
        envContent = envContent.replace(
            /CHAT_IDS=.*/,
            `CHAT_IDS="${JSON.stringify(newChatIds)}"`
        );
    } else {
        envContent += `\nCHAT_IDS="${JSON.stringify(newChatIds)}"`;
    }

    // Записываем обратно
    fs.writeFileSync(envPath, envContent);
    process.env.CHAT_IDS = JSON.stringify(newChatIds); // Обновляем в процессе
}

// Кэш сообщений
let messageCache = [];
let groups = getChatIds();
let chatsCache = new Map(); // Кэш бесед: {peerId, members[]}

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
function logInviteBot(group_id) {
    const logEntry = `Бот добавлен в чат: "${group_id}"\n`;
    fs.appendFile('violations.log', logEntry, (err) => {
        if (err) console.error('Ошибка при записи в лог:', err);
    });
}

function logInvite(userId, group_id) {
    const logEntry = `Пользователь ${userId} добавлен в чат: "${group_id}, не состоит в сообщевстве, и был удален"\n`;
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
        // 1. Проверяем, что пользователь действительно находится в беседе
        const members = await fetchChatMembers(peerId);

        if (!members.includes(userId)) {
            console.log(`[${peerId}] Пользователь ${userId} уже не в беседе, пропускаем исключение`);
            return;
        }

        // 2. Пытаемся исключить пользователя
        await bot.execute('messages.removeChatUser', {
            chat_id: peerId - 2000000000,
            member_id: userId
        });

        console.log(`[${peerId}] Пользователь ${userId} успешно исключен`);

        // 3. Обновляем кэш (если пользователь был в кэше)
        if (chatsCache.has(peerId)) {
            const updatedMembers = chatsCache.get(peerId).filter(id => id !== userId);
            chatsCache.set(peerId, updatedMembers);
        }
    } catch (err) {
        if (err.code === 15) { // Код 15 = пользователь не в беседе
            console.log(`[${peerId}] Пользователь ${userId} уже покинул беседу`);
        } else if (err.code === 925) { // Нет прав на исключение
            console.error(`[${peerId}] Нет прав для исключения ${userId}`);
        } else {
            console.error(`[${peerId}] Ошибка при исключении ${userId}:`, err);
        }
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



// Функция для получения списка бесед бота
async function fetchConversations() {
    try {
        const response = await bot.execute('messages.getConversations', {
            filter: 'all',
            count: 200,
            extended: 1
        });

        return response.items?.map(conv => conv.conversation.peer.id) || [];
    } catch (err) {
        console.error('Ошибка получения бесед:', err);
        return [];
    }
}

// Функция для получения участников беседы (без проверки)
async function fetchChatMembers(peerId) {
    try {
        const response = await bot.execute('messages.getConversationMembers', {
            peer_id: peerId,
        });
        return response.items?.map(member => member.member_id).filter(id => id > 0) || [];
    } catch (err) {
        console.error(`Ошибка получения участников беседы ${peerId}:`, err);
        const index = groups.indexOf(peerId);
        if (index !== -1) {
            groups.splice(index, 1);
            updateChatIds(groups);
            console.log(`Беседа ${peerId} удалена из списка`);
        }
        // Очищаем кэш
        chatsCache.delete(peerId);
        return [];
    }
}

// Инициализация кэша при запуске
async function initCache() {
    const conversations = groups;
    for (const peerId of conversations) {
        if (peerId > 2000000000) { // Только групповые беседы
            const members = await fetchChatMembers(peerId);
            chatsCache.set(peerId, members);
            console.log(`Загружена беседа ${peerId} с ${members.length} участниками`);
        }
    }
}

// Проверка участников беседы (отдельная функция)
async function verifyChatMembers(peerId) {
    if (!chatsCache.has(peerId)) return;

    // 1. Получаем текущий список участников из API
    const currentMembers = await fetchChatMembers(peerId);
    if (currentMembers.length === 0) return;

    // 2. Достаем кэшированный список
    const cachedMembers = chatsCache.get(peerId) || [];

    // 3. Находим новых участников (есть в current, но нет в cached)
    const newMembers = currentMembers.filter(member => !cachedMembers.includes(member));

    if (newMembers.length === 0) {
        // console.log(`[${peerId}] Нет новых участников для проверки`);
        return;
    }

    console.log(`[${peerId}] Новые участники для проверки:`, newMembers);

    // 4. Проверяем только новых участников
    for (const memberId of newMembers) {
        const isMember = await isGroupMember(memberId);
        if (!isMember) {
            console.log(`[${peerId}] Нарушитель найден: ${memberId}`);
            logInvite(memberId, peerId);
            await kickUser(peerId, memberId);
            verifyMessages(memberId);
        }
    }
    // 5. Обновляем кэш актуальным списком участников
    chatsCache.set(peerId, currentMembers);
    console.log(`[${peerId}] Кэш обновлен, теперь ${currentMembers.length} участников`);
}

// Периодическая проверка всех бесед
async function verifyAllChats() {
    for (const [peerId] of chatsCache) {
        await verifyChatMembers(peerId);
    }
}

async function verifyMessages(userId = null){
    for (let i = messageCache.length - 1; i >= 0; i--) {
        const msg = messageCache[i];

        const messageText = await getMessageText(msg.peer_id, msg.id);
        if(userId !== null){
            await deleteMessage(msg.peer_id, msg.id);
            logViolation(msg.id, messageText, 'непроверенная ссылка');
            messageCache.splice(i, 1);
            break;
        }
        // if (messageText) {
        //     // const normalizedText = normalizeText(messageText);
        //     // const hasForbiddenWord = forbiddenWords.some(word => normalizedText.includes(word));
        //     const hasUntrustedLink = containsUntrustedLink(messageText);
        //
        //     if (hasUntrustedLink) {
        //         console.log(`Нарушение в сообщении ${msg.id}:`, messageText);
        //         logViolation(msg.peer_id, messageText, hasUntrustedLink ? 'непроверенная ссылка' : 'запрещенное слово');
        //         await deleteMessage(msg.peer_id, msg.id);
        //         await kickUser(msg.peer_id, msg.from_id);
        //         messageCache.splice(i, 1);
        //     }
        // }
    }
}




// Проверка сообщений в кэше каждые 10 секунд
setInterval(async () => {
    verifyMessages();
}, 10000);

// Обработчик новых сообщений
bot.on(async (ctx) => {
    const messageTime = ctx.message.date; // Время отправки

    // Игнорируем старые сообщения
    if (messageTime < startTime) return;

     // ID пользователя, которого добавили
    const peerId = ctx.message.peer_id; // ID беседы

    // Проверяем, что это событие добавления в беседу
    if (ctx.message.action && ctx.message.action.type === 'chat_invite_user') {
        const userId = ctx.message.action.member_id;
        // Проверяем, что добавили именно бота
        if (userId === -ctx.groupId) {
            await bot.execute('messages.send', {
                chat_id: peerId - 2000000000, // Преобразуем peer_id в chat_id
                message: 'Привет, друзья!\nСпасибо, что добавили меня в беседу! 😊\nЯ буду следить за порядком и удалять тех, кто не состоит в нашем сообществе, а также удалять спам, если выдадите мне права администратора!',
                random_id: Math.floor(Math.random() * 1e9), // Уникальный ID для сообщения
            });
            logInviteBot(peerId);
            return;
        }
        else if (userId > 0) { // Если добавили обычного пользователя
            const isMember = await isGroupMember(userId);
            if (!isMember) {
                console.log(`Пользователь ${userId} не состоит в группе ${TARGET_GROUP_ID}`);
                await kickUser(peerId, userId);
            }
            else{
                if (chatsCache.has(peerId)) {
                    const members = chatsCache.get(peerId);
                    if (!members.includes(userId)) {
                        members.push(userId);
                        chatsCache.set(peerId, members);
                    }
                }
            }
        }
    }

    if (!groups.includes(ctx.message.peer_id)) {

        // Если это касается нашего бота

        console.log(`[${peerId}] Бота назначили администратором!`);
        groups.push(peerId);
        updateChatIds(groups);
        const members = await fetchChatMembers(peerId);
        chatsCache.set(peerId, members);
        console.log(`Бот добавлен в беседу администратором ${peerId}, участников: ${members.length}`);

    }
    if (ctx.message.action?.type === 'chat_kick_user') {
        const { member_id: userId, peer_id: peerId } = ctx.message;
        if (chatsCache.has(peerId)) {
            const updatedMembers = chatsCache.get(peerId).filter(id => id !== userId);
            chatsCache.set(peerId, updatedMembers);
        }
    }

    // Остальная логика обработки сообщений
    if (ctx.message.text && ctx.message.conversation_message_id) {
        logMessage(ctx);
        // const normalizedText = normalizeText(ctx.message.text);
        // const hasForbiddenWord = forbiddenWords.some(word => normalizedText.includes(word));
        // const hasUntrustedLink = containsUntrustedLink(ctx.message.text);
        //
        // if (hasUntrustedLink) {
        //     console.log('Нарушение в новом сообщении:', ctx.message.text);
        //     logViolation(ctx.message.from_id, ctx.message.text, hasUntrustedLink ? 'непроверенная ссылка' : 'запрещенное слово');
        //
        //     await deleteMessage(peerId, ctx.message.conversation_message_id);
        //     await kickUser(peerId, ctx.message.from_id);
        //     return;
        // }

        // Добавляем сообщение в кэш
        messageCache.push({
            id: ctx.message.conversation_message_id,
            peer_id: peerId,
            from_id: ctx.message.from_id
        });

        // Если кэш превышает 10 сообщений, удаляем самое старое
        if (messageCache.length > 20) {
            const removedMessage = messageCache.shift();
            console.log(`Сообщение ${removedMessage.id} удалено из кэша.`);
        }
    }
});

// Запуск бота
bot.startPolling(async (err) => {
    if (err) {
        console.error('Ошибка запуска бота:', err);
    } else {
        console.log('Бот запущен. Инициализация кэша...');
        await initCache();
        console.log(`Кэш инициализирован, загружено ${chatsCache.size} бесед`);

        // Запуск периодических проверок
        setInterval(verifyAllChats, 10000); // Каждые 5 минут
    }
});