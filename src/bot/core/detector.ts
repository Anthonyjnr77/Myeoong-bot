import { 
  subscribe, 
  CommitmentLevel, 
  LaserstreamConfig, 
  SubscribeRequest,
  SubscribeUpdate
} from 'helius-laserstream';
import { appConfig, PUMP_FUN_CONSTANTS } from '../../config/config';
import bs58 from 'bs58';

export interface DetectedTransaction {
  signature: string;
  accountKeys: string[];
  instructions: any[];
  meta: any;
  slot: number;
  timestamp: number;
}

export class PumpFunDetector {
  private stream: any = null;
  private isRunning = false;
  private transactionCallback: ((transaction: DetectedTransaction) => void) | null = null;

  // Set callback for when transactions are detected
  onTransaction(callback: (transaction: DetectedTransaction) => void): void {
    this.transactionCallback = callback;
  }

  // Start monitoring transactions using SDK
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log("Detector already running");
      return;
    }

    console.log(`🎯 Starting detector in ${appConfig.mode} mode`);
    console.log(`📡 Watching ${appConfig.trading.watchWallets.length} wallets for pump.fun transactions`);
    
    // Log watchlist (truncated for security)
    appConfig.trading.watchWallets.forEach((wallet, index) => {
      console.log(`   ${index + 1}. ${wallet.substring(0, 4)}...${wallet.slice(-4)}`);
    });

    this.isRunning = true;

    try {
      // SDK configuration
      const config: LaserstreamConfig = {
        apiKey: appConfig.laserstream.apiKey,
        endpoint: appConfig.laserstream.endpoint,
      };

      // Create subscription request using proven filtering logic
      const subscriptionRequest: SubscribeRequest = {
        transactions: {
          pumpFun: {
            // Include transactions from our watchlist wallets
            accountInclude: appConfig.trading.watchWallets,
            accountExclude: [],
            // Require pump.fun program only (fee account not used on devnet)
            accountRequired: [PUMP_FUN_CONSTANTS.PROGRAM_ID],
            vote: false,
            failed: false // Only successful transactions
          }
        },
        commitment: CommitmentLevel.PROCESSED, // Use PROCESSED for ~400ms faster detection
        accounts: {},
        slots: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
      };

      console.log("🔌 Connecting to Laserstream with SDK...");
      const connectionStartTime = Date.now();

      // Use SDK's subscribe function with proper types and async handler
      this.stream = await subscribe(
        config,
        subscriptionRequest,
        async (update: SubscribeUpdate) => this.handleIncomingData(update, connectionStartTime),
        (error: any) => console.error("Stream error:", error)
      );

      console.log("✅ Connected to Laserstream successfully");
      console.log("🎧 Listening for pump.fun transactions...");

    } catch (error) {
      console.error("❌ Failed to start detector:", error);
      this.isRunning = false;
      throw error;
    }
  }

  // Stop monitoring
  stop(): void {
    console.log("🛑 Stopping detector...");
    this.isRunning = false;
    
    if (this.stream && typeof this.stream.cancel === 'function') {
      this.stream.cancel();
      this.stream = null;
    }
  }

  // Handle incoming transaction data using Helius docs approach
  private handleIncomingData(update: SubscribeUpdate, connectionStartTime: number): void {
    try {
      // Use correct nesting from Helius docs
      const transaction = update.transaction.transaction.transaction; // The signed message
      const meta = update.transaction.transaction.meta; // Execution metadata
      const message = transaction?.message;

      if (!transaction || !message || meta?.err) {
        return;
      }

      // Convert all binary data to human-readable format (from Helius docs)
      const decodedTransaction = this.convertBuffers(transaction);
      const decodedMeta = this.convertBuffers(meta);

      // Extract signature from top level
      const signature = bs58.encode(update.transaction.transaction.signature);

      // Extract instructions including inner instructions (critical for pump.fun)
      const innerInstructions = meta?.innerInstructions;
      const flattenedInnerInstructions = 
        innerInstructions?.flatMap((ix: any) => ix.instructions || []) || [];
      
      const allInstructions = [
        ...message.instructions,
        ...flattenedInnerInstructions,
      ];

      // Create standardized transaction object with decoded data
      const detectedTransaction: DetectedTransaction = {
        signature,
        accountKeys: decodedTransaction.message.accountKeys, // Now properly decoded
        instructions: allInstructions,
        meta: decodedMeta,
        slot: update.transaction.slot,
        timestamp: Date.now()
      };

      // Calculate detection latency for performance monitoring
      const detectionLatency = Date.now() - connectionStartTime;
      
      console.log(`Transaction detected: ${signature.substring(0, 8)}... (${detectionLatency}ms)`);

      // Forward to parser via callback
      if (this.transactionCallback) {
        this.transactionCallback(detectedTransaction);
      }

    } catch (error) {
      console.error("Error processing transaction data:", error);
    }
  }

  // Recursive buffer conversion function (from Helius docs)
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