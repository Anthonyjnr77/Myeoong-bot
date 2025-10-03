import 'dotenv/config';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
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
  executePumpSwapBuy
} from '../src/utils/test-utils';
import bs58 from 'bs58';

const DEFAULT_OPERATIONS = 20;
const NUM_OPERATIONS = parseInt(
  process.argv.find(arg => arg.startsWith('--operations='))?.split('=')[1] || String(DEFAULT_OPERATIONS)
);
const DEFAULT_SDK_OPERATIONS = 10;
const SDK_OPERATIONS = parseInt(
  process.argv.find(arg => arg.startsWith('--sdk-operations='))?.split('=')[1] || String(DEFAULT_SDK_OPERATIONS)
);
const PUMPSWAP_TRADE_AMOUNT = 0.002;

interface TimingData {
  detection: number;
  parsing: number;
  parallelFetch: number;
  calculation: number;
  buildTx: number;
  buildTotal: number;
  signing: number;
  submission: number;
  executionTotal: number;
  processingTime: number;
  blockDistance?: number;
}

interface FailedOperation {
  operationNum: number;
  protocol: string;
  error: string;
}

function createProgressBar(current: number, total: number, label: string): void {
  const barWidth = 40;
  const percentage = Math.floor((current / total) * 100);
  const filledWidth = Math.floor((percentage / 100) * barWidth);
  const emptyWidth = barWidth - filledWidth;

  const filledBlock = String.fromCharCode(0x2588); // █
  const emptyBlock = String.fromCharCode(0x2592); // ▒
  const progressBar = filledBlock.repeat(filledWidth) + emptyBlock.repeat(emptyWidth);

  // Move cursor to beginning of line and clear it
  process.stdout.write('\r');
  // Clear from cursor to end of line
  process.stdout.write('\x1b[K');
  process.stdout.write(`${label} [${progressBar}] ${current}/${total}`);

  if (current === total) {
    process.stdout.write('\n');
  }
}

async function executeBenchmarkOperation(
  protocol: 'PUMP_FUN' | 'PUMP_SWAP',
  connection: Connection,
  sourceWallet: Keypair,
  detector: Detector,
  parser: TradeParser,
  builder: PumpFunTxBuilder | PumpSwapTxBuilder,
  executor: TransactionExecutor,
  testMint: string | null,
  poolInfo: any
): Promise<{ timing: TimingData | null; sourceSignature: string | null; copySignature: string | null; error?: string }> {
  return new Promise((resolve) => {
    let processing = false;
    let sourceSignature: string | null = null;

    const handler = async (tx: any) => {
      if (processing || tx.protocol !== protocol) return;
      processing = true;  // Set synchronously before await
      const parseResult = parser.parse(tx);

      if (!parseResult.success) {
        if ('error' in parseResult) {
          resolve({ timing: null, sourceSignature, copySignature: null, error: parseResult.error });
        } else {
          processing = false;  // Reset if filtered
        }
        return; // Filtered or error
      }

      if (parseResult.data.type !== 'BUY') {
        processing = false;  // Reset if wrong type
        return;
      }

      // Remove handler immediately to prevent duplicate execution
      detector.clearTransactionHandler();

      if (!sourceSignature) {
        sourceSignature = tx.signature;
      }

      const parsed = parseResult.data;

      try {
        const detection = tx.processedTimestamp - tx.receivedTimestamp;
        const parseStart = Date.now();
        const parseEnd = Date.now();
        const parsing = parseEnd - parseStart;

        const buildResult = await builder.buildTransactionWithTiming(parsed);
        if (!buildResult.success || !buildResult.timing) {
          resolve({ timing: null, sourceSignature, copySignature: null, error: buildResult.error || 'Build failed' });
          return;
        }

        const executeResult = await executor.executeTransactionWithTiming(
          buildResult.transaction!,
          builder.getBotKeypair(),
          { blockhash: buildResult.blockhash }
        );

        if (!executeResult.success || !executeResult.timing || !executeResult.signature) {
          resolve({ timing: null, sourceSignature, copySignature: null, error: executeResult.error || 'Execution failed' });
          return;
        }

        const timing: TimingData = {
          detection,
          parsing,
          parallelFetch: buildResult.timing.parallelFetch,
          calculation: buildResult.timing.calculateAmount,
          buildTx: buildResult.timing.buildInstructions,
          buildTotal: buildResult.timing.total,
          signing: executeResult.timing.signing,
          submission: executeResult.timing.submission,
          executionTotal: executeResult.timing.total,
          processingTime: detection + parsing + buildResult.timing.total + executeResult.timing.total
        };

        resolve({ timing, sourceSignature: sourceSignature!, copySignature: executeResult.signature, error: undefined });
      } catch (error) {
        resolve({ timing: null, sourceSignature, copySignature: null, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    };

    detector.onTransaction(handler);

    if (protocol === 'PUMP_FUN') {
      const provider = new AnchorProvider(connection, new Wallet(sourceWallet), { commitment: "confirmed" });
      const sdk = new PumpFunSDK(provider);
      sdk.trade.buy(
        sourceWallet,
        new PublicKey(testMint!),
        BigInt(0.005 * LAMPORTS_PER_SOL),
        500n,
        { unitLimit: 250_000, unitPrice: 250_000 }
      ).catch((error) => {
        console.error(`Operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        resolve({ timing: null, sourceSignature: null, copySignature: null });
      });
    } else {
      const onlineSdk = new OnlinePumpAmmSdk(connection);
      onlineSdk.swapSolanaState(poolInfo.pool, sourceWallet.publicKey).then(async (swapState) => {
        const buyInstructions = await PUMP_AMM_SDK.buyQuoteInput(
          swapState,
          new BN(Math.floor(PUMPSWAP_TRADE_AMOUNT * LAMPORTS_PER_SOL)),
          10
        );
        const tx = new Transaction();
        buyInstructions.forEach(ix => tx.add(ix));
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = sourceWallet.publicKey;
        tx.sign(sourceWallet);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        sourceSignature = sig;
      }).catch((error) => {
        console.error(`Operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        resolve({ timing: null, sourceSignature: null, copySignature: null });
      });
    }

    setTimeout(() => {
      if (!processing) {
        processing = true;
        detector.clearTransactionHandler();
        resolve({ timing: null, sourceSignature, copySignature: null, error: 'Timeout: No transaction detected after 15s' });
      }
    }, 15000);
  });
}

async function executeSDKNativeOperation(
  protocol: 'PUMP_FUN' | 'PUMP_SWAP',
  connection: Connection,
  sourceWallet: Keypair,
  testMint: string | null,
  poolInfo: any
): Promise<{ latency: number | null; signature: string | null }> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    if (protocol === 'PUMP_FUN') {
      const provider = new AnchorProvider(connection, new Wallet(sourceWallet), { commitment: "confirmed" });
      const sdk = new PumpFunSDK(provider);

      sdk.trade.buy(
        sourceWallet,
        new PublicKey(testMint!),
        BigInt(0.005 * LAMPORTS_PER_SOL),
        500n,
        { unitLimit: 250_000, unitPrice: 250_000 }
      )
        .then((result) => {
          const latency = Date.now() - startTime;
          resolve({ latency, signature: result.signature || null });
        })
        .catch((error) => {
          console.error(`Operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          resolve({ latency: null, signature: null });
        });
    } else {
      const onlineSdk = new OnlinePumpAmmSdk(connection);

      onlineSdk.swapSolanaState(poolInfo.pool, sourceWallet.publicKey)
        .then(async (swapState) => {
          const buyInstructions = await PUMP_AMM_SDK.buyQuoteInput(
            swapState,
            new BN(Math.floor(PUMPSWAP_TRADE_AMOUNT * LAMPORTS_PER_SOL)),
            10
          );
          const tx = new Transaction();
          buyInstructions.forEach(ix => tx.add(ix));
          const { blockhash } = await connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.feePayer = sourceWallet.publicKey;
          tx.sign(sourceWallet);
          const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
          const latency = Date.now() - startTime;
          resolve({ latency, signature: sig });
        })
        .catch((error) => {
          console.error(`Operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
          resolve({ latency: null, signature: null });
        });
    }

    setTimeout(() => resolve({ latency: null, signature: null }), 15000);
  });
}

async function main() {
  const startTime = Date.now();

  console.log('LATENCY BENCHMARK');
  console.log('='.repeat(60));

  const connection = new Connection(appConfig.rpc.endpoint, { commitment: appConfig.rpc.commitment });

  if (!appConfig.testing?.sourceWalletPrivateKey) {
    console.error('SOURCE_WALLET_PRIVATE_KEY required');
    process.exit(1);
  }

  const sourceWallet = Keypair.fromSecretKey(bs58.decode(appConfig.testing.sourceWalletPrivateKey));
  const detector = new Detector();
  const parser = new TradeParser();
  const pumpFunBuilder = new PumpFunTxBuilder();
  const pumpSwapBuilder = new PumpSwapTxBuilder();
  const executor = new TransactionExecutor();

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

  process.stdout.write('  Test token:    ');
  const testMint = await createTestToken(connection, sourceWallet);
  if (!testMint) {
    console.log('FAILED');
    process.exit(1);
  }
  console.log(`${testMint.slice(0, 4)}...${testMint.slice(-4)}`);

  process.stdout.write('  PumpSwap pool: ');
  const poolInfo = await findPumpSwapPool(connection);
  if (!poolInfo) {
    console.log('FAILED');
    process.exit(1);
  }
  console.log(`${poolInfo.pool.toBase58().slice(0, 4)}...${poolInfo.pool.toBase58().slice(-4)} (${poolInfo.liquidity.toFixed(1)} SOL liquidity)`);

  console.log = suppressLog;
  await detector.start([sourceWallet.publicKey.toBase58()]);
  console.log = originalLog;
  await new Promise(resolve => setTimeout(resolve, 3000));

  const pumpFunTimings: TimingData[] = [];
  const pumpSwapTimings: TimingData[] = [];
  const pendingConfirmations: Array<{ protocol: string; timing: TimingData; promise: Promise<number | null> }> = [];
  const sdkPumpFunLatencies: number[] = [];
  const sdkPumpSwapLatencies: number[] = [];
  const failedOperations: FailedOperation[] = [];

  console.log(`\nRunning ${NUM_OPERATIONS} pump.fun BUY operations...`);

  for (let i = 1; i <= NUM_OPERATIONS; i++) {
    const result = await executeBenchmarkOperation(
      'PUMP_FUN', connection, sourceWallet, detector, parser,
      pumpFunBuilder, executor, testMint, null
    );

    if (result.timing) {
      pumpFunTimings.push(result.timing);

      if (result.sourceSignature && result.copySignature) {
        const confirmationPromise = Promise.all([
          getTransactionSlot(connection, result.sourceSignature),
          getTransactionSlot(connection, result.copySignature)
        ]).then(([sourceSlot, copySlot]) =>
          sourceSlot && copySlot ? copySlot - sourceSlot : null
        );

        pendingConfirmations.push({
          protocol: 'PUMP_FUN',
          timing: result.timing,
          promise: confirmationPromise
        });
      }
    } else {
      failedOperations.push({
        operationNum: i,
        protocol: 'PUMP.FUN',
        error: result.error || 'Unknown error'
      });
    }

    createProgressBar(i, NUM_OPERATIONS, 'Progress:');
    if (i < NUM_OPERATIONS) await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`\nRunning ${NUM_OPERATIONS} PumpSwap BUY operations...`);

  for (let i = 1; i <= NUM_OPERATIONS; i++) {
    const result = await executeBenchmarkOperation(
      'PUMP_SWAP', connection, sourceWallet, detector, parser,
      pumpSwapBuilder, executor, null, poolInfo
    );

    if (result.timing) {
      pumpSwapTimings.push(result.timing);

      if (result.sourceSignature && result.copySignature) {
        const confirmationPromise = Promise.all([
          getTransactionSlot(connection, result.sourceSignature),
          getTransactionSlot(connection, result.copySignature)
        ]).then(([sourceSlot, copySlot]) =>
          sourceSlot && copySlot ? copySlot - sourceSlot : null
        );

        pendingConfirmations.push({
          protocol: 'PUMP_SWAP',
          timing: result.timing,
          promise: confirmationPromise
        });
      }
    } else {
      failedOperations.push({
        operationNum: i,
        protocol: 'PUMPSWAP',
        error: result.error || 'Unknown error'
      });
    }

    createProgressBar(i, NUM_OPERATIONS, 'Progress:');
    if (i < NUM_OPERATIONS) await new Promise(resolve => setTimeout(resolve, 500));
  }

  if (pendingConfirmations.length > 0) {
    process.stdout.write('\nMeasuring block distances...');
    const confirmationResults = await Promise.all(
      pendingConfirmations.map(p => p.promise)
    );

    confirmationResults.forEach((blockDistance, i) => {
      if (blockDistance !== null) {
        pendingConfirmations[i].timing.blockDistance = blockDistance;
      }
    });
    console.log(' Done');
  }

  console.log(`\nRunning ${SDK_OPERATIONS} SDK native pump.fun operations...`);

  for (let i = 1; i <= SDK_OPERATIONS; i++) {
    const result = await executeSDKNativeOperation(
      'PUMP_FUN',
      connection,
      sourceWallet,
      testMint,
      null
    );

    if (result.latency) {
      sdkPumpFunLatencies.push(result.latency);
    }

    createProgressBar(i, SDK_OPERATIONS, 'Progress:');
    if (i < SDK_OPERATIONS) await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`\nRunning ${Math.floor(NUM_OPERATIONS / 2)} SDK native PumpSwap operations...`);

  for (let i = 1; i <= Math.floor(NUM_OPERATIONS / 2); i++) {
    const result = await executeSDKNativeOperation(
      'PUMP_SWAP',
      connection,
      sourceWallet,
      null,
      poolInfo
    );

    if (result.latency) {
      sdkPumpSwapLatencies.push(result.latency);
    }

    createProgressBar(i, Math.floor(NUM_OPERATIONS / 2), 'Progress:');
    if (i < Math.floor(NUM_OPERATIONS / 2)) await new Promise(resolve => setTimeout(resolve, 500));
  }

  detector.clearTransactionHandler();
  detector.stop();
  pumpFunBuilder.cleanup();

  console.log('\n' + '='.repeat(60));
  console.log(`\nPUMP.FUN (${NUM_OPERATIONS} operations, ${pumpFunTimings.length} successful)\n`);

  const pfDetection = calculateStats(pumpFunTimings.map(t => t.detection));
  const pfParsing = calculateStats(pumpFunTimings.map(t => t.parsing));
  const pfParallelFetch = calculateStats(pumpFunTimings.map(t => t.parallelFetch));
  const pfCalculation = calculateStats(pumpFunTimings.map(t => t.calculation));
  const pfBuildTx = calculateStats(pumpFunTimings.map(t => t.buildTx));
  const pfBuildTotal = calculateStats(pumpFunTimings.map(t => t.buildTotal));
  const pfSigning = calculateStats(pumpFunTimings.map(t => t.signing));
  const pfSubmission = calculateStats(pumpFunTimings.map(t => t.submission));
  const pfExecutionTotal = calculateStats(pumpFunTimings.map(t => t.executionTotal));
  const pfProcessingTime = calculateStats(pumpFunTimings.map(t => t.processingTime));
  const pfBlockDistance = calculateStatsWithDecimal(pumpFunTimings.filter(t => t.blockDistance !== undefined).map(t => t.blockDistance!));

  console.log('                       ' + 'p50'.padStart(7) + '    ' + 'p95'.padStart(7) + '    ' + 'avg'.padStart(7));
  console.log(`  Detection            ${String(pfDetection.p50).padStart(5)}ms    ${String(pfDetection.p95).padStart(5)}ms    ${String(Math.round(pfDetection.avg)).padStart(5)}ms`);
  console.log(`  Parsing              ${String(pfParsing.p50).padStart(5)}ms    ${String(pfParsing.p95).padStart(5)}ms    ${String(Math.round(pfParsing.avg)).padStart(5)}ms`);
  console.log('  Building:');
  console.log(`    Parallel Fetch     ${String(pfParallelFetch.p50).padStart(5)}ms    ${String(pfParallelFetch.p95).padStart(5)}ms    ${String(Math.round(pfParallelFetch.avg)).padStart(5)}ms`);
  console.log(`    Calculation        ${String(pfCalculation.p50).padStart(5)}ms    ${String(pfCalculation.p95).padStart(5)}ms    ${String(Math.round(pfCalculation.avg)).padStart(5)}ms`);
  console.log(`    Build TX           ${String(pfBuildTx.p50).padStart(5)}ms    ${String(pfBuildTx.p95).padStart(5)}ms    ${String(Math.round(pfBuildTx.avg)).padStart(5)}ms`);
  console.log(`    Total              ${String(pfBuildTotal.p50).padStart(5)}ms    ${String(pfBuildTotal.p95).padStart(5)}ms    ${String(Math.round(pfBuildTotal.avg)).padStart(5)}ms`);
  console.log('  Execution:');
  console.log(`    Signing            ${String(pfSigning.p50).padStart(5)}ms    ${String(pfSigning.p95).padStart(5)}ms    ${String(Math.round(pfSigning.avg)).padStart(5)}ms`);
  console.log(`    Submission         ${String(pfSubmission.p50).padStart(5)}ms    ${String(pfSubmission.p95).padStart(5)}ms    ${String(Math.round(pfSubmission.avg)).padStart(5)}ms`);
  console.log(`    Total              ${String(pfExecutionTotal.p50).padStart(5)}ms    ${String(pfExecutionTotal.p95).padStart(5)}ms    ${String(Math.round(pfExecutionTotal.avg)).padStart(5)}ms`);
  console.log('  ' + '-'.repeat(56));
  console.log(`  Processing Time:     ${String(pfProcessingTime.p50).padStart(5)}ms    ${String(pfProcessingTime.p95).padStart(5)}ms    ${String(Math.round(pfProcessingTime.avg)).padStart(5)}ms`);
  console.log(`  Block Distance:      ${(String(pfBlockDistance.p50) + 'blks').padStart(7)}    ${(String(pfBlockDistance.p95) + 'blks').padStart(7)}    ${(pfBlockDistance.avg.toFixed(1) + 'blks').padStart(7)}`);

  console.log(`\nPUMPSWAP (${NUM_OPERATIONS} operations, ${pumpSwapTimings.length} successful)\n`);

  const psDetection = calculateStats(pumpSwapTimings.map(t => t.detection));
  const psParsing = calculateStats(pumpSwapTimings.map(t => t.parsing));
  const psParallelFetch = calculateStats(pumpSwapTimings.map(t => t.parallelFetch));
  const psCalculation = calculateStats(pumpSwapTimings.map(t => t.calculation));
  const psBuildTx = calculateStats(pumpSwapTimings.map(t => t.buildTx));
  const psBuildTotal = calculateStats(pumpSwapTimings.map(t => t.buildTotal));
  const psSigning = calculateStats(pumpSwapTimings.map(t => t.signing));
  const psSubmission = calculateStats(pumpSwapTimings.map(t => t.submission));
  const psExecutionTotal = calculateStats(pumpSwapTimings.map(t => t.executionTotal));
  const psProcessingTime = calculateStats(pumpSwapTimings.map(t => t.processingTime));
  const psBlockDistance = calculateStatsWithDecimal(pumpSwapTimings.filter(t => t.blockDistance !== undefined).map(t => t.blockDistance!));

  console.log('                       ' + 'p50'.padStart(7) + '    ' + 'p95'.padStart(7) + '    ' + 'avg'.padStart(7));
  console.log(`  Detection            ${String(psDetection.p50).padStart(5)}ms    ${String(psDetection.p95).padStart(5)}ms    ${String(Math.round(psDetection.avg)).padStart(5)}ms`);
  console.log(`  Parsing              ${String(psParsing.p50).padStart(5)}ms    ${String(psParsing.p95).padStart(5)}ms    ${String(Math.round(psParsing.avg)).padStart(5)}ms`);
  console.log('  Building:');
  console.log(`    Parallel Fetch     ${String(psParallelFetch.p50).padStart(5)}ms    ${String(psParallelFetch.p95).padStart(5)}ms    ${String(Math.round(psParallelFetch.avg)).padStart(5)}ms`);
  console.log(`    Calculation        ${String(psCalculation.p50).padStart(5)}ms    ${String(psCalculation.p95).padStart(5)}ms    ${String(Math.round(psCalculation.avg)).padStart(5)}ms`);
  console.log(`    Build TX           ${String(psBuildTx.p50).padStart(5)}ms    ${String(psBuildTx.p95).padStart(5)}ms    ${String(Math.round(psBuildTx.avg)).padStart(5)}ms`);
  console.log(`    Total              ${String(psBuildTotal.p50).padStart(5)}ms    ${String(psBuildTotal.p95).padStart(5)}ms    ${String(Math.round(psBuildTotal.avg)).padStart(5)}ms`);
  console.log('  Execution:');
  console.log(`    Signing            ${String(psSigning.p50).padStart(5)}ms    ${String(psSigning.p95).padStart(5)}ms    ${String(Math.round(psSigning.avg)).padStart(5)}ms`);
  console.log(`    Submission         ${String(psSubmission.p50).padStart(5)}ms    ${String(psSubmission.p95).padStart(5)}ms    ${String(Math.round(psSubmission.avg)).padStart(5)}ms`);
  console.log(`    Total              ${String(psExecutionTotal.p50).padStart(5)}ms    ${String(psExecutionTotal.p95).padStart(5)}ms    ${String(Math.round(psExecutionTotal.avg)).padStart(5)}ms`);
  console.log('  ' + '-'.repeat(56));
  console.log(`  Processing Time:     ${String(psProcessingTime.p50).padStart(5)}ms    ${String(psProcessingTime.p95).padStart(5)}ms    ${String(Math.round(psProcessingTime.avg)).padStart(5)}ms`);
  console.log(`  Block Distance:      ${(String(psBlockDistance.p50) + 'blks').padStart(7)}    ${(String(psBlockDistance.p95) + 'blks').padStart(7)}    ${(psBlockDistance.avg.toFixed(1) + 'blks').padStart(7)}`);

  console.log('\n' + '='.repeat(60));
  console.log(`\nTOTAL (${NUM_OPERATIONS * 2} operations, ${pumpFunTimings.length + pumpSwapTimings.length} successful)\n`);

  const allTimings = [...pumpFunTimings, ...pumpSwapTimings];
  const totalProcessingTime = calculateStats(allTimings.map(t => t.processingTime));
  const totalBlockDistance = calculateStatsWithDecimal(allTimings.filter(t => t.blockDistance !== undefined).map(t => t.blockDistance!));

  console.log('BOT PERFORMANCE:');
  console.log('                       ' + 'p50'.padStart(7) + '    ' + 'p95'.padStart(7) + '    ' + 'avg'.padStart(7));
  console.log(`  Processing Time:     ${String(totalProcessingTime.p50).padStart(5)}ms    ${String(totalProcessingTime.p95).padStart(5)}ms    ${String(Math.round(totalProcessingTime.avg)).padStart(5)}ms`);
  console.log(`  Block Distance:      ${(String(totalBlockDistance.p50) + 'blks').padStart(7)}    ${(String(totalBlockDistance.p95) + 'blks').padStart(7)}    ${(totalBlockDistance.avg.toFixed(1) + 'blks').padStart(7)}`);

  // SDK Native comparison
  const allSDKLatencies = [...sdkPumpFunLatencies, ...sdkPumpSwapLatencies];
  if (allSDKLatencies.length > 0) {
    const sdkStats = calculateStats(allSDKLatencies);

    console.log('\nSDK NATIVE PERFORMANCE:');
    console.log('                       ' + 'p50'.padStart(7) + '    ' + 'p95'.padStart(7) + '    ' + 'avg'.padStart(7));
    console.log(`  Build + Submit:      ${String(sdkStats.p50).padStart(5)}ms    ${String(sdkStats.p95).padStart(5)}ms    ${String(Math.round(sdkStats.avg)).padStart(5)}ms`);

    // Calculate speedup
    const botAvg = totalProcessingTime.avg;
    const sdkAvg = sdkStats.avg;
    const speedup = ((sdkAvg / botAvg)).toFixed(2);
    const timeSaved = Math.round(sdkAvg - botAvg);

    console.log('\nCOMPARISON:');
    console.log(`  Bot is ${speedup}x faster than SDK native implementation`);
    console.log(`  Saves ~${timeSaved}ms per trade on average`);
  }

  const elapsedMin = Math.floor((Date.now() - startTime) / 60000);
  const elapsedSec = Math.floor(((Date.now() - startTime) % 60000) / 1000);

  const totalOps = NUM_OPERATIONS * 2;
  const successfulOps = pumpFunTimings.length + pumpSwapTimings.length;
  const successRate = ((successfulOps / totalOps) * 100).toFixed(1);

  if (failedOperations.length > 0) {
    console.log('\nFailed Operations:');
    failedOperations.forEach(f => {
      console.log(`  ${f.protocol} #${f.operationNum}: ${f.error}`);
    });
  }

  console.log(`\nSuccess Rate: ${successfulOps}/${totalOps} (${successRate}%)`);
  console.log(`Benchmark completed in ${elapsedMin}m ${elapsedSec}s\n`);

  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\nBenchmark interrupted');
  process.exit(0);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
  process.exit(1);
});

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
