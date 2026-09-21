"""Durable, project-scoped CLI usage. No prompts, documents or credentials are stored."""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

TOKEN_KEYS = ('input_tokens', 'cached_input_tokens', 'output_tokens')


def now():
    return datetime.now(timezone.utc).isoformat()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', value):
        raise ValueError('用量记录的项目或任务标识无效。')
    return value


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.usage-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            json.dump(value, output, ensure_ascii=False, separators=(',', ':'))
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def clean_usage(value):
    if not isinstance(value, dict):
        return None
    if any(type(value.get(k)) is not int or value[k] < 0 for k in TOKEN_KEYS):
        return None
    if value['cached_input_tokens'] > value['input_tokens']:
        return None
    result = {k: value[k] for k in TOKEN_KEYS}
    reasoning = value.get('reasoning_output_tokens')
    if type(reasoning) is int and 0 <= reasoning <= value['output_tokens']:
        result['reasoning_output_tokens'] = reasoning
    return result


class UsageMeter:
    def __init__(self, root, project_id, job_id, batch):
        self.lock = threading.Lock()
        self.sequence = 0
        self.seen = set()
        self.record = {
            'version': 1, 'call_id': 'call_' + uuid.uuid4().hex,
            'project_id': identifier(project_id), 'run_id': identifier(job_id), 'batch': int(batch),
            'provider': os.environ.get('BOND_CODEX_PROVIDER', 'unknown'),
            'requested_model': os.environ.get('BOND_CODEX_MODEL', 'unknown'),
            'started_at': now(), 'finished_at': None, 'status': 'running',
            'transport_complete': False, 'usage_complete': False, 'recording_error': False,
            'invalid_usage_events': 0, 'turns': [],
        }
        self.path = Path(root) / 'usage' / self.record['project_id'] / (self.record['call_id'] + '.json')
        # A failure here prevents an untracked model invocation.
        write_json(self.path, self.record)

    def _persist(self):
        try:
            write_json(self.path, self.record)
        except OSError:
            self.record['recording_error'] = True
            logging.error('BondBuddy usage recording failed; the report must be treated as incomplete.')

    def observe(self, event):
        if not isinstance(event, dict) or event.get('type') != 'turn.completed':
            return
        with self.lock:
            self.sequence += 1
            event_id = event.get('turn_id') or event.get('id')
            event_id = str(event_id)[:150] if isinstance(event_id, (str, int)) else 'sequence:' + str(self.sequence)
            if event_id in self.seen:
                return
            self.seen.add(event_id)
            usage = clean_usage(event.get('usage'))
            if usage is None:
                self.record['invalid_usage_events'] += 1
            else:
                # Only terminal turn usage is additive. Ignore token_count totals.
                model = event.get('model')
                model = model if isinstance(model, str) and re.fullmatch(r'[A-Za-z0-9_.:/-]{1,100}', model) else None
                self.record['turns'].append({'at': now(), 'sequence': self.sequence,
                                             'reported_model': model, **usage})
            self._persist()

    def mark_error(self):
        with self.lock:
            self.record['recording_error'] = True
            self._persist()

    def finish(self, status, returncode=None):
        with self.lock:
            self.record.update(status=status, finished_at=now(), returncode=returncode,
                               transport_complete=returncode == 0)
            self.record['usage_complete'] = bool(returncode == 0 and self.record['turns']
                                                  and not self.record['invalid_usage_events']
                                                  and not self.record['recording_error'])
            self._persist()


def report(root, project):
    pid = identifier(project['id'])
    records, unreadable = [], 0
    for path in sorted((Path(root) / 'usage' / pid).glob('call_*.json')):
        try:
            item = json.loads(path.read_text(encoding='utf-8'))
            if (not isinstance(item, dict) or item['project_id'] != pid
                    or not isinstance(item['turns'], list)
                    or not isinstance(item.get('started_at'), str)):
                raise ValueError('Invalid record')
            identifier(item['run_id'])
            records.append(item)
        except (OSError, ValueError, KeyError, TypeError):
            unreadable += 1
    calls, totals, known_runs = [], {k: 0 for k in TOKEN_KEYS}, set()
    missing = unreadable
    for item in records:
        known_runs.add(item['run_id'])
        valid = [clean_usage(t) for t in item['turns']]
        values = {k: sum(t[k] for t in valid if t is not None) for k in TOKEN_KEYS}
        for key in TOKEN_KEYS:
            totals[key] += values[key]
        complete = item.get('usage_complete') is True and bool(valid) and all(t is not None for t in valid)
        if not complete:
            missing += 1
        calls.append({**{k: item.get(k) for k in ('call_id', 'run_id', 'batch', 'provider', 'requested_model',
                                                 'started_at', 'finished_at', 'status', 'returncode')},
                      **values, 'has_reported_usage': bool(item['turns']), 'usage_complete': bool(complete),
                      'turns': [{**{k: t.get(k) for k in ('at', 'sequence', 'reported_model')}, **v}
                                for t, v in zip(item['turns'], valid) if v is not None]})
    # An older task can already have been pruned. Never present its absence as zero.
    historical_runs = {m.get('run_id') for m in project.get('messages', []) if m.get('role') == 'user' and m.get('run_id')}
    unrecorded_runs = sorted(historical_runs - known_runs)
    totals.update(uncached_input_tokens=totals['input_tokens'] - totals['cached_input_tokens'],
                  total_tokens=totals['input_tokens'] + totals['output_tokens'])
    return {'project_id': pid, 'project_title': project.get('title', ''), 'generated_at': now(),
            'scope': 'All model invocations in this project, including failed/cancelled attempts and retries.',
            'totals': totals, 'calls': sorted(calls, key=lambda c: c['started_at']),
            'call_count': len(calls), 'incomplete_calls': missing, 'unrecorded_runs': unrecorded_runs,
            'measurement_complete': not missing and not unrecorded_runs,
            'cost': None, 'cost_status': 'Requires the applicable verified DeepSeek rates and billing reconciliation.',
            'notes': ['Cached input is a subset of input tokens; do not add it to total tokens.',
                      'Reasoning output, when reported, is a subset of output tokens.',
                      'Missing usage is unknown, not zero. Reported tokens from incomplete calls are a lower bound.',
                      'CLI calls can span pricing periods; account billing is the final charge.']}


def account_snapshot(root, title, phase):
    """Private reconciliation data. Never exposed through the project usage endpoint."""
    import urllib.request
    from .codex_config import read_config
    from .runner import cli_environment
    env = cli_environment()
    config = read_config(env.get('CODEX_HOME') or str(Path.home() / '.codex'))
    provider = config.get('model_providers', {}).get('deepseek', {})
    if provider.get('base_url', '').rstrip('/') not in ('https://api.deepseek.com', 'https://api.deepseek.com/v1'):
        raise ValueError('DeepSeek provider configuration is unavailable.')
    token = env.get(provider.get('env_key', ''), '') or provider.get('experimental_bearer_token', '')
    record = {'title': title, 'phase': phase, 'at': now(), 'balance': None,
              'note': 'Account-wide balance difference is only a cross-check; concurrent usage and top-ups affect it.'}
    request = urllib.request.Request('https://api.deepseek.com/user/balance', headers={'Authorization': 'Bearer ' + token})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            value = json.load(response)
        record['balance'] = [{k: b.get(k) for k in ('currency', 'total_balance', 'granted_balance', 'topped_up_balance')}
                             for b in value.get('balance_infos', [])]
        record['balance_status'] = 'captured' if record['balance'] else 'unavailable'
    except Exception as exc:
        record['balance_status'] = 'unavailable:' + type(exc).__name__
    folder = Path(root) / 'usage' / 'private-snapshots'
    path = folder / (phase + '-' + uuid.uuid4().hex + '.json')
    write_json(path, record)
    try:
        with urllib.request.urlopen('https://api-docs.deepseek.com/zh-cn/quick_start/pricing', timeout=15) as response:
            html = response.read(2_000_001)
        if len(html) <= 2_000_000:
            price_path = path.with_suffix('.pricing.html')
            price_path.write_bytes(html)
            os.chmod(price_path, 0o600)
    except Exception:
        pass
    return {'snapshot': str(path), 'balance_status': record['balance_status']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['report', 'baseline', 'finish'])
    parser.add_argument('--title', required=True)
    args = parser.parse_args()
    root = Path(os.environ.get('BOND_DATA_DIR', '/data/projects'))
    if args.action in ('baseline', 'finish'):
        print(json.dumps(account_snapshot(root, args.title, args.action), ensure_ascii=False))
        if args.action == 'baseline':
            return
    matches = [json.loads(p.read_text(encoding='utf-8')) for p in root.glob('project_*.json')]
    matches = [p for p in matches if p.get('title') == args.title]
    if len(matches) != 1:
        raise ValueError('Project title must match exactly one existing project.')
    result = report(root, matches[0])
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
