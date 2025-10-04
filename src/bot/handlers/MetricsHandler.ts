// src/bot/handlers/MetricsHandler.ts
import { Metrics } from '../../utils/metrics';
import { BotEvent, BotEventHandler } from '../types';

export class MetricsHandler implements BotEventHandler {
  private metrics: Metrics;

  constructor(metrics: Metrics) {
    this.metrics = metrics;
  }

  handle(event: BotEvent): void {
    switch (event.type) {
      case 'detected':
        this.handleDetected(event);
        break;
      case 'filtered':
        this.handleFiltered(event);
        break;
      case 'executionSuccess':
        this.handleExecutionSuccess(event);
        break;
      case 'buildFailed':
      case 'executionFailed':
        this.handleFailure(event);
        break;
    }
  }

  private handleDetected(event: any): void {
    const { protocol } = event;
    this.metrics.recordDetection(protocol);
  }

  private handleFiltered(event: any): void {
    this.metrics.recordFiltered();
  }

  private handleExecutionSuccess(event: any): void {
    const { parsed, buildTime, execTime } = event;
    const protocol = parsed.protocol === 'PUMP_FUN' ? 'pumpfun' : 'pumpswap';

    this.metrics.recordSuccess(protocol, buildTime, execTime);
  }

  private handleFailure(event: any): void {
    const { parsed, error } = event;
    const protocol = parsed.protocol === 'PUMP_FUN' ? 'pumpfun' : 'pumpswap';

    this.metrics.recordFailure(protocol, error);
  }
}
