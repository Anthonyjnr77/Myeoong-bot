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
          continue; // Need at least discriminator (8) + amounts (16)
        }

        // Extract discriminator (first 8 bytes)
        const discriminator = instruction.data.slice(0, 8);
        const buyDiscriminator = Array.from(PUMP_FUN_CONSTANTS.BUY_DISCRIMINATOR);
        const sellDiscriminator = Array.from(PUMP_FUN_CONSTANTS.SELL_DISCRIMINATOR);
        const instructionDiscriminator = Array.from(discriminator);

        // Check if this is a BUY or SELL
        const isBuy = buyDiscriminator.every((byte, i) => byte === instructionDiscriminator[i]);
        const isSell = sellDiscriminator.every((byte, i) => byte === instructionDiscriminator[i]);

        if (!isBuy && !isSell) {
          continue;
        }

        // CRITICAL: instruction.accounts is a Buffer, must convert to Array
        const accountIndices = Array.from(instruction.accounts);
        
        // Extract target accounts using validated indices
        const targetAccounts = PUMP_FUN_CONSTANTS.TARGET_ACCOUNTS[isBuy ? 'BUY' : 'SELL'];
        const mintAccountIndex = accountIndices[targetAccounts[0].index]; // index 2
        const userAccountIndex = accountIndices[targetAccounts[1].index]; // index 6

        if (mintAccountIndex === undefined || userAccountIndex === undefined) {
          console.warn(`Missing account indices in instruction`);
          continue;
        }

        const mint = transaction.accountKeys[mintAccountIndex];
        const user = transaction.accountKeys[userAccountIndex];

        if (!mint || !user) {
          console.warn(`Could not resolve mint or user from account keys`);
          continue;
        }

        // Watchlist check - early exit if not in watchlist
        if (!appConfig.trading.watchWallets.includes(user)) {
          console.log(`Ignoring trade from non-watchlist wallet: ${user.substring(0, 8)}...`);
          return null;
        }

        // Parse amounts using validated parseU64 function
        const tokenAmount = this.parseU64(instruction.data, 8);
        const solAmount = this.parseU64(instruction.data, 16);

        // Minimum trade amount check
        if (!TRADING_UTILS.meetsMinimumTrade(solAmount, appConfig.trading.minTradeAmountSol)) {
          console.log(`Trade below minimum: ${TRADING_UTILS.formatAmount(solAmount)} < ${appConfig.trading.minTradeAmountSol} SOL`);
          return null;
        }

        // Successfully parsed trade
        const parsedTrade: ParsedTrade = {
          type: isBuy ? 'BUY' : 'SELL',
          mint,
          user,
          tokenAmount,
          solAmount,
          signature: transaction.signature,
          slot: transaction.slot,
          timestamp: transaction.timestamp
        };

        console.log(`✅ Parsed ${parsedTrade.type} trade:`);
        console.log(`   Mint: ${mint}`);
        console.log(`   User: ${user.substring(0, 8)}...${user.slice(-4)}`);
        console.log(`   Token Amount: ${tokenAmount}`);
        console.log(`   SOL Amount: ${TRADING_UTILS.formatAmount(solAmount)}`);

        return parsedTrade;
      }

      return null; // No valid BUY/SELL instruction found

    } catch (error) {
      console.error(`Parser error for ${transaction.signature}:`, error);
      return null;
    }
  }

  /**
   * Parse unsigned 64-bit integer from buffer (little-endian)
   * Validated via test-detector.ts output
   */
  private parseU64(data: Uint8Array, offset: number): number {
    const slice = data.slice(offset, offset + 8);
    const dataView = new DataView(slice.buffer, slice.byteOffset, slice.byteLength);
    return Number(dataView.getBigUint64(0, true)); // true = little-endian
  }
}