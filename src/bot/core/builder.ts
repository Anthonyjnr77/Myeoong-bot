// src/bot/core/builder.ts
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  LAMPORTS_PER_SOL, 
  Transaction 
} from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { PumpFunSDK } from 'pumpdotfun-repumped-sdk';
import { ParsedTrade } from './parser';
import { appConfig, TRADING_UTILS } from '../../config/config';
import bs58 from 'bs58';

export interface BuildResult {
  success: boolean;
  transaction?: Transaction;
  error?: string;
  buildTimestamp: number;
  metadata?: {
    mint: string;
    amount: string;
  };
  timing?: {
    bondingCurveCheck: number;
    amountConversion: number;
    sdkBuild: number;
    total: number;
  };
}

export class TransactionBuilder {
  private connection: Connection;
  private provider: AnchorProvider;
  private sdk: PumpFunSDK;
  private botKeypair: Keypair;

  constructor() {
    this.connection = new Connection(appConfig.rpc.endpoint, {
      commitment: appConfig.rpc.commitment
    });

    this.botKeypair = Keypair.fromSecretKey(
      bs58.decode(appConfig.wallet.privateKey)
    );

    const botWallet = new Wallet(this.botKeypair);
    this.provider = new AnchorProvider(this.connection, botWallet, {
      commitment: appConfig.rpc.commitment
    });

    this.sdk = new PumpFunSDK(this.provider);
  }

  async buildTransaction(parsedTrade: ParsedTrade): Promise<BuildResult> {
    const buildTimestamp = Date.now();

    try {
      if (parsedTrade.type !== 'BUY') {
        return {
          success: false,
          error: 'Only BUY trades supported in MVP',
          buildTimestamp
        };
      }

      const mintPubkey = new PublicKey(parsedTrade.mint);
      
      const bondingCurve = await this.sdk.token.getBondingCurveAccount(
        mintPubkey, 
        appConfig.rpc.commitment
      );
      
      if (!bondingCurve) {
        return {
          success: false,
          error: 'Bonding curve not found - token may have graduated',
          buildTimestamp
        };
      }

      const buyAmountLamports = BigInt(
        TRADING_UTILS.solToLamports(appConfig.trading.copyAmountSol)
      );

      const transaction = await this.sdk.trade.getBuyInstructionsBySolAmount(
        this.botKeypair.publicKey,
        mintPubkey,
        buyAmountLamports,
        BigInt(appConfig.trading.slippageBps),
        appConfig.rpc.commitment
      );

      return {
        success: true,
        transaction,
        buildTimestamp,
        metadata: {
          mint: parsedTrade.mint,
          amount: appConfig.trading.copyAmountSol.toString()
        }
      };

    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        buildTimestamp
      };
    }
  }

  async buildTransactionWithTiming(parsedTrade: ParsedTrade): Promise<BuildResult> {
    const buildTimestamp = Date.now();
    const timing = {
      bondingCurveCheck: 0,
      amountConversion: 0,
      sdkBuild: 0,
      total: 0,
    };

    try {
      if (parsedTrade.type !== 'BUY') {
        return {
          success: false,
          error: 'Only BUY trades supported in MVP',
          buildTimestamp
        };
      }

      const mintPubkey = new PublicKey(parsedTrade.mint);
      
      const t1 = Date.now();
      const bondingCurve = await this.sdk.token.getBondingCurveAccount(
        mintPubkey, 
        appConfig.rpc.commitment
      );
      timing.bondingCurveCheck = Date.now() - t1;
      
      if (!bondingCurve) {
        return {
          success: false,
          error: 'Bonding curve not found',
          buildTimestamp,
          timing
        };
      }

      const t2 = Date.now();
      const buyAmountLamports = BigInt(
        TRADING_UTILS.solToLamports(appConfig.trading.copyAmountSol)
      );
      timing.amountConversion = Date.now() - t2;

      const t3 = Date.now();
      const transaction = await this.sdk.trade.getBuyInstructionsBySolAmount(
        this.botKeypair.publicKey,
        mintPubkey,
        buyAmountLamports,
        BigInt(appConfig.trading.slippageBps),
        appConfig.rpc.commitment
      );
      timing.sdkBuild = Date.now() - t3;

      timing.total = Date.now() - buildTimestamp;

      return {
        success: true,
        transaction,
        buildTimestamp,
        metadata: {
          mint: parsedTrade.mint,
          amount: appConfig.trading.copyAmountSol.toString()
        },
        timing
      };

    } catch (error) {
      timing.total = Date.now() - buildTimestamp;
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        buildTimestamp,
        timing
      };
    }
  }

  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(this.botKeypair.publicKey);
    return balance / LAMPORTS_PER_SOL;
  }

  getBotWallet(): PublicKey {
    return this.botKeypair.publicKey;
  }

  getBotKeypair(): Keypair {
    return this.botKeypair;
  }
}