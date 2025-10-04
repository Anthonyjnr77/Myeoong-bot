// src/bot/types.ts
import { DetectedTransaction } from '../detector';
import { ParsedTrade } from '../parser';

// Bot configuration
export interface BotConfig {
  mode: 'simulate' | 'live';
  watchWallets: string[];
}

// Event types
export type BotEventType =
  | 'detected'
  | 'filtered'
  | 'buildSuccess'
  | 'buildFailed'
  | 'executionSuccess'
  | 'executionFailed';

// Event payloads
export interface DetectedEvent {
  type: 'detected';
  transaction: DetectedTransaction;
  parsed: ParsedTrade;
  protocol: 'pumpfun' | 'pumpswap';
  detectionTime: number; // tx.processedTimestamp - tx.receivedTimestamp
}

export interface FilteredEvent {
  type: 'filtered';
  reason?: string;
}

export interface BuildSuccessEvent {
  type: 'buildSuccess';
  parsed: ParsedTrade;
  buildTime: number;
  detectionTime: number;
  parsingTime: number;
}

export interface BuildFailedEvent {
  type: 'buildFailed';
  parsed: ParsedTrade;
  error: string;
  detectionTime: number;
  parsingTime: number;
}

export interface ExecutionSuccessEvent {
  type: 'executionSuccess';
  parsed: ParsedTrade;
  detectionTime: number;
  parsingTime: number;
  buildTime: number;
  execTime: number;
  signature: string;
}

export interface ExecutionFailedEvent {
  type: 'executionFailed';
  parsed: ParsedTrade;
  error: string;
  detectionTime: number;
  parsingTime: number;
  buildTime?: number; // Optional - may fail before build completes
}

export type BotEvent =
  | DetectedEvent
  | FilteredEvent
  | BuildSuccessEvent
  | BuildFailedEvent
  | ExecutionSuccessEvent
  | ExecutionFailedEvent;

// Event handler interface
export interface BotEventHandler {
  handle(event: BotEvent): void | Promise<void>;
}
