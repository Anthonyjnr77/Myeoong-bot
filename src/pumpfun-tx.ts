// src/pumpfun-tx.ts
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  ComputeBudgetProgram
} from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  AccountLayout
} from '@solana/spl-token';
import BN from 'bn.js';
import { PumpFunSDK } from './pumpfun-sdk/PumpFunSDK';
import { ParsedTrade } from './parser';
import { appConfig, TRADING_UTILS } from './config/config';
import bs58 from 'bs58';
import { toError } from './utils/errors';
import { fetchWithRetry } from './utils/rpc-retry';

export interface PumpFunTxResult {
  success: boolean;
  transaction?: Transaction;
  error?: string;
  buildTimestamp: number;
  blockhash?: string;
  metadata?: {
    mint: string;
    amount: string;
  };
  timing?: {
    parallelFetch: number;
    calculateAmount: number;
    buildInstructions: number;
    total: number;
  };
}

export class PumpFunTxBuilder {
  private connection: Connection;
  private botKeypair: Keypair;
  private sdk: PumpFunSDK;
  
  private globalAccount: any = null;
  private feeConfig: any = null;
  private cacheInitialized: boolean = false;
  private refreshInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.connection = new Connection(appConfig.rpc.endpoint, {
      commitment: appConfig.rpc.commitment
    });

    this.botKeypair = Keypair.fromSecretKey(
      bs58.decode(appConfig.wallet.privateKey)
    );

    const provider = new AnchorProvider(
      this.connection,
      new Wallet(this.botKeypair),
      { commitment: appConfig.rpc.commitment }
    );

    this.sdk = new PumpFunSDK(provider);
  }

  async initialize(): Promise<void> {
    const [globalAccount, feeConfig] = await Promise.all([
      this.sdk.token.getGlobalAccount(appConfig.rpc.commitment),
      this.sdk.token.getFeeConfig(appConfig.rpc.commitment)
    ]);

    this.globalAccount = globalAccount;
    this.feeConfig = feeConfig;
    this.cacheInitialized = true;

    this.refreshInterval = setInterval(() => {
      this.refreshCache();
    }, 10 * 60 * 1000);
  }

  private async refreshCache(): Promise<void> {
    try {
      const [globalAccount, feeConfig] = await Promise.all([
        this.sdk.token.getGlobalAccount(appConfig.rpc.commitment),
        this.sdk.token.getFeeConfig(appConfig.rpc.commitment)
      ]);

      this.globalAccount = globalAccount;
      this.feeConfig = feeConfig;
    } catch (error) {
      // Silently skip - cache refresh failure
    }
  }

  cleanup(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  async buildTransactionWithTiming(parsedTrade: ParsedTrade): Promise<PumpFunTxResult> {
    const buildTimestamp = Date.now();
    const timing = {
      parallelFetch: 0,
      calculateAmount: 0,
      buildInstructions: 0,
      total: 0
    };

    try {
      if (!this.cacheInitialized) {
        throw new Error('PumpFun builder not initialized - call initialize() before building transactions');
      }

      const mint = new PublicKey(parsedTrade.mint);

      if (parsedTrade.type === 'BUY') {
        return await this.buildBuyTransaction(mint, buildTimestamp, timing);
      } else if (parsedTrade.type === 'SELL') {
        return await this.buildSellTransaction(mint, buildTimestamp, timing);
      } else {
        return {
          success: false,
          error: `Unsupported trade type: ${parsedTrade.type}`,
          buildTimestamp,
          timing
        };
      }

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

  private async buildBuyTransaction(
    mint: PublicKey,
    buildTimestamp: number,
    timing: { parallelFetch: number; calculateAmount: number; buildInstructions: number; total: number }
  ): Promise<PumpFunTxResult> {
    try {
      const buyAmountSol = BigInt(
        TRADING_UTILS.solToLamports(appConfig.trading.protocols.pumpFun.buyAmountSol)
      );
      const slippageBasisPoints = BigInt(appConfig.trading.protocols.pumpFun.slippageBps);

      const bondingCurvePDA = this.sdk.pda.getBondingCurvePDA(mint);

      const t1 = Date.now();
      const [bondingCurveAccount, { blockhash }] = await Promise.all([
        fetchWithRetry(() => this.sdk.token.getBondingCurveAccount(mint, appConfig.rpc.commitment)),
        fetchWithRetry(() => this.connection.getLatestBlockhash(appConfig.rpc.commitment))
      ]);
      timing.parallelFetch = Date.now() - t1;

      // Safety: null account checks
      if (!bondingCurveAccount) {
        throw new Error(`Bonding curve not found - token may have graduated (mint: ${mint.toBase58()})`);
      }

    const bondingCreator = new PublicKey(bondingCurveAccount.creator);

    const t2 = Date.now();
    const buyAmount = bondingCurveAccount.getBuyPrice(
      this.globalAccount,
      this.feeConfig,
      buyAmountSol
    );
    const buyAmountWithSlippage = buyAmountSol + (buyAmountSol * slippageBasisPoints / 10000n);
    timing.calculateAmount = Date.now() - t2;

    const t3 = Date.now();
    const transaction = new Transaction();
    
    const bondingCurve = bondingCurvePDA;
    const associatedBonding = await getAssociatedTokenAddress(
      mint,
      bondingCurve,
      true
    );

    const associatedUser = await getAssociatedTokenAddress(
      mint,
      this.botKeypair.publicKey
    );

    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.botKeypair.publicKey,
        associatedUser,
        this.botKeypair.publicKey,
        mint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    const globalAccountPDA = this.sdk.pda.getGlobalAccountPda();
    const creatorVault = this.sdk.pda.getCreatorVaultPda(bondingCreator);
    const eventAuthority = this.sdk.pda.getEventAuthorityPda();

    const ix = await this.sdk.program.methods
      .buy(new BN(buyAmount.toString()), new BN(buyAmountWithSlippage.toString()))
      .accounts({
        global: globalAccountPDA,
        feeRecipient: this.globalAccount.feeRecipient,
        mint,
        bondingCurve,
        associatedBondingCurve: associatedBonding,
        associatedUser,
        user: this.botKeypair.publicKey,
        creatorVault,
        eventAuthority,
        globalVolumeAccumulator: this.sdk.pda.getGlobalVolumeAccumulatorPda(),
        userVolumeAccumulator: this.sdk.pda.getUserVolumeAccumulatorPda(this.botKeypair.publicKey),
        feeConfig: this.sdk.pda.getPumpFeeConfigPda(),
      })
      .instruction();

      transaction.add(ix);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.botKeypair.publicKey;

      timing.buildInstructions = Date.now() - t3;
      timing.total = Date.now() - buildTimestamp;

      return {
        success: true,
        transaction,
        buildTimestamp,
        blockhash,
        metadata: {
          mint: mint.toBase58(),
          amount: appConfig.trading.protocols.pumpFun.buyAmountSol.toString()
        },
        timing
      };
    } catch (error) {
      timing.total = Date.now() - buildTimestamp;
      return {
        success: false,
        error: toError(error).message,
        buildTimestamp,
        timing
      };
    }
  }

  private async buildSellTransaction(
    mint: PublicKey,
    buildTimestamp: number,
    timing: { parallelFetch: number; calculateAmount: number; buildInstructions: number; total: number }
  ): Promise<PumpFunTxResult> {
    try {
      const slippageBasisPoints = BigInt(appConfig.trading.protocols.pumpFun.slippageBps);

      // Get bot's token account
      const associatedUser = await getAssociatedTokenAddress(
        mint,
        this.botKeypair.publicKey
      );

      const bondingCurvePDA = this.sdk.pda.getBondingCurvePDA(mint);

      // Fetch token balance + bonding curve + blockhash in parallel
      const t1 = Date.now();
      const [tokenAccountInfo, bondingCurveAccount, { blockhash }] = await Promise.all([
        fetchWithRetry(() => this.connection.getAccountInfo(associatedUser)),
        fetchWithRetry(() => this.sdk.token.getBondingCurveAccount(mint, appConfig.rpc.commitment)),
        fetchWithRetry(() => this.connection.getLatestBlockhash(appConfig.rpc.commitment))
      ]);
      timing.parallelFetch = Date.now() - t1;

      // Safety: null account checks
      if (!tokenAccountInfo) {
        throw new Error(`Bot token account not found - no tokens to sell (mint: ${mint.toBase58()}, wallet: ${this.botKeypair.publicKey.toBase58()})`);
      }

      const tokenBalance = AccountLayout.decode(tokenAccountInfo.data).amount;
      if (tokenBalance === 0n) {
        throw new Error(`Zero token balance - bot wallet has no tokens to sell (mint: ${mint.toBase58()})`);
      }

      if (!bondingCurveAccount) {
        throw new Error(`Bonding curve not found - token may have graduated (mint: ${mint.toBase58()})`);
      }

    const bondingCreator = new PublicKey(bondingCurveAccount.creator);

    // Calculate minimum SOL to receive with slippage
    const t2 = Date.now();
    const minSolOutput = bondingCurveAccount.getSellPrice(
      this.globalAccount,
      this.feeConfig,
      BigInt(tokenBalance.toString())
    );
    const minSolWithSlippage = minSolOutput - (minSolOutput * slippageBasisPoints / 10000n);
    timing.calculateAmount = Date.now() - t2;

    const t3 = Date.now();
    const transaction = new Transaction();
    
    const bondingCurve = bondingCurvePDA;
    const associatedBonding = await getAssociatedTokenAddress(
      mint,
      bondingCurve,
      true
    );

    const globalAccountPDA = this.sdk.pda.getGlobalAccountPda();
    const creatorVault = this.sdk.pda.getCreatorVaultPda(bondingCreator);
    const eventAuthority = this.sdk.pda.getEventAuthorityPda();

    const ix = await this.sdk.program.methods
      .sell(new BN(tokenBalance.toString()), new BN(minSolWithSlippage.toString()))
      .accounts({
        global: globalAccountPDA,
        feeRecipient: this.globalAccount.feeRecipient,
        mint,
        bondingCurve,
        associatedBondingCurve: associatedBonding,
        associatedUser,
        user: this.botKeypair.publicKey,
        creatorVault,
        eventAuthority,
        globalVolumeAccumulator: this.sdk.pda.getGlobalVolumeAccumulatorPda(),
        userVolumeAccumulator: this.sdk.pda.getUserVolumeAccumulatorPda(this.botKeypair.publicKey),
        feeConfig: this.sdk.pda.getPumpFeeConfigPda(),
      })
      .instruction();

      transaction.add(ix);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = this.botKeypair.publicKey;

      timing.buildInstructions = Date.now() - t3;
      timing.total = Date.now() - buildTimestamp;

      return {
        success: true,
        transaction,
        buildTimestamp,
        blockhash,
        metadata: {
          mint: mint.toBase58(),
          amount: `${Number(tokenBalance) / 1e6} tokens` // Assumes 6 decimals
        },
        timing
      };
    } catch (error) {
      timing.total = Date.now() - buildTimestamp;
      return {
        success: false,
        error: toError(error).message,
        buildTimestamp,
        timing
      };
    }
  }

  getBotKeypair(): Keypair {
    return this.botKeypair;
  }

  async getBalance(): Promise<number> {
    const balance = await this.connection.getBalance(
      this.botKeypair.publicKey
    );
    return balance / 1e9;
  }
}