import test from 'node:test';
import assert from 'node:assert/strict';
import { ClickQueue, retryDelay } from '../click-queue.js';

test('lost responses retry the identical batch while new clicks wait', () => {
  const queue = new ClickQueue();
  for (let i = 0; i < 60; i++) queue.push('user-a');
  const batch = queue.next();
  assert.equal(batch.amount, 50);
  queue.push('user-a');
  assert.equal(queue.next(), batch);
  assert.equal(queue.size, 61);
  queue.acknowledge(batch);
  const next = queue.next();
  assert.equal(next.amount, 11);
  assert.notEqual(next.request_id, batch.request_id);
  queue.acknowledge(next);
  assert.equal(queue.size, 0);
  assert.equal(queue.next(), null);
});
test('batches never attribute guest clicks or another account to a signed-in user', () => {
  const queue = new ClickQueue();
  for (const id of [null, null, 'a', 'b', null]) queue.push(id);
  for (const [userId, amount] of [[null, 2], ['a', 1], ['b', 1], [null, 1]]) {
    const batch = queue.next();
    assert.equal(batch.userId, userId);
    assert.equal(batch.amount, amount);
    queue.acknowledge(batch);
  }
});
test('queue bounds memory including in-flight requests', () => {
  const queue = new ClickQueue(2);
  assert.equal(queue.push(null), true);
  const batch = queue.next();
  assert.equal(queue.push(null), true);
  assert.equal(queue.push(null), false);
  queue.acknowledge(batch);
  assert.equal(queue.push(null), true);
});
test('retries back off, add jitter and honor Retry-After', () => {
  assert.equal(retryDelay(0, 0, () => 1), 2500);
  assert.equal(retryDelay(2, 0, () => 1), 10000);
  assert.equal(retryDelay(1000, 0, () => 1), 60000);
  assert.equal(retryDelay(0, 8000, () => 0), 8000);
  assert.equal(retryDelay(0, 0, () => 0), 1250);
});
