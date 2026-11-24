export const meta = {
  name: 'review-ai-evidence',
  description: 'Independent review of the staged ai/ evidence directory: privacy, fidelity of the export, facts in the documents, and compliance with section 5 of the assignment',
  phases: [
    { title: 'Review', detail: 'five reviewers, each with its own lens', model: '[REDACTED: model identifier B]' },
    { title: 'Critic', detail: 'what did nobody check?', model: '[REDACTED: model identifier B]' },
  ],
}

const S = '/tmp/claude-0/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9/scratchpad'
const X = `${S}/ai-export`
const STAGE = `${X}/out/ai`
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
          location: { type: 'string', description: 'file and line (and character offset where useful)' },
          description: { type: 'string', description: 'What is wrong. Never quote private text: describe it by kind, length and position.' },
          evidence: { type: 'string', description: 'How you established it (the command you ran, what it printed - without private text).' },
          suggestedFix: { type: 'string' },
        },
        required: ['title', 'severity', 'category', 'location', 'description', 'evidence'],
      },
    },
  },
  required: ['summary', 'checksPerformed', 'findings'],
}

const COMMON = `
You are an independent reviewer. A candidate has done a take-home assignment (a multi-tenant certificate admin console) with an AI coding assistant, and must hand in the evidence of that AI use. The evidence has been assembled in a staging directory and will be committed to the candidate's repository as "ai/" unless you find a reason not to. Nobody has reviewed it yet. Assume it has mistakes; your job is to find them.

Where things are
- Staged evidence (what would be published): ${STAGE}
  - README.md, decision-log.md, completeness-declaration.md, session-index.csv, tool-actions.csv
  - sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl  (the interactive session, exported; about 18 MB, one JSON object per line)
  - sessions/readable/  (reading copy of it, generated)
  - sessions/subagents/<run>/  (sub-agent sessions as .jsonl.gz, run.json, journal.jsonl, script.js) and sessions/subagents/README.md
  - sessions/tool-results/  (long tool outputs the sessions refer to), sessions/redaction-report.json
  - export/  (export_sessions.py, build_indexes.py, runs.json: the scripts that produced all this)
- The repository the evidence belongs to: ${REPO}  (git; "git log" shows 8 commits; README.md and written-answers.md are there)
- The requirements for this evidence, as given to the candidate: ${X}/section5.txt

Rules for you
- Read-only: do not change anything under ${STAGE}, ${REPO}, ${X} or ${NATIVE_DIR}. Put any file you write into your own directory, given below.
- The exported session contains markers of the form "[REDACTED: reason]". They replace private material. The private material itself must not appear anywhere in what you return: your result is stored and will be read by others. When you report a leak, give the file, the line, the kind of thing it is and its length - never the text itself. Do not print long stretches of files to your terminal without need.
- Use scripts (python3, jq, zcat, grep) for anything that has to cover a whole file; read samples to understand, measure to conclude. Say in "evidence" what you ran.
- This machine has no "ss" or "netstat". Do not chain "sleep" in front of other commands in one Bash call.
- Report only what you established yourself. If you could not check something, say so in the summary instead of guessing.
- Severity: "blocker" = must not be published / would mislead the reader of the evidence; "major" = a requirement of section5.txt is not met or a statement is false; "minor" = should be fixed; "nit" = polish.
`

const REVIEWS = [
  {
    key: 'privacy-main',
    prompt: `${COMMON}
Your lens: PRIVACY of the exported interactive session.

Your directory: ${S}/ai-review/privacy-main (create it).

[REDACTED: line that refers to the unrelated private request]

You may read the ORIGINAL transcript to learn what the private material looks like: ${NATIVE}  (same line numbers as the staged file). The exporter's private configuration is ${X}/private-config.json: "unrelated_ranges" and "unrelated_entries" are 0-based line indexes of the entries whose content is withheld (line number = index + 1), "private_keywords" is the pattern the line rule uses, "prep_start" is the index from which the preparation of this export begins.

What to do
1. Build your own picture of the private material from the original entries in the withheld ranges: names of companies, products, people and sites, file names, figures, phrases - in Chinese and English. Do NOT rely on the configured keyword pattern: the question is what it misses. Keep your term list in a file in your directory, not in your answer.
2. Search the staged session file (${MAIN}) and the reading copy (${STAGE}/sessions/readable/*.md) for every term, and for longer passages of the withheld entries (shared substrings of 12+ characters, shared sequences of 5+ Chinese characters). Count hits per term; for each hit decide whether it is a leak or an innocent use of an ordinary word.
3. Look at the neighbourhood of the markers "line that refers to the unrelated private request": is anything about the private request left right before or after a withheld line (a continuation, a list item, a sentence)?
4. Check the compaction summaries (entries with "isCompactSummary": true) and the assistant's status messages line by line: they restate earlier content.
5. Check the last part of the session (from index "prep_start" on), where the export itself was built and checked: commands and outputs there dealt with the private material. Is any of it left?
6. Search for: e-mail addresses other than the test addresses of the app (…@east.test, …@west.test and similar), noreply@anthropic.com and the reviewer's address in section5-related text; anything that looks like a real person's name, a phone number, a street address; UUID-like account identifiers; tokens, keys, passwords, URLs with credentials; model names (family names of the vendor's models, with or without version).
7. Tell me also where the export withholds MORE than it should: content about the assignment that is replaced by a marker without need (for example a status message about the console that lost lines). List locations and what kind of content it was.

Return findings as specified. No private text in the result.`,
  },
  {
    key: 'privacy-other-files',
    prompt: `${COMMON}
Your lens: PRIVACY of everything in the staging directory EXCEPT the main session file and its reading copy: sessions/subagents/** (decompress the .jsonl.gz files), sessions/tool-results/*, session-index.csv, tool-actions.csv, README.md, decision-log.md, completeness-declaration.md, sessions/redaction-report.json, export/*.

Your directory: ${S}/ai-review/privacy-other (create it).

[REDACTED: line that refers to the unrelated private request]

You may read the ORIGINAL files to learn what private material looks like: the original main transcript ${NATIVE} (the withheld entries are listed in ${X}/private-config.json as 0-based line indexes "unrelated_ranges" and "unrelated_entries"), and the original sub-agent files under ${NATIVE_DIR}/subagents/workflows/<run>/ . Two runs there, wf_34e04759-afc and wf_7ccfb441-20f, belong to the private request and must not be exported at all.

What to do
1. Confirm that the two private runs are absent from the staged files, also from session-index.csv, tool-actions.csv, sessions/subagents/README.md (they may be NAMED as not exported, nothing more).
2. Build your own list of private terms (from the original withheld entries and the two private runs): names, file names, phrases, figures, in Chinese and English. Keep the list in your directory, not in your answer. Search every staged file in your scope for them, including inside the compressed files, and for longer shared passages.
3. Sub-agents listed directories and read files on the same machine: look for traces of the private request's working directory and files in their command outputs (directory listings of /home/user, of the scratch area, process lists).
4. Search for e-mail addresses (the app's test addresses such as …@east.test are fine), account identifiers, anything that looks like credentials (tokens, keys, cookies, Authorization headers, URLs with user:password), environment dumps (/proc/*/environ, "env", "printenv" outputs) and look at what they printed.
5. Search for model names in every file of your scope (family names of the vendor's models with or without version, technical identifiers of the form vendor-family-number): metadata files (agent-*.meta.json, run.json, journal.jsonl), script.js, the CSV files, the documents and the export scripts.
6. Search for remains of the AI tool's own prompt material: long system-prompt-like texts, tool definition lists, skill texts.
7. Check that every file in export/ is free of private terms (the export scripts must be generic; private terms belong in a configuration file that is NOT in the staging directory).
8. Tell me also where the export withholds more than it should in these files.

Return findings as specified. No private text in the result.`,
  },
  {
    key: 'fidelity',
    prompt: `${COMMON}
Your lens: FIDELITY of the export. The documents claim that the staged session files are the AI tool's own transcript files, copied line by line and changed only where a stated rule applies (the table "What was replaced, and why" in ${STAGE}/README.md, implemented in ${STAGE}/export/export_sessions.py), and that the indexes and the reading copy are derived from the staged files alone. Check whether that is true.

Your directory: ${S}/ai-review/fidelity (create it).

Originals: main transcript ${NATIVE} ; sub-agent transcripts ${NATIVE_DIR}/subagents/workflows/<run>/agent-*.jsonl (+ .meta.json, journal.jsonl), run records ${NATIVE_DIR}/workflows/<run>.json, scripts ${NATIVE_DIR}/workflows/scripts/*<run>.js, long outputs ${NATIVE_DIR}/tool-results/ . The original main transcript is still growing (the session is running); the staged file ends at the line it had when it was exported, so compare the first N lines where N is the staged line count.
The exporter's private configuration (which entries are withheld, the private terms) is ${X}/private-config.json. IMPORTANT: the entries listed there as "unrelated_ranges" / "unrelated_entries" (0-based indexes) hold private material. Never print their content, and never print the original text of a line that the staged file shows as withheld; work with lengths, hashes and counts for those.

What to check
1. Line for line: same number of lines (up to N), same order, same "type", "uuid" and "timestamp" on every line. No line added, dropped or moved. The same for every sub-agent file (compare after decompressing).
2. Every difference between an original line and its staged line must be one of the documented replacements. Write a script that, for each differing line, removes the documented markers from the staged side and the corresponding material from the original side (or simply classifies the differing JSON leaves by the marker that replaced them) and reports any difference that is NOT explained by a marker: text silently changed, shortened, re-ordered, re-encoded, keys dropped. Report counts by reason and list every unexplained difference.
3. The candidate's own prompts must be word for word as typed. Find them all in the original (user entries whose content is a plain string, not tool notices; "queue-operation" entries with operation "enqueue" that are not task notifications; "queued_command" attachments) and compare with the staged text. One prompt at line 554 is kept as typed on purpose; one at line 5410 was queued and never delivered - is it there in full?
4. The assistant's messages about the assignment must be complete. For assistant "text" parts outside the withheld ranges, list every one that contains a marker, with the reason given and how many lines were replaced, and judge (from the original) whether the replaced lines were about the private request or about the assignment. Report content about the assignment that was withheld.
5. Tool calls and results outside the withheld ranges: how many results are withheld as a whole, by reason? For each reason, sample ten and judge (from the original, without printing private material) whether withholding the whole result was justified by what the rule says.
6. tool-actions.csv: does its number of rows equal the number of tool calls ("tool_use" parts) in all staged session files? Do line numbers, tools and time stamps of 30 random rows match the session files? session-index.csv: do started_at / ended_at equal the first and last time stamp of each file; does every export_file exist; is each sub-agent listed exactly once; are the two private runs absent?
7. The reading copy (sessions/readable/*.md): take 40 random blocks and compare them with the lines of the staged .jsonl they name: same text (up to the stated shortening)? Is every prompt of the candidate present in the reading copy, unshortened? Does it show anything that is NOT in the staged .jsonl?
8. Re-run the builder on a COPY of the staging directory in your own directory (python3 export/build_indexes.py --ai <copy> --runs <copy>/export/runs.json) and compare its output with the staged CSV files and reading copy: identical?
9. Check sessions/redaction-report.json against your own counts.

Return findings as specified. No private text in the result.`,
  },
  {
    key: 'factcheck',
    prompt: `${COMMON}
Your lens: FACTS. Check every factual statement in these staged documents against the staged session files and the git repository:
  ${STAGE}/decision-log.md
  ${STAGE}/README.md
  ${STAGE}/completeness-declaration.md   (its last section, "Confirmations by the candidate", is still a placeholder: ignore that one section)
  ${STAGE}/sessions/subagents/README.md and ${STAGE}/sessions/readable/README.md
  ${STAGE}/export/runs.json (the "purpose" texts and the commits named for each run)

Your directory: ${S}/ai-review/factcheck (create it).

How
- "line N" in the documents means line N of ${MAIN}. For EVERY line reference open that line (sed -n 'Np' file | jq .) and decide whether it says what the document claims: who is speaking (candidate, assistant, tool), what is said or done, at what time. A reference that points to a neighbouring line, to a withheld line, or to a line that does not support the claim is a finding. Chinese text in the session is to be read as it is (the candidate writes Chinese; the assistant answers in Chinese).
- For every sub-agent named ("<run>/agent-<id>", with a label): does that file exist, does its label match (sessions/subagents/<run>/journal.jsonl, agent-<id>.meta.json), and does that sub-agent's result (journal.jsonl / run.json) really contain the finding the document attributes to it?
- For every commit named: does it exist (git -C ${REPO} log), does its message and content match what the document says about it (for example: which commit introduced a behaviour, a test or a README section; the test counts quoted; "reconstructed" notes; author dates)?
- For every test, file, README section and command named: does it exist under that name in the repository at HEAD (${REPO}); does the test do what the document says?
- For every number: 40 sub-agent sessions, seven runs, which runs were cut short, which model letter ran which run (session-index.csv and the agent files), the lines of the model change, time stamps, counts of prompts ("four times", "three times"), sizes, percentages ("about 54 %"), the list of the candidate's prompts in "Who decided what" (is it complete? is every line number right? was anything the candidate said left out or misdescribed?).
- Statements about what the candidate did or decided are the most important ones: the documents must not credit the candidate with anything the session does not show, and must not hide anything it shows. Check each one against the candidate's actual prompts.
- Statements about cause and motive ("the assistant chose … because …") need a source in the session (a message, a note, a comment in a commit) - or they should be worded as the document's own explanation. Flag claims with no source.
- Check the internal consistency of the documents with each other and with session-index.csv.

Return one finding per wrong, unsupported or misleading statement, with the correct fact. No private text in the result.`,
  },
  {
    key: 'evaluator-section5',
    prompt: `${COMMON}
Your lens: you are the EVALUATOR at the company that set the assignment. You check the submission's AI evidence against your own requirements (${X}/section5.txt - read it first, every sentence) and you are strict: this section exists to see how the candidate works with AI and whether the record can be trusted.

Your directory: ${S}/ai-review/evaluator (create it).

Go through section5.txt requirement by requirement and decide for each one: met / partly met / not met, with what you looked at. In particular:
- "Submit every interactive AI session used from planning through final documentation, including rejected suggestions and unsuccessful runs. Do not substitute a curated prompt list or screenshots." Is the session export complete from the first prompt on? Are failed runs and rejected suggestions in it? Is anything curated?
- ai/sessions/: "Original native exports where available … Include user prompts, full assistant responses, tool calls, file edits, commands, errors, timestamps, and model identifiers when the tool records them." Check each of these in the staged session file with jq: are prompts, responses, tool calls, file edits (Write/Edit inputs), commands (Bash inputs), errors (is_error results) and time stamps there? Model identifiers are replaced by letters - read what README.md and completeness-declaration.md say about that and judge it as the evaluator: acceptable as it stands? what would you want to see instead?
- ai/session-index.csv: exactly the columns session_id, tool, model, started_at, ended_at, export_file, purpose, related_commits; one row per session; a consistent time zone; parseable as CSV (python csv module); export_file paths that exist relative to the repository root (the staging directory will be the repository's "ai/" directory); related_commits that exist in ${REPO} (git log). One commit is written as a placeholder for the commit that will add ai/ itself - note it, do not count it as an error unless it is handled badly.
- ai/decision-log.md: at least three material decisions - one AI suggestion accepted, one rejected or corrected, one scope or design trade-off - each linked to session ID, verification evidence and commit. Are the links concrete and do they resolve (spot-check five line references and three commits)? Is it honest about who decided? Would you accept decisions that the candidate delegated to the assistant?
- Tool action evidence: are agent commands and edits in the native export; is tool-actions.csv a usable chronological export? "Keep AGENTS.md and similar files in git": what does the submission say about instruction files, and is it true (look for such files in ${REPO} and its history)?
- Completeness declaration: every tool listed? every export limitation? inline autocomplete addressed? "Confirm that Section 6 was completed without AI": the confirmations section is still a placeholder that the candidate will fill in - but look at the session yourself: the candidate pasted the written answers into the session and asked the assistant to review them (around line 5193), and the assistant answered (line 5195). Compare ${REPO}/written-answers.md with the text the candidate pasted at line 5193: identical in wording? State exactly what an honest confirmation can and cannot say given this record.
- "Remove credentials and private third-party data … Use narrow [REDACTED: reason] replacements without changing the interaction's substance." Count the markers by reason (sessions/redaction-report.json and your own grep). Are the replacements narrow enough? Is there any place where the substance of the interaction about the assignment is lost? Is the large withheld block (lines 555-1068, another request in the same session) explained well enough to be acceptable?
- "Large binary files and dependency caches are not AI interaction evidence": sizes of the staged files; anything binary or bloated?
- Usability: can you, as evaluator, actually follow the work? Open sessions/readable/README.md and two parts; follow one decision from the decision log into the session; try the jq commands of README.md (run them exactly as written from a directory where "ai" is a symlink to the staging directory). Report every command, link or path that does not work.
- Also check the top-level README of the repository (${REPO}/README.md) for the pointers to ai/ and written-answers.md and for the other deliverables the assignment lists in section5.txt (one-command startup, actor header, A1-A7 reproduction steps, 100,000-row generation, known defects, unfinished work): present and findable?

Finish the summary with your verdict as evaluator: what would count against the candidate as it stands, in order of weight.

Return findings as specified. No private text in the result.`,
  },
]

phase('Review')
const results = await parallel(REVIEWS.map((r) => () =>
  agent(r.prompt, { label: `review:${r.key}`, phase: 'Review', schema: RESULT, model: '[REDACTED: model identifier B]' })
    .then((value) => ({ area: r.key, ...value }))))
const done = results.filter(Boolean)
const missing = REVIEWS.map((r) => r.key).filter((key) => !done.some((d) => d.area === key))
log(`reviews returned: ${done.length} of ${REVIEWS.length}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`)

phase('Critic')
const digest = done.map((d) => `## ${d.area}\n${d.summary}\n\nChecks: ${d.checksPerformed.join(' | ').slice(0, 3000)}\n\nFindings:\n${d.findings.map((f) => `- [${f.severity}] ${f.title} (${f.location})`).join('\n')}`).join('\n\n')
const critic = await agent(`${COMMON}
Your lens: the CRITIC. Five reviewers have looked at the staged evidence (privacy of the main session, privacy of the other files, fidelity of the export, facts in the documents, the evaluator's view). Their summaries and finding titles are below. Your job is what they did NOT do.

Your directory: ${S}/ai-review/critic (create it).

1. Read their summaries and list what none of them checked or what they checked only by sampling. Then check the three most important gaps yourself.
2. Pick the five findings that matter most and try to REFUTE each one: reproduce it from the files; if it does not hold, say so with evidence.
3. Look for contradictions between reviewers.
4. Independent of them, do these checks yourself:
   - Is there any file in ${STAGE} that is not mentioned in ${STAGE}/README.md, or any path mentioned there that does not exist?
   - Does ${STAGE}/export/ contain everything needed to understand how the export was made, and nothing private? (The private configuration must not be there.)
   - Decompress three random sub-agent files and read the first prompt and the final result of each: do they match what sessions/subagents/README.md says about them?
   - Open the staged session file at ten random lines between 1 and 5000 and at ten random lines after 5200 and read them: anything that should not be published? anything that looks edited rather than replaced by a marker?
   - Total size and number of files of the staging directory; the five largest files.

Reviewer results:

${digest}

Return findings as specified (only your own, new or refuting ones). No private text in the result.`, { label: 'critic:completeness', phase: 'Critic', schema: RESULT, model: '[REDACTED: model identifier B]' })

return { reviews: done, missing, critic }
