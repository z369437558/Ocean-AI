#!/usr/bin/env python3
"""
Build the indexes and the reading copy from the exported sessions (ai/sessions/).

Everything written here is derived from the exported JSON Lines files and can be rebuilt from
them; nothing is read from the native transcripts. Output:

  ai/session-index.csv            one row per session (the main session and every sub-agent)
  ai/tool-actions.csv             one row per tool call, in the order of the clock
  ai/sessions/readable/*.md       the main session as text, in parts
  ai/sessions/subagents/README.md what each sub-agent run was for and how it ended

Usage:  build_indexes.py --ai <the ai/ directory> --runs runs.json [--commits commits.json]
        runs.json maps a run id to {"purpose": ..., "commits": [...]}; it also carries
        "main_purpose" and "main_commits".
"""
import argparse
import csv
import gzip
import json
import os
import re

MAX_INPUT = 3000   # characters of a tool input shown in the reading copy
MAX_OUTPUT = 1500  # characters of a tool result shown in the reading copy
PART_SIZE = 330_000


def read_jsonl(path):
    opener = gzip.open if path.endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8') as handle:
        return [json.loads(line) for line in handle if line.strip()]


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, dict):
                if part.get('type') == 'text':
                    parts.append(part.get('text', ''))
                elif part.get('type') == 'image':
                    parts.append('[image]')
                else:
                    parts.append(json.dumps(part, ensure_ascii=False))
            else:
                parts.append(str(part))
        return '\n'.join(parts)
    return '' if content is None else json.dumps(content, ensure_ascii=False)


def one_line(text, limit):
    text = re.sub(r'\s+', ' ', text or '').strip()
    return text if len(text) <= limit else text[: limit - 1] + '…'


def timestamps(entries):
    stamps = [entry['timestamp'] for entry in entries if isinstance(entry.get('timestamp'), str)]
    return (min(stamps), max(stamps)) if stamps else ('', '')


def models_of(entries):
    """The model named on each assistant message, with the number of messages."""
    counts = {}
    for entry in entries:
        message = entry.get('message')
        if entry.get('type') == 'assistant' and isinstance(message, dict):
            model = message.get('model')
            if model and model != '<synthetic>':
                counts[model] = counts.get(model, 0) + 1
    return counts


def tool_calls(entries):
    """(line, timestamp, name, input, result entry line, result part) for every tool call."""
    results = {}
    for number, entry in enumerate(entries, 1):
        message = entry.get('message')
        if entry.get('type') == 'user' and isinstance(message, dict) and isinstance(message.get('content'), list):
            for part in message['content']:
                if isinstance(part, dict) and part.get('type') == 'tool_result':
                    results[part.get('tool_use_id')] = (number, part)
    for number, entry in enumerate(entries, 1):
        message = entry.get('message')
        if entry.get('type') == 'assistant' and isinstance(message, dict):
            for part in message.get('content') or []:
                if isinstance(part, dict) and part.get('type') == 'tool_use':
                    yield number, entry.get('timestamp', ''), part.get('name'), part.get('input') or {}, results.get(part.get('id'))


def describe_call(name, data):
    """(what was done, on what) for the tool-action list."""
    if not isinstance(data, dict):
        return '', ''
    if 'redacted' in data and len(data) == 1:
        return data['redacted'], ''
    if name == 'Bash':
        return data.get('description', ''), one_line(data.get('command', ''), 160)
    if name in ('Read', 'Write', 'Edit', 'NotebookEdit'):
        return name.lower() + ' file', data.get('file_path', '')
    if name in ('Grep', 'Glob'):
        return 'search', one_line(f"{data.get('pattern', '')} in {data.get('path', '.')}", 160)
    if name == 'Workflow':
        match = re.search(r"name:\s*'([^']+)'", data.get('script', '') or '')
        return 'start sub-agent workflow', match.group(1) if match else (data.get('scriptPath') or data.get('name') or '')
    if name == 'Skill':
        return 'load skill', data.get('skill', '')
    if name == 'StructuredOutput':
        return 'return the structured result', ''
    return data.get('description', '') or '', one_line(json.dumps(data, ensure_ascii=False), 160)


def result_state(result):
    if result is None:
        return 'no result recorded', 0
    _, part = result
    text = text_of(part.get('content'))
    if text.startswith('[REDACTED'):
        return 'withheld', 0
    return ('error' if part.get('is_error') else 'ok'), len(text)


def fence(text, language=''):
    longest = max((len(run) for run in re.findall(r'`+', text)), default=0)
    ticks = '`' * max(3, longest + 1)
    return f'{ticks}{language}\n{text}\n{ticks}'


def clip(text, limit, where):
    if len(text) <= limit:
        return text
    return text[:limit] + f'\n… [{len(text) - limit} more characters: {where}]'


WITHHELD = ('[REDACTED: unrelated private request handled in the same session',
            '[REDACTED: notice of the tool about background work of the unrelated private request')


def is_withheld(entry):
    """An entry of the unrelated request: everything it says is one of the two markers above.

    Decided by the structure of the entry, not by the marker text occurring somewhere in it - the
    commands that built this export quote that text."""
    kind = entry.get('type')
    if kind in ('queue-operation', 'system'):
        text = entry.get('content')
        return isinstance(text, str) and text.startswith(WITHHELD)
    if kind == 'attachment':
        text = (entry.get('attachment') or {}).get('redacted')
        return isinstance(text, str) and text.startswith(WITHHELD)
    message = entry.get('message')
    if not isinstance(message, dict):
        return False
    content = message.get('content')
    if isinstance(content, str):
        return content.startswith(WITHHELD)
    found = False
    for part in content or []:
        if not isinstance(part, dict):
            continue
        for key in ('text', 'thinking', 'content'):
            value = part.get(key)
            if isinstance(value, str) and value:
                if not value.startswith(WITHHELD):
                    return False
                found = True
        if 'input' in part:
            marker = part['input'].get('redacted') if isinstance(part['input'], dict) and len(part['input']) == 1 else None
            if not (isinstance(marker, str) and marker.startswith(WITHHELD)):
                return False
            found = True
    return found


def lines_of(ranges):
    """['3-5', '9'] -> {3, 4, 5, 9}"""
    numbers = set()
    for item in ranges:
        first, _, last = item.partition('-')
        numbers.update(range(int(first), int(last or first) + 1))
    return numbers


def render_main(entries, session_file, out_dir, unrelated=frozenset()):
    """The main session as Markdown, in parts. Returns [(file name, first time, last time, first line, last line)]."""
    os.makedirs(out_dir, exist_ok=True)
    results = {}
    for number, entry in enumerate(entries, 1):
        message = entry.get('message')
        if entry.get('type') == 'user' and isinstance(message, dict) and isinstance(message.get('content'), list):
            for part in message['content']:
                if isinstance(part, dict) and part.get('type') == 'tool_result':
                    results[part.get('tool_use_id')] = (number, part)
    shown_results = set()
    blocks = []  # (line, timestamp, text)
    # What the candidate typed reaches the assistant as a message, or as a "queued command" when it
    # was typed while the assistant was working. A prompt that is in the queue log and in neither
    # of those was not delivered when it was sent: the tool may hand it over later, inside a
    # prompt of its own (several queued messages in one), or never.
    delivered = set()
    typed = []  # (line, text without its line breaks and repeated blanks) of every prompt
    squeeze = lambda value: ' '.join(value.split())
    for number, entry in enumerate(entries, 1):
        message = entry.get('message')
        if entry.get('type') == 'user' and isinstance(message, dict) and isinstance(message.get('content'), str):
            delivered.add(message['content'].strip())
            typed.append((number, squeeze(message['content'])))
        if entry.get('type') == 'attachment' and (entry.get('attachment') or {}).get('type') == 'queued_command':
            delivered.add(str((entry.get('attachment') or {}).get('prompt') or '').strip())
    withheld = None  # [first line, last line, first time, last time, count]

    def flush_withheld():
        nonlocal withheld
        if withheld:
            first, last, start, end, count = withheld
            blocks.append((first, start, f'> **Lines {first}–{last}** ({start} – {end}): {count} entries of an unrelated private request '
                                         f'(the assistant\'s work on it and the tool\'s notices about it). Their content is withheld in the export; '
                                         f'kind and time of every entry are in the `.jsonl`.\n'))
            withheld = None

    for number, entry in enumerate(entries, 1):
        kind = entry.get('type')
        stamp = entry.get('timestamp', '') or ''
        message = entry.get('message') if isinstance(entry.get('message'), dict) else None
        if number in unrelated:
            if kind not in ('user', 'assistant', 'attachment', 'queue-operation', 'system') or not is_withheld(entry):
                continue  # bookkeeping of the tool, or nothing said
            if withheld:
                withheld[1], withheld[3], withheld[4] = number, stamp or withheld[3], withheld[4] + 1
            else:
                withheld = [number, number, stamp, stamp, 1]
            continue
        if kind in ('user', 'assistant', 'system') or (kind == 'attachment' and (entry.get('attachment') or {}).get('type') == 'queued_command'):
            flush_withheld()
        head = f'### Line {number} · {stamp[:19].replace("T", " ")} UTC · '
        if kind == 'queue-operation':
            text = entry.get('content')
            if (entry.get('operation') == 'enqueue' and isinstance(text, str) and text.strip() and text.strip() not in delivered
                    and not text.lstrip().startswith('<task-notification>') and not text.startswith('[REDACTED')):
                flush_withheld()
                later = next((line for line, prompt in typed if line > number and squeeze(text) in prompt), None)
                fate = (f'delivered it to the assistant only at line {later}, inside a later prompt' if later
                        else 'never delivered it to the assistant - it is in the queue log only')
                blocks.append((number, stamp, head + f'**candidate** (typed while the assistant was working; the tool queued this message and {fate})\n\n' + fence(text)))
            continue
        if kind == 'attachment':
            attachment = entry.get('attachment') or {}
            if attachment.get('type') == 'queued_command':
                prompt = attachment.get('prompt') or ''
                # The tool says who an entry of its queue comes from; the text may have been replaced by a marker.
                from_tool = ((attachment.get('origin') or {}).get('kind') == 'task-notification'
                             or attachment.get('commandMode') == 'task-notification')
                if from_tool or (isinstance(prompt, str) and prompt.lstrip().startswith('<task-notification>')):
                    blocks.append((number, stamp, head + 'background-task notice\n\n' + fence(clip(text_of(prompt), 4000, f'line {number} of {session_file}'))))
                else:  # typed by the candidate: never shortened
                    blocks.append((number, stamp, head + '**candidate** (message sent while the assistant was working)\n\n' + fence(text_of(prompt))))
            continue
        if kind == 'system':
            if entry.get('subtype') == 'compact_boundary':
                blocks.append((number, stamp, head + 'tool\n\n*The conversation so far was compacted here: the tool replaced it, for the assistant, with the summary in the next entry.*'))
            continue
        if not message:
            continue
        content = message.get('content')
        if kind == 'user':
            if isinstance(content, list) and any(isinstance(p, dict) and p.get('type') == 'tool_result' for p in content):
                for part in content:
                    if isinstance(part, dict) and part.get('type') == 'tool_result' and part.get('tool_use_id') not in shown_results:
                        text = text_of(part.get('content'))
                        blocks.append((number, stamp, head + 'tool result without a recorded call\n\n' + fence(clip(text, MAX_OUTPUT, f'line {number} of {session_file}'))))
                continue
            text = text_of(content)
            if entry.get('isCompactSummary'):
                who = 'summary written by the tool (what the assistant kept of the conversation before this point)'
                body = fence(clip(text, 6000, f'line {number} of {session_file}'))
            elif text.lstrip().startswith('<command-name>'):
                who = '**candidate** (a command typed into the tool itself, not a message to the assistant)'
                body = fence(text)
            elif entry.get('isMeta') or text.lstrip().startswith(('<system-reminder>', '<local-command', '<command-')):
                who = 'tool notice'
                body = fence(clip(text, 1200, f'line {number} of {session_file}'))
            elif text.lstrip().startswith('<task-notification>') or (entry.get('origin') or {}).get('kind') == 'task-notification':
                who = 'background-task notice'
                body = fence(clip(text, 2500, f'line {number} of {session_file}'))
            else:
                who = '**candidate**'
                body = fence(text)  # prompts are never shortened
            blocks.append((number, stamp, head + who + '\n\n' + body))
            continue
        # assistant
        for part in content or []:
            if not isinstance(part, dict):
                continue
            if part.get('type') == 'text' and part.get('text', '').strip():
                blocks.append((number, stamp, head + '**assistant**\n\n' + part['text'].strip()))
            elif part.get('type') == 'thinking' and (part.get('thinking') or '').strip():
                blocks.append((number, stamp, head + 'assistant, reasoning note\n\n' + fence(part['thinking'].strip())))
            elif part.get('type') == 'tool_use':
                name, data = part.get('name'), part.get('input') or {}
                action, target = describe_call(name, data)
                lines = [head + f'assistant → tool `{name}`' + (f': {one_line(action, 200)}' if action else '')]
                if name == 'Bash' and isinstance(data.get('command'), str):
                    lines.append(fence(clip(data['command'], MAX_INPUT, f'line {number} of {session_file}'), 'bash'))
                elif name in ('Write',) and isinstance(data.get('content'), str):
                    lines.append(f'`{data.get("file_path", "")}`\n\n' + fence(clip(data['content'], MAX_INPUT, f'line {number} of {session_file}')))
                elif name == 'Edit':
                    lines.append(f'`{data.get("file_path", "")}`\n\nold:\n' + fence(clip(str(data.get('old_string', '')), MAX_INPUT // 2, f'line {number}')) +
                                 '\n\nnew:\n' + fence(clip(str(data.get('new_string', '')), MAX_INPUT // 2, f'line {number}')))
                elif name == 'Workflow' and isinstance(data.get('script'), str):
                    lines.append(fence(clip(data['script'], MAX_INPUT, f'line {number} of {session_file}; the whole script is also in subagents/<run>/script.js'), 'js'))
                elif name == 'AskUserQuestion':
                    lines.append(fence(json.dumps(data, ensure_ascii=False, indent=1), 'json'))  # the questions in full
                else:
                    lines.append(fence(clip(json.dumps(data, ensure_ascii=False, indent=1), MAX_INPUT, f'line {number} of {session_file}'), 'json'))
                result = results.get(part.get('id'))
                if result and name == 'AskUserQuestion':
                    # the answers are the candidate's own: never shortened
                    result_line, result_part = result
                    shown_results.add(part.get('id'))
                    lines.append(f'**candidate** (answers chosen in the tool\'s question dialog, line {result_line}):\n\n' + fence(text_of(result_part.get('content'))))
                elif result:
                    result_line, result_part = result
                    shown_results.add(part.get('id'))
                    text = text_of(result_part.get('content'))
                    state = 'error' if result_part.get('is_error') else 'result'
                    lines.append(f'{state} (line {result_line}, {len(text)} characters):\n\n' + fence(clip(text, MAX_OUTPUT, f'line {result_line} of {session_file}')))
                else:
                    lines.append('*no result recorded for this call*')
                blocks.append((number, stamp, '\n\n'.join(lines)))
    flush_withheld()

    parts, current, size = [], [], 0
    for block in blocks:
        if current and size + len(block[2]) > PART_SIZE:
            parts.append(current)
            current, size = [], 0
        current.append(block)
        size += len(block[2])
    if current:
        parts.append(current)
    written = []
    for index, part in enumerate(parts, 1):
        name = f'main-part-{index:02d}.md'
        first_line, last_line = part[0][0], part[-1][0]
        stamps = [stamp for _, stamp, _ in part if stamp]
        first_time, last_time = (min(stamps), max(stamps)) if stamps else ('', '')
        header = (f'# Main session, part {index} of {len(parts)}\n\n'
                  f'Reading copy of `{session_file}`, lines {first_line}–{last_line} ({first_time[:19]}Z – {last_time[:19]}Z). '
                  'Generated from the exported file; long tool inputs and outputs are shortened here and complete there. '
                  'See [README.md](README.md) for how to read it.\n\n---\n\n')
        with open(os.path.join(out_dir, name), 'w', encoding='utf-8') as handle:
            handle.write(header + '\n\n'.join(text for _, _, text in part) + '\n')
        written.append((name, first_time, last_time, first_line, last_line))
    return written


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ai', required=True)
    parser.add_argument('--runs', required=True)
    args = parser.parse_args()
    with open(args.runs, encoding='utf-8') as handle:
        runs_info = json.load(handle)
    sessions = os.path.join(args.ai, 'sessions')
    main_file = next(name for name in sorted(os.listdir(sessions)) if name.endswith('.jsonl'))
    main_id = main_file[: -len('.jsonl')]
    main_entries = read_jsonl(os.path.join(sessions, main_file))

    index_rows, action_rows, overview = [], [], []
    started, ended = timestamps(main_entries)
    models = models_of(main_entries)
    model_text = '; '.join(f'{model} ({count} assistant entries)' for model, count in sorted(models.items(), key=lambda item: -item[1]))
    index_rows.append({
        'session_id': main_id, 'tool': runs_info['main_tool'], 'model': model_text, 'started_at': started, 'ended_at': ended,
        'export_file': f'ai/sessions/{main_file}', 'purpose': runs_info['main_purpose'], 'related_commits': ' '.join(filter(None, runs_info['main_commits'])),
    })
    for line, stamp, name, data, result in tool_calls(main_entries):
        action, target = describe_call(name, data)
        state, size = result_state(result)
        action_rows.append([stamp, main_id, line, name, one_line(action, 240), target, state, size])

    base = os.path.join(sessions, 'subagents')
    for run in sorted(os.listdir(base)) if os.path.isdir(base) else []:
        run_dir = os.path.join(base, run)
        if not os.path.isdir(run_dir):
            continue
        info = runs_info['runs'].get(run, {})
        record = {}
        if os.path.exists(os.path.join(run_dir, 'run.json')):
            with open(os.path.join(run_dir, 'run.json'), encoding='utf-8') as handle:
                record = json.load(handle)
        labels, outcomes = {}, {}
        journal = os.path.join(run_dir, 'journal.jsonl')
        if os.path.exists(journal):
            for item in read_jsonl(journal):
                if item.get('type') == 'started':
                    labels[item.get('agentId')] = item.get('label')
                elif item.get('type') == 'result':
                    outcomes[item.get('agentId')] = item.get('result')
        section = [f'## {run} — {record.get("workflowName", "")}', '', info.get('purpose', ''), '']
        if record.get('summary'):
            section += [f'Task given to the run: {record["summary"]}', '']
        section += [f'Related commits: {" ".join(filter(None, info.get("commits", []))) or "—"}', '',
                    '| sub-agent | label | model | started (UTC) | ended (UTC) | tool calls | outcome |', '| --- | --- | --- | --- | --- | --- | --- |']
        for name in sorted(os.listdir(run_dir)):
            if not (name.startswith('agent-') and (name.endswith('.jsonl') or name.endswith('.jsonl.gz'))):
                continue
            agent_id = name.split('.')[0][len('agent-'):]
            entries = read_jsonl(os.path.join(run_dir, name))
            first, last = timestamps(entries)
            meta_path = os.path.join(run_dir, f'agent-{agent_id}.meta.json')
            meta = json.load(open(meta_path, encoding='utf-8')) if os.path.exists(meta_path) else {}
            agent_models = models_of(entries)
            model = '; '.join(sorted(agent_models))
            if not model and meta.get('model'):
                # no answer of a model is in the file: the session ended before the first one
                model = f"{meta['model']} (requested; the file records no response of a model)"
            label = labels.get(agent_id) or meta.get('description', '')
            calls = list(tool_calls(entries))
            session_id = f'{run}/agent-{agent_id}'
            if agent_id in outcomes:
                result = outcomes[agent_id]
                findings = result.get('findings') if isinstance(result, dict) else None
                outcome = 'returned a result' + (f' ({len(findings)} findings)' if isinstance(findings, list) else '')
                if isinstance(result, str) and result.startswith('[REDACTED'):
                    note = re.search(r'; (\d+ findings[^;]*);', result)
                    outcome = 'returned a result' + (f' ({note.group(1)}; the text is withheld)' if note else ' (the text is withheld)')
            else:
                last_text = ''
                for entry in reversed(entries):
                    message = entry.get('message')
                    if entry.get('type') == 'assistant' and isinstance(message, dict):
                        last_text = text_of(message.get('content'))
                        if last_text.strip():
                            break
                outcome = 'no result: ' + one_line(last_text, 110) if last_text.strip() else 'no result recorded'
            index_rows.append({
                'session_id': session_id, 'tool': f'{runs_info["subagent_tool"]} (run {run})', 'model': model, 'started_at': first, 'ended_at': last,
                'export_file': f'ai/sessions/subagents/{run}/{name}', 'purpose': f'{label}: {info.get("purpose", "")}'.strip(': '),
                'related_commits': ' '.join(filter(None, info.get('commits', []))),
            })
            for line, stamp, tool, data, result in calls:
                action, target = describe_call(tool, data)
                state, size = result_state(result)
                action_rows.append([stamp, session_id, line, tool, one_line(action, 240), target, state, size])
            section.append(f'| `{agent_id}` | {label} | {model} | {first[:19]} | {last[:19]} | {len(calls)} | {outcome} |')
        section += ['', f'Files: `{run}/agent-<id>.jsonl.gz` (the sub-agent\'s session), `agent-<id>.meta.json`, `journal.jsonl` (start and result of every sub-agent), '
                        '`run.json` (the tool\'s record of the run, with every returned result), `script.js` (the instructions the main session wrote for it).', '']
        overview.append('\n'.join(section))

    with open(os.path.join(sessions, 'redaction-report.json'), encoding='utf-8') as handle:
        report = json.load(handle)
    for run in report.get('subagent_runs', []):
        if run.get('included'):
            continue
        for session in run.get('sessions', []):
            index_rows.append({
                'session_id': f"{run['run']}/agent-{session['agent']}", 'tool': f'{runs_info["subagent_tool"]} (run {run["run"]})', 'model': session.get('model', ''),
                'started_at': session.get('started_at', ''), 'ended_at': session.get('ended_at', ''),
                'export_file': 'not exported (sub-agent of the unrelated request, see ai/README.md)',
                'purpose': 'Sub-agent of the unrelated private request handled in the same session; not part of the assignment', 'related_commits': '',
            })
    # Sessions that began after the last exported line of the main session: named in runs.json,
    # because no exported file can hold them.
    for session in runs_info.get('sessions_after_export', []):
        index_rows.append({
            'session_id': session['session_id'], 'tool': f'{runs_info["subagent_tool"]} (run {session["run"]})', 'model': session.get('model', ''),
            'started_at': session.get('started_at', ''), 'ended_at': session.get('ended_at', ''),
            'export_file': 'not exported (started after the last exported line, see ai/completeness-declaration.md)',
            'purpose': session.get('purpose', ''), 'related_commits': ' '.join(filter(None, session.get('commits', []))),
        })
    with open(os.path.join(args.ai, 'session-index.csv'), 'w', encoding='utf-8', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['session_id', 'tool', 'model', 'started_at', 'ended_at', 'export_file', 'purpose', 'related_commits'])
        writer.writeheader()
        writer.writerows(index_rows)
    action_rows.sort(key=lambda row: (row[0], row[1], row[2]))
    with open(os.path.join(args.ai, 'tool-actions.csv'), 'w', encoding='utf-8', newline='') as handle:
        writer = csv.writer(handle)
        writer.writerow(['seq', 'timestamp_utc', 'session_id', 'line_in_export_file', 'tool', 'action', 'target', 'result', 'output_chars'])
        for seq, row in enumerate(action_rows, 1):
            writer.writerow([seq] + row)

    readable = os.path.join(sessions, 'readable')
    with open(os.path.join(sessions, 'redaction-report.json'), encoding='utf-8') as handle:
        unrelated = lines_of(json.load(handle)['main_session'].get('line ranges of the unrelated request', []))
    parts = render_main(main_entries, main_file, readable, unrelated)
    with open(os.path.join(readable, 'README.md'), 'w', encoding='utf-8') as handle:
        handle.write(runs_info['readable_intro'].rstrip() + '\n\n| part | lines of the `.jsonl` | from (UTC) | to (UTC) |\n| --- | --- | --- | --- |\n')
        for name, first, last, first_line, last_line in parts:
            handle.write(f'| [{name}]({name}) | {first_line}–{last_line} | {first[:19]} | {last[:19]} |\n')
    with open(os.path.join(base, 'README.md'), 'w', encoding='utf-8') as handle:
        handle.write(runs_info['subagents_intro'].rstrip() + '\n\n' + '\n'.join(overview))
    print(json.dumps({'sessions': len(index_rows), 'tool_actions': len(action_rows), 'readable_parts': len(parts),
                      'main_lines': len(main_entries), 'main_models': models}, ensure_ascii=False, indent=1))


if __name__ == '__main__':
    main()
