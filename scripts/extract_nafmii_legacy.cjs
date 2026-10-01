// Independent read-only DOC extraction; never launches Office or runs macros.
// npm install --prefix <temporary-dir> --no-save --ignore-scripts word-extractor@1.0.4
// node scripts/extract_nafmii_legacy.cjs <temporary-dir>/node_modules/word-extractor
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const WordExtractor = require(path.resolve(process.argv[2]));
const root = path.resolve(__dirname, '../knowledge/nafmii');
async function main() {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, 'sources.json'), 'utf8'));
  const official=JSON.parse(fs.readFileSync(path.join(root,'official/catalog.json'),'utf8')).filter(s=>s.path.endsWith('.doc')).map(s=>({...s,original_path:s.path}));
  for (const source of [...catalog.sources.filter(s => s.original_path.endsWith('.doc')), ...official]) {
    const filename = path.join(root, source.original_path);
    if (createHash('sha256').update(fs.readFileSync(filename)).digest('hex') !== source.sha256) throw Error('Original hash mismatch');
    const doc = await new WordExtractor().extract(filename);
    const text = doc.getBody();
    const records = text.split(/\r?\n|\r/).map((line, i) => ({locator: `L${String(i+1).padStart(5,'0')}`, role:'body', text:line})).filter(r=>r.text.trim());
    const result = {source_id:source.source_id, original_sha256:source.sha256, extraction_status:'legacy_doc_text_extracted', extraction_tool:'word-extractor@1.0.4', locator_note:'Extracted body line, not original page or Word paragraph; table cells may be linearized. Quoted form identifiers must be retained.', records};
    fs.writeFileSync(path.join(root, 'records', source.source_id+'.json'), JSON.stringify(result,null,2)+'\n');
    source.parse_status=result.extraction_status;
    source.record_count=records.length;
    console.log(source.source_id, records.length, text.length);
  }
  fs.writeFileSync(path.join(root,'sources.json'),JSON.stringify(catalog,null,2)+'\n');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
