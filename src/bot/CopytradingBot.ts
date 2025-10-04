// src/bot/CopytradingBot.ts
import { Detector, DetectedTransaction } from '../detector';
import { TradeParser } from '../parser';
import { PumpFunTxBuilder } from '../pumpfun-tx';
import { PumpSwapTxBuilder } from '../pumpswap-tx';
import { TransactionExecutor } from '../executor';
import {
  BotConfig,
  BotEvent,
  BotEventHandler,
  DetectedEvent,
  FilteredEvent,
  BuildSuccessEvent,
  BuildFailedEvent,
  ExecutionSuccessEvent,
  ExecutionFailedEvent
} from './types';

export class CopytradingBot {
  private config: BotConfig;
  private detector: Detector;
  private parser: TradeParser;
  private pumpFunBuilder: PumpFunTxBuilder;
  private pumpSwapBuilder: PumpSwapTxBuilder;
  private executor: TransactionExecutor;
  private handlers: BotEventHandler[] = [];
  private inflightTrades: number = 0;
  private isRunning: boolean = false;

  constructor(config: BotConfig) {
    this.config = config;
    this.detector = new Detector();
    this.parser = new TradeParser();
    this.pumpFunBuilder = new PumpFunTxBuilder();
    this.pumpSwapBuilder = new PumpSwapTxBuilder();
    this.executor = new TransactionExecutor();
  }

  // Event handler management
  addHandler(handler: BotEventHandler): void {
    this.handlers.push(handler);
  }

  removeHandler(handler: BotEventHandler): void {
    const index = this.handlers.indexOf(handler);
    if (index !== -1) {
      this.handlers.splice(index, 1);
    }
  }

  private emit(event: BotEvent): void {
    for (const handler of this.handlers) {
      try {
        handler.handle(event);
      } catch (error) {
        // Silently ignore handler errors to prevent one handler from breaking others
      }
    }
  }

  // Initialize the bot
  async initialize(): Promise<void> {
    await this.pumpFunBuilder.initialize();
  }

  // Start the bot
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;

    // Set up transaction handler
    this.detector.onTransaction((tx) => this.processTrade(tx));

    // Start detector
    await this.detector.start(this.config.watchWallets);
  }

  // Stop the bot
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.detector.stop();

    // Wait for inflight trades (max 5s)
    let waitTime = 0;
    while (this.inflightTrades > 0 && waitTime < 5000) {
      await new Promise(r => setTimeout(r, 100));
      waitTime += 100;
    }

    // Cleanup builders
    this.pumpFunBuilder.cleanup();
    if (typeof (this.pumpSwapBuilder as any).cleanup === 'function') {
      (this.pumpSwapBuilder as any).cleanup();
    }
  }

  // Get inflight trades count
  getInflightTrades(): number {
    return this.inflightTrades;
  }

  // Core trade processing logic (extracted from index.ts lines ~140-220)
  private async processTrade(tx: DetectedTransaction): Promise<void> {
    this.inflightTrades++;

    try {
      // Measure detection time
      const detectionTime = tx.processedTimestamp - tx.receivedTimestamp;

      // Parse
      const parseStart = Date.now();
      const parseResult = this.parser.parse(tx);
      const parsingTime = Date.now() - parseStart;

      if (!parseResult.success) {
        if ('filtered' in parseResult && parseResult.filtered) {
          // Emit filtered event
          this.emit({
            type: 'filtered',
            reason: parseResult.reason
          } as FilteredEvent);
        } else if ('error' in parseResult && parseResult.error) {
          // Parse error - emit build failed with timing
          this.emit({
            type: 'buildFailed',
            parsed: {
              protocol: tx.protocol,
              type: 'BUY',
              mint: '',
              user: '',
              tokenAmount: 0,
              solAmount: 0,
              signature: tx.signature,
              slot: tx.slot,
              timestamp: tx.timestamp
            },
            error: parseResult.error,
            detectionTime,
            parsingTime
          } as BuildFailedEvent);
        }
        return;
      }

      const parsed = parseResult.data!;

      // Record detection
      const protocol = parsed.protocol === 'PUMP_FUN' ? 'pumpfun' : 'pumpswap';

      // Emit detected event with timing
      this.emit({
        type: 'detected',
        transaction: tx,
        parsed,
        protocol,
        detectionTime
      } as DetectedEvent);

      // Route to correct builder
      const builder = parsed.protocol === 'PUMP_FUN' ? this.pumpFunBuilder : this.pumpSwapBuilder;

      // Build transaction
      const buildStart = Date.now();
      const buildResult = await builder.buildTransactionWithTiming(parsed);
      const buildTime = Date.now() - buildStart;

      if (!buildResult.success) {
        this.emit({
          type: 'buildFailed',
          parsed,
          error: buildResult.error || 'Build failed',
          detectionTime,
          parsingTime
        } as BuildFailedEvent);
        return;
      }

      // Emit build success with all timing
      this.emit({
        type: 'buildSuccess',
        parsed,
        buildTime,
        detectionTime,
        parsingTime
      } as BuildSuccessEvent);

      // SIMULATE MODE
      if (this.config.mode === 'simulate') {
        // In simulate mode, treat as execution success
        this.emit({
          type: 'executionSuccess',
          parsed,
          detectionTime,
          parsingTime,
          buildTime,
          execTime: 0,
          signature: 'SIMULATED_' + Date.now()
        } as ExecutionSuccessEvent);
        return;
      }

      // LIVE MODE - Execute
      const execStart = Date.now();
      const execResult = await this.executor.executeTransactionWithTiming(
        buildResult.transaction!,
        builder.getBotKeypair(),
        { blockhash: buildResult.blockhash }
      );
      const execTime = Date.now() - execStart;

      if (execResult.success) {
        this.emit({
          type: 'executionSuccess',
          parsed,
          detectionTime,
          parsingTime,
          buildTime,
          execTime,
          signature: execResult.signature!
        } as ExecutionSuccessEvent);
      } else {
        this.emit({
          type: 'executionFailed',
          parsed,
          error: execResult.error || 'Execution failed',
          detectionTime,
          parsingTime,
          buildTime
        } as ExecutionFailedEvent);
      }

    } finally {
      this.inflightTrades--;
    }
  }
}
