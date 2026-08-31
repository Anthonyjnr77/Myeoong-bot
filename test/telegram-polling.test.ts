import assert from 'node:assert/strict';
import { TelegramBot } from '../src/utils/telegram';

async function testNoConcurrentPolls(): Promise<void> {
  const bot = new TelegramBot({
    token: 'test-token',
    chatId: '123',
    webhookMode: false,
    callbacks: {
      getPaused: () => false,
      setPaused: () => undefined,
      getStatus: () => ({ openPositions: 0, balance: '0', channels: 1, primaryServiceConnected: true }),
    },
  });

  let active = 0;
  let maxActive = 0;

  (bot as any).apiRequest = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 50));
    active -= 1;
    return {
      ok: true,
      status: 200,
      body: '{"ok":true,"result":[]}',
      data: { ok: true, result: [] },
    };
  };

  await Promise.all([
    (bot as any).poll(),
    (bot as any).poll(),
  ]);

  assert.equal(maxActive, 1, 'Polling requests should not overlap');
  console.log('testNoConcurrentPolls: ok');
}

void testNoConcurrentPolls();
