import {SaxesParser} from 'saxes';
import {readBoundedZipParts} from './docx-inspector.js';
import type {FileTemplatePreview} from '@bondbuddy/contracts';

// Whole-field allowlist. Unknown populated values never reach the browser.
// Neither filenames, original XML, attributes, links nor metadata are returned.
const labels=new Set(('项目名称 项目组成员 项目负责人 复核人 核查人员 核查日期 企业名称 公司名称 发行人名称 发行人 法定代表人 注册资本 实收资本 成立日期 注册地址 办公地址 联系地址 邮政编码 联系人 联系电话 电话 传真 电子邮箱 网址 姓名 职务 任期 性别 年龄 董事 监事 高级管理人员 经办人员 签字 签章 日期 序号 核查内容 核查方式 核查情况 核查结果 核查结论 备注 是否适用 适用性 核查人员签名 核查人员签字 复核人员签字 发行人基本情况 核查记录 核查文件 情况说明 发行人说明 核查意见 目录 重要提示 释义 公司基本情况 公司及相关中介机构简介 公司债券事项 财务报告 财务情况 财务信息 财务指标 资产总计 负债合计 所有者权益 营业收入 净利润 公司治理 债券基本信息 债券名称 债券简称 债券代码 债券余额 发行金额 发行规模 期限 单位 金额 比例 持股比例 持股数量 股东名称 出资人 关联关系 关联方名称 担保金额 担保余额 主承销商 受托管理人 律师事务所 会计师事务所 评级机构 核查依据 核查事项 核查程序 结论 本次发行 批准与授权 主体资格 发行条件 募集资金用途 募集资金运用 尽调结论 尽职调查记录 立项申请报告 主承销商核查意见 公司债券年度报告 法律意见书 发行申请书 风险因素 发行人信用情况 经营范围 主营业务 总资产 总负债 净资产 项目组意见 复核意见 负责人意见 经营活动产生的现金流量净额 发行方案 主要财务数据').split(' '));
export function redactTemplateText(value:string,cell=false){
 const text=value.replace(/\s/g,''),label=text.replace(/[：:]$/,'');
 if(!text)return '';
 if(labels.has(label))return label;
 const first=text.split(/[：:]/)[0];
 if(labels.has(first)&&first!==text)return first+'：【本项信息】';
 return cell?'—':'【本项目内容】';
}
export function templateStructure(bytes:Buffer,title:string):FileTemplatePreview{
 const parts=readBoundedZipParts(bytes,n=>n==='word/document.xml',true),raw=parts.get('word/document.xml');
 if(!raw)throw Error('TEMPLATE_WORD_REQUIRED');
 const blocks:FileTemplatePreview['blocks']=[];
 const ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main',parser=new SaxesParser({xmlns:true});
 const tables:{rows:string[][];row:string[];cell:string}[]=[];
 let paragraph:{text:string;bold:boolean}|undefined,body=false,inText=false,skip=0;
 parser.on('doctype',()=>{throw Error('TEMPLATE_XML_INVALID');});
 parser.on('opentag',tag=>{
  if(skip){skip++;return;}
  if(tag.uri!==ns){skip=1;return;}
  if(['del','moveFrom','drawing','pict','object'].includes(tag.local)){skip=1;return;}
  if(tag.local==='body')body=true;if(!body)return;
  if(tag.local==='tbl')tables.push({rows:[],row:[],cell:''});
  if(tag.local==='tr'&&tables.length)tables.at(-1)!.row=[];
  if(tag.local==='tc'&&tables.length)tables.at(-1)!.cell='';
  if(tag.local==='p')paragraph={text:'',bold:false};
  if(tag.local==='b'&&paragraph)paragraph.bold=true;
  if(tag.local==='t')inText=true;
 });
 parser.on('text',value=>{if(!skip&&body&&inText&&paragraph)paragraph.text+=value;});
 parser.on('closetag',tag=>{
  if(skip){skip--;return;}if(tag.uri!==ns||!body)return;
  if(tag.local==='t')inText=false;
  if(tag.local==='p'&&paragraph){if(tables.length)tables.at(-1)!.cell+=paragraph.text;else{const text=redactTemplateText(paragraph.text);if(text)blocks.push({kind:'paragraph',text,bold:paragraph.bold,align:'left'});}paragraph=undefined;}
  if(tag.local==='tc'&&tables.length)tables.at(-1)!.row.push(redactTemplateText(tables.at(-1)!.cell,true));
  if(tag.local==='tr'&&tables.length)tables.at(-1)!.rows.push(tables.at(-1)!.row);
  if(tag.local==='tbl'){const table=tables.pop();if(table?.rows.length)blocks.push({kind:'table',rows:table.rows});}
  if(tag.local==='body')body=false;
 });
 const xml=new TextDecoder('utf-8',{fatal:true}).decode(raw);for(let i=0;i<xml.length;i+=65536)parser.write(xml.slice(i,i+65536));parser.close();
 if(!blocks.length)throw Error('TEMPLATE_EMPTY');
 return {title,redacted:true,view:'structure',blocks,pdf_available:false};
}
