"""Synthetic edits of authorized originals; never real-run/human acceptance."""
import copy
import hashlib
import json
import re
import tempfile
import unittest
from decimal import Decimal, ROUND_HALF_UP, localcontext
from pathlib import Path
from zipfile import ZipFile
from openpyxl import load_workbook, Workbook
from lxml import etree as ET

from prospectus_acceptance_inspect import (Reader, FinancialSources, SOURCE_BINDINGS, POLICY, ALIASES,
    RQ_TABLE_ROLES, RQ_NARRATIVE_ROLES, ROLE_IDS, EXTENDED, STOCK, extended_lists, finite_decimal, numeric_cache, metric_ok)
from bondbuddy_file_authoring.check import package
from bondbuddy_file_authoring.word_patch import paragraph_text, q, xml, serialized

def golden():
    base = Path(__file__).resolve().parents[1] / 'tests/samples/2026-09-25'
    manifest = json.loads((base/'manifest.json').read_text(encoding='utf-8'))
    case = next(c for c in manifest['cases'] if c['case_id'] == 'rq-202509')
    files = {f['file_id']: base/f['path'] for f in case['files']}
    for f in case['files']:
        if hashlib.sha256(files[f['file_id']].read_bytes()).hexdigest() != f['sha256']:
            raise AssertionError('authorized source hash')
    return case, files

def source_checks():
    case, files = golden()
    book = load_workbook(files['rq-202509-02'], read_only=True, data_only=True, keep_links=False)
    result = {}
    with ZipFile(files['rq-202509-02']) as archive:
        for key, binding in SOURCE_BINDINGS.items():
            # Test truth reads the worksheet path supplied by openpyxl separately
            # from the production workbook-relationship reader.
            tree = xml(archive.read(book[binding['sheet']]._worksheet_path))
            ns = {'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            cell = tree.find(f'.//s:sheetData/s:row/s:c[@r="{binding["cell"]}"]/s:v', ns)
            raw = cell.text
            with localcontext() as context:
                context.prec = 100
                output = (Decimal(raw)/Decimal(10000)).quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
            start = '2025-09-30' if binding['stock'] else '2025-01-01'
            result[key] = {'scope':key[0], 'metric':key[1],
                'source':{'file_id':'rq-202509-02','sha256':POLICY['source_sha256'], 'locator':binding['locator'],
                          'scope':key[0], 'start':start,'end':'2025-09-30','unit':'CNY','value':raw},
                'output':{'scope':key[0],'start':start,'end':'2025-09-30','value':str(output),'unit':'CNY_10K','decimal_places':2}}
    book.close()
    return case, files, result


class FinancialSourceBindings(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.case, cls.files, cls.rows = source_checks()

    def test_all_18_exact_raw_caches_headers_labels_and_periods(self):
        source = FinancialSources()
        try:
            self.assertEqual(len(self.rows),18)
            for key, row in self.rows.items():
                with self.subTest(key=key):
                    self.assertEqual(source.value(self.files['rq-202509-02'],row,self.case['issuer']),Decimal(row['source']['value']))
        finally:
            source.close()

    def test_exact_role_ids_agree_with_shared_policy(self):
        self.assertEqual(len(ROLE_IDS),39)
        self.assertEqual(len(set(ROLE_IDS)),39)
        self.assertEqual(set(ROLE_IDS),set(POLICY['required_role_ids']))
        self.assertEqual(POLICY['required_occurrences'],39)
        self.assertEqual({(s,m) for _,_,s,m in RQ_TABLE_ROLES}|{(s,m) for _,s,m in RQ_NARRATIVE_ROLES},set(SOURCE_BINDINGS))

    def test_missing_blank_error_string_and_nonfinite_cache_are_rejected(self):
        namespace='http://schemas.openxmlformats.org/spreadsheetml/2006/main'
        valid=xml(f'<c xmlns="{namespace}" r="D20"><v>1.200000000000001</v></c>'.encode())
        self.assertEqual(numeric_cache(valid),Decimal('1.200000000000001'))
        invalid=[None]+[xml(f'<c xmlns="{namespace}" r="D20" {kind}>{body}</c>'.encode()) for kind,body in (
            ('',''),('','<v/>'),('','<f>A1+A2</f>'),('t="e"','<v>#VALUE!</v>'),
            ('t="s"','<v>0</v>'),('t="inlineStr"','<is><t>0</t></is>'),
            ('','<v>NaN</v>'),('','<v>Infinity</v>'),('','<v>1e3</v>'))]
        for cell in invalid:
            with self.assertRaises(ValueError):numeric_cache(cell)

    def test_wrong_scope_cell_unit_period_and_truncated_raw_cache_are_rejected(self):
        source = FinancialSources()
        row = self.rows['consolidated','net_profit']
        try:
            source.value(self.files['rq-202509-02'],row,self.case['issuer'])
            for mutate in [lambda r:r['source'].update(locator='02合并利润表!D49'),
                           lambda r:r['source'].update(unit='CNY_10K'),
                           lambda r:r['source'].update(start='2025-09-30'),
                           lambda r:r['source'].update(locator='02母公司利润表!D44'),
                           lambda r:r['source'].update(value=str(Decimal(r['source']['value']).quantize(Decimal('.00000001'))))]:
                wrong = copy.deepcopy(row);mutate(wrong)
                with self.assertRaises(ValueError):
                    source.value(self.files['rq-202509-02'],wrong,self.case['issuer'])
            wrong=copy.deepcopy(self.rows['consolidated','profit_attributable_to_parent'])
            wrong['scope']=wrong['source']['scope']='parent'
            with self.assertRaises(ValueError): source.value(self.files['rq-202509-02'],wrong,self.case['issuer'])
        finally: source.close()

    def test_header_checks_cannot_accept_hidden_other_entity_period_or_label(self):
        binding=SOURCE_BINDINGS['consolidated','sales_expenses']
        def sheet():
            ws=Workbook().active
            for cell,value in {'A1':binding['statement_title'],'A3':binding['entity_header'],'B3':binding['period_header'],
                               'D4':binding['column_header'],binding['label_cell']:binding['label'],'E3':'金额单位：人民币元'}.items():ws[cell]=value
            return ws
        FinancialSources.headers(sheet(),binding)
        for cell,value in [('A1','母公司利润表'),('A3','编制单位：另一企业'),('B3','2025年1-6月'),('D4','上期金额'),('A20','管理费用'),('E3','金额单位：人民币万元')]:
            ws=sheet();ws[cell]=value
            with self.assertRaises(ValueError):FinancialSources.headers(ws,binding)
        ws=sheet();ws.sheet_state='hidden'
        with self.assertRaises(ValueError):FinancialSources.headers(ws,binding)
        for value in ('NaN','Infinity','1e3','1.2e-6','',None,1.0):
            with self.assertRaises(ValueError):finite_decimal(value)

    def test_attribution_and_investment_labels_do_not_accept_other_facts(self):
        self.assertTrue(metric_ok('1.归属于母公司所有者的净利润（净亏损以“-”号填列）','profit_attributable_to_parent',cell=True))
        for value in ('净利润','归属于母公司所有者权益合计','归属于母公司所有者的综合收益总额'):
            self.assertFalse(metric_ok(value,'profit_attributable_to_parent',cell=True))
        self.assertFalse(metric_ok('其中：对联营企业和合营企业的投资收益','investment_income',cell=True))
        self.assertFalse(metric_ok('归属于母公司所有者的净利润','net_profit',cell=True))

    def test_single_amount_exemption_requires_source_bound_historical_or_whole_other_subject(self):
        historical='2023年度，发行人销售费用为100.00万元。'
        other='子公司甲的销售费用为100.00万元。'
        for clause in (historical,other):
            self.assertTrue(Reader.historical_or_other_entity_single_clause(clause,'sales_expenses'))
            # Eligibility never exempts a caller's assertion by itself.
            self.assertTrue(Reader.unsupported_metric_lists(clause,'sales_expenses'))
        for clause in ('2023年度以来，本期发行人销售费用为100.00万元。',
                       '担保人说明，发行人销售费用为100.00万元。','报告期内，发行人销售费用为100.00万元。'):
            self.assertFalse(Reader.historical_or_other_entity_single_clause(clause,'sales_expenses'))
        denominator='最近两年及一期末，发行人的资产中以非流动资产为主，分别为853,341.29万元、867,817.39万元和824,905.29万元，分别占当期期末总资产规模的55.54%、53.45%和51.32%。'
        self.assertEqual(Reader.unsupported_metric_lists(denominator,'total_assets'),[])
        for clause in ('本期100.00万元为发行人销售费用。','100.00万元的销售费用。','报告期内，发行人销售费用为100.00万元。'):
            self.assertTrue(Reader.unsupported_metric_lists(clause,'sales_expenses'))


class ExpandedAmountRegression(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.case,cls.files,cls.rows=source_checks()
        source=FinancialSources()
        try:
            for row in cls.rows.values():source.value(cls.files['rq-202509-02'],row,cls.case['issuer'])
        finally:source.close()
        cls.parts=package(cls.files['rq-202509-01'])
        # All variants read the same SHA-verified, immutable original. Reuse
        # only that parsed source; each output has fresh caches and real checks.
        cls.source_reader=Reader(source=cls.files['rq-202509-01'],issuer=cls.case['issuer'])
        cls.source_reader.occurrence_document(str(cls.files['rq-202509-01']))
        document=xml(cls.parts['word/document.xml'])
        for paragraph in document.iter(q('p')):
            text=paragraph_text(paragraph)
            changed=text.replace('6','9') if re.sub(r'\s+','',text)=='2025年1-6月/6月末' else re.sub(r'(2025\s*年\s*(?:1\s*[-—–至]\s*)?)6(\s*月)',r'\g<1>9\2',text)
            if changed!=text:cls.put(paragraph,changed)
        tables=list(document.iter(q('tbl')));paragraphs=list(document.iter(q('p')))
        for t,r,scope,metric in RQ_TABLE_ROLES:
            cls.put(tables[t-1].findall(q('tr'))[r-1].findall(q('tc'))[1],cls.rows[scope,metric]['output']['value'])
        for p,scope,metric in RQ_NARRATIVE_ROLES:
            paragraph=paragraphs[p-1];text=paragraph_text(paragraph)
            spans=Reader.metric_list_clauses(text,metric)
            if len(spans)!=1:raise AssertionError((p,metric,spans))
            start,end=spans[0];quote=text[start:end]
            amounts=list(re.finditer(r'(-?[0-9]+(?:,[0-9]{3})*\.[0-9]+)\s*万元',quote))
            if len(amounts)!=3:raise AssertionError((p,metric,'amount_count'))
            a,b=amounts[2].span(1)
            cls.put(paragraph,text[:start+a]+cls.rows[scope,metric]['output']['value']+text[start+b:])
        cls.positive=serialized(document)

    @staticmethod
    def put(node,text):
        texts=list(node.iter(q('t')))
        if not texts:
            paragraph=node if node.tag==q('p') else next(node.iter(q('p')))
            texts=[ET.SubElement(ET.SubElement(paragraph,q('r')),q('t'))]
        for i,leaf in enumerate(texts):leaf.text=text if i==0 else ''

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='bb-synthetic-expanded-amounts-')
        self.counter=0

    def tearDown(self):self.temp.cleanup()

    def fixture(self):
        document=xml(self.positive)
        refs={'p':list(document.iter(q('p'))),'t':list(document.iter(q('tbl')))}
        refs['rows']={(t,r):refs['t'][t-1].findall(q('tr'))[r-1] for t,r,_,_ in RQ_TABLE_ROLES}
        return document,refs

    def evaluate(self,document,refs,*,omit=(),overrides=None):
        self.counter+=1
        path=str(Path(self.temp.name)/f'synthetic-{self.counter}.docx')
        with ZipFile(path,'w') as archive:
            for name,raw in self.parts.items():archive.writestr(name,serialized(document) if name=='word/document.xml' else raw)
        reader=copy.copy(self.source_reader)
        for name in ('packages','roots','story_nodes','grids','occurrence_documents'):
            setattr(reader,name,dict(getattr(self.source_reader,name)))
        paragraphs=list(document.iter(q('p')));tables=list(document.iter(q('tbl')))
        p=lambda node:f'word/document.xml//w:p[{paragraphs.index(node)+1}]'
        cell=lambda table,row,column:f'word/document.xml#table={tables.index(table)+1},row={table.findall(q("tr")).index(row)+1},cell={column}'
        anchor=lambda locator:{'locator':locator,'quote':reader.node(path,locator)['text']}
        verified=[];errors=[];specs=[]
        for t,r,scope,metric in RQ_TABLE_ROLES:
            role=f'table:{t}:{scope}:{metric}'
            if role in omit:continue
            table=refs['t'][t-1];target=refs['rows'][t,r]
            if table not in tables or target not in table.findall(q('tr')):continue
            location=cell(table,target,2)
            header=table.findall(q('tr'))[5 if t==54 and metric in ('net_profit','operating_cash_flow') else 0]
            spec={'locator':location,'metric_anchor':anchor(cell(table,target,1)),'period_anchor':anchor(cell(table,header,2))}
            caption=reader.caption(table)
            if t in (55,79,98):
                spec.update(scope_anchor=anchor(p(refs['p'][4779])),scope_section_anchor=anchor(p(refs['p'][4778])),table_caption=anchor(p(caption)))
            else:spec['scope_anchor']=anchor(p(caption))
            row=self.rows[scope,metric]
            try:identity=reader.output_value(path,spec,row)
            except ValueError as error:errors.append((role,str(error)));continue
            record={'scope':scope,'metric':metric,'kind':'table','identity':identity}
            verified.append(record);specs.append((record,spec,row))
        for source_p,scope,metric in RQ_NARRATIVE_ROLES:
            role=f'narrative:{source_p}:{scope}:{metric}'
            if role in omit:continue
            paragraph=(overrides or {}).get(metric,refs['p'][source_p-1])
            if paragraph not in paragraphs:continue
            text=paragraph_text(paragraph);clauses=Reader.metric_list_clauses(text,metric)
            if len(clauses)!=1:errors.append((role,'no_unique_supported_clause'));continue
            start,end=clauses[0];quote=text[start:end]
            amounts=list(re.finditer(r'(-?[0-9]+(?:,[0-9]{3})*\.[0-9]+)\s*(?:亿元|万元|元)',quote))
            if len(amounts)!=3:errors.append((role,'no_complete_three_amount_list'));continue
            chosen=amounts[2]
            spec={'locator':p(paragraph),'quote':quote,'narrative_list':True,'start':chosen.start(1),'end':chosen.end(1),
                  'scope_anchor':anchor(p(refs['p'][4779]))}
            if source_p in (46,285):
                spec['scope_anchor']={'locator':p(refs['p'][43]),'quote':'本募集说明书其他章节中若无特殊说明，则财务数据及财务指标均为合并口径。'}
            else:
                glossary=refs['t'][1];glossary_row=glossary.findall(q('tr'))[28 if metric in STOCK else 27]
                spec['reporting_period_definition']={'section_anchor':anchor(p(refs['p'][163])),
                    'term_anchor':anchor(cell(glossary,glossary_row,1)),'definition_anchor':anchor(cell(glossary,glossary_row,3))}
            if source_p in (7931,7967) or metric in EXTENDED and metric not in STOCK:
                spec['period_context']={'section_anchor':anchor(p(refs['p'][4778])),'introduction_anchor':anchor(p(refs['p'][4779]))}
            row=self.rows[scope,metric]
            try:identity=reader.output_value(path,spec,row)
            except ValueError as error:errors.append((role,str(error)));continue
            record={'scope':scope,'metric':metric,'kind':'narrative_list','identity':identity}
            verified.append(record);specs.append((record,spec,row))
        return reader.occurrence_coverage(path,verified),errors,verified,(reader,path,specs)

    def test_real_source_driven_39_identity_fixture(self):
        coverage,errors,verified,_=self.evaluate(*self.fixture())
        self.assertEqual(errors,[])
        self.assertEqual(len(verified),39)
        self.assertEqual(coverage['status'],'passed',coverage)

    def test_each_of_six_missing_or_stale_narratives_rejects_correct_tables(self):
        for source_p,scope,metric in RQ_NARRATIVE_ROLES:
            if metric not in EXTENDED:continue
            with self.subTest(metric=metric):
                document,refs=self.fixture();role=f'narrative:{source_p}:{scope}:{metric}'
                coverage,_,verified,_=self.evaluate(document,refs,omit=(role,))
                self.assertEqual(sum(r['kind']=='table' for r in verified),26)
                self.assertIn({'role':role,'code':'required_occurrence_not_independently_checked'},coverage['failures'])
                text=paragraph_text(refs['p'][source_p-1]);span=Reader.metric_list_clauses(text,metric)[0]
                amounts=list(re.finditer(r'(-?[0-9]+(?:,[0-9]{3})*\.[0-9]+)\s*万元',text[span[0]:span[1]]));a,b=amounts[2].span(1)
                old=paragraph_text(list(xml(self.parts['word/document.xml']).iter(q('p')))[source_p-1])
                old_span=Reader.metric_list_clauses(old,metric)[0]
                old_value=list(re.finditer(r'(-?[0-9]+(?:,[0-9]{3})*\.[0-9]+)\s*万元',old[old_span[0]:old_span[1]]))[2][1]
                self.put(refs['p'][source_p-1],text[:span[0]+a]+old_value+text[span[0]+b:])
                coverage,errors,_,_=self.evaluate(document,refs)
                self.assertEqual(coverage['status'],'failed')
                self.assertIn((role,'output_value'),errors)

    def test_checked_primary_table_or_duplicate_identity_cannot_replace_missing_narrative(self):
        coverage,errors,verified,details=self.evaluate(*self.fixture())
        self.assertEqual(errors,[]);self.assertEqual(coverage['status'],'passed')
        reader,path,_=details
        for metric in EXTENDED:
            with self.subTest(metric=metric):
                narrative=next(r for r in verified if r['metric']==metric and r['kind']=='narrative_list')
                table=next(r for r in verified if r['metric']==metric and r['kind']=='table')
                replaced=[r for r in verified if r is not narrative]+[table]
                self.assertEqual(len(replaced),39)
                result=reader.occurrence_coverage(path,replaced)
                self.assertEqual(result['status'],'failed')
                self.assertNotIn(next(role for role in ROLE_IDS if role.startswith('narrative:') and role.endswith(':'+metric)),result['covered_role_ids'])

    def test_unsupported_stale_clause_and_correct_copy_cannot_replace_each_other(self):
        for source_p,scope,metric in RQ_NARRATIVE_ROLES:
            if metric not in EXTENDED:continue
            for variant in ('connector','shared_unit','period'):
                with self.subTest(metric=metric,variant=variant):
                    document,refs=self.fixture();old=refs['p'][source_p-1];fresh=copy.deepcopy(old);text=paragraph_text(old)
                    start,end=Reader.metric_list_clauses(text,metric)[0];clause=text[start:end]
                    if variant=='connector':clause=clause.replace('分别为','分别是',1) if '分别为' in clause else clause.replace('净利润为','净利润数额为',1)
                    elif variant=='shared_unit':clause=clause.replace('万元','',2)
                    elif metric=='profit_attributable_to_parent':text=text.replace('报告期内','此前期内',1)
                    else:clause=clause.replace('最近两年及一期末','此前期末').replace('报告期内','此前期内')
                    if variant!='period' or metric!='profit_attributable_to_parent':text=text[:start]+clause+text[end:]
                    self.put(old,text);old.addnext(fresh)
                    coverage,_,_,_=self.evaluate(document,refs,overrides={metric:fresh,**({'net_profit':fresh} if metric=='profit_attributable_to_parent' else {})})
                    self.assertEqual(coverage['status'],'failed',coverage)
                    self.assertIn({'role':f'narrative:{source_p}:{scope}:{metric}','code':'unsupported_occurrence_clause'},coverage['failures'])

    def test_each_single_stale_amount_or_unbound_history_cannot_hide_behind_correct_copy(self):
        for source_p,scope,metric in RQ_NARRATIVE_ROLES:
            if metric not in EXTENDED:continue
            with self.subTest(metric=metric):
                document,refs=self.fixture();original=refs['p'][source_p-1];fresh=copy.deepcopy(original)
                label=ALIASES[metric][0]
                # Alternate amount order, period wording and predicate: the
                # detector must not depend on one example's 期末余额 keyword.
                clause=(f'最近两年及一期末，发行人{label}期末余额为4,858.78万元。' if metric in STOCK else
                        f'本期100.00万元为发行人{label}。' if metric in ('sales_expenses','finance_expenses') else
                        f'报告期内，发行人{label}金额为100.00万元。')
                self.put(original,clause);original.addnext(fresh)
                coverage,_,_,_=self.evaluate(document,refs,overrides={metric:fresh,**({'net_profit':fresh} if metric=='profit_attributable_to_parent' else {})})
                self.assertEqual(coverage['status'],'failed')
                self.assertIn({'role':f'narrative:{source_p}:{scope}:{metric}','code':'unsupported_occurrence_clause'},coverage['failures'])
        document,refs=self.fixture();original=refs['p'][7966];fresh=copy.deepcopy(original)
        self.put(original,'报告期内，发行人净利润为166.42万元。');original.addnext(fresh)
        coverage,_,_,_=self.evaluate(document,refs,overrides={'net_profit':fresh,'profit_attributable_to_parent':fresh})
        self.assertEqual(coverage['status'],'failed')
        self.assertIn({'role':'narrative:7967:consolidated:net_profit','code':'unsupported_occurrence_clause'},coverage['failures'])
        # The original contains a lawful 2024 asset-growth sentence. Preserve
        # it exactly in positives; an altered historical amount must not exempt.
        document,refs=self.fixture();original=refs['p'][4815]
        text=paragraph_text(original);self.assertIn('87,208.14万元',text)
        self.put(original,text.replace('87,208.14万元','999.00万元'))
        coverage,_,_,_=self.evaluate(document,refs)
        self.assertEqual(coverage['status'],'failed')
        self.assertIn({'role':'narrative:4816:consolidated:total_assets','code':'unsupported_occurrence_clause'},coverage['failures'])
        for clause in ('2023年，发行人递延收益为999.00万元。','担保人说明，发行人递延收益为999.00万元。'):
            document,refs=self.fixture();original=refs['p'][7604];fresh=copy.deepcopy(original)
            self.put(original,clause);original.addnext(fresh)
            coverage,_,_,_=self.evaluate(document,refs,overrides={'deferred_income':fresh})
            self.assertEqual(coverage['status'],'failed')
            self.assertIn({'role':'narrative:7605:consolidated:deferred_income','code':'unsupported_occurrence_clause'},coverage['failures'])
        document,refs=self.fixture();original=refs['p'][7604];explanation=copy.deepcopy(original)
        self.put(explanation,'发行人递延收益主要系收到的补助，相关事项仍应结合附注判断。');original.addnext(explanation)
        coverage,errors,_,_=self.evaluate(document,refs)
        self.assertEqual(errors,[]);self.assertEqual(coverage['status'],'passed')

    def test_attribution_requires_adjacent_same_paragraph_same_issuer_period(self):
        for variant in ('other_subject','parent_scope','intervening_clause','detached_attribution','total_profit_label','incomplete_previous_list'):
            with self.subTest(variant=variant):
                document,refs=self.fixture();paragraph=refs['p'][7966];text=paragraph_text(paragraph)
                if variant=='other_subject':text=text.replace('发行人净利润','其他公司净利润',1)
                elif variant=='parent_scope':text=text.replace('发行人净利润','发行人母公司净利润',1)
                elif variant=='intervening_clause':text=text.replace('；','；另一主体采用不同期间；',1)
                elif variant=='detached_attribution':text=text.split('；',1)[1]
                elif variant=='total_profit_label':text=text.replace('归属母公司所有者的净利润','净利润',1)
                else:text=re.sub(r'分别为[^、]+、','分别为',text,count=1)
                self.put(paragraph,text)
                coverage,_,_,_=self.evaluate(document,refs)
                self.assertEqual(coverage['status'],'failed')
                self.assertNotIn('narrative:7967:consolidated:profit_attributable_to_parent',coverage['covered_role_ids'])

    def test_historical_values_periods_blank_cells_and_percentage_spans_cannot_change(self):
        for variant in ('first_year','second_year','historical_period','historical_unit','table_unit','blank_to_zero','percentage_span'):
            with self.subTest(variant=variant):
                document,refs=self.fixture()
                if variant in ('first_year','second_year'):
                    p=refs['p'][7837];text=paragraph_text(p);matches=list(re.finditer(r'(-?[0-9]+(?:,[0-9]{3})*\.[0-9]+)\s*万元',text));m=matches[0 if variant=='first_year' else 1]
                    self.put(p,text[:m.start(1)]+'1.00'+text[m.end(1):])
                elif variant=='historical_period':self.put(refs['t'][44].findall(q('tr'))[0].findall(q('tc'))[2],'2023年度')
                elif variant=='historical_unit':
                    p=refs['p'][7837];self.put(p,paragraph_text(p).replace('万元','亿元',1))
                elif variant=='table_unit':
                    node=refs['t'][44].getprevious()
                    while '单位' not in paragraph_text(node):node=node.getprevious()
                    self.put(node,paragraph_text(node).replace('万元','亿元'))
                elif variant=='blank_to_zero':self.put(refs['t'][43].findall(q('tr'))[44].findall(q('tc'))[3],'0.00')
                coverage,errors,_,details=self.evaluate(document,refs)
                if variant=='percentage_span':
                    reader,path,specs=details
                    _,spec,row=next(x for x in specs if x[0]['kind']=='narrative_list' and x[0]['metric']=='sales_expenses')
                    wrong=copy.deepcopy(spec);percentage=list(re.finditer(r'([0-9.]+)%',wrong['quote']))[-1];wrong['start'],wrong['end']=percentage.span(1)
                    with self.assertRaises(ValueError):reader.output_value(path,wrong,row)
                else:
                    self.assertEqual(coverage['status'],'failed')
                    self.assertTrue(any('historical' in e[1] or e[1]=='list_unit_or_precision_mismatch' for e in errors),errors)

    def test_inserted_body_paragraph_unrelated_table_and_row_are_relocated_from_actual_nodes(self):
        document,refs=self.fixture();body=document.find(q('body'))
        note=copy.deepcopy(refs['p'][0]);self.put(note,'Synthetic nonfinancial paragraph');body.insert(0,note)
        table=refs['t'][43];row=copy.deepcopy(table.findall(q('tr'))[1])
        for i,c in enumerate(row.findall(q('tc'))):self.put(c,'Synthetic nonmetric row' if i==0 else '')
        table.findall(q('tr'))[2].addprevious(row)
        extra=ET.Element(q('tbl'));grid=ET.SubElement(extra,q('tblGrid'));ET.SubElement(grid,q('gridCol'))
        cell=ET.SubElement(ET.SubElement(extra,q('tr')),q('tc'));paragraph=ET.SubElement(cell,q('p'))
        self.put(paragraph,'Synthetic unrelated table')
        Reader().caption(table).addprevious(extra)
        coverage,errors,verified,_=self.evaluate(document,refs)
        self.assertEqual(errors,[]);self.assertEqual(len(verified),39);self.assertEqual(coverage['status'],'passed',coverage)


if __name__=='__main__':unittest.main()
