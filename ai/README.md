# AI interaction evidence

This directory documents how AI was used for this assignment.

One AI tool was used: **Claude Code** (Anthropic), as a cloud session at claude.ai/code (the
candidate confirms this in the [completeness declaration](completeness-declaration.md)).
Everything - planning, code, tests, verification, the README, the git history and this evidence -
happened in **one interactive session**. For the assignment that session started
**54 sub-agent sessions**, in eleven runs: to have its work checked by sessions that had not written
it, in one run to rework the UI, in three runs to review this evidence, and in one run to check the
finished application against the official wording of the requirements. (Six more sub-agent
sessions, in two runs, belong to an unrelated request and are not exported; see below. Two more
checked the newest part of this export after its last line; the completeness declaration names
them.)

| Path | What it is |
| --- | --- |
| [`sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl`](sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl) | The interactive session: the tool's own transcript file, JSON Lines, one entry per line - prompts, assistant messages, tool calls with their inputs (commands, file edits), tool results and errors, each with its time. Changed only where the table of replacements below says so. |
| [`sessions/readable/`](sessions/readable/README.md) | The same session as text for reading, in parts. Generated from the `.jsonl`; long tool inputs and outputs are shortened there. |
| [`sessions/subagents/`](sessions/subagents/README.md) | The sub-agent sessions: one compressed JSON Lines file each (`zcat agent-<id>.jsonl.gz`) with the tool's note on it (`agent-<id>.meta.json`), plus, per run, the tool's record of the run with every returned result (`run.json`), its journal and the script the main session wrote for it (`script.js`). The README there says what each run was for and how each sub-agent ended. |
| [`sessions/tool-results/`](sessions/tool-results/) | Tool outputs that were too long for the transcript: the tool keeps them in files of their own, and the sessions name them. (Copied for everything up to line 5200 and for the sub-agents; the long outputs of the commands that prepared this export are not.) |
| [`sessions/redaction-report.json`](sessions/redaction-report.json) | How many replacements were made, by reason, and which lines of the interactive session are withheld. |
| [`session-index.csv`](session-index.csv) | One row per session: `session_id, tool, model, started_at, ended_at, export_file, purpose, related_commits`. All times are UTC. For the interactive session `ended_at` is the time of its last exported line (the completeness declaration says what follows it). The eight sessions that are not exported - six of the unrelated request, two that began after the last exported line - have a row each, without a file. |
| [`tool-actions.csv`](tool-actions.csv) | Tool action evidence: every tool call of every session in the order of the clock - the command that was run or the file that was edited, by which session, with what result - with the line of the session file that holds it. Generated from the session files. |
| [`decision-log.md`](decision-log.md) | Material decisions, each linked to the session lines, the verification evidence and the commits. |
| [`completeness-declaration.md`](completeness-declaration.md) | Tools used, limitations of the export, and the candidate's confirmations. |
| [`export/`](export/) | The two scripts that produced the files above from the tool's transcript files, and the description of the runs they use. |

**AI instruction files.** The project has none: no `AGENTS.md`, `CLAUDE.md`, rules or prompt files
were written or used, and the repository has never contained one. What the assistant was told is
in the session itself: everything the candidate typed (marked "candidate" in the reading copy and
listed in the decision log), and the instructions the main session wrote for its sub-agents
(`script.js` of each run). Two things came from the tool, not from the candidate: the reference
text of its workflow feature (the tool put it into the conversation at lines 533 and 1524 - the
second time because the assistant asked for it at line 1522 - and attached it again after each
compaction; withheld as vendor material), and the tool's notice of its workflow mode (from
line 531 on).

## How the export was made

The tool keeps a transcript file per session on the machine the session runs on
(`~/.claude/projects/<project>/<session id>.jsonl`, and one file per sub-agent below
`<session id>/subagents/`). [`export/export_sessions.py`](export/export_sessions.py) copies those
files line by line and changes a line only where one of the rules below applies. Every change
leaves `[REDACTED: reason]` in place of what was removed, so position, kind and size of the removed
text stay visible. Where more than a text goes, the marker stands for the whole value: a withheld
tool input becomes `{"redacted": "[REDACTED: …]"}`, an attachment of the tool its type and one
marker, any other object or list one marker string. Empty values stay empty.
[`export/build_indexes.py`](export/build_indexes.py) then builds the two CSV files and the reading
copy from the exported files alone.

The exporter reads the private terms and the numbers of the withheld lines from a configuration
file that is not published: it consists of the very terms that are withheld. Its settings are the
line ranges of the unrelated request, the patterns of private terms and names, the letters for
the model names, and the reasons printed in the markers. The line ranges are in
`sessions/redaction-report.json`; the reasons are the ones in the tables below.

The line numbers used everywhere (decision log, reading copy, `tool-actions.csv`) are the lines of
the exported file, which are the lines of the tool's file: no line is added, dropped or moved.

Run from the root of the repository:

```bash
# the candidate's prompts, in order, and the messages sent while the assistant was working
# (other kinds of entries hold the rest of what the candidate typed: the command at line 516 and
# the answers at line 6368; the two messages that the tool queued at lines 5410 and 6372 and
# delivered only at line 6972 show up here at that line - the table in decision-log.md lists
# everything)
jq -r 'if .type == "user" and .origin.kind == "human" and (.message.content | type) == "string"
       then "\(.timestamp)  \(.message.content[0:100] | gsub("\n"; " "))"
       elif .type == "attachment" and .attachment.type == "queued_command" and .attachment.origin.kind == "human"
       then "\(.timestamp)  \(.attachment.prompt[0:100] | gsub("\n"; " "))"
       else empty end' ai/sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl
# every command the assistant ran
jq -r 'select(.type == "assistant") | .message.content[]? | select(.type == "tool_use" and .name == "Bash")
       | .input.command // .input.redacted' ai/sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl
# one line of the file (the decision log refers to lines)
sed -n '5396p' ai/sessions/61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl | jq .
```

## What was replaced, and why

**Another request in the same session.** During the session the candidate also asked the
assistant for something that has nothing to do with the assignment (line 554; the request itself
is kept as typed). The assistant's work on it dealt with private documents about third parties.

| Marker | What it stands for |
| --- | --- |
| `unrelated private request handled in the same session - third-party business documents` | What the entries of that work say: lines 555–936, 945–953, 993–999, 1001–1067, 1539–1540, 1567–1568, 1573–1574, 1583, 1585, 1592–1593, 1599–1600. Every entry is still there, with its kind and its time. |
| `notice of the tool about background work of the unrelated private request` | The tool's notices that background work of that request had ended; they quote its results. (These are entries of the tool, not prompts of the candidate.) |
| `line that refers to the unrelated private request` | Later mentions of that request in messages, notes and summaries: the sentence or line that mentions it, and list items below it. |
| `file …`, `directory …`, `job name …`, `tool name of the unrelated request`, `private term` | Names of its files, directories, jobs and connector tools, wherever they occur; single terms inside two commands that are otherwise kept (lines 5470 and 5474). |
| `command of the preparation of this export that handled its private terms`, `output of a command that handled the private terms of this export`, `tool output that shows material of the unrelated private request`, `text shown while this export was prepared that repeats words of the unrelated private request` | From line 5200 on the session built and checked this export. Commands that handled the private terms themselves - searched for them, counted them, rebuilt their patterns - are replaced as a whole, with their outputs (21 commands; the first two markers). So are outputs that print several lines naming the request, and outputs that repeat a passage of the withheld text. So are five outputs outside those rules: three that list the request's files with their sizes (lines 972, 7056 and 7062) and two of a check that prints parts of the private terms (lines 7256 and 7262). |
| `working step of a session that reviewed this export and was given its files, the withheld material included`, `result of a review of this export: it describes the withheld material to say where traces of it were found`, `tool output that prints part of a result of a review of this export` | The twelve sub-agents of three runs (`wf_ce880d66-b3c`, `wf_64f4f895-96e`, `wf_9ebd21af-0fe`) reviewed this export; some compared it with the original transcript. Of their sessions the task is exported. What they typed into tools, what the tools answered, their notes on the way and the text of their results are replaced: a review that looks for traces of private material has to describe that material. The copies of those results are replaced too: in the task of the one reviewer that was handed the results of the others, in the records of the runs (`run.json`: result, previews), in the tool's notices that the runs had ended, and in the output of a later command that printed part of one. How many findings each returned, and how severe, is in the marker; what was changed because of them is in decision 6 of the decision log. |

Two sub-agent runs that belong to that request (`wf_34e04759-afc` and `wf_7ccfb441-20f`, six
sessions) are not exported at all.

**Personal data.**

| Marker | What it stands for |
| --- | --- |
| `candidate e-mail address`, `domain of the candidate's e-mail address`, `account identifier` | The candidate's e-mail address, its domain where a command names it alone, and identifiers of the account: two of the tool's, the one of its cloud environment, and the numeric ones of the GitHub account. |
| `list of the candidate's other repositories - unrelated to this assignment`, `another repository of the candidate`, `name of an organisation of the candidate's account` | What the candidate's GitHub account holds besides this repository. |
| `e-mail address of the assignment's reviewer`, `name of the assignment's reviewer`, `name of the company that set the assignment` | The person the submission is sent to, and the company. They occur in the candidate's prompts where the assignment's text is quoted. Replaced because this repository is public. |

**Material of the tool's vendor, and binary data.**

| Marker | What it stands for |
| --- | --- |
| `built-in system prompt and tool definitions of the AI tool (vendor material)`, `definitions of tools …`, `documentation page of the AI tool …`, `bundled reference text of the AI tool …` | What the tool itself puts in front of the conversation or hands to the assistant on request: its system prompt, the definitions of its tools, a page of its documentation, the reference text of its workflow feature. |
| `reminder or instruction text of the AI tool (vendor material)` | The text the tool renders from its reminders (environment description, mode notices) for the model. The structured part of each such entry is kept. |
| `catalogue of tools and connectors … / of skills … available in the account`, `instructions of the connectors …`, `catalogue of agent types …` | Lists of what is installed in the candidate's account. |
| `session record of the AI tool with account and usage data (account configuration)` | The answer to the tool's own query about the session (two calls, results at lines 967 and 1136): identifiers of the environment, usage and cost figures, and the tool's one-line summary of what the session was doing at that moment. |
| `binary data (base64), …` | Screenshots the assistant took of the running app and looked at. Size and a checksum are in the marker; the three screenshots used in the README are in `docs/screenshots/`. |
| `encoded data inside a text, such as a script in a process listing of the container (not conversation content), …` | Runs of 300 or more characters of encoded data inside a text. They occur where a process listing shows a maintenance script of the container the session ran in (three files in `sessions/tool-results/`, one sub-agent session). |
| `opaque signature of a reasoning block, …` | A signature the tool stores with each reasoning step of the model (see the limitations in the declaration). |
| `model identifier A` … `E` | The names of AI models, wherever they occur: see the next section. |

Kept on purpose: the short notices with which the tool marks events in the conversation (a
background task has ended, a message arrived while the assistant was working, the conversation
was compacted, the model was changed, the candidate has not heard from the assistant for a
while) - they are part of what happened; the name of the candidate's GitHub account, which owns
this public repository; the id of the cloud session, which the commit messages carry as well; and the time zone of the machine and of the account, which the dates of
the commits show as well. Where a command of the assistant searches the export for a sentence
of the tool's reminder texts, those few words appear as the search term.

Nothing else was changed. About 44 % of the lines of the interactive session are byte for byte
the tool's lines. Most of the others differ only in a model identifier, a reasoning signature or a
reminder text of the tool; `sessions/redaction-report.json` has the counts (they count
replacements made by the export: a later command that prints a marker is not counted again).

## Model identifiers

The tool records the model with every assistant entry. In these files the names are replaced by
letters, consistently, so that it stays visible which model did what:

- **A** - the model named in the `Co-Authored-By` line of this repository's commits. It wrote all of
  the main session after its first minutes, and ran the sub-agents of the first five runs.
- **B** - another model of the same vendor. It produced the first four assistant entries of the
  main session (lines 21, 22, 29 and 30; the last one at 07:18:33 UTC). The candidate switched to
  model A with the tool's `/model` command: the command carries the time 07:09:28 and is stored
  further down, at lines 516 and 518, out of time order. Every assistant entry written by a model from line 34
  (07:19:09) on carries A. Model B also ran the sub-agents of the later runs (verification
  round 4, the confirmation run, the three reviews of this evidence, the check against the official
  wording of the requirements): the main session named it in the
  scripts of those runs. Before that, the usage limit of model A had cut two runs short (lines
  944 and 3525); the limit notices say so, the session gives no other reason for the choice.
- **C, D, E** - further model names that are only mentioned in text.

The reason for the letters, as the assistant states it (line 6365): it works under a rule of its
tool not to write model identifiers into files that are pushed to a repository; the co-author line
of the commits is where the tool itself names the model. The text of that rule belongs to the
tool's own prompt material, which is withheld, so the statement cannot be checked from this
export. **This departs from section 5 of the assignment**, which asks for model identifiers where
the tool records them, and model B is not named anywhere in this repository. The candidate was
asked and chose to leave the letters in place (line 6368).

## Limitations of this export

They are listed, with the candidate's confirmations, in
[`completeness-declaration.md`](completeness-declaration.md).
