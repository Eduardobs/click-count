// A batch becomes immutable before transmission; every retry reuses its UUID,
// amount and identity, including when the server committed but the response was lost.
export class ClickQueue {
  constructor(limit = 1000) {
    this.limit = limit;
    this.pending = [];
    this.active = null;
  }
  get size() { return this.pending.length + (this.active?.amount || 0); }
  push(userId) {
    if (this.size >= this.limit) return false;
    this.pending.push(userId);
    return true;
  }
  next() {
    if (this.active || !this.pending.length) return this.active;
    const userId = this.pending[0];
    let amount = 1;
    while (amount < 50 && amount < this.pending.length && this.pending[amount] === userId) amount++;
    this.pending.splice(0, amount);
    this.active = Object.freeze({ userId, amount, request_id: crypto.randomUUID() });
    return this.active;
  }
  acknowledge(batch) {
    if (this.active !== batch) throw new Error('Unexpected batch acknowledgement');
    this.active = null;
  }
}
export function retryDelay(attempt, retryAfterMs = 0, random = Math.random) {
  return Math.max(retryAfterMs, Math.min(60000, 2500 * 2 ** Math.min(attempt, 5)) * (0.5 + random() * 0.5));
}
