import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {OpsScheduler} from './ops-scheduler.js';
import {setTimeout as delay} from 'node:timers/promises';
test('existing operations timer ticks without business events, stops, and restarts its optional pool callback',async()=>{
 let ticks=0;
 const make=()=>new OpsScheduler({pool:{} as Pool,tasks:[],tickMs:20,executionPoolTick:async()=>{ticks++;}});
 const one=make().start();await delay(75);await one.stop();assert.ok(ticks>=2);const stopped=ticks;await delay(40);assert.equal(ticks,stopped);
 const two=make().start();await delay(30);await two.stop();assert.ok(ticks>stopped);
});
test('unconfigured scheduler never manufactures a cloud callback',async()=>{
 const scheduler=new OpsScheduler({pool:{} as Pool,tasks:[]});await scheduler.tick();await scheduler.stop();
});
