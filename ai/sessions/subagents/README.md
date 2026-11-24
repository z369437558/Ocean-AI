# Sub-agent runs

The main session started eleven runs of sub-agents ("workflows") to have its work checked by sessions that had not written it - in one case to implement and repair the UI, in three to review this evidence before it was committed. Each sub-agent is a session of its own, with its own export file. This page is generated from those files (`ai/export/build_indexes.py`): what each run was for, which commits its findings went into, and how each sub-agent ended.

What a sub-agent was asked is in `script.js` of its run (the prompt is built there) and at the start of its session file. What it answered is in `run.json` and `journal.jsonl`.

Two further runs (six sub-agent sessions, `wf_34e04759-afc` and `wf_7ccfb441-20f`) belong to the unrelated request that was handled in the same session. They are not exported; see [`ai/README.md`](../../README.md).

## wf_2de7e29c-a07 — round4-verification

Verification round 4 on the whole application after the round-3 fixes, with a completeness critic.

Task given to the run: Independent verification of the certificate console after the last round of fixes: test quality, UI fixes in a real browser, backend fixes, acceptance criteria, install and docs - then a critic that checks what nobody checked

Related commits: 22fe305

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a56fb9df345ba153a` | critic:completeness | [REDACTED: model identifier B] | 2026-11-24T06:31:11 | 2026-11-24T06:41:24 | 47 | returned a result (5 findings) |
| `a583e86fe0f4ba800` | verify:install-docs | [REDACTED: model identifier B] | 2026-11-24T06:01:02 | 2026-11-24T06:31:11 | 86 | returned a result (4 findings) |
| `a5f34f5569acdc350` | verify:backend-adversarial | [REDACTED: model identifier B] | 2026-11-24T05:17:59 | 2026-11-24T05:51:34 | 87 | returned a result (2 findings) |
| `a7b3ddb36cff3a940` | verify:test-quality | [REDACTED: model identifier B] | 2026-11-24T04:39:18 | 2026-11-24T06:10:18 | 134 | returned a result (4 findings) |
| `a9864dcd129114bac` | verify:frontend-browser | [REDACTED: model identifier B] | 2026-11-24T04:39:22 | 2026-11-24T05:17:59 | 91 | returned a result (2 findings) |
| `aaca4a3fd95ebec46` | verify:spec-acceptance | [REDACTED: model identifier B] | 2026-11-24T05:51:34 | 2026-11-24T06:01:02 | 40 | returned a result (0 findings) |

Files: `wf_2de7e29c-a07/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_36b67f7f-878 — confirm-post-verification-fixes

Confirmation of the changes made after round 4: dialog handling in the UI, the database pre-check and development tooling, the new README sections.

Task given to the run: Adversarial confirmation of the changes made after the last verification round: dialog handling in the UI, database open pre-check and dev tooling, and the new README sections

Related commits: 7ea0f6f

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a467330090aebbf78` | confirm:frontend-dialog | [REDACTED: model identifier B] | 2026-11-24T06:56:02 | 2026-11-24T07:37:10 | 59 | returned a result (3 findings) |
| `abe3905e181b3630c` | confirm:readme-claims | [REDACTED: model identifier B] | 2026-11-24T07:37:10 | 2026-11-24T07:55:05 | 65 | returned a result (8 findings) |
| `ad7ea298544b06bf0` | confirm:backend-tooling | [REDACTED: model identifier B] | 2026-11-24T06:56:04 | 2026-11-24T08:03:57 | 80 | returned a result (6 findings) |

Files: `wf_36b67f7f-878/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_64f4f895-96e — confirm-ai-evidence

Second review of this evidence directory, after it had been rebuilt with the changes the first review led to: privacy, fidelity of the export, facts and requirements.

Task given to the run: Second independent review of the rebuilt ai/ evidence directory after the fixes: privacy, fidelity and facts

Related commits: —

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a30cce0721e2d5fec` | confirm:fidelity | [REDACTED: model identifier B] | 2026-11-24T09:54:19 | 2026-11-24T10:10:14 | 66 | returned a result (13 findings: 1 major, 8 minor, 4 nit; the text is withheld) |
| `a811b606c965dc4c4` | confirm:privacy | [REDACTED: model identifier B] | 2026-11-24T09:54:16 | 2026-11-24T10:27:52 | 105 | returned a result (8 findings: 2 major, 3 minor, 3 nit; the text is withheld) |
| `aa7d29859a3277682` | confirm:factcheck | [REDACTED: model identifier B] | 2026-11-24T10:10:14 | 2026-11-24T10:20:48 | 72 | returned a result (15 findings: 6 major, 5 minor, 4 nit; the text is withheld) |

Files: `wf_64f4f895-96e/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_956299a7-a24 — audit-certificate-console

Audit round 1: nine independent read-only auditors, one per risk area, checking the first complete version against the specification. Seven of the nine were cut off by a usage limit; two returned results.

Task given to the run: Independent adversarial audit of the certificate admin console against its spec: 9 read-only auditors, one per risk area, each must reproduce what it reports

Related commits: 56ed60e

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a337b4fa5ceb8c52e` | audit:idempotency-concurrency | [REDACTED: model identifier A] | 2026-11-23T10:10:11 | 2026-11-23T10:45:39 | 83 | returned a result (7 findings) |
| `a47a35a3ca694f9dc` | audit:startup-docs-spec | [REDACTED: model identifier A] (requested; the file records no response of a model) | 2026-11-23T10:57:36 | 2026-11-23T10:57:36 | 0 | no result: You've hit your [REDACTED: model identifier A] limit · resets Nov 26, 4am (Asia/Tokyo). Switch to another mod… |
| `a53e8f4b0c009ebce` | audit:frontend-ui | [REDACTED: model identifier A] (requested; the file records no response of a model) | 2026-11-23T10:57:35 | 2026-11-23T10:57:36 | 0 | no result: You've hit your [REDACTED: model identifier A] limit · resets Nov 26, 4am (Asia/Tokyo). Switch to another mod… |
| `a55e2caafd1756fd1` | audit:time-dst | [REDACTED: model identifier A] | 2026-11-23T10:45:39 | 2026-11-23T10:57:35 | 53 | no result: You've hit your [REDACTED: model identifier A] limit · resets Nov 26, 4am (Asia/Tokyo). Switch to another mod… |
| `a920ffe3f6606c12a` | audit:outcomes-revocation-audit | [REDACTED: model identifier A] | 2026-11-23T10:34:00 | 2026-11-23T10:57:47 | 61 | no result: You've hit your [REDACTED: model identifier A] limit · resets Nov 26, 4am (Asia/Tokyo). Switch to another mod… |
| `ac55117d6ced5e52d` | audit:test-suite-quality | [REDACTED: model identifier A] (requested; the file records no response of a model) | 2026-11-23T10:57:36 | 2026-11-23T10:57:36 | 0 | no result: You've hit your [REDACTED: model identifier A] limit · resets Nov 26, 4am (Asia/Tokyo). Switch to another mod… |
| `acc016375f2cdbf87` | audit:export-scale | [REDACTED: model identifier A] (requested; the file records no response of a model) | 2026-11-23T10:57:35 | 2026-11-23T10:57:35 | 0 | no result: You've hit your [REDACTED: model identifier A] limit · resets Nov 26, 4am (Asia/Tokyo). Switch to another mod… |
| `aefa69eeb0b5a9897` | audit:tenant-isolation | [REDACTED: model identifier A] | 2026-11-23T10:10:10 | 2026-11-23T10:34:00 | 75 | returned a result (4 findings) |
| `af9bfb6523ed40e57` | audit:backend-review-fuzz | [REDACTED: model identifier A] (requested; the file records no response of a model) | 2026-11-23T10:57:36 | 2026-11-23T10:57:36 | 0 | no result: You've hit your [REDACTED: model identifier A] limit · resets Nov 26, 4am (Asia/Tokyo). Switch to another mod… |

Files: `wf_956299a7-a24/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_9ebd21af-0fe — final-evidence-review

Third and last review of this evidence directory before it was committed: a privacy check against the tool's files, a reading by a session that was given only the files to be published, and a check of the facts stated in the documents.

Task given to the run: Last independent check of the staged ai/ evidence directory before it is published: privacy (with the source), an outsider reading, and the facts in the documents

Related commits: —

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a477f1d25b334b924` | review:facts | [REDACTED: model identifier B] | 2026-11-24T11:00:09 | 2026-11-24T11:09:11 | 72 | returned a result (12 findings: 2 blocker, 3 major, 4 minor, 3 nit; the text is withheld) |
| `a4a63da468d1cbc39` | review:privacy | [REDACTED: model identifier B] | 2026-11-24T10:53:53 | 2026-11-24T11:00:09 | 42 | returned a result (8 findings: 2 blocker, 4 minor, 2 nit; the text is withheld) |
| `aa5fb84757355a7f4` | review:outsider | [REDACTED: model identifier B] | 2026-11-24T10:53:58 | 2026-11-24T11:03:18 | 64 | returned a result (11 findings: 1 blocker, 1 major, 6 minor, 3 nit; the text is withheld) |

Files: `wf_9ebd21af-0fe/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_be7a6b64-0c4 — requirements-compliance

Check of the finished application against the official wording of sections 2 to 4 of the assignment, which had reached the session late: two sub-agents acting as the company's evaluators, each from a clean clone - constraints and product scope in a browser; demo data and scenarios A1 to A7 by the README's steps and by checks of their own.

Task given to the run: Check the finished application against the official wording of sections 2 to 4 of the assignment, as the company's evaluator would: sentence by sentence, from a clean clone

Related commits: 7ea0f6f

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a0776160c14786760` | evaluate:scope | [REDACTED: model identifier B] | 2026-11-24T11:03:00 | 2026-11-24T11:11:13 | 40 | returned a result (4 findings) |
| `adc5f1b815e37eb95` | evaluate:scenarios | [REDACTED: model identifier B] | 2026-11-24T11:03:01 | 2026-11-24T11:11:01 | 37 | returned a result (9 findings) |

Files: `wf_be7a6b64-0c4/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_c39bd866-324 — verify-backend-round2-fixes

Independent verification of the backend fixes of audit round 2 (export, search and data, write path, code review).

Task given to the run: Independent adversarial verification of the backend changes made after the second audit (export, search, write path, start-up) plus a full diff review, each finding reproduced

Related commits: f615919

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a0e7cfa3e63cde4e1` | verify:review | [REDACTED: model identifier A] | 2026-11-23T18:10:12 | 2026-11-23T19:10:32 | 164 | returned a result (14 findings) |
| `a1ccbe876d2779483` | verify:write-path | [REDACTED: model identifier A] | 2026-11-23T17:21:54 | 2026-11-23T18:21:17 | 107 | returned a result (2 findings) |
| `a651bddf02ac0a287` | verify:search-data | [REDACTED: model identifier A] | 2026-11-23T16:29:37 | 2026-11-23T17:21:54 | 104 | returned a result (11 findings) |
| `aaca92983f2886c4f` | verify:export | [REDACTED: model identifier A] | 2026-11-23T16:29:37 | 2026-11-23T18:10:11 | 132 | returned a result (6 findings) |

Files: `wf_c39bd866-324/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_c7cfad2a-83b — final-acceptance-verification

Verification round 3 on the whole application: acceptance criteria, adversarial backend tests, real-browser checks, installation and documentation, quality of the tests.

Task given to the run: Independent adversarial verification of the integrated certificate console: spec acceptance, backend changes, UI in a real browser, install and docs, test quality

Related commits: c706d93

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a4ff4421b747e4e50` | verify:backend-adversarial | [REDACTED: model identifier A] | 2026-11-23T19:49:05 | 2026-11-23T21:27:59 | 114 | returned a result (6 findings) |
| `ad21f916da4a75b0e` | verify:frontend-browser | [REDACTED: model identifier A] | 2026-11-23T20:36:57 | 2026-11-23T21:56:31 | 119 | returned a result (10 findings) |
| `adf7cc97864dd2fbe` | verify:spec-acceptance | [REDACTED: model identifier A] | 2026-11-23T19:49:04 | 2026-11-23T20:36:57 | 140 | returned a result (5 findings) |
| `ae76003f33b3f534b` | verify:install-docs | [REDACTED: model identifier A] | 2026-11-23T21:27:59 | 2026-11-23T22:21:26 | 156 | returned a result (9 findings) |
| `aeaaf5bf54e0cd4f5` | verify:test-quality | [REDACTED: model identifier A] | 2026-11-23T21:56:31 | 2026-11-23T23:24:52 | 182 | no result: You've hit your [REDACTED: model identifier A] limit · resets Nov 26, 4am (Asia/Tokyo). Switch to another mod… |

Files: `wf_c7cfad2a-83b/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_ce880d66-b3c — review-ai-evidence

Review of this evidence directory before it was committed: privacy of the exported files, fidelity of the export, the facts stated in the documents, the view of an evaluator, and a critic.

Task given to the run: Independent review of the staged ai/ evidence directory: privacy, fidelity of the export, facts in the documents, and compliance with section 5 of the assignment

Related commits: —

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a1e1bd8e3568ed6c3` | review:fidelity | [REDACTED: model identifier B] | 2026-11-24T09:16:58 | 2026-11-24T09:30:56 | 65 | returned a result (10 findings: 4 major, 3 minor, 3 nit; the text is withheld) |
| `a47b675cea4941fee` | review:privacy-main | [REDACTED: model identifier B] | 2026-11-24T09:02:35 | 2026-11-24T09:16:58 | 60 | returned a result (9 findings: 2 major, 6 minor, 1 nit; the text is withheld) |
| `a7fcccf22530d467a` | review:evaluator-section5 | [REDACTED: model identifier B] | 2026-11-24T09:28:19 | 2026-11-24T09:39:21 | 61 | returned a result (14 findings: 1 blocker, 5 major, 6 minor, 2 nit; the text is withheld) |
| `ac7542d9f1dd57df7` | review:privacy-other-files | [REDACTED: model identifier B] | 2026-11-24T09:02:39 | 2026-11-24T09:17:42 | 82 | returned a result (7 findings: 4 major, 1 minor, 2 nit; the text is withheld) |
| `adfc41c948576cdc1` | critic:completeness | [REDACTED: model identifier B] | 2026-11-24T09:39:21 | 2026-11-24T09:47:08 | 32 | returned a result (8 findings: 1 blocker, 1 major, 4 minor, 2 nit; the text is withheld) |
| `af1d55fbe32a65e0f` | review:factcheck | [REDACTED: model identifier B] | 2026-11-24T09:17:42 | 2026-11-24T09:28:19 | 71 | returned a result (24 findings: 4 major, 13 minor, 7 nit; the text is withheld) |

Files: `wf_ce880d66-b3c/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_cf2a82ec-f18 — frontend-fixes-and-ui-tests

Rework of the UI after the audit findings: one sub-agent implemented the fixes and a UI test suite, others verified it in a browser and by review, repaired what they found and confirmed the repair.

Task given to the run: Fix the audited UI defects of the certificate console in a private copy, add an automated UI test suite, then verify adversarially (real browser + code/test review), repair and confirm

Related commits: f615919 c706d93

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a1b850a8c7071e81e` | repair:frontend | [REDACTED: model identifier A] | 2026-11-23T17:50:23 | 2026-11-23T19:18:28 | 192 | returned a result |
| `a6f7c4d6ed89dd59f` | confirm:frontend | [REDACTED: model identifier A] | 2026-11-23T19:18:28 | 2026-11-23T20:20:42 | 158 | returned a result (1 findings) |
| `a742739259faaa6c0` | verify:browser | [REDACTED: model identifier A] | 2026-11-23T16:36:55 | 2026-11-23T17:50:23 | 116 | returned a result (5 findings) |
| `acf92137be58ef802` | implement:frontend | [REDACTED: model identifier A] | 2026-11-23T15:12:54 | 2026-11-23T16:36:55 | 151 | returned a result |
| `af9345b29cd0a2d82` | verify:review | [REDACTED: model identifier A] | 2026-11-23T16:36:55 | 2026-11-23T17:40:14 | 120 | returned a result (9 findings) |

Files: `wf_cf2a82ec-f18/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).

## wf_e4b5cf66-7b5 — audit-certificate-console-round2

Audit round 2: the seven areas that had not run, plus a review of the fixes made after round 1.

Task given to the run: Second independent audit round of the certificate admin console: 8 read-only auditors (7 risk areas not yet covered plus a regression audit of the latest fixes); every finding must be reproduced

Related commits: 5f34d63 f615919

| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `a05445e86f0fe5c33` | audit:concurrency-regression | [REDACTED: model identifier A] | 2026-11-23T12:19:18 | 2026-11-23T13:06:05 | 80 | returned a result (5 findings) |
| `a1d28bcc120154ef4` | audit:test-suite-quality | [REDACTED: model identifier A] | 2026-11-23T13:54:35 | 2026-11-23T15:00:03 | 87 | returned a result (13 findings) |
| `a4ebe6c11403903b0` | audit:startup-docs-spec | [REDACTED: model identifier A] | 2026-11-23T13:35:50 | 2026-11-23T13:55:33 | 60 | returned a result (6 findings) |
| `a5da742aff24a2dd8` | audit:frontend-ui | [REDACTED: model identifier A] | 2026-11-23T13:04:06 | 2026-11-23T13:22:19 | 53 | returned a result (8 findings) |
| `a771a62d973bd0a45` | audit:export-scale | [REDACTED: model identifier A] | 2026-11-23T12:37:19 | 2026-11-23T13:04:06 | 58 | returned a result (6 findings) |
| `a7871ec02495211b6` | audit:backend-review-fuzz | [REDACTED: model identifier A] | 2026-11-23T13:06:05 | 2026-11-23T13:54:35 | 88 | returned a result (5 findings) |
| `aef76356d2232e23f` | audit:time-dst | [REDACTED: model identifier A] | 2026-11-23T13:22:19 | 2026-11-23T13:35:50 | 42 | returned a result (0 findings) |
| `af9ba29e23ae97304` | audit:outcomes-revocation-audit | [REDACTED: model identifier A] | 2026-11-23T12:19:18 | 2026-11-23T12:37:19 | 40 | returned a result (4 findings) |

Files: `wf_e4b5cf66-7b5/agent-<id>.jsonl.gz` (the sub-agent's session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), `run.json` (the tool's record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).
