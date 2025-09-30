// src/bot/core/builder/index.ts
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY
} from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { 
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
} from '@solana/spl-token';
import BN from 'bn.js';
import { PumpFunSDK } from '../pumpfun-sdk/PumpFunSDK';
import { ParsedTrade } from '../parser';
import { appConfig, TRADING_UTILS } from '../../../config/config';
import bs58 from 'bs58';

export interface BuildResult {
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

export class DirectCallBuilder {
  private connection: Connection;
  private botKeypair: Keypair;
  private sdk: PumpFunSDK;
  
  // Cached config
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
    console.log('Initializing config cache...');
    
    // Fetch global account and fee config in parallel
    const [globalAccount, feeConfig] = await Promise.all([
      this.sdk.token.getGlobalAccount(appConfig.rpc.commitment),
      this.sdk.token.getFeeConfig(appConfig.rpc.commitment)
    ]);

    this.globalAccount = globalAccount;
    this.feeConfig = feeConfig;
    this.cacheInitialized = true;

    console.log('Config cache initialized');

    // Refresh cache every 10 minutes
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
      
      console.log('Config cache refreshed');
    } catch (error) {
      console.error('Failed to refresh config cache:', error);
    }
  }

  cleanup(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  async buildTransaction(parsedTrade: ParsedTrade): Promise<BuildResult> {
    const buildTimestamp = Date.now();

    try {
      if (!this.cacheInitialized) {
        throw new Error('Builder not initialized. Call initialize() first.');
      }

      if (parsedTrade.type !== 'BUY') {
        return {
          success: false,
          error: 'Only BUY trades supported',
          buildTimestamp
        };
      }

      const mint = new PublicKey(parsedTrade.mint);
      const buyAmountSol = BigInt(
        TRADING_UTILS.solToLamports(appConfig.trading.copyAmountSol)
      );
      const slippageBasisPoints = BigInt(appConfig.trading.slippageBps);

      const bondingCurvePDA = this.sdk.pda.getBondingCurvePDA(mint);

      // Parallel fetch: bonding curve + blockhash (NO creator fetch!)
      const [bondingCurveAccount, { blockhash }] = await Promise.all([
        this.sdk.token.getBondingCurveAccount(mint, appConfig.rpc.commitment),
        this.connection.getLatestBlockhash(appConfig.rpc.commitment)
      ]);
      
      if (!bondingCurveAccount) {
        throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
      }

      // Extract creator directly from bonding curve - no extra RPC call!
      const bondingCreator = new PublicKey(bondingCurveAccount.creator);

      // Calculate using cached config
      const buyAmount = bondingCurveAccount.getBuyPrice(
        this.globalAccount,
        this.feeConfig,
        buyAmountSol
      );
      const buyAmountWithSlippage = buyAmountSol + (buyAmountSol * slippageBasisPoints / 10000n);

      // Build transaction
      const transaction = new Transaction();
      
      const bondingCurve = bondingCurvePDA;
      const associatedBonding = await getAssociatedTokenAddress(
        mint,
        bondingCurve,
        true
      );

      // Use idempotent ATA creation (no existence check needed)
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

      return {
        success: true,
        transaction,
        buildTimestamp,
        blockhash,
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
      parallelFetch: 0,
      calculateAmount: 0,
      buildInstructions: 0,
      total: 0
    };

    try {
      if (!this.cacheInitialized) {
        throw new Error('Builder not initialized. Call initialize() first.');
      }

      if (parsedTrade.type !== 'BUY') {
        return {
          success: false,
          error: 'Only BUY trades supported',
          buildTimestamp,
          timing
        };
      }

      const mint = new PublicKey(parsedTrade.mint);
      const buyAmountSol = BigInt(
        TRADING_UTILS.solToLamports(appConfig.trading.copyAmountSol)
      );
      const slippageBasisPoints = BigInt(appConfig.trading.slippageBps);

      const bondingCurvePDA = this.sdk.pda.getBondingCurvePDA(mint);

      // TIME: Parallel fetch bonding curve + blockhash (NO creator fetch!)
      const t1 = Date.now();
      const [bondingCurveAccount, { blockhash }] = await Promise.all([
        this.sdk.token.getBondingCurveAccount(mint, appConfig.rpc.commitment),
        this.connection.getLatestBlockhash(appConfig.rpc.commitment)
      ]);
      timing.parallelFetch = Date.now() - t1;
      
      if (!bondingCurveAccount) {
        throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
      }

      // Extract creator directly from bonding curve - no extra RPC call!
      const bondingCreator = new PublicKey(bondingCurveAccount.creator);

      // TIME: Calculate amount using cached config
      const t2 = Date.now();
      const buyAmount = bondingCurveAccount.getBuyPrice(
        this.globalAccount,
        this.feeConfig,
        buyAmountSol
      );
      const buyAmountWithSlippage = buyAmountSol + (buyAmountSol * slippageBasisPoints / 10000n);
      timing.calculateAmount = Date.now() - t2;

      // TIME: Build instructions
      const t3 = Date.now();
      const transaction = new Transaction();
      
      const bondingCurve = bondingCurvePDA;
      const associatedBonding = await getAssociatedTokenAddress(
        mint,
        bondingCurve,
        true
      );

      // Use idempotent ATA creation (no existence check - saves ~100ms)
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