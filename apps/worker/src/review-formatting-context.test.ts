import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputManifestHash } from '@bondbuddy/api/production-rule-pin';
import { DEFAULT_DOCUMENT_PARSER_VERSION } from '@bondbuddy/api/material-jobs';
import { reviewFixture } from '../../../packages/domain/dist/review-test-fixtures.js';
import { referenceFor } from '../../../packages/domain/dist/review-evidence.js';
import { reviewComplianceEvidence } from '../../../packages/domain/dist/review-compliance-checks.js';
import { loadExplicitReviewFormatting } from './review-formatting-context.js';
import { loadReviewRuleContext, type ReviewRuleManifest } from './review-rule-context.js';
import type { ReviewAnalysisRecord } from './review-model-stage.js';
import type { StageContext } from './run-pipeline.js';
import { validateDocumentParseResponse, type DocumentParseRequest } from './document-parser.js';

function records() {
  const f = reviewFixture();
  return [
    { ...f.addRecord('body', '正文文字'), source_kind: 'disclosure' },
    {
      ...f.addRecord('table', '表格文字', true, {
        locator: {
          stable_ref: 't1',
          path: [{ table: 1 }, { row: 1 }, { column: 1 }, { paragraph: 1 }],
        },
      }),
      source_kind: 'disclosure',
    },
    { ...f.addRecord('support', '其他材料', false), source_kind: 'audit' },
  ] as ReviewAnalysisRecord[];
}
const load = (requirements: string[], source = records()) =>
  loadExplicitReviewFormatting({
    requirements,
    input_hash: 'f'.repeat(64),
    input_revision: 7,
    records: source,
  });
test('saved explicit standards supply immutable user-source rules and current-source record scopes', () => {
  const result = load([
    '正文中文字体为宋体',
    '正文段落字号：小四',
    '表格西文字体为Times New Roman',
  ]);
  assert.equal(result.formatting_requirements.length, 3);
  assert.deepEqual(
    result.formatting_requirements.map((r) => r.record_ids),
    [['body', 'table'], ['body'], ['table']],
  );
  assert.deepEqual(
    result.formatting_requirements.map((r) => r.expected),
    ['宋体', '24', 'Times New Roman'],
  );
  assert(
    result.rules.every(
      (r) =>
        r.authority === 'internal_method' &&
        r.applicability === 'applicable' &&
        !r.url &&
        r.pack_sha256 === 'f'.repeat(64),
    ),
  );
  assert.equal(
    result.rules[0]?.source_sha256,
    createHash('sha256').update('正文中文字体为宋体').digest('hex'),
  );
  assert.match(result.rules[0]!.locator, /revision 7.*非监管规则/);
});
test('ambiguous, conditional, visual and conflicting input never chooses a standard silently', () => {
  for (const input of [
    '全文使用宋体',
    '正文中文字体为宋体或黑体',
    '正文中文字体为不是宋体',
    '正文中文字体为除标题外用宋体',
    '正文字号为小四或四号',
    '页眉字号为12磅',
    '正文标题层级必须三级',
    '如果是大公募，正文字号为小四',
  ])
    assert.equal(load([input]).formatting_requirements.length, 0, input);
  const conflicts = load(['正文中文字体为宋体', '表格中文字体为黑体', '正文段落字号为12磅']);
  assert.equal(conflicts.formatting_requirements.length, 1);
  assert.equal(conflicts.formatting_requirements[0]?.property, 'half_points');
  assert(conflicts.limitations.some((x) => x.includes('冲突')));
  const distinct = load(['正文段落中文字体为宋体', '表格中文字体为黑体']);
  assert.equal(distinct.formatting_requirements.length, 2);
});
test('explicit quoted custom font names remain literal, missing PDF/native scope stays uncovered, and large sources retain every record', () => {
  assert.equal(
    load(['正文中文字体为“方正书宋_GBK”']).formatting_requirements[0]?.expected,
    '方正书宋_GBK',
  );
  const absent = load(['正文字号为10.5磅'], []);
  assert.equal(absent.formatting_requirements[0]?.expected, '21');
  assert.deepEqual(absent.formatting_requirements[0]?.record_ids, []);
  const base = records()[0]!,
    many = Array.from({ length: 1001 }, (_, i) => ({ ...base, record_id: `p-${i}` }));
  const result = load(['正文字号为小四'], many);
  assert.deepEqual(
    result.formatting_requirements.map((r) => r.record_ids.length),
    [500, 500, 1],
  );
  assert.equal(new Set(result.formatting_requirements.flatMap((r) => r.record_ids)).size, 1001);
});

test('saved heading standards match one exact body paragraph and reject absent, ambiguous or conflicting selections', () => {
  const base = records()[0]!,
    source = [
      { ...base, record_id: 'h1', literal_quote: '第一章 总则' },
      { ...base, record_id: 'h2', literal_quote: '第二章 风险' },
    ];
  const result = load(
    ['标题“第一章 总则”层级为1级', '格式要求：标题"第二章 风险"的大纲级别：二级'],
    source,
  );
  assert.deepEqual(
    result.formatting_requirements.map((r) => [r.property, r.expected, r.record_ids]),
    [
      ['outline_level', '1', ['h1']],
      ['outline_level', '2', ['h2']],
    ],
  );
  assert.equal(
    load(['标题“第一章 总则”层级为1级', '标题“第一章 总则”层级为2级'], source)
      .formatting_requirements.length,
    0,
  );
  for (const missing of [[], [...source, { ...source[0]!, record_id: 'duplicate' }]]) {
    const unclear = load(['标题“第一章 总则”层级为1级'], missing);
    assert.deepEqual(unclear.formatting_requirements[0]?.record_ids, []);
    assert(unclear.limitations.some((x) => x.includes('唯一匹配')));
  }
  for (const input of [
    '标题层级为1级',
    '标题“第一章 总则”层级为10级',
    '如果是大公募，标题“第一章 总则”层级为1级',
  ])
    assert.equal(load([input], source).formatting_requirements.length, 0);
});

const python = process.env.BONDBUDDY_TEST_PYTHON ?? process.env.BB_PYTHON ?? 'python3';
const pythonAvailable =
  spawnSync(python, ['-c', 'import docx,lxml'], { encoding: 'utf8', windowsHide: true }).status ===
  0;
test(
  'real OOXML style inheritance reaches production requirement loader and yields traceable non-regulatory checks (synthetic document)',
  { skip: pythonAvailable ? false : 'Set BONDBUDDY_TEST_PYTHON to Python with python-docx/lxml' },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'bb-review-format-'));
    const root = resolve(fileURLToPath(import.meta.url), '../../../..');
    try {
      const path = resolve(directory, 'styles.docx');
      const script = `from docx import Document
from docx.shared import Pt
from docx.oxml.ns import qn
import sys
d=Document()
# This case isolates explicit fonts and size inheritance; theme fonts stay uncovered.
for node in d.styles.element.iter(qn('w:rFonts')):
 for attr in ('asciiTheme','hAnsiTheme','eastAsiaTheme','cstheme'):
  node.attrib.pop(qn('w:'+attr),None)
s=d.styles['Normal'];s.font.size=Pt(12)
s.element.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'),'宋体')
d.add_paragraph('继承正文样式')
d.add_paragraph('直接字号覆盖').runs[0].font.size=Pt(14)
t=d.add_table(rows=1,cols=1);r=t.cell(0,0).paragraphs[0].add_run('表格明确字体')
r._r.get_or_add_rPr().get_or_add_rFonts().set(qn('w:eastAsia'),'黑体');r.font.size=Pt(12)
d.sections[0].header.paragraphs[0].text='页眉仍须独立验证'
d.save(sys.argv[1])`;
      const generated = spawnSync(python, ['-B', '-c', script, path], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(generated.status, 0, generated.stderr);
      const sha = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      const request = {
        schema_version: 'document-parse-request-v1',
        request_id: 'synthetic-format-probe',
        material: {
          material_id: 'source',
          material_version: 1,
          media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sha256: sha,
          authorized_local_path: path,
        },
        options: {},
      };
      const parsed = spawnSync(python, ['-B', '-m', 'bondbuddy_document_parser'], {
        cwd: root,
        env: { ...process.env, PYTHONPATH: resolve(root, 'python'), PYTHONIOENCODING: 'utf-8' },
        input: JSON.stringify(request),
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      assert.equal(parsed.status, 0, parsed.stderr);
      const response = JSON.parse(parsed.stdout);
      assert.equal(response.schema_version, 'document-parse-response-v1');
      const source: ReviewAnalysisRecord[] = response.records.map((r: Record<string, unknown>) => ({
        owner_user_id: 'owner',
        project_id: 'project',
        material_id: 'source',
        material_version: 1,
        material_sha256: sha,
        parse_snapshot_id: 'snapshot',
        parse_response_sha256: inputManifestHash(response),
        record_id: r.record_id,
        record_sha256: inputManifestHash(r),
        locator_type: r.locator_type,
        locator: r.locator,
        literal_quote: r.literal_quote,
        extraction_method: r.extraction_method,
        uncertainty: r.uncertainty,
        formatting: r.formatting,
        source_kind: 'disclosure',
      }));
      const manifest: ReviewRuleManifest = {
        issuer_name: null,
        market: null,
        offering: null,
        materials: [
          { material_id: 'source', material_version: 1, sha256: sha, role: 'historical' },
        ],
        review: {
          input: {
            as_of: null,
            requirements: ['正文中文字体为宋体', '正文段落字号为小四', '表格字号为12磅'],
          },
        },
      };
      const ctx = {
        run: {
          owner_user_id: 'owner',
          project_id: 'project',
          input_hash: inputManifestHash(manifest),
          input_revision: 1,
        },
        checkpoint: {},
        pool: {
          query: async () => {
            throw new Error('No regulatory query expected');
          },
        },
      } as unknown as StageContext;
      const loaded = await loadReviewRuleContext(ctx, manifest, source);
      assert.equal(loaded.formatting_requirements.length, 3);
      assert.equal(loaded.rule_context, null);
      assert.equal(loaded.rule_packs.length, 0);
      const evidence = {
        owner_user_id: 'owner',
        project_id: 'project',
        report_id: 'report',
        source_material: { material_id: 'source', material_version: 1, sha256: sha },
        records: source,
        rules: loaded.rules,
      };
      const checked = reviewComplianceEvidence(
        {
          context: null,
          packs: [],
          assessments: [],
          formatting_requirements: loaded.formatting_requirements,
          formatted_records: source.map((r) => ({
            ref: referenceFor(r),
            formatting: r.formatting!,
          })),
        },
        evidence,
      );
      const actual = checked.coverage.filter((c) => c.check_id.startsWith('user-format:'));
      assert.deepEqual(
        actual.map((c) => c.outcome),
        ['issue', 'issue', 'pass'],
      );
      assert.equal(checked.findings.length, 2);
      assert(
        checked.findings.every(
          (f) =>
            f.conclusion === 'error' &&
            !f.repairability.can_revise &&
            f.rule_refs?.[0]?.authority === 'internal_method',
        ),
      );
      assert(loaded.limitations.some((x) => x.includes('页眉页脚') && x.includes('尚未覆盖')));
      assert(source[0]?.formatting?.runs);
    } finally {
      assert(directory.startsWith(resolve(tmpdir(), 'bb-review-format-')));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'real OOXML outline inheritance, overrides and unresolved styles reach the production loader/checker (synthetic DOCX)',
  { skip: pythonAvailable ? false : 'Set BONDBUDDY_TEST_PYTHON to Python with python-docx/lxml' },
  async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'bb-review-outline-'));
    const root = resolve(fileURLToPath(import.meta.url), '../../../..');
    try {
      const path = resolve(directory, 'outline.docx'),
        defaultsPath = resolve(directory, 'defaults.docx');
      const script = `from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
import sys
def outline(ppr,value):
 node=OxmlElement('w:outlineLvl');node.set(qn('w:val'),value);ppr.append(node)
d=Document()
base=d.styles.add_style('SyntheticBase',WD_STYLE_TYPE.PARAGRAPH)
outline(base.element.get_or_add_pPr(),'0')
child=d.styles.add_style('SyntheticChild',WD_STYLE_TYPE.PARAGRAPH);child.base_style=base
d.add_paragraph('继承一级标题',style=child)
p=d.add_paragraph('直接覆盖为三级',style=child);outline(p._p.get_or_add_pPr(),'2')
p=d.add_paragraph('显式正文级别',style=child);outline(p._p.get_or_add_pPr(),'9')
named=d.styles.add_style('Heading Misleading',WD_STYLE_TYPE.PARAGRAPH)
d.add_paragraph('样式名不是层级',style=named)
p=d.add_paragraph('非法级别',style=child);outline(p._p.get_or_add_pPr(),'not-a-level')
a=d.styles.add_style('CycleA',WD_STYLE_TYPE.PARAGRAPH);b=d.styles.add_style('CycleB',WD_STYLE_TYPE.PARAGRAPH)
a.base_style=b;b.base_style=a;d.add_paragraph('循环继承',style=a)
p=d.add_paragraph('缺少引用样式');p._p.get_or_add_pPr().get_or_add_pStyle().val='MissingStyle'
d.add_paragraph('编号属性未解析',style='List Number')
d.add_paragraph('重复标题',style=child);d.add_paragraph('重复标题',style=child)
d.add_table(rows=1,cols=1).cell(0,0).text='仅表格标题'
d.save(sys.argv[1])
default=Document();docdefaults=default.styles.element.find(qn('w:docDefaults'))
pdefault=docdefaults.find(qn('w:pPrDefault'))
if pdefault is None:
 pdefault=OxmlElement('w:pPrDefault');docdefaults.append(pdefault)
ppr=pdefault.find(qn('w:pPr'))
if ppr is None:
 ppr=OxmlElement('w:pPr');pdefault.append(ppr)
outline(ppr,'4');default.add_paragraph('文档默认五级');default.save(sys.argv[2])`;
      const generated = spawnSync(python, ['-B', '-c', script, path, defaultsPath], {
        encoding: 'utf8',
        windowsHide: true,
      });
      assert.equal(generated.status, 0, generated.stderr);
      async function check(documentPath: string, requirements: string[]) {
        const sha = createHash('sha256')
          .update(await readFile(documentPath))
          .digest('hex');
        const request: DocumentParseRequest = {
          schema_version: 'document-parse-request-v1',
          request_id: 'synthetic-outline-probe',
          material: {
            material_id: 'source',
            material_version: 1,
            media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sha256: sha,
            authorized_local_path: documentPath,
          },
          options: {},
        };
        const parsed = spawnSync(python, ['-B', '-m', 'bondbuddy_document_parser'], {
          cwd: root,
          env: { ...process.env, PYTHONPATH: resolve(root, 'python'), PYTHONIOENCODING: 'utf-8' },
          input: JSON.stringify(request),
          encoding: 'utf8',
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        });
        assert.equal(parsed.status, 0, parsed.stderr);
        const response = validateDocumentParseResponse(JSON.parse(parsed.stdout), request);
        assert.equal(response.parser_version, 'bondbuddy-document-parser-1.0.8');
        assert.equal(response.parser_version, DEFAULT_DOCUMENT_PARSER_VERSION);
        const source: ReviewAnalysisRecord[] = response.records.map((r) => ({
          owner_user_id: 'owner',
          project_id: 'project',
          material_id: 'source',
          material_version: 1,
          material_sha256: sha,
          parse_snapshot_id: 'snapshot',
          parse_response_sha256: inputManifestHash(response),
          record_id: r.record_id,
          record_sha256: inputManifestHash(r),
          locator_type: r.locator_type,
          locator: r.locator,
          literal_quote: r.literal_quote,
          extraction_method: r.extraction_method,
          uncertainty: r.uncertainty,
          formatting: r.formatting,
          source_kind: 'disclosure',
        }));
        const manifest: ReviewRuleManifest = {
          issuer_name: null,
          market: null,
          offering: null,
          materials: [
            { material_id: 'source', material_version: 1, sha256: sha, role: 'historical' },
          ],
          review: { input: { as_of: null, requirements } },
        };
        const ctx = {
          run: {
            owner_user_id: 'owner',
            project_id: 'project',
            input_hash: inputManifestHash(manifest),
            input_revision: 1,
          },
          checkpoint: {},
          pool: {
            query: async () => {
              throw new Error('No regulatory query expected');
            },
          },
        } as unknown as StageContext;
        const loaded = await loadReviewRuleContext(ctx, manifest, source);
        const evidence = {
          owner_user_id: 'owner',
          project_id: 'project',
          report_id: 'report',
          source_material: { material_id: 'source', material_version: 1, sha256: sha },
          records: source,
          rules: loaded.rules,
        };
        const checked = reviewComplianceEvidence(
          {
            context: null,
            packs: [],
            assessments: [],
            formatting_requirements: loaded.formatting_requirements,
            formatted_records: source.map((r) => ({
              ref: referenceFor(r),
              formatting: r.formatting!,
            })),
          },
          evidence,
        );
        return {
          source,
          loaded,
          checked,
          outcomes: checked.coverage
            .filter((c) => c.check_id.startsWith('user-format:'))
            .map((c) => c.outcome),
        };
      }
      const result = await check(
        path,
        [
          '继承一级标题',
          '直接覆盖为三级',
          '显式正文级别',
          '样式名不是层级',
          '非法级别',
          '循环继承',
          '缺少引用样式',
          '编号属性未解析',
          '重复标题',
          '仅表格标题',
          '未出现的标题',
        ].map((title) => `标题“${title}”层级为1级`),
      );
      assert.deepEqual(
        result.source.slice(0, 7).map((r) => r.formatting?.outline_level),
        ['1', '3', 'body', 'body', null, null, null],
      );
      assert.deepEqual(result.outcomes, [
        'pass',
        'issue',
        'issue',
        'issue',
        'uncovered',
        'uncovered',
        'uncovered',
        'uncovered',
        'uncovered',
        'uncovered',
        'uncovered',
      ]);
      assert.equal(result.checked.findings.length, 3);
      assert(
        result.checked.findings.every(
          (f) =>
            f.conclusion === 'error' &&
            !f.repairability.can_revise &&
            f.rule_refs?.[0]?.authority === 'internal_method',
        ),
      );
      assert(
        result.checked.findings.every((f) =>
          f.target_refs.every((ref) =>
            result.source.some(
              (r) => r.record_id === ref.record_id && r.record_sha256 === ref.record_sha256,
            ),
          ),
        ),
      );
      const defaults = await check(defaultsPath, ['标题“文档默认五级”层级为5级']);
      assert.deepEqual(defaults.outcomes, ['pass']);
    } finally {
      assert(directory.startsWith(resolve(tmpdir(), 'bb-review-outline-')));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
