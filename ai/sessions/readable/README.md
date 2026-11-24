# Reading copy of the main session

These files are a rendering of [`../61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl`](../61a877e9-483e-575a-b7cf-c5b8e94decb9.jsonl) for people: prompts, assistant messages, and every tool call with its input and result, in order. They are generated from that file (`ai/export/build_indexes.py`) and contain nothing that is not in it.

- **The `.jsonl` is the record.** Here, long tool inputs and outputs are cut after a few thousand characters, with a note saying how many characters follow and on which line of the `.jsonl` they are. Prompts typed by the candidate and messages of the assistant are never shortened.
- Each block starts with the line number of the entry in the `.jsonl` and its time (UTC).
- "candidate" marks what the candidate typed. "tool notice", "background-task notice" and "summary written by the tool" are texts the tool itself put into the conversation.
- `[REDACTED: reason]` marks removed text; the reasons are listed in [`ai/README.md`](../../README.md).
- Links inside quoted text (a README that was written or printed during the session, say) are part of the quotation and may lead nowhere from here.

| part | lines of the `.jsonl` | from (UTC) | to (UTC) |
| --- | --- | --- | --- |
| [main-part-01.md](main-part-01.md) | 3–1230 | 2026-11-23T07:07:08 | 2026-11-23T11:34:59 |
| [main-part-02.md](main-part-02.md) | 1231–2071 | 2026-11-23T11:36:14 | 2026-11-23T15:55:44 |
| [main-part-03.md](main-part-03.md) | 2074–3016 | 2026-11-23T15:56:33 | 2026-11-23T19:06:53 |
| [main-part-04.md](main-part-04.md) | 3017–3922 | 2026-11-23T19:06:56 | 2026-11-24T03:32:45 |
| [main-part-05.md](main-part-05.md) | 3929–4786 | 2026-11-24T03:33:26 | 2026-11-24T04:42:05 |
| [main-part-06.md](main-part-06.md) | 4787–5678 | 2026-11-24T04:42:09 | 2026-11-24T07:47:56 |
| [main-part-07.md](main-part-07.md) | 5685–6445 | 2026-11-24T07:48:16 | 2026-11-24T09:31:15 |
| [main-part-08.md](main-part-08.md) | 6451–7141 | 2026-11-24T09:32:02 | 2026-11-24T11:13:42 |
| [main-part-09.md](main-part-09.md) | 7145–7281 | 2026-11-24T11:13:48 | 2026-11-24T11:26:19 |
