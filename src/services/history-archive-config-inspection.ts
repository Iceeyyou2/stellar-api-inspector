import * as fs from 'fs';
import * as path from 'path';

/**
 * Stellar History Archive Configuration Inspection
 *
 * Read-only inspection of Stellar history archive configuration files.
 * Identifies configured storage backends, evaluates whether referenced
 * local resources are accessible, and surfaces misconfiguration issues.
 *
 * Stellar Core's history archive configuration lives in `stellar-core.cfg`
 * (or a user-supplied TOML/INI-style config). Archive stanzas follow a
 * pattern like:
 *
 *   [HISTORY.archiveName]
 *   get="cp /path/to/archive/{0} {1}"
 *   put="cp {0} /path/to/archive/{1}"
 *   mkdir="mkdir -p /path/to/archive/{0}"
 *
 * This module parses those stanzas, identifies backend types (local filesystem,
 * s3, gcs, azure, http, custom), and validates local paths where possible.
 *
 * It never writes to the config file or the archive directories.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ArchiveBackendType =
  | 'local'
  | 's3'
  | 'gcs'
  | 'azure'
  | 'http'
  | 'https'
  | 'custom'
  | 'unknown';

export interface ArchiveCommandSet {
  get: string | null;
  put: string | null;
  mkdir: string | null;
}

export interface ArchiveBackend {
  /** Archive name as it appears in the config stanza, e.g. "primary". */
  name: string;
  /** Inferred backend type. */
  backendType: ArchiveBackendType;
  /** Raw command strings extracted from the config. */
  commands: ArchiveCommandSet;
  /**
   * Local filesystem path inferred from the commands, if the backend appears
   * to be a local copy command. Null for remote backends.
   */
  localPath: string | null;
  /** Whether the local path is accessible (directory exists and is readable). */
  localPathAccessible: boolean | null;
  /** Reason local path accessibility check failed, if applicable. */
  localPathError: string | null;
  /** Non-fatal warnings specific to this backend. */
  warnings: string[];
}

export interface ConfigInspectionResult {
  /** Resolved absolute path to the config file. */
  configFilePath: string;
  /** Whether the config file was read successfully. */
  configReadable: boolean;
  /** Raw config file content (for diagnostics). */
  rawContent: string | null;
  /** Parsed archive backends. */
  backends: ArchiveBackend[];
  /** Non-fatal warnings about the overall config. */
  warnings: string[];
  /** Fatal errors that prevented full inspection. */
  errors: string[];
  readOnly: boolean;
  inspectedAt: string;
  disclaimers: string[];
}

export interface ConfigInspectionOptions {
  /** Path to the Stellar Core config file. */
  configFilePath: string;
  /**
   * Whether to skip local-path accessibility checks.
   * Default: false (checks are performed).
   */
  skipAccessibilityChecks?: boolean;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Minimal TOML/INI parser scoped to the HISTORY.* section format used by
 * Stellar Core. Returns a map of section → key → value strings.
 *
 * Rules:
 *  - Lines starting with `#` or `;` are comments.
 *  - `[SECTION]` starts a new section.
 *  - `KEY = "VALUE"` or `KEY = VALUE` are entries.
 *  - Continuation lines and multi-line values are not supported (Stellar Core
 *    history stanzas don't use them).
 */
function parseConfig(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let currentSection = '';

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    // Section header.
    const sectionMatch = line.match(/^\[([^\]]+)\]/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (!sections.has(currentSection)) {
        sections.set(currentSection, new Map());
      }
      continue;
    }

    // Key = value.
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1 || !currentSection) {
      continue;
    }

    const key = line.slice(0, eqIdx).trim().toLowerCase();
    let value = line.slice(eqIdx + 1).trim();

    // Strip surrounding quotes.
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    sections.get(currentSection)!.set(key, value);
  }

  return sections;
}

/**
 * Extract the HISTORY.* sections from the parsed config.
 * Stellar Core uses [HISTORY.archiveName] stanzas.
 */
function extractHistorySections(sections: Map<string, Map<string, string>>): Array<{ name: string; entries: Map<string, string> }> {
  const result: Array<{ name: string; entries: Map<string, string> }> = [];
  for (const [section, entries] of sections) {
    const upper = section.toUpperCase();
    if (upper === 'HISTORY' || upper.startsWith('HISTORY.')) {
      const name = upper === 'HISTORY' ? 'default' : section.slice('HISTORY.'.length);
      result.push({ name, entries });
    }
  }
  return result;
}

/**
 * Infer the backend type from a command string.
 *
 * Heuristics:
 *  - Commands using `cp`, `mv`, or absolute/relative paths → local
 *  - Commands containing `aws s3` or `s3://` → s3
 *  - Commands containing `gsutil` or `gs://` → gcs
 *  - Commands containing `az storage` or `wasbs://` / `abfs://` → azure
 *  - Commands starting with `curl`, `wget`, or containing `http://` → http
 *  - Commands starting with `curl`, `wget`, or containing `https://` → https
 */
function inferBackendType(commands: ArchiveCommandSet): ArchiveBackendType {
  const all = [commands.get, commands.put, commands.mkdir]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/aws\s+s3|s3:\/\//.test(all)) return 's3';
  if (/gsutil|gs:\/\//.test(all)) return 'gcs';
  if (/az\s+storage|wasbs:\/\/|abfs:\/\//.test(all)) return 'azure';
  if (/https?:\/\//.test(all)) {
    return all.includes('https://') ? 'https' : 'http';
  }
  if (/\bcp\b|\bmv\b|\/|\.\//.test(all)) return 'local';
  if (commands.get || commands.put || commands.mkdir) return 'custom';
  return 'unknown';
}

/**
 * Attempt to extract a local filesystem path from a cp/mv command template.
 *
 * Stellar Core templates use `{0}` for the remote key and `{1}` for the
 * local destination (get) or the reverse (put). We try to find the base
 * directory shared by both operands.
 *
 * Example: `cp /archives/primary/{0} {1}` → `/archives/primary`
 */
function extractLocalPath(commands: ArchiveCommandSet): string | null {
  const candidates = [commands.get, commands.put, commands.mkdir].filter(Boolean) as string[];

  for (const cmd of candidates) {
    // Strip the command verb (cp, mv, mkdir, etc.) and flags.
    const tokens = cmd.trim().split(/\s+/);
    for (const token of tokens) {
      if (token.startsWith('-')) continue;
      if (token === 'cp' || token === 'mv' || token === 'mkdir') continue;
      // Look for a path-like token containing {0} or a bare path segment.
      if (token.includes('{0}') || token.includes('{1}')) {
        // Strip the placeholder and trailing slashes to get the base dir.
        const base = token
          .replace(/\{0\}.*/, '')
          .replace(/\{1\}.*/, '')
          .replace(/\/+$/, '');
        if (base && (base.startsWith('/') || base.startsWith('.') || base.startsWith('~'))) {
          return base || null;
        }
      } else if (token.startsWith('/') || token.startsWith('./') || token.startsWith('~/')) {
        return token;
      }
    }
  }

  return null;
}

/**
 * Check whether a local path is accessible as a directory.
 */
function checkLocalAccessibility(localPath: string): { accessible: boolean; error: string | null } {
  const expanded = localPath.replace(/^~/, process.env.HOME ?? '');
  try {
    const stat = fs.statSync(expanded);
    if (!stat.isDirectory()) {
      return { accessible: false, error: `Path '${expanded}' exists but is not a directory.` };
    }
    // Probe readability.
    fs.readdirSync(expanded);
    return { accessible: true, error: null };
  } catch (err: any) {
    const code = err?.code ?? '';
    if (code === 'ENOENT') {
      return { accessible: false, error: `Path '${expanded}' does not exist.` };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { accessible: false, error: `Insufficient permissions to access '${expanded}'.` };
    }
    return { accessible: false, error: `Cannot access '${expanded}': ${err?.message ?? String(err)}` };
  }
}

function buildDisclaimers(): string[] {
  return [
    'This inspection is read-only and does not modify the config file or archive directories.',
    'Backend type inference is heuristic; custom or non-standard command templates may be misclassified.',
    'Local-path accessibility checks only verify that the path exists and is a readable directory.',
    'Remote backend accessibility (S3, GCS, Azure, HTTP) is not checked.',
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function inspectArchiveConfig(options: ConfigInspectionOptions): ConfigInspectionResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const skipChecks = options.skipAccessibilityChecks ?? false;

  const configFilePath = path.resolve(options.configFilePath);

  // Read the config file.
  let rawContent: string | null = null;
  try {
    rawContent = fs.readFileSync(configFilePath, 'utf8');
  } catch (err: any) {
    const msg = `Cannot read config file '${configFilePath}': ${err?.message ?? String(err)}`;
    errors.push(msg);
    return {
      configFilePath,
      configReadable: false,
      rawContent: null,
      backends: [],
      warnings,
      errors,
      readOnly: true,
      inspectedAt: new Date().toISOString(),
      disclaimers: buildDisclaimers(),
    };
  }

  // Parse and extract HISTORY sections.
  const sections = parseConfig(rawContent);
  const historySections = extractHistorySections(sections);

  if (historySections.length === 0) {
    warnings.push('No HISTORY archive stanzas found in the config file.');
  }

  // Build backend descriptors.
  const backends: ArchiveBackend[] = [];

  for (const { name, entries } of historySections) {
    const backendWarnings: string[] = [];
    const commands: ArchiveCommandSet = {
      get: entries.get('get') ?? null,
      put: entries.get('put') ?? null,
      mkdir: entries.get('mkdir') ?? null,
    };

    if (!commands.get && !commands.put && !commands.mkdir) {
      backendWarnings.push(`Archive '${name}' has no get/put/mkdir commands configured.`);
    }

    const backendType = inferBackendType(commands);
    const localPath = backendType === 'local' ? extractLocalPath(commands) : null;

    let localPathAccessible: boolean | null = null;
    let localPathError: string | null = null;

    if (localPath && !skipChecks) {
      const { accessible, error: accessErr } = checkLocalAccessibility(localPath);
      localPathAccessible = accessible;
      localPathError = accessErr;
      if (!accessible && accessErr) {
        backendWarnings.push(`Archive '${name}' local path issue: ${accessErr}`);
      }
    }

    if (backendType === 'http') {
      backendWarnings.push(`Archive '${name}' uses an unencrypted HTTP backend.`);
    }

    backends.push({
      name,
      backendType,
      commands,
      localPath,
      localPathAccessible,
      localPathError,
      warnings: backendWarnings,
    });
  }

  // Surface per-backend warnings at the top level too.
  for (const b of backends) {
    warnings.push(...b.warnings);
  }

  return {
    configFilePath,
    configReadable: true,
    rawContent,
    backends,
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

export function formatArchiveConfigInspection(result: ConfigInspectionResult): string {
  const lines: string[] = [];
  lines.push('Stellar History Archive Configuration Inspection');
  lines.push('================================================');
  lines.push(`Config file:  ${result.configFilePath}`);
  lines.push(`Readable:     ${result.configReadable}`);
  lines.push(`Inspected at: ${result.inspectedAt}`);
  lines.push('');

  if (result.backends.length > 0) {
    lines.push(`Archive Backends (${result.backends.length})`);
    lines.push('------------------');
    for (const b of result.backends) {
      lines.push(`  [${b.name}]`);
      lines.push(`    Backend type: ${b.backendType}`);
      lines.push(`    get:          ${b.commands.get ?? '(none)'}`);
      lines.push(`    put:          ${b.commands.put ?? '(none)'}`);
      lines.push(`    mkdir:        ${b.commands.mkdir ?? '(none)'}`);
      if (b.localPath) {
        lines.push(`    Local path:   ${b.localPath}`);
        lines.push(`    Accessible:   ${b.localPathAccessible ?? 'not checked'}`);
        if (b.localPathError) {
          lines.push(`    Path error:   ${b.localPathError}`);
        }
      }
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

export function serializeArchiveConfigInspection(result: ConfigInspectionResult): Record<string, unknown> {
  return {
    configFilePath: result.configFilePath,
    configReadable: result.configReadable,
    backends: result.backends.map((b) => ({
      name: b.name,
      backendType: b.backendType,
      commands: b.commands,
      localPath: b.localPath,
      localPathAccessible: b.localPathAccessible,
      localPathError: b.localPathError,
      warnings: b.warnings,
    })),
    warnings: result.warnings,
    errors: result.errors,
    readOnly: result.readOnly,
    inspectedAt: result.inspectedAt,
    disclaimers: result.disclaimers,
  };
}
