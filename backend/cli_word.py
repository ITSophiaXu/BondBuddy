"""One Codex process owns the complete document job and writes its artifacts."""
from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from .cli_workspace import verify_workspace
from .docx_fidelity import source_bytes
from .usage_meter import UsageMeter
from .knowledge import snapshot

WORKFLOW = 'cli_word_v1'
ARTIFACT = 'output/updated_prospectus.docx'


def safe(value):
    return re.sub(r'sk-[A-Za-z0-9_-]{12,}', '[REDACTED]', str(value))


def copy_work(source, destination):
    """Copy only regular task files; do not follow model-created symlinks."""
    source, destination = Path(source), Path(destination)
    if source.is_symlink() or not source.is_dir():
        return
    for entry in source.iterdir():
        if entry.is_symlink() or entry.name in {'.codex', '.git', 'AGENTS.md'}:
            continue
        target = destination / entry.name
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            copy_work(entry, target)
        elif entry.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(entry, target)


def prepare(project, task, instruction, previous=None):
    task = Path(task)
    task.mkdir(parents=True, exist_ok=True)
    previous_work = False
    if previous and Path(previous).is_dir():
        # Originals and previous delivery are never used as this run's final output.
        for entry in Path(previous).iterdir():
            if entry.name in {'materials', 'input.json', 'knowledge.md', 'completion.txt', 'events.jsonl', 'AGENTS.md', '.codex', '.git'} or entry.is_symlink():
                continue
            target = task / ('previous_output' if entry.name == 'output' else entry.name)
            if entry.is_dir():
                target.mkdir(exist_ok=True)
                copy_work(entry, target)
            elif entry.is_file():
                shutil.copyfile(entry, target)
        previous_work = True
    for name in ('materials', 'scratch', 'output'):
        (task / name).mkdir(exist_ok=True)
    manifest = []
    for f in project['files']:
        if not re.fullmatch(r'file_[A-Za-z0-9_-]+', f['id']) or not re.fullmatch(r'\.[A-Za-z0-9]{1,8}', f['extension']):
            raise ValueError('上传材料的文件标识无效。')
        path = task / 'materials' / (f['id'] + f['extension'])
        path.write_bytes(source_bytes(f))
        path.chmod(0o444)
        manifest.append({**{k: f.get(k) for k in ('id', 'name', 'role', 'category', 'sha256', 'extension')},
                         'path': path.relative_to(task).as_posix(),
                         'is_historical_prospectus': f['id'] == project['original_id']})
    payload = {'project': project['title'], 'project_id': project['id'], 'target_period': project['period'],
               'instruction': instruction, 'materials': manifest, 'previous_work': previous_work,
               'final_word_path': ARTIFACT, 'python': sys.executable,
               'reference_knowledge': snapshot(task) if project.get('job', {}).get('use_reference_knowledge', False) else None}
    (task / 'input.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    for source, name in (('material_reader.py', 'read_material.py'), ('word_patch_tool.py', 'word_patch.py'),
                         ('cli_word_guide.md', '任务说明.md')):
        shutil.copyfile(Path(__file__).with_name(source), task / name)
    return payload


def command(cli, task, options):
    mode = 'danger-full-access' if 'sandbox_mode="danger-full-access"' in options else 'workspace-write'
    args = [cli, *options, '-a', 'never', '-s', mode,
            '--enable', 'shell_tool', '--enable', 'view_image',
            '-c', 'web_search="disabled"']
    for variable, setting in (('BOND_CODEX_PROVIDER', 'model_provider'),
                              ('BOND_CODEX_REASONING_EFFORT', 'model_reasoning_effort')):
        if os.environ.get(variable):
            args += ['-c', setting + '=' + json.dumps(os.environ[variable])]
    args += ['exec', '--skip-git-repo-check', '--ephemeral', '--json', '-C', str(task),
             '--output-last-message', str(task / 'completion.txt'), '--color', 'never']
    if os.environ.get('BOND_CODEX_MODEL'):
        args += ['-m', os.environ['BOND_CODEX_MODEL']]
    return args + ['-']


def invoke(runner, project, jid, task, checkpoint):
    environment = runner._process_environment()
    scratch = str((task / 'scratch').resolve())
    environment.update(TMPDIR=scratch, TMP=scratch, TEMP=scratch, PYTHONIOENCODING='utf-8')
    for key in ('BOND_AUTH_USERNAME', 'BOND_AUTH_PASSWORD'):
        environment.pop(key, None)
    checkpoint('正在准备文件读写环境')
    options = verify_workspace(runner._cli_path(), environment, task.parent)
    checkpoint('Codex 正在读取材料、更新全文并制作 Word')
    args = command(runner._cli_path(), task, options)
    prompt = ('请完成本次募集书全文更新，直到自己生成最终带修订 Word。先读取任务说明.md 和 input.json。仅当 reference_knowledge 非空时，完整阅读并使用 knowledge.md。'
              '\n全部文档处理、复核和 Word 写入均由你在本次工作目录完成。最终回复普通文字，不需要 JSON。'
              '\n可用 Python 解释器：' + sys.executable + '\n最终 Word 路径：' + ARTIFACT)
    meter = UsageMeter(runner.store.root, project['id'], jid, 1)
    outcome, proc, readers, terminal_failure = 'failed', None, [], False
    q = queue.Queue()

    def reader(stream, kind):
        try:
            for line in stream:
                if kind == 'out':
                    try:
                        event = json.loads(line)
                        if isinstance(event, dict):
                            meter.observe(event)
                    except ValueError:
                        pass
                q.put((kind, safe(line)))
        except Exception:
            meter.mark_error()
        finally:
            q.put((kind, None))

    try:
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd=task, env=environment, text=True, encoding='utf-8', errors='replace',
            start_new_session=os.name != 'nt',
            creationflags=(subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP) if os.name == 'nt' else 0)
        runner.processes[jid] = proc
        readers = [threading.Thread(target=reader, args=(stream, kind), daemon=True)
                   for stream, kind in ((proc.stdout, 'out'), (proc.stderr, 'err'))]
        for thread in readers:
            thread.start()
        input_failed = False
        try:
            proc.stdin.write(prompt)
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            input_failed = True
        deadline = time.monotonic() + int(os.environ.get('BOND_WORD_CLI_TIMEOUT', '43200'))
        last, errors, ended = '', [], set()
        with (task / 'events.jsonl').open('w', encoding='utf-8') as log:
            while len(ended) < 2:
                if jid in runner.cancelled:
                    raise InterruptedError('任务已停止，CLI 工作文件已保留。')
                if time.monotonic() > deadline:
                    raise TimeoutError('本次 CLI 达到运行时限，工作文件和已报告用量已保留。')
                try:
                    kind, line = q.get(timeout=.3)
                except queue.Empty:
                    continue
                if line is None:
                    ended.add(kind)
                    continue
                log.write(json.dumps({'stream': kind, 'line': line}, ensure_ascii=False) + '\n')
                log.flush()
                if kind == 'err':
                    errors = (errors + [line[:1500]])[-8:]
                    continue
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                if event.get('type') == 'item.completed' and event.get('item', {}).get('type') == 'agent_message':
                    last = str(event['item'].get('text', ''))
                if event.get('type') == 'turn.failed':
                    terminal_failure = True
                    errors = (errors + [safe(event)])[-8:]
            code = proc.wait(timeout=5)
        if jid in runner.cancelled:
            raise InterruptedError('任务已停止，CLI 工作文件已保留。')
        if code or input_failed or terminal_failure:
            raise RuntimeError('Codex CLI 本次未正常结束，工作文件已保留。' + ''.join(errors)[-1500:])
        # This is the agent's ordinary prose, not a business result schema.
        completion = task / 'completion.txt'
        if completion.is_file() and not completion.is_symlink():
            last = completion.read_text(encoding='utf-8', errors='replace')
        outcome = 'completed'
        runner.execution_verified = True
        runner.runtime_failure = None
        return safe(last)
    except InterruptedError:
        outcome = 'cancelled'
        raise
    except TimeoutError:
        outcome = 'timed_out'
        raise
    finally:
        if proc is None:
            outcome = 'launch_failed'
        else:
            if proc.poll() is None:
                runner._stop_process(proc)
            for thread in readers:
                thread.join(timeout=5)
            if any(t.is_alive() for t in readers):
                meter.mark_error()
            for stream in (proc.stdin, proc.stdout, proc.stderr):
                stream.close()
        meter.finish(outcome, None if proc is None else proc.returncode)
        runner.processes.pop(jid, None)
