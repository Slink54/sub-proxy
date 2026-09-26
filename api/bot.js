const BOT_TOKEN = "8927342440:AAHsBWL16dC6xmm_6B9s_WxXmFM_YsG4cg0";
const ADMIN_ID = 833454967;

// Подставь свои значения из Cloudflare:
const CF_ACCOUNT_ID = "ТВОЙ_ACCOUNT_ID";
const CF_NAMESPACE_ID = "ТВОЙ_NAMESPACE_ID"; // server_storage ID
const CF_API_TOKEN = "ТВОЙ_CF_API_TOKEN";

// Функция отправки сообщений в Telegram
async function sendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });
}

// Запись в Cloudflare KV через REST API
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

// Парсинг срока
function parseExpiry(text, now) {
  const relMatch = text.match(/(\d+)\s*(d|д|day|дней|дня)/i);
  if (relMatch) {
    return now + parseInt(relMatch[1], 10) * 86400;
  }
  const dateMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (dateMatch) {
    const timestamp = Math.floor(new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T23:59:59Z`).getTime() / 1000);
    if (!isNaN(timestamp)) return timestamp;
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

    // Доступ только для тебя
    if (msg.from.id !== ADMIN_ID) {
      await sendMessage(msg.chat.id, "⛔ Доступ запрещён.");
      return res.status(200).send("OK");
    }

    const text = msg.text.trim();
    const now = Math.floor(Date.now() / 1000);

    // Команда /start или /cancel
    if (text === "/start" || text === "/cancel") {
      await deleteFromKV(`pending::${ADMIN_ID}`);
      await sendMessage(
        msg.chat.id,
        "👋 <b>VPN Bot готов к работе</b>\n\n" +
        "1. Просто отправь мне сообщение с ключами (`vless://...`).\n" +
        "2. Следующим шагом я спрошу дату окончания.\n\n" +
        "Команда /cancel сбрасывает ожидание ввода даты."
      );
      return res.status(200).send("OK");
    }

    // Проверяем: ждёт ли бот дату для ранее присланных ключей
    const pendingRaw = await getFromKV(`pending::${ADMIN_ID}`);

    if (pendingRaw) {
      const expireAt = parseExpiry(text, now);

      if (!expireAt) {
        await sendMessage(
          msg.chat.id,
          "⚠️ Не удалось распознать формат срока.\n\n" +
          "Напиши например:\n" +
          "• <code>3d</code> (на 3 дня)\n" +
          "• <code>30d</code> (на месяц)\n" +
          "• <code>2026-12-31</code> (до конкретного дня)\n\n" +
          "Или отправь /cancel для отмены."
        );
        return res.status(200).send("OK");
      }

      const pendingData = JSON.parse(pendingRaw);
      const recordKey = `sub::${Date.now()}`;
      
      // Записываем финальную пачку ключей в базу KV
      await putToKV(recordKey, {
        expireAt: expireAt,
        keys: pendingData.keys
      });

      // Сбрасываем временное состояние ожидания
      await deleteFromKV(`pending::${ADMIN_ID}`);

      const expireStr = new Date(expireAt * 1000).toISOString().split("T")[0];
      await sendMessage(
        msg.chat.id,
        `✅ <b>Успешно сохранено!</b>\n` +
        `• Ключей добавлено: <b>${pendingData.keys.length}</b>\n` +
        `• Действуют до: <b>${expireStr}</b>\n\n` +
        `Серверы готовы к загрузке в Happ.`
      );

      return res.status(200).send("OK");
    }

    // Если бот не ждал дату — ищем новые ключи в тексте
    const keyRegex = /(vless|vmess|hysteria2|ss|trojan):\/\/[^\s<>'"]+/gi;
    const foundKeys = text.match(keyRegex) || [];

    if (foundKeys.length === 0) {
      await sendMessage(msg.chat.id, "⚠️ Серверные ключи в сообщении не обнаружены.");
      return res.status(200).send("OK");
    }

    // Сохраняем ключи во временный буфер базы KV
    await putToKV(`pending::${ADMIN_ID}`, { keys: foundKeys });

    await sendMessage(
      msg.chat.id,
      `📥 <b>Найдено ключей: ${foundKeys.length}</b>\n\n` +
      `До какого числа они действуют?\n` +
      `Напиши срок, например: <code>7d</code>, <code>30d</code> или <code>2026-11-01</code>:`
    );

    return res.status(200).send("OK");
  } catch (err) {
    return res.status(200).send("OK");
  }
}
