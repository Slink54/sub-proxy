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
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const stringBody = typeof value === "string" ? value : JSON.stringify(value);

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "text/plain; charset=utf-8"
    },
    body: stringBody
  });

  if (!res.ok) {
    const errorDetails = await res.text();
    return { ok: false, error: `${res.status}: ${errorDetails}` };
  }
  return { ok: true };
}

// Чтение из Cloudflare KV
async function getFromKV(key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    headers: { "Authorization": `Bearer ${CF_API_TOKEN}` }
  });
  if (!res.ok) return null;
  return await res.text();
}

// Удаление из Cloudflare KV
async function deleteFromKV(key) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_NAMESPACE_ID}/values/${encodeURIComponent(key)}`;
  await fetch(url, {
    method: "DELETE",
    headers: { "Authorization": `Bearer ${CF_API_TOKEN}` }
  });
}

// Парсинг срока действия
function parseExpiry(text, nowTimestamp) {
  const now = new Date(nowTimestamp * 1000);
  const cleanText = text.trim().toLowerCase();

  // Дата: ДД.ММ.ГГГГ или ДД/ММ/ГГГГ
  const dateMatch = cleanText.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10) - 1;
    const year = parseInt(dateMatch[3], 10);

    const targetDate = new Date(
      year,
      month,
      day,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds()
    );

    const targetTimestamp = Math.floor(targetDate.getTime() / 1000);
    if (!isNaN(targetTimestamp) && targetTimestamp > nowTimestamp) {
      return targetTimestamp;
    }
  }

  // Минуты: 10m, 10мин, 10м
  const minMatch = cleanText.match(/^(\d+)\s*(m|мин|м|min|minute|minutes)$/i);
  if (minMatch) {
    const minutes = parseInt(minMatch[1], 10);
    if (minutes > 0) return nowTimestamp + minutes * 60;
  }

  // Дни: 3d, 7д, 30дней или просто число
  const dayMatch = cleanText.match(/^(\d+)\s*(d|д|day|days|дней|дня|день)?$/i);
  if (dayMatch) {
    const days = parseInt(dayMatch[1], 10);
    if (days > 0) return nowTimestamp + days * 86400;
  }

  return null;
}

// Извлечение VLESS-ключей из входящего JSON (V2Ray / Xray / sing-box)
function extractKeysFromJson(jsonObj) {
  const keys = [];
  const outbounds = jsonObj?.outbounds || (Array.isArray(jsonObj) ? jsonObj : []);
  const defaultRemark = jsonObj?.remarks || "Сервер";

  for (let i = 0; i < outbounds.length; i++) {
    const ob = outbounds[i];
    if (!ob) continue;

    // 1. Формат Xray / V2Ray outbounds
    if (ob.protocol === "vless" && ob.settings?.vnext?.[0]) {
      const serverInfo = ob.settings.vnext[0];
      const user = serverInfo.users?.[0];
      const stream = ob.streamSettings || {};
      const uuid = user?.id;
      const host = serverInfo.address;
      const port = serverInfo.port;
      const tag = encodeURIComponent(ob.tag || `${defaultRemark} ${i + 1}`);

      if (!uuid || !host || !port) continue;

      const params = new URLSearchParams();
      params.set("encryption", user.encryption || "none");
      if (user.flow) params.set("flow", user.flow);

      const netType = stream.network || "tcp";
      params.set("type", netType);

      if (stream.security === "reality") {
        params.set("security", "reality");
        const r = stream.realitySettings || {};
        if (r.publicKey) params.set("pbk", r.publicKey);
        if (r.fingerprint) params.set("fp", r.fingerprint);
        if (r.serverName) params.set("sni", r.serverName);
        if (r.shortId) params.set("sid", r.shortId);
        if (r.spiderX) params.set("spx", r.spiderX);
      } else if (stream.security === "tls") {
        params.set("security", "tls");
        const t = stream.tlsSettings || {};
        if (t.serverName) params.set("sni", t.serverName);
        if (t.fingerprint) params.set("fp", t.fingerprint);
        if (t.alpn?.length) params.set("alpn", t.alpn.join(","));
      }

      if (netType === "xhttp" && stream.xhttpSettings) {
        const x = stream.xhttpSettings;
        if (x.path) params.set("path", x.path);
        if (x.host) params.set("host", x.host);
        if (x.mode) params.set("mode", x.mode);
      } else if (netType === "grpc" && stream.grpcSettings) {
        const g = stream.grpcSettings;
        if (g.serviceName) params.set("serviceName", g.serviceName);
      } else if (netType === "ws" && stream.wsSettings) {
        const w = stream.wsSettings;
        if (w.path) params.set("path", w.path);
        if (w.headers?.Host) params.set("host", w.headers.Host);
      }

      keys.push(`vless://${uuid}@${host}:${port}?${params.toString()}#${tag}`);
    }

    // 2. Формат sing-box outbounds
    if (ob.type === "vless" && ob.server && ob.server_port && ob.uuid) {
      const tag = encodeURIComponent(ob.tag || `${defaultRemark} ${i + 1}`);
      const params = new URLSearchParams();
      params.set("type", ob.transport?.type || "tcp");
      if (ob.flow) params.set("flow", ob.flow);

      if (ob.tls?.enabled) {
        if (ob.tls.reality?.enabled) {
          params.set("security", "reality");
          if (ob.tls.reality.public_key) params.set("pbk", ob.tls.reality.public_key);
          if (ob.tls.reality.short_id) params.set("sid", ob.tls.reality.short_id);
        } else {
          params.set("security", "tls");
        }
        if (ob.tls.server_name) params.set("sni", ob.tls.server_name);
        if (ob.tls.utls?.fingerprint) params.set("fp", ob.tls.utls.fingerprint);
        if (ob.tls.alpn?.length) params.set("alpn", ob.tls.alpn.join(","));
      }

      keys.push(`vless://${ob.uuid}@${ob.server}:${ob.server_port}?${params.toString()}#${tag}`);
    }
  }

  return keys;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot endpoint is running.");
  }

  try {
    const update = req.body;
    const msg = update?.message;

    if (!msg) {
      return res.status(200).send("OK");
    }

    // Проверка прав доступа (ADMIN_ID)
    if (msg.from.id !== ADMIN_ID) {
      await sendMessage(msg.chat.id, "⛔ Доступ запрещён.");
      return res.status(200).send("OK");
    }

    const msgTimestamp = msg.date || Math.floor(Date.now() / 1000);
    let text = (msg.text || msg.caption || "").trim();

    // Команды /start и /cancel
    if (text === "/start" || text === "/cancel") {
      await deleteFromKV(`pending::${ADMIN_ID}`);
      await sendMessage(
        msg.chat.id,
        "👋 <b>VPN Bot готов к работе!</b>\n\n" +
        "1. Отправьте ключи (<code>vless://...</code>), ссылку на подписку или прикрепите <b>.json</b> файл.\n" +
        "2. Следующим шагом укажите срок действия (<b>ДД.ММ.ГГГГ</b>, <code>3d</code> или <code>10m</code>).\n\n" +
        "Для отмены используйте команду /cancel."
      );
      return res.status(200).send("OK");
    }

    // Шаг 2: Проверяем, ожидает ли бот ввода даты
    const pendingRaw = await getFromKV(`pending::${ADMIN_ID}`);

    if (pendingRaw && text && !msg.document) {
      const expireAt = parseExpiry(text, msgTimestamp);

      if (!expireAt) {
        await sendMessage(
          msg.chat.id,
          "⚠️ Неверный формат даты или указанное время уже истекло!\n\n" +
          "Примеры:\n" +
          "• <b>25.10.2026</b>\n" +
          "• <code>3d</code> (на 3 дня)\n" +
          "• <code>10m</code> (на 10 минут)\n\n" +
          "Для отмены отправьте /cancel."
        );
        return res.status(200).send("OK");
      }

      let pendingData = { keys: [] };
      try {
        pendingData = JSON.parse(pendingRaw);
      } catch (e) {}

      const recordKey = `sub::${Date.now()}`;

      const saveResult = await putToKV(recordKey, {
        expireAt: expireAt,
        keys: pendingData.keys
      });

      if (!saveResult.ok) {
        await sendMessage(
          msg.chat.id,
          `❌ <b>Ошибка сохранения в Cloudflare KV:</b>\n<code>${saveResult.error}</code>`
        );
        return res.status(200).send("OK");
      }

      await deleteFromKV(`pending::${ADMIN_ID}`);

      const expDateObj = new Date(expireAt * 1000);
      const timeStr = expDateObj.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const dateStr = expDateObj.toLocaleDateString("ru-RU");

      await sendMessage(
        msg.chat.id,
        `✅ <b>Успешно сохранено!</b>\n\n` +
        `• Добавлено ключей: <b>${pendingData.keys.length}</b>\n` +
        `• Действуют до: <b>${dateStr} ${timeStr}</b>\n\n` +
        `Серверы готовы для обновления в приложении Happ.`
      );

      return res.status(200).send("OK");
    }

    // Шаг 1: Извлечение ключей из текста, JSON или прикрепленного файла
    let foundKeys = [];

    // А. Если прикреплен файл (.json)
    if (msg.document) {
      const fileId = msg.document.file_id;
      const getFileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
      const fileData = await getFileRes.json();

      if (fileData.ok && fileData.result?.file_path) {
        const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileData.result.file_path}`;
        const fileContentRes = await fetch(downloadUrl);
        const fileContentText = await fileContentRes.text();

        try {
          const parsedDocJson = JSON.parse(fileContentText);
          foundKeys.push(...extractKeysFromJson(parsedDocJson));
        } catch (e) {
          const regex = /(vless|vmess|hysteria2|ss|trojan):\/\/[^\s<>'"]+/gi;
          foundKeys.push(...(fileContentText.match(regex) || []));
        }
      }
    }

    // Б. Если отправлен текст в формате JSON
    if (foundKeys.length === 0 && text.startsWith("{")) {
      try {
        const parsedRawJson = JSON.parse(text);
        foundKeys.push(...extractKeysFromJson(parsedRawJson));
      } catch (e) {}
    }

    // В. Если отправлена ссылка на подписку (https://...)
    if (foundKeys.length === 0 && /^https?:\/\//i.test(text)) {
      try {
        const subRes = await fetch(text, { headers: { "User-Agent": "Happ/sing-box" } });
        if (subRes.ok) {
          const rawText = (await subRes.text()).trim();
          let decoded = rawText;
          try { decoded = atob(rawText); } catch (e) {}

          try {
            const parsedSubJson = JSON.parse(decoded);
            foundKeys.push(...extractKeysFromJson(parsedSubJson));
          } catch (e) {
            const regex = /(vless|vmess|hysteria2|ss|trojan):\/\/[^\s<>'"]+/gi;
            foundKeys.push(...(decoded.match(regex) || []));
          }
        }
      } catch (e) {}
    }

    // Г. Поиск стандартных протоколов в тексте
    if (foundKeys.length === 0 && text) {
      const regex = /(vless|vmess|hysteria2|ss|trojan):\/\/[^\s<>'"]+/gi;
      foundKeys.push(...(text.match(regex) || []));
    }

    // Удаление дубликатов
    foundKeys = [...new Set(foundKeys)];

    if (foundKeys.length === 0) {
      await sendMessage(msg.chat.id, "⚠️ Серверные ключи или JSON-ноды не обнаружены.");
      return res.status(200).send("OK");
    }

    // Сохранение во временный буфер KV
    const saveResult = await putToKV(`pending::${ADMIN_ID}`, { keys: foundKeys });

    if (!saveResult.ok) {
      await sendMessage(
        msg.chat.id,
        `❌ <b>Ошибка записи в Cloudflare KV:</b>\n<code>${saveResult.error}</code>`
      );
      return res.status(200).send("OK");
    }

    await sendMessage(
      msg.chat.id,
      `📥 <b>Найдено ключей: ${foundKeys.length}</b>\n\n` +
      `До какого числа они действуют? Пришлите дату в формате <b>ДД.ММ.ГГГГ</b> (например: <code>25.10.2026</code>) или срок (например: <code>10d</code>):`
    );

    return res.status(200).send("OK");

  } catch (err) {
    return res.status(200).send("OK");
  }
}
