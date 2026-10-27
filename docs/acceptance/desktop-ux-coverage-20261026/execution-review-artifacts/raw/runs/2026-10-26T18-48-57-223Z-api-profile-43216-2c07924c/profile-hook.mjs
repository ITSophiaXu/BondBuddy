import pg from 'pg';
const original=pg.Pool.prototype.query;
let sequence=0;
pg.Pool.prototype.query=function(...args){
  const id=++sequence,start=performance.now(),sql=String(args[0]?.text??args[0]).replaceAll(/\s+/g,' ').slice(0,180);
  process.stdout.write(JSON.stringify({trace:'begin',id,sql})+'\n');
  const result=original.apply(this,args);
  return result.then(value=>{process.stdout.write(JSON.stringify({trace:'end',id,ms:performance.now()-start})+'\n');return value;},
    error=>{process.stdout.write(JSON.stringify({trace:'error',id,ms:performance.now()-start,code:error.code})+'\n');throw error;});
};
