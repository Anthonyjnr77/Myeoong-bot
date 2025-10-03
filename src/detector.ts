// src/detector.ts
import {
  subscribe,
  CommitmentLevel,
  LaserstreamConfig,
  SubscribeRequest,
  SubscribeUpdate
} from 'helius-laserstream';
import { appConfig, PUMP_FUN_CONSTANTS, PUMP_SWAP_CONSTANTS } from './config/config';
import bs58 from 'bs58';
import { logError } from './utils/errors';

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
  watchedWallets: string[]; // Wallets being monitored for this transaction
}

export class Detector {
  private stream: any = null;
  private isRunning = false;
  private transactionCallback: ((transaction: DetectedTransaction) => void) | null = null;
  private watchedWallets: string[] = [];
  private seenSignatures: Set<string> = new Set();
  private readonly MAX_SIGNATURES = 1000;

  onTransaction(callback: (transaction: DetectedTransaction) => void): void {
    this.transactionCallback = callback;
  }

  clearTransactionHandler(): void {
    this.transactionCallback = null;
  }

  async start(overrideWallets?: string[]): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    try {
      const config: LaserstreamConfig = {
        apiKey: appConfig.laserstream.apiKey,
        endpoint: appConfig.laserstream.endpoint,
      };

      // Use override wallets if provided, otherwise use config
      const walletsToWatch = overrideWallets || appConfig.trading.watchWallets;
      this.watchedWallets = walletsToWatch;

      console.log(`Starting unified detector`);
      console.log(`Watching wallets: ${walletsToWatch.join(', ')}`);
      console.log(`pump.fun enabled: ${appConfig.trading.protocols.pumpFun.enabled}`);
      console.log(`PumpSwap enabled: ${appConfig.trading.protocols.pumpSwap.enabled}`);

      // Build subscription with separate keys for each protocol
      const transactions: any = {};

      if (appConfig.trading.protocols.pumpFun.enabled) {
        transactions.pumpFun = {
          accountInclude: walletsToWatch,
          accountExclude: [],
          accountRequired: [PUMP_FUN_CONSTANTS.PROGRAM_ID],
          vote: false,
          failed: false
        };
      }

      if (appConfig.trading.protocols.pumpSwap.enabled) {
        transactions.pumpSwap = {
          accountInclude: walletsToWatch,
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
      console.log('─'.repeat(60));
      console.log();

    } catch (error) {
      console.error("Failed to start detector:", error);
      this.isRunning = false;
      throw error;
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

      // Safety: duplicate detection
      if (this.seenSignatures.has(signature)) {
        return; // Skip silently - expected from Laserstream replay
      }

      this.seenSignatures.add(signature);

      // Safety: memory management
      if (this.seenSignatures.size > this.MAX_SIGNATURES) {
        const signaturesArray = Array.from(this.seenSignatures);
        const recentSignatures = signaturesArray.slice(-this.MAX_SIGNATURES);
        this.seenSignatures = new Set(recentSignatures);
      }

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
        protocol,
        watchedWallets: this.watchedWallets
      };

      if (this.transactionCallback) {
        this.transactionCallback(detectedTransaction);
      }

    } catch (error) {
      logError('Detector', 'Handle data exception', error);
      return;
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

  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.stream) {
      try {
        this.stream.close();
      } catch (error) {
        // Ignore close errors
      }
      this.stream = null;
    }

    this.transactionCallback = null;
  }
}