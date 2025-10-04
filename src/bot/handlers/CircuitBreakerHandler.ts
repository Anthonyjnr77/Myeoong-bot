// src/bot/handlers/CircuitBreakerHandler.ts
import { BotEvent, BotEventHandler } from '../types';

export class CircuitBreakerHandler implements BotEventHandler {
  private consecutiveFailures: number = 0;
  private isTripped: boolean = false;
  private maxFailures: number;
  private onTrip: () => void;

  constructor(maxFailures: number = 5, onTrip: () => void) {
    this.maxFailures = maxFailures;
    this.onTrip = onTrip;
  }

  handle(event: BotEvent): void {
    if (this.isTripped) {
      return;
    }

    switch (event.type) {
      case 'executionSuccess':
        // Reset on success
        this.consecutiveFailures = 0;
        break;

      case 'buildFailed':
      case 'executionFailed':
        // Increment on failure
        this.consecutiveFailures++;

        if (this.consecutiveFailures >= this.maxFailures) {
          this.isTripped = true;
          this.onTrip();
        }
        break;
    }
  }
}
