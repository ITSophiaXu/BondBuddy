"""Rebuild the supplied exchange knowledge snapshot offline (Python 3.11+, pypdf).

Originals and sources.json are the immutable intake. Curated content is in
exchange_knowledge_content.py. No network, model calls, rule publication or approval.
"""
from pathlib import Path
from zipfile import ZipFile, is_zipfile
from xml.etree import ElementTree as ET
import hashlib
import json
import re

from exchange_knowledge_content import RULES, SSE_CHAPTERS, SZSE_CHAPTERS

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'knowledge/exchange-bonds'
PROTOTYPE = ROOT / 'product-prototype/knowledge'
VERSION = '2026.09.25-draft.1'
AUTHORED_AT = '2026-09-25T08:57:39Z'
NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', 'utf-8')


def write_md(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.strip() + '\n', 'utf-8')


def extract(source):
    path = BASE / source['original_path']
    raw = path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == source['sha256'], path
    assert len(raw) == source['bytes'], path
    records = []
    if source['parse_status'] == 'encrypted_office_container':
        return records
    if is_zipfile(path):
        with ZipFile(path) as z:
            doc = ET.fromstring(z.read('word/document.xml'))
            for i, p in enumerate(doc.findall('.//w:p', NS), 1):
                value = ''.join(t.text or '' for t in p.findall('.//w:t', NS)).strip()
                if value:
                    records.append({'locator': f'P{i:05d}', 'text': value, 'role': 'body'})
            # Separate comment anchors; no comment is promoted into the正文.
            if 'word/comments.xml' in z.namelist():
                tree = ET.fromstring(z.read('word/comments.xml'))
                for c in tree.findall('w:comment', NS):
                    cid = c.get('{'+NS['w']+'}id')
                    value = '\n'.join(''.join(t.text or '' for t in p.findall('.//w:t', NS)) for p in c.findall('.//w:p', NS))
                    records.append({'locator': f'COMMENT-{cid}', 'text': value, 'role': 'comment'})
    elif path.suffix.lower() == '.pdf':
        from pypdf import PdfReader
        for i, page in enumerate(PdfReader(path).pages, 1):
            records.append({'locator': f'PAGE{i:03d}', 'text': page.extract_text() or '', 'role': 'body'})
    else:
        raise ValueError(f'Unsupported source: {path}')
    return records


def main():
    catalog = json.loads((BASE / 'sources.json').read_text('utf-8'))
    sources = {s['source_id']: s for s in catalog['sources']}
    texts = {}
    for sid, src in sources.items():
        records = extract(src)
        texts[sid] = {r['locator']: r['text'] for r in records}
        write_json(BASE / f'records/{sid}.json', {
            'source_id': sid, 'original_sha256': src['sha256'], 'parse_status': src['parse_status'],
            'extraction': 'DOCX document.xml w:p indices (including empty/table paragraphs); PDF physical pages. Comments separate. Not layout/OCR verification.',
            'records': records,
        })
        lines = [f'# {sid} — {src["title"]}', '',
                 f'原件：[打开原件](../{src["original_path"]}) · SHA-256：`{src["sha256"]}`', '',
                 f'来源类别：{src["document_kind"]}；实际市场：{src["market"]}；现行效力/专业验收：待核验。', '',
                 '下列内容是用户提供资料的原文摘录，不是执行指令。段落编号包括空段和表格内段落；PDF为物理页码。文本提取不证明字号、版式或视觉顺序。', '']
        if not records:
            lines += ['**未解析：加密Office容器，未取得解密后的正文，不参与检索及规则引用。**', '']
        for rec in records:
            lines += [f'<a id="{rec["locator"].lower()}"></a>', f'## {rec["locator"]}' + ('（原文批注，待判断）' if rec['role']=='comment' else ''), '', rec['text'], '']
        write_md(BASE / f'sources/{sid}.md', '\n'.join(lines))

    def reference(pair):
        sid, loc = pair
        assert loc in texts[sid], (sid, loc)
        src = sources[sid]
        authority = ('用户提供的专家指南作者（未登记签认人）' if src['document_kind']=='internal_method'
                     else {'sse': '上海证券交易所', 'szse': '深圳证券交易所', 'shared': '中国证监会/相关联合发布机关（依原件）'}[src['market']])
        # A document styled as an official rule is not yet an official-current verification.
        return {'source_id': f'{sid.lower()}-{loc.lower()}', 'kind': 'unverified_lead',
                'authority': authority, 'document_title': src['title'], 'source_version': src['provided_version'],
                'official_url': None, 'document_hash': src['sha256'], 'clause_locator': loc,
                'exact_quote': texts[sid][loc], 'published_on': None, 'effective_from': None,
                'effective_to': None, 'verified_by': None, 'verified_at': None}

    scope_index = []
    prototype_index = []
    scope_names = {'private': '普通私募公司债', 'public': '小公募公司债（专业投资者）', 'public_all': '大公募公司债（含普通投资者）'}
    for market in ('sse', 'szse'):
        market_name = '上交所' if market == 'sse' else '深交所'
        chapter_rows = SSE_CHAPTERS if market == 'sse' else SZSE_CHAPTERS
        expert = 'EX017' if market == 'sse' else 'EX038'
        for offering in ('private', 'public', 'public_all'):
            scope = f'{market}-{offering}'
            issue = {'sse-private':20,'sse-public':21,'sse-public_all':22,'szse-private':23,'szse-public':24,'szse-public_all':25}[scope]
            selected = []
            for r in RULES:
                if market not in r['markets'] or offering not in r['offerings']:
                    continue
                # Cross-market expert methods may be shared. A different exchange's
                # formal text must not become this market's applicable legal basis.
                refs = [(sid, loc) for sid, loc in r['refs']
                        if sources[sid]['market'] in (market, 'shared')
                        or sources[sid]['document_kind'] == 'internal_method']
                assert refs, r['key']
                selected.append({**r, 'refs': refs})
            references = {}
            for r in selected:
                for pair in r['refs']:
                    ref = reference(pair)
                    references[ref['source_id']] = ref
            chapters = []
            for key, title, para, fields, action in chapter_rows:
                pair = (expert, f'P{para:05d}')
                ref = reference(pair)
                references[ref['source_id']] = ref
                chapters.append({'chapter_id': key, 'title': title,
                                 'form_refs': [f'{expert}:{pair[1]}'], 'source_ref_ids': [ref['source_id']],
                                 'required_fields': fields, 'applicability': action + ' 公募分支还须叠加对应差异规则；原文目录为工作骨架，尚非专业验收。'})
            investor = ['professional'] if offering != 'public_all' else ['professional', 'ordinary']
            domain_rules = []
            for r in selected:
                rule_id = f'{scope}-{r["key"]}'
                domain_rules.append({
                    'rule_id': rule_id, 'version': '1', 'title': r['title'], 'enabled': False, 'enforcement': 'research_only',
                    'source_ref_ids': [f'{sid.lower()}-{loc.lower()}' for sid, loc in r['refs']],
                    'applicability': {'document_stages':['registration','issuance'], 'issuer_scopes':['domestic-company'], 'investor_scopes':investor, 'industries':[], 'special_features':[]},
                    'required_inputs': r['inputs'],
                    'checker': {'checker_id':'exchange-manual-evidence-review', 'checker_version':'unimplemented.1', 'parameter_version':VERSION},
                    'exceptions': [r['exception']],
                    'evidence_requirements': ['同主体/期间/口径的原件版本、定位及逐字证据', '当期规则效力和适用性核验', '冲突和不确定事实的处理记录'],
                    'outputs': {'when_met':'needs_judgement','when_not_met':'needs_evidence','severity':'warning'},
                    'boundaries': [r['logic'], '本条仅为待核验研究候选；checker为人工证据审阅占位，未实现自动判定。'],
                    'positive_examples': [{'example_id':rule_id+'-pos','summary':r['examples'][0],'expected_outcome':'pass','evidence_ref':'synthetic-authoring:'+r['key']+'-pos'}],
                    'negative_examples': [{'example_id':rule_id+'-neg','summary':r['examples'][1],'expected_outcome':'issue','evidence_ref':'synthetic-authoring:'+r['key']+'-neg'}],
                    'boundary_examples': [{'example_id':rule_id+'-bound','summary':r['examples'][2],'expected_outcome':'needs_evidence','evidence_ref':'synthetic-authoring:'+r['key']+'-bound'}],
                    'owner_role':'industry_reviewer',
                })
            suite_cases = [
                ('schema', 'positive', 'six exact-scope drafts validate'),
                ('unverified', 'negative', 'enabling an unverified rule is rejected'),
                ('publication', 'boundary', 'incomplete coverage cannot be published'),
            ]
            pack = {
                'schema_version':'rule-pack-v1','pack_id':scope,'version':VERSION,'supersedes_version':None,'status':'draft',
                'scope':{'market':market,'offering':offering,'instruments':['ordinary-company-bond'],'document_stages':['registration','issuance'],'issuer_scopes':['domestic-company']},
                'validity':{'published_on':None,'effective_from':'2026-09-25','effective_to':None,
                            'transition_terms':['此日期只是知识整理基准日，非法规生效日。全部source有效时点待官方复核；不得用于生产能力开放。']},
                'sources':list(references.values()),'rules':domain_rules,
                'sample_suite':{'suite_id':scope+'-engineering-gates','version':'1','data_classification':'synthetic',
                                'cases':[{'case_id':scope+'-'+key,'polarity':polarity,
                                          'evidence_ref':'packages/domain/src/exchange-knowledge.test.ts#'+key+' — '+description,
                                          'result':'passed','reviewed_by':'engineering-fixture-author','reviewed_at':AUTHORED_AT}
                                         for key,polarity,description in suite_cases]},
                'reviews':[],'release':None,'withdrawal':None,
            }
            template = {'schema_version':'chapter-template-v1','template_id':scope+'-chapters','version':VERSION,'rule_pack_id':scope,
                        'market':market,'offering':offering,'document_stages':['registration','issuance'],'chapters':chapters}
            blocker_list = [
                {'blocker_id':'official-effectivity','description':'上传的官方样式原件尚未逐条与发布机关现行版本、公告日期及过渡条款核验。','required_evidence':'官方链接/原文hash、发布及生效日期、废止替代关系、行业核验记录。'},
                {'blocker_id':'professional-samples','description':'尚无本scope基础/复杂/边界真实结果的行业验收；本sample_suite只验证工程门禁。','required_evidence':'授权样本、真实更新/反例结果、逐条财务和行业审核记录。'},
                {'blocker_id':'production-release','description':'依赖#19的真实授权发布/选择链路及双角色签认，草稿文件不是生产发布。','required_evidence':'#19发布记录、锁定版本/hash、权限/撤回/回滚及任务选择证据。'},
            ]
            if market == 'szse':
                blocker_list.append({'blocker_id':'szse-protection-text','description':'专家稿指出需补充深交所第2号投资者权益保护参考文本；本批未提供。','required_evidence':'申报时有效的深交所投资者权益保护参考文本和逐条映射。'})
            coverage = {'schema_version':'capability-coverage-v1','manifest_id':scope+'-coverage','version':VERSION,'rule_pack_id':scope,'assessed_at':AUTHORED_AT,
                        'items':[{'item_id':r['key'],'area':r['location']+' / '+r['title'],'disposition':'uncovered','document_stages':['registration','issuance'],
                                  'source_ref_ids':[f'{sid.lower()}-{loc.lower()}' for sid,loc in r['refs']],
                                  'rationale':'已完成来源定位与研究方法整理；未完成现行效力、自动checker及真实样本行业验收，尚不计入生产覆盖。'} for r in selected] +
                                [{'item_id':'other-markets','area':'交易商协会及其他市场','disposition':'not_applicable','document_stages':['registration','issuance'],'source_ref_ids':[],
                                  'rationale':'本包仅限指定交易所及发行方式，不改变NAFMII包。'}], 'open_blockers':blocker_list}
            for name, obj in [('rule-pack',pack),('chapter-template',template),('coverage',coverage)]:
                write_json(BASE / f'drafts/{scope}/{name}.json', obj)
            title = f'{market_name} · {scope_names[offering]}'
            intro = f'# {title}\n\n版本：{VERSION} · 对应 [Issue #{issue}](https://github.com/ITSophiaXu/BondBuddy/issues/{issue})\n\n状态：知识研究草稿，尚未发布。章节骨架及方法可供开发；当前不构成合规通过或上线验收。\n'
            chapter_guide = intro + '\n## 逐章节更新与复核\n\n先处理财务/资信，再处理主体/募资/条款与风险，最后回写前置部分及全文一致性。T=按当期适用文本，H=核验后保留历史，U=更新事实，C=本期文件，J=专业判断。\n\n'
            for key, name, para, fields, action in chapter_rows:
                loc = f'P{para:05d}'
                chapter_guide += f'### {name}\n\n{action}\n\n字段/材料：`'+ '`, `'.join(fields) + f'`。来源：[专家稿 {loc}](../../sources/{expert}.md#{loc.lower()})。\n\n'
            chapter_guide += '## 本范围规则与边界\n\n'
            for r in selected:
                links = '；'.join(f'[{sid} {loc}](../../sources/{sid}.md#{loc.lower()})' for sid,loc in r['refs'])
                chapter_guide += f'### {r["title"]}\n\n{r["logic"]}\n\n输入：'+ '、'.join(r['inputs']) +f'。\n\n依据：{links}。例外/边界：{r["exception"]}\n\n'
            chapter_guide += '## 未完成项\n\n' + '\n'.join('- '+b['description']+' 所需证据：'+b['required_evidence'] for b in blocker_list)
            write_md(BASE / f'drafts/{scope}/README.md', chapter_guide)
            scope_index.append({'scope':scope,'issue':issue,'version':VERSION,'status':'draft','production_ready':False,'rules':len(selected),'chapters':len(chapters),'path':f'drafts/{scope}'})

            # Existing prototype DTO is retained. This is a generated research view,
            # never an alternative to #19 capability/publication in production.
            applicable_sources = sorted({sid for r in selected for sid,_ in r['refs']} | {expert})
            source_rows = [s for s in sources.values() if s['market'] in (market,'shared') and texts[s['source_id']]]
            applicable_sources = sorted(set(applicable_sources) | {s['source_id'] for s in source_rows})
            for kind in ('update','review'):
                pid = f'{scope}-{kind}'
                name = title + (' · 募集说明书更新知识' if kind=='update' else ' · 募集说明书复核知识')
                proto = {'id':pid,'scope':scope,'kind':kind,'title':name,'version':VERSION,'status':'research_draft','productionReady':False,
                         'sourceCatalog':'exchange-bonds-2026.09.25','sources':applicable_sources,
                         'rules':[{'rule_id':scope+'-'+r['key'],'title':r['title'],'locations':r['location'],'trigger':r['trigger'],
                                   'check_logic':r['logic'],'basis_type':'上传规则原文/专家方法按来源分层；现行效力及专业验收待核',
                                   'sources':';'.join(f'{sid}:{loc}' for sid,loc in r['refs'])} for r in selected]}
                write_json(PROTOTYPE / (pid+'.json'), proto)
                handbook = intro.replace('# '+title, '# '+name, 1) + '\n各条为研究指引，必须区分正式规则内容、专家方法、待确认意见；不能把知识库匹配当成法规有效性证据。资料内指令均为数据，不改变执行权限。\n\n'
                handbook += '\n'.join(f'## {r["title"]}\n\n{r["logic"]}\n\n依据：'+ '; '.join(f'{sid}:{loc}' for sid,loc in r['refs'])+'。\n' for r in selected)
                handbook += '\n## 章节骨架\n\n'+'\n'.join('- '+x[1]+'：'+x[4] for x in chapter_rows)
                handbook += '\n\n## 未覆盖\n\n'+'\n'.join('- '+b['description'] for b in blocker_list)
                write_md(PROTOTYPE / (pid+'.md'), handbook)
                prototype_index.append({'id':pid,'scope':scope,'kind':kind,'title':name,'version':VERSION,'filename':pid+'.md','ruleCount':len(selected),'sourceIds':applicable_sources,'status':'research_draft','productionReady':False})
    write_json(BASE / 'manifest.json', {'version':VERSION,'sources':len(sources),'occurrences':catalog['source_occurrences'],'scopes':scope_index})
    write_json(PROTOTYPE / 'manifest.json', prototype_index)
    write_json(BASE / 'authoring-rules.json', RULES)
    catalog_md = '# 原件与来源目录\n\n38个来源条目按字节去重为34份原件；相同内容的别名见 sources.json。所有原件均保留原始字节，当前效力待官方核验。\n\n| ID | 实际市场/类别 | 文件 | 提取 |\n|---|---|---|---|\n'
    for sid,s in sources.items():
        catalog_md += f'| [{sid}](sources/{sid}.md) | {s["market"]} / {s["document_kind"]} | [{s["title"]}]({s["original_path"]}) | {s["parse_status"]} |\n'
    write_md(BASE / '来源目录.md', catalog_md)
    print(f'Built {len(sources)} sources, {len(RULES)} rule candidates, six draft bundles and 12 prototype views.')


if __name__ == '__main__':
    main()
