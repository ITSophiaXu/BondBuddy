import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

test('prototype styles imported by the browser are included in the production build context and COPY inputs', () => {
  const root=resolve('../..'),docker=readFileSync(resolve(root,'deploy/m1/Dockerfile'),'utf8');
  const included=new Set(readFileSync(resolve(root,'deploy/m1/Dockerfile.dockerignore'),'utf8').split(/\r?\n/).filter(line=>line.startsWith('!')).map(line=>line.slice(1)));
  const copied=new Set(docker.split(/\r?\n/).filter(line=>line.startsWith('COPY product-prototype/')).flatMap(line=>line.trim().split(/\s+/).slice(1,-1)));
  const assets=new Set<string>();
  // CSS can import the prototype baseline through a page stylesheet, without a direct TS import.
  for(const name of readdirSync('src').filter(name=>/\.(?:ts|css)$/.test(name))){
    const source=readFileSync(resolve('src',name),'utf8');
    for(const match of source.matchAll(/import ['"]\.\.\/\.\.\/\.\.\/(product-prototype\/public\/[^'"]+\.css)['"]/g))assets.add(match[1]);
  }
  assert.ok(assets.size>0,'the check must discover the actual browser imports');
  for(const asset of assets){
    assert.ok(readFileSync(resolve(root,asset)).length>0,`${asset} exists`);
    assert.ok(included.has(asset),`${asset} survives the Docker context filter`);
    assert.ok(copied.has(asset),`${asset} is copied into the build stage`);
  }
});

test('local E2E script imports remain available during production container type checking', () => {
  const root=resolve('../..'),docker=readFileSync(resolve(root,'deploy/m1/Dockerfile'),'utf8');
  const copied=new Set(docker.split(/\r?\n/).filter(line=>line.startsWith('COPY scripts/')).flatMap(line=>line.trim().split(/\s+/).slice(1,-1)));
  const dependencies=new Set<string>();
  for(const name of readdirSync('tests').filter(name=>name.endsWith('.ts'))){
    const source=readFileSync(resolve('tests',name),'utf8');
    for(const match of source.matchAll(/from ['"]\.\.\/\.\.\/\.\.\/(scripts\/[^'"]+\.mjs)['"]/g))dependencies.add(match[1]);
  }
  assert.ok(dependencies.size>0,'discover the actual local E2E imports included by tsconfig');
  for(const dependency of dependencies){
    assert.ok(copied.has(dependency),`${dependency} is copied before container type checking`);
    const declaration=dependency.replace(/\.mjs$/,'.d.mts');
    if(existsSync(resolve(root,declaration)))assert.ok(copied.has(declaration),`${declaration} is copied with its module`);
  }
});
