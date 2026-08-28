// src/parser.ts
import { DetectedTransaction, Protocol } from './detector';
import { PUMP_FUN_CONSTANTS, PUMP_SWAP_CONSTANTS, TRADING_UTILS, appConfig } from './config/config';
import { toError } from './utils/errors';

export interface ParsedTrade {
  protocol: Protocol;
  type: 'BUY' | 'SELL';
  mint: string;
  user: string;
  tokenAmount: number;
  solAmount: number;
  signature: string;
  slot: number;
  timestamp: number;
  pool?: string;
}

export type ParseResult =
  | { success: true; data: ParsedTrade }
  | { success: false; filtered: true; reason?: string }
  | { success: false; error: string };

export class TradeParser {
  parse(transaction: DetectedTransaction): ParseResult {
    try {
      switch (transaction.protocol) {
        case 'PUMP_FUN':
          return this.parsePumpFun(transaction);
        case 'PUMP_SWAP':
          return this.parsePumpSwap(transaction);
        default:
          return { success: false, filtered: true };
      }
    } catch (error) {
      return { success: false, error: `Parse failed - ${toError(error).message} (sig: ${transaction.signature}, protocol: ${transaction.protocol})` };
    }
  }

  private parsePumpFun(transaction: DetectedTransaction): ParseResult {
    // Filter by program ID
    const pumpFunInstructions = transaction.instructions.filter(ix => {
      if (ix.programIdIndex === undefined) return false;
      const programId = transaction.accountKeys[ix.programIdIndex];
      return programId === PUMP_FUN_CONSTANTS.PROGRAM_ID;
    });

    if (pumpFunInstructions.length === 0) return { success: false, filtered: true };

    // Check if this is a token creation (has create instruction) - filter these out
    const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
    const hasCreateInstruction = pumpFunInstructions.some(ix =>
      ix.data && ix.data.length >= 8 && this.matchesDiscriminator(ix.data.slice(0, 8), CREATE_DISCRIMINATOR)
    );

    if (hasCreateInstruction) {
      return { success: false, filtered: true, reason: 'token_creation' };
    }

    for (const instruction of pumpFunInstructions) {
      // Safety: length check
      if (!instruction.data || instruction.data.length < 24) continue;

      const discriminator = instruction.data.slice(0, 8);
      const isBuy = this.matchesDiscriminator(discriminator, PUMP_FUN_CONSTANTS.BUY_DISCRIMINATOR);
      const isSell = this.matchesDiscriminator(discriminator, PUMP_FUN_CONSTANTS.SELL_DISCRIMINATOR);

      if (!isBuy && !isSell) continue;

      const accountIndices = Array.from(instruction.accounts, (index: unknown) => {
        if (typeof index !== 'number') {
          throw new Error('Instruction account index is not numeric');
        }
        return index;
      });
      const targetAccounts = PUMP_FUN_CONSTANTS.TARGET_ACCOUNTS[isBuy ? 'BUY' : 'SELL'];

      const mint = transaction.accountKeys[accountIndices[targetAccounts[0].index]];
      const user = transaction.accountKeys[accountIndices[targetAccounts[1].index]];

      // Safety: watchlist check
      if (!transaction.watchedWallets.includes(user)) return { success: false, filtered: true };

      const tokenAmount = this.parseU64(instruction.data, 8);
      const solAmount = this.parseU64(instruction.data, 16);

      // Safety: minimum trade check (buys only)
      if (isBuy && !TRADING_UTILS.meetsMinimumTrade(solAmount, appConfig.trading.minTradeAmountSol)) {
        return { success: false, filtered: true };
      }

      return {
        success: true,
        data: {
        protocol: 'PUMP_FUN',
        type: isBuy ? 'BUY' : 'SELL',
        mint,
        user,
        tokenAmount,
        solAmount,
        signature: transaction.signature,
        slot: transaction.slot,
        timestamp: transaction.timestamp
        }
      };
    }

    return { success: false, filtered: true };
  }

  private parsePumpSwap(transaction: DetectedTransaction): ParseResult {
    // Filter by program ID
    const pumpSwapInstructions = transaction.instructions.filter(ix => {
      if (ix.programIdIndex === undefined) return false;
      const programId = transaction.accountKeys[ix.programIdIndex];
      return programId === PUMP_SWAP_CONSTANTS.PROGRAM_ID;
    });

    if (pumpSwapInstructions.length === 0) return { success: false, filtered: true };

    for (const instruction of pumpSwapInstructions) {
      // Safety: length check
      if (!instruction.data || instruction.data.length < 24) continue;

      const discriminator = instruction.data.slice(0, 8);
      const isBuy = this.matchesDiscriminator(discriminator, PUMP_SWAP_CONSTANTS.BUY_DISCRIMINATOR);
      const isSell = this.matchesDiscriminator(discriminator, PUMP_SWAP_CONSTANTS.SELL_DISCRIMINATOR);

      if (!isBuy && !isSell) continue;

      const accountIndices = Array.from(instruction.accounts, (index: unknown) => {
        if (typeof index !== 'number') {
          throw new Error('Instruction account index is not numeric');
        }
        return index;
      });
      
      const pool = transaction.accountKeys[accountIndices[0]];
      const user = transaction.accountKeys[accountIndices[1]];
      const baseMint = transaction.accountKeys[accountIndices[3]];

      // Safety: watchlist check
      if (!transaction.watchedWallets.includes(user)) return { success: false, filtered: true };

      const baseAmountOut = this.parseU64(instruction.data, 8);
      const maxQuoteIn = this.parseU64(instruction.data, 16);

      // Safety: minimum trade check (buys only)
      if (isBuy && !TRADING_UTILS.meetsMinimumTrade(maxQuoteIn, appConfig.trading.minTradeAmountSol)) {
        return { success: false, filtered: true };
      }

      return {
        success: true,
        data: {
          protocol: 'PUMP_SWAP',
          type: isBuy ? 'BUY' : 'SELL',
          mint: baseMint,
          user,
          tokenAmount: baseAmountOut,
          solAmount: maxQuoteIn,
          signature: transaction.signature,
          slot: transaction.slot,
          timestamp: transaction.timestamp,
          pool
        }
      };
    }

    return { success: false, filtered: true };
  }

  private matchesDiscriminator(actual: Uint8Array, expected: Uint8Array): boolean {
    if (actual.length !== expected.length) return false;
    return Array.from(expected).every((byte, i) => byte === actual[i]);
  }

  private parseU64(data: Uint8Array, offset: number): number {
    const slice = data.slice(offset, offset + 8);
    const dataView = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
    return Number(dataView.getBigUint64(0, true));
  }
}