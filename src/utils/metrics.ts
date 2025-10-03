import fs from 'fs';

interface ProtocolMetrics {
  detected: number;
  successful: number;
  failed: number;
}

interface SessionMetrics {
  mode: 'simulate' | 'live';
  detected: number;
  successful: number;
  failed: number;
  filtered: number;
  byProtocol: {
    pumpfun: ProtocolMetrics;
    pumpswap: ProtocolMetrics;
  };
  buildLatencies: number[];
  executionLatencies: number[];
  buildOutliers: number[];
  execOutliers: number[];
  errors: Array<{ timestamp: number; protocol: string; error: string }>;
  startTime: number;
}

interface StatsOutput {
  successRate: number;
  avgBuildTime: number;
  avgExecTime: number | null;
  avgTotalTime: number | null;
  buildOutliers: number[];
  execOutliers: number[];
  uptime: string;
}

export class Metrics {
  private stats: SessionMetrics;

  constructor(mode: 'simulate' | 'live') {
    this.stats = {
      mode,
      detected: 0,
      successful: 0,
      failed: 0,
      filtered: 0,
      byProtocol: {
        pumpfun: { detected: 0, successful: 0, failed: 0 },
        pumpswap: { detected: 0, successful: 0, failed: 0 }
      },
      buildLatencies: [],
      executionLatencies: [],
      buildOutliers: [],
      execOutliers: [],
      errors: [],
      startTime: Date.now()
    };
  }

  recordDetection(protocol: 'pumpfun' | 'pumpswap'): void {
    this.stats.detected++;
    this.stats.byProtocol[protocol].detected++;
  }

  recordSuccess(protocol: 'pumpfun' | 'pumpswap', buildTime: number, execTime?: number): void {
    this.stats.successful++;
    this.stats.byProtocol[protocol].successful++;
    this.stats.buildLatencies.push(buildTime);

    if (execTime !== undefined) {
      this.stats.executionLatencies.push(execTime);
    }
  }

  recordFailure(protocol: 'pumpfun' | 'pumpswap', error: string): void {
    this.stats.failed++;
    this.stats.byProtocol[protocol].failed++;

    this.stats.errors.push({
      timestamp: Date.now(),
      protocol,
      error
    });

    // Keep only last 10 errors
    if (this.stats.errors.length > 10) {
      this.stats.errors.shift();
    }
  }

  recordFiltered(): void {
    this.stats.filtered++;
  }

  private removeOutliers(values: number[]): { clean: number[]; outliers: number[] } {
    const OUTLIER_THRESHOLD = 2000; // ms
    const clean: number[] = [];
    const outliers: number[] = [];

    values.forEach(v => {
      if (v > OUTLIER_THRESHOLD) {
        outliers.push(v);
      } else {
        clean.push(v);
      }
    });

    return { clean, outliers };
  }

  getStats(): StatsOutput {
    const total = this.stats.successful + this.stats.failed;
    const successRate = total > 0 ? (this.stats.successful / total) * 100 : 0;

    // Remove outliers from build times
    const buildResult = this.removeOutliers(this.stats.buildLatencies);
    const avgBuildTime = buildResult.clean.length > 0
      ? Math.round(buildResult.clean.reduce((a, b) => a + b, 0) / buildResult.clean.length)
      : 0;
    this.stats.buildOutliers = buildResult.outliers;

    // Remove outliers from execution times
    const execResult = this.removeOutliers(this.stats.executionLatencies);
    const avgExecTime = execResult.clean.length > 0
      ? Math.round(execResult.clean.reduce((a, b) => a + b, 0) / execResult.clean.length)
      : null;
    this.stats.execOutliers = execResult.outliers;

    const avgTotalTime = avgExecTime !== null ? avgBuildTime + avgExecTime : null;

    const uptimeMs = Date.now() - this.stats.startTime;
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptimeMin = Math.floor(uptimeSec / 60);
    const uptimeHour = Math.floor(uptimeMin / 60);

    let uptime: string;
    if (uptimeHour > 0) {
      uptime = `${uptimeHour}h ${uptimeMin % 60}m ${uptimeSec % 60}s`;
    } else if (uptimeMin > 0) {
      uptime = `${uptimeMin}m ${uptimeSec % 60}s`;
    } else {
      uptime = `${uptimeSec}s`;
    }

    return {
      successRate,
      avgBuildTime,
      avgExecTime,
      avgTotalTime,
      buildOutliers: this.stats.buildOutliers,
      execOutliers: this.stats.execOutliers,
      uptime
    };
  }

  printSummary(): void {
    const stats = this.getStats();
    const modeLabel = this.stats.mode.toUpperCase();

    console.log('═'.repeat(60));
    console.log(`SESSION SUMMARY (${modeLabel} MODE)`);
    console.log('═'.repeat(60));
    console.log();
    console.log(`Uptime:          ${stats.uptime}`);
    console.log(`Detected:        ${this.stats.detected}`);
    console.log(`Successful:      ${this.stats.successful}`);
    console.log(`Failed:          ${this.stats.failed}`);
    console.log(`Filtered:        ${this.stats.filtered}`);
    console.log(`Success Rate:    ${stats.successRate.toFixed(1)}%`);
    console.log();
    console.log(`Avg Build Time:  ${stats.avgBuildTime}ms`);
    if (stats.avgExecTime !== null) {
      console.log(`Avg Exec Time:   ${stats.avgExecTime}ms`);
      console.log(`Avg Total Time:  ${stats.avgTotalTime}ms`);
    } else {
      console.log(`⚠️  No transactions executed (simulate mode)`);
    }
    console.log();

    // Protocol breakdown
    console.log('By Protocol:');
    console.log(`  pump.fun:  ${this.stats.byProtocol.pumpfun.successful}/${this.stats.byProtocol.pumpfun.detected} successful`);
    console.log(`  PumpSwap:  ${this.stats.byProtocol.pumpswap.successful}/${this.stats.byProtocol.pumpswap.detected} successful`);

    // Outliers
    if (stats.buildOutliers.length > 0 || stats.execOutliers.length > 0) {
      console.log();
      console.log('Outliers (excluded from averages):');
      if (stats.buildOutliers.length > 0) {
        console.log(`  Build times: ${stats.buildOutliers.map(v => `${v}ms`).join(', ')}`);
      }
      if (stats.execOutliers.length > 0) {
        console.log(`  Exec times:  ${stats.execOutliers.map(v => `${v}ms`).join(', ')}`);
      }
    }

    // Recent errors
    if (this.stats.errors.length > 0) {
      console.log();
      console.log('Recent Errors:');
      this.stats.errors.slice(-5).forEach(err => {
        const time = new Date(err.timestamp).toLocaleTimeString();
        console.log(`  [${time}] ${err.protocol}: ${err.error}`);
      });
    }
  }

  saveToFileSync(filepath: string): void {
    const data = {
      ...this.stats,
      summary: this.getStats()
    };

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
