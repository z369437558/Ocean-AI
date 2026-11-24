# Decision log

All references are to the interactive session `61a877e9-483e-575a-b7cf-c5b8e94decb9`
([`sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl`](sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl));
"line N" is line N of that file, and the reading copy in [`sessions/readable/`](sessions/readable/README.md)
shows the same line numbers. Sub-agent sessions are named `<run>/agent-<id>` as in
[`session-index.csv`](session-index.csv). Commits are in this repository.

## Who decided what

The record shows a short list of inputs by the candidate and a long list of actions by the
assistant. This is everything the candidate typed:

| Line | Time (UTC) | What |
| --- | --- | --- |
| 3 | 11-23 07:07 | The task: the specification, "please do this for me" |
| 516 | 11-23 07:09 | The tool's `/model` command: a switch to the model called A in this export |
| 524, 2218, 2332, 4919 | | "How is it going?" (four times) |
| 554 | 11-23 10:13 | A request that has nothing to do with the assignment (see [`README.md`](README.md)) |
| 962, 3538, 5062 | | "Continue" (three times) |
| 5193 | 11-24 06:18 | The candidate's written answers, with the question what the assistant thinks of them (decision 7). Sent at 06:07 while the assistant was working (queue log, line 5073); delivered at 06:18 |
| 5202 | 11-24 06:27 | The list of deliverables of the submission |
| 5396 | 11-24 07:20 | The choice how the git history is to be made (decision 1) |
| 5406, 5409 | 11-24 07:20 | Create a repository under the candidate's GitHub account and push |
| 5410 | 11-24 07:21 | The official text of sections 2–5 of the assignment, with the requirements for this evidence (queued by the tool and delivered only at line 6972; see the completeness declaration) |
| 5422 | 11-24 07:22 | The assistant's offer to draft the submission e-mail for the candidate to send, pasted back (taken as a yes) |
| 5556 | 11-24 07:31 | The repository has been created |
| 6368 | 11-24 09:08 | Answers to the assistant's four questions: three about the completeness declaration, one about access to the repository (decisions 6 and 7) |
| 6372 | 11-24 09:08 | "Make it public for me" - the repository (queued by the tool and delivered only at line 6972; the assistant found it in the queue log at line 6587) |
| 6972 | 11-24 10:59 | The two queued messages of lines 5410 and 6372, delivered by the tool as one prompt |

Everything technical - the stack, the design, the code, the tests, the verification rounds, which
review findings to act on - was proposed and carried out by the assistant without a separate
approval step: the candidate's standing instruction was the specification and "continue". Those
decisions are marked **delegated** below. Where the candidate decided, the entry says so.

To say it plainly: in this session the candidate accepted one suggestion of the assistant
(decision 1), did not take up its suggestions for the written answers (decision 7), and decided
two points about this evidence (decision 6). The candidate did not reject or correct a technical
suggestion: the rejections and corrections of technical suggestions recorded here (decisions 3
and 4) were made by the assistant, on the findings of sub-agents it had started itself.

From line 531 on (11-23 10:04, after the first complete version had been delivered at line 513)
the session ran in a mode of the tool that makes the assistant use sub-agent workflows for
substantial work. The record shows the tool's notice of that mode, not how it was switched on.
The verification rounds listed here were started by the assistant in that mode; they are where
most of its own output was corrected.

## 1. Git history rebuilt from the copies kept during the work - an AI suggestion the candidate accepted

- **Situation.** The project was built in a directory that was not a git repository; the
  submission asks for a repository with its full history.
- **Suggestion (assistant, line 5384).** Two options: (a) rebuild the history from the real copies
  of the project kept during the work - the text named four of them: 11-23 17:03, 11-24 04:46,
  13:37 and the current state (times of the machine's clock, UTC+9) - as a few commits, each
  saying in its message that it is reconstructed; (b) one initial commit and a statement that the repository was created after the
  work. The assistant recommended (a) and wrote that a history cannot be made up after the fact.
- **Decision (candidate, line 5396).** Option (a), by pasting its text.
- **What was done - more than the option named.** When the assistant went through the scratch
  area it found seven complete states, not four (its note at line 5436), and used all of them:
  six reconstructed commits, `9c2d538`, `4a88be6`, `56ed60e`, `5f34d63`, `f615919`, `c706d93`,
  each with the time of its copy as author date and a "Reconstructed commit" paragraph in its
  message, and `22fe305`, the state at the moment the repository was created, as the first
  ordinary commit (lines 5453–5461). Using the three additional copies was the assistant's own
  extension of what the candidate had chosen; the candidate was told the result, seven commits,
  at line 5478.
- **Verification evidence.** Line 5432 compares the kept copies with the checksum manifests that
  had been written around the audit rounds: three copies - two of the seven states - match their
  manifest in each of its 47 files (the result is at line 5433; such a check would not notice an
  additional file). The
  copy behind `9c2d538` is the one that had been made for a clean-install check, as its commit
  message says. Line 5464 checks that the last commit equals the working tree; line 5474 scans
  every commit for private details. From `4a88be6` on, the README of each commit states the number
  of tests of its stage (77, then 105 in both `56ed60e` and `5f34d63`, 179 + 231, 190 + 252,
  191 + 253).
- **Commits.** `9c2d538` … `22fe305`.

## 2. SQLite with synchronous transactions and two interchangeable drivers - a design trade-off (delegated)

- **Decision (assistant, lines 30–46: line 30 by model B, the rest by model A; note at line 40).** Node.js with Express, SQLite as a file
  database in WAL mode, every write in one synchronous `BEGIN IMMEDIATE` transaction. The native
  module `better-sqlite3` is an optional dependency; where it cannot be installed the server falls
  back to the SQLite that is built into Node.js 22 and later. Before deciding, the assistant
  checked that the prebuilt binary installs (line 41) and that both drivers behave alike where the
  design depends on it (line 46).
- **What it buys.** A2, A3 and A7 become properties of one transaction: the idempotency lookup,
  the eligibility decision, the certificates, the audit events and the stored answer are written
  together or not at all, and a second server process on the same file waits for the lock. One
  command starts everything, with no database service - and also on a machine without a C
  toolchain.
- **What it costs.** A very large bulk issue holds every other request up while it runs, and two
  drivers have to be tested. The first is stated in the README under "Known defects" (section
  10), the second in its design notes (section 7).
- **How the cost was found and bounded.** The first version blocked much longer in one case: see
  decision 3. The 20,000-learner case was measured again by an independent sub-agent
  (`wf_36b67f7f-878/agent-abe3905e181b3630c`, "confirm:readme-claims"): four runs on a busy
  machine, 1.2 s, 1.2 s and 2.0 s, and 5.4 s once.
- **Verification evidence.** `backend/test/acceptance.test.js` › *A2 - retry safety /
  idempotency*, *A2 - while another process holds the database write lock*, *A3 - idempotency key
  misuse*, *A7 - revocation and its audit trail*. The last full run is at line 6288 (result at
  line 6292): the whole suite on Node 20, 22 and 24 with the default driver, and the API suite on
  Node 22 with the built-in driver as well.
- **Commits.** `9c2d538` (design), `56ed60e` (lock handling), `22fe305` (README section 10).

## 3. The assistant's first write path blocked the whole server on a busy lock - AI output corrected after an independent audit (delegated)

- **What the assistant had built (commit `9c2d538`).** A write that found the database locked by
  another process waited for the lock inside SQLite - synchronously, for up to ten seconds, during
  which the server answered nothing, not even a read.
- **How it was found.** The assistant delivered the first version with 77 passing tests
  (line 513) and then started nine independent auditors (line 545). The run was cut short by the
  usage limit after two of them had finished; the one on idempotency and concurrency
  (`wf_956299a7-a24/agent-a337b4fa5ceb8c52e`) reported this, with a reproduction. The findings
  are listed at lines 987–988.
- **Decision (assistant).** To change the write path: try for the lock without waiting, back off
  asynchronously between tries, answer `503 database_busy` with `Retry-After` when the limit is
  reached, and let reads and replays of finished operations through meanwhile (line 1094;
  reported to the candidate at line 1579).
- **Verification evidence.** New tests in the group *A2 - while another process holds the
  database write lock* of `backend/test/acceptance.test.js`; each fix was taken out again to see
  its test fail (line 1579 reports 26 such reversals); the second audit round re-examined the
  change (`wf_e4b5cf66-7b5`, "audit:concurrency-regression").
- **Commit.** `56ed60e`.

## 4. Review suggestions of which the first option was not followed - AI suggestions rejected or corrected (delegated; the candidate was told of the first)

Each of these reviewers proposed a change and named a lighter alternative - to document the
behaviour, or a smaller change. In all three cases the assistant took the alternative and gave
its reason.

- **A row click opens the certificate, so a double click cannot select a word.** Reviewing
  sub-agents asked for the drawer to open differently, or else for the limit to be documented
  (rounds 3 and 4, for example `wf_2de7e29c-a07/agent-a9864dcd129114bac`,
  "verify:frontend-browser"). The assistant kept the behaviour: making room for a double click
  means delaying every single click by about a quarter of a second. It told the candidate so and
  named the alternative - open the drawer from the serial-number link only (line 4927) - and
  listed the behaviour under "Known defects" (README section 10). Commit `22fe305`.
- **`exec node …` in the npm scripts**, so that a SIGTERM to `npm` reaches the server
  (`wf_36b67f7f-878/agent-ad7ea298544b06bf0`, "confirm:backend-tooling"; the suggestion was
  "use `exec` …, or document it"). The first half was not followed: the Windows command shell has
  no `exec`, and `npm start` - the one command the assignment asks for - would stop working
  there. The second half was: the behaviour is listed under "Known defects". Note at line 6100.
- **Refusing to start when `STATIC_DIR` has no built UI**, or at least naming the directory
  (`wf_36b67f7f-878/agent-abe3905e181b3630c`). The refusal was not followed: serving the API
  alone is how `npm run dev` and the test suite run the server. The start-up output now names the
  directory it looked in, and the page says what the setting has to be; one test covers both.

One more option was the assistant's own and was dropped by it: when a reviewer found read-only
left-over files next to a database that the server had refused (round 4,
`wf_2de7e29c-a07/agent-a5f34f5569acdc350`, "verify:backend-adversarial"; its suggestion, a check of
the permissions before the database is opened, was adopted in `22fe305`), deleting such a file
would have been the shortest way to make the database usable again. A write-ahead log can hold
committed data, so the server names the file and leaves it; the README (section 9) says to make
it writable.

- **Verification evidence.** `backend/test/acceptance.test.js` › *start-up and maintenance
  commands* › "a database file that cannot be written to is refused at start-up…" and "without a
  built UI the server says where it looked…"; the mutants for both are at line 5934. For
  `npm run dev`: the first sweep with timed signals found processes left behind (started at
  line 5946, read at line 6000); after the change, 124 timed signals left nothing behind (started
  at line 6089, result at line 6149).
- **Commits.** `22fe305`, `7ea0f6f`.

## 5. UI tests against recorded answers instead of browser tests in the repository - a scope trade-off (delegated)

- **Decision (assistant, line 1758; carried out by the sub-agents of run `wf_cf2a82ec-f18`).**
  The UI suite mounts the real application in a simulated DOM and answers its requests from
  responses recorded from the real backend. Browser checks were done with throw-away scripts in
  every verification round and are not part of the repository.
- **Why.** `npm test` has to run anywhere `npm start` runs, in about a minute, without
  downloading a browser. The cost: what only a real browser does - layout, the browser's own
  focus handling - is not covered by the suite.
- **How the cost showed.** Reviewing sub-agents with a real browser found focus defects the suite
  could not see (rounds 3 and 4, and the confirmation run: a press on the backdrop of the
  confirmation, `wf_36b67f7f-878/agent-a467330090aebbf78`). Each was fixed and pinned by a test of
  what the simulated DOM can observe (line 5847; the mutants are at line 5856). And when the
  assistant repeated those browser checks itself, from a copy of the project below a hidden
  directory, the page did not load at all: the server did not serve the built UI from such a path
  (lines 6272–6283). No test had ever asked the server for the page; one does now.
- **Stated in the README.** Section 10, "Unfinished work": *Browser tests in the repository*.
- **Verification evidence.** `frontend/test/detail-revoke.test.jsx` › *Dialogs are modal: only the
  top-most one can be operated* and *Revoke dialog: focus and layout*;
  `backend/test/acceptance.test.js` › "serves the built UI, also from a directory whose path has a
  hidden directory in it"; the browser probes after the fixes are at line 6283, the whole suite
  on Node 20, 22 and 24 at line 6288.
- **Commits.** `f615919` (the suite), `c706d93`, `22fe305`, `7ea0f6f`.

## 6. What goes into this evidence, and what is withheld (delegated; two points decided by the candidate)

- **Decision (assistant).** Export the tool's transcript files as they are and replace, entry by
  entry and with a reason, only what must not be published: the content of an unrelated request
  handled in the same session, personal and account details, binary data, the tool's own prompt
  material ([`README.md`](README.md) lists every rule). The review of the written answers (lines
  5193–5195) stays in the record unchanged.
- **Trade-off.** A narrower export would have been easier to read; a curated one would not be
  evidence. The price of the complete one is its size and the markers.
- **Decided by the candidate (lines 6368 and 6372).** To leave the letters that stand for model
  names as they are, and to make the repository public for the review.
- **Verification evidence.** Six sub-agents reviewed the export before it was committed (run
  `wf_ce880d66-b3c`: two looked for private material, one compared it with the tool's files line
  by line, one checked the statements of these documents, one read it as the evaluator would, one
  looked for what the others had missed). The text of their findings is withheld with the rest of
  their work - it describes the withheld material - but their number and severity are in the
  export (`sessions/subagents/README.md`); the rules
  and these documents were changed as their results came in (from line 6422 on), and three more sub-agents
  checked the rebuilt export (run `wf_64f4f895-96e`); after the changes that followed, three
  more read the result once more (run `wf_9ebd21af-0fe`: one against the tool's files, one given
  only the files to be published, one checking the facts stated here), and what they found was
  corrected as well (from line 7040 on). [`sessions/redaction-report.json`](sessions/redaction-report.json)
  counts the replacements.
- **Commit.** The one that adds this directory.

## 7. The written answers stay as the candidate wrote them - suggestions of the assistant that the candidate did not take up

- **Situation.** Section 6 of the assignment is to be answered without AI. The candidate pasted
  the finished answers into the session and asked what the assistant thought of them (line 5193).
- **Suggestions (assistant, line 5195).** A rating of each of the three answers and, for each, a
  list of points to add - five, six and five, one of them marked as optional - with an order of
  priority (the second answer first, then the first, then the third). The wording was left to the
  candidate.
- **Decision (candidate, line 6368).** Asked how the answers were to be submitted (the question
  and its three options are at line 6365: as pasted; revised by the candidate along the review;
  or declared as written with AI), the candidate chose to submit them as pasted. None of the
  suggested points was taken up.
- **What was done.** [`../written-answers.md`](../written-answers.md) holds the answers of the
  prompt at line 5193. The assistant made the file (line 6028) and added a title line, the
  heading marks before the three question titles and blank lines; nothing else.
- **Trade-off.** The answers go out with the weaknesses that the review names, and the review
  stays in the record. Working the review's points into them would have made the statement that
  section 6 was completed without AI untrue.
- **Verification evidence.** Line 6924 compares the file with the prompt at line 5193: apart from
  the additions named above, the text is the same character for character (result at line 6925).
- **Commit.** The one that adds this directory; it also adds `written-answers.md`.

## 8. The official wording of sections 2–4 arrived late: checked at the end, answered in the README (delegated)

- **Situation.** The application was built and verified against the specification in the first
  prompt (line 3). The candidate sent the assignment's own text of sections 2–5 at line 5410; the
  tool delivered it only at line 6972 (see the completeness declaration). Line 6984 compares the
  two texts: the same requirements, in different words.
- **Decision (assistant, line 7005).** Not to rely on that reading: to have the finished
  application checked against the official wording before it is published, by two sub-agents
  acting as the company's evaluators, each from a clean clone (run `wf_be7a6b64-0c4`) - one on
  sections 2 and 3, in a browser; one on the demo data and the scenarios A1–A7, first by the
  README's own steps, then by checks of its own.
- **Result (line 7105).** Of the 58 requirement sentences they judged, 53 are met. One was left by
  the first evaluator to the second, who found it met. Four are "partly met": all four concern
  how far the README lets a reader reproduce a scenario, none the behaviour of the application.
  Thirteen findings, three of them "minor", the rest "nit".
- **What was changed - the README only.** What the generator changes in the console and what it
  does not (section 4); a second case of key misuse in the steps for A3; the ordering rule of A5
  shown on the running app with the load-test rows; for A6, the number of exported rows against
  the list's total and a list request during an export that is certainly still open; the wording
  about unknown query parameters (section 5); two cosmetic findings added to the known defects
  (line 7213).
- **Trade-off.** The two cosmetic findings - the list's loading indicator covers a column
  heading; the hour that occurs twice at the end of daylight saving time looks the same in the
  list and the CSV - were recorded as known defects and not repaired: a change to the UI at this
  point would have needed a verification round of its own for something that does not touch the
  required behaviour. Not acted on: the fixed file names in `/tmp` that the README's steps use
  (a shell variable would be lost when a reader opens another terminal), the general wording of
  the reason of a failed outcome (internal errors are not shown to clients), and the time of day
  in the CSV's date column (it is the format scenario A5 gives).
- **Verification evidence.** The two results are in `sessions/subagents/wf_be7a6b64-0c4/run.json`.
  Line 7225 runs every step of the edited README section as written, from a clean clone started
  with the documented command; the output is at line 7226.
- **Commit.** The one that adds this directory; it carries the README changes.
