import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Detector } from './detector';
import { TradeParser } from './parser';
import { PumpFunTxBuilder } from './pumpfun-tx';
import { PumpSwapTxBuilder } from './pumpswap-tx';
import { TransactionExecutor } from './executor';
import { Metrics } from './utils/metrics';
import { Logger } from './utils/logger';
import { appConfig } from './config/config';
import bs58 from 'bs58';
import fs from 'fs';
import path from 'path';

// Parse CLI arguments
const args = process.argv.slice(2);
const walletsArg = args.find(a => a.startsWith('--wallets='));
const modeArg = args.find(a => a.startsWith('--mode='));

const mode = (modeArg?.split('=')[1] || appConfig.mode) as 'simulate' | 'live';

// Priority 1: Check if bot wallet is configured and valid
if (!appConfig.wallet?.privateKey) {
  console.error('✗ No bot wallet configured');
  console.error('  Solution: Set BOT_WALLET_PRIVATE_KEY in .env');
  process.exit(1);
}

try {
  Keypair.fromSecretKey(bs58.decode(appConfig.wallet.privateKey));
} catch (error) {
  console.error('✗ Invalid BOT_WALLET_PRIVATE_KEY format');
  console.error('  Solution: Provide valid base58 encoded private key');
  process.exit(1);
}

// Priority 2: Determine watch wallets with fallback logic
let watchWallets: string[] = [];
let usingSourceWallet = false;

if (walletsArg) {
  // Priority 1: CLI argument
  watchWallets = walletsArg.split('=')[1].split(',').map(w => w.trim()).filter(w => w.length > 0);
} else if (appConfig.trading.watchWallets && appConfig.trading.watchWallets.length > 0) {
  // Priority 2: WATCH_WALLETS from .env
  watchWallets = appConfig.trading.watchWallets;
} else if (appConfig.testing.sourceWalletPrivateKey) {
  // Priority 3: Derive from SOURCE_WALLET_PRIVATE_KEY
  try {
    const sourceKeypair = Keypair.fromSecretKey(bs58.decode(appConfig.testing.sourceWalletPrivateKey));
    watchWallets = [sourceKeypair.publicKey.toBase58()];
    usingSourceWallet = true;
  } catch (error) {
    console.error('✗ Invalid SOURCE_WALLET_PRIVATE_KEY format');
    console.error('  Solution: Provide valid base58 encoded private key');
    process.exit(1);
  }
}

// Validate we have at least one wallet
if (watchWallets.length === 0) {
  console.error('✗ No wallets configured');
  console.error('  Solution: Add wallets via one of these methods:');
  console.error('  1. CLI: npm run bot -- --wallets=YOUR_WALLET_ADDRESS');
  console.error('  2. ENV: Set WATCH_WALLETS in .env');
  console.error('  3. TEST: Set SOURCE_WALLET_PRIVATE_KEY in .env');
  process.exit(1);
}

// Validate addresses
for (const wallet of watchWallets) {
  try {
    new PublicKey(wallet);
  } catch {
    console.error(`✗ Invalid wallet address: ${wallet}`);
    console.error('  Solution: Provide valid Solana public key');
    process.exit(1);
  }
}

// Validate mode
if (!['simulate', 'live'].includes(mode)) {
  console.error(`✗ Invalid mode: ${mode}`);
  console.error('  Solution: Use --mode=simulate or --mode=live');
  process.exit(1);
}

// Pre-flight validation
async function validateStartup(): Promise<void> {
  const connection = new Connection(appConfig.rpc.endpoint);

  // Test RPC
  try {
    await connection.getLatestBlockhash();
  } catch (error: any) {
    console.error('✗ RPC connection failed');
    console.error(`  Error: ${error.message}`);
    console.error('  Solution: Check HELIUS_RPC_ENDPOINT in .env');
    process.exit(1);
  }

  // Test bot wallet balance
  if (!appConfig.wallet?.privateKey) {
    console.error('✗ Bot wallet not configured');
    console.error('  Solution: Set BOT_WALLET_PRIVATE_KEY in .env');
    process.exit(1);
  }

  const botKeypair = Keypair.fromSecretKey(bs58.decode(appConfig.wallet.privateKey));
  const balance = await connection.getBalance(botKeypair.publicKey);
  const balanceSol = balance / 1e9;

  const minBalance = appConfig.trading?.minBalance || 0.1;
  if (balanceSol < minBalance) {
    console.error(`✗ Insufficient bot wallet balance: ${balanceSol.toFixed(4)} SOL`);
    console.error(`  Minimum required: ${minBalance} SOL`);
    console.error('  Solution: Fund bot wallet');
    process.exit(1);
  }
}

// Main
async function main() {
  await validateStartup();

  // Setup session
  const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const logsDir = path.join(__dirname, '../logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const logger = new Logger(path.join(logsDir, `bot-${sessionId}.log`));
  const metrics = new Metrics(mode);

  // Initialize components
  const connection = new Connection(appConfig.rpc.endpoint, { commitment: appConfig.rpc.commitment });
  const botKeypair = Keypair.fromSecretKey(bs58.decode(appConfig.wallet.privateKey));
  const botBalance = (await connection.getBalance(botKeypair.publicKey)) / 1e9;

  const detector = new Detector();
  const parser = new TradeParser();
  const pumpFunBuilder = new PumpFunTxBuilder();
  const pumpSwapBuilder = new PumpSwapTxBuilder();
  const executor = new TransactionExecutor();

  await pumpFunBuilder.initialize();

  // Circuit breaker state
  let consecutiveFailures = 0;
  let circuitBreakerActive = false;
  let inflightTrades = 0;

  // Print banner
  console.log(mode === 'simulate' ? '🤖 COPYTRADING BOT - SIMULATE MODE' : '🤖 COPYTRADING BOT - LIVE MODE');
  console.log('═'.repeat(60));
  if (mode === 'simulate') {
    console.log('⚠️  Transactions will NOT be executed');
  }
  if (usingSourceWallet) {
    console.log('ℹ️  Using configured source wallet');
  }
  console.log();
  console.log(`Mode:        ${mode.toUpperCase()}`);
  console.log(`Wallets:     ${watchWallets.map(w => `${w.slice(0, 4)}...${w.slice(-4)}`).join(', ')} (${watchWallets.length} total)`);
  console.log(`Bot Wallet:  ${botKeypair.publicKey.toBase58().slice(0, 4)}...${botKeypair.publicKey.toBase58().slice(-4)} (${botBalance.toFixed(2)} SOL)`);
  console.log(`Protocols:   pump.fun ✓  PumpSwap ✓`);
  console.log(`Log File:    ./logs/bot-${sessionId}.log`);
  console.log();
  console.log('═'.repeat(60));
  console.log('Listening for trades...\n');

  // Trade handler
  detector.onTransaction(async (tx) => {
    // Circuit breaker check
    if (circuitBreakerActive) return;

    inflightTrades++;

    try {
      // Parse
      const parseResult = parser.parse(tx);

      if (!parseResult.success) {
        if ('filtered' in parseResult && parseResult.filtered) {
          metrics.recordFiltered();

          // Log filtered trades for visibility (skip token creations)
          if (parseResult.reason !== 'token_creation') {
            const protocol = tx.protocol === 'PUMP_FUN' ? 'pump.fun' : 'PumpSwap';
            logger.warn(`Filtered ${protocol} trade (below minimum ${appConfig.trading.minTradeAmountSol} SOL) - Sig: ${tx.signature.slice(0, 8)}...`);
          }
        } else if ('error' in parseResult && parseResult.error) {
          // Parse error - try to infer protocol from transaction for metrics
          const protocol = tx.protocol === 'PUMP_FUN' ? 'pumpfun' : 'pumpswap';
          handleFailure(protocol, parseResult.error);
        }
        return;
      }

      const parsed = parseResult.data!;

      // Record detection
      const protocol = parsed.protocol === 'PUMP_FUN' ? 'pumpfun' : 'pumpswap';
      metrics.recordDetection(protocol);

      // Log detection
      logger.trade({
        phase: 'DETECTED',
        protocol,
        type: parsed.type.toLowerCase() as 'buy' | 'sell',
        mint: parsed.mint,
        pool: parsed.pool
      });

      // Route to correct builder
      const builder = parsed.protocol === 'PUMP_FUN' ? pumpFunBuilder : pumpSwapBuilder;

      // Build transaction
      const buildStart = Date.now();
      const buildResult = await builder.buildTransactionWithTiming(parsed);
      const buildTime = Date.now() - buildStart;

      if (!buildResult.success) {
        handleFailure(protocol, buildResult.error || 'Build failed');
        return;
      }

      // SIMULATE MODE
      if (mode === 'simulate') {
        const copyAmount = parsed.type === 'BUY'
          ? (protocol === 'pumpfun' ? appConfig.trading.protocols.pumpFun.buyAmountSol : appConfig.trading.protocols.pumpSwap.buyAmountSol)
          : -1; // -1 represents "ALL tokens" for sells

        logger.trade({
          phase: 'SIMULATE',
          protocol,
          type: parsed.type.toLowerCase() as 'buy' | 'sell',
          buildTime,
          copyAmount
        });
        metrics.recordSuccess(protocol, buildTime);
        consecutiveFailures = 0;
        return;
      }

      // LIVE MODE - Execute
      const execStart = Date.now();
      const execResult = await executor.executeTransactionWithTiming(
        buildResult.transaction!,
        builder.getBotKeypair(),
        { blockhash: buildResult.blockhash }
      );
      const execTime = Date.now() - execStart;

      if (execResult.success) {
        const copyAmount = parsed.type === 'BUY'
          ? (protocol === 'pumpfun' ? appConfig.trading.protocols.pumpFun.buyAmountSol : appConfig.trading.protocols.pumpSwap.buyAmountSol)
          : -1; // -1 represents "ALL tokens" for sells

        logger.trade({
          phase: 'SUCCESS',
          protocol,
          type: parsed.type.toLowerCase() as 'buy' | 'sell',
          copyAmount,
          buildTime,
          execTime,
          signature: execResult.signature
        });
        metrics.recordSuccess(protocol, buildTime, execTime);
        consecutiveFailures = 0;
      } else {
        handleFailure(protocol, execResult.error || 'Execution failed');
      }

    } finally {
      inflightTrades--;
    }
  });

  function handleFailure(protocol: 'pumpfun' | 'pumpswap', error: string) {
    consecutiveFailures++;
    logger.error(`✗ Trade failed (${consecutiveFailures}/5): ${error}`);
    metrics.recordFailure(protocol, error);

    if (consecutiveFailures >= 5) {
      circuitBreakerActive = true;
      logger.error('🚨 CIRCUIT BREAKER TRIGGERED - Stopping bot');
      logger.error('   5 consecutive failures detected');
      shutdown();
    }
  }

  // Start detector
  await detector.start(watchWallets);

  // Shutdown handler
  let isShuttingDown = false;

  async function shutdown() {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\nShutting down gracefully...');

    // Stop detector
    detector.stop();

    // Wait for in-flight trades (max 5 seconds)
    let waitTime = 0;
    while (inflightTrades > 0 && waitTime < 5000) {
      await new Promise(resolve => setTimeout(resolve, 100));
      waitTime += 100;
    }

    if (inflightTrades > 0) {
      console.log(`Warning: ${inflightTrades} trades still in-flight after 5s`);
    }

    // Cleanup builders
    pumpFunBuilder.cleanup();
    if (typeof (pumpSwapBuilder as any).cleanup === 'function') {
      (pumpSwapBuilder as any).cleanup();
    }

    // Print and save metrics
    console.log();
    metrics.printSummary();

    const sessionFile = path.join(logsDir, `session-${sessionId}.json`);
    metrics.saveToFileSync(sessionFile);
    console.log(`\nSession saved to: ${sessionFile}\n`);

    // Close logger
    logger.close();

    process.exit(0);
  }

  // Signal handlers
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Uncaught exception handler
  process.on('uncaughtException', (error) => {
    logger.error(`FATAL: ${error.message}`);
    logger.error(error.stack || '');
    const crashFile = path.join(logsDir, `crash-${sessionId}.json`);
    metrics.saveToFileSync(crashFile);
    console.error(`\nCrash report saved to: ${crashFile}`);
    process.exit(1);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
