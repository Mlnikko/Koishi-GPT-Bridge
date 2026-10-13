'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { JobQueue } = require('../src/core/queue.cjs');

// Metadata-only comparison: no model, transport, task files or startup I/O.
// The old lookup algorithms remain here solely as a repeatable control group.
const jobs = Array.from({ length: 10000 }, (_, index) => ({ id: index.toString(16).padStart(12, '0'),
  owner: 'alice', conversation: 'qq:alice', sessionId: 's' + index % 100, messageId: 'm' + index,
  createdAt: index, status: 'ready' }));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-benchmark-'));
const queue = new JobQueue(root, () => { throw Error('benchmark must never execute a job'); });
queue.jobs = jobs;
for (const job of jobs) queue.indexJob(job);

function measure(query) {
  let checksum = 0;
  const samples = [];
  for (let sample = 0; sample < 7; sample++) {
    const started = performance.now();
    for (let index = 0; index < 1000; index++) checksum += query(index).id.charCodeAt(11);
    if (sample >= 2) samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return { medianMs: +samples[2].toFixed(3), checksum };
}
const legacyFind = (id, sessionId) => jobs.filter(j => j.owner === 'alice' && j.conversation === 'qq:alice'
  && (!id || j.id === id) && (id || !sessionId || j.sessionId === sessionId)).sort((a, b) => b.createdAt - a.createdAt)[0];
try {
  const comparisons = [
    ['按任务编号查询', index => legacyFind(jobs[index].id), index => queue.find(jobs[index].id, 'alice', 'qq:alice')],
    ['当前会话最近任务', () => legacyFind(undefined, 's0'), () => queue.find(undefined, 'alice', 'qq:alice', 's0')],
    ['平台消息去重', index => jobs.find(j => j.owner === 'alice' && j.conversation === 'qq:alice' && j.messageId === 'm' + index),
      index => queue.duplicate('alice', 'qq:alice', 'm' + index)],
  ].map(([name, before, after]) => {
    const previous = measure(before), current = measure(after);
    if (previous.checksum !== current.checksum) throw Error('lookup results changed: ' + name);
    return { name, beforeMs: previous.medianMs, afterMs: current.medianMs };
  });
  console.log(JSON.stringify({ jobs: jobs.length, queriesPerSample: 1000, measuredSamples: 5, comparisons }, null, 2));
} finally { queue.close(); fs.rmSync(root, { recursive: true, force: true }); }
