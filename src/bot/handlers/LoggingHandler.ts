// src/bot/handlers/LoggingHandler.ts
import { Logger } from '../../utils/logger';
import { BotEvent, BotEventHandler } from '../types';
import { appConfig } from '../../config/config';
import { SELL_PERCENTAGE } from '../../config/config';

export class LoggingHandler implements BotEventHandler {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  handle(event: BotEvent): void {
    switch (event.type) {
      case 'detected':
        this.handleDetected(event);
        break;
      case 'filtered':
        this.handleFiltered(event);
        break;
      case 'buildFailed':
        this.handleBuildFailed(event);
        break;
      case 'executionSuccess':
        this.handleExecutionSuccess(event);
        break;
      case 'executionFailed':
        this.handleExecutionFailed(event);
        break;
    }
  }

  private handleDetected(event: any): void {
    const { parsed, protocol } = event;

    this.logger.trade({
      phase: 'DETECTED',
      protocol,
      type: parsed.type.toLowerCase() as 'buy' | 'sell',
      mint: parsed.mint,
      pool: parsed.pool
    });
  }

  private handleFiltered(event: any): void {
    // Only log filtered trades that are NOT token creations
    if (event.reason !== 'token_creation') {
      this.logger.warn(`Filtered trade (below minimum ${appConfig.trading.minTradeAmountSol} SOL)`);
    }
  }

  private handleBuildFailed(event: any): void {
    const { error } = event;
    this.logger.error(`✗ Build failed: ${error}`);
  }

  private handleExecutionSuccess(event: any): void {
    const { parsed, buildTime, execTime, signature } = event;
    const protocol = parsed.protocol === 'PUMP_FUN' ? 'pumpfun' : 'pumpswap';

    // Determine copy amount based on protocol and trade type
    let copyAmount: number;
    if (parsed.type === 'BUY') {
      copyAmount = protocol === 'pumpfun'
        ? appConfig.trading.protocols.pumpFun.buyAmountSol
        : appConfig.trading.protocols.pumpSwap.buyAmountSol;
    } else {
      copyAmount = SELL_PERCENTAGE * 100; // Sell percentage (e.g., 50 for 50%)
    }

    if (appConfig.mode === 'simulate') {
      this.logger.trade({
        phase: 'SIMULATE',
        protocol,
        type: parsed.type.toLowerCase() as 'buy' | 'sell',
        buildTime,
        copyAmount
      });
    } else {
      this.logger.trade({
        phase: 'SUCCESS',
        protocol,
        type: parsed.type.toLowerCase() as 'buy' | 'sell',
        copyAmount,
        buildTime,
        execTime,
        signature
      });
    }
  }

  private handleExecutionFailed(event: any): void {
    const { error } = event;
    this.logger.error(`✗ Execution failed: ${error}`);
  }
}
