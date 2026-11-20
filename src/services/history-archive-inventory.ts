import * as fs from 'fs';
import * as path from 'path';

/**
 * Stellar History Archive File Inventory
 *
 * Scans a locally accessible Stellar history archive directory, classifies
 * recognised files, calculates storage usage, and generates an inventory
 * report.
 *
 * Stellar history archives follow a well-known directory layout:
 *
 *   <root>/
 *     .well-known/stellar.toml  (optional)
 *     history/
 *       <checkpoints>/
 *         <ledger>.history
 *     ledger/
 *       <checkpoints>/
 *         ledger-<seq>.xdr.gz
 *     transactions/
 *       <checkpoints>/
 *         transactions-<seq>.xdr.gz
 *     results/
 *       <checkpoints>/
 *         results-<seq>.xdr.gz
 *     bucket/
 *       <prefix>/
 *         bucket-<hash>.xdr.gz
 *
 * This module walks the archive directory, classifies each file by its
 * containing directory and name pattern, calculates total and per-category
 * storage, identifies unusually large files, and flags unexpected artifacts.
 *
 * The scan is fully read-only and handles large archives via iterative directory
 * walking (no recursion stack overflow risk for deep trees).
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ArchiveFileCategory =
  | 'has'           // .history JSON files
  | 'ledger-header' // ledger/ xdr files
  | 'transaction'   // transactions/ xdr files
  | 'result'        // results/ xdr files
  | 'bucket'        // bucket/ xdr files
  | 'other';        // unrecognised but present

export interface InventoryFile {
  /** Relative path from the archive root. */
  relativePath: string;
  /** File size in bytes. */
  sizeBytes: number;
  /** Whether the file is gzip-compressed. */
  compressed: boolean;
  category: ArchiveFileCategory;
}

export interface CategorySummary {
  fileCount: number;
  totalBytes: number;
}

export interface StorageFootprint {
  totalBytes: number;
  byCategory: Record<ArchiveFileCategory, CategorySummary>;
}

export interface LargeFileRecord {
  relativePath: string;
  sizeBytes: number;
  category: ArchiveFileCategory;
}

export interface InventoryReport {
  /** Resolved absolute path to the archive root. */
  archiveRoot: string;
  /** Total number of files scanned (all categories). */
  totalFiles: number;
  /** Total number of directories visited. */
  totalDirectories: number;
  /** Storage footprint summary. */
  storageFootprint: StorageFootprint;
  /** Files larger than the large-file threshold, sorted descending by size. */
  largeFiles: LargeFileRecord[];
  /**
   * Directories that could not be read (permission denied, broken symlinks,
   * etc.). The scan continues after recording these.
   */
  inaccessiblePaths: string[];
  /** Non-fatal warnings about the archive. */
  warnings: string[];
  /** Fatal errors that prevented the scan. */
  errors: string[];
  readOnly: boolean;
  scannedAt: string;
  disclaimers: string[];
}

export interface InventoryOptions {
  /** Path to the archive root directory. */
  archiveRoot: string;
  /**
   * File size in bytes above which a file is listed in `largeFiles`.
   * Default: 100 MiB.
   */
  largeFileThresholdBytes?: number;
  /**
   * Maximum number of files to include in the detailed listing.
   * Counts continue regardless; listing rows are capped. Default: 10 000.
   */
  maxFiles?: number;
  /**
   * Whether to skip inaccessible subdirectories silently (default: false —
   * they are recorded in inaccessiblePaths).
   */
  silenceInaccessible?: boolean;
}

// ---------------------------------------------------------------------------
// File classification
// ---------------------------------------------------------------------------

const DEFAULT_LARGE_FILE_THRESHOLD = 100 * 1024 * 1024; // 100 MiB
const DEFAULT_MAX_FILES = 10_000;

/**
 * Classify a file given its path relative to the archive root.
 *
 * The first segment of the relative path indicates the top-level category
 * directory; the filename pattern provides additional confirmation.
 */
function classifyFile(relativePath: string): ArchiveFileCategory {
  const parts = relativePath.split(path.sep);
  const topDir = parts[0]?.toLowerCase() ?? '';
  const name = parts[parts.length - 1] ?? '';
  const baseName = name.replace(/\.gz$/, '');

  // history/ contains HAS (.history) files.
  if (topDir === 'history' || baseName.endsWith('.history')) {
    return 'has';
  }

  // ledger/ contains ledger header XDR files.
  if (topDir === 'ledger' || /^ledger-/.test(baseName)) {
    return 'ledger-header';
  }

  // transactions/ contains transaction history XDR files.
  if (topDir === 'transactions' || /^transactions-/.test(baseName)) {
    return 'transaction';
  }

  // results/ contains transaction result XDR files.
  if (topDir === 'results' || /^results-/.test(baseName)) {
    return 'result';
  }

  // bucket/ contains bucket XDR files.
  if (topDir === 'bucket' || /^bucket-/.test(baseName)) {
    return 'bucket';
  }

  return 'other';
}

// ---------------------------------------------------------------------------
// Directory walker (iterative to avoid call-stack limits)
// ---------------------------------------------------------------------------

interface WalkResult {
  files: InventoryFile[];
  totalDirectories: number;
  inaccessiblePaths: string[];
  truncated: boolean;
}

function walkArchive(
  root: string,
  maxFiles: number,
  silenceInaccessible: boolean,
): WalkResult {
  const result: WalkResult = {
    files: [],
    totalDirectories: 0,
    inaccessiblePaths: [],
    truncated: false,
  };

  // Queue of directories to visit.
  const queue: string[] = [root];

  while (queue.length > 0) {
    const dir = queue.shift()!;
    result.totalDirectories++;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err: any) {
      if (!silenceInaccessible) {
        result.inaccessiblePaths.push(path.relative(root, dir) || '.');
      }
      continue;
    }

    for (const entry of entries) {
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }

      if (!entry.isFile()) {
        // Skip symlinks, fifos, etc.
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        // Skip files we cannot stat.
        continue;
      }

      const rel = path.relative(root, abs);
      const category = classifyFile(rel);

      if (result.files.length < maxFiles) {
        result.files.push({
          relativePath: rel,
          sizeBytes: stat.size,
          compressed: entry.name.endsWith('.gz'),
          category,
        });
      } else {
        // Still count toward totals — handled after walk.
        result.truncated = true;
        // We push a minimal record for counting only (no path, so it's cheap).
        result.files.push({
          relativePath: '',
          sizeBytes: stat.size,
          compressed: false,
          category,
        });
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Storage footprint calculation
// ---------------------------------------------------------------------------

function emptyFootprint(): StorageFootprint {
  const byCategory: Record<ArchiveFileCategory, CategorySummary> = {
    'has': { fileCount: 0, totalBytes: 0 },
    'ledger-header': { fileCount: 0, totalBytes: 0 },
    'transaction': { fileCount: 0, totalBytes: 0 },
    'result': { fileCount: 0, totalBytes: 0 },
    'bucket': { fileCount: 0, totalBytes: 0 },
    'other': { fileCount: 0, totalBytes: 0 },
  };
  return { totalBytes: 0, byCategory };
}

function computeFootprint(files: InventoryFile[]): StorageFootprint {
  const fp = emptyFootprint();
  for (const f of files) {
    fp.totalBytes += f.sizeBytes;
    fp.byCategory[f.category].fileCount++;
    fp.byCategory[f.category].totalBytes += f.sizeBytes;
  }
  return fp;
}

function buildDisclaimers(): string[] {
  return [
    'This scan is read-only and does not modify the archive.',
    'File classification is based on directory names and filename patterns; files in unexpected locations may be misclassified as "other".',
    'Storage sizes reflect compressed file sizes on disk, not the uncompressed XDR payload size.',
    'The scan does not verify file contents, checksums, or archive completeness.',
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function scanArchiveInventory(options: InventoryOptions): InventoryReport {
  const warnings: string[] = [];
  const errors: string[] = [];
  const largeFileThreshold = options.largeFileThresholdBytes ?? DEFAULT_LARGE_FILE_THRESHOLD;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const silenceInaccessible = options.silenceInaccessible ?? false;

  let archiveRoot: string;
  try {
    archiveRoot = path.resolve(options.archiveRoot);
  } catch (err: any) {
    return {
      archiveRoot: options.archiveRoot,
      totalFiles: 0,
      totalDirectories: 0,
      storageFootprint: emptyFootprint(),
      largeFiles: [],
      inaccessiblePaths: [],
      warnings,
      errors: [`Cannot resolve path: ${err?.message ?? String(err)}`],
      readOnly: true,
      scannedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  // Confirm the root exists and is a directory.
  try {
    const stat = fs.statSync(archiveRoot);
    if (!stat.isDirectory()) {
      errors.push(`'${archiveRoot}' is not a directory.`);
      return {
        archiveRoot,
        totalFiles: 0,
        totalDirectories: 0,
        storageFootprint: emptyFootprint(),
        largeFiles: [],
        inaccessiblePaths: [],
        warnings,
        errors,
        readOnly: true,
        scannedAt: new Date().toISOString(),
        disclaimers: buildDisclaimers(),
      };
    }
  } catch (err: any) {
    errors.push(`Cannot access '${archiveRoot}': ${err?.message ?? String(err)}`);
    return {
      archiveRoot,
      totalFiles: 0,
      totalDirectories: 0,
      storageFootprint: emptyFootprint(),
      largeFiles: [],
      inaccessiblePaths: [],
      warnings,
      errors,
      readOnly: true,
      scannedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  // Walk the archive.
  const walk = walkArchive(archiveRoot, maxFiles, silenceInaccessible);

  if (walk.truncated) {
    warnings.push(
      `File listing truncated at ${maxFiles} entries. Total counts reflect all files found.`,
    );
  }

  if (walk.inaccessiblePaths.length > 0) {
    warnings.push(
      `${walk.inaccessiblePaths.length} directory/directories could not be read (see inaccessiblePaths).`,
    );
  }

  // Identify "other" files.
  const otherCount = walk.files.filter((f) => f.category === 'other' && f.relativePath).length;
  if (otherCount > 0) {
    warnings.push(`${otherCount} file(s) could not be classified as recognised archive artifacts.`);
  }

  // Compute footprint.
  const storageFootprint = computeFootprint(walk.files);

  // Large files (only from files with paths, i.e. not overflow placeholders).
  const largeFiles: LargeFileRecord[] = walk.files
    .filter((f) => f.relativePath && f.sizeBytes >= largeFileThreshold)
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
    .map((f) => ({
      relativePath: f.relativePath,
      sizeBytes: f.sizeBytes,
      category: f.category,
    }));

  return {
    archiveRoot,
    totalFiles: walk.files.length,
    totalDirectories: walk.totalDirectories,
    storageFootprint,
    largeFiles,
    inaccessiblePaths: walk.inaccessiblePaths,
    warnings,
    errors,
    readOnly: true,
    scannedAt: new Date().toISOString(),
    disclaimers: buildDisclaimers(),
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = BYTES_PER_KB * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

function humanBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(2)} GiB`;
  if (bytes >= BYTES_PER_MB) return `${(bytes / BYTES_PER_MB).toFixed(2)} MiB`;
  if (bytes >= BYTES_PER_KB) return `${(bytes / BYTES_PER_KB).toFixed(2)} KiB`;
  return `${bytes} B`;
}

export function formatInventoryReport(report: InventoryReport): string {
  const lines: string[] = [];
  lines.push('Stellar History Archive File Inventory');
  lines.push('======================================');
  lines.push(`Archive root:    ${report.archiveRoot}`);
  lines.push(`Scanned at:      ${report.scannedAt}`);
  lines.push(`Total files:     ${report.totalFiles.toLocaleString()}`);
  lines.push(`Total dirs:      ${report.totalDirectories.toLocaleString()}`);
  lines.push(`Total size:      ${humanBytes(report.storageFootprint.totalBytes)}`);
  lines.push('');

  lines.push('Storage by Category');
  lines.push('-------------------');
  const categories: ArchiveFileCategory[] = ['has', 'ledger-header', 'transaction', 'result', 'bucket', 'other'];
  for (const cat of categories) {
    const s = report.storageFootprint.byCategory[cat];
    if (s.fileCount === 0) continue;
    lines.push(`  ${cat.padEnd(16)} ${s.fileCount.toLocaleString().padStart(8)} files  ${humanBytes(s.totalBytes)}`);
  }
  lines.push('');

  if (report.largeFiles.length > 0) {
    lines.push(`Large Files (>${humanBytes(0)} threshold, ${report.largeFiles.length} found)`);
    lines.push('----------');
    for (const f of report.largeFiles.slice(0, 20)) {
      lines.push(`  [${f.category.padEnd(14)}] ${humanBytes(f.sizeBytes).padStart(10)}  ${f.relativePath}`);
    }
    if (report.largeFiles.length > 20) {
      lines.push(`  ... and ${report.largeFiles.length - 20} more`);
    }
    lines.push('');
  }

  if (report.inaccessiblePaths.length > 0) {
    lines.push('Inaccessible Paths');
    lines.push('------------------');
    for (const p of report.inaccessiblePaths.slice(0, 10)) {
      lines.push(`  - ${p}`);
    }
    if (report.inaccessiblePaths.length > 10) {
      lines.push(`  ... and ${report.inaccessiblePaths.length - 10} more`);
    }
    lines.push('');
  }

  if (report.warnings.length > 0) {
    lines.push('Warnings');
    lines.push('--------');
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
    lines.push('');
  }

  if (report.errors.length > 0) {
    lines.push('Errors');
    lines.push('------');
    for (const e of report.errors) {
      lines.push(`  ! ${e}`);
    }
    lines.push('');
  }

  lines.push('Disclaimers');
  lines.push('-----------');
  for (const d of report.disclaimers) {
    lines.push(`  - ${d}`);
  }

  return lines.join('\n');
}

export function serializeInventoryReport(report: InventoryReport): Record<string, unknown> {
  return {
    archiveRoot: report.archiveRoot,
    totalFiles: report.totalFiles,
    totalDirectories: report.totalDirectories,
    storageFootprint: {
      totalBytes: report.storageFootprint.totalBytes,
      byCategory: report.storageFootprint.byCategory,
    },
    largeFiles: report.largeFiles,
    inaccessiblePaths: report.inaccessiblePaths,
    warnings: report.warnings,
    errors: report.errors,
    readOnly: report.readOnly,
    scannedAt: report.scannedAt,
    disclaimers: report.disclaimers,
  };
}
