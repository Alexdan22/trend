class AsyncWorkQueue {
  constructor({ maxSize = 100, onError = () => {} } = {}) {
    this.maxSize = maxSize;
    this.onError = onError;
    this.jobs = [];
    this.running = false;
  }

  enqueue(label, work) {
    if (this.jobs.length >= this.maxSize) return false;
    this.jobs.push({ label, work });
    queueMicrotask(() => this.#drain());
    return true;
  }

  async #drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift();
        try {
          await job.work();
        } catch (error) {
          try { this.onError(error, job.label); } catch (_) {}
        }
      }
    } finally {
      this.running = false;
    }
  }

  size() { return this.jobs.length + (this.running ? 1 : 0); }

  async idle() {
    while (this.running || this.jobs.length) await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

module.exports = { AsyncWorkQueue };
