import 'dotenv/config';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { Detector } from '../src/detector';
import { TradeParser } from '../src/parser';
import { PumpFunTxBuilder } from '../src/pumpfun-tx';
import { PumpSwapTxBuilder } from '../src/pumpswap-tx';
import { TransactionExecutor } from '../src/executor';
import { appConfig } from '../src/config/config';
import {
  calculateStats,
  calculateStatsWithDecimal,
  getTransactionSlot,
  findPumpSwapPool,
  createTestToken,
  executePumpFunBuy,
  executePumpFunSell,
  executePumpSwapBuy,
  executePumpSwapSell
} from '../src/utils/test-utils';
import { DEFAULTS, AMOUNTS, TIMEOUTS } from '../src/config/test-constants';
import bs58 from 'bs58';

interface TradeResult {
  latency: number;
  detection: number;
  parsing: number;
  building: number;
  execution: number;
  sourceSignature?: string;
  copySignature?: string;
}

interface PendingConfirmation {
  cycleNum: number;
  protocol: 'PUMP_FUN' | 'PUMP_SWAP';
  type: 'BUY' | 'SELL';
  processingTimeMs: number;
  promise: Promise<{ sourceSlot: number; copySlot: number; blockDistance: number } | null>;
}

interface FailedTrade {
  cycle: number;
  protocol: string;
  type: 'BUY' | 'SELL';
  error: string;
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
        return false;
      }
    } catch (error) {
      // Silently retry on RPC errors
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return false;
}

async function executeCycle(
  protocol: 'PUMP_FUN' | 'PUMP_SWAP',
  cycleNum: number,
  connection: Connection,
  sourceWallet: Keypair,
  detector: Detector,
  parser: TradeParser,
  builder: PumpFunTxBuilder | PumpSwapTxBuilder,
  executor: TransactionExecutor,
  testMint: string | null,
  poolInfo: any
): Promise<{ buy: TradeResult | null; sell: TradeResult | null; buyError?: string; sellError?: string }> {
  
  let buyResult: TradeResult | null = null;
  let sellResult: TradeResult | null = null;

  // BUY
  let buyError: string | undefined;
  const buyPromise = new Promise<TradeResult | null>((resolve) => {
    let processing = false;
    let sourceSignature: string | null = null;

    const handler = async (tx: any) => {
      if (processing || tx.protocol !== protocol) return;
      processing = true;  // Set synchronously before await

      const parseStart = Date.now();
      const parseResult = parser.parse(tx);

      if (!parseResult.success) {
        if ('error' in parseResult) {
          buyError = parseResult.error;
          resolve(null);
        } else {
          processing = false;  // Reset if filtered
        }
        return; // Filtered or error
      }

      if (parseResult.data.type !== 'BUY') {
        processing = false;  // Reset if wrong type
        return;
      }

      // Store the source signature from the detected transaction
      if (!sourceSignature) {
        sourceSignature = tx.signature;
      }

      const parsed = parseResult.data;
      const parseEnd = Date.now();
      const parsing = parseEnd - parseStart;

      try {
        const detection = tx.processedTimestamp - tx.receivedTimestamp;

        const buildResult = await builder.buildTransactionWithTiming(parsed);
        if (!buildResult.success || !buildResult.timing) {
          buyError = buildResult.error || 'Build failed';
          resolve(null);
          return;
        }

        const executeResult = await executor.executeTransactionWithTiming(
          buildResult.transaction!,
          builder.getBotKeypair(),
          { blockhash: buildResult.blockhash }
        );

        if (!executeResult.success || !executeResult.timing || !executeResult.signature) {
          buyError = executeResult.error || 'Execution failed';
          resolve(null);
          return;
        }

        const building = buildResult.timing.total;
        const execution = executeResult.timing.total;

        resolve({
          latency: detection + parsing + building + execution,
          detection,
          parsing,
          building,
          execution,
          sourceSignature: sourceSignature!,
          copySignature: executeResult.signature
        });
      } catch (error) {
        buyError = error instanceof Error ? error.message : 'Unknown error';
        resolve(null);
      }
    };

    detector.onTransaction(handler);

    // Execute source trade
    if (protocol === 'PUMP_FUN') {
      executePumpFunBuy(
        connection,
        sourceWallet,
        new PublicKey(testMint!),
        AMOUNTS.PUMP_FUN_BUY_SOL
      ).then((sig) => {
        sourceSignature = sig;
      }).catch((error) => {
        console.error(`Buy operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        buyError = `Source transaction failed: ${error instanceof Error ? error.message : error}`;
        resolve(null);
      });
    } else {
      executePumpSwapBuy(
        connection,
        sourceWallet,
        poolInfo.pool,
        AMOUNTS.PUMP_SWAP_BUY_SOL
      ).then((sig) => {
        sourceSignature = sig;
      }).catch((error) => {
        console.error(`Buy operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        resolve(null);
      });
    }

    setTimeout(() => {
      if (!processing) {
        processing = true;
        buyError = `Timeout: No transaction detected after ${TIMEOUTS.DETECTION_MS / 1000}s`;
        resolve(null);
      }
    }, TIMEOUTS.DETECTION_MS);
  });

  buyResult = await buyPromise;
  if (!buyResult) return { buy: null, sell: null, buyError, sellError: undefined };

  // Wait for source buy transaction to confirm before executing sell
  if (!buyResult.sourceSignature) {
    return { buy: buyResult, sell: null, buyError, sellError: 'No source signature to wait for' };
  }

  const confirmed = await waitForConfirmation(connection, buyResult.sourceSignature);
  if (!confirmed) {
    return { buy: buyResult, sell: null, buyError, sellError: 'Source buy failed to confirm' };
  }

  // SELL
  let sellError: string | undefined;
  const sellPromise = new Promise<TradeResult | null>((resolve) => {
    let processing = false;
    let sourceSignature: string | null = null;

    const handler = async (tx: any) => {
      if (processing || tx.protocol !== protocol) return;
      processing = true;  // Set synchronously before await

      const parseStart = Date.now();
      const parseResult = parser.parse(tx);

      if (!parseResult.success) {
        if ('error' in parseResult) {
          sellError = parseResult.error;
          resolve(null);
        } else {
          processing = false;  // Reset if filtered
        }
        return; // Filtered or error
      }

      if (parseResult.data.type !== 'SELL') {
        processing = false;  // Reset if wrong type
        return;
      }

      // Store the source signature from the detected transaction
      if (!sourceSignature) {
        sourceSignature = tx.signature;
      }

      const parsed = parseResult.data;
      const parseEnd = Date.now();
      const parsing = parseEnd - parseStart;

      try {
        const detection = tx.processedTimestamp - tx.receivedTimestamp;

        const buildResult = await builder.buildTransactionWithTiming(parsed);
        if (!buildResult.success || !buildResult.timing) {
          sellError = buildResult.error || 'Build failed';
          resolve(null);
          return;
        }

        const executeResult = await executor.executeTransactionWithTiming(
          buildResult.transaction!,
          builder.getBotKeypair(),
          { blockhash: buildResult.blockhash }
        );

        if (!executeResult.success || !executeResult.timing || !executeResult.signature) {
          sellError = executeResult.error || 'Execution failed';
          resolve(null);
          return;
        }

        resolve({
          latency: detection + parsing + buildResult.timing.total + executeResult.timing.total,
          detection,
          parsing,
          building: buildResult.timing.total,
          execution: executeResult.timing.total,
          sourceSignature: sourceSignature!,
          copySignature: executeResult.signature
        });
      } catch (error) {
        sellError = error instanceof Error ? error.message : 'Unknown error';
        resolve(null);
      }
    };

    detector.onTransaction(handler);

    // Execute source sell
    if (protocol === 'PUMP_FUN') {
      connection.getTokenAccountsByOwner(
        sourceWallet.publicKey,
        { mint: new PublicKey(testMint!) }
      ).then(async (accounts) => {
        if (accounts.value.length === 0) return resolve(null);
        const balance = accounts.value[0].account.data.readBigUInt64LE(64);
        if (balance === 0n) return resolve(null);

        const sellAmount = (balance * BigInt(AMOUNTS.SELL_PERCENTAGE * 100)) / 100n;
        await executePumpFunSell(
          connection,
          sourceWallet,
          new PublicKey(testMint!),
          sellAmount
        );
      }).catch((error) => {
        console.error(`Sell operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        sellError = `Source transaction failed: ${error instanceof Error ? error.message : error}`;
        resolve(null);
      });
    } else {
      connection.getTokenAccountsByOwner(
        sourceWallet.publicKey,
        { mint: poolInfo.baseMint }
      ).then(async (accounts) => {
        if (accounts.value.length === 0) return resolve(null);
        const balance = accounts.value[0].account.data.readBigUInt64LE(64);
        if (balance === 0n) return resolve(null);

        const sellAmount = (balance * BigInt(AMOUNTS.SELL_PERCENTAGE * 100)) / 100n;
        const sig = await executePumpSwapSell(
          connection,
          sourceWallet,
          poolInfo.pool,
          sellAmount.toString()
        );
        sourceSignature = sig;
      }).catch((error) => {
        console.error(`Sell operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        sellError = `Source transaction failed: ${error instanceof Error ? error.message : error}`;
        resolve(null);
      });
    }

    setTimeout(() => {
      if (!processing) {
        processing = true;
        sellError = `Timeout: No transaction detected after ${TIMEOUTS.DETECTION_MS / 1000}s`;
        resolve(null);
      }
    }, TIMEOUTS.DETECTION_MS);
  });

  sellResult = await sellPromise;
  return { buy: buyResult, sell: sellResult, buyError, sellError };
}

async function main() {
  const startTime = Date.now();

  console.log('COPYTRADING BOT DEMO');
  console.log('━'.repeat(60));

  const connection = new Connection(appConfig.rpc.endpoint, { commitment: appConfig.rpc.commitment });

  if (!appConfig.testing?.sourceWalletPrivateKey) {
    console.error('SOURCE_WALLET_PRIVATE_KEY required for demo');
    process.exit(1);
  }

  const sourceWallet = Keypair.fromSecretKey(bs58.decode(appConfig.testing.sourceWalletPrivateKey));
  const detector = new Detector();
  const parser = new TradeParser();
  const pumpFunBuilder = new PumpFunTxBuilder();
  const pumpSwapBuilder = new PumpSwapTxBuilder();
  const executor = new TransactionExecutor();

  // Suppress initialization logs
  const suppressLog = () => {};
  const originalLog = console.log;

  console.log = suppressLog;
  await pumpFunBuilder.initialize();
  console.log = originalLog;

  const sourceBalance = await connection.getBalance(sourceWallet.publicKey);
  const botBalance = await pumpFunBuilder.getBalance();

  console.log('\nSetup:');
  console.log(`  Source wallet: ${sourceWallet.publicKey.toBase58().slice(0, 4)}...${sourceWallet.publicKey.toBase58().slice(-4)} (${(sourceBalance / 1e9).toFixed(2)} SOL)`);
  console.log(`  Bot wallet:    ${pumpFunBuilder.getBotKeypair().publicKey.toBase58().slice(0, 4)}...${pumpFunBuilder.getBotKeypair().publicKey.toBase58().slice(-4)} (${botBalance.toFixed(2)} SOL)`);

  process.stdout.write('\nCreating pump.fun token... ');
  const testMint = await createTestToken(connection, sourceWallet);
  if (!testMint) {
    console.log('FAILED');
    process.exit(1);
  }
  console.log(`${testMint.slice(0, 4)}...${testMint.slice(-4)}`);

  process.stdout.write('Finding PumpSwap pool... ');
  const poolInfo = await findPumpSwapPool(connection);
  if (!poolInfo) {
    console.log('FAILED');
    process.exit(1);
  }
  console.log(`${poolInfo.pool.toBase58().slice(0, 4)}...${poolInfo.pool.toBase58().slice(-4)} (${poolInfo.liquidity.toFixed(1)} SOL liquidity)`);

  // Start detector silently
  console.log = suppressLog;
  await detector.start([sourceWallet.publicKey.toBase58()]);
  console.log = originalLog;

  // Wait for Laserstream connection to stabilize
  await new Promise(resolve => setTimeout(resolve, 5000));

  const pendingConfirmations: PendingConfirmation[] = [];
  const failedTrades: FailedTrade[] = [];

  // PUMP.FUN
  console.log('\n' + '━'.repeat(60));
  console.log(`\nPUMP.FUN TEST (${DEFAULTS.NUM_CYCLES} cycles)\n`);

  const pumpFunBuys: TradeResult[] = [];
  const pumpFunSells: TradeResult[] = [];

  for (let i = 1; i <= DEFAULTS.NUM_CYCLES; i++) {
    process.stdout.write(`Cycle ${i}: `);
    const result = await executeCycle(
      'PUMP_FUN', i, connection, sourceWallet, detector, parser,
      pumpFunBuilder, executor, testMint, null
    );

    if (result.buy) {
      pumpFunBuys.push(result.buy);
      process.stdout.write(`BUY ${result.buy.latency}ms ✓  `);

      // Queue confirmation check
      if (result.buy.sourceSignature && result.buy.copySignature) {
        const confirmationPromise = Promise.all([
          getTransactionSlot(connection, result.buy.sourceSignature),
          getTransactionSlot(connection, result.buy.copySignature)
        ]).then(([sourceSlot, copySlot]) =>
          sourceSlot && copySlot
            ? { sourceSlot, copySlot, blockDistance: copySlot - sourceSlot }
            : null
        );

        pendingConfirmations.push({
          cycleNum: i,
          protocol: 'PUMP_FUN',
          type: 'BUY',
          processingTimeMs: result.buy.latency,
          promise: confirmationPromise
        });
      }
    } else {
      process.stdout.write(`BUY FAIL  `);
      failedTrades.push({
        cycle: i,
        protocol: 'PUMP.FUN',
        type: 'BUY',
        error: result.buyError || 'Unknown error'
      });
    }

    if (result.sell) {
      pumpFunSells.push(result.sell);
      process.stdout.write(`SELL ${result.sell.latency}ms ✓\n`);

      // Queue confirmation check
      if (result.sell.sourceSignature && result.sell.copySignature) {
        const confirmationPromise = Promise.all([
          getTransactionSlot(connection, result.sell.sourceSignature),
          getTransactionSlot(connection, result.sell.copySignature)
        ]).then(([sourceSlot, copySlot]) =>
          sourceSlot && copySlot
            ? { sourceSlot, copySlot, blockDistance: copySlot - sourceSlot }
            : null
        );

        pendingConfirmations.push({
          cycleNum: i,
          protocol: 'PUMP_FUN',
          type: 'SELL',
          processingTimeMs: result.sell.latency,
          promise: confirmationPromise
        });
      }
    } else {
      process.stdout.write(`SELL FAIL\n`);
      failedTrades.push({
        cycle: i,
        protocol: 'PUMP.FUN',
        type: 'SELL',
        error: result.sellError || 'Unknown error'
      });
    }

    if (i < DEFAULTS.NUM_CYCLES) await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // PUMPSWAP
  console.log(`\nPUMPSWAP TEST (${DEFAULTS.NUM_CYCLES} cycles)\n`);

  const pumpSwapBuys: TradeResult[] = [];
  const pumpSwapSells: TradeResult[] = [];

  for (let i = 1; i <= DEFAULTS.NUM_CYCLES; i++) {
    process.stdout.write(`Cycle ${i}: `);
    const result = await executeCycle(
      'PUMP_SWAP', i, connection, sourceWallet, detector, parser,
      pumpSwapBuilder, executor, null, poolInfo
    );

    if (result.buy) {
      pumpSwapBuys.push(result.buy);
      process.stdout.write(`BUY ${result.buy.latency}ms ✓  `);

      // Queue confirmation check
      if (result.buy.sourceSignature && result.buy.copySignature) {
        const confirmationPromise = Promise.all([
          getTransactionSlot(connection, result.buy.sourceSignature),
          getTransactionSlot(connection, result.buy.copySignature)
        ]).then(([sourceSlot, copySlot]) =>
          sourceSlot && copySlot
            ? { sourceSlot, copySlot, blockDistance: copySlot - sourceSlot }
            : null
        );

        pendingConfirmations.push({
          cycleNum: i,
          protocol: 'PUMP_SWAP',
          type: 'BUY',
          processingTimeMs: result.buy.latency,
          promise: confirmationPromise
        });
      }
    } else {
      process.stdout.write(`BUY FAIL  `);
      failedTrades.push({
        cycle: i,
        protocol: 'PUMPSWAP',
        type: 'BUY',
        error: result.buyError || 'Unknown error'
      });
    }

    if (result.sell) {
      pumpSwapSells.push(result.sell);
      process.stdout.write(`SELL ${result.sell.latency}ms ✓\n`);

      // Queue confirmation check
      if (result.sell.sourceSignature && result.sell.copySignature) {
        const confirmationPromise = Promise.all([
          getTransactionSlot(connection, result.sell.sourceSignature),
          getTransactionSlot(connection, result.sell.copySignature)
        ]).then(([sourceSlot, copySlot]) =>
          sourceSlot && copySlot
            ? { sourceSlot, copySlot, blockDistance: copySlot - sourceSlot }
            : null
        );

        pendingConfirmations.push({
          cycleNum: i,
          protocol: 'PUMP_SWAP',
          type: 'SELL',
          processingTimeMs: result.sell.latency,
          promise: confirmationPromise
        });
      }
    } else {
      process.stdout.write(`SELL FAIL\n`);
      failedTrades.push({
        cycle: i,
        protocol: 'PUMPSWAP',
        type: 'SELL',
        error: result.sellError || 'Unknown error'
      });
    }

    if (i < DEFAULTS.NUM_CYCLES) await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Wait for all confirmations
  let pfBuyBlocks: number[] = [];
  let pfSellBlocks: number[] = [];
  let psBuyBlocks: number[] = [];
  let psSellBlocks: number[] = [];

  if (pendingConfirmations.length > 0) {
    console.log(`\nMeasuring block distances...`);
    const confirmationResults = await Promise.all(
      pendingConfirmations.map(p => p.promise)
    );

    // Categorize block distances by protocol and type
    confirmationResults.forEach((result, i) => {
      if (result) {
        const confirmation = pendingConfirmations[i];
        if (confirmation.protocol === 'PUMP_FUN') {
          if (confirmation.type === 'BUY') {
            pfBuyBlocks.push(result.blockDistance);
          } else {
            pfSellBlocks.push(result.blockDistance);
          }
        } else {
          if (confirmation.type === 'BUY') {
            psBuyBlocks.push(result.blockDistance);
          } else {
            psSellBlocks.push(result.blockDistance);
          }
        }
      }
    });
  }

  detector.stop();
  pumpFunBuilder.cleanup();

  // RESULTS
  console.log('\n' + '━'.repeat(60));
  console.log('\nRESULTS\n');

  const pfBuyStats = calculateStats(pumpFunBuys.map(r => r.latency));
  const pfSellStats = calculateStats(pumpFunSells.map(r => r.latency));
  const pfBuyBlockStats = calculateStatsWithDecimal(pfBuyBlocks);
  const pfSellBlockStats = calculateStatsWithDecimal(pfSellBlocks);

  console.log(`PUMP.FUN (${pumpFunBuys.length} buys, ${pumpFunSells.length} sells)`);
  console.log('                   Processing Time (ms)         Block Distance (blks)');
  console.log('                   p50     p95     avg          p50    p95    avg');
  console.log(`  BUY:            ${String(pfBuyStats.p50).padStart(4)}    ${String(pfBuyStats.p95).padStart(4)}    ${String(pfBuyStats.avg).padStart(4)}           ${String(pfBuyBlockStats.p50).padStart(2)}     ${String(pfBuyBlockStats.p95).padStart(2)}   ${pfBuyBlockStats.avg.toFixed(1).padStart(4)}`);
  console.log(`  SELL:           ${String(pfSellStats.p50).padStart(4)}    ${String(pfSellStats.p95).padStart(4)}    ${String(pfSellStats.avg).padStart(4)}           ${String(pfSellBlockStats.p50).padStart(2)}     ${String(pfSellBlockStats.p95).padStart(2)}   ${pfSellBlockStats.avg.toFixed(1).padStart(4)}`);

  const psBuyStats = calculateStats(pumpSwapBuys.map(r => r.latency));
  const psSellStats = calculateStats(pumpSwapSells.map(r => r.latency));
  const psBuyBlockStats = calculateStatsWithDecimal(psBuyBlocks);
  const psSellBlockStats = calculateStatsWithDecimal(psSellBlocks);

  console.log(`\nPUMPSWAP (${pumpSwapBuys.length} buys, ${pumpSwapSells.length} sells)`);
  console.log('                   Processing Time (ms)         Block Distance (blks)');
  console.log('                   p50     p95     avg          p50    p95    avg');
  console.log(`  BUY:            ${String(psBuyStats.p50).padStart(4)}    ${String(psBuyStats.p95).padStart(4)}    ${String(psBuyStats.avg).padStart(4)}           ${String(psBuyBlockStats.p50).padStart(2)}     ${String(psBuyBlockStats.p95).padStart(2)}   ${psBuyBlockStats.avg.toFixed(1).padStart(4)}`);
  console.log(`  SELL:           ${String(psSellStats.p50).padStart(4)}    ${String(psSellStats.p95).padStart(4)}    ${String(psSellStats.avg).padStart(4)}           ${String(psSellBlockStats.p50).padStart(2)}     ${String(psSellBlockStats.p95).padStart(2)}   ${psSellBlockStats.avg.toFixed(1).padStart(4)}`);

  // Latency breakdown for all buy operations
  const allBuys = [...pumpFunBuys, ...pumpSwapBuys];
  const detectionStats = calculateStats(allBuys.map(r => r.detection));
  const parsingStats = calculateStats(allBuys.map(r => r.parsing));
  const buildingStats = calculateStats(allBuys.map(r => r.building));
  const executionStats = calculateStats(allBuys.map(r => r.execution));
  const totalStats = calculateStats(allBuys.map(r => r.latency));
  const totalBlockStats = calculateStatsWithDecimal([...pfBuyBlocks, ...psBuyBlocks]);

  console.log(`\nLATENCY BREAKDOWN (${allBuys.length} buy operations)`);
  console.log('                       ' + 'p50'.padStart(7) + '    ' + 'p95'.padStart(7) + '    ' + 'avg'.padStart(7));
  console.log(`  Detection            ${String(detectionStats.p50).padStart(5)}ms    ${String(detectionStats.p95).padStart(5)}ms    ${String(Math.round(detectionStats.avg)).padStart(5)}ms`);
  console.log(`  Parsing              ${String(parsingStats.p50).padStart(5)}ms    ${String(parsingStats.p95).padStart(5)}ms    ${String(Math.round(parsingStats.avg)).padStart(5)}ms`);
  console.log(`  Building             ${String(buildingStats.p50).padStart(5)}ms    ${String(buildingStats.p95).padStart(5)}ms    ${String(Math.round(buildingStats.avg)).padStart(5)}ms`);
  console.log(`  Execution            ${String(executionStats.p50).padStart(5)}ms    ${String(executionStats.p95).padStart(5)}ms    ${String(Math.round(executionStats.avg)).padStart(5)}ms`);
  console.log(`  Total                ${String(totalStats.p50).padStart(5)}ms    ${String(totalStats.p95).padStart(5)}ms    ${String(Math.round(totalStats.avg)).padStart(5)}ms`);
  console.log(`  Block Distance       ${(String(totalBlockStats.p50) + 'blks').padStart(7)}    ${(String(totalBlockStats.p95) + 'blks').padStart(7)}    ${(totalBlockStats.avg.toFixed(1) + 'blks').padStart(7)}`);

  const totalOps = pumpFunBuys.length + pumpFunSells.length + pumpSwapBuys.length + pumpSwapSells.length;
  const expectedOps = DEFAULTS.NUM_CYCLES * 4;
  const elapsedMin = Math.floor((Date.now() - startTime) / 60000);
  const elapsedSec = Math.floor(((Date.now() - startTime) % 60000) / 1000);

  if (failedTrades.length > 0) {
    console.log('\nFailed Trades:');
    failedTrades.forEach(f => {
      console.log(`  Cycle ${f.cycle} ${f.protocol} ${f.type}: ${f.error}`);
    });
  }

  console.log(`\nSuccess rate: ${totalOps}/${expectedOps} (${((totalOps/expectedOps)*100).toFixed(0)}%)`);
  console.log(`Demo completed in ${elapsedMin}m ${elapsedSec}s\n`);

  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\nDemo interrupted');
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
  process.exit(1);
});

main().catch((error) => {
  console.error('Demo failed:', error);
  process.exit(1);
});