// src/detector.ts
import { Connection, PublicKey } from '@solana/web3.js';
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
  private connection: Connection;
  private logSubscriptions: number[] = [];
  private isRunning = false;
  private transactionCallback: ((transaction: DetectedTransaction) => void) | null = null;
  private watchedWallets: string[] = [];
  private seenSignatures: Set<string> = new Set();
  private readonly MAX_SIGNATURES = 1000;

  constructor() {
    this.connection = new Connection(appConfig.rpc.endpoint, {
      commitment: appConfig.rpc.commitment
    });
  }

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
      // Use override wallets if provided, otherwise use config
      const walletsToWatch = overrideWallets || appConfig.trading.watchWallets;
      this.watchedWallets = walletsToWatch;

      if (process.env.NODE_ENV !== 'test') {
        console.log(`Starting detector`);
        console.log(`Watching wallets: ${walletsToWatch.join(', ')}`);
        console.log(`pump.fun enabled: ${appConfig.trading.protocols.pumpFun.enabled}`);
        console.log(`PumpSwap enabled: ${appConfig.trading.protocols.pumpSwap.enabled}`);
      }

      if (!appConfig.trading.protocols.pumpFun.enabled && !appConfig.trading.protocols.pumpSwap.enabled) {
        throw new Error('No protocols enabled - cannot start detector');
      }

      for (const wallet of walletsToWatch) {
        const subscriptionId = await this.connection.onLogs(
          new PublicKey(wallet),
          (logs) => {
            if (!logs.err) {
              void this.handleSignature(logs.signature);
            }
          },
          appConfig.rpc.commitment
        );
        this.logSubscriptions.push(subscriptionId);
      }

      if (process.env.NODE_ENV !== 'test') {
        console.log('RPC WebSocket subscribed successfully');
        console.log('─'.repeat(60));
        console.log();
      }

    } catch (error) {
      console.error("Failed to start detector:", error);
      this.isRunning = false;
      throw error;
    }
  }

  private async handleSignature(signature: string): Promise<void> {
    const receivedTimestamp = Date.now();

    if (this.seenSignatures.has(signature)) {
      return;
    }

    try {
      const transaction = await this.connection.getTransaction(signature, {
        commitment: appConfig.rpc.commitment,
        maxSupportedTransactionVersion: 0
      });

      if (!transaction || transaction.meta?.err) {
        return;
      }

      const accountKeys = transaction.transaction.message.accountKeys.map(key => key.toBase58());
      const instructions = transaction.transaction.message.instructions.map(instruction => ({
        programIdIndex: instruction.programIdIndex,
        accounts: Array.from(instruction.accounts),
        data: bs58.decode(instruction.data)
      }));
      const innerInstructions = transaction.meta.innerInstructions?.flatMap(group =>
        group.instructions.map(instruction => ({
          programIdIndex: instruction.programIdIndex,
          accounts: Array.from(instruction.accounts),
          data: bs58.decode(instruction.data)
        }))
      ) || [];

      this.seenSignatures.add(signature);
      if (this.seenSignatures.size > this.MAX_SIGNATURES) {
        const signatures = Array.from(this.seenSignatures);
        this.seenSignatures = new Set(signatures.slice(-this.MAX_SIGNATURES));
      }

      const allInstructions = [...instructions, ...innerInstructions];
      const processedTimestamp = Date.now();
      const detectedTransaction: DetectedTransaction = {
        signature,
        accountKeys,
        instructions: allInstructions,
        meta: transaction.meta,
        slot: transaction.slot,
        timestamp: (transaction.blockTime || Math.floor(Date.now() / 1000)) * 1000,
        receivedTimestamp,
        processedTimestamp,
        protocol: this.identifyProtocol(accountKeys, allInstructions),
        watchedWallets: this.watchedWallets
      };

      if (this.transactionCallback) {
        this.transactionCallback(detectedTransaction);
      }
    } catch (error) {
      logError('Detector', 'Handle transaction exception', error);
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

    for (const subscriptionId of this.logSubscriptions) {
      void this.connection.removeOnLogsListener(subscriptionId).catch(() => {
        // Ignore listener cleanup errors during shutdown.
      });
    }
    this.logSubscriptions = [];

    this.transactionCallback = null;
  }
}