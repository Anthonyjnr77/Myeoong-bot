import fs from 'fs';
import path from 'path';

export interface TradeLogData {
  phase: 'DETECTED' | 'SUCCESS' | 'FAILURE' | 'SIMULATE';
  protocol?: 'pumpfun' | 'pumpswap';
  type?: 'buy' | 'sell';
  mint?: string;
  pool?: string;
  amount?: number;
  copyAmount?: number; // Amount for the copy trade (config-based)
  buildTime?: number;
  execTime?: number;
  signature?: string;
  error?: string;
  instructions?: number;
}

export class Logger {
  private fileStream: fs.WriteStream;

  constructor(logFilePath: string) {
    // Ensure directory exists
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.fileStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  }

  private timestamp(): string {
    return new Date().toLocaleTimeString('en-US', { hour12: false });
  }

  private writeToFile(message: string): void {
    this.fileStream.write(`${message}\n`);
  }

  info(message: string): void {
    console.log(message);
    this.writeToFile(message);
  }

  error(message: string): void {
    const coloredMessage = `\x1b[31m${message}\x1b[0m`; // Red
    console.log(coloredMessage);
    this.writeToFile(message);
  }

  warn(message: string): void {
    const coloredMessage = `\x1b[33m${message}\x1b[0m`; // Yellow
    console.log(coloredMessage);
    this.writeToFile(message);
  }

  trade(data: TradeLogData): void {
    const time = this.timestamp();

    if (data.phase === 'DETECTED') {
      const protocolLabel = data.protocol === 'pumpfun' ? 'pump.fun' : 'PumpSwap';
      const typeLabel = data.type?.toUpperCase();

      console.log(`[${time}] DETECTED - ${protocolLabel} ${typeLabel}`);
      this.writeToFile(`[${time}] DETECTED - ${protocolLabel} ${typeLabel}`);

      // PumpSwap: show pool only, pump.fun: show mint
      if (data.protocol === 'pumpswap') {
        if (data.pool) {
          console.log(`    Pool: ${data.pool}`);
          this.writeToFile(`    Pool: ${data.pool}`);
        }
      } else if (data.protocol === 'pumpfun' && data.mint) {
        console.log(`    Mint: ${data.mint}`);
        this.writeToFile(`    Mint: ${data.mint}`);
      }

      console.log();
      this.writeToFile('');
    }

    else if (data.phase === 'SIMULATE') {
      const protocolLabel = data.protocol === 'pumpfun' ? 'pump.fun' : 'PumpSwap';
      const typeLabel = data.type?.toUpperCase();

      console.log(`[${time}] SIM - ${protocolLabel} ${typeLabel}`);
      this.writeToFile(`[${time}] SIM - ${protocolLabel} ${typeLabel}`);

      if (data.copyAmount !== undefined) {
        const amountText = data.type === 'sell' ? `${data.copyAmount}%` : `${data.copyAmount} SOL`;
        console.log(`    Amount: ${amountText}`);
        this.writeToFile(`    Amount: ${amountText}`);
      }

      if (data.buildTime !== undefined) {
        console.log(`    Built in ${data.buildTime}ms`);
        this.writeToFile(`    Built in ${data.buildTime}ms`);
      }

      console.log(`    NOT EXECUTED`);
      this.writeToFile(`    NOT EXECUTED`);
      console.log();
      this.writeToFile('');
    }

    else if (data.phase === 'SUCCESS') {
      const protocolLabel = data.protocol === 'pumpfun' ? 'pump.fun' : 'PumpSwap';
      const typeLabel = data.type?.toUpperCase();

      console.log(`[${time}] COPY - ${protocolLabel} ${typeLabel}`);
      this.writeToFile(`[${time}] COPY - ${protocolLabel} ${typeLabel}`);

      if (data.copyAmount !== undefined) {
        const amountText = data.type === 'sell' ? `${data.copyAmount}%` : `${data.copyAmount} SOL`;
        console.log(`    Amount: ${amountText}`);
        this.writeToFile(`    Amount: ${amountText}`);
      }

      if (data.buildTime !== undefined) {
        console.log(`    Built in ${data.buildTime}ms`);
        this.writeToFile(`    Built in ${data.buildTime}ms`);
      }

      if (data.execTime !== undefined) {
        console.log(`    Executed in ${data.execTime}ms`);
        this.writeToFile(`    Executed in ${data.execTime}ms`);
      }

      if (data.signature) {
        console.log(`    \x1b[32m✓\x1b[0m Sig: ${data.signature}`);
        this.writeToFile(`    ✓ Sig: ${data.signature}`);
      }

      console.log();
      this.writeToFile('');
    }

    else if (data.phase === 'FAILURE') {
      console.log(`[${time}] COPYING...`);
      this.writeToFile(`[${time}] COPYING...`);

      if (data.buildTime !== undefined) {
        console.log(`           Built in ${data.buildTime}ms`);
        this.writeToFile(`           Built in ${data.buildTime}ms`);
      }

      if (data.error) {
        console.log(`           \x1b[31m✗\x1b[0m ${data.error}`);
        this.writeToFile(`           ✗ ${data.error}`);
      }

      console.log();
      this.writeToFile('');
    }
  }

  close(): void {
    this.fileStream.end();
  }
}
