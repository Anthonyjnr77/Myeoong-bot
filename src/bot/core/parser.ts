// src/bot/core/parser.ts
import { DetectedTransaction } from './detector';
import { PUMP_FUN_CONSTANTS, TRADING_UTILS, appConfig } from '../../config/config';

export interface ParsedTrade {
  type: 'BUY' | 'SELL';
  mint: string;
  user: string;
  tokenAmount: number;
  solAmount: number;
  signature: string;
  slot: number;
  timestamp: number;
}

export class TradeParser {
  /**
   * Parse a detected transaction to extract pump.fun trade details
   * Returns ParsedTrade if valid trade from watchlist, null otherwise
   */
  parse(transaction: DetectedTransaction): ParsedTrade | null {
    try {
      // Filter for pump.fun instructions only
      const pumpFunInstructions = transaction.instructions.filter(ix => {
        if (ix.programIdIndex === undefined) return false;
        const programId = transaction.accountKeys[ix.programIdIndex];
        return programId === PUMP_FUN_CONSTANTS.PROGRAM_ID;
      });

      if (pumpFunInstructions.length === 0) {
        return null;
      }

      // Find BUY or SELL instruction by discriminator
      for (const instruction of pumpFunInstructions) {
        if (!instruction.data || instruction.data.length < 24) {
          continue;
        }

        const discriminator = instruction.data.slice(0, 8);
        const buyDiscriminator = Array.from(PUMP_FUN_CONSTANTS.BUY_DISCRIMINATOR);
        const sellDiscriminator = Array.from(PUMP_FUN_CONSTANTS.SELL_DISCRIMINATOR);
        const instructionDiscriminator = Array.from(discriminator);

        const isBuy = buyDiscriminator.every((byte, i) => byte === instructionDiscriminator[i]);
        const isSell = sellDiscriminator.every((byte, i) => byte === instructionDiscriminator[i]);

        if (!isBuy && !isSell) {
          continue;
        }

        const accountIndices = Array.from(instruction.accounts);
        
        const targetAccounts = PUMP_FUN_CONSTANTS.TARGET_ACCOUNTS[isBuy ? 'BUY' : 'SELL'];
        const mintAccountIndex = accountIndices[targetAccounts[0].index];
        const userAccountIndex = accountIndices[targetAccounts[1].index];

        if (mintAccountIndex === undefined || userAccountIndex === undefined) {
          continue;
        }

        const mint = transaction.accountKeys[mintAccountIndex];
        const user = transaction.accountKeys[userAccountIndex];

        if (!mint || !user) {
          continue;
        }

        // Watchlist check
        if (!appConfig.trading.watchWallets.includes(user)) {
          return null;
        }

        const tokenAmount = this.parseU64(instruction.data, 8);
        const solAmount = this.parseU64(instruction.data, 16);

        // Minimum trade amount check
        if (!TRADING_UTILS.meetsMinimumTrade(solAmount, appConfig.trading.minTradeAmountSol)) {
          return null;
        }

        return {
          type: isBuy ? 'BUY' : 'SELL',
          mint,
          user,
          tokenAmount,
          solAmount,
          signature: transaction.signature,
          slot: transaction.slot,
          timestamp: transaction.timestamp
        };
      }

      return null;

    } catch (error) {
      console.error(`Parser error for ${transaction.signature}:`, error);
      return null;
    }
  }

  /**
   * Parse unsigned 64-bit integer from buffer (little-endian)
   */
  private parseU64(data: Uint8Array, offset: number): number {
    const slice = data.slice(offset, offset + 8);
    const dataView = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
    return Number(dataView.getBigUint64(0, true));
  }
}