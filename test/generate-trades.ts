import 'dotenv/config';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PumpFunSDK } from '../src/pumpfun-sdk/PumpFunSDK';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import { appConfig } from '../src/config/config';
import bs58 from 'bs58';
import BN from 'bn.js';
import fs from 'fs';
import path from 'path';

// Sell amount: always 10% of balance
function getSellAmount(balance: bigint): bigint {
  return (balance * 10n) / 100n;
}

// CLI parsing
const args = process.argv.slice(2);
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

Usage: npm run trades -- [pattern] [options]

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
  npm run trades -- buy                              (pump.fun buy, creates token)
  npm run trades -- buy --pumpfun --amount=0.05      (pump.fun buy 0.05 SOL)
  npm run trades -- buy --pumpswap                   (PumpSwap buy, finds pool)
  npm run trades -- sell --token=7YPL...3mK8         (pump.fun sell 10%)
  npm run trades -- sell --pool=Pool9xKm...          (PumpSwap sell 10%)
  npm run trades -- buysell --pumpswap               (PumpSwap buy then sell)

NOTES:
  - Sells always sell 10% of balance
  - The '--' is required to pass arguments through npm
  - If no protocol specified, defaults to pump.fun
`);
}

async function createFreshToken(sdk: PumpFunSDK, wallet: Keypair): Promise<string | undefined> {
  const mint = Keypair.generate();
  const blob = new Blob([Buffer.from([0x89, 0x50, 0x4E, 0x47])], { type: 'image/png' });

  try {
    await sdk.trade.createAndBuy(
      wallet,
      mint,
      {
        name: `TEST${Date.now() % 1000}`,
        symbol: "TEST",
        description: "Test token",
        file: blob
      },
      BigInt(0.0001 * 1e9),
      500n,
      { unitLimit: 300_000, unitPrice: 250_000 }
    );

    return mint.publicKey.toBase58();
  } catch (error: any) {
    return undefined;
  }
}

const POOL_CACHE_FILE = path.join(__dirname, '../data/pumpswap-pool.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const PUMPSWAP_MIN_POOL = 20; // SOL
const PUMPSWAP_MAX_POOL = 100; // SOL

async function findPumpSwapPool(connection: Connection): Promise<{ pool: string; baseMint: string; liquidity: number } | undefined> {
  const PUMPSWAP_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
  const NATIVE_MINT = new PublicKey('So11111111111111111111111111111111111111112');
  const MIN = PUMPSWAP_MIN_POOL * LAMPORTS_PER_SOL;
  const MAX = PUMPSWAP_MAX_POOL * LAMPORTS_PER_SOL;

  // Try to load from cache
  try {
    if (fs.existsSync(POOL_CACHE_FILE)) {
      const cacheData = JSON.parse(fs.readFileSync(POOL_CACHE_FILE, 'utf-8'));
      const cacheAge = Date.now() - cacheData.timestamp;

      if (cacheAge < CACHE_MAX_AGE_MS) {
        const poolPubkey = new PublicKey(cacheData.pool);
        const poolQuoteTokenAccount = getAssociatedTokenAddressSync(NATIVE_MINT, poolPubkey, true);

        const quoteInfo = await connection.getAccountInfo(poolQuoteTokenAccount);
        if (quoteInfo) {
          const poolQuoteAmount = quoteInfo.data.readBigUInt64LE(64);
          if (poolQuoteAmount >= MIN && poolQuoteAmount <= MAX) {
            const quoteSol = Number(poolQuoteAmount) / LAMPORTS_PER_SOL;
            return { pool: cacheData.pool, baseMint: cacheData.baseMint, liquidity: quoteSol };
          }
        }
      }
    }
  } catch {}

  // Search for valid pool
  const accounts = await connection.getProgramAccounts(PUMPSWAP_PROGRAM_ID, {
    filters: [{ dataSize: 300 }]
  });

  for (const { pubkey, account } of accounts) {
    const discriminator = account.data.subarray(0, 8);
    const expected = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
    if (!discriminator.equals(expected)) continue;

    const baseMintOffset = 8 + 1 + 2 + 32;
    const baseMint = new PublicKey(account.data.subarray(baseMintOffset, baseMintOffset + 32));

    try {
      const poolBaseTokenAccount = getAssociatedTokenAddressSync(baseMint, pubkey, true);
      const poolQuoteTokenAccount = getAssociatedTokenAddressSync(NATIVE_MINT, pubkey, true);
      const [baseInfo, quoteInfo] = await connection.getMultipleAccountsInfo([
        poolBaseTokenAccount,
        poolQuoteTokenAccount
      ]);

      if (!baseInfo || !quoteInfo) continue;

      const poolQuoteAmount = quoteInfo.data.readBigUInt64LE(64);
      if (poolQuoteAmount >= MIN && poolQuoteAmount <= MAX) {
        const quoteSol = Number(poolQuoteAmount) / LAMPORTS_PER_SOL;

        // Save to cache
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) {
          fs.mkdirSync(dataDir, { recursive: true });
        }

        const cacheData = {
          pool: pubkey.toBase58(),
          baseMint: baseMint.toBase58(),
          liquidity: quoteSol,
          timestamp: Date.now()
        };
        fs.writeFileSync(POOL_CACHE_FILE, JSON.stringify(cacheData, null, 2));

        return { pool: pubkey.toBase58(), baseMint: baseMint.toBase58(), liquidity: quoteSol };
      }
    } catch {}
  }

  return undefined;
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
  timeoutMs: number = 30000
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
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2s interval to reduce RPC load
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
  sdk: PumpFunSDK,
  pumpSwapSdk: OnlinePumpAmmSdk,
  wallet: Keypair,
  connection: Connection
): Promise<{ success: boolean; error?: string; signature?: string }> {
  try {
    if (targetProtocol === 'pumpfun') {
      const mint = new PublicKey(token);

      if (type === 'buy') {
        const amountLamports = BigInt((amount || 0.01) * 1e9);

        const result = await sdk.trade.buy(
          wallet,
          mint,
          amountLamports,
          500n,
          { unitLimit: 300_000, unitPrice: 250_000 }
        );

        return { success: true, signature: result.signature };
      } else {
        // Get current balance
        const balance = await getTokenBalance(connection, wallet, mint);

        if (balance === 0n) {
          throw new Error('No tokens to sell');
        }

        // Sell 10% of balance
        const sellAmount = getSellAmount(balance);

        const result = await sdk.trade.sell(
          wallet,
          mint,
          sellAmount,
          500n,
          { unitLimit: 300_000, unitPrice: 250_000 }
        );

        return { success: true, signature: result.signature };
      }
    } else {
      // PumpSwap
      if (!pool) {
        throw new Error('Pool address required for PumpSwap trades');
      }

      const poolPubkey = new PublicKey(pool);
      const swapState = await pumpSwapSdk.swapSolanaState(poolPubkey, wallet.publicKey);
      const baseMint = swapState.baseMint;

      if (type === 'buy') {
        const buyInstructions = await PUMP_AMM_SDK.buyQuoteInput(
          swapState,
          new BN(Math.floor((amount || 0.002) * LAMPORTS_PER_SOL)),
          10
        );

        const tx = new Transaction();
        buyInstructions.forEach(ix => tx.add(ix));
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        tx.sign(wallet);

        const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });

        return { success: true, signature };

      } else {
        // Get balance
        const balance = await getTokenBalance(connection, wallet, baseMint);

        if (balance === 0n) {
          throw new Error('No tokens to sell');
        }

        // Sell 10% of balance
        const sellAmount = getSellAmount(balance);

        const sellInstructions = await PUMP_AMM_SDK.sellBaseInput(
          swapState,
          new BN(sellAmount.toString()),
          10
        );

        const tx = new Transaction();
        sellInstructions.forEach(ix => tx.add(ix));
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;
        tx.sign(wallet);

        const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });

        return { success: true, signature };
      }
    }
  } catch (error: any) {
    return { success: false, error: error.message };
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
      console.error('  Example: npm run trades -- sell --token=YOUR_TOKEN\n');
      process.exit(1);
    }
    if (protocol === 'pumpswap' && !poolArg) {
      console.error('\n✗ Sell requires --pool for PumpSwap');
      console.error('  Example: npm run trades -- sell --pumpswap --pool=YOUR_POOL\n');
      process.exit(1);
    }
  }

  // Setup connection and wallet (minimal, for balance check)
  const connection = new Connection(appConfig.rpc.endpoint);
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
    const stepAmount = step.amount || (amountArg ? parseFloat(amountArg) : 0.01);
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

  // Create SDKs (expensive initialization)
  const provider = new AnchorProvider(connection, new Wallet(wallet), { commitment: "processed" });
  const sdk = new PumpFunSDK(provider);
  const pumpSwapSdk = new OnlinePumpAmmSdk(connection);

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
    pumpFunToken = await createFreshToken(sdk, wallet);
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
    pumpSwapPool = poolInfo.pool;
    pumpSwapToken = poolInfo.baseMint;
    console.log(`✓ ${poolInfo.pool.slice(0, 8)}... (${poolInfo.liquidity.toFixed(1)} SOL)`);
  }

  // Show pattern
  console.log(`\nPattern: ${command || 'buysell'}`);
  const opts = [];
  if (tokenArg) opts.push(`token=${tokenArg.slice(0, 8)}...`);
  if (poolArg) opts.push(`pool=${poolArg.slice(0, 8)}...`);
  if (amountArg) opts.push(`amount=${amountArg}`);
  if (opts.length > 0) console.log(`Options: ${opts.join(', ')}`);
  console.log();

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

    const tradeAmount = step.amount || (amountArg ? parseFloat(amountArg) : undefined);
    const amountStr = step.type === 'buy'
      ? `${tradeAmount || 0.01} SOL`
      : '10%';

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
      sdk,
      pumpSwapSdk,
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
}

main().catch(error => {
  console.error('\nError:', error.message);
  process.exit(1);
});
