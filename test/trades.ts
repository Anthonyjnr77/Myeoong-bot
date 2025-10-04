// Suppress bigint warning
process.env.NODE_NO_WARNINGS = '1';
import 'dotenv/config';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { appConfig } from '../src/config/config';
import {
  getSellAmount,
  findPumpSwapPool,
  createTestToken
} from '../src/utils/test-utils';
import { SELL_PERCENTAGE, TIMEOUTS } from '../src/config/config';
import { CopytradingBot } from '../src/bot/CopytradingBot';
import { SourceTradeExecutor } from '../src/bot/test/SourceTradeExecutor';
import bs58 from 'bs58';

// CLI parsing
const args = process.argv.slice(2).filter(arg => arg !== '--');
const command = args[0] || 'buysell';
const tokenArg = args.find(a => a.startsWith('--token=') || a.startsWith('-t='))?.split('=')[1];
const poolArg = args.find(a => a.startsWith('--pool=') || a.startsWith('-p='))?.split('=')[1];
const amountArg = args.find(a => a.startsWith('--amount='))?.split('=')[1];
const pumpfunFlag = args.includes('--pumpfun');
const pumpswapFlag = args.includes('--pumpswap');

// Determine protocol (pool implies pumpswap)
let protocol: 'pumpfun' | 'pumpswap' = 'pumpfun';
if (pumpswapFlag || poolArg) {
  protocol = 'pumpswap';
} else if (pumpfunFlag) {
  protocol = 'pumpfun';
}

// Pattern definitions
interface TradeStep {
  type: 'buy' | 'sell';
  amount?: number; // For buys only
  protocol?: 'pumpfun' | 'pumpswap';
}

const PATTERNS: Record<string, TradeStep[]> = {
  'buy': [{ type: 'buy' }],
  'sell': [{ type: 'sell' }],
  'buysell': [
    { type: 'buy' },
    { type: 'sell' }
  ],
  'pump': [
    { type: 'buy', protocol: 'pumpfun' },
    { type: 'buy', protocol: 'pumpswap' },
    { type: 'sell', protocol: 'pumpfun' },
    { type: 'sell', protocol: 'pumpswap' }
  ]
};

function showHelp() {
  console.log(`
TRADE GENERATOR

Usage: pnpm trades [pattern] [options]

PATTERNS:
  buy       - Single buy
  sell      - Single sell
  buysell   - Buy then sell (default)
  pump      - Test both protocols

OPTIONS:
  --pumpfun                         (use pump.fun protocol, default)
  --pumpswap                        (use PumpSwap protocol)
  --token=ADDRESS  or  -t=ADDRESS   (token address for pump.fun)
  --pool=ADDRESS   or  -p=ADDRESS   (pool address for PumpSwap)
  --amount=0.01                     (SOL amount for buys only)

EXAMPLES:
  pnpm trades buy                              (pump.fun buy, creates token)
  pnpm trades buy --pumpfun --amount=0.05      (pump.fun buy 0.05 SOL)
  pnpm trades buy --pumpswap                   (PumpSwap buy, finds pool)
  pnpm trades sell --token=7YPL...3mK8         (pump.fun sell token)
  pnpm trades sell --pool=Pool9xKm...          (PumpSwap sell from pool)
  pnpm trades buysell --pumpswap               (PumpSwap buy then sell)

NOTES:
  - Sells always sell the percentage defined in config (SELL_PERCENTAGE)
  - If no protocol specified, defaults to pump.fun
`);
}

async function getTokenBalance(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey
): Promise<bigint> {
  const accounts = await connection.getTokenAccountsByOwner(
    wallet.publicKey,
    { mint }
  );

  if (accounts.value.length === 0) return 0n;
  return accounts.value[0].account.data.readBigUInt64LE(64);
}

async function waitForConfirmation(
  connection: Connection,
  signature: string,
  timeoutMs: number = TIMEOUTS.CONFIRMATION_MS
): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const status = await connection.getSignatureStatus(signature);
      if (status.value?.confirmationStatus === 'confirmed' ||
          status.value?.confirmationStatus === 'finalized') {
        return true;
      }
      if (status.value?.err) {
        console.log(`\n  Transaction failed: ${JSON.stringify(status.value.err)}`);
        return false;
      }
    } catch (e: any) {
      // Log network errors instead of silently ignoring
      console.log(`\n  Warning: RPC error checking confirmation - ${e.message || 'unknown error'}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250)); // 250ms interval for fast confirmation
  }

  console.log(`\n  Warning: Confirmation timeout after ${timeoutMs/1000}s`);
  return false;
}

async function executeTrade(
  type: 'buy' | 'sell',
  targetProtocol: 'pumpfun' | 'pumpswap',
  token: string,
  pool: string | undefined,
  amount: number | undefined,
  executor: SourceTradeExecutor,
  wallet: Keypair,
  connection: Connection
): Promise<{ success: boolean; error?: string; signature?: string }> {
  try {
    // Use executeTrade like demo.ts does
    const tradeParams: any = {
      protocol: targetProtocol === 'pumpfun' ? 'PUMP_FUN' : 'PUMP_SWAP',
      type: type.toUpperCase() as 'BUY' | 'SELL',
      mint: token
    };

    // Add pool and baseMint for PumpSwap
    if (targetProtocol === 'pumpswap' && pool) {
      tradeParams.pool = new PublicKey(pool);
      tradeParams.baseMint = new PublicKey(token); // token is baseMint for PumpSwap
    }

    const signature = await executor.executeTrade(wallet, tradeParams);

    return { success: true, signature };
  } catch (error: any) {
    return { success: false, error: error.message || error.toString() };
  }
}

async function main() {
  if (command === 'help' || command === '-h' || command === '--help') {
    showHelp();
    process.exit(0);
  }

  // Validate environment configuration
  if (!appConfig.testing?.sourceWalletPrivateKey) {
    console.error('\n✗ SOURCE_WALLET_PRIVATE_KEY not configured');
    console.error('  Set it in .env file\n');
    process.exit(1);
  }

  if (!appConfig.rpc?.endpoint) {
    console.error('\n✗ RPC endpoint not configured');
    console.error('  Set HELIUS_RPC_ENDPOINT in .env file\n');
    process.exit(1);
  }

  const pattern = PATTERNS[command] || PATTERNS['buysell'];

  // Validate that token and pool are not both provided
  if (tokenArg && poolArg) {
    console.error('\n✗ Cannot specify both --token and --pool');
    console.error('  Use --token for pump.fun OR --pool for PumpSwap\n');
    process.exit(1);
  }

  // Validate protocol flag consistency
  if (pumpfunFlag && poolArg) {
    console.error('\n✗ Cannot use --pumpfun with --pool');
    console.error('  Use --pumpfun with --token OR --pumpswap with --pool\n');
    process.exit(1);
  }

  if (pumpswapFlag && tokenArg) {
    console.error('\n✗ Cannot use --pumpswap with --token');
    console.error('  Use --pumpfun with --token OR --pumpswap with --pool\n');
    process.exit(1);
  }

  // Validate token address if provided
  if (tokenArg) {
    try {
      new PublicKey(tokenArg);
    } catch (error) {
      console.error(`\n✗ Invalid token address: ${tokenArg}`);
      console.error('  Please provide a valid Solana public key\n');
      process.exit(1);
    }
  }

  // Validate pool address if provided
  if (poolArg) {
    try {
      new PublicKey(poolArg);
    } catch (error) {
      console.error(`\n✗ Invalid pool address: ${poolArg}`);
      console.error('  Please provide a valid Solana public key\n');
      process.exit(1);
    }
  }

  // Validate that sell commands have required token/pool
  const hasSell = pattern.some(s => s.type === 'sell');
  if (hasSell && command === 'sell') {
    if (protocol === 'pumpfun' && !tokenArg) {
      console.error('\n✗ Sell requires --token for pump.fun');
      console.error('  Example: pnpm trades sell --token=YOUR_TOKEN\n');
      process.exit(1);
    }
    if (protocol === 'pumpswap' && !poolArg) {
      console.error('\n✗ Sell requires --pool for PumpSwap');
      console.error('  Example: pnpm trades sell --pumpswap --pool=YOUR_POOL\n');
      process.exit(1);
    }
  }

  // Setup connection and wallet (use processed commitment for fresh blockhashes)
  const connection = new Connection(appConfig.rpc.endpoint, { commitment: 'processed' });
  const wallet = Keypair.fromSecretKey(bs58.decode(appConfig.testing!.sourceWalletPrivateKey));

  // Validate pool exists and is owned by PumpSwap program
  if (poolArg) {
    const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
    const poolPubkey = new PublicKey(poolArg);

    try {
      const poolInfo = await connection.getAccountInfo(poolPubkey);
      if (!poolInfo) {
        console.error(`\n✗ Pool not found: ${poolArg}`);
        console.error('  Pool account does not exist on-chain\n');
        process.exit(1);
      }
      if (!poolInfo.owner.equals(PUMPSWAP_PROGRAM_ID)) {
        console.error(`\n✗ Not a PumpSwap pool: ${poolArg}`);
        console.error(`  Pool owner: ${poolInfo.owner.toBase58()}`);
        console.error(`  Expected: ${PUMPSWAP_PROGRAM_ID.toBase58()}\n`);
        process.exit(1);
      }
    } catch (error: any) {
      if (error.message && !error.message.includes('Pool not found')) {
        console.error(`\n✗ Error validating pool: ${error.message}\n`);
        process.exit(1);
      }
      throw error;
    }
  }

  // Check balance before doing anything expensive
  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;

  // Calculate total SOL needed for all buys
  const buySteps = pattern.filter(s => s.type === 'buy');
  let totalRequired = 0;
  for (const step of buySteps) {
    const stepProtocol = step.protocol || protocol;
    const defaultAmount = stepProtocol === 'pumpfun' ? appConfig.trading.protocols.pumpFun.buyAmountSol : appConfig.trading.protocols.pumpSwap.buyAmountSol;
    const stepAmount = step.amount || (amountArg ? parseFloat(amountArg) : defaultAmount);
    totalRequired += stepAmount;
  }

  // Add buffer for transaction fees (~0.001 SOL per tx)
  const feesBuffer = pattern.length * 0.001;
  const totalWithFees = totalRequired + feesBuffer;

  if (balanceSol < totalWithFees) {
    console.error(`\n✗ Insufficient balance`);
    console.error(`  Available: ${balanceSol.toFixed(4)} SOL`);
    console.error(`  Required:  ${totalWithFees.toFixed(4)} SOL (${totalRequired.toFixed(4)} + ${feesBuffer.toFixed(4)} fees)`);
    console.error(`  Wallet:    ${wallet.publicKey.toBase58()}\n`);
    process.exit(1);
  }

  let pumpFunToken = tokenArg;
  let pumpSwapPool: string | undefined = poolArg;
  let pumpSwapToken: string | undefined;

  // If pool is provided but no token, fetch the base mint from the pool
  if (poolArg && !tokenArg) {
    process.stdout.write('Fetching pool info... ');
    try {
      const poolPubkey = new PublicKey(poolArg);
      const poolInfo = await connection.getAccountInfo(poolPubkey);
      if (!poolInfo) {
        throw new Error('Pool account not found');
      }
      // Base mint is at offset 8 + 1 + 2 + 32
      const baseMintOffset = 8 + 1 + 2 + 32;
      const baseMint = new PublicKey(poolInfo.data.subarray(baseMintOffset, baseMintOffset + 32));
      pumpSwapToken = baseMint.toBase58();
      console.log(`✓ ${pumpSwapToken.slice(0, 8)}...`);
    } catch (error: any) {
      console.log('✗');
      console.error(`Error fetching pool info: ${error.message}`);
      process.exit(1);
    }
  }

  // Pre-create resources needed for the pattern
  const needsPumpFun = pattern.some(s => (s.protocol || protocol) === 'pumpfun');
  const needsPumpSwap = pattern.some(s => (s.protocol || protocol) === 'pumpswap');

  if (needsPumpFun && !pumpFunToken) {
    process.stdout.write('Creating token... ');
    pumpFunToken = await createTestToken(connection, wallet);
    if (!pumpFunToken) {
      console.log('FAILED');
      process.exit(1);
    }
    console.log(`✓ ${pumpFunToken.slice(0, 8)}...`);
  }

  if (needsPumpSwap && !pumpSwapPool) {
    process.stdout.write('Finding pool... ');
    const poolInfo = await findPumpSwapPool(connection);
    if (!poolInfo) {
      console.log('FAILED');
      process.exit(1);
    }
    pumpSwapPool = poolInfo.pool.toBase58();
    pumpSwapToken = poolInfo.baseMint.toBase58();
    console.log(`✓ ${pumpSwapPool.slice(0, 8)}... (${poolInfo.liquidity.toFixed(1)} SOL)`);
  }

  // Show pattern
  console.log(`\nPattern: ${command || 'buysell'}`);
  const opts = [];
  if (tokenArg) opts.push(`token=${tokenArg.slice(0, 8)}...`);
  if (poolArg) opts.push(`pool=${poolArg.slice(0, 8)}...`);
  if (amountArg) opts.push(`amount=${amountArg}`);
  if (opts.length > 0) console.log(`Options: ${opts.join(', ')}`);
  console.log();

  // Initialize bot and executor (like demo.ts does)
  const bot = new CopytradingBot({
    mode: 'live',
    watchWallets: [wallet.publicKey.toBase58()]
  });
  const executor = new SourceTradeExecutor(connection);
  await bot.initialize();
  await bot.start();

  // Execute pattern and track confirmations
  const pendingConfirmations: Array<{ signature: string; promise: Promise<boolean> }> = [];
  const lastBuy: Record<'pumpfun' | 'pumpswap', { signature: string; promise: Promise<boolean> } | null> = {
    pumpfun: null,
    pumpswap: null
  };
  let successCount = 0;
  let failCount = 0;

  for (const step of pattern) {
    const stepProtocol = step.protocol || protocol;

    // If this is a sell, wait for the corresponding buy to confirm
    if (step.type === 'sell' && lastBuy[stepProtocol]) {
      await lastBuy[stepProtocol]!.promise;
    }

    // Execute trade
    const time = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });

    const defaultAmount = stepProtocol === 'pumpfun' ? appConfig.trading.protocols.pumpFun.buyAmountSol : appConfig.trading.protocols.pumpSwap.buyAmountSol;
    const tradeAmount = step.amount || (amountArg ? parseFloat(amountArg) : undefined);
    const amountStr = step.type === 'buy'
      ? `${tradeAmount ?? defaultAmount} SOL`
      : `${SELL_PERCENTAGE * 100}%`;

    process.stdout.write(
      `[${time}] ${stepProtocol.padEnd(9)} ${step.type.toUpperCase().padEnd(4)} ${amountStr.padEnd(10)} `
    );

    const tokenForTrade = stepProtocol === 'pumpfun' ? pumpFunToken! : pumpSwapToken!;
    const poolForTrade = stepProtocol === 'pumpswap' ? pumpSwapPool : undefined;

    const result = await executeTrade(
      step.type,
      stepProtocol,
      tokenForTrade,
      poolForTrade,
      tradeAmount,
      executor,
      wallet,
      connection
    );

    if (result.success) {
      console.log('✓');
      successCount++;

      // Start confirmation in background
      if (result.signature) {
        const confirmPromise = waitForConfirmation(connection, result.signature);
        pendingConfirmations.push({ signature: result.signature, promise: confirmPromise });

        // Track last buy per protocol
        if (step.type === 'buy') {
          lastBuy[stepProtocol] = { signature: result.signature, promise: confirmPromise };
        }
      }
    } else {
      console.log(`✗`);
      failCount++;
      if (result.error) {
        console.error(`Error: ${result.error}`);
      }
    }
  }

  // Wait for all confirmations to complete
  const confirmationResults = await Promise.all(
    pendingConfirmations.map(async ({ signature, promise }) => ({
      signature,
      confirmed: await promise
    }))
  );

  const confirmedCount = confirmationResults.filter(r => r.confirmed).length;
  const unconfirmedCount = confirmationResults.length - confirmedCount;

  console.log(`\n✓ Complete`);
  console.log(`  Executed: ${successCount} trades`);
  console.log(`  Confirmed: ${confirmedCount}/${pendingConfirmations.length}`);
  if (unconfirmedCount > 0) {
    console.log(`  Failed to confirm: ${unconfirmedCount}`);
  }
  if (failCount > 0) {
    console.log(`  Failed: ${failCount}`);
  }
  console.log();

  // Cleanup bot
  await bot.stop();
  process.exit(0);
}

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
  process.exit(1);
});

main().catch(error => {
  console.error('\nError:', error.message);
  process.exit(1);
});
