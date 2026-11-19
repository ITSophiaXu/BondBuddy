const fs=require('fs'),ts=require('typescript'),crypto=require('crypto'),path=require('path');
const dir='.release-scratch';
const read=n=>fs.readFileSync(path.join(dir,n),'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const live=read('live-main.js'),base=read('master-baseline.js'),next=read('master-candidate.js');
const expected='c454d17f066a1ec496493a43878390cc16c0f52688b870c94bf33c24afee2785';
if(sha(live)!==expected)throw Error('Live JS preimage mismatch');
function ast(s){const sf=ts.createSourceFile('bundle.js',s,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);if(sf.parseDiagnostics.length)throw Error('JS parse error');return sf}
function collection(sf,s){const i=s.indexOf('Project pagination did not advance');if(i<0)throw Error('Collection marker missing');let result;function walk(n){if(n.pos<=i&&i<n.end){if(ts.isFunctionDeclaration(n))result=n;ts.forEachChild(n,walk)}}walk(sf);if(!result)throw Error('Collection function missing');return result}
function browser(sf){let result;function walk(n){if(ts.isClassExpression(n)&&n.members.some(m=>m.name?.getText(sf)==='renderSync')&&n.members.some(m=>m.name?.getText(sf)==='paint')){if(result)throw Error('Multiple browser classes');result=n}ts.forEachChild(n,walk)}walk(sf);if(!result)throw Error('Browser class missing');return result}
function member(sf,cl,name){const hits=cl.members.filter(m=>m.name?.getText(sf)===name);if(hits.length!==1)throw Error('Member '+name+' not unique');return hits[0]}
function raw(sf,n){return sf.text.slice(n.getStart(sf),n.end)}
const L=ast(live),B=ast(base),N=ast(next),lc=browser(L),bc=browser(B),nc=browser(N);
const normalize=(name,s)=>name==='load'?s.replace('Kl(','Cl(').replace('S(e,`read`)','x(e,`read`)'):name==='renderSync'?s.replaceAll('A(this.lastSync)','E(this.lastSync)').replaceAll('A(dg.format','E(Hh.format'):s;
const edits=[];
let lp=collection(L,live),bp=collection(B,base),np=collection(N,next);
if(raw(L,lp)!==raw(B,bp).replace('function Kl(','function Cl('))throw Error('Collection baseline differs from live');
edits.push([lp.getStart(L),lp.end,raw(N,np).replace('function Kl(','function Cl(')]);
for(const name of ['renderSync','load','paint']){
 const l=member(L,lc,name),b=member(B,bc,name),n=member(N,nc,name);
 if(raw(L,l)!==normalize(name,raw(B,b)))throw Error(name+' baseline differs from live');
 edits.push([l.getStart(L),l.end,normalize(name,raw(N,n))]);
}
const loaded=member(L,lc,'loaded');if(raw(L,loaded)!=='loaded=!1;'||nc.members.filter(m=>m.name?.getText(N)==='partial').length!==1)throw Error('Partial field baseline differs');
edits.push([loaded.end,loaded.end,'partial=!1;']);
let output=live;for(const [start,end,replacement] of edits.sort((a,b)=>b[0]-a[0]))output=output.slice(0,start)+replacement+output.slice(end);
if(ast(output).parseDiagnostics.length)throw Error('Candidate parse error');
const jsName='main-tasklist1649-'+sha(output).slice(0,8)+'.js';
const index=read('live-index.html');if(sha(index)!=='596a2b1125034799178685f879f8fd9f58260b540b4baf8bc7d76d1313726b99')throw Error('Index preimage mismatch');
if(index.split('main-lH0AuHk5.js').length!==2)throw Error('Index entry not unique');
const newIndex=index.replace('main-lH0AuHk5.js',jsName);
fs.writeFileSync(path.join(dir,jsName),output);fs.writeFileSync(path.join(dir,'candidate-index.html'),newIndex);
console.log(JSON.stringify({jsName,jsBytes:Buffer.byteLength(output),jsSha256:sha(output),indexSha256:sha(newIndex),indexBytes:Buffer.byteLength(newIndex),edits:edits.length,sourcePr:1649},null,2));
