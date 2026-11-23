#!/usr/bin/env node
/**
 * Load-test data generator CLI.
 *
 *   npm run generate:east                     # 100,000 certificates for tenant East
 *   npm run generate:east -- --count 250000   # a different volume
 *   npm run generate:east -- --clear          # remove the generated rows again
 *   npm run generate:east -- --db /tmp/x.sqlite   # work on another database file
 *
 * Safe to run while the server is up: the rows are written in one transaction and the running
 * app shows them on the next request. The quick-start demo rows are never modified.
 */
import { parseArgs } from 'node:util';

import { openInitializedDatabase } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { clearGeneratedCertificates, generateCertificates } from '../src/db/generate.js';

const { values } = parseArgs({
  options: {
    tenant: { type: 'string', default: 'East' },
    count: { type: 'string', default: '100000' },
    seed: { type: 'string', default: '20260110' },
    db: { type: 'string' },
    clear: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: false,
});

if (values.help) {
  console.log(
    'Usage: node scripts/generate-certificates.js [--tenant East] [--count 100000] [--seed N] [--db path] [--clear]',
  );
  process.exit(0);
}

const count = Number(values.count);
const seed = Number(values.seed);
if (!Number.isInteger(count) || count < 1) {
  console.error(`--count must be a positive integer (got "${values.count}")`);
  process.exit(1);
}
if (!Number.isInteger(seed)) {
  console.error(`--seed must be an integer (got "${values.seed}")`);
  process.exit(1);
}

const dbPath = values.db ? loadConfig({ DB_PATH: values.db }).dbPath : loadConfig().dbPath;
const db = openInitializedDatabase(dbPath, { log: console.log });
try {
  const started = performance.now();
  if (values.clear) {
    const result = clearGeneratedCertificates(db, { tenantName: values.tenant });
    console.log(`Removed ${result.removed.toLocaleString('en-US')} generated certificates from tenant ${result.tenant}.`);
  } else {
    console.log(`Generating ${count.toLocaleString('en-US')} certificates for tenant ${values.tenant} in ${dbPath} ...`);
    const result = generateCertificates(db, { tenantName: values.tenant, count, seed });
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `Done in ${seconds}s: ${result.generated.toLocaleString('en-US')} certificates ` +
        `(${result.revoked.toLocaleString('en-US')} revoked) across ${result.courses} generated courses and ` +
        `${result.learners.toLocaleString('en-US')} generated learners, ${result.distinctIssueInstants.toLocaleString('en-US')} distinct issue instants.`,
    );
    if (result.replaced > 0) {
      console.log(`Replaced ${result.replaced.toLocaleString('en-US')} previously generated certificates.`);
    }
    console.log(`Tenant ${result.tenant} now has ${result.totalCertificatesInTenant.toLocaleString('en-US')} certificates in total.`);
  }
  // Refresh planner statistics after a large change in table sizes.
  db.exec('PRAGMA optimize');
} catch (err) {
  console.error(`Generation failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
