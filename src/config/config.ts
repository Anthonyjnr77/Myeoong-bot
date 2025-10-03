// config/config.ts
import config from 'config';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

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
    const required = ['HELIUS_API_KEY', 'HELIUS_RPC_ENDPOINT', 'LASERSTREAM_ENDPOINT', 'BOT_WALLET_PRIVATE_KEY'];
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
      try {
        const sourceKey = process.env.SOURCE_WALLET_PRIVATE_KEY;
        if (sourceKey.length < 32) {
          throw new Error('Source wallet private key appears to be too short');
        }
        bs58.decode(sourceKey);
      } catch {
        throw new Error('Invalid source wallet private key format - should be base58 encoded');
      }
    }
  }

  private static validateTradingParams(trading: any): void {
    if (trading.minTradeAmountSol <= 0) {
      throw new Error('Minimum trade amount must be positive');
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

    // Parse wallets from environment variable
    const watchWallets = process.env.WATCH_WALLETS
      ?.split(',')
      .map(w => w.trim())
      .filter(w => w.length > 0) || [];

    const cfg: CopyTradingConfig = {
      mode: config.get('mode'),
      rpc: {
        endpoint: process.env.HELIUS_RPC_ENDPOINT!,
        commitment: config.get('rpc.commitment')
      },
      laserstream: {
        endpoint: process.env.LASERSTREAM_ENDPOINT!,
        apiKey: process.env.HELIUS_API_KEY!
      },
      trading: {
        ...config.get('trading'),
        watchWallets  // Use parsed wallets from env
      },
      wallet: {
        privateKey: process.env.BOT_WALLET_PRIVATE_KEY!
      },
      testing: {
        sourceWalletPrivateKey: process.env.SOURCE_WALLET_PRIVATE_KEY || ''
      },
      logging: config.get('logging')
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