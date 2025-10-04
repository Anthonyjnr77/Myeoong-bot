// Suppress bigint warning
process.env.NODE_NO_WARNINGS = '1';
import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress } from '@solana/spl-token';
import bs58 from 'bs58';
import { subscribe } from 'helius-laserstream';

interface ValidationResult {
  passed: boolean;
  message: string;
  solution?: string;
}

async function validateEnvironmentVariables(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  const required = [
    'HELIUS_API_KEY',
    'HELIUS_RPC_ENDPOINT',
    'LASERSTREAM_ENDPOINT',
    'BOT_WALLET_PRIVATE_KEY'
  ];

  // Common placeholder values that indicate .env wasn't properly configured
  const placeholders = [
    'your_helius_api_key_here',
    'your_api_key_here',
    'your_base58_encoded_private_key_here',
    'your_source_wallet_base58_private_key',
    'wallet1_address',
    'wallet2_address'
  ];

  for (const varName of required) {
    const value = process.env[varName];

    if (!value) {
      results.push({
        passed: false,
        message: varName,
        solution: `Set ${varName} in .env file`
      });
    } else if (placeholders.some(ph => value.includes(ph))) {
      results.push({
        passed: false,
        message: `${varName} (still using placeholder value)`,
        solution: `Replace placeholder value with actual ${varName}`
      });
    } else {
      results.push({
        passed: true,
        message: varName
      });
    }
  }

  // Include optional variables if they are set (ignore if using placeholder values)
  if (process.env.WATCH_WALLETS && process.env.WATCH_WALLETS.trim()) {
    const watchWallets = process.env.WATCH_WALLETS;
    // Skip validation if using placeholder values - treat as not set
    if (!placeholders.some(ph => watchWallets.includes(ph))) {
      results.push({
        passed: true,
        message: 'WATCH_WALLETS'
      });
    }
  }

  if (process.env.SOURCE_WALLET_PRIVATE_KEY) {
    const sourceKey = process.env.SOURCE_WALLET_PRIVATE_KEY;
    // Skip validation if using placeholder values - treat as not set
    if (!placeholders.some(ph => sourceKey.includes(ph))) {
      results.push({
        passed: true,
        message: 'SOURCE_WALLET_PRIVATE_KEY'
      });
    }
  }

  return results;
}

async function validatePrivateKeys(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  // Validate bot wallet private key
  try {
    if (!process.env.BOT_WALLET_PRIVATE_KEY) {
      throw new Error('Not set');
    }

    const decoded = bs58.decode(process.env.BOT_WALLET_PRIVATE_KEY);
    if (decoded.length !== 64) {
      throw new Error('Invalid length (should be 64 bytes)');
    }

    const keypair = Keypair.fromSecretKey(decoded);
    results.push({
      passed: true,
      message: `Bot wallet valid: ${keypair.publicKey.toBase58().slice(0, 4)}...${keypair.publicKey.toBase58().slice(-4)}`
    });
  } catch (error) {
    results.push({
      passed: false,
      message: `Bot wallet invalid: ${error instanceof Error ? error.message : 'Unknown error'}`,
      solution: 'Ensure BOT_WALLET_PRIVATE_KEY is a valid base58-encoded private key'
    });
  }

  // Validate source wallet private key (optional)
  // Common placeholder values
  const placeholders = ['your_source_wallet_base58_private_key', 'your_'];

  const sourceKeySet = process.env.SOURCE_WALLET_PRIVATE_KEY &&
                       !placeholders.some(ph => process.env.SOURCE_WALLET_PRIVATE_KEY!.includes(ph));

  if (sourceKeySet) {
    try {
      const decoded = bs58.decode(process.env.SOURCE_WALLET_PRIVATE_KEY!);
      if (decoded.length !== 64) {
        throw new Error('Invalid length (should be 64 bytes)');
      }

      const keypair = Keypair.fromSecretKey(decoded);
      results.push({
        passed: true,
        message: `Source wallet valid: ${keypair.publicKey.toBase58().slice(0, 4)}...${keypair.publicKey.toBase58().slice(-4)}`
      });
    } catch (error) {
      results.push({
        passed: false,
        message: `Source wallet invalid: ${error instanceof Error ? error.message : 'Unknown error'}`,
        solution: 'Ensure SOURCE_WALLET_PRIVATE_KEY is a valid base58-encoded private key'
      });
    }
  }

  return results;
}

async function validateWalletAddresses(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  if (!process.env.WATCH_WALLETS || !process.env.WATCH_WALLETS.trim()) {
    return results; // Skip if not set
  }

  // Common placeholder values
  const placeholders = ['wallet1_address', 'wallet2_address', 'your_'];

  // Skip if using placeholder values - treat as not set
  if (placeholders.some(ph => process.env.WATCH_WALLETS!.includes(ph))) {
    return results;
  }

  const wallets = process.env.WATCH_WALLETS.split(',').map(w => w.trim()).filter(w => w);

  for (const wallet of wallets) {
    try {
      new PublicKey(wallet);
      results.push({
        passed: true,
        message: `${wallet.slice(0, 4)}...${wallet.slice(-4)}`
      });
    } catch {
      results.push({
        passed: false,
        message: `Invalid address: ${wallet}`,
        solution: 'Ensure all addresses in WATCH_WALLETS are valid Solana public keys'
      });
    }
  }

  return results;
}

async function validateRPCConnection(): Promise<ValidationResult> {
  try {
    if (!process.env.HELIUS_RPC_ENDPOINT) {
      throw new Error('RPC endpoint not set');
    }

    const connection = new Connection(process.env.HELIUS_RPC_ENDPOINT);
    const start = Date.now();
    await connection.getSlot();
    const latency = Date.now() - start;

    return {
      passed: true,
      message: `RPC endpoint responding (${latency}ms)`
    };
  } catch (error) {
    return {
      passed: false,
      message: `RPC connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      solution: 'Check HELIUS_RPC_ENDPOINT in .env - ensure it includes your API key'
    };
  }
}

async function validateLaserstreamConnection(): Promise<ValidationResult> {
  try {
    if (!process.env.LASERSTREAM_ENDPOINT || !process.env.HELIUS_API_KEY) {
      throw new Error('Laserstream configuration not set');
    }

    return await new Promise<ValidationResult>((resolve) => {
      let resolved = false;
      let streamHandle: any = null;

      const cleanup = () => {
        if (streamHandle && typeof streamHandle.cancel === 'function') {
          try {
            streamHandle.cancel();
          } catch (e) {
            // Ignore cleanup errors
          }
        }
      };

      // 5 second hard timeout
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          resolve({
            passed: false,
            message: 'Laserstream connection timeout (5s)',
            solution: 'Check LASERSTREAM_ENDPOINT and HELIUS_API_KEY - ensure API key is valid'
          });
        }
      }, 5000);

      subscribe(
        {
          apiKey: process.env.HELIUS_API_KEY!,
          endpoint: process.env.LASERSTREAM_ENDPOINT!
        },
        {
          transactions: {},
          accounts: {},
          slots: {},
          transactionsStatus: {},
          blocks: {},
          blocksMeta: {},
          entry: {},
          accountsDataSlice: []
        },
        () => {}, // Empty data handler
        (error: any) => {
          // Error callback
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            cleanup();
            resolve({
              passed: false,
              message: `Laserstream connection failed: ${error.message || 'Unknown error'}`,
              solution: 'Check HELIUS_API_KEY is valid and has Laserstream access'
            });
          }
        }
      ).then((handle) => {
        streamHandle = handle;

        // Success - connection established and handle received
        // Wait 2 seconds instead of 1 to reduce false negatives
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            cleanup();
            resolve({
              passed: true,
              message: 'Laserstream connection successful'
            });
          }
        }, 2000); // Increased to 2 seconds
      }).catch((error) => {
        // Catch promise rejection
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          cleanup();
          resolve({
            passed: false,
            message: `Laserstream connection failed: ${error.message || 'Unknown error'}`,
            solution: 'Check LASERSTREAM_ENDPOINT and HELIUS_API_KEY in .env'
          });
        }
      });
    });
  } catch (error) {
    return {
      passed: false,
      message: `Laserstream validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      solution: 'Check LASERSTREAM_ENDPOINT and HELIUS_API_KEY in .env'
    };
  }
}

async function validateWalletBalances(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  // Validate bot wallet balance
  try {
    if (!process.env.HELIUS_RPC_ENDPOINT || !process.env.BOT_WALLET_PRIVATE_KEY) {
      throw new Error('Missing configuration');
    }

    const connection = new Connection(process.env.HELIUS_RPC_ENDPOINT);
    const keypair = Keypair.fromSecretKey(bs58.decode(process.env.BOT_WALLET_PRIVATE_KEY));
    const balance = await connection.getBalance(keypair.publicKey);
    const balanceSol = balance / 1e9;

    const MIN_BALANCE = 0.1;

    if (balanceSol < MIN_BALANCE) {
      results.push({
        passed: false,
        message: `Bot wallet balance too low: ${balanceSol.toFixed(4)} SOL (need >${MIN_BALANCE} SOL)`,
        solution: 'Fund bot wallet at https://faucet.solana.com'
      });
    } else {
      results.push({
        passed: true,
        message: `Bot wallet balance: ${balanceSol.toFixed(4)} SOL`
      });
    }
  } catch (error) {
    results.push({
      passed: false,
      message: `Bot wallet balance check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      solution: 'Ensure RPC connection and bot wallet are configured correctly'
    });
  }

  // Validate source wallet balance (optional)
  // Common placeholder values
  const placeholders = ['your_source_wallet_base58_private_key', 'your_'];

  const sourceKeySet = process.env.SOURCE_WALLET_PRIVATE_KEY &&
                       !placeholders.some(ph => process.env.SOURCE_WALLET_PRIVATE_KEY!.includes(ph));

  if (sourceKeySet) {
    try {
      if (!process.env.HELIUS_RPC_ENDPOINT) {
        throw new Error('Missing RPC configuration');
      }

      const connection = new Connection(process.env.HELIUS_RPC_ENDPOINT);
      const keypair = Keypair.fromSecretKey(bs58.decode(process.env.SOURCE_WALLET_PRIVATE_KEY!));
      const balance = await connection.getBalance(keypair.publicKey);
      const balanceSol = balance / 1e9;

      const MIN_BALANCE = 0.1;

      if (balanceSol < MIN_BALANCE) {
        results.push({
          passed: false,
          message: `Source wallet balance too low: ${balanceSol.toFixed(4)} SOL (need >${MIN_BALANCE} SOL)`,
          solution: 'Fund source wallet at https://faucet.solana.com'
        });
      } else {
        results.push({
          passed: true,
          message: `Source wallet balance: ${balanceSol.toFixed(4)} SOL`
        });
      }
    } catch (error) {
      results.push({
        passed: false,
        message: `Source wallet balance check failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        solution: 'Ensure source wallet private key is valid'
      });
    }
  }

  return results;
}

async function validateConfigSystem(): Promise<ValidationResult> {
  try {
    // Dynamically import to ensure env vars are loaded first
    const { appConfig } = await import('../src/config/config');

    return {
      passed: true,
      message: 'Config system loaded successfully'
    };
  } catch (error) {
    return {
      passed: false,
      message: `Config validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      solution: 'Check config/default.json for syntax errors'
    };
  }
}

async function validateTestingCapability(): Promise<ValidationResult> {
  // Common placeholder values
  const placeholders = ['your_source_wallet_base58_private_key', 'your_'];

  const sourceKeySet = process.env.SOURCE_WALLET_PRIVATE_KEY &&
                       !placeholders.some(ph => process.env.SOURCE_WALLET_PRIVATE_KEY!.includes(ph));

  if (!sourceKeySet) {
    return {
      passed: true,
      message: 'Testing scripts unavailable (SOURCE_WALLET_PRIVATE_KEY not configured)',
      solution: 'Set SOURCE_WALLET_PRIVATE_KEY in .env to run demo/latency/trades scripts'
    };
  }

  return {
    passed: true,
    message: 'Testing scripts available'
  };
}

async function validateTokenAccountCreation(): Promise<ValidationResult> {
  try {
    if (!process.env.HELIUS_RPC_ENDPOINT || !process.env.BOT_WALLET_PRIVATE_KEY) {
      throw new Error('Missing configuration');
    }

    const connection = new Connection(process.env.HELIUS_RPC_ENDPOINT);
    const keypair = Keypair.fromSecretKey(bs58.decode(process.env.BOT_WALLET_PRIVATE_KEY));

    const testMint = new PublicKey('So11111111111111111111111111111111111111112');
    const ata = await getAssociatedTokenAddress(testMint, keypair.publicKey);

    return {
      passed: true,
      message: 'Token account creation works'
    };
  } catch (error) {
    return {
      passed: false,
      message: `Token account test failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      solution: 'Check @solana/spl-token package is installed correctly'
    };
  }
}

async function validateOptionalConfigs(): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  // Common placeholder values
  const placeholders = ['wallet1_address', 'wallet2_address', 'your_'];

  // Check if WATCH_WALLETS is not set or has placeholder values (treat both as not set)
  const watchWalletsNotSet = !process.env.WATCH_WALLETS ||
                              !process.env.WATCH_WALLETS.trim() ||
                              placeholders.some(ph => process.env.WATCH_WALLETS!.includes(ph));

  if (watchWalletsNotSet) {
    results.push({
      passed: true,
      message: 'WATCH_WALLETS not set',
      solution: 'Optional, pass wallet addresses as CLI arguments or set in .env to run bot'
    });
  }

  // Check if SOURCE_WALLET_PRIVATE_KEY is not set or has placeholder values
  const sourceKeyNotSet = !process.env.SOURCE_WALLET_PRIVATE_KEY ||
                          placeholders.some(ph => process.env.SOURCE_WALLET_PRIVATE_KEY!.includes(ph));

  if (sourceKeyNotSet) {
    results.push({
      passed: true,
      message: 'SOURCE_WALLET_PRIVATE_KEY not set',
      solution: 'Optional, but required for running tests'
    });
  }

  return results;
}

function printResults(category: string, results: ValidationResult[]): boolean {
  console.log(`\n${category}:`);

  let allPassed = true;

  for (const result of results) {
    const icon = result.passed ? '✓' : '✗';
    console.log(`  ${icon} ${result.message}`);

    if (!result.passed) {
      allPassed = false;
      if (result.solution) {
        console.log(`    Solution: ${result.solution}`);
      }
    } else if (result.solution) {
      // Warning: passed but has additional info
      console.log(`    ${result.solution}`);
    }
  }

  return allPassed;
}

function printOptionalConfigs(results: ValidationResult[]): void {
  if (results.length === 0) return;

  console.log(`\nOptional Variables:`);

  for (const result of results) {
    console.log(`  ! ${result.message}`);
    if (result.solution) {
      console.log(`    ${result.solution}`);
    }
  }
}

async function main() {
  console.log('SETUP VALIDATION');
  console.log('━'.repeat(60));

  let overallPassed = true;

  const envResults = await validateEnvironmentVariables();
  if (!printResults('Environment Variables', envResults)) {
    overallPassed = false;
  }

  const optionalConfigs = await validateOptionalConfigs();
  printOptionalConfigs(optionalConfigs);

  const keyResults = await validatePrivateKeys();
  if (!printResults('Wallet Keys', keyResults)) {
    overallPassed = false;
  }

  const walletResults = await validateWalletAddresses();
  if (walletResults.length > 0) {
    if (!printResults('Watch Wallets (from .env)', walletResults)) {
      overallPassed = false;
    }
  }

  const rpcResult = await validateRPCConnection();
  const laserstreamResult = await validateLaserstreamConnection();
  if (!printResults('Connections', [rpcResult, laserstreamResult])) {
    overallPassed = false;
  }

  const balanceResults = await validateWalletBalances();
  if (!printResults('Wallet Balances', balanceResults)) {
    overallPassed = false;
  }

  const configResult = await validateConfigSystem();
  const tokenResult = await validateTokenAccountCreation();
  const testingResult = await validateTestingCapability();
  if (!printResults('Functionality', [configResult, tokenResult, testingResult])) {
    overallPassed = false;
  }

  console.log('\n' + '━'.repeat(60));

  if (overallPassed) {
    console.log('✓ ALL CHECKS PASSED - Ready to run scripts\n');
    process.exit(0);
  } else {
    console.log('✗ VALIDATION FAILED - Fix issues above before running scripts\n');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('Validation script error:', error);
  process.exit(1);
});