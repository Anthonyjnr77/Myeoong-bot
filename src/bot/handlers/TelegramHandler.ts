import { BotEvent, BotEventHandler } from '../types';
import { sendTelegramAlert } from '../../utils/telegram';

export class TelegramHandler implements BotEventHandler {
  handle(event: BotEvent): void {
    const message = this.format(event);
    if (message) {
      void sendTelegramAlert(message);
    }
  }

  private format(event: BotEvent): string | null {
    switch (event.type) {
      case 'detected':
        if (event.parsed.type !== 'BUY') return null;
        return [
          `<b>BOT ACTIVE — TRACKED WALLET BUY DETECTED</b>`,
          `<b>${event.protocol === 'pumpfun' ? 'PUMP.FUN' : 'PUMPSWAP'} BUY</b>`,
          `Mint: <code>${this.escapeHtml(event.parsed.mint)}</code>`,
          `Source: <code>${this.escapeHtml(event.parsed.user)}</code>`,
          `Signature: <code>${this.escapeHtml(event.parsed.signature)}</code>`
        ].join('\n');
      case 'executionSuccess': {
        const successMessage = [
          `<b>${event.parsed.type} ${event.parsed.protocol === 'PUMP_FUN' ? 'PUMP.FUN' : 'PUMPSWAP'}</b>`,
          `Mode: <code>${process.env.MODE === 'simulate' ? 'SIMULATE' : 'LIVE'}</code>`,
          `Mint: <code>${this.escapeHtml(event.parsed.mint)}</code>`,
          `Copy signature: <code>${this.escapeHtml(event.signature)}</code>`
        ];
        if (process.env.MODE !== 'simulate') {
          successMessage.push(`Explorer: https://explorer.solana.com/tx/${encodeURIComponent(event.signature)}?cluster=devnet`);
        }
        return successMessage.join('\n');
      }
      case 'buildFailed':
      case 'executionFailed':
        return [
          `<b>TRADE ${event.type === 'buildFailed' ? 'BUILD' : 'EXECUTION'} FAILED</b>`,
          `Mint: <code>${this.escapeHtml(event.parsed.mint || 'unknown')}</code>`,
          `Error: ${this.escapeHtml(event.error)}`
        ].join('\n');
      default:
        return null;
    }
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}