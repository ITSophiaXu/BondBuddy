import assert from 'node:assert/strict';
import {test} from 'node:test';
import {navigationProjectContext,projectWorkHref,rechargeHref,workReturnTo} from './project-navigation.js';

test('work links keep the original project across execution workspace remapping',()=>{
  for(const work of ['update','review','generate','integrity','qa','consistency'] as const){
    const href=projectWorkHref(work,'source project');
    assert.deepEqual(navigationProjectContext(href),{projectId:'source project',work});
    assert.equal(new URLSearchParams(href.split('?')[1]).get('project'),'source project');
  }
  assert.deepEqual(navigationProjectContext('#/projects/derived-review/review?return_project=source%20project'),{projectId:'source project',work:'review'});
  assert.deepEqual(navigationProjectContext('#/projects/derived-update?from=projects&return_project=source%20project'),{projectId:'source project',work:'update'});
});

test('global and malformed routes do not inherit a stale project',()=>{
  for(const hash of ['#tasks','#generate','#review?new=1','#/new?return_project=old','#/projects/%E0%A4%A/files','#tasks?return_project=old'])assert.equal(navigationProjectContext(hash),null);
  assert.equal(navigationProjectContext('#qa?project='+('x'.repeat(129))),null);
  assert.deepEqual(navigationProjectContext('#qa?project=owned&return_project=%00'),{projectId:'owned',work:'qa'});
});

test('direct file and account routes retain an explicit navigation return project',()=>{
  assert.equal(projectWorkHref('files','a/b'),'#/projects/a%2Fb/files');
  assert.deepEqual(navigationProjectContext('#/projects/a%2Fb/files'),{projectId:'a/b',work:'files'});
  assert.deepEqual(navigationProjectContext('#/account?project=original'),{projectId:'original',work:null});
  assert.deepEqual(navigationProjectContext('#/artifacts/result?return_project=original'),{projectId:'original',work:null});
  assert.equal(navigationProjectContext('#/artifacts/result'),null);
});

test('recharge keeps the execution project and exact work separately from its return project',()=>{
  const work='#/projects/execution-review/review?tab=results&report_id=report-1&return_project=original';
  const href=rechargeHref(undefined,work),query=new URLSearchParams(href.split('?')[1]);
  assert.equal(query.get('project'),'execution-review');
  assert.equal(query.get('return_project'),'original');
  assert.equal(query.get('return_to'),work);
  const afterOrder=new URLSearchParams(rechargeHref('execution-review',href+'&order=order-1').split('?')[1]);
  assert.equal(afterOrder.get('project'),'execution-review');
  assert.equal(afterOrder.get('return_to'),work);
});

test('topic navigation never supplies an inferred order project from its return project',()=>{
  const work='#generate?topic=topic-1&run=run-1&return_project=original';
  assert.deepEqual(navigationProjectContext(work),{projectId:'original',work:'generate'});
  const query=new URLSearchParams(rechargeHref(undefined,work).split('?')[1]);
  assert.equal(query.get('project'),null);
  assert.equal(query.get('return_project'),'original');
  assert.equal(query.get('return_to'),work);
  assert.deepEqual(navigationProjectContext(rechargeHref(undefined,work)),{projectId:'original',work:null});
  assert.equal(new URLSearchParams(rechargeHref('execution-topic',work).split('?')[1]).get('project'),'execution-topic');
});

test('recharge return destinations reject external, account, unknown and malformed routes',()=>{
  for(const value of ['https://example.com','#//example.com','#/account?project=old','#unknown?project=p','#qa?project=%0A','#qa?project=%5c','#qa?project=%E0%A4%A','#qa?project=p\n','#qa?project='+'a'.repeat(2049)])assert.equal(workReturnTo(value),null);
  for(const value of ['#consistency?project=p&run=check-1','#qa?project=p&run=answer-1','#integrity?project=p&run=check-2','#generate?project=p&step=documents','#/projects/p/files?folder=4.2'])assert.equal(workReturnTo(value),value);
  assert.equal(new URLSearchParams(rechargeHref(undefined,'#/account?return_to=https%3A%2F%2Fexample.com').split('?')[1]).get('return_to'),null);
});
