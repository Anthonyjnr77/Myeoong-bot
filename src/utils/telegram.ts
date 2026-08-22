import https from 'https';
import fetch from 'node-fetch';

const telegramAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 16,
  timeout: 8000,
});

export async function sendTelegramMessage(chatId: number | string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();

  if (!token) {
    console.warn('Telegram notifications disabled: TELEGRAM_BOT_TOKEN is missing');
    return false;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      agent: telegramAgent,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const responseBody = await response.text();

    if (!response.ok) {
      console.error(`Telegram request failed (${response.status}): ${responseBody}`);
      return false;
    }

    let result: { ok?: boolean };
    try {
      result = JSON.parse(responseBody);
    } catch {
      console.error(`Telegram returned invalid JSON: ${responseBody}`);
      return false;
    }

    if (result.ok !== true) {
      console.error(`Telegram rejected the message: ${responseBody}`);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Telegram network error: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

export async function sendTelegramAlert(message: string): Promise<boolean> {
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

  if (!chatId) {
    console.warn('Telegram notifications disabled: TELEGRAM_CHAT_ID is missing');
    return false;
  }

  return sendTelegramMessage(chatId, message);
}