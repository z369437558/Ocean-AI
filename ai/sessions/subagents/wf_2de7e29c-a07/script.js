export const meta = {
  name: 'round4-verification',
  description: 'Independent verification of the certificate console after the last round of fixes: test quality, UI fixes in a real browser, backend fixes, acceptance criteria, install and docs - then a critic that checks what nobody checked',
  phases: [
    { title: 'Verify', detail: 'five independent verifiers, each on a private copy of the frozen snapshot', model: '[REDACTED: model identifier B]' },
    { title: 'Critic', detail: 'what did nobody check? - and check it', model: '[REDACTED: model identifier B]' },
  ],
}

const S = '/tmp/claude-0/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9/scratchpad'
const F = S + '/final2'

const FINDING = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
    category: { type: 'string', description: 'bug | spec | docs | test-gap | robustness | performance | ux | accessibility | tooling | regression' },
    location: { type: 'string', description: 'file:line or URL/command' },
    description: { type: 'string' },
    reproduction: { type: 'string', description: 'Exact commands or steps you ran and what you observed.' },
    expected: { type: 'string' },
    suggestedFix: { type: 'string' },
    reproduced: { type: 'boolean', description: 'true only if you ran the reproduction yourself and saw the problem' },
  },
  required: ['title', 'severity', 'category', 'description', 'reproduction', 'expected', 'reproduced'],
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Verdict for your area in plain words: what holds, what does not, and anything the integrator must know (left-over processes, things you could not check).' },
    checksPerformed: { type: 'array', items: { type: 'string' }, description: 'What you actually ran, with numbers (one entry per group of checks).' },
    previousFindingsRechecked: {
      type: 'array',
      description: 'The findings of the previous round that fall into your area: is each one really gone?',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          status: { type: 'string', enum: ['fixed', 'partly fixed', 'not fixed', 'documented instead', 'not checked'] },
          evidence: { type: 'string' },
        },
        required: ['title', 'status', 'evidence'],
      },
    },
    findings: { type: 'array', items: FINDING },
  },
  required: ['summary', 'checksPerformed', 'findings'],
}

const COMMON = `You are one of several independent verifiers of a small software project just before it is handed over. It has been verified once already; the author then changed code, tests and documentation to answer the findings, and believes everything works now. Your job is to prove otherwise in your area - or to establish, with evidence you produced yourself, that it holds. Be adversarial but honest: report only what you reproduced; do not pad the report with speculation. A fix can be wrong, incomplete, or break something next to it: look for all three.

THE PROJECT
"Multi-Tenant Certificate Admin Console": an internal admin console where tenant admins review course completions, bulk-issue certificates, revoke them and export them as CSV. Backend: Node.js (ESM), Express 5, SQLite in WAL mode (driver better-sqlite3, automatic fallback to the built-in node:sqlite). Frontend: React 19 + Vite. No login: every API request names its actor in the header X-Actor-Email (alice@east.test -> tenant East, Australia/Sydney; bob@west.test -> tenant West, Australia/Perth). One documented command starts everything: "npm start" (installs, builds the UI, creates the demo database, serves UI + API on one port). "npm test" runs the verification suites (190 API tests with node:test, then 252 UI tests with Vitest).
- The original task specification: ${F}/SPEC.md  (read it first; acceptance criteria A1-A7 are at the end)
- The project as it will be handed over (frozen, READ-ONLY): ${F}/app   (manifest: ${F}/manifest.sha256). Its README.md describes behaviour, API, settings and design; treat every statement in it as a claim to check, not as truth.
- Everything that changed since the previous verification, as a diff (sources, tests, README): ${F}/round4.diff
- The findings of the previous verification (JSON, one file per verifier): ${S}/wfres/final_verify_spec-acceptance.json, ${S}/wfres/final_verify_backend-adversarial.json, ${S}/wfres/final_verify_frontend-browser.json, ${S}/wfres/final_verify_install-docs.json. The author claims each finding is fixed in the code or, where it describes a deliberate limit, stated in the README. For the ones in your area decide for yourself and report them under previousFindingsRechecked.

GROUND RULES
1. Work only inside your own directory ${F}/<your-area>/ (create it). Make your private copy first:  cp -r ${F}/app ${F}/<your-area>/app && chmod -R u+w ${F}/<your-area>/app , then run "npm ci --no-audit --no-fund" in it (seconds; the npm cache is warm). Never write to ${F}/app, to /home/user/cert-admin-console, to ${S}/final or to another verifier's directory.
2. Ports: use only the port range given to you below. Start servers with PORT=<port> HOST=127.0.0.1 and with DB_PATH=<a file inside your directory> (or --db for the CLI scripts). Never use the default port 3000. "npm test" needs no settings: it uses ephemeral ports and temp directories.
3. Record the PID of every long-running process you start (server, vite, helper scripts) and stop each one by PID before you finish; check that your ports no longer answer. If stopping a process is refused, say so in your summary with PID and port.
4. Node versions on this machine: default "node" is 22.23.5 (npm 10.9.9); Node 20.20.2 (npm 10.8.2) is at ${S}/node20/node-v20.20.2-linux-x64/bin; Node 24.22.3 (npm 11.19.1) is at /opt/node24/bin - put the directory first in PATH to use one. A native module installed under one Node version does not load under another: use a separate copy (and npm ci) per Node version. Chromium and Playwright are pre-installed: require('playwright') works from any directory, chromium.launch() needs no options; do not install browsers. python3 is available (sqlite3, unicodedata, zoneinfo) for independent oracles. You run as root; "runuser -u nobody -- <command>" runs something as an unprivileged user (it needs HOME and TMPDIR pointing to places it may write, and a copy it may read).
5. The machine has 4 cores and other verifiers are active at the same time. Treat a single slow measurement with suspicion: repeat it, and say when load may explain a number. Do not report a timing finding you could not repeat.
6. A finding needs a reproduction you ran yourself: exact commands or steps, what you observed, what you expected. Severity: critical = wrong or lost data, or an acceptance criterion violated; major = a spec requirement or documented feature fails in a realistic situation; minor = wrong in an edge case, misleading message or documentation, or an important behaviour without any test; nit = cosmetic or very unlikely. Things the README lists as deliberately out of scope or describes as a known limit are not findings (a limit that the README describes wrongly is), and neither is the absence of real authentication (the spec forbids adding it).
7. When you are done, return your result through the structured output: a summary, what you checked (with numbers), the previous findings you rechecked, and the findings (an empty list if you found nothing wrong).

`

const AREAS = [
  {
    key: 'test-quality',
    prompt: `YOUR AREA: test-quality   (directory ${F}/test-quality, ports 7000-7049)
Decide whether the project's test suites can be trusted as evidence. Nobody has examined this yet: the previous round's verifier for this area never ran.
- Reliability: in your copy run "npm test" three times on Node 22, then the backend suite (cd backend && npm test) three more times while four busy-loop processes load the CPU, then "npm test" once each on Node 20 and Node 24 (separate copies), and the backend suite once with SQLITE_DRIVER=node. Run "npm test" once with hostile settings exported in the shell (NODE_ENV=production DB_BUSY_TIMEOUT_MS=200 EXPORT_MAX_CONCURRENT=1 EXPORT_IDLE_TIMEOUT_MS=5 HOST=203.0.113.9 DB_PATH=/nonexistent/x.sqlite PORT=1 LOG_REQUESTS=0): the suites claim to be independent of them. Run the UI suite 10 times in a row (npm run test --workspace frontend) and the UI tests added in the last round 100 times each under CPU load (npx vitest run <file> -t "<name>"): "stays locked from the answer until the roster on screen reflects the run: clicks in between start nothing" (it hammers the button from setImmediate and a MutationObserver - is it deterministic, and does it really fail when the fix in BulkIssuePage.jsx is removed?), the tests in "Dialogs are modal: only the top-most one can be operated", and "tells the stylesheet how high the bar is while it sticks ...". Report any failure, flake, hang or cancelled test with its output, and how long the runs take (the README says "about a minute").
- The suite as another user: the backend test "a database file that cannot be written to is refused at start-up, not at the first write" starts its server as the user "nobody" when the suite runs as root (test/helpers.js: unprivilegedSpawnOptions, canOpen). Check that it really runs here (not skipped), that it fails when backend/src/bootstrap.js no longer calls assertWritable, and that the whole backend suite also passes when it is run as an unprivileged user (copy the project to a directory "nobody" may read and write, e.g. below /tmp, npm ci there as root, chown -R nobody, then runuser -u nobody -- env HOME=<dir> TMPDIR=<dir>/tmp npm test in backend).
- Independence: run individual suites and tests in isolation (node --test --test-name-pattern=... for the backend files; npx vitest run <file> -t <name> for the UI) to find tests that only pass after another test, and check that the suites leave nothing behind (temp directories in the OS temp dir, processes, listening ports, files in the repository; the project's data/ directory must stay untouched; world-writable directories).
- Sensitivity (mutation spot check): make about 40 small behaviour-changing edits, one at a time, in a throw-away copy and run the suites that should notice. Half of them in the code that changed in the last round (see round4.diff: backend/src/lib/download.js, the export route in src/app.js, src/db/sqlite.js assertWritable and createDirectory, src/bootstrap.js, src/config.js, src/server.js, src/services/certificates.js, src/services/bulkIssue.js, scripts/*.js; frontend/src/components/BulkIssuePage.jsx, ui.jsx (Dialog), CertificatesPage.jsx, CertificateDetail.jsx, App.jsx, api.js, hooks.js), half in the code that carries the acceptance criteria (tenant scoping in the services, idempotency in src/services/bulkIssue.js and ledger.js, revocation, ordering, time zones, CSV, frontend/src/bulkIssueStore.js). Prefer mutants that would matter to a user (wrong tenant, second request, lost outcome, wrong order, missing validation, a dialog that can be left). For every survivor decide whether it is equivalent or a real gap, and report the real gaps with the exact edit.
- Honesty of the verification command: confirm that "npm test" exits non-zero when a backend test fails and when a UI test fails (introduce a failing mutant for each), that a hanging test is reported by name within a few minutes instead of stalling the run for ever (make one request handler never answer), that a test file that crashes on import fails the run, and that the test counts printed match the README (190 API tests, 252 UI tests; is any test skipped?).
- Read the test code for weak assertions: tests that cannot fail, assertions on the wrong thing, time-based waits that are too tight for a loaded machine or so generous that they hide slowness, UI fixtures (frontend/test/fixtures/recorded.json, re-record with node frontend/test/fixtures/record.mjs) that drifted from what the backend really sends, simulated-DOM tests that pass although a real browser behaves differently (compare a few with Playwright).
Report flaky or order-dependent tests, real mutation survivors, misleading test names and anything that makes a green run less trustworthy than it looks.`,
  },
  {
    key: 'frontend-browser',
    prompt: `YOUR AREA: frontend-browser   (directory ${F}/frontend-browser, ports 7050-7099)
Verify the user interface in a real browser (Playwright + Chromium) against the real backend, on the production build (start with "PORT=70xx HOST=127.0.0.1 DB_PATH=... npm start" in your copy) and on the Vite dev server, which runs React StrictMode (start the API with "PORT=<api> HOST=127.0.0.1 DB_PATH=... node backend/src/server.js" and then, in app/frontend, "API_URL=http://127.0.0.1:<api> npx vite --host 127.0.0.1 --port <port> --strictPort"). The previous verifier of this area left its scripts in ${S}/final/frontend-browser/scripts (lib.cjs, t00-t21, repro_findings.cjs); you may copy and adapt them (they contain the paths and ports of the previous round and some checks that describe the old behaviour), but judge by what you observe, not by what a script prints.
1. The ten findings of the previous round (final_verify_frontend-browser.json). For each: is it gone, on both builds, also in the variations its description mentions? In particular
   - Bulk issue: no click, however timed, starts a second operation for one intention: script clicks in every task, trusted mouse events 1-32 ms apart, a held Enter key, double clicks, with the answer taking 0 ms to 2 s, with a slow or failing roster reload after the answer, and with CPU throttling. After the answer the button must stay locked until the roster on screen reflects the run - and must come back when it does (also when that roster request fails and is retried).
   - While a bulk issue "may or may not have gone through" or "has not run yet", the course picker is locked and the prompt and its key survive everything except Retry and Dismiss: the other tab, the other actor and back, a reload, the browser's back and forward buttons, a deep link, a change event from a script, the course disappearing meanwhile (npm run db:reset on the database while the prompt is open - what then?).
   - The end of a bulk issue is announced: the status region (aria-live) exists before its text changes, the text is right for success, partial failure and a replayed request, nothing is announced on a plain page load, and "Show outcomes" leads to the result.
   - Drawer and confirmation are modal: Tab and Shift+Tab never leave the top-most dialog (start from every control, from the dialog itself and from a lost focus), everything behind is inert (not focusable, not clickable, absent from the accessibility tree - check with Playwright's accessibility/aria snapshot), a confirmation whose request is in flight cannot be closed or bypassed by any key sequence, and the page is fully operable again after every way of closing: Escape, the Close button, the backdrop, Cancel, a successful revocation, browser back/forward, a changed hash, a render error (error boundary). No "inert" attribute may ever be left behind, on either build. Focus returns to where it came from.
   - Nothing that receives the focus or that the page scrolls to is hidden under the top bar: Tab and Shift+Tab through every page (list with 100,000 generated certificates and 100 rows, bulk issue with result and history) at 1366x768, 1024x768, 800x600, 740x900 (the bar wraps), 683x384 and 360x640; "View outcomes" / "Show outcomes" with the page scrolled anywhere. Check the README's reasoning: the bar sticks on large windows and scrolls away on small ones.
   - A revocation reason typed on several lines is shown as typed (drawer field and audit trail) and still wraps when it is one very long line or word.
   - An export answer that is not a CSV is refused and nothing is saved; a correct one is saved byte for byte (compare with curl), also 100,000 rows.
   - Selecting text in a row (drag, double click, shift-click) does not open the drawer; a plain click and the keyboard still do.
   - Switching the actor with a certificate open sends no request for that id as the new actor (watch the server log).
2. Regressions: run through the four workflows of the spec once more end to end as both actors on both builds (list: search, status filter, every sort column both ways, page sizes including 5, pagination; detail; revoke with its three outcomes; bulk issue with outcomes issued / skipped with reason / failed; export preserving search and sort), with request interception or a proxy of your own to lose, delay and corrupt answers, and the SQLite write lock held from python3 to provoke 503 database_busy. Tenant isolation in the UI: nothing of East is ever visible while acting as Bob.
3. The browser console stays free of errors and warnings on both builds (apart from failed requests you provoked).
Report wrong behaviour, misleading text, lost input, focus traps that trap too much or too little, console errors, README claims (section "3. Using the console") that do not hold, and anything a fix has made worse.`,
  },
  {
    key: 'backend-adversarial',
    prompt: `YOUR AREA: backend-adversarial   (directory ${F}/backend-adversarial, ports 7100-7149)
Try to break the backend, concentrating on what the last round changed (read round4.diff and the sources it touches) and on the findings of the previous round (final_verify_backend-adversarial.json, and the backend-related ones in final_verify_install-docs.json and final_verify_spec-acceptance.json).
1. Downloads that cannot be completed (backend/src/app.js export route, src/lib/download.js). Claims: a download the server gives up (idle timeout, failure while reading) or that the client abandons is ended with a connection reset, never with a clean close, so that a client without chunk framing cannot take half a file for a whole one; a client that half-closes right after its request gets the reset too; every other client gets the complete file. Attack with raw sockets on Node 22 AND Node 20 AND Node 24: HTTP/1.1 and HTTP/1.0 requests, keep-alive and "Connection: close", pipelined requests (export first, export last, several exports), half-close before / during / after the body, clients that stall and resume, clients that read very slowly (with EXPORT_IDLE_TIMEOUT_MS small and large), clients that vanish; and with ordinary clients (curl, curl --http1.0, wget, python3 urllib/http.client, node fetch, a browser download via Playwright) that must all receive byte-identical complete files (compare sha256). Does a reset ever hit a client that did nothing wrong (e.g. the next request on a reused connection, a slow but steady reader, a client that sends its request in two packets)? After every abuse check that export slots are free, no reader connection is left (file descriptors of the server process; "PRAGMA wal_checkpoint(TRUNCATE)" from another process succeeds) and the server log is sane. Use a database with 100,000 generated certificates. Measure the memory of the server process (RSS) with 1, 4, 16 and 64 exports running at once (EXPORT_MAX_CONCURRENT up to 64) and list latency meanwhile, from a separate process.
2. A database that cannot be written to (src/db/sqlite.js assertWritable, src/bootstrap.js): as user nobody (runuser) with a read-only file in a writable directory, a writable file in a read-only directory, a read-only file with and without -wal/-shm files next to it, a directory that does not exist and cannot be created, a path below /proc, a path that is a directory; with both drivers (SQLITE_DRIVER=node). Each must end in one clear line and exit code 1, quickly, leave nothing behind and never damage the file; a database that another process is writing to at that moment must still start. The check itself must not change the file (compare bytes, mtime aside) or disturb a concurrent writer.
3. Start-up and settings: the start-up line names an address that leads to the server (HOST unset, 0.0.0.0, ::, ::1, 127.0.0.1, localhost, a host name that does not resolve); settings that are blank or white space only count as not set (PORT, HOST, DB_PATH, STATIC_DIR, LOG_REQUESTS, DB_BUSY_TIMEOUT_MS, EXPORT_MAX_CONCURRENT, EXPORT_IDLE_TIMEOUT_MS, SQLITE_DRIVER); LOG_REQUESTS accepts 0 and 1 only; every unusable value is reported in one line before the port is taken or a database file is created.
4. Command-line scripts through npm: "npm run db:reset -- --db <file>", "npm run generate:east -- --db <file> --count N --seed N --tenant X --clear" with good and bad values (empty --db, unknown tenant on a new and on an existing database, count 0 / 2000001 / 1e3, a file that is not a database, a database of another schema version). After a reset the file must be as small as a newly created database and hold no sqlite_stat tables, also while a server or a reader has it open. "npm run dev" without installed dependencies and with PORT blank.
5. Search and parameters: a search of accents and spaces only matches nothing; accents fold in Latin, Greek and Cyrillic (compare with a python3 unicodedata oracle on names you insert); "sort=-x" together with "order" is a 400; "courseId" together with "course_id" is a 400; two aliases of one query parameter are a 400; list, total, pages and export always agree.
6. Regression sweep of the core: tenant isolation on every endpoint, idempotency with 30 concurrent identical requests on two server processes sharing one database, key reuse with another payload, revocation races, both SQLite drivers - short, but with your own scripts and a look into the database file with python3.
Anything that makes the server hang, leak, answer wrongly, lose or duplicate data, or contradict the README is a finding. Run the backend suite once per SQLite driver in your copy as a baseline (cd backend && npm test; SQLITE_DRIVER=node npm test).`,
  },
  {
    key: 'spec-acceptance',
    prompt: `YOUR AREA: spec-acceptance   (directory ${F}/spec-acceptance, ports 7150-7199)
Act as the strict reviewer who receives this project together with the specification and decides whether it is accepted. The code has changed since the last such review, so decide from scratch.
- From your fresh copy start the app with the one documented command (PORT=71xx HOST=127.0.0.1 DB_PATH=... npm start) and confirm that this single command really installs, builds, seeds and serves UI and API.
- Go through SPEC.md sentence by sentence (sections 1-4) and check each requirement against the running app: tech-stack constraints, seed data (tenants, time zones, admins, "Safety 101" and "Alex Lee" in both tenants with completed / incomplete / already-certified enrollments), the separate generator command for 100,000 East certificates that must not alter the quick-start dataset, the four workflows (drive the UI with Playwright where the requirement is about the UI: actor switch, search, pagination, sorting, loading/empty/error states, duplicate-submission prevention, operation status, per-learner outcomes, detail fields, revocation with confirmation, CSV export preserving search and sort), and the audit logs for issuance and revocation.
- Verify A1-A7 yourself over HTTP with your own scripts, not by trusting the project's tests: cross-tenant list/detail/bulk-issue/export/revoke; sequential and concurrent identical bulk issues with one Idempotency-Key (at least 20 concurrent, check certificates and audit events in the database file with python3 sqlite3); the same key with another course or payload (409, nothing executed, first result intact); per-learner outcomes; the instant 2026-01-10T13:30:00Z shown as 2026-01-11 00:30 for East and 2026-01-10 21:30 for West, and sorting and export by tenant-local calendar date; with 100,000 generated East certificates a filtered + sorted export twice, each under 60 s, identical and deterministic with id as tie-breaker, while list requests keep being answered; revocation writing exactly one audit event and repeats being idempotent.
- Also run "npm test" once in your copy and report the totals.
- Look for scope violations (the spec forbids production auth, cloud deployment, notifications and unrelated features) and for anything a reviewer would stumble over in the first ten minutes (confusing README step, command that fails, misleading output). The last round added behaviour to the UI (modal dialogs that make the page behind them inert, a locked course picker while the outcome of a bulk issue is open, a status line after a bulk issue, a top bar that scrolls away on small windows): does any of it get in the way of the workflows the spec asks for?
Report every requirement that is unmet or only partly met as a finding; say explicitly in the summary whether, in your judgement, each of A1-A7 passes.`,
  },
  {
    key: 'install-docs',
    prompt: `YOUR AREA: install-docs   (directory ${F}/install-docs, ports 7200-7249)
Check that a stranger can run the project from a fresh checkout and that the documentation is true.
- For each of Node 20.20.2, 22.23.5 and 24.22.3, in a separate fresh copy without node_modules: run the documented "npm start" (with PORT/HOST/DB_PATH set as required by the ground rules) and confirm UI and API answer; run "npm test" and record totals and duration; run "npm run generate:east" (with -- --db <file>, with -- --count 250000, with -- --clear), "npm run db:reset" (DB_PATH=..., and with -- --db <file>) and a quick "npm run dev" start (it uses PORT for the API and Vite's port 5173: check that port is free first and stop it right away). Repeat "npm start" and "npm test" once with NODE_ENV=production exported and once with NODE_ENV=development, "npm start" once with package-lock.json deleted (the project's .npmrc claims this still works on npm 10.9), and "npm run dev" in a copy without node_modules (it must say what to do in one line). Start a copy that was installed under Node 22 with Node 20 and with Node 24: the message must say what to do.
- After each command compare the tree with the snapshot: package-lock.json must be byte-identical, and nothing may appear outside node_modules, frontend/dist, frontend/node_modules and data/*.sqlite* (compare file lists and sha256 against ${F}/manifest.sha256).
- Read README.md line by line and check every checkable statement, with special attention to what the last round changed (round4.diff shows the README changes): requirements, commands, the settings table against backend/src/config.js and backend/src/db/sqlite.js (names, defaults, meaning; invalid, blank and white-space values; LOG_REQUESTS), the start-up line, the demo-data tables against a fresh database (ids, rosters, outcomes), every curl example (run them in order on a fresh database and compare with the comments), the API table (parameters, aliases, limits, every error code and shape including 415 and 500), the sample bulk-issue response, the CSV format, the test counts ("190 API tests", "252 UI tests"), the note about the test that runs as "nobody", the "about a minute", the numbers in "Typical numbers" (plausible on this machine?), section 3 (page sizes, modal dialogs, locked course picker, announced status, refused non-CSV export), the design notes on search (Greek and Cyrillic accents, accents typed on their own) and on downloads that cannot be completed (reset; clients that half-close; "Browsers, curl, wget and HTTP libraries do not do that" - check a few), the troubleshooting entries (port in use, schema version, 503 texts, db:reset, another Node.js version, database that cannot be written to, npm run dev without dependencies), the project layout section against the actual tree, the Chinese summary at the end, and the screenshots in docs/screenshots against the current UI (take fresh ones with Playwright and compare what they show).
- Look at the repository hygiene: .gitignore covers what the commands create; no secrets, absolute paths of this machine, leftovers of development (TODO, console.log debugging, commented-out code, unused files, exports or dependencies); package.json files (scripts, engines, workspaces, dependency ranges) are consistent with the lockfile and with the README; comments in the code that no longer describe the code next to them (the last round moved things: check the comments in the files round4.diff touches).
- Error experience: what does a user see with Node 18 or 20.18 (scripts/preflight.mjs; simulate by reading the script and, if you can, by faking process.versions), with the port taken, with a database file of another schema version, with an unwritable DB_PATH, with an invalid setting? Each should end in one clear line, not a stack trace.
Report every statement that is false or misleading, every command that fails or leaves changes behind, and anything that would cost a first-time user time.`,
  },
]

phase('Verify')
const results = await parallel(
  AREAS.map((area) => () =>
    agent(COMMON + area.prompt, { label: 'verify:' + area.key, phase: 'Verify', schema: RESULT_SCHEMA, model: '[REDACTED: model identifier B]' }).then((result) =>
      result ? { area: area.key, ...result } : null,
    ),
  ),
)
const completed = results.filter(Boolean)
const missing = AREAS.filter((_, index) => !results[index]).map((area) => area.key)
log(completed.length + ' of ' + AREAS.length + ' verifiers returned a result' + (missing.length ? '; missing: ' + missing.join(', ') : ''))

// The critic needs all reports at once: it looks for what none of them covered.
phase('Critic')
const digest = completed
  .map((result) => {
    const findings = result.findings.map((finding) => '    - [' + finding.severity + '] ' + finding.title).join('\n') || '    (none)'
    const checks = result.checksPerformed.map((check) => '    - ' + check).join('\n')
    return '== ' + result.area + ' ==\n  summary: ' + result.summary + '\n  checks performed:\n' + checks + '\n  findings:\n' + findings
  })
  .join('\n\n')

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    gaps: {
      type: 'array',
      description: 'What nobody had verified, and what you found when you verified it.',
      items: {
        type: 'object',
        properties: {
          gap: { type: 'string', description: 'The spec requirement, README claim or changed code path that no verifier covered.' },
          whatYouDid: { type: 'string' },
          result: { type: 'string', enum: ['holds', 'does not hold', 'could not be checked'] },
        },
        required: ['gap', 'whatYouDid', 'result'],
      },
    },
    findings: { type: 'array', items: FINDING },
  },
  required: ['summary', 'gaps', 'findings'],
}

const critic = await agent(
  COMMON +
    `YOUR AREA: completeness critic   (directory ${F}/critic, ports 7250-7299)
Five verifiers have just examined the project (test quality, the UI in a browser, the backend, the acceptance criteria, install and documentation)${missing.length ? ' - of which these returned nothing, so their areas are entirely open: ' + missing.join(', ') : ''}. Below is what each of them says it checked and found. Your job is the remainder: what did none of them check?
1. Build the list of things that need evidence: every requirement in SPEC.md (sections 1-4, A1-A7), every checkable statement in README.md that the last round changed (round4.diff), and every code path that round4.diff added or changed (sources and scripts, backend and frontend).
2. Strike out what the reports below demonstrably cover. Be strict: "ran the suite" covers nothing specific; a check counts only if the report names it.
3. Verify what remains yourself, most important first (data correctness and the acceptance criteria before conveniences), with your own scripts against your own copy of the project - on the running app, in a real browser where it is about the UI. Also sample five of the verifiers' own findings and positive claims and re-run them: is the finding real, is the claim true?
Report each gap with what you did and the result, and every problem you find as a finding (with a reproduction you ran).

WHAT THE VERIFIERS REPORTED
` +
    digest,
  { label: 'critic:completeness', phase: 'Critic', schema: CRITIC_SCHEMA, model: '[REDACTED: model identifier B]' },
)

return { completed, missing, critic }
