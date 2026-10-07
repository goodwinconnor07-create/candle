/*
 * The Durable Object that makes the questions for one study set. A run takes
 * a minute or so and mustn't depend on the player's browser staying open, so
 * the Worker only asks for it to start; the work happens in this object's
 * alarm, and the browser polls the set's status in D1.
 */
import * as Library from './library.js';
import * as Generate from './generate.js';

const MIN_QUESTIONS = 10;   // fewer good questions than this and the run counts as failed

export class SetJob {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const job = await request.json();
    await this.state.storage.put('job', job);
    await this.state.storage.setAlarm(Date.now());
    return new Response('{"status":"generating"}', { status: 202, headers: { 'content-type': 'application/json' } });
  }

  // never throws: an alarm that throws is retried, and a retry would pay for the calls again
  async alarm() {
    const job = await this.state.storage.get('job');
    if (!job) return;
    await this.state.storage.delete('job');
    const db = this.env.DB;
    let spent = 0, detail = null;
    try {
      const chunks = await Library.getChunks(db, job.setId);
      const out = await Generate.generate(Generate.makeClient(this.env), chunks);
      spent = out.calls.reduce((n, c) => n + c.cost, 0);
      detail = { calls: out.calls, dropped: out.dropped, failed: out.failed };
      if (out.questions.length < MIN_QUESTIONS) {
        const why = out.failed ? "Something went wrong while making the questions. Try again." : "We couldn't make enough good questions from that. Add more notes and try again.";
        await Library.failRun(db, job.setId, job.runId, why, spent, detail);
        return;
      }
      await Library.saveRun(db, job.setId, job.runId, out, chunks, spent);
    } catch (e) {
      try { await Library.failRun(db, job.setId, job.runId, 'Something went wrong while making the questions. Try again.', spent, detail); } catch (e2) {}
    }
  }
}
