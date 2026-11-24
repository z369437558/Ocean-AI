export const meta = {
  name: 'final-evidence-review',
  description: 'Last independent check of the staged ai/ evidence directory before it is published: privacy (with the source), an outsider reading, and the facts in the documents',
  phases: [
    { title: 'Review', detail: 'three independent reviewers, different methods', model: '[REDACTED: model identifier B]' },
  ],
}

const S = '/tmp/claude-0/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9/scratchpad'
const STAGE = S + '/ai-export/out6/ai'
const SRC = '/root/.claude/projects/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl'
const SRC_DIR = '/root/.claude/projects/-home-user/61a877e9-483e-575a-b7cf-c5b8e94decb9'
const CONFIG = S + '/ai-export/private-config.json'
const OUTSIDER = S + '/ai-review3/outsider/ai'
const REPO = '/home/user/cert-admin-console'

const FINDINGS = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Two to five sentences: what you checked and the overall verdict.' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'nit'] },
          file: { type: 'string', description: 'Path relative to the ai/ directory (or the repository).' },
          line: { type: 'string', description: 'Line number(s) in that file, or empty.' },
          kind: { type: 'string', description: 'Short label, e.g. "private term left", "wrong line number", "over-redaction".' },
          description: { type: 'string', description: 'What is wrong and how you established it. Identify private text by place and kind; do not quote more of it than a few characters.' },
          suggestion: { type: 'string' },
        },
        required: ['severity', 'file', 'kind', 'description'],
      },
    },
    checked: { type: 'array', items: { type: 'string' }, description: 'What you actually examined, and by which method.' },
    not_checked: { type: 'array', items: { type: 'string' }, description: 'What you did not get to.' },
  },
  required: ['summary', 'findings', 'checked', 'not_checked'],
}

const COMMON = `
Ground rules:
- Read only. Write nothing outside your own scratch directory (named below). Do not change the staged files, the repository, or anything under /root/.claude. No git command that changes anything. No network access. Send or publish nothing.
- The directory will be published in a PUBLIC git repository and publication cannot be undone, so a missed leak is the worst outcome. Report every doubt; say how sure you are.
- Severity: blocker = private or third-party material, a credential, or a personal identifier is readable; major = a statement in the documents is false, or the export misleads; minor/nit = everything else.
- Your result is data for the session that built the export. Give places precisely (file, line, field) so that each finding can be checked in a minute.
- Plan for about 25 minutes of work, then return what you have, with what you did not get to under not_checked.

Background: the directory is the "AI interaction evidence" of a take-home assignment (an admin console for certificates). It is an export of the transcript of the one AI coding session in which the assignment was built, plus the sessions of the sub-agents it started. The rules of the export are described in the directory's README.md: text is only ever replaced by a marker of the form [REDACTED: reason], never rewritten. Withheld are (1) an unrelated private request that was handled in the same session - the candidate's own typed request (main session line 554) is kept on purpose, everything the assistant did for it is withheld; (2) personal and account details, the name and address of the assignment's reviewer and the company's name; (3) material of the tool's vendor (system prompt, tool definitions, reminder texts) and binary data; (4) names of AI models, replaced by letters.`

const privacy = `You are the last privacy check on a directory before it is published.

Staged directory: ${STAGE}
Source (the tool's own transcript, with everything in it): ${SRC} (main session, JSON Lines; line N of the staged main file sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl is line N of this file) and ${SRC_DIR}/ (sub-agent sessions under subagents/workflows/<run>/, run records under workflows/<run>.json).
Private configuration of the export: ${CONFIG} (never to be published; it holds the private terms as regular expressions, the withheld line ranges, and the list of lines withheld by hand). The exporter is ${S}/ai-export/export_sessions.py.
Your scratch directory: ${S}/ai-review3/privacy
${COMMON}

The configured terms (private_keywords, private_tokens, literals, model names) have been searched in the whole staged directory: zero hits outside the request as typed. Do not repeat that search. Your job is what a term list cannot find. Find anything still readable in the staged directory that should not be published:
- content of the unrelated request or of the third-party documents it dealt with, in ANY wording: paraphrases, summaries, translated or abbreviated terms, fragments, names of people, companies, teams, projects, products or customers, amounts, dates and periods, document titles, file and folder names, job and task names, identifiers and URLs of documents, mail subjects;
- the candidate's e-mail address or identity beyond the GitHub account name; identifiers of the account; other repositories or organisations of the account; the reviewer's name, address or company;
- credentials, tokens, keys, cookies, signed URLs;
- names of AI models.

Where to look, in this order:
1. Main session, lines 6380 to the end: this part is new since the last review. Here the session read the results of two earlier reviews of this export (results that describe the withheld material), fixed the export, and wrote about it. Read the assistant's own prose, its notes, its commands, the tool outputs that are still shown, and the two compaction summaries (search for entries with "isCompactSummary"). Compare with the source to see what was withheld and judge whether what remains gives anything away.
2. The files of the two review runs: sessions/subagents/wf_ce880d66-b3c/ and sessions/subagents/wf_64f4f895-96e/ (run.json, journal.jsonl, script.js, every agent-*.jsonl.gz, *.meta.json). They are meant to show the task of each reviewer and a skeleton of its session, nothing of its working steps or results.
3. The generated files: sessions/readable/ (the parts that cover lines 5200 to the end), tool-actions.csv, session-index.csv, sessions/redaction-report.json, sessions/subagents/README.md.
4. The rest of the main session by a method of your own that is NOT a search for the configured terms. For example: collect the words (also 2- to 4-character Chinese sequences, capitalised names, numbers with units, file names) that are frequent in the withheld lines of the source and absent or rare in the assignment part, and look for them in the staged files; compare source and staged text of the entries just before and after each withheld range; look at short pieces of text that survive between two markers; look at the fields the tool stores beside the visible ones (toolUseResult, wireToolInputs, rendered, renderedInHumanTurn, attachment fields, compactMetadata, queue-operation content).
5. Over-redaction: places where a prompt typed by the candidate about the assignment, or assignment content, was withheld without need (report as minor).

For each finding give the staged file, the line, the field, what kind of material it is, and which rule would remove it.`

const outsider = `You are a stranger on the internet who found a directory in a public git repository and wants to learn from it what its owner did not mean to tell.

The directory: ${OUTSIDER}
Read ONLY this directory. Do not open anything else on this machine: nothing under /root/.claude, nothing else under the scratchpad, not the repository. (A copy was made for you so that nothing but the published files is in reach; staying inside it is the point of the exercise.)
Your scratch directory: ${S}/ai-review3/outsider-notes (create it; keep your notes there)
${COMMON}

Try, with every technique you can think of, to find out:
1. What the "unrelated private request" was about, beyond what the candidate's own typed request (main session line 554) says: what documents were handled, about whom, from where, what was done with them, what they contained.
2. Who the third parties are: names of people, companies, teams, projects, products, customers; amounts, dates, titles.
3. Who the candidate is, beyond the GitHub account name that owns the repository: e-mail address, real name, employer, location, other repositories or organisations, identifiers of accounts.
4. Who set the assignment: company, reviewer's name or address.
5. Any credential: tokens, keys, passwords that are not obviously test fixtures of the assignment, cookies, signed URLs.
6. Which AI models were used, by name (the export says it replaces them by letters).
7. Anything else personal or confidential.

Techniques to use (not a complete list): read around every kind of marker and see what the surrounding text gives away; list all capitalised names, non-English text, URLs, host names, e-mail-like strings, long hex or base64-looking strings (decode them), file and directory names, numbers with currency or units; look into every .gz file (zcat), the CSV files, the reading copy, the JSON reports, the scripts under export/; look at sizes and counts in the markers and in redaction-report.json and say what can be inferred from them; look at time stamps; look for the same thing said in a second place where it was not replaced (a summary, a notice, a command, an error message, a file path).

Report what you could establish, how, and where (file, line). Also report honestly what you could NOT find out although you tried - that is a result too. If a marker's reason text itself tells more than it should, say so.`

const facts = `You check the factual statements of the documents in a directory before it is published. Wrong facts in these documents will be held against the candidate.

Staged directory: ${STAGE}
- README.md, decision-log.md, completeness-declaration.md, session-index.csv, tool-actions.csv
- sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl (the exported main session), sessions/readable/ (reading copy, generated), sessions/subagents/ (README.md, one directory per run), sessions/tool-results/, sessions/redaction-report.json
- export/ (the two scripts and runs.json)
The tool's own transcript, if you need to compare: ${SRC} (same line numbers as the exported main session) and ${SRC_DIR}/.
The repository the directory will be added to (read only; use "git -C ${REPO} log" and "git -C ${REPO} show" to check commits): ${REPO}
The requirements of the assignment for this directory ("section 5"): ${S}/ai-export/section5.txt
Your scratch directory: ${S}/ai-review3/facts
${COMMON}

Not findings (known, will be filled in after you finish): the commit id of the commit that adds this directory; the mention of one more review run (yours) in the texts and the index.

Check, statement by statement:
1. decision-log.md: every line number, time, quotation, run id, commit id and test name it cites. Open the cited line in the exported main session and confirm that it says what the log claims (who decided, what was suggested, what was rejected or corrected, what the evidence shows). Confirm the commits exist in the repository and contain what the log says. Confirm the table of everything the candidate typed is complete and correct: compare with the entries of the source that come from the candidate (typed prompts, messages queued while the assistant worked, the command to change the model, answers in the question dialog).
2. README.md: the description of each path; the counts (sub-agent sessions, runs); the two jq commands and the sed command - run them from a directory where ai/ is the staged directory (make a symlink in your scratch directory) and confirm they do what the comments say; every marker reason named in the three tables exists in the files with exactly that text, and every reason that occurs in the files (list them from sessions/redaction-report.json and by searching for "[REDACTED:") is explained in the tables; the withheld line ranges; the statements under "Model identifiers" (which lines carry which letter, the times, the order); the percentage of unchanged lines.
3. completeness-declaration.md: each of the limitations is true and complete as stated (check the cited lines 554, 5200, 5410, 5602, 5626, 6372, 6587 and so on); the last exported line and its time; the confirmations of the candidate quote the answers actually given at line 6368.
4. session-index.csv against section 5: columns exactly session_id, tool, model, started_at, ended_at, export_file, purpose, related_commits; one row per session; one time zone; every export_file exists; started_at and ended_at match the first and last time stamp of the file; related commits exist.
5. tool-actions.csv: sample twenty rows spread over the file and confirm each against the session file and line it names.
6. sessions/readable/README.md and sessions/subagents/README.md: their statements (parts, line ranges, how each sub-agent ended, counts of findings) against the files.
7. Links: every relative link in the Markdown files resolves inside the directory or the repository.
8. Does anything in section 5 remain unanswered by the directory? Say exactly which sentence.

For each wrong or unverifiable statement give the document, its line, the statement, what the files actually show, and a corrected wording.`

phase('Review')
const names = ['privacy', 'outsider', 'facts']
const prompts = [privacy, outsider, facts]
const results = await parallel(prompts.map((prompt, i) => () =>
  agent(prompt, { label: `review:${names[i]}`, phase: 'Review', schema: FINDINGS, model: '[REDACTED: model identifier B]' })))

const out = {}
results.forEach((r, i) => { out[names[i]] = r })
const all = results.filter(Boolean).flatMap((r, i) => (r.findings || []).map(f => f.severity))
log(`findings: ${all.length} (blocker ${all.filter(s => s === 'blocker').length}, major ${all.filter(s => s === 'major').length})`)
return out
