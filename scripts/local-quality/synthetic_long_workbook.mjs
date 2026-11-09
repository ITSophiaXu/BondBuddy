// Entirely invented engineering inputs. This builder reads only the companion synthetic case.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,all)=>
  index%2?pairs:[...pairs,[value.replace(/^--/,''),all[index+1]]],[]));
if(!args['fixture-dir']||!args['runtime-dir'])throw Error('--fixture-dir and --runtime-dir are required');
const directory=path.resolve(args['fixture-dir']);
const data=JSON.parse(await fs.readFile(path.join(directory,'case.json'),'utf8'));
if(data.schema!=='synthetic-long-2026q3-v1'||data.synthetic_only!==true||data.customer_inputs_read!==false)
  throw Error('A freshly generated purely synthetic case is required');
const require=createRequire(path.join(path.resolve(args['runtime-dir']),'runtime.cjs'));
const {Workbook,SpreadsheetFile}=await import(pathToFileURL(require.resolve('@oai/artifact-tool')).href);
const workbook=Workbook.create();
for(const spec of data.sheets){
  const sheet=workbook.worksheets.add(spec.name),last=5+spec.rows.length,lastCol=String.fromCharCode(65+spec.periods.length);
  sheet.showGridLines=false; sheet.tabColor='#D9C6A0';
  sheet.getRange(`A1:${lastCol}${last}`).format.font={name:'Arial',size:10,color:'#000000'};
  sheet.getRange('A2').values=[[spec.name+' 2026年三季度合成资料']];
  sheet.getRange('A2').format.font={name:'Arial',size:14,bold:true,color:'#000000'};
  sheet.getRange('A3').values=[[`编制主体 ${data.issuer}  单位 ${spec.unit}`]];
  sheet.getRange('A4').values=[['纯合成工程数据 明细索引不参与主表科目加总']];
  sheet.getRange('A3:A4').format.font={name:'Arial',size:10,italic:true,color:'#505050'};
  sheet.getRange(`A5:${lastCol}5`).values=[['项目',...spec.periods]];
  sheet.getRange(`A6:${lastCol}${last}`).values=spec.rows.map(row=>[row.metric,...row.yuan.map(value=>value/spec.multiplier)]);
  sheet.getRange(`A5:${lastCol}5`).format={fill:'#304E68',font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},
    horizontalAlignment:'center',verticalAlignment:'center',rowHeight:28};
  sheet.getRange(`A6:${lastCol}${last}`).format.rowHeight=23;
  sheet.getRange(`B6:${lastCol}${last}`).format.font={name:'Arial',size:10,color:'#0000FF'};
  sheet.getRange(`B6:${lastCol}${last}`).setNumberFormat('#,##0.00;(#,##0.00);"-"');
  sheet.getRange(`B6:${lastCol}${last}`).format.horizontalAlignment='right';
  sheet.getRange(`A1:A${last}`).format.columnWidth=38;
  sheet.getRange(`B1:${lastCol}${last}`).format.columnWidth=22;
  sheet.getRange(`A5:${lastCol}${last}`).format.verticalAlignment='center';
  sheet.freezePanes.freezeRows(5);
}
workbook.recalculate();
const inspections=[];
for(const spec of data.sheets){
  inspections.push({sheet:spec.name,inspection:(await workbook.inspect({kind:'table',range:`'${spec.name}'!A5:E16`,
    include:'values,formulas',tableMaxRows:12,tableMaxCols:5,maxChars:4000})).ndjson});
  const preview=await workbook.render({sheetName:spec.name,range:'A1:E17',scale:1.5,format:'png'});
  await fs.writeFile(path.join(directory,`preview-${spec.name}.png`),new Uint8Array(await preview.arrayBuffer()));
}
const errors=await workbook.inspect({kind:'match',searchTerm:'#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!',
  options:{useRegex:true,maxResults:30},summary:'final synthetic source error scan'});
const filename='synthetic-2026q3-financials.xlsx',output=await SpreadsheetFile.exportXlsx(workbook);
await output.save(path.join(directory,filename));
const bytes=await fs.readFile(path.join(directory,filename));
data.files.push({role:'financial',filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
await fs.writeFile(path.join(directory,'fixture-manifest.json'),JSON.stringify(data,null,2));
await fs.writeFile(path.join(directory,'workbook-verification.json'),JSON.stringify({syntheticOnly:true,inspections,errorScan:errors.ndjson,
  formulasExpected:false,reason:'Source observations are explicitly invented fixed actual values; no forecasting or business formulas are claimed.'},null,2));
console.log(JSON.stringify({filename,bytes:bytes.length,sheets:data.sheets.length,controls:data.controls.length,syntheticOnly:true}));
