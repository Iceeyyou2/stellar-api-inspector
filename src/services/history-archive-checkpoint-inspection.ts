import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/**
 * Stellar History Archive Checkpoint Inspection
 *
 * Read-only inspection of Stellar history archive checkpoint metadata and the
 * ledger state represented by an archived checkpoint.
 *
 * Stellar history archives organise data around checkpoint ledgers, which occur
 * every 64 ledgers (the standard checkpoint frequency). Each checkpoint directory
 * contains several categories of files, most importantly the .history JSON
 * document, ledger header xdr files, and the bucket-list hash.
 *
 * This module exposes:
 *  - Checkpoint ledger identification and sanity-check (ledger must be a valid
 *    checkpoint, i.e. (ledgerSeq + 1) % 64 === 0).
 *  - Inspection of the .history JSON file (HAS – History Archive State).
 *  - Enumeration of files present under the checkpoint directory.
 *  - Surface-level bucket-list metadata from the HAS (hash + level count).
 *
 * It explicitly does NOT perform full archive integrity verification or
 * cryptographic re-derivation of bucket-list hashes.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Standard Stellar checkpoint frequency (ledgers per checkpoint). */
export const CHECKPOINT_FREQUENCY = 64;

export interface CheckpointBucketRef {
  /** Bucket level index (0-based). */
  level: number;
  /** Whether this is the "curr" or "snap" bucket at this level. */
  slot: 'curr' | 'snap';
  /** Bucket content hash (hex). Empty string if not present. */
  hash: string;
  /** Whether this is an empty / zero bucket. */
  empty: boolean;
}

export interface HistoryArchiveState {
  /** Version field from the HAS JSON. */
  version: number | null;
  /** Current ledger sequence recorded in the HAS. */
  currentLedger: number | null;
  /** Network passphrase recorded in the HAS, if present. */
  networkPassphrase: string | null;
  /** Bucket references extracted from the HAS. */
  buckets: CheckpointBucketRef[];
  /** Raw HAS object for callers that need full detail. */
  raw: Record<string, unknown>;
}

export interface CheckpointFile {
  /** Relative path from the checkpoint root. */
  relativePath: string;
  /** Absolute path. */
  absolutePath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Whether the file is gzip-compressed (.gz). */
  compressed: boolean;
  /** Recognised file category. */
  category: CheckpointFileCategory;
}

export type CheckpointFileCategory =
  | 'has'
  | 'ledger-header'
  | 'transaction'
  | 'transaction-result'
  | 'bucket'
  | 'other';

export interface CheckpointInspectionOptions {
  /**
   * Path to the checkpoint directory, or path to the .history JSON file
   * directly. When a directory is supplied the inspector locates the .history
   * file automatically.
   */
  checkpointPath: string;
  /**
   * Expected checkpoint ledger sequence. When provided the inspector validates
   * that the HAS currentLedger matches this value.
   */
  expectedLedgerSeq?: number;
}

export interface CheckpointInspectionResult {
  /** Resolved absolute path inspected. */
  resolvedPath: string;
  /** Whether resolvedPath points to a directory (true) or a file (false). */
  isDirectory: boolean;
  /** Whether the checkpoint ledger sequence is a valid checkpoint number. */
  isValidCheckpointLedger: boolean | null;
  /** Checkpoint ledger sequence (from HAS or derived from path). */
  checkpointLedgerSeq: number | null;
  /** History Archive State parsed from the .history file. */
  has: HistoryArchiveState | null;
  /** Path to the .history file, if found. */
  hasFilePath: string | null;
  /** Error encountered while reading/parsing the HAS, if any. */
  hasError: string | null;
  /** Files enumerated within the checkpoint directory. */
  files: CheckpointFile[];
  /** Non-fatal warnings. */
  warnings: string[];
  /** Fatal errors that prevented inspection. */
  errors: string[];
  readOnly: boolean;
  inspectedAt: string;
  disclaimers: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ZERO_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Check whether a ledger sequence number represents a valid Stellar checkpoint.
 * A valid checkpoint satisfies (seq + 1) % CHECKPOINT_FREQUENCY === 0.
 */
export function isValidCheckpointLedger(ledgerSeq: number): boolean {
  if (!Number.isInteger(ledgerSeq) || ledgerSeq < 0) {
    return false;
  }
  return (ledgerSeq + 1) % CHECKPOINT_FREQUENCY === 0;
}

/**
 * Derive the nearest checkpoint ledger at or below the given sequence number.
 */
export function nearestCheckpoint(ledgerSeq: number): number {
  return Math.floor((ledgerSeq + 1) / CHECKPOINT_FREQUENCY) * CHECKPOINT_FREQUENCY - 1;
}

/**
 * Categorise a filename into one of the known checkpoint file categories.
 */
function categoriseFile(name: string): CheckpointFileCategory {
  const base = name.replace(/\.gz$/, '');
  if (base.endsWith('.history') || base === 'history') {
    return 'has';
  }
  if (/ledger-/.test(base)) {
    return 'ledger-header';
  }
  if (/transactions-/.test(base)) {
    return 'transaction';
  }
  if (/results-/.test(base)) {
    return 'transaction-result';
  }
  if (/bucket-/.test(base)) {
    return 'bucket';
  }
  return 'other';
}

/**
 * Read and decompress a file if it is gzip-compressed.
 */
function readMaybeGzip(filePath: string): { text: string; error: string | null } {
  let raw: Buffer;
  try {
    raw = fs.readFileSync(filePath);
  } catch (err: any) {
    return { text: '', error: `Cannot read '${filePath}': ${err?.message ?? String(err)}` };
  }

  if (filePath.endsWith('.gz')) {
    try {
      raw = zlib.gunzipSync(raw);
    } catch (err: any) {
      return { text: '', error: `Cannot decompress '${filePath}': ${err?.message ?? String(err)}` };
    }
  }

  return { text: raw.toString('utf8'), error: null };
}

/**
 * Locate the .history JSON file within a checkpoint directory.
 * Stellar archives typically use the pattern `<ledger>.history` or just
 * a file named after the checkpoint inside the last path component.
 */
function findHasFile(dir: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const e of entries) {
    if (!e.isFile()) continue;
    const name = e.name;
    if (name.endsWith('.history') || name.endsWith('.history.gz')) {
      return path.join(dir, name);
    }
  }
  return null;
}

/**
 * Parse the History Archive State JSON document.
 */
function parseHas(text: string): { has: HistoryArchiveState; error: string | null } {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(text);
  } catch (err: any) {
    return {
      has: { version: null, currentLedger: null, networkPassphrase: null, buckets: [], raw: {} },
      error: `JSON parse error: ${err?.message ?? String(err)}`,
    };
  }

  const version = typeof obj.version === 'number' ? obj.version : null;
  const currentLedger = typeof obj.currentLedger === 'number' ? obj.currentLedger : null;
  const networkPassphrase =
    typeof obj.networkPassphrase === 'string' ? obj.networkPassphrase : null;

  const buckets: CheckpointBucketRef[] = [];
  const bucketList = Array.isArray(obj.buckets) ? (obj.buckets as unknown[]) : [];

  for (let i = 0; i < bucketList.length; i++) {
    const level = bucketList[i] as Record<string, unknown>;
    if (!level || typeof level !== 'object') continue;

    for (const slot of ['curr', 'snap'] as const) {
      const hash = typeof level[slot] === 'string' ? (level[slot] as string) : '';
      buckets.push({
        level: i,
        slot,
        hash,
        empty: !hash || hash === ZERO_HASH,
      });
    }
  }

  return {
    has: { version, currentLedger, networkPassphrase, buckets, raw: obj },
    error: null,
  };
}

/**
 * Enumerate files within a directory (non-recursive).
 */
function enumerateCheckpointFiles(dir: string): CheckpointFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: CheckpointFile[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const abs = path.join(dir, e.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    files.push({
      relativePath: e.name,
      absolutePath: abs,
      sizeBytes: stat.size,
      compressed: e.name.endsWith('.gz'),
      category: categoriseFile(e.name),
    });
  }
  return files;
}

function buildDisclaimers(): string[] {
  return [
    'This inspection is read-only and does not modify the archive.',
    'Checkpoint metadata inspection does not constitute full archive integrity verification.',
    'Bucket-list hashes are reported as found in the HAS; cryptographic re-derivation is not performed.',
    'A valid checkpoint ledger sequence does not guarantee all checkpoint files are present or uncorrupted.',
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Inspect a Stellar history archive checkpoint directory or HAS file.
 */
export function inspectCheckpoint(options: CheckpointInspectionOptions): CheckpointInspectionResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  let resolvedPath: string;
  try {
    resolvedPath = path.resolve(options.checkpointPath);
  } catch (err: any) {
    return {
      resolvedPath: options.checkpointPath,
      isDirectory: false,
      isValidCheckpointLedger: null,
      checkpointLedgerSeq: null,
      has: null,
      hasFilePath: null,
      hasError: null,
      files: [],
      warnings,
      errors: [`Cannot resolve path '${options.checkpointPath}': ${err?.message ?? String(err)}`],
      readOnly: true,
      inspectedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolvedPath);
  } catch (err: any) {
    errors.push(`Cannot access '${resolvedPath}': ${err?.message ?? String(err)}`);
    return {
      resolvedPath,
      isDirectory: false,
      isValidCheckpointLedger: null,
      checkpointLedgerSeq: null,
      has: null,
      hasFilePath: null,
      hasError: null,
      files: [],
      warnings,
      errors,
      readOnly: true,
      inspectedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  const isDirectory = stat.isDirectory();
  let hasFilePath: string | null = null;
  let files: CheckpointFile[] = [];

  if (isDirectory) {
    hasFilePath = findHasFile(resolvedPath);
    files = enumerateCheckpointFiles(resolvedPath);
    if (!hasFilePath) {
      warnings.push(`No .history file found in '${resolvedPath}'.`);
    }
  } else {
    // Treat the path itself as the HAS file.
    hasFilePath = resolvedPath;
  }

  // Parse the HAS.
  let has: HistoryArchiveState | null = null;
  let hasError: string | null = null;

  if (hasFilePath) {
    const { text, error: readError } = readMaybeGzip(hasFilePath);
    if (readError) {
      hasError = readError;
      errors.push(readError);
    } else {
      const { has: parsed, error: parseError } = parseHas(text);
      has = parsed;
      if (parseError) {
        hasError = parseError;
        warnings.push(`HAS parse warning: ${parseError}`);
      }
    }
  }

  // Determine checkpoint ledger sequence.
  const checkpointLedgerSeq = has?.currentLedger ?? null;
  let isValidCP: boolean | null = null;
  if (checkpointLedgerSeq !== null) {
    isValidCP = isValidCheckpointLedger(checkpointLedgerSeq);
    if (!isValidCP) {
      warnings.push(
        `currentLedger ${checkpointLedgerSeq} is not a valid checkpoint sequence. ` +
          `Expected (ledgerSeq + 1) % ${CHECKPOINT_FREQUENCY} === 0.`,
      );
    }
  }

  // Validate against expected ledger if supplied.
  if (options.expectedLedgerSeq !== undefined && checkpointLedgerSeq !== null) {
    if (checkpointLedgerSeq !== options.expectedLedgerSeq) {
      warnings.push(
        `HAS currentLedger ${checkpointLedgerSeq} does not match expected ${options.expectedLedgerSeq}.`,
      );
    }
  }

  // Warn if no buckets found in HAS.
  if (has && has.buckets.length === 0) {
    warnings.push('HAS buckets array is empty.');
  }

  return {
    resolvedPath,
    isDirectory,
    isValidCheckpointLedger: isValidCP,
    checkpointLedgerSeq,
    has,
    hasFilePath,
    hasError,
    files,
    warnings,
    errors,
    readOnly: true,
    inspectedAt: new Date().toISOString(),
    disclaimers: buildDisclaimers(),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatCheckpointInspection(result: CheckpointInspectionResult): string {
  const lines: string[] = [];
  lines.push('Stellar History Archive Checkpoint Inspection');
  lines.push('=============================================');
  lines.push(`Path:                ${result.resolvedPath}`);
  lines.push(`Is directory:        ${result.isDirectory}`);
  lines.push(`Inspected at:        ${result.inspectedAt}`);
  lines.push('');

  lines.push('Checkpoint');
  lines.push('----------');
  lines.push(`  Ledger sequence:   ${result.checkpointLedgerSeq ?? 'n/a'}`);
  lines.push(`  Valid checkpoint:  ${result.isValidCheckpointLedger ?? 'n/a'}`);
  lines.push('');

  if (result.has) {
    lines.push('History Archive State (HAS)');
    lines.push('---------------------------');
    lines.push(`  HAS file:          ${result.hasFilePath ?? 'n/a'}`);
    lines.push(`  Version:           ${result.has.version ?? 'n/a'}`);
    lines.push(`  Current ledger:    ${result.has.currentLedger ?? 'n/a'}`);
    lines.push(`  Network:           ${result.has.networkPassphrase ?? 'n/a'}`);
    lines.push(`  Bucket refs:       ${result.has.buckets.length}`);
    const nonEmpty = result.has.buckets.filter((b) => !b.empty).length;
    lines.push(`  Non-empty buckets: ${nonEmpty}`);
    lines.push('');
  }

  if (result.isDirectory && result.files.length > 0) {
    lines.push(`Files (${result.files.length})`);
    lines.push('-------');
    for (const f of result.files) {
      lines.push(`  [${f.category.padEnd(18)}] ${f.relativePath} (${f.sizeBytes.toLocaleString()} bytes)`);
    }
    lines.push('');
  }

  if (result.warnings.length > 0) {
    lines.push('Warnings');
    lines.push('--------');
    for (const w of result.warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push('');
  }

  if (result.errors.length > 0) {
    lines.push('Errors');
    lines.push('------');
    for (const e of result.errors) {
      lines.push(`  ! ${e}`);
    }
    lines.push('');
  }

  lines.push('Disclaimers');
  lines.push('-----------');
  for (const d of result.disclaimers) {
    lines.push(`  - ${d}`);
  }

  return lines.join('\n');
}

export function serializeCheckpointInspection(result: CheckpointInspectionResult): Record<string, unknown> {
  return {
    resolvedPath: result.resolvedPath,
    isDirectory: result.isDirectory,
    isValidCheckpointLedger: result.isValidCheckpointLedger,
    checkpointLedgerSeq: result.checkpointLedgerSeq,
    hasFilePath: result.hasFilePath,
    hasError: result.hasError,
    has: result.has
      ? {
          version: result.has.version,
          currentLedger: result.has.currentLedger,
          networkPassphrase: result.has.networkPassphrase,
          buckets: result.has.buckets,
        }
      : null,
    files: result.files.map((f) => ({
      relativePath: f.relativePath,
      sizeBytes: f.sizeBytes,
      compressed: f.compressed,
      category: f.category,
    })),
    warnings: result.warnings,
    errors: result.errors,
    readOnly: result.readOnly,
    inspectedAt: result.inspectedAt,
    disclaimers: result.disclaimers,
  };
}
