/**
 * Antivirus scan of every upload (CR-07, Q3: ClamAV). `skip` marks files clean without scanning
 * and is refused in production by the configuration check.
 */
export type ScanVerdict = 'CLEAN' | 'INFECTED' | 'ERROR';

export interface AntivirusScanner {
  readonly mode: 'skip' | 'clamav';
  scan(data: Buffer): Promise<ScanVerdict>;
}

export function createScanner(mode: 'skip' | 'clamav'): AntivirusScanner {
  if (mode === 'skip') return { mode, scan: async () => 'CLEAN' };
  throw new Error("FILE_SCAN_MODE 'clamav' is not integrated yet (Q3)");
}
