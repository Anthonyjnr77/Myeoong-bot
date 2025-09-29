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
}

export class TransactionBuilder {
  private connection: Connection;
  private provider: AnchorProvider;
  private sdk: PumpFunSDK;
  private botKeypair: Keypair;

  constructor() {
    console.log('Initializing TransactionBuilder...');
    
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

    const botPubkey = this.botKeypair.publicKey.toBase58();
    console.log(`Builder initialized with bot wallet: ${botPubkey.substring(0, 8)}...${botPubkey.slice(-4)}`);
  }

  async buildTransaction(parsedTrade: ParsedTrade): Promise<BuildResult> {
    const buildTimestamp = Date.now();

    try {
      console.log(`\n=== Building Copy Trade Transaction ===`);
      console.log(`Source trade details:`);
      console.log(`  Type: ${parsedTrade.type}`);
      console.log(`  Mint: ${parsedTrade.mint}`);
      console.log(`  Source User: ${parsedTrade.user.substring(0, 8)}...${parsedTrade.user.slice(-4)}`);
      console.log(`  Source Amount: ${TRADING_UTILS.formatAmount(parsedTrade.solAmount)}`);
      
      console.log(`\nCopy trade configuration:`);
      console.log(`  Bot Wallet: ${this.botKeypair.publicKey.toBase58().substring(0, 8)}...${this.botKeypair.publicKey.toBase58().slice(-4)}`);
      console.log(`  Copy Amount: ${appConfig.trading.copyAmountSol} SOL (from config)`);
      console.log(`  Slippage: ${appConfig.trading.slippageBps} bps`);

      if (parsedTrade.type !== 'BUY') {
        console.log(`Skipping ${parsedTrade.type} - only BUY supported in MVP`);
        return {
          success: false,
          error: 'Only BUY trades supported in MVP',
          buildTimestamp
        };
      }

      const mintPubkey = new PublicKey(parsedTrade.mint);
      
      console.log(`Validating bonding curve exists for mint...`);
      const bondingCurve = await this.sdk.token.getBondingCurveAccount(
        mintPubkey, 
        appConfig.rpc.commitment
      );
      
      if (!bondingCurve) {
        console.error(`Bonding curve not found for mint ${parsedTrade.mint}`);
        console.error(`Token may have graduated to Raydium or doesn't exist`);
        return {
          success: false,
          error: 'Bonding curve not found - token may have graduated',
          buildTimestamp
        };
      }

      console.log(`Bonding curve validated successfully`);

      const buyAmountLamports = BigInt(
        TRADING_UTILS.solToLamports(appConfig.trading.copyAmountSol)
      );

      console.log(`Building buy instruction...`);
      console.log(`  Amount: ${buyAmountLamports} lamports (${appConfig.trading.copyAmountSol} SOL)`);
      console.log(`  Slippage tolerance: ${appConfig.trading.slippageBps} bps`);

      const transaction = await this.sdk.trade.getBuyInstructionsBySolAmount(
        this.botKeypair.publicKey,
        mintPubkey,
        buyAmountLamports,
        BigInt(appConfig.trading.slippageBps),
        appConfig.rpc.commitment
      );

      const buildDuration = Date.now() - buildTimestamp;
      
      console.log(`\nTransaction built successfully!`);
      console.log(`  Build time: ${buildDuration}ms`);
      console.log(`  Instructions: ${transaction.instructions.length}`);
      console.log(`  Fee payer: ${transaction.feePayer?.toBase58().substring(0, 8)}...`);

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
      console.error(`\nTransaction build failed:`, error);
      
      if (error instanceof Error) {
        console.error(`  Error message: ${error.message}`);
        console.error(`  Error stack: ${error.stack}`);
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        buildTimestamp
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