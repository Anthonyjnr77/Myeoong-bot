// src/bot/core/detector.ts
import { 
  subscribe, 
  CommitmentLevel, 
  LaserstreamConfig, 
  SubscribeRequest,
  SubscribeUpdate
} from 'helius-laserstream';
import { appConfig, PUMP_FUN_CONSTANTS, PUMP_SWAP_CONSTANTS } from '../../config/config';
import bs58 from 'bs58';

export type Protocol = 'PUMP_FUN' | 'PUMP_SWAP' | 'UNKNOWN';

export interface DetectedTransaction {
  signature: string;
  accountKeys: string[];
  instructions: any[];
  meta: any;
  slot: number;
  timestamp: number;
  receivedTimestamp: number;
  processedTimestamp: number;
  protocol: Protocol;
}

export class Detector {
  private stream: any = null;
  private isRunning = false;
  private transactionCallback: ((transaction: DetectedTransaction) => void) | null = null;

  onTransaction(callback: (transaction: DetectedTransaction) => void): void {
    this.transactionCallback = callback;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const config: LaserstreamConfig = {
        apiKey: appConfig.laserstream.apiKey,
        endpoint: appConfig.laserstream.endpoint,
      };

      console.log(`Starting unified detector`);
      console.log(`Watching wallets: ${appConfig.trading.watchWallets.join(', ')}`);
      console.log(`pump.fun enabled: ${appConfig.trading.protocols.pumpFun.enabled}`);
      console.log(`PumpSwap enabled: ${appConfig.trading.protocols.pumpSwap.enabled}`);

      // Build subscription with separate keys for each protocol
      const transactions: any = {};

      if (appConfig.trading.protocols.pumpFun.enabled) {
        transactions.pumpFun = {
          accountInclude: appConfig.trading.watchWallets,
          accountExclude: [],
          accountRequired: [PUMP_FUN_CONSTANTS.PROGRAM_ID],
          vote: false,
          failed: false
        };
      }

      if (appConfig.trading.protocols.pumpSwap.enabled) {
        transactions.pumpSwap = {
          accountInclude: appConfig.trading.watchWallets,
          accountExclude: [],
          accountRequired: [PUMP_SWAP_CONSTANTS.PROGRAM_ID],
          vote: false,
          failed: false
        };
      }

      if (Object.keys(transactions).length === 0) {
        throw new Error('No protocols enabled - cannot start detector');
      }

      const subscriptionRequest: SubscribeRequest = {
        transactions,
        commitment: CommitmentLevel.PROCESSED,
        accounts: {},
        slots: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
      };

      this.stream = await subscribe(
        config,
        subscriptionRequest,
        async (update: SubscribeUpdate) => this.handleIncomingData(update),
        (error: any) => console.error("Stream error:", error)
      );

      console.log('Stream subscribed successfully');

    } catch (error) {
      console.error("Failed to start detector:", error);
      this.isRunning = false;
      throw error;
    }
  }

  stop(): void {
    this.isRunning = false;
    
    if (this.stream && typeof this.stream.cancel === 'function') {
      this.stream.cancel();
      this.stream = null;
    }
  }

  private identifyProtocol(accountKeys: string[], instructions: any[]): Protocol {
    // Check which program IDs are present in the transaction
    const hasPumpFun = instructions.some(ix => {
      if (ix.programIdIndex === undefined) return false;
      return accountKeys[ix.programIdIndex] === PUMP_FUN_CONSTANTS.PROGRAM_ID;
    });

    const hasPumpSwap = instructions.some(ix => {
      if (ix.programIdIndex === undefined) return false;
      return accountKeys[ix.programIdIndex] === PUMP_SWAP_CONSTANTS.PROGRAM_ID;
    });

    // Prioritize pump.fun if both are present (edge case)
    if (hasPumpFun) return 'PUMP_FUN';
    if (hasPumpSwap) return 'PUMP_SWAP';
    return 'UNKNOWN';
  }

  private handleIncomingData(update: SubscribeUpdate): void {
    const receivedTimestamp = Date.now();
    
    try {
      const transaction = update.transaction.transaction.transaction;
      const meta = update.transaction.transaction.meta;
      const message = transaction?.message;

      if (!transaction || !message || meta?.err) {
        return;
      }

      const decodedTransaction = this.convertBuffers(transaction);
      const decodedMeta = this.convertBuffers(meta);
      const signature = bs58.encode(update.transaction.transaction.signature);

      const innerInstructions = meta?.innerInstructions;
      const flattenedInnerInstructions = 
        innerInstructions?.flatMap((ix: any) => ix.instructions || []) || [];
      
      const allInstructions = [
        ...message.instructions,
        ...flattenedInnerInstructions,
      ];

      const processedTimestamp = Date.now();

      // Identify which protocol this transaction belongs to
      const protocol = this.identifyProtocol(
        decodedTransaction.message.accountKeys, 
        allInstructions
      );

      const detectedTransaction: DetectedTransaction = {
        signature,
        accountKeys: decodedTransaction.message.accountKeys,
        instructions: allInstructions,
        meta: decodedMeta,
        slot: update.transaction.slot,
        timestamp: Date.now(),
        receivedTimestamp,
        processedTimestamp,
        protocol
      };

      if (this.transactionCallback) {
        this.transactionCallback(detectedTransaction);
      }

    } catch (error) {
      console.error("Error processing transaction data:", error);
    }
  }

  private convertBuffers(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }
    
    if (obj instanceof Uint8Array || Buffer.isBuffer(obj)) {
      return bs58.encode(obj);
    }
    
    if (Array.isArray(obj)) {
      return obj.map(item => this.convertBuffers(item));
    }
    
    if (typeof obj === 'object') {
      const converted: any = {};
      for (const [key, value] of Object.entries(obj)) {
        converted[key] = this.convertBuffers(value);
      }
      return converted;
    }
    
    return obj;
  }
}