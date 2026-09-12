"""Opt-in real CLI smoke check using only fictional local materials."""
import json
import time
from pathlib import Path
from tempfile import TemporaryDirectory

from backend.store import Store
from backend.engine import add_file
from backend.runner import Runner, cli_status


def main():
    repo = Path(__file__).resolve().parents[1]
    with TemporaryDirectory() as tmp:
        store = Store(tmp)
        p = store.create('虚构材料 CLI 连通性检查')
        add_file(store, p, '# 测试\n截至2026年3月末，资产总额100万元。'.encode(), '虚构底稿.md', 'prospectus', 'prospectus')
        add_file(store, p, '虚构材料，2026年6月30日合并资产总额120万元，未经审计。'.encode(), '虚构报表.txt', 'source', 'financial')
        runner = Runner(store, repo)
        runtime = cli_status()
        with store.lock:
            runner.start(p)
        deadline = time.monotonic() + 60
        while p['job']['status'] in {'queued', 'running'} and time.monotonic() < deadline:
            time.sleep(.2)
        if p['job']['status'] in {'queued', 'running'}:
            runner.cancel(p)
        result = {'kind': 'REAL_CODEX_CLI', 'runtime': runtime, 'job': p['job'],
                  'execution_verified': runner.execution_verified,
                  'changed_by_agent': sum(c['origin'] == 'agent' for c in p['changes']),
                  'remaining_brackets': sum(c['status'] == 'needs_review' for c in p['changes'])}
        out = repo / 'work/app-checks/live-cli-result.json'
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
