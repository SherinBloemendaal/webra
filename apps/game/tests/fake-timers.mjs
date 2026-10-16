// Timers driven by hand (setTimeout, setInterval and their clears), for
// stores and clients that take a `timers` object.

export class FakeTimers {
  constructor() {
    this.now = 0;
    this.next = 1;
    this.jobs = new Map();
  }

  setTimeout(fn, ms) {
    const id = this.next++;
    this.jobs.set(id, { fn, at: this.now + ms, every: null });
    return id;
  }

  setInterval(fn, ms) {
    const id = this.next++;
    this.jobs.set(id, { fn, at: this.now + ms, every: ms });
    return id;
  }

  clearTimeout(id) {
    this.jobs.delete(id);
  }

  clearInterval(id) {
    this.jobs.delete(id);
  }

  advance(ms) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.jobs.entries()].filter(([, j]) => j.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, job] = due;
      this.now = job.at;
      if (job.every) job.at += job.every;
      else this.jobs.delete(id);
      job.fn();
    }
    this.now = end;
  }
}
