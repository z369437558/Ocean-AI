#!/usr/bin/env python3
"""
Export the native Claude Code transcripts of one session into ai/sessions/.

The tool keeps one JSON Lines file per session (one JSON object per line: prompts, assistant
messages, tool calls, tool results, harness notices) and one more per sub-agent it started. This
script copies those files line by line and changes a line only where one of the rules below
applies. Every change leaves a marker of the form "[REDACTED: reason]" in place of the removed
text, so the position, the kind and the size of what was removed stay visible.

What is replaced
  1. Binary payloads: base64 image data and the opaque signatures attached to reasoning blocks.
  2. Material of the tool vendor: the built-in system prompt, bundled reference texts, and the
     catalogue of tools and connectors available in the account.
  3. Private data that has nothing to do with the assignment: entries (given by line number in
     the private configuration) that belong to another request handled in the same session, and
     any later line that names it.
  4. Identifiers: the candidate's e-mail address, account identifiers, model identifiers.

Everything that names private terms lives in a configuration file that is not part of the
repository (the terms themselves are what must not be published). The rules are generic.

Usage:  export_sessions.py --config private-config.json --out <directory>
"""
import argparse
import collections
import contextlib
import copy
import gzip
import hashlib
import io
import json
import os
import re
import sys

MARK = '[REDACTED: {}]'


def mark(reason):
    return MARK.format(reason)


class Rules:
    """The compiled redaction rules of one export run, and the counters they fill."""

    def __init__(self, config):
        self.config = config
        self.counts = collections.Counter()
        self.withheld_lines = []  # running text (messages, notes, summaries) that the line rules have replaced
        self.anchor = re.compile(config['assignment_words'], re.I) if config.get('assignment_words') else None
        self.keyword = re.compile(config['private_keywords'], re.I) if config.get('private_keywords') else None
        # Words that point to the unrelated request when the assistant writes about it, but are
        # ordinary words in the commands and outputs of the assignment (a test may say "PDF" too).
        wider = '|'.join(filter(None, [config.get('private_keywords'), config.get('private_keywords_in_text')]))
        self.keyword_text = re.compile(wider, re.I) if wider else None
        self.prep = False  # set while the entries that prepared this export are written: the wider set applies to everything
        self.tokens = [(re.compile(rx, re.I), mark(reason)) for rx, reason in config.get('private_tokens', [])]
        self.literals = [(re.compile(re.escape(text), re.I), mark(reason)) for text, reason in config.get('literals', {}).items()]
        families = config.get('model_families', {})
        self.model_alias = {family.lower(): alias for family, alias in families.items()}
        if families:
            names = '|'.join(sorted(map(re.escape, families), key=len, reverse=True))
            # Technical identifiers ("vendor-family-1-2", with an optional "[suffix]") and product
            # names ("Vendor Family 1.2", "Family 1.2", or the family name on its own).
            self.model_rx = re.compile(
                r'\bclaude-(?:\d+-)+(' + names + r')(?:-\d+)*'
                r'|\bclaude-(' + names + r')(?:-\d+)+(?:\[\w+\])?'
                r'|\b(?:claude\s+)?(' + names + r')\b(?:\s+\d+(?:\.\d+)?)?',
                re.I)
        else:
            self.model_rx = None

    # -- single strings ----------------------------------------------------------------------

    def identifiers(self, text):
        """Replacements that apply everywhere, including dictionary keys."""
        for rx, replacement in self.literals:
            text, n = rx.subn(replacement, text)
            if n:
                self.counts[replacement] += n
        if len(text) >= ENCODED_MIN and ENCODED.search(text):
            def encoded(match):
                run = match.group(0)
                if len(set(run)) < 20:  # a long run of few different characters is test data, not an encoding
                    return run
                self.counts[mark(ENCODED_REASON)] += 1
                return mark(f'{ENCODED_REASON}, {len(run)} characters')
            text = ENCODED.sub(encoded, text)
        if self.model_rx is not None:
            def alias(match):
                family = (match.group(1) or match.group(2) or match.group(3)).lower()
                replacement = mark('model identifier ' + self.model_alias[family])
                self.counts[replacement] += 1
                return replacement
            text = self.model_rx.sub(alias, text)
        return text

    def named(self, text):
        """Names of files, directories and jobs of the unrelated request, then the identifiers."""
        for rx, replacement in self.tokens:
            text, n = rx.subn(replacement, text)
            if n:
                self.counts[replacement] += n
        return self.identifiers(text)

    def scrub(self, text):
        """A string of an entry that belongs to the assignment."""
        for rx, replacement in self.tokens:
            text, n = rx.subn(replacement, text)
            if n:
                self.counts[replacement] += n
        keyword = self.keyword_text if self.prep else self.keyword
        if keyword is not None and keyword.search(text):
            replacement = mark(self.config['reason_line'])
            lines = text.split('\n')
            for number, line in enumerate(lines):
                if keyword.search(line):
                    lines[number] = replacement
                    self.counts[replacement] += 1
            text = '\n'.join(lines)
        return self.identifiers(text)

    def private_lines(self, text):
        """How many different lines of a text name the unrelated request."""
        if self.keyword_text is None:
            return 0
        return sum(1 for line in set(text.split('\n'))
                   if self.keyword_text.search(line) or any(rx.search(line) for rx, _ in self.tokens))

    def by_sentence(self, line, extra=()):
        """A line of a message that names the unrelated request: withhold from the first sentence
        that names it to the end of the line, or to the next sentence that is plainly about the
        assignment again. Returns None when the whole line goes."""
        if self.anchor is None:
            return None
        sentences = [piece for piece in SENTENCE.split(line) if piece]
        if len(sentences) < 2:
            return None
        private = lambda piece: bool(self.keyword_text.search(piece)) or any(term in piece for term in extra)
        kept, withholding, replaced = [], False, 0
        for piece in sentences:
            if private(piece):
                withholding = True
            elif withholding and self.anchor.search(piece):
                withholding = False
            if withholding:
                self.withheld_lines.append(piece)
                if not kept or kept[-1] is not MARK_SENTENCE:
                    kept.append(MARK_SENTENCE)
                    replaced += 1
            else:
                kept.append(piece)
        if all(piece is MARK_SENTENCE for piece in kept):
            return None
        marker = mark(self.config['reason_line'])
        self.counts[marker] += replaced
        return ''.join(marker if piece is MARK_SENTENCE else piece for piece in kept)

    def scrub_prose(self, text, extra=(), sentences=False):
        """Running text (messages, summaries): a withheld line takes the items below it along."""
        if self.keyword_text is None:
            return self.scrub(text)
        for rx, replacement in self.tokens:  # names first: what is left decides about the line
            text, n = rx.subn(replacement, text)
            if n:
                self.counts[replacement] += n
        original = text.split('\n')
        lines = list(original)
        replacement = mark(self.config['reason_line'])
        hit = [bool(self.keyword_text.search(line)) or any(term in line for term in extra) for line in original]
        number = 0
        while number < len(lines):
            if not hit[number]:
                number += 1
                continue
            partly = self.by_sentence(original[number], extra) if sentences else None
            if partly is not None:
                lines[number] = partly
            else:
                self.withheld_lines.append(original[number])
                lines[number] = replacement
                self.counts[replacement] += 1
            base, base_is_item = indent_of(original[number]), is_list_item(original[number])
            follow = number + 1
            while follow < len(lines) and original[follow].strip():
                deeper = indent_of(original[follow]) > base
                if deeper or (not base_is_item and is_list_item(original[follow])):
                    self.withheld_lines.append(original[follow])
                    lines[follow] = replacement
                    self.counts[replacement] += 1
                    follow += 1
                else:
                    break
            number = follow
        return self.identifiers('\n'.join(lines))

    def quotes_in(self, text, quotes, at_least=1):
        if not quotes:
            return False
        found = grams_of(text, collections.Counter()) & quotes
        return len(found) >= at_least

    def scrub_quotes(self, node, quotes):
        """While this export was prepared: withhold lines that repeat words of the withheld entries."""
        if isinstance(node, str):
            if not self.quotes_in(node, quotes):
                return node
            replacement = mark(self.config['reason_quote'])
            lines = node.split('\n')
            for number, line in enumerate(lines):
                if line.strip() and self.quotes_in(line, quotes):
                    lines[number] = replacement
                    self.counts[replacement] += 1
            return '\n'.join(lines)
        if isinstance(node, list):
            return [self.scrub_quotes(item, quotes) for item in node]
        if isinstance(node, dict):
            return {key: (value if key in NOT_CONTENT else self.scrub_quotes(value, quotes)) for key, value in node.items()}
        return node

    # -- structures --------------------------------------------------------------------------

    def binary(self, node):
        """Replace binary payloads inside a structure. Returns the structure."""
        if isinstance(node, dict):
            for key, value in list(node.items()):
                if key == 'signature' and isinstance(value, str) and len(value) > 40:
                    node[key] = mark(f'opaque signature of a reasoning block, {len(value)} characters')
                    self.counts[mark('opaque signature of a reasoning block')] += 1
                elif key in ('data', 'base64') and isinstance(value, str) and len(value) > 512 and looks_base64(value):
                    digest = hashlib.sha256(value.encode('ascii', 'replace')).hexdigest()[:16]
                    node[key] = mark(f'binary data (base64), {len(value)} characters, sha256 of the base64 text {digest}')
                    self.counts[mark('binary data (base64)')] += 1
                else:
                    node[key] = self.binary(value)
            return node
        if isinstance(node, list):
            return [self.binary(item) for item in node]
        return node

    def walk(self, node):
        """Apply the string rules to every string of a structure, keys included."""
        if isinstance(node, str):
            return self.scrub(node)
        if isinstance(node, list):
            return [self.walk(item) for item in node]
        if isinstance(node, dict):
            return {self.named(key): self.walk(value) for key, value in node.items()}
        return node


BASE64_HEAD = re.compile(r'^[A-Za-z0-9+/=\r\n]+$')
ENCODED_MIN = 300
ENCODED = re.compile(r'[A-Za-z0-9+/]{%d,}={0,2}' % ENCODED_MIN)
ENCODED_REASON = 'encoded data inside a text, such as a script in a process listing of the container (not conversation content)'
SENTENCE = re.compile(r'(?<=[。！？；;])|(?<=[.!?])(?=\s)')
MARK_SENTENCE = object()
LIST_ITEM = re.compile(r'^\s*(?:[-*•]\s|\d+[.)]\s|\|)')


def indent_of(line):
    return len(line) - len(line.lstrip(' \t'))


def is_list_item(line):
    return bool(LIST_ITEM.match(line))


def looks_base64(text):
    return bool(BASE64_HEAD.match(text[:2048]))


CJK_RUN = re.compile(r'[\u3400-\u9fff]+')
PATH = re.compile(r'(?:/[\w.@~+\-]+){2,}/?')
WORD = re.compile(r'[A-Za-z0-9]+')
NOT_CONTENT = {'signature', 'data', 'base64', 'uuid', 'parentUuid', 'sessionId', 'requestId', 'id', 'tool_use_id',
               'promptId', 'sourceToolUseID', 'sourceToolAssistantUUID', 'cwd', 'timestamp', 'version', 'slug'}


def strings_of(node, found=None):
    """The text a structure carries (identifiers and binary fields left out)."""
    found = [] if found is None else found
    if isinstance(node, str):
        found.append(node)
    elif isinstance(node, list):
        for item in node:
            strings_of(item, found)
    elif isinstance(node, dict):
        for key, value in node.items():
            if key not in NOT_CONTENT:
                strings_of(value, found)
    return found


def grams_of(text, counts=None):
    """Pieces of a text: runs of 5 Chinese characters and sequences of 8 words (the long pieces).

    Returns the set of long pieces; short pieces (2 and 3 characters, single words) are counted in
    `counts` when it is given, and returned as part of the set otherwise.
    """
    long_pieces, short_pieces = set(), []
    text = PATH.sub(' ', text)  # a path shared with a withheld entry says nothing about its content
    for run in CJK_RUN.findall(text):
        for size in (2, 3):
            short_pieces.extend(run[i:i + size] for i in range(len(run) - size + 1))
        long_pieces.update(run[i:i + 5] for i in range(len(run) - 4))
    words = [word.lower() for word in WORD.findall(text)]
    short_pieces.extend(word for word in words if len(word) >= 5 and not word.isdigit())
    long_pieces.update(' '.join(words[i:i + 8]) for i in range(len(words) - 7))
    if counts is None:
        long_pieces.update(short_pieces)
    else:
        counts.update(short_pieces)
    return long_pieces


def size_of(value):
    return len(value) if isinstance(value, str) else len(json.dumps(value, ensure_ascii=False))


# ---------------------------------------------------------------------------------------------
# Entries of the main session
# ---------------------------------------------------------------------------------------------

# Harness attachments that carry vendor material or the account's catalogue instead of conversation.
VENDOR_ATTACHMENTS = {
    'prompt_snapshot': 'built-in system prompt and tool definitions of the AI tool (vendor material)',
    'skill_listing': 'catalogue of skills available in the account (account configuration)',
    'deferred_tools_record': 'catalogue of tools and connectors available in the account (account configuration)',
    'deferred_tools_delta': 'catalogue of tools and connectors available in the account (account configuration)',
    'mcp_instructions_delta': 'instructions of the connectors available in the account (account configuration)',
    'agent_listing_delta': 'catalogue of agent types of the AI tool (vendor material)',
    'invoked_skills': 'bundled reference text of the AI tool (vendor material)',
}

REMINDER = 'reminder or instruction text of the AI tool (vendor material)'
RENDERED_KEYS = ('rendered', 'renderedInHumanTurn')  # the text the tool made of an attachment for the model

# Keys of an entry that describe it without carrying conversation content.
STRUCTURAL_KEYS = {
    'type', 'uuid', 'parentUuid', 'logicalParentUuid', 'timestamp', 'sessionId', 'agentId', 'isSidechain', 'isMeta',
    'isCompactSummary', 'isVisibleInTranscriptOnly', 'isApiErrorMessage', 'userType', 'entrypoint', 'cwd', 'version',
    'gitBranch', 'slug', 'requestId', 'promptId', 'sourceToolUseID', 'sourceToolAssistantUUID', 'permissionMode',
    'operation', 'subtype', 'apiBlockIndex', 'effort', 'perTurnEffort', 'thinkingDurationMs', 'toolInputStreamMs',
    'level', 'toolUseID', 'mode', 'clientPlatform', 'sandboxed', 'madeBy', 'thinkingDisplay', 'promptCacheRequested',
    'stopReason', 'hookCount', 'hasOutput', 'preventedContinuation', 'toolEndsTurn', 'origin', 'promptSource',
    'rowSource', 'turnPosition', 'turnOrigin', 'deliveryId', 'commandUuid', 'leafUuid', 'requestedModel',
    'advisorModel', 'error', 'apiErrorStatus', 'apiErrorType',
}
MESSAGE_KEYS = {'id', 'type', 'role', 'model', 'stop_reason', 'stop_sequence', 'usage', 'container', 'context_management'}
PART_KEYS = {'type', 'id', 'name', 'tool_use_id', 'is_error', 'caller'}


def withhold(value, reason, rules):
    """The marker that stands for a removed value, with its size."""
    rules.counts[mark(reason)] += 1
    return mark(f'{reason}, {size_of(value)} characters')


def is_notice(entry):
    """Entries with which the tool reports the end of background work (they are not prompts)."""
    kind = entry.get('type')
    if kind == 'queue-operation':
        text = entry.get('content')
    elif kind == 'attachment':
        text = (entry.get('attachment') or {}).get('prompt')
    elif kind == 'user':
        text = (entry.get('message') or {}).get('content')
    else:
        return False
    return isinstance(text, str) and text.lstrip().startswith('<task-notification>')


def redact_unrelated(entry, reason, rules):
    """An entry of the unrelated request: keep its skeleton, withhold what it says."""
    if is_notice(entry):
        reason = rules.config.get('reason_unrelated_notice', reason)
    out = {}
    empty = lambda value: value is None or isinstance(value, (bool, int, float)) or value in ('', [], {})
    for key, value in entry.items():
        if key in STRUCTURAL_KEYS or empty(value):
            out[key] = value
        elif key == 'message' and isinstance(value, dict):
            message = {}
            for mkey, mvalue in value.items():
                if mkey in MESSAGE_KEYS or empty(mvalue):
                    message[mkey] = mvalue
                elif mkey == 'content':
                    if isinstance(mvalue, str):
                        message[mkey] = withhold(mvalue, reason, rules)
                    else:
                        parts = []
                        for part in mvalue or []:
                            if not isinstance(part, dict):
                                parts.append(withhold(part, reason, rules))
                                continue
                            kept = {}
                            for pkey, pvalue in part.items():
                                if pkey in PART_KEYS or empty(pvalue):
                                    kept[pkey] = pvalue
                                elif pkey == 'input':
                                    kept[pkey] = {'redacted': withhold(pvalue, reason, rules)}
                                else:
                                    kept[pkey] = withhold(pvalue, reason, rules)
                            parts.append(kept)
                        message[mkey] = parts
                else:
                    message[mkey] = withhold(mvalue, reason, rules)
            out[key] = message
        elif key == 'attachment' and isinstance(value, dict):
            out[key] = {'type': value.get('type'), 'redacted': withhold(value, reason, rules)}
        else:
            out[key] = withhold(value, reason, rules)
    return named_only(out, rules)


def named_only(node, rules):
    """Skeletons and entries kept word for word: named tokens and identifiers only."""
    if isinstance(node, str):
        return rules.named(node)
    if isinstance(node, list):
        return [named_only(item, rules) for item in node]
    if isinstance(node, dict):
        return {rules.named(key): named_only(value, rules) for key, value in node.items()}
    return node


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return '\n'.join(part.get('text', '') if isinstance(part, dict) else str(part) for part in content)
    return ''


def vendor_text_reason(entry, config):
    """Meta messages with which the tool loads one of its bundled reference texts."""
    if entry.get('type') != 'user' or not entry.get('isMeta'):
        return None
    text = text_of((entry.get('message') or {}).get('content'))
    for prefix in config.get('vendor_text_prefixes', []):
        if text.startswith(prefix):
            return 'bundled reference text of the AI tool (vendor material)'
    return None


def redact_related(entry, rules, call_names, index=None, quotes=None, quote_messages=False, withheld_calls=frozenset()):
    """An entry that belongs to the assignment: binary data, vendor material, identifiers."""
    config = rules.config
    entry = rules.binary(entry)

    if entry.get('type') == 'attachment':
        attachment = entry.get('attachment') or {}
        kind = attachment.get('type')
        reason = VENDOR_ATTACHMENTS.get(kind)
        if reason:
            entry['attachment'] = {'type': kind, 'redacted': withhold(attachment, reason, rules)}
        # "rendered" is the text the tool made of the attachment for the model: its own reminder
        # and instruction texts. Only a message of the candidate is kept there as it is.
        for key in RENDERED_KEYS:
            if entry.get(key) and kind != 'queued_command':
                entry[key] = withhold(entry[key], reason or REMINDER, rules)
        if kind == 'tool_hosts_notice' and attachment.get('lines'):
            attachment['lines'] = withhold(attachment['lines'], REMINDER, rules)
        if kind == 'model' and attachment.get('text'):
            attachment['text'] = withhold(attachment['text'], REMINDER, rules)  # the identity fields next to it stay
        if kind == 'session_context' and attachment.get('context'):
            attachment['context'] = withhold(attachment['context'], REMINDER, rules)

    if entry.get('type') == 'system' and isinstance(entry.get('compactMetadata'), dict):
        kept = entry['compactMetadata']
        for key, reason in (('preCompactDiscoveredTools', VENDOR_ATTACHMENTS['deferred_tools_record']),
                            ('preCompactArtifactReadVersions', config['reason_unrelated'])):
            if kept.get(key):
                kept[key] = withhold(kept[key], reason, rules)

    reason = vendor_text_reason(entry, config)
    if reason:
        content = entry['message']['content']
        marker = withhold(text_of(content), reason, rules)
        entry['message']['content'] = marker if isinstance(content, str) else [{'type': 'text', 'text': marker}]

    # Results of tools whose whole answer is private (named in the configuration), and results that
    # mostly show material of the unrelated request (several of their lines name it).
    by_tool = config.get('result_redactions_by_tool', {})
    threshold = config.get('result_private_line_threshold') if quotes is not None else None  # preparation phase only
    message = entry.get('message')
    if entry.get('type') == 'user' and isinstance(message, dict) and isinstance(message.get('content'), list):
        # What the tool printed is in the result and, sometimes at greater length, next to it.
        beside = '\n'.join(strings_of(entry.get('toolUseResult'))) if entry.get('toolUseResult') is not None else ''
        for part in message['content']:
            if isinstance(part, dict) and part.get('type') == 'tool_result':
                shown = text_of(part.get('content')) + '\n' + beside
                reason = by_tool.get(call_names.get(part.get('tool_use_id')))
                if not reason and part.get('tool_use_id') in withheld_calls:
                    reason = config.get('reason_command_output', config['reason_quote'])
                if not reason and index is not None and index + 1 in config.get('prep_withheld_result_lines', []):
                    reason = config['reason_review_shown']
                if not reason and index is not None and index + 1 in config.get('private_result_lines', []):
                    reason = config['reason_result']
                if not reason and threshold and rules.private_lines(shown) >= threshold:
                    reason = config['reason_result']
                if not reason and quotes and rules.quotes_in(shown, quotes, at_least=2):
                    reason = config['reason_quote']
                if not reason and quotes and isinstance(part.get('content'), (str, list)):
                    part['content'] = rules.scrub_quotes(part['content'], quotes)  # a single passage: that line only
                if reason:
                    part['content'] = withhold(part.get('content'), reason, rules)
                    for key in ('toolUseResult', 'mcpMeta'):
                        if entry.get(key) is not None:
                            entry[key] = withhold(entry[key], reason, rules)

    # Running text: assistant messages, prompts and summaries.
    extra = tuple(config.get('entry_terms', {}).get(str(index), ())) if index is not None else ()
    line = None if index is None else index + 1
    if isinstance(message, dict) and entry.get('type') in ('user', 'assistant'):
        content = message.get('content')
        by_sentence = entry.get('type') == 'assistant'  # summaries and notices go line by line
        if isinstance(content, str):
            message['content'] = rules.scrub_prose(content, extra)
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                for key in ('text', 'thinking'):
                    if part.get('type') == key and isinstance(part.get(key), str) and part[key]:
                        if line in config.get('inline_term_lines', []):
                            part[key] = inline_terms(part[key], rules)
                        else:
                            part[key] = rules.scrub_prose(part[key], extra, sentences=by_sentence)
                if part.get('type') == 'tool_use':
                    if line in config.get('prep_withheld_lines', []):
                        # a command of the preparation that had the private terms in it
                        part['input'] = {'redacted': withhold(part.get('input'), config.get('reason_command', config['reason_quote']), rules)}
                    elif line in config.get('inline_term_lines', []):
                        # a command worth reading that names private terms: only the terms go
                        part['input'] = inline_terms(part.get('input'), rules)
        if line in config.get('prep_withheld_lines', []) and entry.get('wireToolInputs') is not None:
            entry['wireToolInputs'] = withhold(entry['wireToolInputs'], config.get('reason_command', config['reason_quote']), rules)
        elif line in config.get('inline_term_lines', []) and entry.get('wireToolInputs') is not None:
            entry['wireToolInputs'] = inline_terms(entry['wireToolInputs'], rules)
    entry = rules.walk(entry)
    # While the export was prepared, commands were run on the withheld entries themselves. Lines of
    # those commands that repeat a passage of the withheld entries are withheld too (their results
    # are handled above). Prompts and messages are not touched by this rule.
    if quotes and entry.get('type') == 'user' and entry.get('toolUseResult') is not None:
        entry['toolUseResult'] = rules.scrub_quotes(entry['toolUseResult'], quotes)
    if quotes and entry.get('type') == 'assistant' and isinstance(entry.get('message'), dict):
        for part in entry['message'].get('content') or []:
            if isinstance(part, dict) and part.get('type') == 'tool_use':
                part['input'] = rules.scrub_quotes(part.get('input'), quotes)
            elif quote_messages and isinstance(part, dict) and part.get('type') == 'text':
                part['text'] = rules.scrub_quotes(part.get('text'), quotes)
        if entry.get('wireToolInputs') is not None:
            entry['wireToolInputs'] = rules.scrub_quotes(entry['wireToolInputs'], quotes)
    # Notices about background work carry what that work returned.
    if quotes and is_notice(entry) and any(marker in json.dumps(entry, ensure_ascii=False) for marker in config.get('review_markers', [])):
        reason = config['reason_review_result']
        kind = entry.get('type')
        if kind == 'queue-operation':
            entry['content'] = withhold(entry['content'], reason, rules)
        elif kind == 'attachment':
            entry['attachment']['prompt'] = withhold(entry['attachment']['prompt'], reason, rules)
            for key in RENDERED_KEYS:  # the same notice as the tool rendered it for the model
                if entry.get(key):
                    entry[key] = withhold(entry[key], reason, rules)
        else:
            entry['message']['content'] = withhold(entry['message']['content'], reason, rules)
    elif quotes:
        kind = entry.get('type')
        if kind == 'queue-operation' and isinstance(entry.get('content'), str) and '<task-notification>' in entry['content']:
            entry['content'] = rules.scrub_quotes(entry['content'], quotes)
        elif kind == 'attachment' and isinstance((entry.get('attachment') or {}).get('prompt'), str) and '<task-notification>' in entry['attachment']['prompt']:
            entry['attachment']['prompt'] = rules.scrub_quotes(entry['attachment']['prompt'], quotes)
            for key in RENDERED_KEYS:
                if entry.get(key):
                    entry[key] = rules.scrub_quotes(entry[key], quotes)
        elif kind == 'user' and isinstance(entry.get('message'), dict):
            content = entry['message'].get('content')
            if isinstance(content, str) and content.lstrip().startswith('<task-notification>'):
                entry['message']['content'] = rules.scrub_quotes(content, quotes)
            elif quote_messages and isinstance(content, str):
                entry['message']['content'] = rules.scrub_quotes(content, quotes)
            elif quote_messages and isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get('type') == 'text':
                        part['text'] = rules.scrub_quotes(part.get('text'), quotes)
    return entry




def inline_terms(node, rules):
    """Replace the private terms inside a structure's strings, and nothing around them."""
    if isinstance(node, str):
        marker = mark('private term')
        for rx, replacement in rules.tokens:
            node, m = rx.subn(replacement, node)
            rules.counts[replacement] += m
        node, n = rules.keyword_text.subn(marker, node)
        rules.counts[marker] += n
        return node
    if isinstance(node, list):
        return [inline_terms(item, rules) for item in node]
    if isinstance(node, dict):
        return {key: inline_terms(value, rules) for key, value in node.items()}
    return node


def classify_main(entries, config):
    """Which entries of the main session belong to the unrelated request (index -> True)."""
    unrelated = set()
    for first, last in config.get('unrelated_ranges', []):
        unrelated.update(range(first, last + 1))
    unrelated.update(config.get('unrelated_entries', []))
    call_names, unrelated_calls = {}, set()
    for index, entry in enumerate(entries):
        message = entry.get('message')
        if entry.get('type') == 'assistant' and isinstance(message, dict):
            for part in message.get('content') or []:
                if isinstance(part, dict) and part.get('type') == 'tool_use':
                    call_names[part.get('id')] = part.get('name')
                    if index in unrelated:
                        unrelated_calls.add(part.get('id'))
    markers = config.get('unrelated_markers', [])
    for index, entry in enumerate(entries):
        if index in unrelated:
            continue
        message = entry.get('message')
        if entry.get('type') == 'user' and isinstance(message, dict) and isinstance(message.get('content'), list):
            ids = {part.get('tool_use_id') for part in message['content'] if isinstance(part, dict) and part.get('type') == 'tool_result'}
            if ids and ids <= unrelated_calls:
                unrelated.add(index)
                continue
        # Notices about background work of the unrelated request (they quote its results).
        if markers:
            kind = entry.get('type')
            carrier = None
            if kind == 'queue-operation':
                carrier = entry.get('content')
            elif kind == 'attachment' and (entry.get('attachment') or {}).get('type') == 'queued_command':
                carrier = (entry.get('attachment') or {}).get('prompt')
            elif kind == 'user' and isinstance(message, dict) and isinstance(message.get('content'), str):
                carrier = message['content'] if message['content'].lstrip().startswith('<task-notification>') else None
            if isinstance(carrier, str) and '<task-notification>' in carrier and any(marker in carrier for marker in markers):
                unrelated.add(index)
    return unrelated, call_names


def quotes_of(entries, unrelated, verbatim, baseline):
    """Pieces of text that occur in the withheld entries and nowhere in the entries exported before."""
    pieces = set()
    for index in sorted(unrelated - verbatim):
        pieces |= grams_of('\n'.join(strings_of(entries[index])), collections.Counter())
    return pieces - baseline


def dump(entry):
    return json.dumps(entry, ensure_ascii=False, separators=(',', ':'))


def export_main(config, rules, out_dir):
    with open(config['session_file'], encoding='utf-8') as handle:
        lines = [line.rstrip('\n') for line in handle if line.strip()]
    limit = config.get('last_line')
    if limit:
        lines = lines[:limit]
    entries = [json.loads(line) for line in lines]
    unrelated, call_names = classify_main(entries, config)
    withheld_lines = set(config.get('prep_withheld_lines', []))
    withheld_calls = {part.get('id') for number, entry in enumerate(entries, 1) if number in withheld_lines and entry.get('type') == 'assistant'
                      for part in (entry.get('message') or {}).get('content') or [] if isinstance(part, dict) and part.get('type') == 'tool_use'}
    verbatim = set(config.get('verbatim_entries', []))
    reason = config['reason_unrelated']
    report = collections.Counter()
    prep_start = config.get('prep_start')
    baseline, quotes, taken = set(), None, 0
    withheld_numbers = []
    name = f"{config['session_id']}.jsonl"
    path = os.path.join(out_dir, name)
    with open(path, 'w', encoding='utf-8') as handle:
        for index, entry in enumerate(entries):
            original = dump(entry)
            if index in verbatim:
                # The request itself, in the candidate's words: kept as typed.
                result = named_only(rules.binary(copy.deepcopy(entry)), rules)
            elif index in unrelated:
                result = redact_unrelated(copy.deepcopy(entry), reason, rules)
            elif prep_start is not None and index >= prep_start:
                rules.prep = True
                if quotes is None:
                    quotes = quotes_of(entries, unrelated, verbatim, baseline)
                seen = len(rules.withheld_lines)
                quotes |= grams_of('\n'.join(rules.withheld_lines[taken:]), collections.Counter()) - baseline
                taken = seen
                result = redact_related(copy.deepcopy(entry), rules, call_names, index, quotes, withheld_calls=withheld_calls)
            else:
                result = redact_related(copy.deepcopy(entry), rules, call_names, index)
                if prep_start is not None:
                    baseline |= grams_of('\n'.join(strings_of(result)), collections.Counter())
            text = dump(result)
            if index in unrelated and index not in verbatim:
                withheld_numbers.append(index + 1)  # also the tool's own bookkeeping lines in between, which carry no text
            if text == original:
                report['lines identical to the tool\'s file'] += 1
            elif index in unrelated and index not in verbatim:
                report['lines of the unrelated request with their content withheld'] += 1
            else:
                report['other lines with at least one replacement'] += 1
            handle.write(text + '\n')
    rules.prep = False
    report['lines'] = len(entries)
    report = dict(report)
    report['line ranges of the unrelated request'] = ranges_of(withheld_numbers)
    if quotes is not None:
        quotes |= grams_of('\n'.join(rules.withheld_lines[taken:]), collections.Counter()) - baseline
        report['passages known only from withheld text (used by the rule for the preparation phase)'] = len(quotes)
    return path, report, quotes


def ranges_of(numbers):
    """[3, 4, 5, 9] -> ['3-5', '9']"""
    out, start, last = [], None, None
    for number in sorted(numbers):
        if start is None:
            start = last = number
        elif number == last + 1:
            last = number
        else:
            out.append(f'{start}-{last}' if last > start else str(start))
            start = last = number
    if start is not None:
        out.append(f'{start}-{last}' if last > start else str(start))
    return out


# ---------------------------------------------------------------------------------------------
# Sub-agent sessions
# ---------------------------------------------------------------------------------------------

def findings_note(result):
    """'14 findings: 1 blocker, 5 major, ...' for a review result, so that its size stays visible."""
    findings = result.get('findings') if isinstance(result, dict) else None
    if not isinstance(findings, list):
        return ''
    counts = collections.Counter(str(item.get('severity', 'unrated')) for item in findings if isinstance(item, dict))
    order = ['blocker', 'major', 'minor', 'nit']
    parts = [f'{counts[key]} {key}' for key in order if counts.get(key)] + [f'{n} {key}' for key, n in counts.items() if key not in order]
    return f'{len(findings)} findings' + (': ' + ', '.join(parts) if parts else '')


def review_result(result, rules):
    """The marker that stands for the result of a review of this export."""
    reason = rules.config['reason_review_result']
    note = findings_note(result)
    rules.counts[mark(reason)] += 1
    return mark(f'{reason}; {note + "; " if note else ""}{size_of(result)} characters')


def working_withheld(entry, reason, rules):
    """A session that handled the withheld material itself: keep its task and what it returned,
    withhold what it typed into tools, what the tools answered, and its notes on the way."""
    if entry.get('type') == 'attachment' and isinstance(entry.get('attachment'), dict):
        entry['attachment'] = {'type': entry['attachment'].get('type'), 'redacted': withhold(entry['attachment'], reason, rules)}
        for key in RENDERED_KEYS:
            if entry.get(key):
                entry[key] = withhold(entry[key], reason, rules)
        return entry
    message = entry.get('message')
    if entry.get('type') == 'user' and isinstance(message, dict) and isinstance(message.get('content'), str):
        # the task; where it hands over what other reviewers returned, that part is a review result
        for heading in rules.config.get('review_results_handed_over', []):
            task, found, handed = message['content'].partition(heading)
            if found and handed.strip():
                message['content'] = task + found + '\n' + withhold(handed, rules.config['reason_review_result'], rules)
                break
        return entry
    if not isinstance(message, dict) or not isinstance(message.get('content'), list):
        return entry
    for part in message['content']:
        if not isinstance(part, dict):
            continue
        if part.get('type') == 'tool_use' and part.get('name') == 'StructuredOutput':
            part['input'] = {'redacted': review_result(part.get('input'), rules)}
        elif part.get('type') == 'tool_use':
            part['input'] = {'redacted': withhold(part.get('input'), reason, rules)}
        elif part.get('type') == 'tool_result':
            part['content'] = withhold(part.get('content'), reason, rules)
        elif part.get('type') in ('text', 'thinking') and entry.get('type') == 'assistant':
            key = part['type']
            if isinstance(part.get(key), str) and part[key].strip():
                part[key] = withhold(part[key], reason, rules)
    for key in ('toolUseResult', 'wireToolInputs', 'mcpMeta'):
        if entry.get(key) is not None:
            entry[key] = withhold(entry[key], reason, rules)
    return entry


@contextlib.contextmanager
def compressed_writer(path):
    """A gzip text writer without a time stamp in the file, so that a second run gives the same bytes."""
    with open(path, 'wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=0) as packed:
            with io.TextIOWrapper(packed, encoding='utf-8') as text:
                yield text


def export_text_file(source, target, rules, compress=False, per_line_json=True, quotes=None, working=None):
    """Copy a JSON Lines (or JSON, or text) file with the rules for assignment entries applied."""
    opener = compressed_writer if compress else (lambda p: open(p, 'w', encoding='utf-8'))
    count = 0
    with open(source, encoding='utf-8') as reader, opener(target) as writer:
        if per_line_json:
            for line in reader:
                if not line.strip():
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    writer.write(rules.scrub(line.rstrip('\n')) + '\n')
                    continue
                if working:
                    entry = working_withheld(entry, working, rules)
                entry = redact_related(entry, rules, {}, None, quotes, quote_messages=bool(quotes))
                if quotes:
                    entry = rules.scrub_quotes(entry, quotes)
                writer.write(dump(entry) + '\n')
                count += 1
        else:
            text = rules.scrub(reader.read())
            writer.write(rules.scrub_quotes(text, quotes) if quotes else text)
    return count


def export_subagents(config, rules, out_dir, quotes=None):
    base = os.path.join(config['session_dir'], 'subagents', 'workflows')
    skipped = set(config.get('unrelated_runs', []))
    summary = []
    for run in sorted(os.listdir(base)):
        run_dir = os.path.join(base, run)
        if not os.path.isdir(run_dir):
            continue
        if run in config.get('runs_after_export', []):
            continue  # started after the last exported line of the main session; named in the session index
        if run in skipped:
            sessions = []
            for name in sorted(os.listdir(run_dir)):
                if not (name.startswith('agent-') and name.endswith('.jsonl')):
                    continue
                stamps, models = [], set()
                with open(os.path.join(run_dir, name), encoding='utf-8') as handle:
                    for line in handle:
                        try:
                            item = json.loads(line)
                        except ValueError:
                            continue
                        if isinstance(item.get('timestamp'), str):
                            stamps.append(item['timestamp'])
                        model = (item.get('message') or {}).get('model') if isinstance(item.get('message'), dict) else None
                        if item.get('type') == 'assistant' and model and model != '<synthetic>':
                            models.add(rules.identifiers(model))
                sessions.append({'agent': name[len('agent-'):-len('.jsonl')], 'started_at': min(stamps) if stamps else '',
                                 'ended_at': max(stamps) if stamps else '', 'model': '; '.join(sorted(models))})
            summary.append({'run': run, 'included': False, 'agents': len(sessions), 'sessions': sessions})
            continue
        target_dir = os.path.join(out_dir, 'subagents', run)
        os.makedirs(target_dir, exist_ok=True)
        agents = 0
        # Runs that checked this export looked at the withheld material: for them the rule of the
        # preparation phase applies as well.
        run_quotes = quotes if run in config.get('prep_runs', []) else None
        rules.prep = run_quotes is not None
        handled_private = set()  # sub-agents of such a run that were given the withheld material to work with
        if run_quotes is not None and os.path.exists(os.path.join(run_dir, 'journal.jsonl')):
            with open(os.path.join(run_dir, 'journal.jsonl'), encoding='utf-8') as handle:
                for line in handle:
                    try:
                        item = json.loads(line)
                    except ValueError:
                        continue
                    if item.get('type') == 'started':
                        handled_private.add(item.get('agentId'))
        for name in sorted(os.listdir(run_dir)):
            source = os.path.join(run_dir, name)
            if name.startswith('agent-') and name.endswith('.jsonl'):
                agent_id = name[len('agent-'):-len('.jsonl')]
                export_text_file(source, os.path.join(target_dir, name + ('.gz' if config.get('compress_subagents') else '')), rules,
                                 compress=bool(config.get('compress_subagents')), quotes=run_quotes,
                                 working=config['reason_working'] if agent_id in handled_private else None)
                agents += 1
            elif name.endswith('.meta.json'):
                with open(source, encoding='utf-8') as handle:
                    meta = json.load(handle)
                with open(os.path.join(target_dir, name), 'w', encoding='utf-8') as handle:
                    handle.write(json.dumps(rules.walk(meta), ensure_ascii=False) + '\n')
            elif name == 'journal.jsonl' and run_quotes is not None:
                with open(source, encoding='utf-8') as reader, open(os.path.join(target_dir, name), 'w', encoding='utf-8') as writer:
                    for line in reader:
                        if not line.strip():
                            continue
                        item = json.loads(line)
                        if 'result' in item:
                            item['result'] = review_result(item['result'], rules)
                        writer.write(dump(rules.walk(item)) + '\n')
            elif name == 'journal.jsonl':
                export_text_file(source, os.path.join(target_dir, name), rules, quotes=run_quotes)
            # *.prefix.json: cache bookkeeping of the tool (hashes and outlines of its own prompt) - not copied
        record = os.path.join(config['session_dir'], 'workflows', run + '.json')
        if os.path.exists(record):
            with open(record, encoding='utf-8') as handle:
                data = json.load(handle)
            if run_quotes is not None and 'result' in data:
                data['result'] = review_result(data['result'], rules)
            if run_quotes is not None:
                for item in data.get('workflowProgress') or []:
                    if isinstance(item, dict) and item.get('resultPreview'):
                        item['resultPreview'] = withhold(item['resultPreview'], config['reason_review_result'], rules)
                    if isinstance(item, dict) and item.get('lastToolSummary'):
                        item['lastToolSummary'] = withhold(item['lastToolSummary'], config['reason_working'], rules)
            data = rules.walk(data)
            if run_quotes:
                data = rules.scrub_quotes(data, run_quotes)
            with open(os.path.join(target_dir, 'run.json'), 'w', encoding='utf-8') as handle:
                handle.write(json.dumps(data, ensure_ascii=False, indent=1) + '\n')
        scripts = os.path.join(config['session_dir'], 'workflows', 'scripts')
        script = next((os.path.join(scripts, name) for name in sorted(os.listdir(scripts)) if name.endswith(run + '.js')), None) if os.path.isdir(scripts) else None
        script = script or config.get('run_scripts', {}).get(run)  # a run started from a file the session had written itself
        if script and os.path.exists(script):
            export_text_file(script, os.path.join(target_dir, 'script.js'), rules, per_line_json=False, quotes=run_quotes)
        summary.append({'run': run, 'included': True, 'agents': agents})
    rules.prep = False
    return summary


def export_persisted_outputs(config, rules, out_dir, main_path):
    """Outputs too long for the transcript: the tool keeps them in files that the transcript names.

    A file is copied when an exported entry names it - the main session up to the point where the
    preparation of this export began, and every exported sub-agent session.
    """
    source_dir = os.path.join(config['session_dir'], 'tool-results')
    if not os.path.isdir(source_dir):
        return []
    named = re.compile(r'tool-results/([\w.\-]+\.txt)')
    wanted = set()
    limit = config.get('prep_start')
    with open(main_path, encoding='utf-8') as handle:
        for number, line in enumerate(handle):
            if limit is None or number < limit:
                wanted.update(named.findall(line))
    base = os.path.join(out_dir, 'subagents')
    for folder, _, files in os.walk(base):
        for name in files:
            if name.endswith('.jsonl.gz'):
                with gzip.open(os.path.join(folder, name), 'rt', encoding='utf-8') as handle:
                    wanted.update(named.findall(handle.read()))
            elif name.endswith('.jsonl'):
                with open(os.path.join(folder, name), encoding='utf-8') as handle:
                    wanted.update(named.findall(handle.read()))
    copied = []
    target_dir = os.path.join(out_dir, 'tool-results')
    for name in sorted(wanted):
        source = os.path.join(source_dir, name)
        if os.path.isfile(source):
            os.makedirs(target_dir, exist_ok=True)
            export_text_file(source, os.path.join(target_dir, name), rules, per_line_json=False)
            copied.append(name)
    return copied


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--config', required=True)
    parser.add_argument('--out', required=True, help='directory that receives sessions/')
    args = parser.parse_args()
    with open(args.config, encoding='utf-8') as handle:
        config = json.load(handle)
    rules = Rules(config)
    sessions = os.path.join(args.out, 'sessions')
    os.makedirs(sessions, exist_ok=True)
    path, report, quotes = export_main(config, rules, sessions)
    runs = export_subagents(config, rules, sessions, quotes)
    persisted = export_persisted_outputs(config, rules, sessions, path)
    result = {
        'main_session_file': os.path.relpath(path, args.out),
        'main_session': report,
        'subagent_runs': runs,
        'persisted_outputs_copied': persisted,
        'replacements_by_reason': dict(sorted(rules.counts.items(), key=lambda item: -item[1])),
    }
    with open(os.path.join(sessions, 'redaction-report.json'), 'w', encoding='utf-8') as handle:
        json.dump(result, handle, ensure_ascii=False, indent=1)
        handle.write('\n')
    json.dump(result, sys.stdout, ensure_ascii=False, indent=1)
    print()


if __name__ == '__main__':
    main()
