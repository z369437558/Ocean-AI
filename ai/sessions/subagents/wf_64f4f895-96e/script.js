export const meta = {
  name: 'confirm-ai-evidence',
  description: 'Second independent review of the rebuilt ai/ evidence directory after the fixes: privacy, fidelity and facts',
  phases: [
    { title: 'Confirm', detail: 'three reviewers on the rebuilt directory', model: '[REDACTED: model identifier B]' },
  ],
}

const S = '/tmp/claude-0/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9/scratchpad'
const X = `${S}/ai-export`
const STAGE = `${X}/out2/ai`
const NATIVE = '/root/.claude/projects/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl'
const NATIVE_DIR = '/root/.claude/projects/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9'
const REPO = '/home/user/cert-admin-console'
const MAIN = `${STAGE}/sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl`

const RESULT = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What you checked, what holds and what does not, in plain words. No private text.' },
    checksPerformed: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          category: { type: 'string' },
          location: { type: 'string' },
          description: { type: 'string', description: 'What is wrong. Never quote private text: describe it by kind, length and position.' },
          evidence: { type: 'string' },
          suggestedFix: { type: 'string' },
        },
        required: ['title', 'severity', 'category', 'location', 'description', 'evidence'],
      },
    },
  },
  required: ['summary', 'checksPerformed', 'findings'],
}

const COMMON = `
You are an independent reviewer. A candidate has done a take-home assignment (a multi-tenant certificate admin console) with an AI coding assistant and must hand in the evidence of that AI use. The evidence directory has been rebuilt after a first review found problems. It will be committed to the candidate's repository as "ai/", and the repository will be made PUBLIC. You are the last check before that. Assume the rebuild has mistakes; find them.

Where things are
- Staged evidence (what would be published): ${STAGE}
  - README.md, decision-log.md, completeness-declaration.md, session-index.csv, tool-actions.csv
  - sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl  (the interactive session, exported; about 18 MB, one JSON object per line)
  - sessions/readable/ (reading copy, generated), sessions/subagents/<run>/ (sub-agent sessions as .jsonl.gz, meta.json, run.json, journal.jsonl, script.js), sessions/tool-results/, sessions/redaction-report.json
  - export/ (export_sessions.py, build_indexes.py, runs.json)
- The repository: ${REPO} (git; README.md and written-answers.md are there; "git log" shows the commits)
- The requirements for this evidence: ${X}/section5.txt
- The first review's findings (five reviewers and a critic), for reference: the "result" lines of ${NATIVE_DIR}/subagents/workflows/wf_ce880d66-b3c/journal.jsonl

Rules for you
- Read-only: do not change anything under ${STAGE}, ${REPO}, ${X} or ${NATIVE_DIR}. Put any file you write into your own directory, given below. Do not import Python modules from the staging directory (copy them first), so that no cache files appear there.
- The exported files contain markers "[REDACTED: reason]" in place of private material. The private material itself must not appear anywhere in what you return, and you should not print it to your terminal either: work with counts, lengths, hashes and positions. When you report a leak, give file, line, kind and length - never the text.
- Use scripts for anything that has to cover a whole file. Say in "evidence" what you ran.
- This machine has no "ss" or "netstat". Do not chain "sleep" in front of other commands in one Bash call.
- Report only what you established yourself. Severity: "blocker" = must not be published as it is; "major" = a requirement is not met or a statement is false; "minor" = should be fixed; "nit" = polish.
`

const REVIEWS = [
  {
    key: 'privacy',
    prompt: `${COMMON}
Your lens: PRIVACY of everything in the staging directory, now that it will be public.

Your directory: ${S}/ai-review2/privacy (create it).

[REDACTED: text shown while this export was prepared that repeats words of the unrelated private request]

[REDACTED: text shown while this export was prepared that repeats words of the unrelated private request]

What to do
1. Run every pattern of the private configuration over every staged file (decompress the .gz files): any hit outside the two deliberate places (the candidate's request at lines 552 and 554 of the session file and its copy in the reading copy; the run ids wf_34e04759-afc / wf_7ccfb441-20f where the documents name them as not exported) is a finding.
2. Do NOT stop at the configured patterns - the question is what they miss. Build your own term list from the original withheld entries and the two private runs (names of companies, products, people, sites; file and directory names; figures; distinctive phrases in Chinese and English; ids) and search every staged file for them and for longer shared passages. Keep the list in your directory.
3. Look at what is left next to the markers: the neighbourhood of every "line that refers to the unrelated private request" marker in assistant messages, notes and summaries (is a sentence about the private request left before or after it?), and the entries from "prep_start" on (commands and outputs that dealt with the private material while the export was built: lines of commands, the "toolUseResult" objects next to tool results, long outputs).
4. The first review run (sessions/subagents/wf_ce880d66-b3c/) handled private material. Check its exported agent files, run.json, journal.jsonl and script.js especially carefully: is anything private left in prompts, results, or anywhere else?
5. Search for e-mail addresses (only …@east.test / …@west.test style test addresses and noreply@anthropic.com are expected), person names that are not seed data of the app, account identifiers, tokens/keys/passwords, URLs with credentials, model names.
6. Vendor material: is any system-prompt-like text, tool definition list or reminder text of the AI tool left ("rendered" fields of attachments, results of tool-search or documentation tools, skill texts)?
7. Over-withholding, measured: for the markers "line that refers …", "text shown while this export was prepared …" and "tool output that shows material …", compare with the original and report how many replaced lines / results contain nothing private by your own judgement (counts, and up to ten locations of the worst cases).

Return findings as specified. No private text in the result.`,
  },
  {
    key: 'fidelity',
    prompt: `${COMMON}
Your lens: FIDELITY of the rebuilt export, and of what is generated from it.

Your directory: ${S}/ai-review2/fidelity (create it).

Originals: main transcript ${NATIVE} (still growing: compare the first N lines, N = staged line count); sub-agent transcripts ${NATIVE_DIR}/subagents/workflows/<run>/agent-*.jsonl (+ .meta.json, journal.jsonl), run records ${NATIVE_DIR}/workflows/<run>.json. The exporter's private configuration is ${X}/private-config.json. The entries listed there as "unrelated_ranges" / "unrelated_entries" (0-based) hold private material: never print their content, nor the original text behind any marker; work with lengths, hashes and counts.

What to check
1. Line for line: same number of lines (up to N), same order, same "type", "uuid" and "timestamp" on every line, for the main file and every sub-agent file. No line added, dropped or moved.
2. Every difference between an original line and its staged line must be explained by a "[REDACTED: …]" marker: split differing strings at the markers and check that the text outside markers equals the original text in order. Report counts by reason and list every unexplained difference (text silently changed, shortened, keys renamed or dropped). Where whole objects are replaced by {type, redacted}, check that README.md says so.
3. Everything the candidate typed must be word for word as typed, except for the documented replacements of names (the README lists them: the reviewer's address and name, the company's name, the candidate's own address). List every candidate entry (user string prompts that are not tool notices, "queued_command" attachments, the queue entry at line 5410, the command at line 516, the answers at line 6368) with what was replaced in it, if anything.
4. The assistant's messages about the assignment must be readable. For every assistant "text" and "thinking" part outside the withheld line ranges that contains a marker, judge from the original whether what was replaced was about the private request or about the assignment (counts; list the cases where assignment content was lost, with line and how much).
5. Whole tool results that are withheld outside the withheld line ranges: count by reason, and for each reason judge (sample ten, from the original, without printing private material) whether the rule's condition was really met.
6. The sub-agent sessions of run wf_ce880d66-b3c are exported with their working steps withheld. Check that their task (the first user entries) and their result (the StructuredOutput call, journal.jsonl, run.json) are present and equal to the originals outside markers.
7. tool-actions.csv: rows = number of tool calls in all staged session files? session-index.csv: columns exactly session_id, tool, model, started_at, ended_at, export_file, purpose, related_commits; one row per session (53 expected: 1 + 46 exported sub-agents + 6 not exported); times equal first/last time stamps of each file; every export_file that names a file exists (relative to the repository root, where the staging directory becomes "ai/"); related commits exist in ${REPO} (one cell names the commit that will add ai/ itself - check how that is written).
8. The reading copy (sessions/readable/*.md): 40 random blocks against the staged .jsonl; are the withheld line ranges folded into notes that match sessions/redaction-report.json; is every candidate entry present and unshortened and labelled as the candidate's; is anything shown that is NOT in the staged .jsonl?
9. Re-run the builder on a COPY of the staging directory in your own directory (python3 <copy>/export/build_indexes.py --ai <copy> --runs <copy>/export/runs.json) and compare with the staged CSV files and reading copy: identical?
10. sessions/redaction-report.json: do its line counts add up to the number of lines, and do its line ranges equal the entries that are actually withheld?

Return findings as specified. No private text in the result.`,
  },
  {
    key: 'factcheck',
    prompt: `${COMMON}
Your lens: FACTS and REQUIREMENTS. The three documents were rewritten after the first review. Check every factual statement in them again, and then judge the whole as the evaluator of the assignment would.

Your directory: ${S}/ai-review2/factcheck (create it).

Documents: ${STAGE}/decision-log.md, ${STAGE}/README.md, ${STAGE}/completeness-declaration.md, ${STAGE}/sessions/subagents/README.md, ${STAGE}/sessions/readable/README.md, ${STAGE}/export/runs.json; and in the repository ${REPO}/README.md (its pointers to ai/ and written-answers.md) and ${REPO}/written-answers.md.

Part 1 - facts
- "line N" means line N of ${MAIN}. For EVERY line reference in the documents open that line (sed -n 'Np' file | jq .) and decide whether it supports the claim: who speaks (candidate, assistant, tool), what is said or done, when. The table "everything the candidate typed" in decision-log.md must be complete and right: rebuild the list of the candidate's inputs yourself from the session file (user string entries that are not tool notices or task notifications, "queued_command" attachments that are not task notifications, queue entries that were never delivered, commands typed into the tool, answers to the assistant's questions) and compare. Task notifications ("<task-notification>…", origin "task-notification") are NOT candidate inputs.
- Every sub-agent named ("<run>/agent-<id>" with a label): exists, label matches, and its result contains what the document attributes to it.
- Every commit named: exists in git log of ${REPO}; message, dates and content match what is said (the commit that adds ai/ does not exist yet and is described in words).
- Every test, file, README section and command named exists under that name at HEAD and does what is said.
- Every number: sessions and runs (how many exported, how many not), model letters per run (session-index.csv), time stamps, the percentage of identical lines (sessions/redaction-report.json), line ranges of the withheld entries (compare README.md with redaction-report.json), "from line 5200 on", sizes.
- The jq and sed commands in README.md: run them exactly as written from a directory in which "ai" is a symlink to the staging directory. Do they work, and do they print what the comments say?
- Every relative link in the Markdown files resolves (as it will inside the repository, where the staging directory is "ai/").
- Statements about what the candidate did, decided or confirmed are the most important ones. The section "Confirmations by the candidate" cites line 6368: open lines 6365-6368 and check that each confirmation in the document is really in the candidate's answers there, no more and no less. Compare ${REPO}/written-answers.md with the answer text at line 5193 (word-level): identical in wording?
- Statements about cause and motive need a source in the session or must be worded as the document's own explanation.

Part 2 - the evaluator's view (read ${X}/section5.txt first, every sentence)
Go through section5.txt requirement by requirement: met / partly met / not met for this final state, with what you looked at. In particular: are prompts, full assistant responses, tool calls, file edits, commands, errors and time stamps in the session file; is the session-index what was asked; does the decision log give at least one accepted suggestion, one rejected or corrected one and one scope or design trade-off, each linked to session, evidence and commit, and is it honest about who decided; is the completeness declaration complete (every tool, every limitation, autocomplete, Section 6) and consistent with the record; are the replacements narrow and explained. Model identifiers are replaced by letters: read what the documents say about it and say how you would weigh it. End the summary with what would still count against the candidate, in order of weight, and separately with anything that is FALSE or MISLEADING in the documents as they stand.

Return one finding per wrong, unsupported or misleading statement or unmet requirement, with the correct fact. No private text in the result.`,
  },
]

phase('Confirm')
const results = await parallel(REVIEWS.map((r) => () =>
  agent(r.prompt, { label: `confirm:${r.key}`, phase: 'Confirm', schema: RESULT, model: '[REDACTED: model identifier B]' })
    .then((value) => ({ area: r.key, ...value }))))
const done = results.filter(Boolean)
const missing = REVIEWS.map((r) => r.key).filter((key) => !done.some((d) => d.area === key))
log(`reviews returned: ${done.length} of ${REVIEWS.length}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`)
return { reviews: done, missing }
