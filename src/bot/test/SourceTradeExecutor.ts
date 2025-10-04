// src/bot/test/SourceTradeExecutor.ts
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import {
  executePumpFunBuy,
  executePumpFunSell,
  executePumpSwapBuy,
  executePumpSwapSell
} from '../../utils/test-utils';
import { SELL_PERCENTAGE, appConfig } from '../../config/config';

export interface SourceTradeOptions {
  protocol: 'PUMP_FUN' | 'PUMP_SWAP';
  type: 'BUY' | 'SELL';
  mint?: string; // Required for PUMP_FUN
  pool?: PublicKey; // Required for PUMP_SWAP
  baseMint?: PublicKey; // Required for PUMP_SWAP sells
}

export class SourceTradeExecutor {
  private connection: Connection;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  /**
   * Execute source trade - handles both pump.fun and pumpswap protocols
   * Handles both buy and sell operations
   */
  async executeTrade(
    sourceWallet: Keypair,
    options: SourceTradeOptions
  ): Promise<string> {
    const { protocol, type, mint, pool, baseMint } = options;

    if (type === 'BUY') {
      // Execute buy
      if (protocol === 'PUMP_FUN') {
        if (!mint) {
          throw new Error('mint is required for PUMP_FUN buys');
        }
        const signature = await executePumpFunBuy(
          this.connection,
          sourceWallet,
          new PublicKey(mint),
          appConfig.trading.protocols.pumpFun.buyAmountSol
        );
        return signature;
      } else {
        // PUMP_SWAP
        if (!pool) {
          throw new Error('pool is required for PUMP_SWAP buys');
        }
        const signature = await executePumpSwapBuy(
          this.connection,
          sourceWallet,
          pool,
          appConfig.trading.protocols.pumpSwap.buyAmountSol
        );
        return signature;
      }
    } else {
      // Execute sell
      if (protocol === 'PUMP_FUN') {
        if (!mint) {
          throw new Error('mint is required for PUMP_FUN sells');
        }

        // Get token balance
        const accounts = await this.connection.getTokenAccountsByOwner(
          sourceWallet.publicKey,
          { mint: new PublicKey(mint) }
        );

        if (accounts.value.length === 0) {
          throw new Error('No token account found');
        }

        const balance = accounts.value[0].account.data.readBigUInt64LE(64);
        if (balance === 0n) {
          throw new Error('Zero token balance');
        }

        // Calculate sell amount (SELL_PERCENTAGE of balance)
        const sellAmount = (balance * BigInt(SELL_PERCENTAGE * 100)) / 100n;

        const signature = await executePumpFunSell(
          this.connection,
          sourceWallet,
          new PublicKey(mint),
          sellAmount
        );
        return signature;
      } else {
        // PUMP_SWAP
        if (!pool) {
          throw new Error('pool is required for PUMP_SWAP sells');
        }
        if (!baseMint) {
          throw new Error('baseMint is required for PUMP_SWAP sells');
        }

        // Get token balance
        const accounts = await this.connection.getTokenAccountsByOwner(
          sourceWallet.publicKey,
          { mint: baseMint }
        );

        if (accounts.value.length === 0) {
          throw new Error('No token account found');
        }

        const balance = accounts.value[0].account.data.readBigUInt64LE(64);
        if (balance === 0n) {
          throw new Error('Zero token balance');
        }

        // Calculate sell amount (SELL_PERCENTAGE of balance)
        const sellAmount = (balance * BigInt(SELL_PERCENTAGE * 100)) / 100n;

        const signature = await executePumpSwapSell(
          this.connection,
          sourceWallet,
          pool,
          sellAmount.toString()
        );
        return signature;
      }
    }
  }
}
