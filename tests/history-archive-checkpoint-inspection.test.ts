import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

import {
  inspectCheckpoint,
  isValidCheckpointLedger,
  nearestCheckpoint,
  formatCheckpointInspection,
  serializeCheckpointInspection,
  CHECKPOINT_FREQUENCY,
} from '../src/services/history-archive-checkpoint-inspection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildHas(opts: {
  version?: number;
  currentLedger?: number;
  networkPassphrase?: string;
  buckets?: Array<{ curr: string; snap: string }>;
}): string {
  return JSON.stringify({
    version: opts.version ?? 1,
    currentLedger: opts.currentLedger ?? 63,
    networkPassphrase: opts.networkPassphrase ?? 'Test SDF Network ; September 2015',
    buckets: opts.buckets ?? [
      { curr: 'abc123', snap: '0000000000000000000000000000000000000000000000000000000000000000' },
    ],
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-insp-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Checkpoint ledger maths
// ---------------------------------------------------------------------------

describe('checkpoint ledger helpers', () => {
  it('identifies valid checkpoint ledger sequences', () => {
    // 63 = 64*1 - 1, 127 = 64*2 - 1, etc.
    expect(isValidCheckpointLedger(63)).toBe(true);
    expect(isValidCheckpointLedger(127)).toBe(true);
    expect(isValidCheckpointLedger(191)).toBe(true);
  });

  it('rejects non-checkpoint ledger sequences', () => {
    expect(isValidCheckpointLedger(64)).toBe(false);
    expect(isValidCheckpointLedger(100)).toBe(false);
    expect(isValidCheckpointLedger(0)).toBe(false);
  });

  it('rejects negative ledger sequences', () => {
    expect(isValidCheckpointLedger(-1)).toBe(false);
  });

  it('computes the nearest checkpoint at or below a ledger', () => {
    expect(nearestCheckpoint(63)).toBe(63);
    expect(nearestCheckpoint(64)).toBe(63);
    expect(nearestCheckpoint(127)).toBe(127);
    expect(nearestCheckpoint(130)).toBe(127);
  });

  it('exports the standard checkpoint frequency constant', () => {
    expect(CHECKPOINT_FREQUENCY).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// HAS file parsing
// ---------------------------------------------------------------------------

describe('HAS file parsing', () => {
  it('parses version, currentLedger, and networkPassphrase from a valid HAS', () => {
    const hasContent = buildHas({ currentLedger: 63, networkPassphrase: 'Public Global Stellar Network ; September 2015' });
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, hasContent);

    const result = inspectCheckpoint({ checkpointPath: hasPath });

    expect(result.has?.version).toBe(1);
    expect(result.has?.currentLedger).toBe(63);
    expect(result.has?.networkPassphrase).toBe('Public Global Stellar Network ; September 2015');
  });

  it('extracts bucket references from the HAS', () => {
    const hasContent = buildHas({
      currentLedger: 63,
      buckets: [
        { curr: 'abc', snap: '000' },
        { curr: 'def', snap: '000' },
      ],
    });
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, hasContent);

    const result = inspectCheckpoint({ checkpointPath: hasPath });

    expect(result.has?.buckets.length).toBe(4); // 2 levels × 2 slots
    expect(result.has?.buckets[0].slot).toBe('curr');
    expect(result.has?.buckets[1].slot).toBe('snap');
  });

  it('marks zero-hash buckets as empty', () => {
    const zeroHash = '0000000000000000000000000000000000000000000000000000000000000000';
    const hasContent = buildHas({
      currentLedger: 63,
      buckets: [{ curr: 'realHash', snap: zeroHash }],
    });
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, hasContent);

    const result = inspectCheckpoint({ checkpointPath: hasPath });

    const snapBucket = result.has?.buckets.find((b) => b.slot === 'snap');
    expect(snapBucket?.empty).toBe(true);

    const currBucket = result.has?.buckets.find((b) => b.slot === 'curr');
    expect(currBucket?.empty).toBe(false);
  });

  it('reports a parse error for malformed JSON', () => {
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, 'not json {{{');

    const result = inspectCheckpoint({ checkpointPath: hasPath });

    expect(result.hasError).toBeTruthy();
    expect(result.warnings.some((w) => /parse/i.test(w))).toBe(true);
  });

  it('parses a gzip-compressed .history.gz file', () => {
    const hasContent = buildHas({ currentLedger: 63 });
    const compressed = zlib.gzipSync(Buffer.from(hasContent));
    const hasPath = path.join(tmpDir, 'checkpoint.history.gz');
    fs.writeFileSync(hasPath, compressed);

    const result = inspectCheckpoint({ checkpointPath: hasPath });

    expect(result.errors).toHaveLength(0);
    expect(result.has?.currentLedger).toBe(63);
  });
});

// ---------------------------------------------------------------------------
// Valid checkpoint ledger detection
// ---------------------------------------------------------------------------

describe('checkpoint validation', () => {
  it('flags the result as a valid checkpoint for a correct ledger sequence', () => {
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, buildHas({ currentLedger: 63 }));

    const result = inspectCheckpoint({ checkpointPath: hasPath });

    expect(result.isValidCheckpointLedger).toBe(true);
    expect(result.checkpointLedgerSeq).toBe(63);
  });

  it('warns and flags invalid when currentLedger is not a checkpoint', () => {
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, buildHas({ currentLedger: 60 }));

    const result = inspectCheckpoint({ checkpointPath: hasPath });

    expect(result.isValidCheckpointLedger).toBe(false);
    expect(result.warnings.some((w) => /not a valid checkpoint/i.test(w))).toBe(true);
  });

  it('warns when HAS currentLedger mismatches the expected ledger', () => {
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, buildHas({ currentLedger: 63 }));

    const result = inspectCheckpoint({ checkpointPath: hasPath, expectedLedgerSeq: 127 });

    expect(result.warnings.some((w) => /does not match/i.test(w))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Directory inspection
// ---------------------------------------------------------------------------

describe('checkpoint directory inspection', () => {
  it('locates the .history file within a directory', () => {
    const hasContent = buildHas({ currentLedger: 63 });
    fs.writeFileSync(path.join(tmpDir, 'checkpoint.history'), hasContent);

    const result = inspectCheckpoint({ checkpointPath: tmpDir });

    expect(result.isDirectory).toBe(true);
    expect(result.hasFilePath).toBeTruthy();
    expect(result.has?.currentLedger).toBe(63);
  });

  it('enumerates files in the checkpoint directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'checkpoint.history'), buildHas({ currentLedger: 63 }));
    fs.writeFileSync(path.join(tmpDir, 'ledger-00000000.xdr.gz'), Buffer.alloc(10));
    fs.writeFileSync(path.join(tmpDir, 'transactions-00000000.xdr.gz'), Buffer.alloc(10));

    const result = inspectCheckpoint({ checkpointPath: tmpDir });

    expect(result.files.length).toBeGreaterThanOrEqual(3);
    const categories = result.files.map((f) => f.category);
    expect(categories).toContain('has');
    expect(categories).toContain('ledger-header');
    expect(categories).toContain('transaction');
  });

  it('warns when no .history file is present in the directory', () => {
    fs.writeFileSync(path.join(tmpDir, 'some-other-file.txt'), 'data');

    const result = inspectCheckpoint({ checkpointPath: tmpDir });

    expect(result.warnings.some((w) => /no .history/i.test(w))).toBe(true);
  });

  it('reports an error for a missing path', () => {
    const result = inspectCheckpoint({
      checkpointPath: path.join(tmpDir, 'does-not-exist'),
    });

    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

describe('read-only guarantee', () => {
  it('does not modify any files in the directory', () => {
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    const hasContent = buildHas({ currentLedger: 63 });
    fs.writeFileSync(hasPath, hasContent);
    const before = fs.readdirSync(tmpDir).sort();

    inspectCheckpoint({ checkpointPath: tmpDir });

    const after = fs.readdirSync(tmpDir).sort();
    expect(after).toEqual(before);
  });

  it('sets readOnly to true on the result', () => {
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, buildHas({ currentLedger: 63 }));

    const result = inspectCheckpoint({ checkpointPath: hasPath });

    expect(result.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  it('formatCheckpointInspection returns a human-readable string', () => {
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, buildHas({ currentLedger: 63 }));

    const result = inspectCheckpoint({ checkpointPath: hasPath });
    const text = formatCheckpointInspection(result);

    expect(typeof text).toBe('string');
    expect(text).toMatch(/checkpoint|ledger/i);
  });

  it('serializeCheckpointInspection returns a structured object', () => {
    const hasPath = path.join(tmpDir, 'checkpoint.history');
    fs.writeFileSync(hasPath, buildHas({ currentLedger: 63 }));

    const result = inspectCheckpoint({ checkpointPath: hasPath });
    const serialized = serializeCheckpointInspection(result);

    expect(typeof serialized).toBe('object');
    expect(serialized.checkpointLedgerSeq).toBe(63);
    expect(serialized.readOnly).toBe(true);
  });
});
