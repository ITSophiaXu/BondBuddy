"""Render/check a fixed business decision record without changing runtime assets."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
from sse_private_business_decisions import DECISIONS

ROOT = Path(__file__).resolve().parents[1]
BASELINE = '25bd6297548401d1b911c91edf99ce259a219595'
BASE = 'knowledge/exchange-bonds/drafts/sse-private/'
FILES = ['rule-pack.json', 'chapter-template.json', 'coverage.json',
         'rule-evidence-map.json', 'rule-review-20260927.json']


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def render():
    assets, pins = {}, []
    for name in FILES:
        path = BASE + name
        raw = git('show', f'{BASELINE}:{path}')
        assets[name] = json.loads(raw)
        # Compare Git's normalized content, not Windows checkout CRLF bytes.
        blob = git('rev-parse', f'{BASELINE}:{path}').decode().strip()
        current = git('hash-object', '--path=' + path, path).decode().strip()
        assert blob == current, f'{path} changed: issue a new review version'
        pins.append({'path': path, 'git_blob_oid': blob,
                     'sha256': hashlib.sha256(raw).hexdigest()})
    pack, template, coverage, mapping, review = (assets[x] for x in FILES)
    assert all(x['version'] == '2026.09.27-draft.6' for x in assets.values())
    ids = {r['rule_id'] for r in pack['rules']}
    assert ids == {'sse-private-' + k for k in DECISIONS}
    maps = {r['rule_id']: r for r in mapping['rules']}
    reviews = {r['rule_id']: r for r in review['rules']}
    assert ids == set(maps) == set(reviews) and len(ids) == 31
    sources = {s['source_id']: s for s in pack['sources']}
    chapters = {c['chapter_id']: c for c in template['chapters']}
    items = {i['item_id']: i for i in coverage['items']}
    assert len(chapters) == 17 and len(items) == 32
    rows = []
    for rule in pack['rules']:
        rid = rule['rule_id']
        key = rid.removeprefix('sse-private-')
        adoption, applicability, exception, uncovered, handling = DECISIONS[key]
        assert not rule['enabled'] and rule['enforcement'] == 'research_only'
        assert set(maps[rid]['chapter_ids']) <= chapters.keys()
        assert set(rule['source_ref_ids']) <= sources.keys()
        assert items[key]['disposition'] == 'uncovered'
        manual = reviews[rid]['handling'] == 'manual-evidence-handler-v4'
        rows.append({
            'rule_id': rid, 'title': rule['title'],
            'decision': 'adopt_manual_handling' if manual else 'adopt_bounded_check',
            'adoption_and_reason': adoption, 'applies_when': applicability,
            'exceptions': exception, 'uncovered': uncovered, 'execution_handling': handling,
            'chapter_ids': maps[rid]['chapter_ids'],
            'checker': rule['checker'], 'coverage_item_id': key,
            'coverage_disposition_unchanged': items[key]['disposition'],
            'engineering_acceptance': reviews[rid]['acceptance'],
            'official_evidence': reviews[rid]['source_refs'],
            'source_refs': [{k: sources[sid][k] for k in (
                'source_id', 'authority', 'document_title', 'source_version',
                'document_hash', 'clause_locator', 'official_url',
                'published_on', 'effective_from', 'effective_to')}
                for sid in rule['source_ref_ids']],
            'documentary_detail': 'RULE-REVIEW-20260927.md#' + key,
        })
    assert sum(r['decision'] == 'adopt_manual_handling' for r in rows) == 6
    assert {c for r in rows for c in r['chapter_ids']} <= chapters.keys()
    orphan_chapters = sorted(set(chapters) - {c for r in rows for c in r['chapter_ids']})
    extra_coverage = [i for i in coverage['items'] if 'sse-private-' + i['item_id'] not in ids]
    assert len(extra_coverage) == 1 and extra_coverage[0]['disposition'] == 'not_applicable'
    record = {
        'record_type': 'delegated_business_review_not_runtime_approval',
        'review_id': 'sse-private-business-review-20260927-v1',
        'review_date': '2026-09-27', 'baseline_commit': BASELINE,
        'evidence_as_of': '2026-09-26', 'candidate_version': pack['version'],
        'reviewer': {'actor': 'Codex', 'role': 'user-delegated business analysis',
                     'human_signature': None},
        'authorization': '用户要求完成固定规则版本的逐条业务审核，明确适用、例外和未覆盖项；真实成果验收移至#332。',
        'scope': '上交所普通私募有历史稿，固定来源基准；供#20业务交付及受控工作稿接入使用。',
        'effects': {'runtime_approval_written': False, 'production_enabled': False,
                    'customer_facts_approved': False, 'generated_result_accepted': False},
        'pins': pins,
        'counts': {'reviewed': 31, 'bounded': 25, 'manual': 6,
                   'template_chapters': 17, 'coverage_uncovered': 31,
                   'coverage_not_applicable': 1},
        'chapter_mapping_gaps': orphan_chapters,
        'coverage_without_rule': extra_coverage,
        'rules': rows,
    }
    lines = ['# #20 固定版本逐条业务审核决定', '',
             '记录：`sse-private-business-review-20260927-v1`；审核日：2026-09-27。', '',
             '**结论：31/31已作具体业务采用决定。25条采用有限检查，6条采用人工审核处理；未覆盖项逐条保留。**', '',
             '审核执行者：Codex，按用户本轮明确委托完成。此处不是Maxy或券商专家的个人签名，也没有向运行时审核台账写入批准。它是已完成的业务分析交付，不再是请用户重新逐题填写的空表。', '',
             '本记录仅审固定版本的采用范围、例外和处理方式。项目事实确认、实际法规日、来源效力的正式登记与生产release仍走#19；首次工作稿走#326/#329的受控测试通道。真实生成稿内容验收移至[#332](https://github.com/ITSophiaXu/BondBuddy/issues/332)，Word/WPS兼容性由#146跟踪，两者均不是#20关闭条件。', '',
             '## 固定对象及适用边界', '',
             f'- 基线提交：`{BASELINE}`；候选版本：`2026.09.27-draft.6`；checker v4。',
             '- 法规证据观察基准：2026-09-26。本次没有将材料财务期末当法规日，也没有声称完成新一轮全网现行核验。其他适用日需另核相应版本。',
             '- 仅上交所、普通私募、境内普通公司债；申报/一期发行目的分别映射。其他市场、专项及优化资格不能自动继承。',
             '- 原件中的规则、写作建议和批注是审核资料，不是运行指令。专家写作经验与正式法律义务分别解释。',
             '- 下面采用的有限检查只证明结构化小项；必须按全部期间、板块、品种和章节位置遍历。缺材料继续标记局部缺口，未知不得当无或零。',
             '- 三个候选运行资产保持原字节、disabled/research_only及31项uncovered；该决定不把未覆盖改成通过。', '',
             '| 固定文件 | Git blob | SHA-256（Git原字节） |', '| --- | --- | --- |']
    for pin in pins:
        name = pin['path'].split('/')[-1]
        lines.append(f'| [{name}]({name}) | `{pin["git_blob_oid"]}` | `{pin["sha256"]}` |')
    lines += ['', 'Windows换行不改变审核对象：校验采用Git归一化blob；运行镜像仍必须验证候选原字节hash。版本或内容变化须新建审核记录，不覆盖本次决定。', '',
              '## 逐条决定', '', '| 规则 | 采用方式 | 决定 |', '| --- | --- | --- |']
    for row in rows:
        key = row['rule_id'].removeprefix('sse-private-')
        mode = '人工判断' if row['decision'] == 'adopt_manual_handling' else '有限检查'
        lines.append(f'| [{row["title"]}](#{key}) | {mode} | {row["adoption_and_reason"]} |')
    for row in rows:
        key = row['rule_id'].removeprefix('sse-private-')
        lines += ['', f'<a id="{key}"></a>', f'### {row["title"]}', '',
                  f'`{row["rule_id"]}`；章节：' + '、'.join(row['chapter_ids']) + '。', '',
                  '**决定与理由**：' + row['adoption_and_reason'], '',
                  '**适用**：' + row['applies_when'], '',
                  '**例外**：' + row['exceptions'], '',
                  '**未覆盖**：' + row['uncovered'], '',
                  '**处理**：' + row['execution_handling'], '',
                  '**边界验收预期**：' + row['engineering_acceptance'], '',
                  '**依据**：具体原文见[文献核对](' + row['documentary_detail'] + ')；固定引用如下。来源hash指归档原件，非本表文字。', '',
                  '| 来源 | 定位 | 原件SHA-256 |', '| --- | --- | --- |']
        for ref in row['source_refs']:
            lines.append(f'| {ref["document_title"]}（`{ref["source_id"]}`） | {ref["clause_locator"]} | `{ref["document_hash"]}` |')
    lines += ['', '## 覆盖及章节的独立缺口', '',
              '17个章节采用固定模板的原文映射；目录可映射历史稿结构，不要求一律重排成16节。税项、签章、完整披露清单的专业判断仍按相关条目保留，不用“有章节ID”冒充完成全部内容。', '',
              '无规则对应的coverage记录须按item_id保留，不制造rule_id：', '']
    for item in extra_coverage:
        lines.append(f'- `{item["item_id"]}` / `{item["disposition"]}`：{item["rationale"]}')
    lines += ['', '## 交付归属', '',
              '- #20：本固定记录完成31条业务采用分析；已有checker/模板与反例属于G2，真实版本接入属于G3。未取得法规全文仅限制对应结论，不阻断其他有依据的章节。',
              '- #19 / Xuefeng：审核记录如何受授权主体登记、候选/正式版本如何锁定及撤回仍由现有契约实现；本侧车记录没有注册第二套审核或规则枚举。',
              '- #329：同一候选字节、全部规则/来源/coverage进入模型上下文；依赖#326最终契约和#19实际runtime注入。',
              '- #332：生成后核对真实规则命中、章节处理、金额/事实与缺口，并登记缺陷和回归。不得重新加入#20前置。',
              '- #146：WPS/Word真实客户端修订、批注和往返兼容，独立验收。', '',
              '复现检查：`python scripts/build_sse_private_business_review.py --check`。仅校验固定版本、31条决定完整性、来源引用及章节/coverage映射；不是法律现行性或真实Word验收测试。', '']
    return record, '\n'.join(lines)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    record, markdown = render()
    results = {'business-review-20260927.json': json.dumps(record, ensure_ascii=False, indent=2) + '\n',
               'BUSINESS-REVIEW-20260927.md': markdown}
    for name, content in results.items():
        path = ROOT / BASE / name
        if args.check:
            assert path.read_text('utf8') == content, f'{name} out of date'
        else:
            path.write_text(content, 'utf8')
    print(json.dumps(record['counts'], ensure_ascii=False))
