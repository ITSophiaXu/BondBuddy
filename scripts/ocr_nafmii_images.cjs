// Optional OCR research derivative for supplied image-based teaching articles.
// Args: tesseract.js module path, directory of rendered <ID>-PAGE###.png files.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {createWorker}=require(path.resolve(process.argv[2]));
async function main(){
 const base=path.resolve(__dirname,'../knowledge/nafmii');
 const files=fs.readdirSync(process.argv[3]).filter(x=>/^NA\d{3}-PAGE\d{3}\.png$/.test(x)).sort();
 const worker=await createWorker('chi_sim+eng',1,{cachePath:path.resolve(process.argv[3])});
 try{
  for(const sid of [...new Set(files.map(x=>x.slice(0,5)))]){
   const records=[];
   for(const file of files.filter(x=>x.startsWith(sid+'-'))){
    const {data}=await worker.recognize(path.join(process.argv[3],file));
    records.push({locator:file.slice(6,-4),role:'ocr_unverified',text:data.text,confidence:data.confidence});
    console.log(file, data.confidence);
   }
   const result={source_id:sid,original_sha256:createHash('sha256').update(fs.readFileSync(path.join(base,'originals',sid+'.pdf'))).digest('hex'),extraction_status:'ocr_unverified',extraction_tool:'tesseract.js '+require(path.join(path.resolve(process.argv[2]),'package.json')).version,render_scale:1.5,language:'chi_sim+eng',records};
   fs.mkdirSync(path.join(base,'ocr'),{recursive:true});
   fs.writeFileSync(path.join(base,'ocr',sid+'.json'),JSON.stringify(result,null,2)+'\n');
  }
 }finally{await worker.terminate();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
