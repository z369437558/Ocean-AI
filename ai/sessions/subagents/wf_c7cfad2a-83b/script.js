export const meta = {
  name: 'final-acceptance-verification',
  description: 'Independent adversarial verification of the integrated certificate console: spec acceptance, backend changes, UI in a real browser, install and docs, test quality',
  phases: [{ title: 'Verify', detail: 'five independent verifiers, each working on a private copy of the frozen snapshot' }],
}

const S = '/tmp/claude-0/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9/scratchpad'

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Verdict for your area in plain words: what holds, what does not, and anything the integrator must know (left-over processes, things you could not check).' },
    checksPerformed: { type: 'array', items: { type: 'string' }, description: 'What you actually ran, with numbers (one entry per group of checks).' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          category: { type: 'string', description: 'bug | spec | docs | test-gap | robustness | performance | ux | accessibility | tooling' },
          location: { type: 'string', description: 'file:line or URL/command' },
          description: { type: 'string' },
          reproduction: { type: 'string', description: 'Exact commands or steps you ran and what you observed.' },
          expected: { type: 'string' },
          suggestedFix: { type: 'string' },
          reproduced: { type: 'boolean', description: 'true only if you ran the reproduction yourself and saw the problem' },
        },
        required: ['title', 'severity', 'category', 'description', 'reproduction', 'expected', 'reproduced'],
      },
    },
  },
  required: ['summary', 'checksPerformed', 'findings'],
}

const COMMON = `You are one of five independent verifiers of a small software project just before it is handed over. The author believes everything works. Your job is to prove otherwise in your area - or to establish, with evidence you produced yourself, that it holds. Be adversarial but honest: report only what you reproduced; do not pad the report with speculation.

THE PROJECT
"Multi-Tenant Certificate Admin Console": an internal admin console where tenant admins review course completions, bulk-issue certificates, revoke them and export them as CSV. Backend: Node.js (ESM), Express 5, SQLite in WAL mode (driver better-sqlite3, automatic fallback to the built-in node:sqlite). Frontend: React 19 + Vite. No login: every API request names its actor in the header X-Actor-Email (alice@east.test -> tenant East, Australia/Sydney; bob@west.test -> tenant West, Australia/Perth). One documented command starts everything: "npm start" (installs, builds the UI, creates the demo database, serves UI + API on one port). "npm test" runs the verification suites (API tests with node:test, then UI tests with Vitest).
- The original task specification: ${S}/final/SPEC.md  (read it first; acceptance criteria A1-A7 are at the end)
- The project as it will be handed over (frozen, READ-ONLY, 72 files): ${S}/final/app   (manifest: ${S}/final/manifest.sha256). Its README.md describes behaviour, API, settings and design; treat every statement in it as a claim to check, not as truth.
- What the backend changed in the last round, as a diff: ${S}/final/backend-round3.diff

GROUND RULES
1. Work only inside your own directory ${S}/final/<your-area>/ (create it). Make your private copy first:  cp -r ${S}/final/app ${S}/final/<your-area>/app && chmod -R u+w ${S}/final/<your-area>/app , then run "npm ci --no-audit --no-fund" in it (seconds; the npm cache is warm). Never write to ${S}/final/app, to /home/user/cert-admin-console, or to another verifier's directory.
2. Ports: use only the port range given to you below. Start servers with PORT=<port> HOST=127.0.0.1 and with DB_PATH=<a file inside your directory> (or --db for the CLI scripts). Never use the default port 3000. "npm test" needs no settings: it uses ephemeral ports and temp directories.
3. Record the PID of every long-running process you start (server, vite, helper scripts) and stop each one by PID before you finish; check that your ports no longer answer. If stopping a process is refused, say so in your summary with PID and port.
4. Node versions on this machine: default "node" is 22.23.5 (npm 10.9.9); Node 20.20.2 (npm 10.8.2) is at ${S}/node20/node-v20.20.2-linux-x64/bin; Node 24.22.3 (npm 11.19.1) is at /opt/node24/bin - put the directory first in PATH to use one. A native module installed under one Node version does not load under another: use a separate copy (and npm ci) per Node version. Chromium and Playwright are pre-installed: require('playwright') works from any directory, chromium.launch() needs no options; do not install browsers. python3 is available (sqlite3, unicodedata, zoneinfo) for independent oracles.
5. The machine has 4 cores and other verifiers and test runs are active at the same time. Treat a single slow measurement with suspicion: repeat it, and say when load may explain a number. Do not report a timing finding you could not repeat.
6. A finding needs a reproduction you ran yourself: exact commands or steps, what you observed, what you expected. Severity: critical = wrong or lost data, or an acceptance criterion violated; major = a spec requirement or documented feature fails in a realistic situation; minor = wrong in an edge case, misleading message or documentation, or an important behaviour without any test; nit = cosmetic or very unlikely. Things the README lists as deliberately out of scope are not findings, and neither is the absence of real authentication (the spec forbids adding it).
7. When you are done, return your result through the structured output: a summary, what you checked (with numbers), and the findings (an empty list if you found nothing wrong).

`

const AREAS = [
  {
    key: 'spec-acceptance',
    prompt: `YOUR AREA: spec-acceptance   (directory ${S}/final/spec-acceptance, ports 6500-6549)
Act as the strict reviewer who receives this project together with the specification and decides whether it is accepted.
- From your fresh copy start the app with the one documented command (PORT=65xx HOST=127.0.0.1 DB_PATH=... npm start) and confirm that this single command really installs, builds, seeds and serves UI and API.
- Go through SPEC.md sentence by sentence (sections 1-4) and check each requirement against the running app: tech-stack constraints, seed data (tenants, time zones, admins, "Safety 101" and "Alex Lee" in both tenants with completed / incomplete / already-certified enrollments), the separate generator command for 100,000 East certificates that must not alter the quick-start dataset, the four workflows (drive the UI with Playwright where the requirement is about the UI: actor switch, search, pagination, sorting, loading/empty/error states, duplicate-submission prevention, operation status, per-learner outcomes, detail fields, revocation with confirmation, CSV export preserving search and sort), and the audit logs for issuance and revocation.
- Verify A1-A7 yourself over HTTP with your own scripts, not by trusting the project's tests: cross-tenant list/detail/bulk-issue/export/revoke; sequential and concurrent identical bulk issues with one Idempotency-Key (at least 20 concurrent, check certificates and audit events in the database file with python3 sqlite3); the same key with another course or payload (409, nothing executed, first result intact); per-learner outcomes; the instant 2026-01-10T13:30:00Z shown as 2026-01-11 00:30 for East and 2026-01-10 21:30 for West, and sorting and export by tenant-local calendar date; with 100,000 generated East certificates a filtered + sorted export twice, each under 60 s, identical and deterministic with id as tie-breaker, while list requests keep being answered; revocation writing exactly one audit event and repeats being idempotent.
- Also run "npm test" once in your copy and report the totals.
- Look for scope violations (the spec forbids production auth, cloud deployment, notifications and unrelated features) and for anything a reviewer would stumble over in the first ten minutes (confusing README step, command that fails, misleading output).
Report every requirement that is unmet or only partly met as a finding; say explicitly in the summary whether, in your judgement, each of A1-A7 passes.`,
  },
  {
    key: 'backend-adversarial',
    prompt: `YOUR AREA: backend-adversarial   (directory ${S}/final/backend-adversarial, ports 6550-6599)
Try to break the backend, concentrating on what changed in the last round (read ${S}/final/backend-round3.diff and the sources it touches):
1. CSV export plumbing (backend/src/app.js export route, src/lib/download.js, src/lib/turns.js, src/lib/limiter.js, streamCsvExport in src/services/certificates.js). Claims: at most EXPORT_MAX_CONCURRENT exports read at a time, 32 more may wait, then 503 export_busy; a client that disconnects (in any way) releases slot, connection and snapshot within one step; requests sent ahead on one connection (HTTP pipelining) are answered in order and an export among them takes a slot only when its answer can be sent; a download that takes no more data for EXPORT_IDLE_TIMEOUT_MS is dropped; HEAD answers headers only; all exports together take one step (500 rows) per event-loop iteration, so other requests are not held up however many exports run. Attack with raw sockets (pipelining, half-close, reset, slow readers, clients that never read, many connections), on Node 22 AND Node 20 AND Node 24 (before Node 24 a queued response gets no 'close' event - that was the cause of a slot leak that is claimed to be fixed). After every abuse check that slots are free (a normal export still works, repeatedly), that no reader connection is left (file descriptors of the server process; a wal_checkpoint(TRUNCATE) from another process succeeds) and that the server log is sane. Use a database with 100,000 generated certificates (node scripts/generate-certificates.js --db <file>). Measure, from a separate process, how list and health requests fare while 4, 16 and 64 exports run (EXPORT_MAX_CONCURRENT up to 64).
2. Search and sorting (src/lib/text.js, buildFilter/SORTS in certificates.js, src/services/courses.js, the name_key/title_key columns of schema version 4). Claims: search ignores case and accents and spells out ø ł ß æ œ đ ð þ ħ ŧ ı; an accent typed on its own matches nothing; % _ and backslash are literal; list, total, pages and export always agree; certificate list, export, course list, roster and bulk-issue result order use the folded key with id as tie-breaker. Build an independent oracle in python3 (unicodedata) and compare on awkward names you insert yourself (SQL insert of learners/courses must supply the key columns - or issue through the API after inserting learners and enrollments), for both tenants and both SQLite drivers (SQLITE_DRIVER=node).
3. Parameters and start-up: two aliases of one parameter are a 400; blank means not given; numbers in settings are plain decimal; a blank setting means default; the port is bound before the database is created; the CLI scripts (scripts/init-db.js, scripts/generate-certificates.js) refuse an empty --db, a bad count and an unknown tenant before creating anything.
4. Write path: a request queueing for the write lock is answered as soon as its answer is known (replay for the same key and payload, 409 for the same key with another payload, already-revoked, 404), also across two server processes on one database file; failed learners of a bulk issue are logged once in full and then in one line each.
Anything that makes the server hang, leak, answer wrongly, lose or duplicate data, or contradict the README is a finding. Run the backend suite once per SQLite driver in your copy as a baseline (cd backend && npm test; SQLITE_DRIVER=node npm test).`,
  },
  {
    key: 'frontend-browser',
    prompt: `YOUR AREA: frontend-browser   (directory ${S}/final/frontend-browser, ports 6600-6649)
Verify the user interface in a real browser (Playwright + Chromium) against the real backend, on the production build (start with "PORT=66xx HOST=127.0.0.1 DB_PATH=... npm start" in your copy) and on the Vite dev server, which runs React StrictMode (start the API with "PORT=<api> HOST=127.0.0.1 DB_PATH=... node backend/src/server.js" and then, in app/frontend, "API_URL=http://127.0.0.1:<api> npx vite --host 127.0.0.1 --port <port> --strictPort").
Check, with scripted steps and assertions:
- The four workflows of the spec end to end, as both actors: certificate list (actor switch, search by name and by serial, status filter, every sort column in both directions, pagination on a database with 100,000 generated certificates, loading / empty / error states with a working "Try again"), detail drawer (serial, course, learner, tenant-local issue date for East and West, status, audit trail), revocation (confirmation dialog, cancel paths send nothing, one POST per confirmed revocation, repeated clicks), bulk issue (roster preview, one POST per click however fast or often it is clicked - double click, Enter plus click -, status while in flight, per-learner outcomes issued / skipped with reason / failed, recent operations), CSV export (exactly the rows and order of the current search, filter and sort; as both actors).
- The README's claims in section "3. Using the console": the bulk-issue lock and status survive a visit to the other tab, a switch to the other actor and back, and a page reload (same Idempotency-Key on retry, never a second key for one attempt unless the admin dismisses the prompt); a lost or unreadable answer is reported as "may or may not have gone through" with a safe retry; the revoke dialog's three outcomes (revoked / not revoked / may or may not, then re-checked with the server); leaving the page or switching the actor cancels a running export (no file is ever saved for the wrong tenant); an error panel instead of a blank page when rendering fails. Use request interception and a small proxy of your own to lose, delay, truncate or corrupt answers, and hold the SQLite write lock from python3 (BEGIN IMMEDIATE on the database file) to provoke 503 database_busy.
- Tenant isolation in the UI: nothing of East is ever visible while acting as Bob (including in-flight requests that finish after a switch, remembered bulk-issue attempts, deep links to another tenant's certificate).
- Keyboard and accessibility basics: focus moves into and out of the drawer and the dialog sensibly, Escape closes the top-most layer only, controls have accessible names, the page stays usable at 360x640 and at 1366x768 with 200 % zoom (683x384).
- The browser console stays free of errors and warnings on both builds (apart from failed requests you provoked).
- Run the UI test suite in your copy (npm run test --workspace frontend) on Node 22, 20 and 24 and report totals; re-record the fixtures (node frontend/test/fixtures/record.mjs) and confirm the suite still passes and the recording differs from the committed one only in clock-dependent values.
Report wrong behaviour, misleading text, lost input, focus traps, console errors and README claims that do not hold.`,
  },
  {
    key: 'install-docs',
    prompt: `YOUR AREA: install-docs   (directory ${S}/final/install-docs, ports 6650-6699)
Check that a stranger can run the project from a fresh checkout and that the documentation is true.
- For each of Node 20.20.2, 22.23.5 and 24.22.3, in a separate fresh copy without node_modules: run the documented "npm start" (with PORT/HOST/DB_PATH set as required by the ground rules) and confirm UI and API answer; run "npm test" and record totals and duration; run "npm run generate:east" (with -- --db <file>, with -- --count 250000, with -- --clear), "npm run db:reset" (DB_PATH=...) and a quick "npm run dev" start (it uses PORT for the API and Vite's port 5173: check that port is free first and stop it right away). Repeat "npm start" and "npm test" once with NODE_ENV=production exported, and "npm start" once with package-lock.json deleted (the project's .npmrc claims this still works on npm 10.9).
- After each command compare the tree with the snapshot: package-lock.json must be byte-identical, and nothing may appear outside node_modules, frontend/dist, frontend/node_modules and data/*.sqlite* (compare file lists and sha256 against ${S}/final/manifest.sha256).
- Read README.md line by line and check every checkable statement: requirements, commands, the settings table against backend/src/config.js and backend/src/db/sqlite.js (names, defaults, meaning; try invalid and blank values), the demo-data tables against a fresh database (ids, rosters, outcomes), every curl example (run them in order on a fresh database and compare with the comments), the API table (parameters, limits, error codes and shapes), the CSV format, the test counts ("179 API tests", "231 UI tests") and the "about a minute", the numbers in "Typical numbers" (plausible on this machine?), the troubleshooting entries (port in use, schema version message, 503 texts, db:reset behaviour), the project layout section against the actual tree, and the screenshots in docs/screenshots against the current UI (take fresh ones with Playwright and compare what they show).
- Look at the repository hygiene: .gitignore covers what the commands create; no secrets, absolute paths of this machine, leftovers of development (TODO, console.log debugging, commented-out code, unused files or dependencies); package.json files (scripts, engines, workspaces, dependency ranges) are consistent with the lockfile and with the README.
- Error experience: what does a user see with Node 18 or 20.18 (scripts/preflight.mjs; simulate by reading the script and, if you can, by faking process.versions), with the port taken, with a database file of another schema version, with an unwritable DB_PATH, with an invalid setting? Each should end in one clear line, not a stack trace.
Report every statement that is false or misleading, every command that fails or leaves changes behind, and anything that would cost a first-time user time.`,
  },
  {
    key: 'test-quality',
    prompt: `YOUR AREA: test-quality   (directory ${S}/final/test-quality, ports 6700-6749)
Decide whether the project's test suites can be trusted as evidence.
- Reliability: in your copy run "npm test" three times on Node 22, then the backend suite (cd backend && npm test) three more times while four busy-loop processes load the CPU, then once each on Node 20 and Node 24 (separate copies), and the backend suite once with SQLITE_DRIVER=node. Run it once with hostile settings exported in the shell (DB_BUSY_TIMEOUT_MS=200 EXPORT_MAX_CONCURRENT=1 EXPORT_IDLE_TIMEOUT_MS=5 HOST=203.0.113.9 DB_PATH=/nonexistent/x.sqlite PORT=1): the suite claims to be independent of them. Report any failure, flake, hang or cancelled test with its output, and how long the runs take.
- Independence: run individual suites and tests in isolation (node --test --test-name-pattern=... for the backend files; npx vitest run <file> -t <name> for the UI) to find tests that only pass after another test, and check that the suites leave nothing behind (temp directories in the OS temp dir, processes, listening ports, files in the repository; the project's data/ directory must stay untouched).
- Sensitivity (mutation spot check): make about 30 small behaviour-changing edits, one at a time, in a throw-away copy and run the suites that should notice: in backend/src/app.js (export route), src/lib/download.js, src/lib/turns.js, src/lib/limiter.js, src/lib/text.js, src/lib/params.js, src/config.js, src/server.js, src/services/bulkIssue.js, src/services/certificates.js, src/services/courses.js, src/db/seed.js, and in frontend/src/bulkIssueStore.js, frontend/src/api.js, frontend/src/components/*.jsx. Prefer mutants that would matter to a user (wrong tenant, second request, lost outcome, wrong order, missing validation). For every survivor decide whether it is equivalent or a real gap, and report the real gaps with the exact edit.
- Honesty of the verification command: confirm that "npm test" exits non-zero when a backend test fails and when a UI test fails (introduce a failing mutant for each), that a hanging test is reported by name within a few minutes instead of stalling the run for ever (make one request handler never answer), and that the test counts printed match the README (179 and 231).
- Read the test code for weak assertions: tests that cannot fail, assertions on the wrong thing, time-based waits that are too tight for a loaded machine or so generous that they hide slowness, fixtures that drifted from what the backend really sends.
Report flaky or order-dependent tests, real mutation survivors, misleading test names and anything that makes a green run less trustworthy than it looks.`,
  },
]

phase('Verify')
const results = await parallel(
  AREAS.map((area) => () =>
    agent(COMMON + area.prompt, { label: `verify:${area.key}`, phase: 'Verify', schema: RESULT_SCHEMA }).then((result) =>
      result ? { area: area.key, ...result } : null,
    ),
  ),
)
const completed = results.filter(Boolean)
const missing = AREAS.filter((_, index) => !results[index]).map((area) => area.key)
log(`${completed.length} of ${AREAS.length} verifiers returned a result${missing.length ? `; missing: ${missing.join(', ')}` : ''}`)
return { completed, missing }
