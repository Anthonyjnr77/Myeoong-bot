import { BotEvent, BotEventHandler } from '../types';

export class TelegramHandler implements BotEventHandler {
  private readonly token: string;
  private readonly chatId: string;

  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN?.trim() || '';
    this.chatId = process.env.TELEGRAM_CHAT_ID?.trim() || '';
  }

  handle(event: BotEvent): void {
    if (!this.token || !this.chatId) {
      return;
    }

    void this.send(this.format(event)).catch(() => {
      // Notification failures must not affect trade processing.
    });
  }

  private format(event: BotEvent): string | null {
    switch (event.type) {
      case 'detected':
        return [
          `🔎 ${event.protocol === 'pumpfun' ? 'pump.fun' : 'PumpSwap'} trade detected`,
          `Type: ${event.parsed.type}`,
          `Mint: ${event.parsed.mint}`,
          `Source: ${event.parsed.user}`,
          `Signature: ${event.parsed.signature}`
        ].join('\n');
      case 'executionSuccess':
        const successMessage = [
          `✅ ${event.parsed.type} ${event.parsed.protocol === 'PUMP_FUN' ? 'pump.fun' : 'PumpSwap'}`,
          `Mode: ${process.env.MODE === 'simulate' ? 'SIMULATE' : 'LIVE'}`,
          `Mint: ${event.parsed.mint}`,
          `Copy signature: ${event.signature}`
        ];
        if (process.env.MODE !== 'simulate') {
          successMessage.push(`Explorer: https://explorer.solana.com/tx/${event.signature}?cluster=devnet`);
        }
        return successMessage.join('\n');
      case 'buildFailed':
      case 'executionFailed':
        return [
          `❌ Trade ${event.type === 'buildFailed' ? 'build' : 'execution'} failed`,
          `Mint: ${event.parsed.mint || 'unknown'}`,
          `Error: ${event.error}`
        ].join('\n');
      default:
        return null;
    }
  }

  private async send(text: string | null): Promise<void> {
    if (!text) {
      return;
    }

    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      throw new Error(`Telegram request failed with status ${response.status}`);
    }
  }
}