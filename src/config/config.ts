import config from 'config';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

// Domain-specific constants from QuickNode (pump.fun knowledge)
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
    copyAmountSol: number;
    minTradeAmountSol: number;
    slippageBps: number;
    priorityFee: {
      unitLimit: number;
      unitPrice: number;
    };
  };
  wallet: {
    privateKey: string;
  };
  logging: {
    logFile: string;
  };
}

class ConfigValidator {
  private static validateWallets(wallets: string[]): void {
    if (wallets.length === 0) {
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
    const required = ['HELIUS_API_KEY', 'HELIUS_RPC_ENDPOINT', 'LASERSTREAM_ENDPOINT', 'PRIVATE_KEY'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing environment variables: ${missing.join(', ')}`);
    }

    // Validate private key format (should be base58)
    try {
      const privateKey = process.env.PRIVATE_KEY!;
      if (privateKey.length < 32) {
        throw new Error('Private key appears to be too short');
      }
    } catch {
      throw new Error('Invalid private key format - should be base58 encoded');
    }
  }

  private static validateTradingParams(trading: any): void {
    if (trading.copyAmountSol <= 0) {
      throw new Error('Copy amount must be positive');
    }

    if (trading.minTradeAmountSol <= 0) {
      throw new Error('Minimum trade amount must be positive');
    }

    if (trading.copyAmountSol < trading.minTradeAmountSol) {
      console.warn('⚠️  Copy amount is less than minimum trade amount - no trades will be copied');
    }

    if (trading.slippageBps < 0 || trading.slippageBps > 10000) {
      throw new Error('Slippage must be between 0 and 10000 basis points (0-100%)');
    }
  }

  static validate(): CopyTradingConfig {
    this.validateEnvironment();
    
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
      trading: config.get('trading'),
      wallet: {
        privateKey: process.env.PRIVATE_KEY!
      },
      logging: config.get('logging')
    };

    // Validate all parameters
    this.validateWallets(cfg.trading.watchWallets);
    this.validateTradingParams(cfg.trading);

    // Log configuration summary
    console.log(`🔧 Config loaded: ${cfg.mode} mode`);
    console.log(`📊 Watching ${cfg.trading.watchWallets.length} wallets:`);
    cfg.trading.watchWallets.forEach(wallet => 
      console.log(`   - ${wallet.substring(0, 4)}...${wallet.slice(-4)}`)
    );
    console.log(`💰 Copy amount: ${cfg.trading.copyAmountSol} SOL`);
    console.log(`🎯 Min trade size: ${cfg.trading.minTradeAmountSol} SOL`);
    
    return cfg;
  }
}

// Utility functions for common calculations
export const TRADING_UTILS = {
  solToLamports: (sol: number) => Math.floor(sol * LAMPORTS_PER_SOL),
  lamportsToSol: (lamports: number) => lamports / LAMPORTS_PER_SOL,
  
  // Helper to check if transaction amount meets minimum
  meetsMinimumTrade: (amountLamports: number, minSol: number) => 
    amountLamports >= Math.floor(minSol * LAMPORTS_PER_SOL),
    
  // Helper to format amounts for logging
  formatAmount: (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`
} as const;

export const appConfig = ConfigValidator.validate();
export type { CopyTradingConfig };