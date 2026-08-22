// config/config.ts
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import path from 'path';

// Pump.fun constants
export const PUMP_FUN_CONSTANTS = {
  PROGRAM_ID: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  FEE_ACCOUNT: "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  BUY_DISCRIMINATOR: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  SELL_DISCRIMINATOR: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
  TOKEN_DECIMALS: 6,
  TARGET_ACCOUNTS: {
    BUY: [
      { name: "mint", index: 2 },
      { name: "user", index: 6 },
    ],
    SELL: [
      { name: "mint", index: 2 },
      { name: "user", index: 6 },
    ],
  },
} as const;

// PumpSwap constants
export const PUMP_SWAP_CONSTANTS = {
  PROGRAM_ID: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  FEE_PROGRAM_ID: "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  BUY_DISCRIMINATOR: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  SELL_DISCRIMINATOR: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
  TOKEN_DECIMALS: 6,
  TARGET_ACCOUNTS: {
    BUY: [
      { name: "pool", index: 0 },
      { name: "user", index: 1 },
      { name: "base_mint", index: 3 },
      { name: "quote_mint", index: 4 },
    ],
    SELL: [
      { name: "pool", index: 0 },
      { name: "user", index: 1 },
      { name: "base_mint", index: 3 },
      { name: "quote_mint", index: 4 },
    ],
  },
} as const;

// Test and operational constants
export const SELL_PERCENTAGE = 0.5;
export const GAS_UNIT_LIMIT = 400_000;
export const GAS_UNIT_PRICE = 250_000;
export const PUMP_FUN_CREATE_SOL = 0.0001; // Token creation fee, not configurable
export const PUMPSWAP_SLIPPAGE = 10; // PumpSwap slippage percentage

// Timeouts (milliseconds)
export const TIMEOUTS = {
  DETECTION_MS: 15_000,
  CONFIRMATION_MS: 30_000,
  SLOT_FETCH_MS: 60_000,
} as const;

// Pool limits
export const POOL_LIMITS = {
  MIN_SOL: 5,
  MAX_SOL: 200,
  CACHE_MAX_AGE_MS: 24 * 60 * 60 * 1000,
} as const;

// Test defaults
export const DEFAULTS = {
  NUM_CYCLES: 5, //Number of test cycles per protocol in Demo
  NUM_OPERATIONS: 20, //Number of tests per protocol in Latency Test
  SDK_OPERATIONS: 10, //Number of SDK tests  per protocol in Latency Test
} as const;

// Pool cache file path
export const POOL_CACHE_FILE = path.join(__dirname, '../../data/pumpswap-pool.json');

// TypeScript interface for type safety
interface CopyTradingConfig {
  mode: 'simulate' | 'live';
  rpc: {
    endpoint: string;
    commitment: 'processed' | 'confirmed' | 'finalized';
  };
  laserstream: {
    endpoint: string;
    apiKey: string;
  };
  trading: {
    watchWallets: string[];
    minBalance: number;
    minTradeAmountSol: number;
    priorityFee: {
      unitLimit: number;
      unitPrice: number;
    };
    protocols: {
      pumpFun: {
        enabled: boolean;
        buyAmountSol: number;
        slippageBps: number;
      };
      pumpSwap: {
        enabled: boolean;
        buyAmountSol: number;
        slippageBps: number;
      };
    };
  };
  wallet: {
    privateKey: string;
  };
  testing: {
    sourceWalletPrivateKey: string;
  };
  logging: {
    logFile: string;
  };
}

class ConfigValidator {
  private static validateWallets(wallets: string[], allowEmpty: boolean = false): void {
    if (!allowEmpty && wallets.length === 0) {
      throw new Error('At least one wallet must be specified in watchWallets');
    }

    wallets.forEach(wallet => {
      try {
        new PublicKey(wallet);
      } catch {
        throw new Error(`Invalid wallet address: ${wallet}`);
      }
    });
  }

  private static validateEnvironment(): void {
    const required = ['HELIUS_API_KEY', 'HELIUS_RPC_ENDPOINT', 'BOT_WALLET_PRIVATE_KEY'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
      throw new Error(`Missing environment variables: ${missing.join(', ')}`);
    }

    try {
      const privateKey = process.env.BOT_WALLET_PRIVATE_KEY!;
      if (privateKey.length < 32) {
        throw new Error('Bot wallet private key appears to be too short');
      }
      bs58.decode(privateKey);
    } catch {
      throw new Error('Invalid bot wallet private key format - should be base58 encoded');
    }

    if (process.env.SOURCE_WALLET_PRIVATE_KEY) {
      const sourceKey = process.env.SOURCE_WALLET_PRIVATE_KEY;

      // Skip validation if using placeholder values or empty
      const placeholders = ['your_source_wallet_base58_private_key', 'your_'];
      const isPlaceholder = placeholders.some(ph => sourceKey.includes(ph)) || !sourceKey.trim();

      if (!isPlaceholder) {
        try {
          if (sourceKey.length < 32) {
            throw new Error('Source wallet private key appears to be too short');
          }
          const decoded = bs58.decode(sourceKey);
          if (decoded.length !== 64) {
            throw new Error('Invalid length');
          }
        } catch (error) {
          // Invalid key - just skip it (it's optional)
          // Don't throw, just ignore it
        }
      }
    }
  }

  private static validateTradingParams(trading: any): void {
    if (trading.minBalance <= 0) {
      throw new Error('Minimum balance must be positive');
    }

    if (trading.minTradeAmountSol <= 0) {
      throw new Error('Minimum trade amount must be positive');
    }

    if (trading.priorityFee.unitLimit <= 0) {
      throw new Error('Priority fee unit limit must be positive');
    }

    if (trading.priorityFee.unitPrice <= 0) {
      throw new Error('Priority fee unit price must be positive');
    }

    // Validate pump.fun config
    if (trading.protocols.pumpFun.enabled) {
      if (trading.protocols.pumpFun.buyAmountSol <= 0) {
        throw new Error('pump.fun buy amount must be positive');
      }
      if (trading.protocols.pumpFun.buyAmountSol < trading.minTradeAmountSol) {
        console.warn('WARNING: pump.fun buy amount is less than minimum trade amount');
      }
      if (trading.protocols.pumpFun.slippageBps < 0 || trading.protocols.pumpFun.slippageBps > 10000) {
        throw new Error('pump.fun slippage must be between 0 and 10000 basis points (0-100%)');
      }
    }

    // Validate PumpSwap config
    if (trading.protocols.pumpSwap.enabled) {
      if (trading.protocols.pumpSwap.buyAmountSol <= 0) {
        throw new Error('PumpSwap buy amount must be positive');
      }
      if (trading.protocols.pumpSwap.buyAmountSol < trading.minTradeAmountSol) {
        console.warn('WARNING: PumpSwap buy amount is less than minimum trade amount');
      }
      if (trading.protocols.pumpSwap.slippageBps < 0 || trading.protocols.pumpSwap.slippageBps > 10000) {
        throw new Error('PumpSwap slippage must be between 0 and 10000 basis points (0-100%)');
      }
    }

    if (!trading.protocols.pumpFun.enabled && !trading.protocols.pumpSwap.enabled) {
      throw new Error('At least one protocol (pumpFun or pumpSwap) must be enabled');
    }
  }

  static validate(): CopyTradingConfig {
    this.validateEnvironment();

    // Common placeholder values to filter out
    const placeholders = ['wallet1_address', 'wallet2_address', 'your_'];

    // Parse wallets from environment variable, filtering out placeholders
    const watchWallets = process.env.WATCH_WALLETS
      ?.split(',')
      .map(w => w.trim())
      .filter(w => w.length > 0)
      .filter(w => !placeholders.some(ph => w.includes(ph))) || [];

    // Parse all configuration from environment with defaults
    const mode = (process.env.MODE || 'live') as 'simulate' | 'live';
    const rpcCommitment = (process.env.RPC_COMMITMENT || 'processed') as 'processed' | 'confirmed' | 'finalized';
    const minBalance = parseFloat(process.env.MIN_BALANCE || '0.1');
    const minTradeAmount = parseFloat(process.env.MIN_TRADE_AMOUNT || '0.001');
    const priorityFeeUnitLimit = parseInt(process.env.PRIORITY_FEE_UNIT_LIMIT || '250000');
    const priorityFeeUnitPrice = parseInt(process.env.PRIORITY_FEE_UNIT_PRICE || '250000');
    const pumpFunEnabled = process.env.PUMPFUN_ENABLED !== 'false';
    const pumpSwapEnabled = process.env.PUMPSWAP_ENABLED !== 'false';
    const pumpFunBuyAmount = parseFloat(process.env.PUMPFUN_BUY_AMOUNT || '0.005');
    const pumpSwapBuyAmount = parseFloat(process.env.PUMPSWAP_BUY_AMOUNT || '0.002');
    const pumpFunSlippage = parseInt(process.env.PUMPFUN_SLIPPAGE_BPS || '500');
    const pumpSwapSlippage = parseInt(process.env.PUMPSWAP_SLIPPAGE_BPS || '1000');
    const logFile = process.env.LOG_FILE || './logs/bot.log';

    // Validate mode
    if (mode !== 'simulate' && mode !== 'live') {
      throw new Error('MODE must be either "simulate" or "live"');
    }

    // Validate commitment
    if (!['processed', 'confirmed', 'finalized'].includes(rpcCommitment)) {
      throw new Error('RPC_COMMITMENT must be "processed", "confirmed", or "finalized"');
    }

    // Validate numeric values
    if (isNaN(minBalance) || minBalance <= 0) {
      throw new Error('MIN_BALANCE must be a positive number');
    }
    if (isNaN(minTradeAmount) || minTradeAmount <= 0) {
      throw new Error('MIN_TRADE_AMOUNT must be a positive number');
    }
    if (isNaN(priorityFeeUnitLimit) || priorityFeeUnitLimit <= 0) {
      throw new Error('PRIORITY_FEE_UNIT_LIMIT must be a positive integer');
    }
    if (isNaN(priorityFeeUnitPrice) || priorityFeeUnitPrice <= 0) {
      throw new Error('PRIORITY_FEE_UNIT_PRICE must be a positive integer');
    }
    if (isNaN(pumpFunBuyAmount) || pumpFunBuyAmount <= 0) {
      throw new Error('PUMPFUN_BUY_AMOUNT must be a positive number');
    }
    if (isNaN(pumpSwapBuyAmount) || pumpSwapBuyAmount <= 0) {
      throw new Error('PUMPSWAP_BUY_AMOUNT must be a positive number');
    }
    if (isNaN(pumpFunSlippage) || pumpFunSlippage < 0 || pumpFunSlippage > 10000) {
      throw new Error('PUMPFUN_SLIPPAGE_BPS must be between 0 and 10000');
    }
    if (isNaN(pumpSwapSlippage) || pumpSwapSlippage < 0 || pumpSwapSlippage > 10000) {
      throw new Error('PUMPSWAP_SLIPPAGE_BPS must be between 0 and 10000');
    }

    const cfg: CopyTradingConfig = {
      mode,
      rpc: {
        endpoint: process.env.HELIUS_RPC_ENDPOINT!,
        commitment: rpcCommitment
      },
      laserstream: {
        endpoint: process.env.LASERSTREAM_ENDPOINT || '',
        apiKey: process.env.HELIUS_API_KEY!
      },
      trading: {
        watchWallets,
        minBalance,
        minTradeAmountSol: minTradeAmount,
        priorityFee: {
          unitLimit: priorityFeeUnitLimit,
          unitPrice: priorityFeeUnitPrice
        },
        protocols: {
          pumpFun: {
            enabled: pumpFunEnabled,
            buyAmountSol: pumpFunBuyAmount,
            slippageBps: pumpFunSlippage
          },
          pumpSwap: {
            enabled: pumpSwapEnabled,
            buyAmountSol: pumpSwapBuyAmount,
            slippageBps: pumpSwapSlippage
          }
        }
      },
      wallet: {
        privateKey: process.env.BOT_WALLET_PRIVATE_KEY!
      },
      testing: {
        sourceWalletPrivateKey: process.env.SOURCE_WALLET_PRIVATE_KEY || ''
      },
      logging: {
        logFile
      }
    };

    // Allow empty wallets from .env (can be provided via CLI)
    this.validateWallets(cfg.trading.watchWallets, true);
    this.validateTradingParams(cfg.trading);

    return cfg;
  }
}

export const TRADING_UTILS = {
  solToLamports: (sol: number) => Math.floor(sol * LAMPORTS_PER_SOL),
  lamportsToSol: (lamports: number) => lamports / LAMPORTS_PER_SOL,
  meetsMinimumTrade: (amountLamports: number, minSol: number) => 
    amountLamports >= Math.floor(minSol * LAMPORTS_PER_SOL),
  formatAmount: (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`
} as const;

export const appConfig = ConfigValidator.validate();
export type { CopyTradingConfig };