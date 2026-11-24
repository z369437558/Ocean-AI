# Completeness declaration

## AI tools used

| Tool | Used for | Sessions | Export |
| --- | --- | --- | --- |
| Claude Code (Anthropic), cloud session at claude.ai/code | Everything in this repository: planning, code, tests, verification, README, the git history, this evidence. Of `written-answers.md` the assistant made the file only; the words are the candidate's (see the confirmations below). | 1 interactive session (`61a877e9-483e-575a-b7cf-c5b8e94decb9`, shown in the tool as `session_01N8a9P4ffov11BZN7rrXK3k`) and the 54 sub-agent sessions it started for the assignment up to its last exported line (two more after it, see limitation 8) | The tool's own transcript files (JSON Lines), see [`README.md`](README.md) |

The interactive session is exported from its first line to line 7284 (2026-11-24 11:26:19 UTC). All of
its prompts, assistant messages, tool calls, file edits, commands, errors and time stamps are in
the export, including the rounds that found defects, the runs that were cut short and the
suggestions that were not followed.

The tool is an agent that works through commands and file edits in a remote container, without
an editor: it has no inline autocomplete. That the candidate used none elsewhere, and no other AI
tool, is the candidate's own statement, in the confirmations below.

## Limitations of the export

1. **An unrelated request in the same session is withheld.** During the session the candidate also
   asked the assistant for something that has nothing to do with the assignment (line 554, kept
   as typed). The assistant's work on it dealt with private documents about third parties; what
   those entries say is replaced by markers, entry by entry (the table in `README.md` gives the
   lines). The six sub-agent sessions of that request (runs `wf_34e04759-afc` and
   `wf_7ccfb441-20f`) are not exported.
2. **Model identifiers are replaced by letters** (A–E) in every file of this directory, the
   `model` column of `session-index.csv` included. This departs from section 5 of the assignment,
   which asks for model identifiers where the tool records them. The reason - a rule of the
   assistant's tool - and the meaning of the letters are in `README.md`; the model behind letter A
   is named in the `Co-Authored-By` line of every commit.
3. **The reasoning of the model is not in the transcript.** The tool stores an opaque signature
   for each reasoning step and, for some of them, a short note. The notes are exported; the
   signatures are replaced by markers. Some of the assistant's short status messages are recorded
   by the tool in the same way, as notes.
4. **The tool's own prompt material is not exported**: its built-in system prompt, the definitions
   of its tools, its reminder texts, the reference text of its workflow feature and the lists of
   tools, skills and connectors of the account. Each occurrence is marked, with its size.
5. **Screenshots** the assistant took and looked at are replaced by markers (size and checksum).
6. **The sessions that reviewed this export are exported without their working steps.** The twelve
   sub-agents of three runs (`wf_ce880d66-b3c`, `wf_64f4f895-96e`, `wf_9ebd21af-0fe`) were given the export
   and, some of them, the original transcript with the withheld material. Their tasks are
   exported; what they typed into tools, what the tools answered and the text of their results
   are not, wherever the tool stores that text (the markers give the number and severity of the
   findings).
   In the interactive session itself, the commands and outputs with which the export was built
   and checked (from line 5200 on) are withheld where they handled or printed that material.
7. **The reviewer's e-mail address and the company's name are replaced**, also where the
   candidate's prompts quote the assignment, because the repository is public.
8. **The export ends before the session does.** The commit that adds this directory cannot contain
   the steps that created it. After line 7284 the session consists of: building this export one
   last time; committing and pushing it; one more privacy check of its newest part (lines 6843
   to 7284 and the two newest runs) by two sub-agents, run `wf_8eb472f6-4d3` - it found two commands of the
   preparation (lines 7065 and 7274) from which parts of withheld names could be worked out; both
   are withheld in this export, which was built again up to the same last line; replacing the two
   commits on GitHub, with the candidate's consent; an attempt to make the repository public as
   the candidate had asked, which the session's access to GitHub does not permit - the candidate
   changes the visibility; drafting the submission e-mail for the candidate to send; and a closing
   summary. The two sessions of that last check began after the
   last exported line, so no exported file can hold them: they have a row each in
   `session-index.csv`, without a file. (For the same reason the commit that adds this directory
   cannot name itself: the commit after it writes its id into `session-index.csv`,
   `export/runs.json` and the overview `sessions/subagents/README.md`; both commits were made a second time after the last check, and replaced the first
   pair. A third commit corrected this paragraph: who makes the repository public.)
9. **Two messages of the candidate reached the assistant hours late.** While the assistant was
   working, the candidate sent the official text of sections 2–5 of the assignment - the
   requirements for the application and for this evidence - and, later, the request to make the
   repository public. The tool queued both (lines 5410 and 6372, at 07:21 and 09:08 UTC) and
   delivered them only when the assistant's turn ended, as one prompt, at line 6972 (10:59 UTC).
   The assistant had come across the first one in the tool's queue log fourteen minutes after it
   was sent (line 5602) and said so (line 5626); from then on it followed section 5. Until then
   it had planned this directory from the short list of deliverables in the prompt at line 5202.
   It found the second one in the queue log at line 6587.
   The application itself was built and verified against the specification in the first prompt
   (line 3), which states sections 2–4 in other words. The official wording was checked at the end, by two sub-agents acting as the
   company's evaluators (run `wf_be7a6b64-0c4`; decision 8 in the decision log).
10. **Files outside the transcript.** Outputs of background commands were written to temporary
    files; what the assistant read of them is in the tool results, the files themselves are not
    kept. The cache bookkeeping files the tool writes next to each sub-agent session
    (`*.prefix.json`: hashes and outlines of its own prompt) are not copied.
11. **The git history of the first six commits is reconstructed.** The project was not under
    version control while it was built; the candidate chose to rebuild the history from the
    copies kept during the work (decision 1 in [`decision-log.md`](decision-log.md)). Each of
    those commits says so in its message, with the time of the copy as its author date.

## Confirmations by the candidate

The assistant asked the candidate four questions - three about this declaration and one about
access to the repository (line 6365); the candidate's answers are at line 6368. The candidate answered by choosing among options the assistant had
drafted: the wording of every option, chosen or not, is at line 6365, and the sentences below
restate the chosen ones. In those answers the candidate confirms:

- **Tools.** Claude Code, in the one session exported here, is the only AI tool that was used for
  this assignment, the written answers included. No other assistant or chat tool was used, and no
  inline autocomplete.
- **Section 6 was completed without AI.** The answers in
  [`written-answers.md`](../written-answers.md) were written by the candidate without AI. After
  they were written, the candidate pasted them into the session and asked the assistant what it
  thought of them (line 5193); the assistant's review is at line 5195. Nothing of that review went
  into the answers: the file holds the answer text pasted at line 5193, word for word. The
  assistant made the file from that text (line 6028) and added only the page title, the heading
  marks in front of the three titles and blank lines between paragraphs; the questions, which the
  candidate had pasted below the answers, are not repeated in it (SHA-256 of the pasted answer
  text: `69cb2101c89e4fd70f3aad68031b7b6406de1c321db01d4999c9944c6bb087c1`). So what "without AI"
  means here is: written without AI, then shown to the assistant and left as it was. What the
  record can show is the second half; the first is the candidate's word.
- **Model identifiers.** The candidate chose to leave the letters in place (limitation 2). The
  model behind letter A is named in the `Co-Authored-By` line of every commit of this repository.
- **Visibility.** The candidate decided to make the repository public for the review, and asked
  the assistant to do so (line 6372; the tool delivered that request at line 6972). What is listed under limitations 1 and 7 was withheld with
  that in mind.
