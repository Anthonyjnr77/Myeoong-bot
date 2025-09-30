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
  metadata?: {
    mint: string;
    amount: string;
  };
  timing?: {
    fetchAccounts: number;
    calculateAmount: number;
    buildInstructions: number;
    total: number;
  };
}

export class DirectCallBuilder {
  private connection: Connection;
  private botKeypair: Keypair;
  private sdk: PumpFunSDK;

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

  async buildTransaction(parsedTrade: ParsedTrade): Promise<BuildResult> {
    const buildTimestamp = Date.now();

    try {
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

      // This replicates getBuyInstructionsBySolAmount exactly
      const transaction = await this.sdk.trade.getBuyInstructionsBySolAmount(
        this.botKeypair.publicKey,
        mint,
        buyAmountSol,
        slippageBasisPoints,
        appConfig.rpc.commitment
      );

      // Executor will fetch blockhash and set fee payer
      // Just set fee payer here
      transaction.feePayer = this.botKeypair.publicKey;

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
      fetchAccounts: 0,
      calculateAmount: 0,
      buildInstructions: 0,
      total: 0
    };

    try {
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

      // TIME: Fetch all three accounts (like SDK does)
      const t1 = Date.now();
      const bondingCurveAccount = await this.sdk.token.getBondingCurveAccount(
        mint,
        appConfig.rpc.commitment
      );
      if (!bondingCurveAccount) {
        throw new Error(`Bonding curve account not found: ${mint.toBase58()}`);
      }

      const feeConfig = await this.sdk.token.getFeeConfig(appConfig.rpc.commitment);
      const globalAccount = await this.sdk.token.getGlobalAccount(appConfig.rpc.commitment);
      timing.fetchAccounts = Date.now() - t1;

      // TIME: Calculate buy amount using SDK's method
      const t2 = Date.now();
      const buyAmount = bondingCurveAccount.getBuyPrice(
        globalAccount,
        feeConfig,
        buyAmountSol
      );
      const buyAmountWithSlippage = buyAmountSol + (buyAmountSol * slippageBasisPoints / 10000n);
      timing.calculateAmount = Date.now() - t2;

      // TIME: Build instructions (like SDK's buildBuyIx)
      const t3 = Date.now();
      const transaction = new Transaction();
      
      const bondingCurve = this.sdk.pda.getBondingCurvePDA(mint);
      const associatedBonding = await getAssociatedTokenAddress(
        mint,
        bondingCurve,
        true
      );

      const associatedUser = await this.sdk.token.createAssociatedTokenAccountIfNeeded(
        this.botKeypair.publicKey,
        this.botKeypair.publicKey,
        mint,
        transaction,
        appConfig.rpc.commitment
      );

      const globalAccountPDA = this.sdk.pda.getGlobalAccountPda();
      const bondingCreator = await this.sdk.token.getBondingCurveCreator(
        bondingCurve,
        appConfig.rpc.commitment
      );
      const creatorVault = this.sdk.pda.getCreatorVaultPda(bondingCreator);
      const eventAuthority = this.sdk.pda.getEventAuthorityPda();

      const ix = await this.sdk.program.methods
        .buy(new BN(buyAmount.toString()), new BN(buyAmountWithSlippage.toString()))
        .accounts({
          global: globalAccountPDA,
          feeRecipient: globalAccount.feeRecipient,
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

      // Executor will fetch blockhash - don't fetch it here
      // Just set fee payer
      transaction.feePayer = this.botKeypair.publicKey;

      timing.buildInstructions = Date.now() - t3;
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