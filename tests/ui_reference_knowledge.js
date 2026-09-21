const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../web'),html=fs.readFileSync(path.join(root,'cowork.html'),'utf8');
assert.equal((html.match(/id="use-reference-knowledge"/g)||[]).length,1);
assert.ok(html.indexOf('id="use-reference-knowledge"')<html.indexOf('id="detail" hidden'),'Visible before project selection');
const fields={},posts=[];
for(const [,id] of html.matchAll(/id="([^"]+)"/g))fields[id]={value:'',checked:false,hidden:false,disabled:false,handlers:{},addEventListener(k,f){this.handlers[k]=f},replaceChildren(){},removeAttribute(){}};
const fixture=id=>({id,title:id,period:'2026-06-30',files:[{role:'source',name:'财报'}],original_id:'original',job:{status:'idle'}});
const context=vm.createContext({URLSearchParams,crypto:{randomUUID:()=>String(Math.random())},Option:class{},history:{replaceState(){}},location:{search:'?project=p1',pathname:'/cowork.html'},setInterval(){},document:{getElementById:id=>fields[id],createElement:()=>({})},fetch:async(url,options)=>{
 let result=url==='/api/health'?{csrf:'test'}:url==='/api/projects'?[fixture('p1'),fixture('p2')]:fixture(url.split('/').at(-1));
 if(options.method==='POST'){posts.push({url,...JSON.parse(options.body)});result={run_id:'test'};}
 return {ok:true,json:async()=>result};
}});
vm.runInContext(fs.readFileSync(path.join(root,'direct-word.js'),'utf8'),context);
(async()=>{
 for(let i=0;i<30;i++)await Promise.resolve();
 assert.equal(fields['use-reference-knowledge'].checked,false);
 await fields.run.handlers.click();assert.equal(posts.at(-1).use_reference_knowledge,false);
 fields['use-reference-knowledge'].checked=true;fields['use-reference-knowledge'].handlers.change();
 await fields.run.handlers.click();assert.equal(posts.at(-1).use_reference_knowledge,true);
 fields.projects.value='p2';await fields.projects.handlers.change();assert.equal(fields['use-reference-knowledge'].checked,false);
 fields.projects.value='p1';await fields.projects.handlers.change();assert.equal(fields['use-reference-knowledge'].checked,true);
 fields['use-reference-knowledge'].checked=false;fields['use-reference-knowledge'].handlers.change();
 await fields.run.handlers.click();assert.equal(posts.at(-1).use_reference_knowledge,false);
 console.log('PASS: unchecked default, true/false task payloads, one control, and project selection isolation');
})().catch(e=>{console.error(e);process.exitCode=1});
