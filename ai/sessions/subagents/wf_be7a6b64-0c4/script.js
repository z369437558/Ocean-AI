export const meta = {
  name: 'requirements-compliance',
  description: 'Check the finished application against the official wording of sections 2 to 4 of the assignment, as the company\'s evaluator would: sentence by sentence, from a clean clone',
  phases: [
    { title: 'Check', detail: 'two independent evaluators: constraints and product scope; demo data and scenarios A1-A7', model: '[REDACTED: model identifier B]' },
  ],
}

const R = '/tmp/claude-0/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9/scratchpad/req-check'
const REQ = R + '/requirements.txt'

const RESULT = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Three to six sentences: what you did and the overall verdict.' },
    requirements: {
      type: 'array',
      description: 'One entry per requirement sentence (or per row/bullet) of your sections, in the order of the text.',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'e.g. "2 Backend", "3 Bulk issue (c)", "4 demo data (2)", "A6 (d)"' },
          requirement: { type: 'string', description: 'The sentence, quoted from the requirements file.' },
          verdict: { type: 'string', enum: ['met', 'partly met', 'not met', 'could not verify'] },
          evidence: { type: 'string', description: 'What you ran or looked at and what it showed: command, the relevant output, file and line, screenshot path.' },
          readme_reference: { type: 'string', description: 'Where the README documents it (section), or "not documented".' },
        },
        required: ['id', 'requirement', 'verdict', 'evidence'],
      },
    },
    findings: {
      type: 'array',
      description: 'Every defect, gap or ambiguity you found, however small. Empty if none.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          title: { type: 'string' },
          reproduction: { type: 'string', description: 'Exact steps or commands from a clean clone.' },
          expected: { type: 'string' },
          actual: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['severity', 'title', 'reproduction', 'expected', 'actual'],
      },
    },
    not_checked: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'requirements', 'findings', 'not_checked'],
}

const common = (name, port) => `
The candidate's submission: a clean clone at ${R}/${name}/repo (nothing installed, no database yet). Your scratch directory for scripts, downloads and screenshots: ${R}/${name}/work
The official requirements: ${REQ} (sections 2, 3 and 4 of the assignment, as the company wrote them; the layout of its tables was lost in copying, so "Area / Constraint", "Workflow / Required behavior" and "ID / Given / Expected" columns run together).
The directory ai/ and the written answers are not part of your task.

Ground rules:
- You are the company's evaluator, not the candidate's helper. Judge each sentence strictly as written. "Met" needs evidence that you produced yourself in this session; a passing test of the repository or a claim in the README is not evidence by itself.
- Work only inside your clone and your scratch directory. Do not read or change anything else on this machine: not the original repository under /home/user, nothing under /root/.claude, nothing else under the scratchpad. Do not change the candidate's code to make something pass (you may add scripts in your scratch directory).
- Network: only what "npm" needs to install the declared dependencies.
- Your port: ${port}. Another evaluator works on this machine at the same time on another port, and other jobs use the CPU: a timing can be two or three times slower than on a free machine. Before you report a timing as a failure, repeat it.
- Stop every process you start (also on failure) and check at the end that nothing of yours is still running: "pgrep -af node". This machine has no "ss" or "netstat"; a chained "sleep" in a shell command may be refused, use: python3 -c "import time; time.sleep(5)".
- A real browser is available: in a Node script, require('playwright') works from any directory and chromium.launch() needs no options. Do not install Playwright or a browser.
- Report every defect and every documentation gap, however small, with exact steps. If the wording of a requirement can be read in two ways, say which reading the submission satisfies and which not.
- Plan for about 30 minutes, then return what you have, with the rest under not_checked.`

const scope = `You evaluate a take-home submission ("Multi-Tenant Certificate Admin Console") against sections 2 and 3 of the official requirements: "Product and Technical Constraints" and "Required Product Scope".
${common('scope', '3111 (start the app with the environment variable PORT=3111, which the README documents; everything else exactly as the README says)')}

What to do:
1. Section 2, row by row.
   - Backend: language and framework (is the framework mainstream?), database (which one? is it persistent - stop the server, start it again, is the data still there? is anything of the application's state held only in memory?).
   - Frontend: Vue 3 or React.
   - Startup: "One documented command must install or use declared dependencies, initialize demo data, and start the complete app." Run exactly the documented command in the clean clone and time it; confirm that after it the complete app (UI and API) answers and the demo data is there. Is it one command? "A second command may run verification": run it once near the end and report the result (it takes one to three minutes on this machine).
   - Actor context: no login UI; one admin seeded per tenant; how is the actor identified (header or token)? What happens without it, and with an unknown actor?
   - Scope control: look through the code and the UI for production authentication, cloud deployment, notifications or unrelated features. "Correct core behavior comes before visual polish": say if you see polish that displaced correctness.
2. Section 3, workflow by workflow, in a real browser against the running app, as a user:
   - Certificate list: select an actor; search by learner name; search by serial number; paginate; sort (each sortable column, both directions). Provoke and observe the loading state, the empty state and the error state (for example: a search with no result; intercept or delay the list request in the browser; stop the server and act in the UI).
   - Bulk issue: choose a course and issue to all eligible learners. Is a duplicate submission disabled in the UI (double click, Enter held down, clicking again while the first request is delayed)? Is the operation status shown? Are per-learner outcomes returned and shown: issued, skipped, failed - and for skipped and failed, the reason?
   - Certificate detail: serial number, course, learner, tenant-local issue date, status. Revocation with confirmation (can it be revoked without confirming? what does cancel do?). "Audit both issuance and revocation": where can an evaluator see the audit events, and is there exactly one per issuance and per revocation?
   - CSV export: columns learner name, course title, serial number, tenant-local issue date. "Preserve current search and sort": set a search and a sort in the UI, export from the UI, and compare the file with what the list shows (same rows, same order). "Handle 100,000-row exports as specified in A6" is checked by the other evaluator; you only confirm that the UI's export works on the demo data.
3. Take a screenshot of each state you report on (file names in your scratch directory).

Return one entry per requirement sentence of sections 2 and 3, and every finding.`

const scenarios = `You evaluate a take-home submission ("Multi-Tenant Certificate Admin Console") against section 4 of the official requirements: "Acceptance Scenarios" - the required demo data and the scenarios A1 to A7.
${common('scenarios', '3000 (the default; start the app exactly as the README says, and copy the README\'s commands verbatim)')}

The company writes: "Your README must explain how to reproduce each scenario" and "We will run our own checks against your API and UI." Do both, in this order:

Part 1 - the README's own reproduction steps. Start from the clean clone with the one documented command. For each scenario A1 to A7, follow the README's steps exactly as written (copy and paste the commands). Report every step that fails, prints something else than the README says, is ambiguous, needs knowledge the README does not give, or does not actually demonstrate what the "Expected" column of the scenario says.

Part 2 - your own checks, as the company would run them. Do not reuse the repository's tests. Design an independent check of each scenario's "Given" and "Expected" against the API (curl, or Node scripts in your scratch directory) and, where a scenario speaks of what is displayed, against the UI in a real browser. Treat the wording of "Expected" as the contract:
- Required demo data: the two tenants and their time zones; the two admins, each bound only to their own tenant; in both tenants a course titled "Safety 101" and a learner named "Alex Lee"; completed, incomplete and already certified enrollments; a command or script that generates 100,000 certificate rows for one tenant "without changing the default quick-start dataset" - establish what that means here and whether it holds (what does a fresh clone, or a reset, show before and after?).
- A1: Bob against East data through the list, detail, bulk issue and export endpoints: only West data is accessible; a cross-tenant detail request returns 404 or an equivalent non-revealing response (compare it with the response for an id that does not exist at all - can Bob tell the difference?); a cross-tenant bulk issue is rejected and creates no certificates and no audit events (count both before and after).
- A2: the same bulk request with the same idempotency key, sequentially and concurrently (for example twenty at once, more than once): one logical operation; each eligible learner receives at most one certificate; each actual issuance has exactly one audit event; all callers receive the outcome of the same logical operation; no additional certificates or audit events.
- A3: the same key with a different course, and with a different payload: 409; no second operation; the first result is not overwritten (replay the original request afterwards).
- A4: a course with completed, incomplete and already certified learners: issued only to eligible learners; incomplete and duplicate cases skipped with reasons.
- A5: an East certificate and a West certificate with the UTC timestamp 2026-01-10T13:30:00Z: East displays 2026-01-11 00:30, West displays 2026-01-10 21:30 (in the API and in the UI); list sorting and CSV use the tenant-local calendar date (find or create certificates around a local midnight and check the order and the CSV dates). How does an evaluator get certificates with exactly this timestamp - is that documented?
- A6: generate 100,000 East certificates with the documented command, including rows with equal values for the requested sort field; apply a search and a sort; run the export twice; during the first export request the certificate list. Each export completes within 60 seconds; the CSV contains exactly the matching East rows in the requested order (verify the set and the order independently, for example with your own query on the SQLite file or by paging through the list API); rows with equal sort keys appear in the same relative order in both exports (compare the two files byte for byte, and look at a stretch of equal keys); the list request succeeds while the export is running (measure when it was sent and answered relative to the export). Try more than one combination of search and sort, including a sort by the local issue date and one with many equal keys.
- A7: Alice revokes a valid certificate, then repeats the request: the first request changes the status and writes one revocation audit event; the repeat creates no duplicate audit event (also when the two requests are sent at the same moment).

Return one entry per demo-data bullet and per sentence of each scenario's "Expected" column, plus one entry per scenario for "the README explains how to reproduce it", and every finding.`

phase('Check')
const names = ['scope', 'scenarios']
const results = await parallel([scope, scenarios].map((prompt, i) => () =>
  agent(prompt, { label: `evaluate:${names[i]}`, phase: 'Check', schema: RESULT, model: '[REDACTED: model identifier B]' })))
const out = {}
results.forEach((r, i) => { out[names[i]] = r })
const verdicts = results.filter(Boolean).flatMap(r => (r.requirements || []).map(x => x.verdict))
const count = v => verdicts.filter(x => x === v).length
log(`requirements: ${verdicts.length} checked - met ${count('met')}, partly met ${count('partly met')}, not met ${count('not met')}, could not verify ${count('could not verify')}; findings: ${results.filter(Boolean).reduce((n, r) => n + (r.findings || []).length, 0)}`)
return out
