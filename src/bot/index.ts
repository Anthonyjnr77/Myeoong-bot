// src/bot/index.ts
import { PumpFunDetector } from './core/detector';
import { TradeParser } from './core/parser';

async function main() {
  const detector = new PumpFunDetector();
  const parser = new TradeParser();

  // Wire detector → parser
  detector.onTransaction((transaction) => {
    const parsedTrade = parser.parse(transaction);
    
    if (!parsedTrade) {
      return; // Not a trade we care about
    }

    console.log(`🎯 Valid trade detected: ${parsedTrade.type}`);
    // TODO: Pass to builder
  });

  await detector.start();
}

main().catch(console.error);