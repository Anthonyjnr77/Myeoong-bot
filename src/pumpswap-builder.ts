// src/pumpswap-builder.ts
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  AccountLayout,
  MintLayout
} from '@solana/spl-token';
import BN from 'bn.js';
import { ParsedTrade } from './parser';
import { appConfig, TRADING_UTILS } from './config/config';
import bs58 from 'bs58';
import { 
  PUMP_AMM_SDK,
  GLOBAL_CONFIG_PDA,
  PUMP_AMM_FEE_CONFIG_PDA,
  PUMP_AMM_PROGRAM_ID,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  coinCreatorVaultAuthorityPda,
  coinCreatorVaultAtaPda
} from './pumpswap-sdk';
import { buyQuoteInput } from './pumpswap-sdk/sdk/buy';
import { sellBaseInput } from './pumpswap-sdk/sdk/sell';

export interface BuildResult {
  success: boolean;
  transaction?: Transaction;
  error?: string;
  buildTimestamp: number;
  blockhash?: string;
  metadata?: {
    mint: string;
    pool: string;
    amount: string;
  };
  timing?: {
    parallelFetch: number;
    calculateAmount: number;
    buildInstructions: number;
    total: number;
  };
}

export class PumpSwapBuilder {
  private connection: Connection;
  private botKeypair: Keypair;
  private program: any;

  constructor() {
    this.connection = new Connection(appConfig.rpc.endpoint, {
      commitment: appConfig.rpc.commitment
    });

    this.botKeypair = Keypair.fromSecretKey(
      bs58.decode(appConfig.wallet.privateKey)
    );

    this.program = PUMP_AMM_SDK.offlineProgram;
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
      if (!parsedTrade.pool) {
        return {
          success: false,
          error: 'Pool address missing from parsed trade',
          buildTimestamp,
          timing
        };
      }

      const poolPubkey = new PublicKey(parsedTrade.pool);
      const baseMint = new PublicKey(parsedTrade.mint);

      if (parsedTrade.type === 'BUY') {
        return await this.buildBuyTransaction(poolPubkey, baseMint, buildTimestamp, timing);
      } else if (parsedTrade.type === 'SELL') {
        return await this.buildSellTransaction(poolPubkey, baseMint, buildTimestamp, timing);
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
    poolPubkey: PublicKey,
    baseMint: PublicKey,
    buildTimestamp: number,
    timing: { parallelFetch: number; calculateAmount: number; buildInstructions: number; total: number }
  ): Promise<BuildResult> {
    const quoteMint = NATIVE_MINT;
    const buyAmountSol = new BN(
      TRADING_UTILS.solToLamports(appConfig.trading.protocols.pumpSwap.buyAmountSol)
    );
    const slippage = appConfig.trading.protocols.pumpSwap.slippageBps / 100;

    const poolBaseTokenAccount = getAssociatedTokenAddressSync(
      baseMint,
      poolPubkey,
      true
    );

    const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      poolPubkey,
      true
    );

    const t1 = Date.now();
    const [accountInfos, { blockhash }] = await Promise.all([
      this.connection.getMultipleAccountsInfo([
        poolPubkey,
        GLOBAL_CONFIG_PDA,
        PUMP_AMM_FEE_CONFIG_PDA,
        baseMint,
        poolBaseTokenAccount,
        poolQuoteTokenAccount
      ]),
      this.connection.getLatestBlockhash(appConfig.rpc.commitment)
    ]);

    const [
      poolInfo,
      globalConfigInfo,
      feeConfigInfo,
      baseMintInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo
    ] = accountInfos;

    if (!poolInfo || !globalConfigInfo || !baseMintInfo || !poolBaseAccountInfo || !poolQuoteAccountInfo) {
      throw new Error('Failed to fetch required accounts');
    }

    timing.parallelFetch = Date.now() - t1;

    const pool = PUMP_AMM_SDK.decodePool(poolInfo);
    const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(globalConfigInfo);
    const feeConfig = feeConfigInfo ? PUMP_AMM_SDK.decodeFeeConfig(feeConfigInfo) : null;
    const baseMintAccount = MintLayout.decode(baseMintInfo.data);
    
    const poolBaseAmount = new BN(
      AccountLayout.decode(poolBaseAccountInfo.data).amount.toString()
    );
    const poolQuoteAmount = new BN(
      AccountLayout.decode(poolQuoteAccountInfo.data).amount.toString()
    );

    const t2 = Date.now();
    const { base, maxQuote } = buyQuoteInput({
      quote: buyAmountSol,
      slippage,
      baseReserve: poolBaseAmount,
      quoteReserve: poolQuoteAmount,
      globalConfig,
      baseMintAccount,
      baseMint,
      coinCreator: pool.coinCreator,
      creator: pool.creator,
      feeConfig
    });
    timing.calculateAmount = Date.now() - t2;

    const t3 = Date.now();
    const transaction = new Transaction();

    const baseTokenProgram = baseMintInfo.owner;
    const quoteTokenProgram = TOKEN_PROGRAM_ID;

    const userBaseTokenAccount = getAssociatedTokenAddressSync(
      baseMint,
      this.botKeypair.publicKey,
      false,
      baseTokenProgram
    );

    const userQuoteTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      this.botKeypair.publicKey,
      false,
      quoteTokenProgram
    );

    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.botKeypair.publicKey,
        userBaseTokenAccount,
        this.botKeypair.publicKey,
        baseMint,
        baseTokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.botKeypair.publicKey,
        userQuoteTokenAccount,
        this.botKeypair.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    transaction.add(
      SystemProgram.transfer({
        fromPubkey: this.botKeypair.publicKey,
        toPubkey: userQuoteTokenAccount,
        lamports: BigInt(maxQuote.toString())
      })
    );

    transaction.add(createSyncNativeInstruction(userQuoteTokenAccount));

    const protocolFeeRecipients = globalConfig.protocolFeeRecipients;
    const protocolFeeRecipient = protocolFeeRecipients[
      Math.floor(Math.random() * protocolFeeRecipients.length)
    ];

    const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      protocolFeeRecipient,
      true,
      quoteTokenProgram
    );

    const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(pool.coinCreator);
    const coinCreatorVaultAta = coinCreatorVaultAtaPda(
      coinCreatorVaultAuthority,
      quoteMint,
      quoteTokenProgram
    );

    const buyIx = await this.program.methods
      .buy(base, maxQuote, { 0: true })
      .accounts({
        pool: poolPubkey,
        globalConfig: GLOBAL_CONFIG_PDA,
        user: this.botKeypair.publicKey,
        baseMint,
        quoteMint,
        userBaseTokenAccount,
        userQuoteTokenAccount,
        poolBaseTokenAccount,
        poolQuoteTokenAccount,
        protocolFeeRecipient,
        protocolFeeRecipientTokenAccount,
        baseTokenProgram,
        quoteTokenProgram,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
        program: PUMP_AMM_PROGRAM_ID,
        coinCreatorVaultAta,
        coinCreatorVaultAuthority
      })
      .instruction();

    transaction.add(buyIx);

    transaction.add(
      createCloseAccountInstruction(
        userQuoteTokenAccount,
        this.botKeypair.publicKey,
        this.botKeypair.publicKey,
        undefined,
        TOKEN_PROGRAM_ID
      )
    );

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
        mint: baseMint.toBase58(),
        pool: poolPubkey.toBase58(),
        amount: appConfig.trading.protocols.pumpSwap.buyAmountSol.toString()
      },
      timing
    };
  }

  private async buildSellTransaction(
    poolPubkey: PublicKey,
    baseMint: PublicKey,
    buildTimestamp: number,
    timing: { parallelFetch: number; calculateAmount: number; buildInstructions: number; total: number }
  ): Promise<BuildResult> {
    const quoteMint = NATIVE_MINT;
    const slippage = appConfig.trading.protocols.pumpSwap.slippageBps / 100;

    const poolBaseTokenAccount = getAssociatedTokenAddressSync(
      baseMint,
      poolPubkey,
      true
    );

    const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      poolPubkey,
      true
    );

    const baseTokenProgram = TOKEN_PROGRAM_ID; // Will get actual value from account fetch
    const userBaseTokenAccount = getAssociatedTokenAddressSync(
      baseMint,
      this.botKeypair.publicKey,
      false,
      baseTokenProgram
    );

    // Fetch token balance + pool data + blockhash in parallel
    const t1 = Date.now();
    const [accountInfos, { blockhash }] = await Promise.all([
      this.connection.getMultipleAccountsInfo([
        userBaseTokenAccount, // Bot's token balance
        poolPubkey,
        GLOBAL_CONFIG_PDA,
        PUMP_AMM_FEE_CONFIG_PDA,
        baseMint,
        poolBaseTokenAccount,
        poolQuoteTokenAccount
      ]),
      this.connection.getLatestBlockhash(appConfig.rpc.commitment)
    ]);

    const [
      tokenAccountInfo,
      poolInfo,
      globalConfigInfo,
      feeConfigInfo,
      baseMintInfo,
      poolBaseAccountInfo,
      poolQuoteAccountInfo
    ] = accountInfos;

    if (!tokenAccountInfo) {
      return {
        success: false,
        error: 'No token account found - nothing to sell',
        buildTimestamp,
        timing
      };
    }

    const tokenBalance = new BN(
      AccountLayout.decode(tokenAccountInfo.data).amount.toString()
    );

    if (tokenBalance.isZero()) {
      return {
        success: false,
        error: 'Zero token balance - nothing to sell',
        buildTimestamp,
        timing
      };
    }

    if (!poolInfo || !globalConfigInfo || !baseMintInfo || !poolBaseAccountInfo || !poolQuoteAccountInfo) {
      throw new Error('Failed to fetch required accounts');
    }

    timing.parallelFetch = Date.now() - t1;

    const pool = PUMP_AMM_SDK.decodePool(poolInfo);
    const globalConfig = PUMP_AMM_SDK.decodeGlobalConfig(globalConfigInfo);
    const feeConfig = feeConfigInfo ? PUMP_AMM_SDK.decodeFeeConfig(feeConfigInfo) : null;
    const baseMintAccount = MintLayout.decode(baseMintInfo.data);
    
    const poolBaseAmount = new BN(
      AccountLayout.decode(poolBaseAccountInfo.data).amount.toString()
    );
    const poolQuoteAmount = new BN(
      AccountLayout.decode(poolQuoteAccountInfo.data).amount.toString()
    );

    const t2 = Date.now();
    const { minQuote } = sellBaseInput({
      base: tokenBalance,
      slippage,
      baseReserve: poolBaseAmount,
      quoteReserve: poolQuoteAmount,
      globalConfig,
      baseMintAccount,
      baseMint,
      coinCreator: pool.coinCreator,
      creator: pool.creator,
      feeConfig
    });
    timing.calculateAmount = Date.now() - t2;

    const t3 = Date.now();
    const transaction = new Transaction();

    const actualBaseTokenProgram = baseMintInfo.owner;
    const quoteTokenProgram = TOKEN_PROGRAM_ID;

    const userQuoteTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      this.botKeypair.publicKey,
      false,
      quoteTokenProgram
    );

    // Wrap SOL account for receiving
    transaction.add(
      createAssociatedTokenAccountIdempotentInstruction(
        this.botKeypair.publicKey,
        userQuoteTokenAccount,
        this.botKeypair.publicKey,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    const protocolFeeRecipients = globalConfig.protocolFeeRecipients;
    const protocolFeeRecipient = protocolFeeRecipients[
      Math.floor(Math.random() * protocolFeeRecipients.length)
    ];

    const protocolFeeRecipientTokenAccount = getAssociatedTokenAddressSync(
      quoteMint,
      protocolFeeRecipient,
      true,
      quoteTokenProgram
    );

    const coinCreatorVaultAuthority = coinCreatorVaultAuthorityPda(pool.coinCreator);
    const coinCreatorVaultAta = coinCreatorVaultAtaPda(
      coinCreatorVaultAuthority,
      quoteMint,
      quoteTokenProgram
    );

    const sellIx = await this.program.methods
      .sell(tokenBalance, minQuote)
      .accounts({
        pool: poolPubkey,
        globalConfig: GLOBAL_CONFIG_PDA,
        user: this.botKeypair.publicKey,
        baseMint,
        quoteMint,
        userBaseTokenAccount,
        userQuoteTokenAccount,
        poolBaseTokenAccount,
        poolQuoteTokenAccount,
        protocolFeeRecipient,
        protocolFeeRecipientTokenAccount,
        baseTokenProgram: actualBaseTokenProgram,
        quoteTokenProgram,
        systemProgram: SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        eventAuthority: PUMP_AMM_EVENT_AUTHORITY_PDA,
        program: PUMP_AMM_PROGRAM_ID,
        coinCreatorVaultAta,
        coinCreatorVaultAuthority
      })
      .instruction();

    transaction.add(sellIx);

    // Unwrap SOL
    transaction.add(
      createCloseAccountInstruction(
        userQuoteTokenAccount,
        this.botKeypair.publicKey,
        this.botKeypair.publicKey,
        undefined,
        TOKEN_PROGRAM_ID
      )
    );

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
        mint: baseMint.toBase58(),
        pool: poolPubkey.toBase58(),
        amount: `${tokenBalance.toString()} tokens`
      },
      timing
    };
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