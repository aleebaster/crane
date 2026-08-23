export function log(message: string): void {
  const now = new Date();
  const time = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join(':');
  console.log(`[${time}] ${message}`);
}

export function logError(message: string, error?: unknown): void {
  log(`ERROR: ${message}`);
  if (error instanceof Error) {
    console.error(`  ${error.message}`);
    if (error.stack) {
      console.error(`  ${error.stack.split('\n').slice(1).join('\n  ')}`);
    }
  } else if (error !== undefined) {
    console.error(`  ${String(error)}`);
  }
}

export function truncateAddress(address: string, visibleChars: number = 8): string {
  if (address.length <= visibleChars * 2) return address;
  return `${address.slice(0, visibleChars)}...${address.slice(-visibleChars)}`;
}
