"""Transport CLI-produced Word files. No business parsing or document authoring."""
from __future__ import annotations

import hashlib
import io
import json
import re
from pathlib import Path
from zipfile import ZipFile, BadZipFile

from . import cli_word
from .store import now


def fingerprint(p):
    # Keep the fingerprint format so old deliveries remain downloadable.
    return hashlib.sha256(json.dumps([p['original_id'], p['period'],
        [(f['id'], f['sha256'], f['role'], f['category']) for f in p['files']]], sort_keys=True).encode()).hexdigest()


def regular_file(path, root, maximum):
    path, root = Path(path), Path(root).resolve()
    if not path.resolve().is_relative_to(root) or path.is_symlink():
        raise ValueError('交付文件路径无效。')
    if any(parent.is_symlink() for parent in path.parents if parent != root and parent.is_relative_to(root)):
        raise ValueError('交付文件目录无效。')
    if not path.is_file() or path.stat().st_size > maximum:
        raise ValueError('CLI 尚未写出可下载的 Word 文件，工作文件已保留。')
    return path.read_bytes()


def word_bytes(task):
    raw = regular_file(Path(task) / cli_word.ARTIFACT, task, 100 * 1024 * 1024)
    # Only file-format/transport checks, never business text or answer fields.
    try:
        with ZipFile(io.BytesIO(raw)) as archive:
            if 'word/document.xml' not in archive.namelist() or '[Content_Types].xml' not in archive.namelist():
                raise ValueError('CLI 输出文件不是 DOCX 文件。')
            if sum(info.file_size for info in archive.infolist()) > 512 * 1024 * 1024:
                raise ValueError('CLI 生成的文件超过交付大小限制。')
            if archive.testzip() is not None:
                raise ValueError('CLI 生成的文件内容损坏。')
    except BadZipFile:
        raise ValueError('CLI 输出文件不是完整的 DOCX 文件。') from None
    return raw


def read_delivery(store, p):
    delivery = p.get('direct_word', {})
    if delivery.get('status') not in {'ready', 'partial'} or delivery.get('fingerprint') != fingerprint(p):
        raise ValueError('当前材料尚未生成可下载的 Word，请先运行更新。')
    run_id = delivery.get('run_id', '')
    if not re.fullmatch(r'run_[a-zA-Z0-9_-]+', run_id):
        raise ValueError('交付文件标识无效。')
    root = store.root / 'deliveries' / p['id']
    raw = regular_file(root / run_id / 'tracked.docx', root, 100 * 1024 * 1024)
    if hashlib.sha256(raw).hexdigest() != delivery['sha256']:
        raise ValueError('交付文件传输校验不一致。')
    return raw


def work(runner, pid, jid, message):
    store = runner.store
    with store.lock:
        snapshot = store.snapshot(store.get(pid))
    start_fingerprint = fingerprint(snapshot)
    directory = store.root / 'deliveries' / pid / jid
    run_dir = store.root / 'runs' / pid / jid
    directory.mkdir(parents=True, exist_ok=True)
    run_dir.mkdir(parents=True, exist_ok=True)
    task = run_dir / 'task'
    instruction = message or '请根据全部上传材料，将历史募集书全文更新至项目报告期，直接生成带修订和来源批注的 Word。'
    manifest = {'workflow': cli_word.WORKFLOW, 'fingerprint': start_fingerprint, 'instruction': instruction,
                'use_reference_knowledge': snapshot.get('job', {}).get('use_reference_knowledge', False)}
    (directory / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    previous = None
    reference_files = []
    prior_id = snapshot.get('direct_word', {}).get('previous_run_id') or ''
    if re.fullmatch(r'run_[A-Za-z0-9_-]+', prior_id):
        prior = directory.parent / prior_id / 'manifest.json'
        try:
            previous_manifest = json.loads(prior.read_text(encoding='utf-8'))
            if previous_manifest == manifest:
                previous = run_dir.parent / prior_id / 'task'
            elif (previous_manifest.get('fingerprint') == start_fingerprint
                  and previous_manifest.get('use_reference_knowledge', False) == manifest['use_reference_knowledge']):
                # Pass earlier model drafts as files, never parse or enforce
                # their business schemas. They are not primary source evidence.
                reference_files = list(prior.parent.glob('batch-*.json'))
                reference_files += list((run_dir.parent / prior_id).glob('batch-*/result.json'))
        except (OSError, ValueError):
            pass

    def checkpoint(step):
        with store.lock:
            p = store.get(pid)
            if jid in runner.cancelled or p['job'].get('id') != jid:
                raise InterruptedError('任务已停止')
            if fingerprint(p) != start_fingerprint:
                raise ValueError('任务运行期间材料或报告期发生变化，文件已保留但未作为新版本发布。')
            p['job'].update(step=step, progress=None, progress_mode='indeterminate')
            p['direct_word'].update(status='running', run_id=jid, workflow=cli_word.WORKFLOW,
                                    fingerprint=start_fingerprint)
            store.save(p)

    checkpoint('正在准备原文件和材料说明')
    payload = cli_word.prepare(snapshot, task, instruction, previous)
    references = []
    for index, source in enumerate(reference_files, 1):
        try:
            raw = regular_file(source, store.root, 2 * 1024 * 1024)
        except (OSError, ValueError):
            continue
        target = task / 'scratch/previous_attempt' / (str(index) + '.txt')
        target.parent.mkdir(exist_ok=True)
        target.write_bytes(raw)
        references.append(target.relative_to(task).as_posix())
    if references:
        payload['previous_model_drafts'] = references
        (task / 'input.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    execution_error = ''
    try:
        summary = cli_word.invoke(runner, snapshot, jid, task, checkpoint)
    except (RuntimeError, TimeoutError) as exc:
        if jid in runner.cancelled:
            raise InterruptedError('任务已停止') from None
        try:
            word_bytes(task)
        except (OSError, ValueError):
            raise exc
        execution_error = cli_word.safe(exc)
        summary = '本次执行未正常结束，已保存可下载的阶段 Word。' + execution_error
    checkpoint('正在保存 Codex 生成的 Word')
    raw = word_bytes(task)
    notes_path = task / 'output/交付说明.md'
    notes = ''
    if notes_path.exists():
        try:
            notes = cli_word.safe(regular_file(notes_path, task, 2 * 1024 * 1024).decode('utf-8', errors='replace'))
        except (OSError, ValueError):
            notes = 'Word 已生成；附加交付说明未能读取，请参见 Word 批注和 Codex 的回复。'
    if execution_error:
        notes = '本次执行未正常结束，此文件为已保存的阶段稿。\n' + execution_error + '\n\n' + notes
    delivery = {'status': 'partial' if execution_error else 'ready', 'workflow': cli_word.WORKFLOW, 'run_id': jid,
                'fingerprint': start_fingerprint, 'sha256': hashlib.sha256(raw).hexdigest(),
                'generated_at': now(), 'target_period': snapshot['period'],
                'reference_knowledge': payload.get('reference_knowledge'),
                'summary': summary[:12000], 'notes': notes[:50000],
                'document_processing': 'codex_cli', 'content_review': 'agent_responsibility',
                'completion_claim': 'artifact_available', 'execution_error': execution_error}
    (directory / 'tracked.docx').write_bytes(raw)
    (directory / 'receipt.json').write_text(json.dumps(delivery, ensure_ascii=False, indent=2), encoding='utf-8')
    if notes:
        (directory / '交付说明.md').write_text(notes, encoding='utf-8')
    with store.lock:
        p = store.get(pid)
        if jid in runner.cancelled or p['job'].get('id') != jid:
            raise InterruptedError('任务已停止')
        if fingerprint(p) != start_fingerprint:
            raise ValueError('当前材料已变化，本次 Word 已保留，未覆盖新版本。')
        p['direct_word'] = delivery
        step = '任务未完成，已保存可下载的阶段 Word' if execution_error else 'Codex 已生成 Word，可以下载'
        p['job'].update(status='failed' if execution_error else 'completed', progress=None if execution_error else 100,
                        progress_mode='complete', ended_at=now(), result_intent='update', step=step)
        if execution_error:
            p['job']['error'] = execution_error
        store.add_message(p, 'assistant', step + '\n\n' + (summary[:12000] or '更新范围与材料缺项请参见 Word 批注及交付说明。'))
        store.log(p, '保存 Codex 生成的 Word', run_id=jid, workflow=cli_word.WORKFLOW)
        store.save(p)
