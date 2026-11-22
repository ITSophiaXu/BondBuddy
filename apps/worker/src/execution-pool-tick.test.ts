import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { OpsScheduler } from './ops-scheduler.js';
import { setTimeout as delay } from 'node:timers/promises';
test('existing operations timer ticks without business events, stops, and restarts its optional pool callback', async () => {
  let ticks = 0;
  const make = () =>
    new OpsScheduler({
      pool: {} as Pool,
      tasks: [],
      tickMs: 20,
      executionPoolTick: async () => {
        ticks++;
      },
    });
  const one = make().start();
  await delay(75);
  await one.stop();
  assert.ok(ticks >= 2);
  const stopped = ticks;
  await delay(40);
  assert.equal(ticks, stopped);
  const two = make().start();
  await delay(30);
  await two.stop();
  assert.ok(ticks > stopped);
});
test('unconfigured scheduler never manufactures a cloud callback', async () => {
  const scheduler = new OpsScheduler({ pool: {} as Pool, tasks: [] });
  await scheduler.tick();
  await scheduler.stop();
});

test(
  'a maintenance task can remain pending across independent, nonoverlapping pool ticks',
  { timeout: 5000 },
  async () => {
    let finishMaintenance!: () => void;
    const maintenance = new Promise<void>((resolve) => {
      finishMaintenance = resolve;
    });
    let startedMaintenance!: () => void;
    const maintenanceStarted = new Promise<void>((resolve) => {
      startedMaintenance = resolve;
    });
    let twoTicks!: () => void;
    const poolProgress = new Promise<void>((resolve) => {
      twoTicks = resolve;
    });
    let active = 0,
      concurrent = 0,
      ticks = 0;
    const db = { query: async () => ({ rowCount: 1 }) } as unknown as Pool;
    const scheduler = new OpsScheduler({
      pool: db,
      tickMs: 5,
      tasks: [
        {
          name: 'log_forward',
          intervalMs: 1000,
          leaseMs: 1000,
          run: async () => {
            startedMaintenance();
            await maintenance;
            return { ok: true };
          },
        },
      ],
      executionPoolTick: async () => {
        concurrent = Math.max(concurrent, ++active);
        await delay(15);
        active--;
        if (++ticks === 2) twoTicks();
      },
    }).start();
    try {
      await maintenanceStarted;
      await poolProgress;
      assert.equal(concurrent, 1);
      let stopped = false;
      const stopping = scheduler.stop().then(() => {
        stopped = true;
      });
      await delay(25);
      assert.equal(stopped, false);
      assert.equal(ticks, 2);
      finishMaintenance();
      await stopping;
    } finally {
      finishMaintenance();
      await scheduler.stop();
    }
  },
);
