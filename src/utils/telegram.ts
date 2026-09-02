import https from 'https';
import fetch from 'node-fetch';
import { Express, Request, Response } from 'express';

const telegramAgent = new https.Agent({ keepAlive: true, maxSockets: 16, timeout: 8000 });

export interface TelegramBotCallbacks {
  getPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  getStatus: () => { openPositions: number; balance: string; channels: number; primaryServiceConnected: boolean } | Promise<{ openPositions: number; balance: string; channels: number; primaryServiceConnected: boolean }>;
  getPositions?: () => string | Promise<string>;
  getStats?: () => string | Promise<string>;
  getHistory?: () => string | Promise<string>;
  getSettings?: () => string | Promise<string>;
}

export interface TelegramBotOptions {
  token?: string;
  chatId?: string | number;
  extended?: boolean;
  webhookMode?: boolean;
  webhookSecret?: string;
  webhookUrl?: string;
  callbacks: TelegramBotCallbacks;
}

interface TelegramUpdate {
  update_id?: number;
  message?: { chat?: { id?: number | string }; date?: number; text?: string };
}

export async function sendTelegramMessage(chatId: number | string, text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    console.warn('Telegram notifications disabled: TELEGRAM_BOT_TOKEN is missing');
    return false;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', agent: telegramAgent, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`Telegram request failed (${response.status}): ${body}`);
      return false;
    }
    const result = JSON.parse(body) as { ok?: boolean };
    if (result.ok !== true) {
      console.error(`Telegram rejected the message: ${body}`);
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

export class TelegramBot {
  private readonly options: Required<Pick<TelegramBotOptions, 'extended' | 'webhookMode'>> & TelegramBotOptions;
  private readonly processedUpdates = new Set<number>();
  private readonly lastCommandByChat = new Map<string, number>();
  private readonly lastCooldownNoticeByChat = new Map<string, number>();
  private updateOffset = 0;
  private pollingTimer?: NodeJS.Timeout;
  private pollingBackoffUntil = 0;
  private pollingInFlight = false;

  constructor(options: TelegramBotOptions) {
    this.options = { extended: false, webhookMode: true, ...options };
  }

  get enabled(): boolean { return Boolean(this.options.token && this.options.chatId); }

  async start(app?: Express): Promise<void> {
    if (!this.enabled) {
      console.warn('Telegram commands disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing');
      return;
    }
    if (this.options.webhookMode && app) {
      app.post(this.webhookRoute, async (request: Request, response: Response) => {
        try { await this.handleUpdate(request.body ?? {}); response.sendStatus(200); }
        catch (error) { console.error('Telegram webhook error:', error); response.sendStatus(500); }
      });
      await this.setupWebhook();
    } else if (!this.options.webhookMode) {
      await this.deleteWebhook();
      this.scheduleNextPoll(0);
    }
  }

  stop(): void {
    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = undefined;
    }
  }
  async sendAlert(message: string): Promise<boolean> { return sendTelegramAlert(message); }
  async sendMessage(chatId: number | string, text: string): Promise<boolean> { return sendTelegramMessage(chatId, text); }

  async setupWebhook(): Promise<boolean> {
    const url = this.options.webhookUrl || `${process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 10000}`}${this.webhookRoute}`;
    await this.deleteWebhook();
    return this.apiCall('setWebhook', { url, secret_token: this.options.webhookSecret });
  }

  async deleteWebhook(): Promise<boolean> { return this.apiCall('deleteWebhook', { drop_pending_updates: true }); }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.update_id !== undefined) {
      if (this.processedUpdates.has(update.update_id)) return;
      this.processedUpdates.add(update.update_id);
      if (this.processedUpdates.size > 1000) this.processedUpdates.delete(this.processedUpdates.values().next().value!);
    }
    const message = update.message;
    if (!message?.text || (message.date !== undefined && Date.now() / 1000 - message.date > 30)) return;
    const chatId = String(message.chat?.id ?? '');
    if (!chatId || chatId !== String(this.options.chatId)) return;
    const command = message.text.trim().toLowerCase().split(/\s+/)[0];
    const now = Date.now();
    const lastCommand = this.lastCommandByChat.get(chatId) || 0;
    if (now - lastCommand < this.cooldownMs) {
      const lastNotice = this.lastCooldownNoticeByChat.get(chatId) || 0;
      if (now - lastNotice >= this.cooldownNotifyMs) {
        this.lastCooldownNoticeByChat.set(chatId, now);
        await this.sendMessage(chatId, 'Please wait before sending another command.');
      }
      return;
    }
    this.lastCommandByChat.set(chatId, now);

    let reply: string | null = null;
    if (command === '/pause') {
      this.options.callbacks.setPaused(true);
      reply = '⏸ <b>Bot paused.</b>\nNo new buys will be taken. Existing positions still monitored/sold normally.\nSend /resume to continue.';
    } else if (command === '/resume') {
      this.options.callbacks.setPaused(false);
      reply = '▶ <b>Bot resumed.</b>\nNew buys re-enabled.';
    } else if (command === '/status') {
      const status = await this.options.callbacks.getStatus();
      reply = `<b>STATUS</b>\nPaused: ${this.options.callbacks.getPaused() ? 'yes' : 'no'}\nOpen positions: ${status.openPositions}\nWallet: ${this.escapeHtml(status.balance)} SOL\nWS channels: ${status.channels}\nPrimary service: ${status.primaryServiceConnected ? '✅ connected' : '❌ disconnected'}`;
    } else if (this.options.extended) {
      const provider = command === '/positions' ? this.options.callbacks.getPositions : command === '/stats' ? this.options.callbacks.getStats : command === '/history' ? this.options.callbacks.getHistory : command === '/settings' ? this.options.callbacks.getSettings : undefined;
      if (provider) reply = await provider();
    }
    if (reply) await this.sendMessage(chatId, reply);
  }

  async poll(): Promise<void> {
    if (!this.enabled || this.options.webhookMode || this.pollingInFlight) return;

    const now = Date.now();
    if (now < this.pollingBackoffUntil) {
      this.scheduleNextPoll(Math.max(0, this.pollingBackoffUntil - now));
      return;
    }

    this.pollingInFlight = true;
    try {
      const result = await this.apiRequest('getUpdates', { offset: this.updateOffset, timeout: this.pollTimeoutSec });
      if (!result.ok) {
        if (result.status === 409) {
          this.pollingBackoffUntil = Date.now() + this.pollBackoffMs;
          console.error('Telegram polling conflict; backing off temporarily');
          this.scheduleNextPoll(this.pollBackoffMs);
        } else {
          console.error(`Telegram polling failed (${result.status}): ${result.body}`);
          this.scheduleNextPoll(this.pollIntervalMs);
        }
        return;
      }

      for (const update of (result.data.result || []) as TelegramUpdate[]) {
        await this.handleUpdate(update);
        if (update.update_id !== undefined) this.updateOffset = update.update_id + 1;
      }
      this.scheduleNextPoll(this.pollIntervalMs);
    } finally {
      this.pollingInFlight = false;
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.options.webhookMode) return;
    if (this.pollingTimer) clearTimeout(this.pollingTimer);
    this.pollingTimer = setTimeout(() => {
      this.pollingTimer = undefined;
      void this.poll().catch(error => console.error('Telegram polling error:', error));
    }, delayMs);
  }

  private async apiCall(method: string, parameters: Record<string, unknown>): Promise<boolean> {
    const result = await this.apiRequest(method, parameters);
    if (!result.ok) console.error(`Telegram ${method} failed (${result.status}): ${result.body}`);
    return result.ok && result.data.ok === true;
  }

  private async apiRequest(method: string, parameters: Record<string, unknown>): Promise<{ ok: boolean; status: number; body: string; data: any }> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.options.token}/${method}`, { method: 'POST', agent: telegramAgent, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parameters) });
      const body = await response.text();
      return { ok: response.ok, status: response.status, body, data: JSON.parse(body) };
    } catch (error) { return { ok: false, status: 0, body: error instanceof Error ? error.message : String(error), data: {} }; }
  }

  private get webhookRoute(): string { return `/telegram-webhook/${this.options.webhookSecret || 'telegram'}`; }
  private get cooldownMs(): number { return Number(process.env.TELEGRAM_COOLDOWN_MS || 5000); }
  private get cooldownNotifyMs(): number { return Number(process.env.TELEGRAM_COOLDOWN_NOTIFY_MS || 60000); }
  private get pollIntervalMs(): number { return Number(process.env.TELEGRAM_POLL_INTERVAL_MS || 30000); }
  private get pollTimeoutSec(): number { return Number(process.env.TELEGRAM_GETUPDATES_TIMEOUT_SEC || 30); }
  private get pollBackoffMs(): number { return Number(process.env.TELEGRAM_POLL_BACKOFF_MS || 300000); }
  private escapeHtml(value: unknown): string { return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
}

export function createTelegramBot(options: TelegramBotOptions): TelegramBot { return new TelegramBot(options); }
