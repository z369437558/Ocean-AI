export const meta = {
  name: 'confirm-post-verification-fixes',
  description: 'Adversarial confirmation of the changes made after the last verification round: dialog handling in the UI, database open pre-check and dev tooling, and the new README sections',
  phases: [{ title: 'Confirm', detail: 'three independent verifiers on private copies of the frozen snapshot', model: '[REDACTED: model identifier B]' }],
}

const S = '/tmp/claude-0/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9/scratchpad'
const F = S + '/final3'

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
          category: { type: 'string', description: 'bug | regression | docs | test-gap | robustness | ux | accessibility | tooling' },
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

const COMMON = `You are one of three independent verifiers of a small software project just before it is handed over. It went through a full verification round; the author then changed code, tests and documentation once more to answer that round's findings. Your job is to check exactly those last changes: prove that one of them is wrong, incomplete or has broken something next to it - or establish, with evidence you produced yourself, that it holds. Be adversarial but honest: report only what you reproduced; do not pad the report with speculation.

THE PROJECT
"Multi-Tenant Certificate Admin Console": an internal admin console where tenant admins review course completions, bulk-issue certificates, revoke them and export them as CSV. Backend: Node.js (ESM), Express 5, SQLite in WAL mode (driver better-sqlite3, automatic fallback to the built-in node:sqlite). Frontend: React 19 + Vite. No login: every API request names its actor in the header X-Actor-Email (alice@east.test -> tenant East; bob@west.test -> tenant West). "npm start" installs, builds the UI, creates the demo database and serves UI + API on one port. "npm test" runs 191 API tests (node:test) and then 253 UI tests (Vitest, simulated DOM).
- The task specification: ${F}/SPEC.md
- The project as it will be handed over (frozen, READ-ONLY, 72 files): ${F}/app   (manifest: ${F}/manifest.sha256). Treat every statement in its README.md as a claim to check.
- The changes to verify, as a diff against the state that was verified before: ${F}/delta.diff  (12 files: README.md, backend/src/db/sqlite.js, backend/src/lib/csv.js, backend/test/*.js, frontend/src/components/ui.jsx, frontend/test/detail-revoke.test.jsx, frontend/test/setup.js, frontend/vite.config.js, package.json, scripts/dev.mjs). Read it first.
- The findings of the previous round that these changes answer (JSON, one file per verifier): ${S}/wfres/r4_frontend-browser.json, r4_backend-adversarial.json, r4_test-quality.json, r4_install-docs.json, r4_completeness.json, r4_spec-acceptance.json.

GROUND RULES
1. Work only inside your own directory ${F}/<your-area>/ (create it). Make your private copy first:  cp -r ${F}/app ${F}/<your-area>/app && chmod -R u+w ${F}/<your-area>/app , then run "npm ci --no-audit --no-fund" in it. Never write to ${F}/app, to /home/user/cert-admin-console, to ${S}/final, ${S}/final2 or to another verifier's directory. Check your current directory before every command that starts a server or a dev server: a command typed in the wrong directory has started servers inside the real project before.
2. Ports: use only the port range given to you below. Start servers with PORT=<port> HOST=127.0.0.1 and with DB_PATH=<a file inside your directory> (or --db for the CLI scripts). Never use the default port 3000 unless your area says so. "npm test" needs no settings.
3. This machine has no "ss" or "netstat": to see what listens, read /proc/net/tcp or use ${S}/listening.sh; find your processes with pgrep and /proc/<pid>/cwd. Record the PID of every long-running process you start and stop each one by PID before you finish; check that your ports no longer answer.
4. Node versions: default "node" is 22.23.5 (npm 10.9.9); Node 20.20.2 is at ${S}/node20/node-v20.20.2-linux-x64/bin; Node 24.22.3 is at /opt/node24/bin - put the directory first in PATH to use one, and use a separate copy (with its own npm ci) per Node version. Chromium and Playwright are pre-installed (require('playwright'), chromium.launch() without options). python3 is available. You run as root; "runuser -u nobody -- <command>" runs something as an unprivileged user and "setpriv --bounding-set=-dac_override <command>" runs it as root without the right to ignore file permissions. The path ${S} is only accessible to root (mode 0700 above it): for anything "nobody" must read, make a copy below /tmp/<your-area>-... and remove it afterwards.
5. The machine has 4 cores and other verifiers are active at the same time. Do not report a timing observation you could not repeat.
6. A finding needs a reproduction you ran yourself. Severity: critical = wrong or lost data, or an acceptance criterion violated; major = a spec requirement or documented feature fails in a realistic situation; minor = wrong in an edge case, misleading message or documentation, or an important behaviour without any test; nit = cosmetic or very unlikely. What the README lists under "Known defects", "Not verified" or "Unfinished work" is not a finding - unless the README describes it wrongly.
7. Return your result through the structured output: a summary, what you checked (with numbers), and the findings (an empty list if you found nothing wrong).

`

const AREAS = [
  {
    key: 'frontend-dialog',
    prompt: `YOUR AREA: frontend-dialog   (directory ${F}/frontend-dialog, ports 7300-7349)
The change: frontend/src/components/ui.jsx - the Dialog component now uses TWO effects. A layout effect makes everything outside the dialog inert, moves the focus in, and handles Tab and Escape; its clean-up releases the page in the same step in which the dialog leaves the DOM. A separate ordinary effect returns the focus, after the whole page update, to the element that opened the dialog - or, if that element is gone, to the top-most remaining dialog. Before, one ordinary effect did all of it. Also changed: frontend/test/setup.js (waitFor / findBy limit 5 s) and frontend/vite.config.js (testTimeout / hookTimeout 30 s), and three tests in frontend/test/detail-revoke.test.jsx.
Verify in a real browser (Playwright + Chromium) against the real backend, on the production build ("PORT=73xx HOST=127.0.0.1 DB_PATH=... npm start" in your copy) AND on the Vite dev server, which runs React StrictMode (API: "PORT=<api> HOST=127.0.0.1 DB_PATH=... node backend/src/server.js"; then in app/frontend "API_URL=http://127.0.0.1:<api> npx vite --host 127.0.0.1 --port <port> --strictPort"):
1. Focus on open and close, for the certificate drawer (opened from a serial link, from a row click, from the keyboard, from a deep link) and for the revoke confirmation on top of it: where is the focus right after opening; after closing by Escape, the Close/Cancel button, the backdrop, browser back/forward and a changed hash; after a successful revocation (the Revoke button that opened the confirmation no longer exists then: the focus must land on the drawer, not on <body>); after a failed revocation; after "Try again". Does the focus ever end up on <body> or on something behind an open dialog? Is there a visible flash or a frame in which the page behind is operable while a dialog is open, or inert while none is open (sample with a MutationObserver and requestAnimationFrame)?
2. inert: exactly while a dialog is in the DOM. No "inert" attribute left behind after any way of closing, after a render error caught by the error boundary, after switching tabs with the keyboard while a drawer is open (is that even possible?), after rapid open/close sequences (click a row, Escape, click another row, 30 times quickly), after opening a deep link to a certificate of the other tenant ("Certificate not found" drawer), and on the dev build with StrictMode (effects run twice).
3. Tab / Shift+Tab stay inside the top-most dialog; a confirmation whose request is in flight cannot be closed from the page; Escape closes only the top-most layer.
4. Regression sweep of the four workflows on both builds (list with search / sort / paging, detail, revoke with confirmation, bulk issue with outcomes, CSV export), console free of errors and warnings.
5. The UI suite in your copy: "npm run test --workspace frontend" 10 times in a row, then the tests of the describe blocks "Dialogs are modal" and "Revoke dialog: focus and layout" (file frontend/test/detail-revoke.test.jsx) 100 times each under CPU load (4 busy loops) - any failure is a finding, with its output. Check that the new limits do not hide failures: make one test genuinely fail (e.g. expect a text that never appears) and confirm the run still fails, in reasonable time, with a clear message. Check with small mutations that the changed tests really pin the behaviour: turn the layout effect back into an ordinary effect; move the focus return into the layout effect's clean-up; drop the fallback to the remaining dialog - each must fail a test.
Report anything where the browser behaves differently from what the simulated-DOM tests assert.`,
  },
  {
    key: 'backend-tooling',
    prompt: `YOUR AREA: backend-tooling   (directory ${F}/backend-tooling, ports 7350-7399; additionally Vite's fixed port 5173 for "npm run dev" - check that it is free first and free it right away)
The changes:
(a) backend/src/db/sqlite.js: assertFilesWritable() - before SQLite opens an existing database for writing, the file, an existing -wal / -shm next to it and (if one of those two is missing) the directory are checked with access(W_OK); a database this process may not write is refused with "the database cannot be written to (<what is in the way>)" and nothing is created. Connection.assertWritable() (a write attempt inside a rolled-back transaction) remains as a second check after opening.
(b) package.json: the root scripts start node directly ("node backend/src/server.js", "node backend/scripts/init-db.js --reset", "node backend/scripts/generate-certificates.js ...") instead of a nested "npm run --workspace", so that arguments and relative paths (DB_PATH, STATIC_DIR, --db) are taken from the directory the command is typed in; the scripts "serve" and "build" are gone.
(c) scripts/dev.mjs ("npm run dev"): the API (node --watch) is started first and its output is passed through; Vite starts only once the API is listening; a first start that fails ends the command with the API's one-line message and a non-zero exit code; Vite's proxy target follows HOST.
(d) backend/test/helpers.js + acceptance.test.js: the test "a database file that cannot be written to is refused at start-up, not at the first write" now starts its server through launcherBoundByPermissions(): as root with "setpriv --bounding-set=-dac_override", else as user "nobody", else skipped with the reason. New unit tests: 'opening the database for the server ends with that question ...', TAB/CR in 'neutralises spreadsheet formulas', a raced mkdir in 'creates missing directories ...'.
Attack each:
1. The pre-check, as an unprivileged process (runuser nobody and setpriv), with both drivers (SQLITE_DRIVER=node): read-only file; read-only -wal or -shm next to a writable file; missing side files in a read-only directory; side files present in a read-only directory (must start); a database path that is a symbolic link (to a writable file, to a read-only file, dangling); a directory given as the path; a new database in a writable / unwritable / missing directory. In every refused case: one line, exit code 1, quickly, and the directory byte-for-byte as before (file list, sizes, sha256, modes). Most important: does the check ever refuse a database that would have worked (false positive)? Think of: a server already running on the same file (side files exist, owned by another user or with other modes), a second server started at the same moment as the first on a new file, the load-test generator or db:reset running while a server has the file open, group-writable files, a file that becomes writable between two starts, root. Run "npm run generate:east -- --db ...", "npm run db:reset -- --db ..." and a second server against a database that a first server has open, 20 times each: none may be refused.
2. The npm scripts: "npm start", "npm test", "npm run db:reset", "npm run generate:east" (with -- --db, --count, --clear, --tenant, --seed) typed in the project root and in a subdirectory (data/, docs/) with relative and absolute paths: where does the file end up; are arguments handed on unchanged, also ones with spaces; is anything created in the project root or outside data/ that .gitignore does not cover? "npm start" on a fresh copy without node_modules on Node 20, 22 and 24; lockfile byte-identical afterwards.
3. "npm run dev" on Node 20, 22 and 24: normal start (Vite answers on 5173, /api is proxied, with HOST unset, HOST=127.0.0.1 and HOST=<this machine's address from hostname -I>); the API restarts when a backend source file is touched and its output still passes through, and a restart that fails while editing (introduce a syntax error, then fix it) does NOT end the command; first start with PORT=abc, with the API port taken, with DB_PATH pointing to a read-only database, with LOG_REQUESTS=2: one line, non-zero exit, no process left (check for vite and node --watch with pgrep), port 5173 free; Ctrl+C (SIGINT to the process group) and SIGTERM end everything with no process left; without node_modules: one line.
4. The suite: "npm test" in your copy on Node 22, 20 and 24 (counts must be 191 and 253, nothing skipped - your copy lives below a root-only path, which is exactly the situation the new launcher is for); the backend suite as user nobody from a copy below /tmp; with PATH reduced so that setpriv is not found (then the nobody fallback or an honest skip message - which one, and is the message true?). Mutation spot check of the changed code (about 15 edits in assertFilesWritable, dev.mjs is untested by design - say what is and is not covered, launcherBoundByPermissions, csv.js): which survive?
Run the backend suite once per SQLite driver as a baseline. Anything that hangs, leaks a process, refuses a healthy database, leaves files behind or contradicts the README is a finding.`,
  },
  {
    key: 'readme-claims',
    prompt: `YOUR AREA: readme-claims   (directory ${F}/readme-claims, ports 7400-7449 - and, for this area only, the default port 3000 with the default database of YOUR copy, because the README's reproduction steps are written for it; check that 3000 is free first, start "npm start" only inside your own copy, and stop it when you are done)
The README changed a lot in the last step (see delta.diff). Check the new and changed text against the running app, as the stranger who receives this repository together with the checklist "README with one-command startup, actor tokens or headers, A1 to A7 reproduction steps, 100,000-row generation, known defects, and unfinished work".
1. "Reproducing A1-A7 by hand" (section 6): in a fresh copy run "npm start" (default port and database), then execute every code block of that subsection verbatim, in order, in a second shell - extract the blocks from README.md mechanically, do not retype them. Compare every output with the comment next to the command and with the prose. Then judge the steps against SPEC.md: does each block really demonstrate what its acceptance criterion asks (A1 isolation incl. "no certificates or audit events written", A2 sequential and concurrent, A3 conflict without a second operation and with the first result intact, A4 issued / skipped with reason / failed, A5 the two reference times and local-date ordering, A6 two filtered and sorted exports under 60 s each, identical, deterministic order with id as tie-breaker, list requests not blocked, A7 one audit event and idempotent repeats)? Where a block shows less than the criterion says, that is a finding. Repeat the run once on Node 20 and once on Node 24, and once with a bash that has "set -e -u -o pipefail" (do the blocks survive being pasted into a strict shell?). Are /tmp/a2-*.json and /tmp/e*.csv left behind - does the README say so?
2. "10. Known defects and unfinished work": reproduce every listed defect as it is described (the 20,000-learner bulk issue that holds other requests up for about a second - build the data with SQL; the linear list search and deep pages at 100,000 certificates: "tens of milliseconds"; the double click in a list row; browser Back during a revocation in flight; netcat and a half-closing client on an export; idempotency keys never expiring; the hint after a refused db:reset on a read-only database). Is each description accurate - not understated, not overstated? Then look for defects that are NOT listed: go through the four workflows and the API once more with that question, and read ${S}/wfres/r4_*.json for findings of the last round that are neither fixed in this snapshot nor listed here.
3. The rest of what changed: the "Where to find what" table (do the links resolve to headings as GitHub would slug them?), the commands table and the sentence after it, the settings table (STATIC_DIR; try it), "A relative path ... is taken from the directory the command is typed in" (try DB_PATH, STATIC_DIR and --db from a subdirectory), the note on the test that runs with setpriv or as nobody, the sentence about leaving with the browser's Back button, the two paragraphs on downloads that cannot be completed, the troubleshooting entry "the database cannot be written to (...)" (provoke each of the three texts in brackets), the label of the sample bulk-issue response, "otherwise idle" in the typical numbers, the test counts (191 and 253) and the Chinese summary at the end (does it agree with the English text?).
4. Consistency: does anything in the README still describe the previous behaviour (search it for "serve", "nobody", "skipped", "localhost", "190", "252", "three of its five")? Do code comments in the files of delta.diff describe the code next to them?
Report every statement that is false, misleading or missing, every command that fails or leaves something behind, and anything a first-time reader would trip over.`,
  },
]

phase('Confirm')
const results = await parallel(
  AREAS.map((area) => () =>
    agent(COMMON + area.prompt, { label: 'confirm:' + area.key, phase: 'Confirm', schema: RESULT_SCHEMA, model: '[REDACTED: model identifier B]' }).then((result) =>
      result ? { area: area.key, ...result } : null,
    ),
  ),
)
const completed = results.filter(Boolean)
const missing = AREAS.filter((_, index) => !results[index]).map((area) => area.key)
log(completed.length + ' of ' + AREAS.length + ' verifiers returned a result' + (missing.length ? '; missing: ' + missing.join(', ') : ''))
return { completed, missing }
