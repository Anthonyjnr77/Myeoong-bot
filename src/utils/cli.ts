export function parseWalletsFromCLI(): string[] | null {
  const walletsIndex = process.argv.indexOf('--wallets');
  
  if (walletsIndex === -1) {
    return null;
  }
  
  const walletsArg = process.argv[walletsIndex + 1];
  
  if (!walletsArg) {
    throw new Error('--wallets flag requires comma-separated wallet addresses');
  }
  
  return walletsArg.split(',').map(w => w.trim()).filter(w => w.length > 0);
}
