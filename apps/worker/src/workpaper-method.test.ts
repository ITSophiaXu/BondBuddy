import test from 'node:test';
import assert from 'node:assert/strict';
import {workpaperMethodHash,type WorkpaperMethodInput} from './workpaper-method.js';

const legacy:WorkpaperMethodInput={skill:'1'.repeat(64),helper:'2'.repeat(64),sourceHelper:'3'.repeat(64),
  tools:{'read_material.py':'4'.repeat(64)},templates:'5'.repeat(64),
  model:{id:'legacy-regression-model',provider:'legacy_test',base:'https://example.test',version:'legacy-method-regression-v1',reasoning:'max'}};

test('the production method builder preserves the pre-progressive legacy identity',()=>{
  // Captured from the shared-method-v1 construction before the renderer split.
  assert.equal(workpaperMethodHash(legacy),'6b2a937aeb381bcb10e3f830497419b682376a078e9504ed07bc8ef93f62e4f5');
});

test('progressive delivery pins its own renderer without changing the legacy method',()=>{
  const progressive={groupSkill:'6'.repeat(64),groupSize:8,groupHelper:'7'.repeat(64),renderer:'8'.repeat(64)};
  const first=workpaperMethodHash({...legacy,progressive});
  assert.notEqual(first,workpaperMethodHash({...legacy,progressive:{...progressive,renderer:'9'.repeat(64)}}));
  assert.notEqual(first,workpaperMethodHash(legacy));
  assert.equal(workpaperMethodHash(legacy),'6b2a937aeb381bcb10e3f830497419b682376a078e9504ed07bc8ef93f62e4f5');
});
