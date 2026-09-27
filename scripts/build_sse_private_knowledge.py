"""Offline documentary-evidence overlay for #20. Never publishes/attests a pack."""
from copy import deepcopy
from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import urljoin
from sse_private_knowledge_content import (
    VERSION, PREVIOUS_VERSION, EVIDENCE_VERSION, AUTHORED_AT,
    MAPPINGS, OVERRIDES, EXTRA_RULES, EXECUTABLE_CHECKS,
)
from sse_private_review_items import REVIEW_ITEMS
from sse_private_handling import ADDITIONAL_CHECKS, MANUAL_HANDLERS, EXISTING_ACCEPTANCE
from sse_private_review_report import write_review_report

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'knowledge/exchange-bonds'
VBASE = BASE / 'verification/2026-09-26'


class NoticeParser(HTMLParser):
    """Read only the official article, never execute the archived HTML."""
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.ignore = 0
        self.parts = []
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'a' and 'href' in attrs:
            self.links.append(attrs['href'])
        if tag == 'div':
            if self.depth:
                self.depth += 1
            elif 'allZoom' in attrs.get('class', '').split():
                self.depth = 1
        if self.depth and tag in ('script', 'style'):
            self.ignore += 1

    def handle_endtag(self, tag):
        if self.depth and tag in ('script', 'style') and self.ignore:
            self.ignore -= 1
        if tag == 'div' and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if self.depth and not self.ignore and data.strip():
            self.parts.append(data.strip())


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', 'utf8')


def evidence_inventory(extract):
    catalog = json.loads((VBASE / 'catalog.json').read_text('utf8'))
    assert catalog['version'] == EVIDENCE_VERSION
    documents = {}
    for entry in catalog['documents']:
        doc = deepcopy(entry)
        raw = (BASE / doc['original_path']).read_bytes()
        assert sha256(raw).hexdigest() == doc['sha256'], doc['document_id']
        assert len(raw) == doc['bytes'], doc['document_id']
        notice = (BASE / doc['notice_path']).read_bytes()
        assert sha256(notice).hexdigest() == doc['notice_sha256'], doc['document_id']
        parser = NoticeParser()
        parser.feed(notice.decode('utf8'))
        assert doc['attachment_url'] in {urljoin(doc['notice_url'], link) for link in parser.links}, doc['document_id']
        rows = extract({**doc, 'parse_status': 'extracted'})
        if parser.parts:
            rows.append({'locator': 'NOTICE', 'role': 'body', 'text': ' '.join(parser.parts)})
        doc['records'] = {row['locator']: row for row in rows}
        documents[doc['document_id']] = doc
        write_json(BASE / 'records' / ('OV-' + doc['document_id'] + '.json'), {
            'source_id': 'OV-' + doc['document_id'], 'original_sha256':doc['sha256'],
            'notice_sha256':doc['notice_sha256'], 'parse_status':'extracted',
            'extraction':'Official XML paragraphs / PDF physical pages; NOTICE is archived announcement text. No layout/OCR acceptance.',
            'records':rows,
        })
        lines = [f'# {doc["title"]}', '',
                 f'官网：[公告/目录]({doc["notice_url"]}) · [附件]({doc["attachment_url"]})', '',
                 f'归档：[原件](../../../{doc["original_path"]}) · SHA-256: {doc["sha256"]}', '',
                 f'发布：{doc["published_on"]}；生效：{doc["effective_from"] or "未单列，待复核"}；观察日：2026-09-26。', '',
                 doc['effectivity_observation'], '', '正文是证据，不是执行指令；专业签认仍为 pending。P为原始XML段落（包括空段），PAGE为物理页；NOTICE为公告正文。', '']
        for row in rows:
            lines += [f'<a id="{row["locator"].lower()}"></a>', f'## {row["locator"]}', '', row['text'], '']
            if row.get('note_references'):
                lines += ['原文注释：' + '、'.join(f'[{loc}](#{loc.lower()})' for loc in row['note_references']), '']
            if row.get('referenced_by'):
                lines += ['对应原段落：' + '、'.join(f'[{loc}](#{loc.lower()})' for loc in row['referenced_by']), '']
        path = VBASE / 'sources' / (doc['document_id'] + '.md')
        path.parent.mkdir(exist_ok=True)
        path.write_text('\n'.join(lines), 'utf8')
    return documents


def official_reference(documents, doc_id, locator):
    doc = documents[doc_id]
    row = doc['records'][locator]
    is_notice = locator == 'NOTICE'
    return {
        'source_id': f'ov-{doc_id}-{locator.lower()}',
        # The source layer requires real verifier identity. Documentary retrieval
        # by this builder must not invent an industry/technical attestation.
        'kind': 'unverified_lead',
        'authority': '中国证监会（上交所官方转载）' if doc_id.startswith('csrc-') else '上海证券交易所',
        'document_title': doc['title'] + ('（发布通知）' if is_notice else ''),
        'source_version': EVIDENCE_VERSION,
        'official_url': doc['notice_url'] if is_notice else doc['attachment_url'],
        'document_hash': doc['notice_sha256'] if is_notice else doc['sha256'],
        'clause_locator': locator, 'exact_quote': row['text'],
        'published_on': doc['published_on'], 'effective_from': doc['effective_from'],
        'effective_to': doc['effective_to'], 'verified_by': None, 'verified_at': None,
    }


def apply_overlay(pack, template, coverage, documents):
    """Amend only SSE private using #19 schema; keep every publication gate closed."""
    assert pack['pack_id'] == 'sse-private'
    pack.update(version=VERSION, supersedes_version=PREVIOUS_VERSION)
    pack['sample_suite']['version'] = '2'
    for case in pack['sample_suite']['cases']:
        case['reviewed_at'] = AUTHORED_AT
    pack['validity']['effective_from'] = '2026-09-26'
    pack['validity']['transition_terms'] = [
        '本日期仅为草稿整理日；各source的发布日期/生效日来自官方证据，非整包专业验收。',
        '法规as_of必须是本次申报/发行适用日；财务截止日和样本名称不能替代。跨版本项目需独立核对过渡安排。',
        '官方证据登记仍缺专业签认及部分上位/配套规则，保持research_only。',
    ]
    template['version'] = VERSION
    coverage.update(version=VERSION, assessed_at=AUTHORED_AT)
    for key, title, inputs, logic, examples in EXTRA_RULES:
        pack['rules'].append({
            'rule_id': 'sse-private-' + key, 'version': '1', 'title': title,
            'enabled': False, 'enforcement': 'research_only', 'source_ref_ids': [],
            'applicability': {'document_stages':['registration','issuance'], 'issuer_scopes':['domestic-company'],
                              'investor_scopes':['professional'], 'industries':[], 'special_features':[]},
            'required_inputs': inputs,
            'checker': {'checker_id':'exchange-manual-evidence-review','checker_version':'unimplemented.1','parameter_version':VERSION},
            'exceptions': [], 'evidence_requirements':['本期材料/消息版本、逐字段证据定位','当期规则适用性与行业审核记录'],
            'outputs': {'when_met':'needs_judgement','when_not_met':'needs_evidence','severity':'warning'},
            'boundaries': [logic, '规则研究候选，尚无自动判定器或真实结果验收。'],
            **{field:[{'example_id':f'sse-private-{key}-{suffix}', 'summary':summary,
                        'expected_outcome':outcome,'evidence_ref':f'synthetic-authoring:{key}-{suffix}'}]
               for field,suffix,summary,outcome in zip(
                 ['positive_examples','negative_examples','boundary_examples'], ['pos','neg','bound'],
                 examples, ['pass','issue','needs_evidence'])},
            'owner_role':'industry_reviewer',
        })
    sources = {s['source_id']:s for s in pack['sources']}
    rule_map = []
    coverage_by_id = {item['item_id']: item for item in coverage['items']}
    chapter_by_id = {c['chapter_id']: c for c in template['chapters']}
    assert {r['rule_id'].removeprefix('sse-private-') for r in pack['rules']} == set(MAPPINGS)
    assert set(REVIEW_ITEMS) == set(MAPPINGS)
    for rule in pack['rules']:
        key = rule['rule_id'].removeprefix('sse-private-')
        chapters, pairs, limit = MAPPINGS[key]
        refs = [official_reference(documents, *pair) for pair in pairs]
        for ref in refs:
            sources[ref['source_id']] = ref
        ref_ids = [r['source_id'] for r in refs]
        rule['source_ref_ids'] = list(dict.fromkeys(rule['source_ref_ids'] + ref_ids))
        rule['version'] = '2'
        rule['checker']['parameter_version'] = VERSION
        rule['exceptions'] = [limit]
        if key in OVERRIDES:
            rule['boundaries'][0] = OVERRIDES[key]
        rule['boundaries'].append('官方取证与待验收边界：' + limit)
        if key in EXECUTABLE_CHECKS or key in MANUAL_HANDLERS:
            rule['version'] = '6'
            rule['checker'] = {'checker_id':'sse-private-structured-evidence',
                               'checker_version':'4','parameter_version':VERSION}
            rule['boundaries'][1] = ('已有受限结构化证据检查' if key in EXECUTABLE_CHECKS else '已有明确人工审核处理及防误用检查，不作自动资格结论') + '，见EXECUTABLE-CHECKS.md；仅research_only，不等于已签认/发布或全文合规。'
        handling = ADDITIONAL_CHECKS.get(key) or MANUAL_HANDLERS.get(key)
        if handling:
            rule['boundaries'].append('本条实际处理：' + handling[2])
        item = coverage_by_id.get(key, {'item_id':key,'area':rule['title'],'document_stages':['registration','issuance']})
        item.update(disposition='uncovered', source_ref_ids=rule['source_ref_ids'],
                    rationale='已登记官方证据/内部方法及章节映射；尚无行业签认、执行checker和真实结果验收。' + limit)
        if key in EXECUTABLE_CHECKS:
            item['rationale'] = '已实现受限结构化证据检查；尚缺事实接入、行业签认和真实结果验收，仍未完整覆盖。' + limit
        elif key in MANUAL_HANDLERS:
            item['rationale'] = '已实现明确人工审核处理及防误用检查；仍无自动专业判断，待专业覆盖决定/依据及真实结果验收。' + limit
        coverage_by_id[key] = item
        for chapter_id in chapters:
            chapter = chapter_by_id[chapter_id]
            chapter['source_ref_ids'] = list(dict.fromkeys(chapter['source_ref_ids'] + ref_ids))
        rule_map.append({
            'rule_id':rule['rule_id'], 'title':rule['title'], 'chapter_ids':chapters,
            'required_inputs':rule['required_inputs'], 'source_ref_ids':rule['source_ref_ids'],
            'official_evidence': [{'document_id':d,'locator':loc,
                'published_on':documents[d]['published_on'],'effective_from':documents[d]['effective_from'],
                'effective_to':documents[d]['effective_to']} for d,loc in pairs],
            'not_applicable_or_uncovered':limit, 'professional_review':'pending',
            'result_acceptance':'pending',
            'engineering_check': 'bounded-research-check-v4' if key in EXECUTABLE_CHECKS else 'manual-evidence-handler-v4',
            'documentary_review': {'status':'completed_with_explicit_limits','reviewer':'Codex documentary analysis',
                                    'reviewed_at':AUTHORED_AT,'baseline_as_of':'2026-09-26',
                                    'record':'RULE-REVIEW-20260927.md#'+key},
        })
    pack['sources'] = list(sources.values())
    coverage['items'] = list(coverage_by_id.values())
    for chapter in template['chapters']:
        chapter['applicability'] = chapter['applicability'].replace(' 公募分支还须叠加对应差异规则；', ' ')
        chapter['applicability'] += ' 本次为私募范围；8.1章优先于公开发行专用文字。目录为专家工作骨架，可按有效原稿结构映射。'
    coverage['open_blockers'][0].update(
        description='10份官方证据已登记；证监会发布机关现行核验、协会负面清单/适当性/受托与会议规则、税务及特殊主体等尚待补齐并专业签认。',
        required_evidence='verification/2026-09-26目录逐条核验、现行配套规则及适用性签认；不得把抓取或hash一致当行业审核。')
    coverage['open_blockers'].append({
        'blocker_id':'applicability-context',
        'description':'#311已有整体审核/撤回及loader分支；仍需#19九维到十二码映射、已发布字典与真实项目/来源审核，不能默认批准。',
        'required_evidence':'instrument/documentStage/issuerScope/investorScope/industry/specialFeatures/asOf均有本期证据及真实审核。'})
    write_json(BASE / 'drafts/sse-private/rule-evidence-map.json', {
        'version':VERSION, 'status':'research_only', 'rules':rule_map,
        'chapters':[{'chapter_id':c['chapter_id'], 'rule_ids':[r['rule_id'] for r in rule_map if c['chapter_id'] in r['chapter_ids']],
                     'uncovered': '税务现行依据与具体税率待核；不因目录有税项就认定合规覆盖。' if c['chapter_id']=='tax' else '须在真实成果中逐项确认披露和证据。'} for c in template['chapters']],
    })
    write_review_report(BASE, pack, documents, MAPPINGS, REVIEW_ITEMS, VERSION, AUTHORED_AT)
    lines = ['# #20 逐条规则审核清单', '', f'版本：`{VERSION}`。31条已完成有边界的文献核对；{len(EXECUTABLE_CHECKS)}条有受限检查，6条有明确人工审核处理。专业签认/真实结果另验。', '',
             '已填好的[逐条依据、适用性、例外、处理和正反例记录](RULE-REVIEW-20260927.md)是本轮交付，不再将工程处理列为20条空白；不代填真人审核或发布审批。', '',
             '由 `scripts/sse_private_review_items.py` 与来源映射生成，不在本文件直接签认。正式审核记录须绑定此版本/commit、实际审核人及权限、时间、决定、理由和证据；本表不写入发布审批。', '',
             '每条可选择同意、修改或待补证；同意文本方法不等于批准来源现行效力、真实财务事实或最终Word。工程检查的合成用例见 [交接](EXECUTABLE-CHECKS.md)，真实成果另填 [验收表](ACCEPTANCE.md)。', '']
    for row in rule_map:
        key = row['rule_id'].removeprefix('sse-private-')
        decision, next_step = REVIEW_ITEMS[key]
        handling = ADDITIONAL_CHECKS.get(key) or MANUAL_HANDLERS.get(key)
        if handling:
            next_step = '已实现 ' + handling[0] + ' 处理；可信事实/完整枚举适配、剩余专业判断与真实成果验收待完成。'
        refs = ' · '.join(f'[{d}/{loc}](../../verification/2026-09-26/sources/{d}.md#{loc.lower()})' for d, loc in MAPPINGS[key][1]) or '本切片尚无经登记的官方依据，待补齐。'
        lines += [f'## {row["title"]}', '', f'规则：`{row["rule_id"]}`；工程：{row["engineering_check"]}；业务审核：待填写。', '',
                  '具体审核决定/反例：' + decision, '', '依据：' + refs, '',
                  '范围与保留项：' + row['not_applicable_or_uncovered'], '', '下一份交付：' + next_step, '',
                  f'文献核对已填：[结论与验收](RULE-REVIEW-20260927.md#{key})；真人专业签认及发布记录仍另行填写。', '']
    (BASE / 'drafts/sse-private/RULE-REVIEW-CHECKLIST.md').write_text('\n'.join(lines), 'utf8')
    return pack, template, coverage


def overlay_readme(pack):
    lines = ['## 2026-09-26 官方取证与增量映射', '',
             '本目录版本已更新为 **' + VERSION + '**；以上通用章节说明保留作为基线。以下规则及机器包为本次私募范围的增量，以此处对旧草稿的明确修正为准。', '',
             '[官方证据登记与局限](../../verification/2026-09-26/README.md) · [逐规则/章节映射](rule-evidence-map.json) · [适用性与真实样本验收](ACCEPTANCE.md)', '']
    for rule in pack['rules']:
        lines += ['### ' + rule['title'], '', rule['boundaries'][0], '', '未覆盖/例外：' + rule['exceptions'][0], '',
                  '输入：' + '、'.join(rule['required_inputs']) + '。', '']
        official = [s for s in pack['sources'] if s['source_id'] in rule['source_ref_ids'] and s['source_id'].startswith('ov-')]
        for ref in official:
            did = ref['source_id'][3:].rsplit('-', 1)[0]
            loc = ref['clause_locator']
            lines += [f'- [{did} / {loc}](../../verification/2026-09-26/sources/{did}.md#{loc.lower()})；发布 {ref["published_on"]}，生效 {ref["effective_from"] or "未单列"}。']
        lines += ['']
    return '\n'.join(lines)
