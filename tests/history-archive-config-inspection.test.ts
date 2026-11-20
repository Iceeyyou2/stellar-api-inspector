import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  inspectArchiveConfig,
  formatArchiveConfigInspection,
  serializeArchiveConfigInspection,
} from '../src/services/history-archive-config-inspection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-config-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeConfig(content: string): string {
  const p = path.join(tmpDir, 'stellar-core.cfg');
  fs.writeFileSync(p, content);
  return p;
}

// ---------------------------------------------------------------------------
// Config file parsing
// ---------------------------------------------------------------------------

describe('config file parsing', () => {
  it('parses a local archive stanza', () => {
    const archiveDir = path.join(tmpDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const cfg = writeConfig(`
[HISTORY.primary]
get="cp ${archiveDir}/{0} {1}"
put="cp {0} ${archiveDir}/{1}"
mkdir="mkdir -p ${archiveDir}/{0}"
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.configReadable).toBe(true);
    expect(result.backends).toHaveLength(1);
    expect(result.backends[0].name).toBe('primary');
    expect(result.backends[0].backendType).toBe('local');
  });

  it('recognises S3 backends', () => {
    const cfg = writeConfig(`
[HISTORY.s3-archive]
get="aws s3 cp s3://my-bucket/{0} {1}"
put="aws s3 cp {0} s3://my-bucket/{1}"
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.backends[0].backendType).toBe('s3');
  });

  it('recognises GCS backends', () => {
    const cfg = writeConfig(`
[HISTORY.gcs-archive]
get="gsutil cp gs://my-bucket/{0} {1}"
put="gsutil cp {0} gs://my-bucket/{1}"
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.backends[0].backendType).toBe('gcs');
  });

  it('recognises Azure backends', () => {
    const cfg = writeConfig(`
[HISTORY.azure-archive]
get="az storage blob download --container-name archive"
put="az storage blob upload --container-name archive"
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.backends[0].backendType).toBe('azure');
  });

  it('recognises HTTPS backends', () => {
    const cfg = writeConfig(`
[HISTORY.cdn]
get="curl -sf https://history.example.com/{0} -o {1}"
put=""
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.backends[0].backendType).toBe('https');
  });

  it('warns on HTTP (unencrypted) backends', () => {
    const cfg = writeConfig(`
[HISTORY.insecure]
get="curl -sf http://history.example.com/{0} -o {1}"
put=""
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.warnings.some((w) => /http/i.test(w))).toBe(true);
  });

  it('parses multiple HISTORY stanzas', () => {
    const cfg = writeConfig(`
[HISTORY.primary]
get="aws s3 cp s3://bucket/{0} {1}"
put="aws s3 cp {0} s3://bucket/{1}"
mkdir=""

[HISTORY.secondary]
get="aws s3 cp s3://backup/{0} {1}"
put="aws s3 cp {0} s3://backup/{1}"
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.backends).toHaveLength(2);
    const names = result.backends.map((b) => b.name);
    expect(names).toContain('primary');
    expect(names).toContain('secondary');
  });

  it('warns when no HISTORY stanzas are found', () => {
    const cfg = writeConfig(`
[GENERAL]
NODE_SEED = "some-seed"
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.warnings.some((w) => /no history/i.test(w))).toBe(true);
  });

  it('reports an error for a missing config file', () => {
    const result = inspectArchiveConfig({
      configFilePath: path.join(tmpDir, 'nonexistent.cfg'),
    });

    expect(result.configReadable).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Local path accessibility
// ---------------------------------------------------------------------------

describe('local path accessibility', () => {
  it('marks an accessible local archive path as accessible', () => {
    const archiveDir = path.join(tmpDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const cfg = writeConfig(`
[HISTORY.local]
get="cp ${archiveDir}/{0} {1}"
put="cp {0} ${archiveDir}/{1}"
mkdir="mkdir -p ${archiveDir}/{0}"
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.backends[0].localPathAccessible).toBe(true);
    expect(result.backends[0].localPathError).toBeNull();
  });

  it('marks a missing local path as inaccessible with an error', () => {
    const missingDir = path.join(tmpDir, 'does-not-exist');
    const cfg = writeConfig(`
[HISTORY.local]
get="cp ${missingDir}/{0} {1}"
put="cp {0} ${missingDir}/{1}"
mkdir="mkdir -p ${missingDir}/{0}"
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.backends[0].localPathAccessible).toBe(false);
    expect(result.backends[0].localPathError).toMatch(/does not exist|cannot access/i);
  });

  it('skips accessibility checks when skipAccessibilityChecks is true', () => {
    const missingDir = path.join(tmpDir, 'does-not-exist');
    const cfg = writeConfig(`
[HISTORY.local]
get="cp ${missingDir}/{0} {1}"
put="cp {0} ${missingDir}/{1}"
mkdir="mkdir -p ${missingDir}/{0}"
`);

    const result = inspectArchiveConfig({ configFilePath: cfg, skipAccessibilityChecks: true });

    expect(result.backends[0].localPathAccessible).toBeNull();
    expect(result.backends[0].localPathError).toBeNull();
  });

  it('does not check accessibility for remote (S3) backends', () => {
    const cfg = writeConfig(`
[HISTORY.s3]
get="aws s3 cp s3://bucket/{0} {1}"
put="aws s3 cp {0} s3://bucket/{1}"
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });

    expect(result.backends[0].localPath).toBeNull();
    expect(result.backends[0].localPathAccessible).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Read-only guarantee
// ---------------------------------------------------------------------------

describe('read-only guarantee', () => {
  it('does not modify the config file', () => {
    const cfg = writeConfig(`
[HISTORY.primary]
get="aws s3 cp s3://bucket/{0} {1}"
put="aws s3 cp {0} s3://bucket/{1}"
mkdir=""
`);
    const before = fs.statSync(cfg).mtimeMs;

    inspectArchiveConfig({ configFilePath: cfg });

    expect(fs.statSync(cfg).mtimeMs).toBe(before);
  });

  it('sets readOnly to true on the result', () => {
    const cfg = writeConfig(`[GENERAL]\n`);
    const result = inspectArchiveConfig({ configFilePath: cfg });
    expect(result.readOnly).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  it('formatArchiveConfigInspection returns a human-readable string', () => {
    const cfg = writeConfig(`
[HISTORY.primary]
get="aws s3 cp s3://bucket/{0} {1}"
put="aws s3 cp {0} s3://bucket/{1}"
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });
    const text = formatArchiveConfigInspection(result);

    expect(typeof text).toBe('string');
    expect(text).toMatch(/archive|backend|history/i);
  });

  it('serializeArchiveConfigInspection returns a structured object', () => {
    const cfg = writeConfig(`
[HISTORY.primary]
get="aws s3 cp s3://bucket/{0} {1}"
put="aws s3 cp {0} s3://bucket/{1}"
mkdir=""
`);

    const result = inspectArchiveConfig({ configFilePath: cfg });
    const serialized = serializeArchiveConfigInspection(result);

    expect(typeof serialized).toBe('object');
    expect(Array.isArray((serialized as any).backends)).toBe(true);
    expect(serialized.readOnly).toBe(true);
  });
});
