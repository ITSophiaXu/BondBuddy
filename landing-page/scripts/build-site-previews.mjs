import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Reproducible product illustrations. All project records and results are demo data.
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const output=join(root,'public','assets');
await mkdir(output,{recursive:true});
// The editable brand mark is stored at public/assets/brand.svg.
const C={ink:'#203b33',muted:'#86917e',deep:'#173e33',line:'#e1e7d9',soft:'#eff3e7',paper:'#f7f8f2'};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const rect=(x,y,w,h,fill='#fff',stroke=C.line,r=10)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`;
const text=(x,y,value,size=14,color=C.ink,weight=400,anchor='start')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`;
const line=(x,y,x2,y2,color=C.line)=>`<path d="M${x} ${y}H${x2}" stroke="${color}"/>`;
const lines=(x,y,values,size=14,color=C.muted,leading=24)=>values.map((v,i)=>text(x,y+i*leading,v,size,color)).join('');
const tag=(x,y,label,fill='#edf3e3',color='#6d8755',width=label.length*12+18)=>rect(x,y,width,25,fill,fill,5)+text(x+9,y+17,label,11,color);
const button=(x,y,w,label,primary=true)=>rect(x,y,w,38,primary?C.deep:'#fff',primary?C.deep:C.line,6)+text(x+w/2,y+24,label,12,primary?'#fff':C.ink,500,'middle');
const paths={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',update:'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9L14 2Zm0 0v7h7M8 15h8m-4-4v8',review:'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9L14 2Zm0 0v7h7m-13 6 3 3 6-6',spark:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',chat:'M21 11a8 8 0 0 1-8 8H7l-5 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8ZM7 10h10M7 14h6',folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',shield:'M12 3l8 3v6c0 5-8 10-8 10S4 17 4 12V6l8-3Z M8 12l3 3 5-6',arrow:'M4 12h16 M14 6l6 6-6 6',file:'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9L14 2Zm0 0v7h7M7 13h10M7 17h7',clip:'M8 12l7-7a4 4 0 1 1 6 6L10 22a6 6 0 0 1-8-8L13 3 M6 16l9-9a1.5 1.5 0 1 1 2 2l-9 9',download:'M12 3v13M7 11l5 5 5-5M4 17v4h16v-4'};
const icon=(name,x,y,size=22,color='#6f8b59')=>`<g transform="translate(${x} ${y}) scale(${size/24})" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${paths[name]||paths.file}"/></g>`;
const logo=(x,y,size=31)=>`<g transform="translate(${x} ${y}) scale(${size/64})"><rect width="64" height="64" rx="18" fill="#173f35"/><path d="M18 15v32h16c19 0 19-22 2-22h-6v9h6c5 0 5 6 0 6H27V15z" fill="#d1ef9c"/><circle cx="44" cy="18" r="5" fill="#d1ef9c"/></g>`;
const title=(heading,sub)=>text(235,113,heading,27,C.ink,600)+text(235,141,sub,12,C.muted);
function base(active,titleText,body){
  const nav=[['dashboard','grid','工作台',174],['update','update','更新募集书',223],['review','review','复核募集书',272],['generate','spark','材料生成',321],['qa','chat','项目问答',370],['tasks','folder','全部项目',445],['billing','shield','套餐与用量',494]];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="780" viewBox="0 0 1280 780" role="img" aria-label="${escape(titleText)} · 产品界面示意，演示数据"><title>${escape(titleText)} · 演示示例</title><style>text{font-family:Inter,'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif}</style>${rect(0,0,1280,780,C.paper,C.paper,0)}${rect(0,0,205,780,'#f0f3e9','#dfe5d6',0)}${logo(24,25,32)}${text(65,49,'bondbuddy',21,C.ink,650)}${rect(17,82,171,52,'#f9fbf4',C.line,8)}${icon('folder',30,97,21)}${text(61,102,'我的工作空间',12,C.ink,500)}${text(61,120,'PERSONAL WORKSPACE',8,'#98a18e')}${nav.map(([id,ico,label,y])=>(active===id?rect(16,y-22,173,41,C.deep,C.deep,7):'')+icon(ico,30,y-12,18,active===id?'#d3e6b5':'#81936e')+text(61,y+2,label,12,active===id?'#f4f7ed':'#6f8066',active===id?500:400)).join('')}${text(31,419,'工作空间',10,'#99a28f')}${line(24,703,180,703)}${rect(27,723,30,30,'#dfe8d2','#dfe8d2',15)}${text(42,743,'我',12,C.ink,500,'middle')}${text(69,735,'我的工作空间',11,C.ink,500)}${text(69,752,'138****8000',9,'#9ba48f')}${rect(205,0,1075,65,'#fafbf6',C.line,0)}${text(235,37,'工作空间  ›  '+titleText,11,'#849278')}${text(858,37,'剩余额度',11,'#8c987f')}${text(918,38,'20 点',14,C.deep,550)}${text(981,37,'套餐与用量  →',11,'#768e61')}${button(1107,15,140,'＋ 加购点数')}${body}${text(1248,762,'产品界面示意 · 演示数据',9,'#a6ad9a',400,'end')}</svg>`;
}

let dashboard=title('工作台','查看项目成果与处理进度，选择下一项任务。');
const stats=[['update','已更新募集书','3','份'],['review','已复核募集书','5','份'],['chat','已完成对话','8','次']];
stats.forEach(([ico,label,n,unit],i)=>{const x=235+i*340;dashboard+=rect(x,166,319,91)+rect(x+19,187,45,45,['#edf3e4','#eaf3f0','#f6f2e5'][i],'none',10)+icon(ico,x+30,197,24)+text(x+81,195,label,11,C.muted)+text(x+81,225,n,28,C.deep,600)+text(x+108,224,unit,11,C.muted)+text(x+253,228,'查看成果 ↗',9,'#9baa8d');});
dashboard+=text(235,303,'今天，从哪一步开始？',17,C.ink,600)+text(1248,302,'专为债券项目工作而设计',11,C.muted,400,'end');
const tasks=[['update','更新募集书',['上传历史募集书与最新材料，','将报告期推进到下一期。'],'修订版 Word'],['review','复核募集书',['核对数字与文档一致性，','让问题有依据、有位置。'],'问题报告 · 原文批注'],['spark','材料生成',['描述材料用途与写作要求，','起草项目说明书等文稿。'],'按需起草 · Word 导出'],['chat','项目问答',['解读项目与财务材料，','查询工商、股权与债券。'],'材料解读 · 信息查询']];
tasks.forEach(([ico,label,desc,tail],i)=>{const x=235+i*255;dashboard+=rect(x,326,234,191)+icon(ico,x+20,347,28)+text(x+207,354,'0'+(i+1)+' /',10,'#a2b391',400,'end')+text(x+20,404,label,16,C.ink,550)+lines(x+20,431,desc,11,'#8a997b',21)+line(x+20,477,x+214,477)+text(x+20,499,tail,9,'#8a9f75')+icon('arrow',x+197,485,16);});
dashboard+=rect(235,542,999,194)+text(255,574,'最近项目',16,C.ink,600)+text(1213,574,'全部项目 →',11,'#839874',400,'end')+text(256,608,'全部',11,C.deep,600)+text(306,608,'已更新募集书',11,C.muted)+text(408,608,'已复核募集书',11,C.muted)+line(255,620,1215,620);
[['产业集团 2026 年公司债','上交所 · 私募公司债','已更新'],['城投公司 2026 年公司债','深交所 · 公募公司债','已复核']].forEach(([name,scope,state],i)=>{const y=649+i*51;dashboard+=text(257,y,name,12,C.ink,500)+text(257,y+18,scope,9,C.muted)+tag(823,y-14,state)+text(1083,y+3,'09/18',11,C.muted)+icon('arrow',1190,y-9,17);});
await writeFile(join(output,'dashboard.svg'),base('dashboard','工作台',dashboard));

let update=title('更新募集书','选择项目与报告期，让新一期材料回到熟悉的募集书里。');
update+=tag(235,163,'1  项目信息','#e6eedb','#4e713c',128)+text(379,181,'────────',11,'#c4d0b7')+text(479,181,'2  上传材料',11,'#97a48a');
update+=rect(235,213,652,510)+text(262,246,'项目基本信息',17,C.ink,550)+text(262,270,'填写本次任务的背景，帮助更准确地理解项目。',11,C.muted);
const field=(x,y,label,value,w=281)=>text(x,y,label,11,'#7f8e71')+rect(x,y+13,w,39,'#fff',C.line,6)+text(x+12,y+38,value,12,'#526b43');
update+=field(262,307,'项目名称','产业集团 2026 年公司债')+field(570,307,'发行人全称','某某产业投资集团有限公司');
update+=text(262,393,'交易所',11,'#7f8e71')+button(262,407,134,'上交所')+button(409,407,134,'深交所',false)+text(570,393,'发行方式',11,'#7f8e71')+button(570,407,134,'私募公司债')+button(717,407,134,'公募公司债',false);
update+=text(262,481,'最新报告期',11,'#7f8e71')+button(262,495,104,'2026 年',false)+button(379,495,108,'3 月末',false)+button(500,495,108,'6 月末')+button(621,495,108,'9 月末',false)+button(742,495,109,'年末',false);
update+=rect(262,554,589,88,'#f2f6e9','#dfe7d4',8)+text(278,577,'本次覆盖报告期',11,'#647c50',550)+text(833,577,'私募 · 两年一期',10,'#8a9b77',400,'end')+tag(278,596,'2024 年度','#fff','#6d8755',151)+tag(444,596,'2025 年度','#fff','#6d8755',151)+tag(610,596,'2026 年 1—6 月','#e0eccf','#526f3e',223)+text(262,680,'报告期按年初至所选月末累计，年末计入年度数据。',10,'#91a07e')+button(694,664,157,'下一步：上传材料 →');
update+=rect(910,213,324,434)+text(934,247,'本次任务',16,C.ink,550)+text(934,287,'发行市场',10,C.muted)+text(934,313,'上交所 · 私募公司债',14,C.ink)+text(934,354,'最新报告期',10,C.muted)+text(934,380,'2026 年 6 月末',14,C.ink)+line(934,402,1210,402)+text(934,433,'本次消耗',10,C.muted)+text(934,464,'4 点',26,'#496d38',550)+text(1005,464,'剩余 20 点',11,C.muted)+text(934,514,'你将获得',10,C.muted)+icon('review',935,537,17)+text(962,550,'带修订的募集书 Word',12,'#6e865a')+icon('file',935,577,17)+text(962,590,'更新说明与待补充清单',12,'#6e865a');
await writeFile(join(output,'update.svg'),base('update','更新募集书',update));

let review=title('募集书复核结果','某某产业集团 2026 年公司债 · 上交所 · 私募公司债');
review+=rect(235,166,999,88)+rect(259,184,46,46,'#e8f0df','none',23)+icon('review',271,195,23)+text(326,197,'复核完成',17,C.ink,550)+text(326,225,'发现的问题与覆盖说明已整理，可下载报告并在原文中继续审阅。',12,C.muted)+tag(1097,196,'成果已生成','#ecf4e2','#6e8c51',110);
review+=rect(235,278,650,450)+text(259,312,'问题清单',17,C.ink,600)+text(857,312,'示例发现 · 2 项',10,C.muted,400,'end');
review+=rect(259,338,602,168,'#fff',C.line,8)+tag(279,355,'需核实','#faf1df','#a1874e',65)+text(358,373,'报告期内财务数据口径不一致',14,C.ink,550)+text(279,405,'原文位置 · 第六节 财务会计信息',10,C.muted)+rect(279,420,562,34,'#f6f8f0','none',3)+text(292,442,'请核对本段经营活动现金流量净额与财务报表的列示口径。',11,'#849474')+text(279,480,'建议：核对合并范围与计量单位，并统一正文和表格的表述。',11,'#748966');
review+=rect(259,523,602,168,'#fff',C.line,8)+tag(279,540,'待补充','#edf2e6','#809367',65)+text(358,558,'有息债务到期分布缺少支持材料',14,C.ink,550)+text(279,590,'原文位置 · 第七节 资信状况',10,C.muted)+rect(279,605,562,34,'#f6f8f0','none',3)+text(292,627,'现有材料尚不足以核实债务到期分布，请补充相关明细。',11,'#849474')+text(279,665,'建议：补充有息债务台账，明确金额、到期日及担保信息。',11,'#748966');
review+=rect(908,278,326,251)+text(932,313,'成果文件',17,C.ink,550);
[['复核结果报告.docx','问题、依据与修改建议'],['募集说明书_复核批注.docx','直接在原文中查看批注']].forEach(([name,note],i)=>{const y=343+i*79;review+=rect(932,y,278,64,'#f8faf3',C.line,7)+icon('file',944,y+16,25)+text(982,y+27,name,11,'#536d46',500)+text(982,y+47,note,9,C.muted)+icon('download',1184,y+20,15);});
review+=rect(908,550,326,178,'#f0f4e7','#dfe6d4',10)+text(932,582,'把需要判断的地方留清楚',13,'#5d7a4a',550)+lines(932,612,['可定位的问题写入原文批注。','缺少依据或未覆盖的事项单独列明，','方便项目组补证、确认与继续修改。'],11,'#889b78',26);
await writeFile(join(output,'review.svg'),base('review','复核募集书',review));

function chatScene(kind){
  const generation=kind==='generate';
  let body=title(generation?'材料生成':'项目问答',generation?'说出材料用途、内容与写作要求，起草项目说明书等工作文稿。':'解读材料、分析财务、查询项目信息，从一个问题开始。');
  body+=button(1121,96,112,'＋ 新对话',false)+rect(235,168,185,559,'#f0f3e8',C.line,10)+text(253,199,'最近对话',13,C.ink,550);
  const titles=generation?['起草项目说明书','募集资金用途说明','整理补充材料清单']:['分析发行人偿债能力','解读财务指标变动','梳理项目进展'];
  titles.forEach((name,i)=>{const y=219+i*65;body+=(i===0?rect(246,y,163,56,'#fff',C.line,6):'')+text(258,y+23,name,11,i===0?C.ink:'#839476',i===0?500:400)+text(258,y+43,'09/18 · 已完成',9,'#a0ac93');});
  body+=rect(441,168,793,559)+logo(464,188,24)+text(499,207,'BondBuddy',15,C.deep,600)+text(872,206,'关联项目',10,C.muted)+rect(933,185,279,32,'#fafcf5',C.line,5)+text(945,206,'产业集团 2026 年公司债  ⌄',11,'#819570')+line(464,235,1210,235);
  body+=rect(693,255,492,60,'#edf3e4','#e3ebd8',8)+lines(709,279,generation?['根据关联项目的资料，帮我起草一份项目说明书，','列明项目背景、发行安排和还需要补充的材料。']:['请结合项目材料，分析发行人的偿债能力，','重点说明现金流、有息债务与需要关注的风险。'],12,'#557444',22)+rect(1195,256,24,24,'#dfe8d3','none',12)+text(1207,273,'我',10,'#677f54',500,'middle');
  body+=logo(464,339,26);
  if(generation){
    body+=text(506,358,'已根据项目资料整理出项目说明书初稿。',13,C.ink,500)+text(506,391,'一、项目背景与发行主体',14,C.ink,600)+lines(506,417,['本次拟发行公司债券，发行主体为某某产业投资集团有限公司。','发行安排、募集资金用途及财务概况按已提供材料列示。'],11,'#7d8d70',23)+text(506,479,'二、仍需确认的事项',14,C.ink,600)+text(506,505,'发行规模、期限和募集资金用途明细，已在初稿中标记为待补充。',11,'#7d8d70')+rect(506,527,474,51,'#f5f8ef',C.line,7)+icon('file',520,540,23)+text(555,548,'项目说明书_初稿.docx',12,'#506f3f',500)+text(555,565,'Word 文稿 · 可继续编辑',9,C.muted)+icon('download',949,543,18);
  }else{
    body+=text(506,358,'可以从现金流、债务期限与偿债保障三个方面看。',13,C.ink,500)+text(506,396,'01  经营活动现金流',13,'#567a40',600)+text(506,420,'对照现金流量表，结合回款变化分析经营现金流的持续性。',11,'#7d8d70')+text(506,454,'02  有息债务与到期分布',13,'#567a40',600)+text(506,478,'结合债务台账区分短期与长期债务，关注集中到期的偿付安排。',11,'#7d8d70')+text(506,512,'03  需要进一步核实',13,'#567a40',600)+text(506,536,'尚需补充授信使用情况及受限资金明细，以完善偿债保障分析。',11,'#7d8d70')+tag(506,551,'依据：项目财务报表','#f0f4e8','#8c9c7b',164)+tag(680,551,'依据：债务台账','#f0f4e8','#8c9c7b',139);
  }
  body+=text(466,616,'继续对话',11,'#5b764a',550)+rect(463,630,749,77,'#fff','#a8b897',8)+text(478,655,generation?'请把发行安排部分展开说明…':'继续问一个问题…',11,'#a0ac93')+icon('clip',478,676,16)+text(501,689,'添加材料',10,'#849774')+text(991,689,'剩余 998 次问答',9,'#9aa78c')+button(1116,665,81,'发送 →');
  return body;
}
await writeFile(join(output,'generate.svg'),base('generate','材料生成',chatScene('generate')));
await writeFile(join(output,'qa.svg'),base('qa','项目问答',chatScene('qa')));
console.log('Generated five product illustrations; brand.svg is maintained separately.');
