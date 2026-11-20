import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  scanArchiveInventory,
  formatInventoryReport,
  serializeInventoryReport,
} from '../src/services/history-archive-inventory';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-inventory-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Create a file of the given size (in bytes) filled with zeros. */
function createFile(dir: string, name: string, sizeBytes: number): string {
  const p = path.join(dir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(sizeBytes, 0));
  return p;
}

/** Build a minimal archive-like directory structure. */
function buildArchive(root: string): void {
  // HAS files
  createFile(path.join(root, 'history', '00', '00', '00'), 'checkpoint.history', 512);
  // Ledger header
  createFile(path.join(root, 'ledger', '00', '00', '00'), 'ledger-0000003f.xdr.gz', 1024);
  // Transaction history
  createFile(path.join(root, 'transactions', '00', '00', '00'), 'transactions-0000003f.xdr.gz', 2048);
  // Transaction results
  createFile(path.join(root, 'results', '00', '00', '00'), 'results-0000003f.xdr.gz', 512);
  // Bucket
  createFile(path.join(root, 'bucket', 'fe', 'dc'), 'bucket-fedcba98.xdr.gz', 4096);
  // Unknown file
  createFile(root, 'README.txt', 100);
}

// ---------------------------------------------------------------------------
// File counting and total size
// ---------------------------------------------------------------------------

describe('file counting and storage totals', () => {
  it('counts all files in a populated archive directory', () => {
    buildArchive(tmpDir);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.totalFiles).toBe(6); // 5 archive files + README
    expect(report.errors).toHaveLength(0);
  });

  it('computes the correct total storage footprint', () => {
    buildArchive(tmpDir);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    // 512 + 1024 + 2048 + 512 + 4096 + 100 = 8292
    expect(report.storageFootprint.totalBytes).toBe(8292);
  });

  it('reports zero files for an empty archive directory', () => {
    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.totalFiles).toBe(0);
    expect(report.storageFootprint.totalBytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

describe('file classification', () => {
  it('classifies HAS files correctly', () => {
    createFile(path.join(tmpDir, 'history', '00'), 'checkpoint.history', 100);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.storageFootprint.byCategory['has'].fileCount).toBe(1);
  });

  it('classifies ledger header files correctly', () => {
    createFile(path.join(tmpDir, 'ledger', '00'), 'ledger-0000003f.xdr.gz', 100);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.storageFootprint.byCategory['ledger-header'].fileCount).toBe(1);
  });

  it('classifies transaction files correctly', () => {
    createFile(path.join(tmpDir, 'transactions', '00'), 'transactions-0000003f.xdr.gz', 100);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.storageFootprint.byCategory['transaction'].fileCount).toBe(1);
  });

  it('classifies result files correctly', () => {
    createFile(path.join(tmpDir, 'results', '00'), 'results-0000003f.xdr.gz', 100);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.storageFootprint.byCategory['result'].fileCount).toBe(1);
  });

  it('classifies bucket files correctly', () => {
    createFile(path.join(tmpDir, 'bucket', 'fe', 'dc'), 'bucket-fedcba98.xdr.gz', 100);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.storageFootprint.byCategory['bucket'].fileCount).toBe(1);
  });

  it('classifies unrecognised files as "other"', () => {
    createFile(tmpDir, 'unknown-artifact.bin', 100);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.storageFootprint.byCategory['other'].fileCount).toBe(1);
    expect(report.warnings.some((w) => /classified/i.test(w))).toBe(true);
  });

  it('accumulates per-category byte counts', () => {
    createFile(path.join(tmpDir, 'ledger', '00'), 'ledger-0000003f.xdr.gz', 1000);
    createFile(path.join(tmpDir, 'ledger', '00'), 'ledger-0000007f.xdr.gz', 2000);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });

    expect(report.storageFootprint.byCategory['ledger-header'].totalBytes).toBe(3000);
    expect(report.storageFootprint.byCategory['ledger-header'].fileCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Large file detection
// ---------------------------------------------------------------------------

describe('large file detection', () => {
  it('identifies files above the threshold as large', () => {
    createFile(path.join(tmpDir, 'bucket', 'ab'), 'bucket-ab.xdr.gz', 200);
    createFile(path.join(tmpDir, 'bucket', 'cd'), 'bucket-cd.xdr.gz', 50);

    const report = scanArchiveInventory({
      archiveRoot: tmpDir,
      largeFileThresholdBytes: 100,
    });

    expect(report.largeFiles).toHaveLength(1);
    expect(report.largeFiles[0].sizeBytes).toBe(200);
  });

  it('sorts large files by descending size', () => {
    createFile(path.join(tmpDir, 'bucket', 'a1'), 'bucket-a1.xdr.gz', 300);
    createFile(path.join(tmpDir, 'bucket', 'a2'), 'bucket-a2.xdr.gz', 500);
    createFile(path.join(tmpDir, 'bucket', 'a3'), 'bucket-a3.xdr.gz', 100);

    const report = scanArchiveInventory({
      archiveRoot: tmpDir,
      largeFileThresholdBytes: 50,
    });

    const sizes = report.largeFiles.map((f) => f.sizeBytes);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
  });

  it('reports no large files when all are below the threshold', () => {
    createFile(path.join(tmpDir, 'ledger', '00'), 'ledger-00.xdr.gz', 10);

    const report = scanArchiveInventory({
      archiveRoot: tmpDir,
      largeFileThresholdBytes: 1000,
    });

    expect(report.largeFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error and edge cases
// ---------------------------------------------------------------------------

describe('error and edge cases', () => {
  it('reports an error for a missing archive root', () => {
    const report = scanArchiveInventory({
      archiveRoot: path.join(tmpDir, 'does-not-exist'),
    });

    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('reports an error when the path is not a directory', () => {
    const filePath = path.join(tmpDir, 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'data');

    const report = scanArchiveInventory({ archiveRoot: filePath });

    expect(report.errors.length).toBeGreaterThan(0);
  });

  it('records inaccessible subdirectories without aborting the scan', () => {
    buildArchive(tmpDir);

    // Create a subdirectory that is not readable.
    const lockedDir = path.join(tmpDir, 'locked-subdir');
    fs.mkdirSync(lockedDir, { recursive: true });
    createFile(lockedDir, 'some-file.txt', 50);

    try {
      fs.chmodSync(lockedDir, 0o000);
    } catch {
      // If we cannot chmod (e.g. running as root), skip this test.
      return;
    }

    try {
      const report = scanArchiveInventory({ archiveRoot: tmpDir });
      // The locked dir should be recorded; the rest of the archive is still scanned.
      expect(report.inaccessiblePaths.length).toBeGreaterThan(0);
      expect(report.totalFiles).toBeGreaterThan(0);
    } finally {
      // Restore permissions so cleanup works.
      try { fs.chmodSync(lockedDir, 0o755); } catch { /* ignore */ }
    }
  });
});

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

describe('read-only guarantee', () => {
  it('does not modify any files in the archive directory', () => {
    buildArchive(tmpDir);
    const before = fs.readdirSync(tmpDir).sort();

    scanArchiveInventory({ archiveRoot: tmpDir });

    const after = fs.readdirSync(tmpDir).sort();
    expect(after).toEqual(before);
  });

  it('sets readOnly to true on the report', () => {
    const report = scanArchiveInventory({ archiveRoot: tmpDir });
    expect(report.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  it('formatInventoryReport returns a human-readable string', () => {
    buildArchive(tmpDir);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });
    const text = formatInventoryReport(report);

    expect(typeof text).toBe('string');
    expect(text).toMatch(/archive|storage|inventory/i);
  });

  it('serializeInventoryReport returns a structured object', () => {
    buildArchive(tmpDir);

    const report = scanArchiveInventory({ archiveRoot: tmpDir });
    const serialized = serializeInventoryReport(report);

    expect(typeof serialized).toBe('object');
    expect(serialized.readOnly).toBe(true);
    expect(typeof serialized.totalFiles).toBe('number');
  });
});
