// src/parser.ts
import { DetectedTransaction, Protocol } from './detector';
import { PUMP_FUN_CONSTANTS, PUMP_SWAP_CONSTANTS, TRADING_UTILS, appConfig } from './config/config';

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
  pool?: string; // Only for PumpSwap
}

export class TradeParser {
  /**
   * Parse a detected transaction based on protocol
   * Returns ParsedTrade if valid trade from watchlist, null otherwise
   */
  parse(transaction: DetectedTransaction): ParsedTrade | null {
    try {
      // Route to protocol-specific parser
      switch (transaction.protocol) {
        case 'PUMP_FUN':
          return this.parsePumpFun(transaction);
        case 'PUMP_SWAP':
          return this.parsePumpSwap(transaction);
        default:
          return null;
      }
    } catch (error) {
      console.error(`Parser error for ${transaction.signature}:`, error);
      return null;
    }
  }

  /**
   * Parse pump.fun transaction
   */
  private parsePumpFun(transaction: DetectedTransaction): ParsedTrade | null {
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
        protocol: 'PUMP_FUN',
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
  }

  /**
   * Parse PumpSwap transaction
   */
  private parsePumpSwap(transaction: DetectedTransaction): ParsedTrade | null {
    // Filter for PumpSwap instructions only
    const pumpSwapInstructions = transaction.instructions.filter(ix => {
      if (ix.programIdIndex === undefined) return false;
      const programId = transaction.accountKeys[ix.programIdIndex];
      return programId === PUMP_SWAP_CONSTANTS.PROGRAM_ID;
    });

    if (pumpSwapInstructions.length === 0) {
      return null;
    }

    // Find BUY or SELL instruction by discriminator
    for (const instruction of pumpSwapInstructions) {
      if (!instruction.data || instruction.data.length < 24) {
        continue;
      }

      const discriminator = instruction.data.slice(0, 8);
      const buyDiscriminator = Array.from(PUMP_SWAP_CONSTANTS.BUY_DISCRIMINATOR);
      const sellDiscriminator = Array.from(PUMP_SWAP_CONSTANTS.SELL_DISCRIMINATOR);
      const instructionDiscriminator = Array.from(discriminator);

      const isBuy = buyDiscriminator.every((byte, i) => byte === instructionDiscriminator[i]);
      const isSell = sellDiscriminator.every((byte, i) => byte === instructionDiscriminator[i]);

      if (!isBuy && !isSell) {
        continue;
      }

      const accountIndices = Array.from(instruction.accounts);
      
      // PumpSwap account layout (different from pump.fun)
      const poolAccountIndex = accountIndices[0];
      const userAccountIndex = accountIndices[1];
      const baseMintAccountIndex = accountIndices[3];
      const quoteMintAccountIndex = accountIndices[4];

      if (poolAccountIndex === undefined || userAccountIndex === undefined || 
          baseMintAccountIndex === undefined || quoteMintAccountIndex === undefined) {
        continue;
      }

      const pool = transaction.accountKeys[poolAccountIndex];
      const user = transaction.accountKeys[userAccountIndex];
      const baseMint = transaction.accountKeys[baseMintAccountIndex];
      const quoteMint = transaction.accountKeys[quoteMintAccountIndex];

      if (!pool || !user || !baseMint || !quoteMint) {
        continue;
      }

      // Watchlist check
      if (!appConfig.trading.watchWallets.includes(user)) {
        return null;
      }

      // PumpSwap instruction data:
      // Bytes 8-15: base amount out (tokens received)
      // Bytes 16-23: max quote amount in (SOL spent)
      const baseAmountOut = this.parseU64(instruction.data, 8);
      const maxQuoteIn = this.parseU64(instruction.data, 16);

      // Use max quote in (SOL amount) for minimum trade check
      if (!TRADING_UTILS.meetsMinimumTrade(maxQuoteIn, appConfig.trading.minTradeAmountSol)) {
        return null;
      }

      return {
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
      };
    }

    return null;
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