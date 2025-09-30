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
  timing?: {
    computeBudget: number;
    blockhashFetch: number;
    signing: number;
    serialization: number;
    submission: number;
    total: number;
  };
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
    this.connection = new Connection(appConfig.rpc.endpoint, {
      commitment: appConfig.rpc.commitment
    });

    this.pendingConfirmations = new Map();
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
      if (appConfig.mode === 'simulate') {
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

      const signStart = Date.now();
      transaction.sign(signer);
      latency.signing = Date.now() - signStart;

      const submitStart = Date.now();
      const rawTransaction = transaction.serialize();
      const signature = await this.connection.sendRawTransaction(rawTransaction, {
        skipPreflight: options.skipPreflight ?? true,
        maxRetries: options.maxRetries ?? 3,
      });
      latency.submission = Date.now() - submitStart;

      latency.total = Date.now() - executionTimestamp;

      const confirmationPromise = this.pollForConfirmation(signature);
      this.pendingConfirmations.set(signature, confirmationPromise);
      
      confirmationPromise.then(confirmed => {
        this.pendingConfirmations.delete(signature);
      }).catch(() => {
        this.pendingConfirmations.delete(signature);
      });

      return {
        success: true,
        signature,
        latency,
        executionTimestamp,
      };

    } catch (error) {
      latency.total = Date.now() - executionTimestamp;

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown execution error',
        latency,
        executionTimestamp,
      };
    }
  }

  async executeTransactionWithTiming(
    transaction: Transaction,
    signer: Keypair,
    options: ExecutionOptions = DEFAULT_OPTIONS
  ): Promise<ExecutionResult> {
    const executionTimestamp = Date.now();
    const timing = {
      computeBudget: 0,
      blockhashFetch: 0,
      signing: 0,
      serialization: 0,
      submission: 0,
      total: 0,
    };

    try {
      if (appConfig.mode === 'simulate') {
        return {
          success: true,
          signature: 'SIMULATED_' + Date.now(),
          latency: { preparation: 0, signing: 0, submission: 0, total: 0 },
          executionTimestamp,
          timing
        };
      }

      const t1 = Date.now();
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
      timing.computeBudget = Date.now() - t1;

      const t2 = Date.now();
      const { blockhash } = await this.connection.getLatestBlockhash(
        appConfig.rpc.commitment
      );
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = signer.publicKey;
      timing.blockhashFetch = Date.now() - t2;

      const t3 = Date.now();
      transaction.sign(signer);
      timing.signing = Date.now() - t3;

      const t4 = Date.now();
      const rawTransaction = transaction.serialize();
      timing.serialization = Date.now() - t4;

      const t5 = Date.now();
      const signature = await this.connection.sendRawTransaction(rawTransaction, {
        skipPreflight: options.skipPreflight ?? true,
        maxRetries: options.maxRetries ?? 3,
      });
      timing.submission = Date.now() - t5;

      timing.total = Date.now() - executionTimestamp;

      const confirmationPromise = this.pollForConfirmation(signature);
      this.pendingConfirmations.set(signature, confirmationPromise);
      
      confirmationPromise.then(() => {
        this.pendingConfirmations.delete(signature);
      }).catch(() => {
        this.pendingConfirmations.delete(signature);
      });

      return {
        success: true,
        signature,
        latency: {
          preparation: timing.computeBudget + timing.blockhashFetch,
          signing: timing.signing,
          submission: timing.submission,
          total: timing.total,
        },
        executionTimestamp,
        timing
      };

    } catch (error) {
      timing.total = Date.now() - executionTimestamp;
      
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown execution error',
        latency: {
          preparation: 0,
          signing: 0,
          submission: 0,
          total: timing.total,
        },
        executionTimestamp,
        timing
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
          return false;
        }
        
        if (response.value.confirmationStatus === 'confirmed' || 
            response.value.confirmationStatus === 'finalized') {
          return true;
        }
        
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    }
    
    return false;
  }
}