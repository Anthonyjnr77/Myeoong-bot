import 'dotenv/config';
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { PumpFunSDK } from '../src/pumpfun-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from '@pump-fun/pump-swap-sdk';
import { Detector } from '../src/detector';
import { TradeParser } from '../src/parser';
import { PumpFunTxBuilder } from '../src/pumpfun-tx';
import { PumpSwapTxBuilder } from '../src/pumpswap-tx';
import { TransactionExecutor } from '../src/executor';
import { appConfig } from '../src/config/config';
import bs58 from 'bs58';
import BN from 'bn.js';
import fs from 'fs';
import path from 'path';

const NUM_CYCLES = 5;
const PUMPSWAP_TRADE_AMOUNT = 0.002;
const PUMPSWAP_MIN_POOL = 20;
const PUMPSWAP_MAX_POOL = 100;
const POOL_CACHE_FILE = path.join(__dirname, '../data/pumpswap-pool.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

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

function calculateStats(values: number[]): { p50: number; p95: number; avg: number } {
  if (values.length === 0) return { p50: 0, p95: 0, avg: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    avg: Math.round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length)
  };
}

async function getTransactionSlot(
  connection: Connection,
  signature: string,
  timeoutMs: number = 60000
): Promise<number | null> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    try {
      const tx = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      
      if (tx?.slot) {
        return tx.slot;
      }
    } catch {}
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return null;
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
      if (status.value?.err) return false;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function createTestToken(connection: Connection, sourceWallet: Keypair): Promise<string | null> {
  const provider = new AnchorProvider(connection, new Wallet(sourceWallet), { commitment: "confirmed" });
  const sdk = new PumpFunSDK(provider);
  const mint = Keypair.generate();
  
  try {
    const blob = new Blob([Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
    ])], { type: 'image/png' });

    await sdk.trade.createAndBuy(
      sourceWallet,
      mint,
      { name: "DEMO", symbol: "DEMO", description: "Demo token", file: blob },
      BigInt(0.0001 * LAMPORTS_PER_SOL),
      500n,
      { unitLimit: 250_000, unitPrice: 250_000 }
    );

    return mint.publicKey.toBase58();
  } catch {
    return null;
  }
}

async function findPumpSwapPool(connection: Connection) {
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
        const baseMint = new PublicKey(cacheData.baseMint);
        const poolQuoteTokenAccount = getAssociatedTokenAddressSync(NATIVE_MINT, poolPubkey, true);

        const quoteInfo = await connection.getAccountInfo(poolQuoteTokenAccount);
        if (quoteInfo) {
          const poolQuoteAmount = quoteInfo.data.readBigUInt64LE(64);
          if (poolQuoteAmount >= MIN && poolQuoteAmount <= MAX) {
            const quoteSol = Number(poolQuoteAmount) / LAMPORTS_PER_SOL;
            return { pool: poolPubkey, baseMint, liquidity: quoteSol };
          }
        }
      }
    }
  } catch {}
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

        const cacheData = {
          pool: pubkey.toBase58(),
          baseMint: baseMint.toBase58(),
          liquidity: quoteSol,
          timestamp: Date.now()
        };
        fs.writeFileSync(POOL_CACHE_FILE, JSON.stringify(cacheData, null, 2));

        return { pool: pubkey, baseMint, liquidity: quoteSol };
      }
    } catch {}
  }
  return null;
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
  let tokensFromBuy: string | null = null;

  // BUY
  let buyError: string | undefined;
  const buyPromise = new Promise<TradeResult | null>((resolve) => {
    let complete = false;
    let sourceSignature: string | null = null;

    const handler = async (tx: any) => {
      if (complete || tx.protocol !== protocol) return;
      const parseResult = parser.parse(tx);

      if (!parseResult.success) {
        if ('error' in parseResult) {
          buyError = parseResult.error;
          complete = true;
          resolve(null);
        }
        return; // Filtered or error
      }

      if (parseResult.data.type !== 'BUY') return;
      complete = true;

      // Store the source signature from the detected transaction
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
      const provider = new AnchorProvider(connection, new Wallet(sourceWallet), { commitment: "confirmed" });
      const sdk = new PumpFunSDK(provider);
      sdk.trade.buy(
        sourceWallet,
        new PublicKey(testMint!),
        BigInt(0.005 * LAMPORTS_PER_SOL),
        500n,
        { unitLimit: 300_000, unitPrice: 250_000 }
      ).catch((err) => {
        buyError = `Source transaction failed: ${err.message || err}`;
        resolve(null);
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
        
        const confirmed = await waitForConfirmation(connection, sig);
        if (confirmed) {
          try {
            const userTokenAccount = getAssociatedTokenAddressSync(
              poolInfo.baseMint,
              sourceWallet.publicKey
            );
            const accountInfo = await connection.getAccountInfo(userTokenAccount);
            if (accountInfo) {
              tokensFromBuy = accountInfo.data.readBigUInt64LE(64).toString();
            }
          } catch {}
        }
      }).catch(() => resolve(null));
    }

    setTimeout(() => {
      if (!complete) {
        complete = true;
        buyError = 'Timeout: No transaction detected after 15s';
        resolve(null);
      }
    }, 15000);
  });

  buyResult = await buyPromise;
  if (!buyResult) return { buy: null, sell: null, buyError, sellError: undefined };

  await new Promise(resolve => setTimeout(resolve, 2000));

  // SELL
  let sellError: string | undefined;
  const sellPromise = new Promise<TradeResult | null>((resolve) => {
    let complete = false;
    let sourceSignature: string | null = null;

    const handler = async (tx: any) => {
      if (complete || tx.protocol !== protocol) return;
      const parseResult = parser.parse(tx);

      if (!parseResult.success) {
        if ('error' in parseResult) {
          sellError = parseResult.error;
          complete = true;
          resolve(null);
        }
        return; // Filtered or error
      }

      if (parseResult.data.type !== 'SELL') return;
      complete = true;

      // Store the source signature from the detected transaction
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
      const provider = new AnchorProvider(connection, new Wallet(sourceWallet), { commitment: "confirmed" });
      const sdk = new PumpFunSDK(provider);
      connection.getTokenAccountsByOwner(
        sourceWallet.publicKey,
        { mint: new PublicKey(testMint!) }
      ).then(async (accounts) => {
        if (accounts.value.length === 0) return resolve(null);
        const balance = accounts.value[0].account.data.readBigUInt64LE(64);
        await sdk.trade.sell(
          sourceWallet,
          new PublicKey(testMint!),
          balance,
          500n,
          { unitLimit: 300_000, unitPrice: 250_000 }
        );
      }).catch((err) => {
        sellError = `Source transaction failed: ${err.message || err}`;
        resolve(null);
      });
    } else {
      const onlineSdk = new OnlinePumpAmmSdk(connection);
      onlineSdk.swapSolanaState(poolInfo.pool, sourceWallet.publicKey).then(async (swapState) => {
        const sellInstructions = await PUMP_AMM_SDK.sellBaseInput(
          swapState,
          new BN(tokensFromBuy || '0'),
          10
        );
        const tx = new Transaction();
        sellInstructions.forEach(ix => tx.add(ix));
        const { blockhash } = await connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.feePayer = sourceWallet.publicKey;
        tx.sign(sourceWallet);
        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        sourceSignature = sig;
      }).catch(() => resolve(null));
    }

    setTimeout(() => {
      if (!complete) {
        complete = true;
        sellError = 'Timeout: No transaction detected after 15s';
        resolve(null);
      }
    }, 15000);
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

  // Warmup phase to reduce first transaction latency
  process.stdout.write('Warming up SDK and RPC connections... ');
  try {
    // Warmup RPC connection
    await connection.getLatestBlockhash();

    // Warmup getAssociatedTokenAddress (used in every transaction)
    const dummyMint = new PublicKey('11111111111111111111111111111111');
    getAssociatedTokenAddressSync(dummyMint, pumpFunBuilder.getBotKeypair().publicKey);

    // Warmup PumpFun SDK instruction building
    const dummyBondingCurve = pumpFunBuilder['sdk'].pda.getBondingCurvePDA(dummyMint);
    const dummyAssociated = getAssociatedTokenAddressSync(dummyMint, pumpFunBuilder.getBotKeypair().publicKey);
    await pumpFunBuilder['sdk'].program.methods
      .buy(new BN(1000), new BN(1100))
      .accounts({
        global: pumpFunBuilder['sdk'].pda.getGlobalAccountPda(),
        feeRecipient: pumpFunBuilder['globalAccount'].feeRecipient,
        mint: dummyMint,
        bondingCurve: dummyBondingCurve,
        associatedBondingCurve: dummyAssociated,
        associatedUser: dummyAssociated,
        user: pumpFunBuilder.getBotKeypair().publicKey,
        creatorVault: pumpFunBuilder['sdk'].pda.getCreatorVaultPda(pumpFunBuilder.getBotKeypair().publicKey),
        eventAuthority: pumpFunBuilder['sdk'].pda.getEventAuthorityPda(),
        globalVolumeAccumulator: pumpFunBuilder['sdk'].pda.getGlobalVolumeAccumulatorPda(),
        userVolumeAccumulator: pumpFunBuilder['sdk'].pda.getUserVolumeAccumulatorPda(pumpFunBuilder.getBotKeypair().publicKey),
        feeConfig: pumpFunBuilder['sdk'].pda.getPumpFeeConfigPda(),
      })
      .instruction();

    console.log('Done');
  } catch {
    console.log('Failed (non-critical)');
  }

  const pendingConfirmations: PendingConfirmation[] = [];
  const failedTrades: FailedTrade[] = [];

  // PUMP.FUN
  console.log('\n' + '━'.repeat(60));
  console.log(`\nPUMP.FUN TEST (${NUM_CYCLES} cycles)\n`);

  const pumpFunBuys: TradeResult[] = [];
  const pumpFunSells: TradeResult[] = [];

  for (let i = 1; i <= NUM_CYCLES; i++) {
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

    if (i < NUM_CYCLES) await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // PUMPSWAP
  console.log(`\nPUMPSWAP TEST (${NUM_CYCLES} cycles)\n`);

  const pumpSwapBuys: TradeResult[] = [];
  const pumpSwapSells: TradeResult[] = [];

  for (let i = 1; i <= NUM_CYCLES; i++) {
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

    if (i < NUM_CYCLES) await new Promise(resolve => setTimeout(resolve, 1000));
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
  const pfBuyBlockStats = calculateStats(pfBuyBlocks);
  const pfSellBlockStats = calculateStats(pfSellBlocks);

  console.log(`PUMP.FUN (${pumpFunBuys.length} buys, ${pumpFunSells.length} sells)`);
  console.log('                   Processing Time (ms)         Block Distance (blks)');
  console.log('                   p50     p95     avg          p50    p95    avg');
  console.log(`  BUY:            ${String(pfBuyStats.p50).padStart(4)}    ${String(pfBuyStats.p95).padStart(4)}    ${String(pfBuyStats.avg).padStart(4)}           ${String(pfBuyBlockStats.p50).padStart(2)}     ${String(pfBuyBlockStats.p95).padStart(2)}   ${pfBuyBlockStats.avg.toFixed(1).padStart(4)}`);
  console.log(`  SELL:           ${String(pfSellStats.p50).padStart(4)}    ${String(pfSellStats.p95).padStart(4)}    ${String(pfSellStats.avg).padStart(4)}           ${String(pfSellBlockStats.p50).padStart(2)}     ${String(pfSellBlockStats.p95).padStart(2)}   ${pfSellBlockStats.avg.toFixed(1).padStart(4)}`);

  const psBuyStats = calculateStats(pumpSwapBuys.map(r => r.latency));
  const psSellStats = calculateStats(pumpSwapSells.map(r => r.latency));
  const psBuyBlockStats = calculateStats(psBuyBlocks);
  const psSellBlockStats = calculateStats(psSellBlocks);

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
  const totalBlockStats = calculateStats([...pfBuyBlocks, ...psBuyBlocks]);

  console.log(`\nLATENCY BREAKDOWN (${allBuys.length} buy operations)`);
  console.log('                       ' + 'p50'.padStart(7) + '    ' + 'p95'.padStart(7) + '    ' + 'avg'.padStart(7));
  console.log(`  Detection            ${String(detectionStats.p50).padStart(5)}ms    ${String(detectionStats.p95).padStart(5)}ms    ${String(Math.round(detectionStats.avg)).padStart(5)}ms`);
  console.log(`  Parsing              ${String(parsingStats.p50).padStart(5)}ms    ${String(parsingStats.p95).padStart(5)}ms    ${String(Math.round(parsingStats.avg)).padStart(5)}ms`);
  console.log(`  Building             ${String(buildingStats.p50).padStart(5)}ms    ${String(buildingStats.p95).padStart(5)}ms    ${String(Math.round(buildingStats.avg)).padStart(5)}ms`);
  console.log(`  Execution            ${String(executionStats.p50).padStart(5)}ms    ${String(executionStats.p95).padStart(5)}ms    ${String(Math.round(executionStats.avg)).padStart(5)}ms`);
  console.log(`  Total                ${String(totalStats.p50).padStart(5)}ms    ${String(totalStats.p95).padStart(5)}ms    ${String(Math.round(totalStats.avg)).padStart(5)}ms`);
  console.log(`  Block Distance       ${(String(totalBlockStats.p50) + 'blks').padStart(7)}    ${(String(totalBlockStats.p95) + 'blks').padStart(7)}    ${(totalBlockStats.avg.toFixed(1) + 'blks').padStart(7)}`);

  const totalOps = pumpFunBuys.length + pumpFunSells.length + pumpSwapBuys.length + pumpSwapSells.length;
  const expectedOps = NUM_CYCLES * 4;
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

main().catch((error) => {
  console.error('Demo failed:', error);
  process.exit(1);
});