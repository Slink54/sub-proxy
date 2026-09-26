const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID, 10);

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_NAMESPACE_ID = process.env.CF_NAMESPACE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

// Отправка сообщений в Telegram
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
}

// Запись в Cloudflare KV
async function putToKV(key, value) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${key}`;
  await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "text/plain"
    },
    body: typeof value === "string" ? value : JSON.stringify(value)
  });
}

// Чтение из Cloudflare KV
async function getFromKV(key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${key}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${CF_API_TOKEN}` }
  });
  if (!res.ok) return null;
  return await res.text();
}

// Удаление из Cloudflare KV
async function deleteFromKV(key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${key}`;
  await fetch(url, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${CF_API_TOKEN}` }
  });
}

// Функция парсинга формата DD.MM.YYYY с текущими часами, минутами и секундами
function parseExpiry(text, nowTimestamp) {
  const now = new Date(nowTimestamp * 1000);

  // 1. Формат DD.MM.YYYY или DD/MM/YYYY
  const dateMatch = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10) - 1; // в JS месяцы 0-11
    const year = parseInt(dateMatch[3], 10);

    // Собираем дату, подставляя текущие часы, минуты и секунды сообщения
    const targetDate = new Date(
      year,
      month,
      day,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds()
    );

    const targetTimestamp = Math.floor(targetDate.getTime() / 1000);

    // Проверка на валидность даты и чтобы срок не был в прошлом
    if (!isNaN(targetTimestamp) && targetTimestamp > nowTimestamp) {
      return targetTimestamp;
    }
  }

  // 2. Относительный формат (например: "3d", "7д", "30дней")
  const relMatch = text.match(/^(\d+)\s*(d|д|day|дней|дня)?$/i);
  if (relMatch) {
    const days = parseInt(relMatch[1], 10);
    return nowTimestamp + days * 86400;
  }

  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot endpoint is running.");
  }

  try {
    const update = req.body;
    const msg = update?.message;

    if (!msg || !msg.text) {
      return res.status(200).send("OK");
    }

    // Защита по Telegram ID
    if (msg.from.id !== ADMIN_ID) {
      await sendMessage(msg.chat.id, "⛔ Доступ запрещён.");
      return res.status(200).send("OK");
    }

    const text = msg.text.trim();
    // Время сообщения берём из метаданных Telegram (в секундах) или текущее системное
    const msgTimestamp = msg.date || Math.floor(Date.now() / 1000);

    // Команда /start или /cancel
    if (text === "/start" || text === "/cancel") {
      await deleteFromKV(`pending::${ADMIN_ID}`);
      await sendMessage(
        msg.chat.id,
        "👋 <b>VPN Bot готов к работе</b>\n\n" +
        "1. Отправь мне сообщение с ключами (<code>vless://...</code>).\n" +
        "2. Следующим шагом отправь дату окончания в формате <b>DD.MM.YYYY</b>.\n" +
        "<i>(Часы, минуты и секунды будут взяты текущие)</i>\n\n" +
        "Команда /cancel сбрасывает ожидание ввода даты."
      );
      return res.status(200).send("OK");
    }

    // Проверяем: ждёт ли бот дату для сохранённой пачки
    const pendingRaw = await getFromKV(`pending::${ADMIN_ID}`);

    if (pendingRaw) {
      const expireAt = parseExpiry(text, msgTimestamp);

      if (!expireAt) {
        await sendMessage(
          msg.chat.id,
          "⚠️ Неверный формат даты или дата уже в прошлом.\n\n" +
          "Пришли дату в формате <b>ДД.ММ.ГГГГ</b> (например: <code>15.10.2026</code>) " +
          "или количество дней (например: <code>10d</code>).\n\n" +
          "Для отмены нажми /cancel."
        );
        return res.status(200).send("OK");
      }

      const pendingData = JSON.parse(pendingRaw);
      const recordKey = `sub::${Date.now()}`;
      
      // Записываем пачку серверов в Cloudflare KV
      await putToKV(recordKey, {
        expireAt: expireAt,
        keys: pendingData.keys
      });

      // Очищаем буфер ожидания
      await deleteFromKV(`pending::${ADMIN_ID}`);

      // Форматируем красивую дату и время для ответа
      const expDateObj = new Date(expireAt * 1000);
      const timeStr = expDateObj.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const dateStr = expDateObj.toLocaleDateString("ru-RU");

      await sendMessage(
        msg.chat.id,
        `✅ <b>Успешно сохранено!</b>\n\n` +
        `• Добавлено ключей: <b>${pendingData.keys.length}</b>\n` +
        `• Срок действия: <b>${dateStr} ${timeStr}</b>\n\n` +
        `Серверы уже доступны для обновления в Happ.`
      );

      return res.status(200).send("OK");
    }

    // Если бот не ждал дату — парсим ключи из входящего текста
    const keyRegex = /(vless|vmess|hysteria2|ss|trojan):\/\/[^\s<>'"]+/gi;
    const foundKeys = text.match(keyRegex) || [];

    if (foundKeys.length === 0) {
      await sendMessage(msg.chat.id, "⚠️ Серверные ключи в сообщении не найдены.");
      return res.status(200).send("OK");
    }

    // Сохраняем ключи во временный буфер
    await putToKV(`pending::${ADMIN_ID}`, { keys: foundKeys });

    await sendMessage(
      msg.chat.id,
      `📥 <b>Найдено ключей: ${foundKeys.length}</b>\n\n` +
      `Пришли дату окончания в формате <b>ДД.ММ.ГГГГ</b> (например: <code>06.10.2026</code>):`
    );

    return res.status(200).send("OK");
  } catch (err) {
    return res.status(200).send("OK");
  }
}
