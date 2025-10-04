import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import { CopytradingBot } from '../src/bot/CopytradingBot';
import { SourceTradeExecutor } from '../src/bot/test/SourceTradeExecutor';
import { appConfig } from '../src/config/config';
import {
  calculateStats,
  calculateStatsWithDecimal,
  getTransactionSlot,
  findPumpSwapPool,
  createTestToken,
  waitForBuyConfirmation
} from '../src/utils/test-utils';
import { DEFAULTS, TIMEOUTS } from '../src/config/config';
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
  const botKeypair = Keypair.fromSecretKey(bs58.decode(appConfig.wallet.privateKey));

  const bot = new CopytradingBot({
    mode: 'live',
    watchWallets: [sourceWallet.publicKey.toBase58()]
  });

  const executor = new SourceTradeExecutor(connection);

  await bot.initialize();

  const sourceBalance = await connection.getBalance(sourceWallet.publicKey);
  const botBalance = await connection.getBalance(botKeypair.publicKey);

  console.log('\nSetup:');
  console.log(`  Source wallet: ${sourceWallet.publicKey.toBase58().slice(0, 4)}...${sourceWallet.publicKey.toBase58().slice(-4)} (${(sourceBalance / 1e9).toFixed(2)} SOL)`);
  console.log(`  Bot wallet:    ${botKeypair.publicKey.toBase58().slice(0, 4)}...${botKeypair.publicKey.toBase58().slice(-4)} (${(botBalance / 1e9).toFixed(2)} SOL)`);

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

  // Start bot
  await bot.start();

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
    process.stdout.write(`Cycle ${i}: BUY `);

    try {
      // Start listening first
      const buyResultPromise = new Promise<any>((resolve, reject) => {
        const handler: any = {
          handle: (event: any) => {
            if (event.type === 'executionSuccess' && event.parsed.protocol === 'PUMP_FUN' && event.parsed.type === 'BUY') {
              bot.removeHandler(handler);
              resolve({
                timing: {
                  detection: event.detectionTime,
                  parsing: event.parsingTime,
                  building: event.buildTime,
                  execution: event.execTime,
                  total: event.detectionTime + event.parsingTime + event.buildTime + event.execTime
                },
                sourceSignature: event.parsed.signature,
                copySignature: event.signature
              });
            } else if (event.type === 'buildFailed' || event.type === 'executionFailed') {
              if (event.parsed.protocol === 'PUMP_FUN' && event.parsed.type === 'BUY') {
                bot.removeHandler(handler);
                reject(new Error(event.error));
              }
            }
          }
        };
        bot.addHandler(handler);
        setTimeout(() => {
          bot.removeHandler(handler);
          reject(new Error(`Timeout: No transaction detected after ${TIMEOUTS.DETECTION_MS / 1000}s`));
        }, TIMEOUTS.DETECTION_MS);
      });

      // Now execute the trade
      await executor.executeTrade(sourceWallet, {
        protocol: 'PUMP_FUN',
        type: 'BUY',
        mint: testMint
      });

      const buyResult = await buyResultPromise;

      pumpFunBuys.push({
        latency: buyResult.timing.total,
        detection: buyResult.timing.detection,
        parsing: buyResult.timing.parsing,
        building: buyResult.timing.building,
        execution: buyResult.timing.execution,
        sourceSignature: buyResult.sourceSignature,
        copySignature: buyResult.copySignature
      });

      process.stdout.write(`${buyResult.timing.total}ms ✓  SELL `);

      // Wait for buy confirmation before executing sell
      await waitForBuyConfirmation(connection, buyResult.copySignature);

      // Queue confirmation check
      const confirmationPromise = Promise.all([
        getTransactionSlot(connection, buyResult.sourceSignature),
        getTransactionSlot(connection, buyResult.copySignature)
      ]).then(([sourceSlot, copySlot]) =>
        sourceSlot && copySlot
          ? { sourceSlot, copySlot, blockDistance: copySlot - sourceSlot }
          : null
      );

      pendingConfirmations.push({
        cycleNum: i,
        protocol: 'PUMP_FUN',
        type: 'BUY',
        processingTimeMs: buyResult.timing.total,
        promise: confirmationPromise
      });

      // Start listening for sell first
      const sellResultPromise = new Promise<any>((resolve, reject) => {
        const handler: any = {
          handle: (event: any) => {
            if (event.type === 'executionSuccess' && event.parsed.protocol === 'PUMP_FUN' && event.parsed.type === 'SELL') {
              bot.removeHandler(handler);
              resolve({
                timing: {
                  detection: event.detectionTime,
                  parsing: event.parsingTime,
                  building: event.buildTime,
                  execution: event.execTime,
                  total: event.detectionTime + event.parsingTime + event.buildTime + event.execTime
                },
                sourceSignature: event.parsed.signature,
                copySignature: event.signature
              });
            } else if (event.type === 'buildFailed' || event.type === 'executionFailed') {
              if (event.parsed.protocol === 'PUMP_FUN' && event.parsed.type === 'SELL') {
                bot.removeHandler(handler);
                reject(new Error(event.error));
              }
            }
          }
        };
        bot.addHandler(handler);
        setTimeout(() => {
          bot.removeHandler(handler);
          reject(new Error(`Timeout: No transaction detected after ${TIMEOUTS.DETECTION_MS / 1000}s`));
        }, TIMEOUTS.DETECTION_MS);
      });

      // Now execute the sell trade
      await executor.executeTrade(sourceWallet, {
        protocol: 'PUMP_FUN',
        type: 'SELL',
        mint: testMint
      });

      const sellResult = await sellResultPromise;

      pumpFunSells.push({
        latency: sellResult.timing.total,
        detection: sellResult.timing.detection,
        parsing: sellResult.timing.parsing,
        building: sellResult.timing.building,
        execution: sellResult.timing.execution,
        sourceSignature: sellResult.sourceSignature,
        copySignature: sellResult.copySignature
      });

      process.stdout.write(`${sellResult.timing.total}ms ✓\n`);

      // Queue confirmation check
      const sellConfirmationPromise = Promise.all([
        getTransactionSlot(connection, sellResult.sourceSignature),
        getTransactionSlot(connection, sellResult.copySignature)
      ]).then(([sourceSlot, copySlot]) =>
        sourceSlot && copySlot
          ? { sourceSlot, copySlot, blockDistance: copySlot - sourceSlot }
          : null
      );

      pendingConfirmations.push({
        cycleNum: i,
        protocol: 'PUMP_FUN',
        type: 'SELL',
        processingTimeMs: sellResult.timing.total,
        promise: sellConfirmationPromise
      });

    } catch (error: any) {
      process.stdout.write(`FAIL: ${error.message}\n`);
      failedTrades.push({
        cycle: i,
        protocol: 'PUMP.FUN',
        type: error.message.includes('SELL') ? 'SELL' : 'BUY',
        error: error.message
      });
    }

    if (i < DEFAULTS.NUM_CYCLES) await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // PUMPSWAP
  console.log(`\nPUMPSWAP TEST (${DEFAULTS.NUM_CYCLES} cycles)\n`);

  const pumpSwapBuys: TradeResult[] = [];
  const pumpSwapSells: TradeResult[] = [];

  for (let i = 1; i <= DEFAULTS.NUM_CYCLES; i++) {
    process.stdout.write(`Cycle ${i}: BUY `);

    try {
      // Start listening for buy first
      const buyResultPromise = new Promise<any>((resolve, reject) => {
        const handler: any = {
          handle: (event: any) => {
            if (event.type === 'executionSuccess' && event.parsed.protocol === 'PUMP_SWAP' && event.parsed.type === 'BUY') {
              bot.removeHandler(handler);
              resolve({
                timing: {
                  detection: event.detectionTime,
                  parsing: event.parsingTime,
                  building: event.buildTime,
                  execution: event.execTime,
                  total: event.detectionTime + event.parsingTime + event.buildTime + event.execTime
                },
                sourceSignature: event.parsed.signature,
                copySignature: event.signature
              });
            } else if (event.type === 'buildFailed' || event.type === 'executionFailed') {
              if (event.parsed.protocol === 'PUMP_SWAP' && event.parsed.type === 'BUY') {
                bot.removeHandler(handler);
                reject(new Error(event.error));
              }
            }
          }
        };
        bot.addHandler(handler);
        setTimeout(() => {
          bot.removeHandler(handler);
          reject(new Error(`Timeout: No transaction detected after ${TIMEOUTS.DETECTION_MS / 1000}s`));
        }, TIMEOUTS.DETECTION_MS);
      });

      // Now execute the buy trade
      await executor.executeTrade(sourceWallet, {
        protocol: 'PUMP_SWAP',
        type: 'BUY',
        pool: poolInfo.pool
      });

      const buyResult = await buyResultPromise;

      pumpSwapBuys.push({
        latency: buyResult.timing.total,
        detection: buyResult.timing.detection,
        parsing: buyResult.timing.parsing,
        building: buyResult.timing.building,
        execution: buyResult.timing.execution,
        sourceSignature: buyResult.sourceSignature,
        copySignature: buyResult.copySignature
      });

      process.stdout.write(`${buyResult.timing.total}ms ✓  SELL `);

      // Wait for buy confirmation before executing sell
      await waitForBuyConfirmation(connection, buyResult.copySignature);

      // Queue confirmation check
      const confirmationPromise = Promise.all([
        getTransactionSlot(connection, buyResult.sourceSignature),
        getTransactionSlot(connection, buyResult.copySignature)
      ]).then(([sourceSlot, copySlot]) =>
        sourceSlot && copySlot
          ? { sourceSlot, copySlot, blockDistance: copySlot - sourceSlot }
          : null
      );

      pendingConfirmations.push({
        cycleNum: i,
        protocol: 'PUMP_SWAP',
        type: 'BUY',
        processingTimeMs: buyResult.timing.total,
        promise: confirmationPromise
      });

      // Start listening for sell first
      const sellResultPromise = new Promise<any>((resolve, reject) => {
        const handler: any = {
          handle: (event: any) => {
            if (event.type === 'executionSuccess' && event.parsed.protocol === 'PUMP_SWAP' && event.parsed.type === 'SELL') {
              bot.removeHandler(handler);
              resolve({
                timing: {
                  detection: event.detectionTime,
                  parsing: event.parsingTime,
                  building: event.buildTime,
                  execution: event.execTime,
                  total: event.detectionTime + event.parsingTime + event.buildTime + event.execTime
                },
                sourceSignature: event.parsed.signature,
                copySignature: event.signature
              });
            } else if (event.type === 'buildFailed' || event.type === 'executionFailed') {
              if (event.parsed.protocol === 'PUMP_SWAP' && event.parsed.type === 'SELL') {
                bot.removeHandler(handler);
                reject(new Error(event.error));
              }
            }
          }
        };
        bot.addHandler(handler);
        setTimeout(() => {
          bot.removeHandler(handler);
          reject(new Error(`Timeout: No transaction detected after ${TIMEOUTS.DETECTION_MS / 1000}s`));
        }, TIMEOUTS.DETECTION_MS);
      });

      // Now execute the sell trade
      await executor.executeTrade(sourceWallet, {
        protocol: 'PUMP_SWAP',
        type: 'SELL',
        pool: poolInfo.pool,
        baseMint: poolInfo.baseMint
      });

      const sellResult = await sellResultPromise;

      pumpSwapSells.push({
        latency: sellResult.timing.total,
        detection: sellResult.timing.detection,
        parsing: sellResult.timing.parsing,
        building: sellResult.timing.building,
        execution: sellResult.timing.execution,
        sourceSignature: sellResult.sourceSignature,
        copySignature: sellResult.copySignature
      });

      process.stdout.write(`${sellResult.timing.total}ms ✓\n`);

      // Queue confirmation check
      const sellConfirmationPromise = Promise.all([
        getTransactionSlot(connection, sellResult.sourceSignature),
        getTransactionSlot(connection, sellResult.copySignature)
      ]).then(([sourceSlot, copySlot]) =>
        sourceSlot && copySlot
          ? { sourceSlot, copySlot, blockDistance: copySlot - sourceSlot }
          : null
      );

      pendingConfirmations.push({
        cycleNum: i,
        protocol: 'PUMP_SWAP',
        type: 'SELL',
        processingTimeMs: sellResult.timing.total,
        promise: sellConfirmationPromise
      });

    } catch (error: any) {
      process.stdout.write(`FAIL: ${error.message}\n`);
      failedTrades.push({
        cycle: i,
        protocol: 'PUMPSWAP',
        type: error.message.includes('SELL') ? 'SELL' : 'BUY',
        error: error.message
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

  await bot.stop();

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