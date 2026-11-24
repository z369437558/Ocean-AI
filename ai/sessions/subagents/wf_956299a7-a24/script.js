export const meta = {
  name: 'audit-certificate-console',
  description: 'Independent adversarial audit of the certificate admin console against its spec: 9 read-only auditors, one per risk area, each must reproduce what it reports',
  phases: [
    { title: 'Audit', detail: 'one independent auditor per risk area; findings need concrete reproduction' },
  ],
}

const SPEC = [
  "# Project Spec: Multi-Tenant Certificate Admin Console",
  "",
  "Build an internal admin console for a multi-tenant training platform where tenant admins review course completions, issue certificates, revoke them, and export certificate data.",
  "",
  "## 1. Tech Stack & Constraints",
  "- **Backend**: Go, Python, or Node.js with a mainstream framework. Use SQLite, MySQL, or PostgreSQL (persistent storage required, no in-memory-only DB).",
  "- **Frontend**: Vue 3 or React (Vite optional).",
  "- **Startup**: Provide one documented command that installs/uses declared dependencies, initializes demo data, and starts the full app. Optionally provide a second command to run verification tests.",
  "- **Actor Context**: No login UI needed. Seed one admin per tenant and identify the actor via an HTTP header or token (e.g., `X-Actor-Email`).",
  "- **Scope Control**: Do not add production auth, cloud deployment, notifications, or unrelated features. Prioritize core behavioral correctness over visual polish.",
  "",
  "## 2. Seed / Demo Data Requirements",
  "- Two tenants:",
  "  - `East` with timezone `Australia/Sydney`",
  "  - `West` with timezone `Australia/Perth`",
  "- Two admins (each bound strictly to their own tenant):",
  "  - `alice@east.test` -> `East`",
  "  - `bob@west.test` -> `West`",
  "- Both tenants must have a course titled `Safety 101` and a learner named `Alex Lee`, including completed, incomplete, and already-certified enrollments.",
  "- Provide a separate CLI command or script to generate 100,000 certificate rows for one tenant (`East`) without altering the default quick-start dataset.",
  "",
  "## 3. Core Workflows",
  "1. **Certificate List**: Switch/select actor, search by learner name or serial number, paginate, and sort. Show loading, empty, and error states.",
  "2. **Bulk Issue**: Choose a course and issue certificates to all eligible (completed, not yet certified) learners. Prevent duplicate UI submissions and show operation status. Return per-learner outcomes: `issued`, `skipped` (with reason), or `failed`.",
  "3. **Certificate Detail & Revocation**: Display serial number, course, learner, tenant-local issue date, and status. Support revocation with UI confirmation. Write audit logs for both issuance and revocation.",
  "4. **CSV Export**: Export columns: learner name, course title, serial number, and tenant-local issue date. Preserve active search and sort filters. Must handle 100,000-row exports efficiently without blocking concurrent reads.",
  "",
  "## 4. Acceptance Criteria (Must Pass)",
  "- **A1 (Tenant Isolation)**: If `bob@west.test` attempts to access `East` data via list, detail, bulk issue, or export endpoints, only `West` data is accessible. Cross-tenant detail requests must return `404`. Cross-tenant bulk issue must be rejected without creating certificates or audit events.",
  "- **A2 (Retry Safety / Idempotency)**: Sequential and concurrent identical bulk-issue requests from Alice with the same `Idempotency-Key` must execute as one logical operation. Each eligible learner gets at most 1 certificate and 1 audit event. All callers receive the same logical outcome.",
  "- **A3 (Idempotency Key Misuse)**: If Alice reuses an `Idempotency-Key` with a different course ID or payload, return `409 Conflict` without executing a second operation or overwriting the first result.",
  "- **A4 (Learner Outcomes)**: Bulk issuing a course with completed, incomplete, and already-certified learners only issues to eligible learners and skips the rest with clear reasons.",
  "- **A5 (DST & Local Date)**: A certificate with UTC timestamp `2026-01-10T13:30:00Z` must display as `2026-01-11 00:30` for `East` (`Australia/Sydney`) and `2026-01-10 21:30` for `West` (`Australia/Perth`). List sorting and CSV export must use the tenant-local calendar date.",
  "- **A6 (Export Scalability & Determinism)**: With 100,000 `East` certificates (including duplicate sort values), running a filtered and sorted CSV export twice must complete each within 60 seconds, return exact matching rows in deterministic order (use a tie-breaker like `id` for equal sort keys), and not block concurrent certificate list API requests during export.",
  "- **A7 (Revocation Audit)**: Revoking a valid certificate changes its status and writes 1 audit event. Repeating the revoke request is idempotent and does not create duplicate audit events.",
].join("\n")

const PROJECT = "/home/user/cert-admin-console"
const AUDIT_ROOT = "/tmp/claude-0/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9/scratchpad/audit"

const AREAS = [
  {
    key: "tenant-isolation",
    portBase: 4100,
    focus: [
      "YOUR AREA: tenant isolation (acceptance criterion A1) and hostile or malformed input on every endpoint.",
      "- Enumerate every route in backend/src/app.js and every SQL statement in backend/src/services and backend/src/db. For each, establish where the tenant restriction comes from and whether any path can read or write another tenant's rows.",
      "- Attack it over HTTP as bob@west.test against East data and as alice@east.test against West data: list, detail, revoke, bulk issue, export, course roster, bulk-operation lookups, audit events. Use ids of the other tenant, guessed parameters (tenant, tenantId, ...), repeated / array-style / object-style query parameters, every parameter alias the code accepts, LIKE wildcards, SQL metacharacters in q / sort / order / status, numeric edge cases in ids and paging, and odd X-Actor-Email values (case, whitespace, comma lists, duplicated header, missing, unknown).",
      "- For 'must be rejected without creating certificates or audit events', compare row counts in the SQLite file before and after (certificates, audit_events, bulk_issue_operations).",
      "- Check that a cross-tenant 404 is indistinguishable from a plain not-found 404 and that no error body, response header or CSV leaks data of another tenant.",
      "- Idempotency keys across tenants: can Bob replay, collide with, block or observe an operation Alice executed with the same key?",
      "- Also probe general input robustness on each endpoint: malformed JSON, wrong content types, oversized bodies, unsupported methods, malformed URL encodings, very long values. A 5xx answer, a hang or a crashed server is a finding.",
    ],
  },
  {
    key: "idempotency-concurrency",
    portBase: 4200,
    focus: [
      "YOUR AREA: retry safety and idempotency-key misuse for bulk issue (acceptance criteria A2 and A3), including the database transaction layer they rely on.",
      "- Read backend/src/services/bulkIssue.js, backend/src/services/ledger.js, backend/src/db/sqlite.js and backend/src/db/schema.js closely. Look for any interleaving, error path or partial failure in which an eligible learner could get two certificates or two issuance audit events, an operation could execute twice, a retry could receive a different outcome, or a failed transaction could leave partial writes or a broken connection state (nested savepoints, rollback or commit failures, exceptions thrown at each step).",
      "- Demonstrate behaviour with real requests: sequential retries; many truly concurrent identical requests (write a Node script; also start a second server process on the same DB_PATH and split the requests across both processes); the same key with a different course id; the same key with a changed payload (extra field, different value types, different formatting or key order, empty or missing body, invalid JSON); a key first used on a rejected request and then reused; odd key values (empty, whitespace, very long, non-ASCII, repeated header); requests without a key; a client that disconnects before reading the response and then retries; a replay after the data changed (for example a certificate issued by the operation was revoked afterwards).",
      "- Verify 'all callers receive the same logical outcome' literally: status code, body, and which requests report themselves as replays.",
      "- Verify 'without executing a second operation or overwriting the first result' for A3 by inspecting the database rows as well as the responses.",
      "- Consider a long-running writer in another process (for example the 100,000-row generator CLI running while bulk-issue requests arrive at the server): do requests fail, hang, double-execute, or return errors that a retrying client would mishandle?",
    ],
  },
  {
    key: "outcomes-revocation-audit",
    portBase: 4300,
    focus: [
      "YOUR AREA: per-learner outcomes of bulk issue (A4) and certificate revocation with its audit trail (A7), plus the audit log in general (spec: 'Write audit logs for both issuance and revocation').",
      "- For every seeded course in both tenants, predict from the seed data (backend/src/db/seed.js or the database itself) what a bulk issue must do for each learner, then run it and compare: issued only to completed-and-not-yet-certified learners, everyone else skipped with a clear reason, summary counts consistent with the per-learner list, certificates / serial numbers / audit events actually present and correct in the database.",
      "- Check that the roster preview endpoint (GET /api/courses/:id/enrollments) and the real operation agree for every learner, including pagination and totals of the roster.",
      "- Find a way to make issuance fail for one learner (think about what data could make the insert fail) and observe whether the others are still processed, what is reported, and whether partial writes remain.",
      "- Revocation: a valid revoke changes status and writes exactly one audit event; repeats are idempotent with no extra event; many concurrent revokes of one certificate (also across two server processes sharing one database file) still give one event; revoke with and without a body, with invalid input, of unknown ids; what the list, detail, export and a later bulk issue show afterwards.",
      "- Audit integrity as an invariant: after a long random sequence of bulk issues and revokes (write a script), every certificate has exactly one certificate.issued event and every revoked certificate exactly one certificate.revoked event, with correct actor, tenant and timestamps; no audit event exists for rejected, replayed or no-op requests. Also exercise GET /api/audit-events (filters, paging, invalid parameters) and the operation history endpoints.",
    ],
  },
  {
    key: "time-dst",
    portBase: 4400,
    focus: [
      "YOUR AREA: time zones, daylight saving and tenant-local dates (acceptance criterion A5).",
      "- Verify the reference case in the running app for both tenants in the list, the detail and the CSV: UTC 2026-01-10T13:30:00Z must display as 2026-01-11 00:30 for East (Australia/Sydney) and 2026-01-10 21:30 for West (Australia/Perth).",
      "- Check the conversion code (backend/src/lib/time.js and every caller) against an independent implementation (Python zoneinfo) over thousands of instants: around both Sydney DST transitions of several years, midnight boundaries, year boundaries, and other zones (half-hour offsets, zones west of UTC). Include the stored issued_local_date column of every certificate after running the 100,000-row generator in your copy.",
      "- 'List sorting and CSV export must use the tenant-local calendar date': build adversarial data in a database copy (certificates just before and after local midnight, on both sides of DST changes, same UTC date but different local dates and vice versa, inserted in an order that differs from chronological order) and check the order returned by the list and by the export for sort=issued in both directions, in both tenants, against your own computation.",
      "- Check everything else that prints or derives a date: revocation times, audit event times, roster completion times, bulk-issue results, export file name, operation history. Look for any use of the server's own time zone or of the UTC date where the tenant-local date is required: run the server under different TZ environment values (for example TZ=America/New_York and TZ=Asia/Tokyo) and compare outputs.",
      "- Frontend: confirm the UI shows the tenant-local strings regardless of the browser's time zone (run Playwright with timezoneId set to a zone far from Australia) in the list, the detail drawer and bulk-issue results. You need the UI built in your copy for this (npm run build, or npm start).",
    ],
  },
  {
    key: "export-scale",
    portBase: 4500,
    focus: [
      "YOUR AREA: export scalability and determinism on 100,000 East certificates (acceptance criterion A6) and the generator CLI that produces them (spec section 2, last bullet).",
      "- In your copy, take a full dump of the freshly seeded database, run the documented generator command, and verify independently (Python sqlite3): exactly 100,000 certificate rows were added for East, nothing was added for West, every quick-start row is unchanged, and the generated data really contains duplicate sort values for every sortable column. Exercise the generator's options and edge cases (re-run, --count, --clear, --db, bad arguments, running it while the server is up and serving requests).",
      "- For several filtered + sorted exports (each sort key, both directions, with search text, with the status filter, with characters special to LIKE or to CSV): run each twice, time it, compare bytes, parse with Python's csv module, and compare the row set and the exact order with an independent computation from the database (sort key plus tie-breaker). Check the CSV against the spec's column list and against the list API page by page.",
      "- 'Not block concurrent certificate list API requests during export': measure list latency without any export, then while exports are streaming (several at once, and with a client that reads slowly or stalls), and compare. Poll a cheap endpoint during exports to find the longest event-loop stall. Explain any stall you find from the code (backend/src/services/certificates.js, backend/src/app.js).",
      "- Resource behaviour: abort many downloads mid-way and check the server process for leaked file descriptors / database connections (/proc/<pid>/fd) and for memory growth; run 20+ exports concurrently; check that writes (bulk issue, revoke) during an export succeed and whether the export is a consistent snapshot.",
      "- Pagination determinism on equal sort keys (no row repeated or skipped across pages), deep pages, a page beyond the end, and consistency between the reported total and the rows returned.",
    ],
  },
  {
    key: "frontend-ui",
    portBase: 4600,
    focus: [
      "YOUR AREA: the React frontend (frontend/src) and the four UI workflows of spec section 3, tested in a real browser with Playwright.",
      "- Build and start your copy (PORT=<your port> npm start, or npm run build followed by the server). Drive the UI as a user would and as an impatient user would. Check the browser console for errors and warnings throughout.",
      "- Certificate list: actor switch, search by learner name and by serial number, pagination, sorting, loading / empty / error states (use page.route to delay, fail or corrupt API responses). Look for races: out-of-order responses while typing, switching actor while requests are in flight (does data of the previous tenant ever render under the new one?), stale detail drawers, page numbers that outlive a filter change.",
      "- Bulk issue: choosing a course, duplicate-submission prevention (double click, Enter key, clicking during the request, changing course mid-flight), operation status display, per-learner outcomes, behaviour when the response is lost and the request is retried (is the same Idempotency-Key reused? when is a new one generated?), behaviour on 4xx and 5xx answers.",
      "- Detail and revocation: all required fields shown, tenant-local issue date, status; the confirmation step (cancel, Escape, backdrop click, double click on confirm, failure of the request); list refresh afterwards; deep links to a certificate of the other tenant; browser back / forward and reload.",
      "- CSV export from the UI: does the downloaded file contain exactly the rows and order of the active search, status filter and sort (also when the user types and immediately clicks Export, and after changing the sort through the column headers)? Behaviour for large exports and for failures.",
      "- Use the generator CLI in your copy (npm run generate:east) for a 100,000-row dataset when checking pagination and export. Also read the components for logic errors a browser run might not hit (stale closures, missing cleanup, state not reset between actors, unhandled promise rejections).",
    ],
  },
  {
    key: "startup-docs-spec",
    portBase: 4700,
    focus: [
      "YOUR AREA: the first-run experience, the documentation, and literal compliance with spec sections 1 and 2.",
      "- Simulate a fresh checkout: instead of the plain cp in ground rule 2, copy the project WITHOUT node_modules, without frontend/dist and without any data/*.sqlite* files, then run the one documented start command with your PORT and nothing else. It must install, initialise demo data and start the full app (UI and API). Then run the documented test command. Record what happened, how long it took, and anything a first-time evaluator would trip over (warnings, ports, confusing output).",
      "- Execute every command and every curl example in README.md exactly as written (adapting only the port) against a fresh database, in order, and compare with what the README says will happen. Check every factual claim in the README that you can test: ids, counts, file layout, behaviours, numbers, environment variables, troubleshooting advice, the claimed fallback when the native SQLite module is unavailable (simulate that in your copy), restart persistence (data survives a restart, nothing is seeded twice), reset while the server is running, development mode.",
      "- Check the seed data against spec section 2 word by word (tenants and time zones, admins bound strictly to their own tenant, the Safety 101 course and the learner Alex Lee in both tenants, completed / incomplete / already-certified enrollments), and the generator requirement.",
      "- Check the section 1 constraints: stack, persistent storage (not in-memory only), actor identification, and scope control (anything that looks like production auth, deployment, notifications or unrelated features).",
      "- Check repository hygiene: package.json scripts and engines, lockfile in sync (npm ci), .gitignore, stray files, and whether the documented commands would plausibly work on macOS and Windows (flag shell-specific constructs).",
    ],
  },
  {
    key: "test-suite-quality",
    portBase: 4800,
    focus: [
      "YOUR AREA: the verification tests (backend/test) - are they real evidence for A1-A7?",
      "- Map each acceptance criterion to the tests that claim to verify it and judge whether a violation would actually be caught.",
      "- Mutation testing in your copy: introduce at least 20 small, realistic defects one at a time into the backend (examples: remove the tenant predicate from one query at a time; skip or duplicate an audit insert; compare the idempotency fingerprint incorrectly or ignore it; scope the key lookup too broadly; drop the id tie-breaker from one ordering; sort by the UTC date; let a revoked certificate be re-issued; remove the status guard from revoke; break LIKE escaping; off-by-one in paging; swap CSV columns; change the CSV date format; make bulk issue non-atomic; return a different body on replay). Run the relevant test file(s) after each mutation and restore the file afterwards. Report every mutant that SURVIVES, with the exact diff and a concrete test that would kill it.",
      "- Run the whole suite at least three times and report flaky or timing-sensitive tests, tests that depend on execution order or on the current date / time zone of the machine (try TZ=America/New_York and TZ=Pacific/Kiritimati), and tests that would pass vacuously.",
      "- Note acceptance-relevant behaviour that has no test at all.",
    ],
  },
  {
    key: "backend-review-fuzz",
    portBase: 4900,
    focus: [
      "YOUR AREA: line-by-line review of the backend source (backend/src, backend/scripts, scripts/) for defects not tied to a single acceptance criterion, plus fuzzing of the running server.",
      "- Read every file. Look for logic errors, wrong edge-case handling (parameter parsing limits and aliases, id parsing, pagination arithmetic, empty results), error paths that leave state behind, promises that can reject unhandled, streams or database connections that can leak, places where the process could crash or hang, misleading error mapping, and mismatches between comments / README and actual behaviour.",
      "- Pay particular attention to backend/src/app.js (body parsing is configured to treat every content type as JSON; the streaming export route and its cleanup; the static file fallback; the error handler), backend/src/db/sqlite.js (two interchangeable drivers: run the server and the test suite with SQLITE_DRIVER=node and with SQLITE_DRIVER=better-sqlite3 and look for behavioural differences), and backend/scripts (argument handling, running against a live server, reset).",
      "- Fuzz the HTTP surface of a running instance with a script: random and boundary values for every parameter and header, malformed percent-encodings, NUL and control characters, huge values, unexpected JSON types and deep nesting, wrong methods, abrupt disconnects during request bodies and during streamed responses, many parallel connections. Any 5xx answer, unhandled exception in the server log, crash, hang or corrupted response is a finding; so is any input that is accepted but produces a wrong result.",
    ],
  },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two or three sentences: what you covered and your overall verdict for this area.' },
    checksPerformed: {
      type: 'array',
      items: { type: 'string' },
      description: 'Concrete checks you ran and their result, including the ones that passed.',
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          category: {
            type: 'string',
            enum: ['spec-violation', 'bug', 'robustness', 'data-integrity', 'performance', 'docs', 'test-gap', 'ux', 'spec-interpretation'],
          },
          criterion: { type: 'string', description: 'A1..A7, or the spec section, or "general".' },
          location: { type: 'string', description: 'file:line (or several) in the deliverable.' },
          description: { type: 'string', description: 'What is wrong and why it matters.' },
          reproduction: { type: 'string', description: 'Exact commands / requests / script and the observed output.' },
          expected: { type: 'string', description: 'What the spec or README requires instead.' },
          reproduced: { type: 'boolean', description: 'true only if you observed the faulty behaviour yourself.' },
          suggestedFix: { type: 'string' },
        },
        required: ['title', 'severity', 'category', 'criterion', 'description', 'reproduction', 'reproduced'],
      },
    },
  },
  required: ['summary', 'checksPerformed', 'findings'],
}

function buildPrompt(area) {
  const workdir = AUDIT_ROOT + "/" + area.key
  return [
    "You are an independent auditor. A software deliverable was built to the specification below, and its author claims it meets every acceptance criterion. Your job is to find where that claim is false or fragile within your assigned area. You did not write this code and owe it no benefit of the doubt - but you must not report anything you have not actually checked.",
    "",
    "=== SPECIFICATION (verbatim from the client) ===",
    SPEC,
    "=== END OF SPECIFICATION ===",
    "",
    "THE DELIVERABLE",
    "- Source tree: " + PROJECT + " - a Node.js / Express 5 + SQLite backend in backend/, a React + Vite frontend in frontend/, verification tests in backend/test, and README.md, which documents the commands, the HTTP API and the design decisions.",
    "- Read README.md first, then the code relevant to your area.",
    "",
    "GROUND RULES (several auditors work on this machine at the same time)",
    "1. " + PROJECT + " is READ-ONLY for you. Never create, edit, build or run anything inside it: no npm start / test / install there, no database files there.",
    "2. Work only in your private directory " + workdir + ". Start with:  mkdir -p " + workdir + " && cp -a " + PROJECT + " " + workdir + "/app   (node_modules is included, so no install is needed; frontend/dist is not built: `npm run build` in your copy builds the UI, and `npm start` in your copy installs, builds and serves everything).",
    "3. Network ports: use only ports " + area.portBase + " to " + (area.portBase + 49) + " (for example `PORT=" + area.portBase + " npm start` in your copy, or `PORT=" + (area.portBase + 1) + " DB_PATH=/some/file.sqlite node backend/src/server.js`). The test suite picks free ports by itself.",
    "4. Never use pkill or killall, and never kill a process you did not start: other auditors run identically named processes. Record the PIDs you start and kill exactly those. Before you finish, stop every process you started.",
    "5. The machine has 4 cores that you share with another auditor running concurrently, so absolute timings are noisy. Report a performance problem only if it is structural (you can explain the mechanism from the code) or reproduces with a wide margin.",
    "6. Available tools: node 22, npm, curl, python3 (its sqlite3, csv and zoneinfo modules are handy for independent checks of the SQLite file and of CSV output), and Playwright with Chromium (require('playwright') works from any directory and chromium.launch() needs no options; do not install anything for it).",
    "7. The databases are SQLite files in WAL mode. To inspect one while a server is running, open it read-only from Python or from Node in your copy.",
    "",
    area.focus.join("\n"),
    "",
    "WHAT COUNTS AS A FINDING",
    "- A violation of the specification or of an acceptance criterion; wrong results; data written when it must not be (or not written when it must be); a crash, hang, leak or unhandled error with a concrete trigger; a documented command or README claim that does not hold; a UI workflow that misbehaves; a verification test that would not catch the defect it claims to guard against.",
    "- Not findings: style preferences; features the spec does not ask for (it says to avoid unrelated features); production concerns the spec excludes (real authentication, deployment); design decisions that the README documents - unless such a decision contradicts the wording of the spec, in which case report it under category spec-interpretation and quote the sentence it conflicts with.",
    "- Every finding needs evidence: the exact commands, requests or script you ran and what you observed, versus what the spec or the README requires. If you are convinced something is wrong but could not demonstrate it, you may report it with reproduced=false and say exactly what you tried; keep such items few and well argued.",
    "- An empty findings list is a valid and respectable result. Do not pad the list. Do not soften or inflate severity: critical = an acceptance criterion fails; major = a spec requirement or core workflow is partly broken, or data integrity is at risk; minor = a real but limited defect; nit = cosmetic or documentation inaccuracy.",
    "- Stay in your area (other auditors cover the rest), but do report anything serious you stumble on elsewhere.",
    "",
    "Be thorough within your area: work through the whole checklist above, then try the ideas of your own that seem most likely to break things. In checksPerformed, list concretely what you verified - including what turned out to be correct; that coverage record matters as much as the findings.",
  ].join("\n")
}

phase('Audit')
const results = await parallel(
  AREAS.map((area) => () =>
    agent(buildPrompt(area), { label: 'audit:' + area.key, phase: 'Audit', schema: FINDINGS_SCHEMA }).then((r) =>
      r ? { area: area.key, summary: r.summary, checksPerformed: r.checksPerformed, findings: r.findings } : null,
    ),
  ),
)

const completed = results.filter(Boolean)
const missing = AREAS.filter((area, i) => !results[i]).map((area) => area.key)
if (missing.length > 0) log('No result from: ' + missing.join(', '))
const total = completed.reduce((sum, r) => sum + r.findings.length, 0)
log(completed.length + '/' + AREAS.length + ' auditors reported, ' + total + ' findings in total')

return { completed, missing }
