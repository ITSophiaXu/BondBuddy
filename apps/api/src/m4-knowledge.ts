import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {Value} from '@sinclair/typebox/value';
import {M4KnowledgeSnapshotSchema,m4DocumentScopeSupported,type M4KnowledgeSnapshot,type M4DocumentType,type Market,type Offering} from '@bondbuddy/contracts';

const root=resolve(fileURLToPath(import.meta.url),'../../../..');
const sha=(content:string)=>createHash('sha256').update(content,'utf8').digest('hex');
/** Only the API selects bundled knowledge. Snapshot bytes are retained for old runs. */
function loadGuide(market:'sse'|'szse',type:M4DocumentType):M4KnowledgeSnapshot {
  const catalog=JSON.parse(readFileSync(resolve(root,'knowledge/material-drafting/2026-10-07/catalog.json'),'utf8')) as
    {packs:(Omit<M4KnowledgeSnapshot,'content'> & {path:string})[]};
  const pin=catalog.packs.find(p=>p.market===market&&p.document_type===type);
  if(!pin || pin.path!==`knowledge/material-drafting/2026-10-07/packs/${market}-${type}.md`)throw Error('M4_KNOWLEDGE_UNAVAILABLE');
  const {path,...metadata}=pin,content=readFileSync(resolve(root,path),'utf8'),snapshot={...metadata,content};
  if(!validM4Knowledge(snapshot,market,type))throw Error('M4_KNOWLEDGE_CHANGED');
  return snapshot;
}
type CasePin={id:string;version:string;market:Market;offering:string;document_type:M4DocumentType;default:boolean;template_path:string;template_sha256:string;source_sha256:string};
const caseRoot='knowledge/material-drafting/2026-10-15';
function caseCatalog():CasePin[]{return JSON.parse(readFileSync(resolve(root,caseRoot,'catalog.json'),'utf8')).templates;}
/** New tasks pin the complete template bytes. Old tasks never reload a newer file. */
export function loadM4Knowledge(market:Market,type:M4DocumentType,offering='private',templateId?:string):M4KnowledgeSnapshot {
  if(!m4DocumentScopeSupported(type,market,offering))throw Error('M4_KNOWLEDGE_UNAVAILABLE');
  const candidates=caseCatalog().filter(p=>p.market===market&&p.offering===offering&&p.document_type===type);
  const pin=templateId?candidates.find(p=>p.id===templateId):candidates.find(p=>p.default);
  if(templateId&&!pin)throw Error('M4_CASE_TEMPLATE_SCOPE');
  if(!pin&&['application','recommendation'].includes(type))throw Error('M4_KNOWLEDGE_UNAVAILABLE');
  const guide=type==='recommendation'?null:loadGuide(market as 'sse'|'szse',type==='application'?'underwriter':type);
  if(!pin)return guide!;
  if(!/^[a-z0-9-]+$/.test(pin.id)||pin.template_path!==`${caseRoot}/templates/${pin.id}.docx`)throw Error('M4_CASE_TEMPLATE_SCOPE');
  const bytes=readFileSync(resolve(root,pin.template_path));
  if(createHash('sha256').update(bytes).digest('hex')!==pin.template_sha256)throw Error('M4_CASE_TEMPLATE_CHANGED');
  const structure=JSON.parse(readFileSync(resolve(root,caseRoot,'templates',`${pin.id}.json`),'utf8')) as {headings:{text:string}[];slots:{id:string;kind:string;section?:string}[]};
  const title=`${market==='nafmii'?'交易商协会':market==='sse'?'上交所':'深交所'} · ${type==='application'?'申请书':type==='recommendation'?'推荐函':'主承销商核查意见'}`;
  const content=`# ${title}\n\n案例格式模板：${pin.id}，版本 ${pin.version}，SHA-256 ${pin.template_sha256}。适用：${market}/${offering}/${type}。\n\n`
    +'本模板是用户提供案例的可复用结构与字体版式，不是已获专业签认的法规文本。原项目名称、金额、结论、签章、个人信息与嵌入对象均已去除。模板占位符必须用本任务事实填写，不能视为事实。不得伪造已完成的尽调、内核、批准、签署或承诺；缺证据写待核。\n\n'
    +'使用 knowledge 中固定的 template_path 作为正文 Word 的起点，保留源章节、字体、字号、页边距和表格样式。edit_base 存在时优先保留该准确成果版式；本人明确选择的私有模板优先于案例基础版。编制说明记录采用的版式及缺项。\n\n'
    +(type==='recommendation'?'收件人为中国银行间市场交易商协会；本次品种为'+(offering==='ppn'?'定向债务融资工具（PPN）':'中期票据（MTN）')+'。推荐人资质、尽调记录、发行人批准程序与推荐人内部核查分别取真实资料；机构签发前仅为工作稿。\n\n':'')
    +'## 固定标题与章节\n'+structure.headings.map(h=>`- ${h.text}`).join('\n')
    +'\n\n## 可扩展内容槽位\n'+structure.slots.filter(s=>s.kind==='body'||s.kind==='table').map(s=>`- ${s.id}：${s.section}（${s.kind}）`).join('\n')
    +(guide?'\n\n## 既有交易所参考指引\n以本次固定案例模板的章节与格式为准；以下历史指引中的旧案例不可读记录仅说明当时的来源状态，不适用于本次已读取并固定的 DOCX。申请书参考其中适用规则，不套用核查意见标题。\n'+guide.content:'');
  const snapshot:M4KnowledgeSnapshot={version:pin.version,document_type:type,market,offering:offering as Offering,title,content,sha256:sha(content),
    source_ids:[...(guide?.source_ids??[]),pin.id],template:{id:pin.id,version:pin.version,sha256:pin.template_sha256,docx_base64:bytes.toString('base64')}};
  if(!validM4Knowledge(snapshot,market,type,offering))throw Error('M4_KNOWLEDGE_CHANGED');
  return snapshot;
}
export function validM4Knowledge(value:unknown,market:string,type:M4DocumentType,offering?:string):value is M4KnowledgeSnapshot {
  return Value.Check(M4KnowledgeSnapshotSchema,value)&&value.market===market&&value.document_type===type
    && (!offering||(!value.offering&&offering==='private')||value.offering===offering)
    && sha(value.content)===value.sha256
    && (!value.template||createHash('sha256').update(Buffer.from(value.template.docx_base64,'base64')).digest('hex')===value.template.sha256);
}
