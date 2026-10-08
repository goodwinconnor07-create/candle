/*
 * The Durable Object that runs paid work for one study set, away from the
 * player's request: making the set, an offered top-up, a free master-sheet
 * upgrade, or replacing a reported question. The Worker only asks for a job
 * to start; the work happens in this object's alarm, and the browser polls
 * the set's status in D1.
 *
 * A top-up goes through the Batch API (half price, not urgent): the alarm
 * sends the batch, then comes back every minute until it's done.
 */
import * as Library from './library.js';
import * as Generate from './generate.js';
import { mergeSheets } from './questions.js';

const MIN_QUESTIONS = 10;   // fewer good questions than this and the run counts as failed
const BATCH_POLL_MS = 60 * 1000;
const BATCH_GIVE_UP_MS = 26 * 60 * 60 * 1000;   // the Batch API finishes within a day

export class SetJob {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const job = await request.json();
    await this.state.storage.put('job', job);
    await this.state.storage.setAlarm(Date.now());
    return new Response('{"status":"started"}', { status: 202, headers: { 'content-type': 'application/json' } });
  }

  // never throws: an alarm that throws is retried, and a retry would pay for the calls again
  async alarm() {
    const job = await this.state.storage.get('job');
    if (!job) return;
    try {
      if (job.kind === 'topup') return await this.topup(job);
      await this.state.storage.delete('job');
      if (job.kind === 'fix') return await this.fix(job);
      if (job.kind === 'sheet') return await this.sheet(job);
      return await this.make(job);
    } catch (e) {
      await this.state.storage.delete('job');
      try {
        if (job.kind === 'topup') await Library.failTopup(this.env.DB, job.setId, job.runId, job.spent || 0, null);
        else if (job.kind === 'make' || !job.kind) await Library.failRun(this.env.DB, job.setId, job.runId, 'Something went wrong while making the questions. Try again.', 0, null);
        else await this.finishRun(job.runId, 'failed', 0, null);
      } catch (e2) {}
    }
  }

  async finishRun(runId, status, cost, detail) {
    await this.env.DB.prepare('UPDATE gen_runs SET status = ?, finished = ?, cost_micro = ?, detail = ? WHERE id = ?')
      .bind(status, Date.now(), cost, detail ? JSON.stringify(detail) : null, runId).run();
  }

  async make(job) {
    const db = this.env.DB;
    let spent = 0, detail = null;
    const chunks = await Library.getChunks(db, job.setId);
    const out = await Generate.generate(Generate.makeClient(this.env), chunks, job.maxSlices);
    spent = out.calls.reduce((n, c) => n + c.cost, 0);
    detail = { calls: out.calls, dropped: out.dropped, failed: out.failed };
    if (out.questions.length < MIN_QUESTIONS) {
      const why = out.failed ? 'Something went wrong while making the questions. Try again.' : "We couldn't make enough good questions from that. Add more notes and try again.";
      await Library.failRun(db, job.setId, job.runId, why, spent, detail);
      return;
    }
    await Library.saveRun(db, job.setId, job.runId, out, chunks, spent);
    await db.prepare('UPDATE study_sets SET source_hash = ? WHERE id = ?').bind(await Library.sourceHash(chunks), job.setId).run();
  }

  // a set made before the master sheet gets one, free to the player
  async sheet(job) {
    const db = this.env.DB;
    const chunks = await Library.getChunks(db, job.setId);
    const out = await Generate.generateSheet(Generate.makeClient(this.env), chunks);
    const cost = out.calls.reduce((n, c) => n + c.cost, 0);
    if (out.sheets.length) await db.prepare('UPDATE study_sets SET sheet = ? WHERE id = ?').bind(JSON.stringify(mergeSheets(out.sheets)), job.setId).run();
    await this.finishRun(job.runId, out.sheets.length ? 'done' : 'failed', cost, { calls: out.calls });
  }

  // one replacement for a reported question, from the same part of the notes
  async fix(job) {
    const db = this.env.DB;
    const out = await Generate.askFix(Generate.makeClient(this.env), job.chunkText, job.oldText);
    if (out.question) await Library.saveFix(db, job.setId, job.chunkId, job.reportId, out.question);
    await this.finishRun(job.runId, out.question ? 'done' : 'failed', out.call.cost, { calls: [out.call] });
  }

  async topup(job) {
    const db = this.env.DB;
    const client = Generate.makeClient(this.env);
    const chunks = await Library.getChunks(db, job.setId);
    const slices = Generate.pickSlices(Generate.makeSlices(chunks));
    if (!job.batchId) {
      const have = await Library.existingStems(db, job.setId);
      const batch = await client.messages.batches.create({ requests: Generate.topupRequests(slices, have, 20) });
      job.batchId = batch.id;
      job.sentAt = Date.now();
      await db.prepare('UPDATE gen_runs SET batch_id = ? WHERE id = ?').bind(batch.id, job.runId).run();
      await this.state.storage.put('job', job);
      await this.state.storage.setAlarm(Date.now() + BATCH_POLL_MS);
      return;
    }
    const b = await client.messages.batches.retrieve(job.batchId);
    if (b.processing_status !== 'ended') {
      if (Date.now() - job.sentAt > BATCH_GIVE_UP_MS) throw new Error('batch took too long');
      await this.state.storage.setAlarm(Date.now() + BATCH_POLL_MS);
      return;
    }
    await this.state.storage.delete('job');
    const questions = [], calls = [];
    for await (const r of await client.messages.batches.results(job.batchId)) {
      if (!r.result || r.result.type !== 'succeeded') continue;
      const i = Number(String(r.custom_id).split('-')[1]);
      const got = Generate.readTopup(r.result.message, slices[i] || slices[0]);
      // the Batch API bills at half the normal price
      calls.push({ ...got.call, cost: Math.ceil(got.call.cost / 2) });
      questions.push(...got.questions);
    }
    const spent = calls.reduce((n, c) => n + c.cost, 0);
    if (!questions.length) { await Library.failTopup(db, job.setId, job.runId, spent, { calls }); return; }
    await Library.saveTopup(db, job.setId, job.runId, questions, chunks, spent, { calls, added: questions.length });
  }
}
