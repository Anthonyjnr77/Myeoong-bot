// src/bot/core/executor.ts
import {
  Connection,
  Keypair,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { appConfig } from '../../config/config';

export interface ExecutionResult {
  success: boolean;
  signature?: string;
  error?: string;
  latency: {
    preparation: number;
    signing: number;
    submission: number;
    total: number;
  };
  executionTimestamp: number;
}

export interface ExecutionOptions {
  skipPreflight?: boolean;
  maxRetries?: number;
}

const DEFAULT_OPTIONS: ExecutionOptions = {
  skipPreflight: true,
  maxRetries: 3,
};

export class TransactionExecutor {
  private connection: Connection;
  private pendingConfirmations: Map<string, Promise<boolean>>;

  constructor() {
    console.log('Initializing TransactionExecutor...');
    
    this.connection = new Connection(appConfig.rpc.endpoint, {
      commitment: appConfig.rpc.commitment
    });

    this.pendingConfirmations = new Map();

    console.log(`Executor initialized with RPC: ${appConfig.rpc.endpoint}`);
    console.log(`  Commitment: ${appConfig.rpc.commitment}`);
  }

  async executeTransaction(
    transaction: Transaction,
    signer: Keypair,
    options: ExecutionOptions = DEFAULT_OPTIONS
  ): Promise<ExecutionResult> {
    const executionTimestamp = Date.now();
    const latency = {
      preparation: 0,
      signing: 0,
      submission: 0,
      total: 0,
    };

    try {
      console.log(`\n=== Executing Transaction ===`);
      console.log(`Mode: ${appConfig.mode}`);
      console.log(`Signer: ${signer.publicKey.toBase58().substring(0, 8)}...`);

      if (appConfig.mode === 'simulate') {
        console.log(`SIMULATE MODE - Transaction not submitted`);
        console.log(`  Instructions: ${transaction.instructions.length}`);
        
        return {
          success: true,
          signature: 'SIMULATED_' + Date.now(),
          latency: {
            preparation: 0,
            signing: 0,
            submission: 0,
            total: 0,
          },
          executionTimestamp,
        };
      }

      // STEP 1: Preparation
      const prepStart = Date.now();
      
      const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({
        units: appConfig.trading.priorityFee.unitLimit,
      });
      
      const computePriceIx = ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: appConfig.trading.priorityFee.unitPrice,
      });

      transaction.instructions = [
        computeBudgetIx,
        computePriceIx,
        ...transaction.instructions,
      ];

      const { blockhash } = await this.connection.getLatestBlockhash(
        appConfig.rpc.commitment
      );
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = signer.publicKey;

      latency.preparation = Date.now() - prepStart;
      console.log(`Preparation complete: ${latency.preparation}ms`);

      // STEP 2: Sign
      const signStart = Date.now();
      transaction.sign(signer);
      latency.signing = Date.now() - signStart;
      console.log(`Transaction signed: ${latency.signing}ms`);

      // STEP 3: Submit
      const submitStart = Date.now();
      const rawTransaction = transaction.serialize();
      const signature = await this.connection.sendRawTransaction(rawTransaction, {
        skipPreflight: options.skipPreflight ?? true,
        maxRetries: options.maxRetries ?? 3,
      });
      latency.submission = Date.now() - submitStart;
      
      console.log(`Transaction submitted: ${latency.submission}ms`);
      console.log(`  Signature: ${signature}`);
      console.log(`  Explorer: https://solscan.io/tx/${signature}?cluster=devnet`);

      latency.total = Date.now() - executionTimestamp;

      // Start background confirmation polling (non-blocking)
      const confirmationPromise = this.pollForConfirmation(signature);
      this.pendingConfirmations.set(signature, confirmationPromise);
      
      confirmationPromise.then(confirmed => {
        const status = confirmed ? '✅ confirmed' : '❌ failed/timeout';
        console.log(`Background: ${signature.substring(0, 8)}... ${status}`);
        this.pendingConfirmations.delete(signature);
      }).catch(error => {
        console.error(`Background confirmation error: ${error.message}`);
        this.pendingConfirmations.delete(signature);
      });

      console.log(`\nExecution complete!`);
      console.log(`  Total latency: ${latency.total}ms`);
      console.log(`  Breakdown: prep=${latency.preparation}ms, sign=${latency.signing}ms, submit=${latency.submission}ms`);

      return {
        success: true,
        signature,
        latency,
        executionTimestamp,
      };

    } catch (error) {
      latency.total = Date.now() - executionTimestamp;
      
      console.error(`\nExecution failed:`, error);
      
      if (error instanceof Error) {
        console.error(`  Error message: ${error.message}`);
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown execution error',
        latency,
        executionTimestamp,
      };
    }
  }

  private async pollForConfirmation(
    signature: string,
    timeoutMs: number = 30000,
    pollIntervalMs: number = 1000
  ): Promise<boolean> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await this.connection.getSignatureStatus(signature);
        
        if (!response || !response.value) {
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          continue;
        }

        if (response.value.err) {
          console.error(`Transaction failed: ${JSON.stringify(response.value.err)}`);
          return false;
        }
        
        if (response.value.confirmationStatus === 'confirmed' || 
            response.value.confirmationStatus === 'finalized') {
          const duration = Date.now() - startTime;
          console.log(`Transaction confirmed after ${duration}ms`);
          return true;
        }
        
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      } catch (error) {
        console.error(`Error polling confirmation:`, error);
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    }
    
    console.warn(`Transaction confirmation timeout after ${timeoutMs}ms`);
    return false;
  }
}