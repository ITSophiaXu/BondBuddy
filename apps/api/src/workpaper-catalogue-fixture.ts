import {ZipFile} from 'yazl';

/** Synthetic, headerless XLSX with the same structure as a numbered checklist. */
export async function headerlessCatalogueXlsx(rows?:string[][]){
  const zip=new ZipFile(),chunks:Buffer[]=[];
  const done=new Promise<Buffer>((resolve,reject)=>{zip.outputStream.on('data',c=>chunks.push(c));zip.outputStream.on('end',()=>resolve(Buffer.concat(chunks)));zip.outputStream.on('error',reject);});
  const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main',rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const cells=rows??[['合成公司尽调清单'],...['1','1-1','1-1-1'].map((code,i)=>[code,'合成核查 '+i])];
  const parts:Record<string,string>={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':`<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="目录" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml':`<worksheet xmlns="${ns}"><sheetData>${cells.map((row,i)=>`<row r="${i+1}">${row.map((value,c)=>`<c r="${String.fromCharCode(65+c)}${i+1}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
  };
  for(const [name,xml] of Object.entries(parts))zip.addBuffer(Buffer.from(xml),name);
  zip.end();return done;
}
