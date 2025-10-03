import path from 'path';

export const POOL_CACHE_FILE = path.join(__dirname, '../../data/pumpswap-pool.json');

// Transaction parameters
export const SLIPPAGE_BPS = 500n;
export const GAS_UNIT_LIMIT = 300_000;
export const GAS_UNIT_PRICE = 250_000;
export const PUMPSWAP_SLIPPAGE = 10;

// Timeouts (milliseconds)
export const TIMEOUTS = {
  DETECTION_MS: 15_000,
  CONFIRMATION_MS: 30_000,
  SLOT_FETCH_MS: 60_000,
} as const;

// Trade amounts
export const AMOUNTS = {
  PUMP_FUN_BUY_SOL: 0.005,
  PUMP_FUN_CREATE_SOL: 0.0001,
  PUMP_SWAP_BUY_SOL: 0.002,
  SELL_PERCENTAGE: 0.5,
} as const;

// Pool limits
export const POOL_LIMITS = {
  MIN_SOL: 20,
  MAX_SOL: 100,
  CACHE_MAX_AGE_MS: 24 * 60 * 60 * 1000,
} as const;

// Test defaults
export const DEFAULTS = {
  NUM_CYCLES: 5,
  NUM_OPERATIONS: 20,
  SDK_OPERATIONS: 10,
} as const;
