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
 *
 * Every problem ends in a short message (no stack trace) and exit code 1, and nothing is written
 * then: the arguments are checked before the database is touched, so a mistyped count or tenant
 * does not even leave a new, empty database file behind.
 */
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { openInitializedDatabase } from '../src/bootstrap.js';
import { loadConfig, resolveUserPath } from '../src/config.js';
import { MAX_GENERATED_CERTIFICATES, clearGeneratedCertificates, generateCertificates } from '../src/db/generate.js';
import { DEMO_TENANT_NAMES } from '../src/db/seed.js';
import { checkDatabaseSettings } from '../src/db/sqlite.js';

const USAGE = 'Usage: node scripts/generate-certificates.js [--tenant East] [--count 100000] [--seed N] [--db path] [--clear]';

function fail(message) {
  console.error(message);
  process.exit(1);
}

let values;
try {
  ({ values } = parseArgs({
    options: {
      tenant: { type: 'string', default: 'East' },
      count: { type: 'string', default: '100000' },
      seed: { type: 'string', default: '20260110' },
      db: { type: 'string' },
      clear: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  }));
} catch (err) {
  fail(`${err.message}\n${USAGE}`);
}

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const count = Number(values.count);
const seed = Number(values.seed);
if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATED_CERTIFICATES) {
  fail(`--count must be a whole number between 1 and ${MAX_GENERATED_CERTIFICATES.toLocaleString('en-US')} (got "${values.count}")`);
}
if (!Number.isInteger(seed)) fail(`--seed must be an integer (got "${values.seed}")`);
if (values.db !== undefined && values.db.trim() === '') fail(`--db needs a path (got an empty value)\n${USAGE}`);

let dbPath;
let db;
try {
  checkDatabaseSettings(); // SQLITE_DRIVER, DB_BUSY_TIMEOUT_MS
  dbPath = values.db !== undefined ? resolveUserPath(values.db) : loadConfig().dbPath;
} catch (err) {
  fail(err.message);
}
// A database that does not exist yet (or is still an empty file) gets the demo data when it is
// opened, so its tenants are known in advance; in any other database the tenant is looked up
// before anything is changed.
function isNewDatabase(file) {
  try {
    return fs.statSync(file).size === 0;
  } catch {
    return true; // no such file
  }
}
const isDemoTenant = DEMO_TENANT_NAMES.some((name) => name.toLowerCase() === values.tenant.toLowerCase());
if (!isDemoTenant && isNewDatabase(dbPath)) {
  fail(`Unknown tenant "${values.tenant}" (a new database has the tenants ${DEMO_TENANT_NAMES.join(' and ')})`);
}
try {
  db = openInitializedDatabase(dbPath, { log: console.log });
} catch (err) {
  fail(`Could not open the database at ${dbPath}: ${err.message}`);
}
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
