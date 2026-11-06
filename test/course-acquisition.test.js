'use strict';
// The course acquisition coordinator (lib/course.js): one acquisition per course, shared
// by every caller, aborted only when no caller still wants it. A caller's signal and a
// newer pick of another course (abortDifferent) withdraw that caller's claim only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { createCourseAcquisitionCoordinator } = require('../lib/course');

// An acquisition that settles when told to and rejects with AbortError when aborted.
function controllable() {
  const calls = [];
  const coordinator = createCourseAcquisitionCoordinator((request, { source, signal }) => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    calls.push({ courseId: source.courseId, signal, resolve, reject });
    return promise;
  });
  return { coordinator, calls };
}

const course = (osmId) => ({ osmType: 'way', osmId });

test('a caller that gives up withdraws only its own claim: the others still get the course', async () => {
  const { coordinator, calls } = controllable();
  const download = new AbortController();
  const background = coordinator.acquire(course(1), { signal: download.signal });
  const plain = coordinator.acquire(course(1));
  assert.equal(calls.length, 1, 'one acquisition, shared');

  download.abort(new Error('cancelled by the player'));
  await assert.rejects(background, /cancelled by the player/);
  assert.equal(calls[0].signal.aborted, false, 'the other caller still wants it');

  calls[0].resolve({ id: 'one' });
  assert.deepEqual(await plain, { id: 'one' });
  assert.equal(coordinator.inFlightCount(), 0);
});

test('the work is aborted once the last claim is withdrawn', async () => {
  const { coordinator, calls } = controllable();
  const a = new AbortController();
  const b = new AbortController();
  const first = coordinator.acquire(course(2), { signal: a.signal });
  const second = coordinator.acquire(course(2), { signal: b.signal });
  assert.equal(calls.length, 1);

  a.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(calls[0].signal.aborted, false);

  b.abort();
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(calls[0].signal.aborted, true, 'nobody wants it any more');
  // the shared promise settled too, so the course can be asked for again
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(coordinator.inFlightCount(), 0);
});

test('a pick of another course leaves a background download running; the older pick gives up at once', async () => {
  const { coordinator, calls } = controllable();
  const download = new AbortController();
  const background = coordinator.acquire(course(3), { signal: download.signal });
  const olderPick = coordinator.acquire(course(3), { abortDifferent: true });
  const newerPick = coordinator.acquire(course(4), { abortDifferent: true });
  assert.equal(calls.length, 2);

  await assert.rejects(olderPick, { name: 'AbortError' });
  assert.equal(calls[0].signal.aborted, false, 'the download still holds course 3');

  calls[0].resolve({ id: 'three' });
  calls[1].resolve({ id: 'four' });
  assert.deepEqual(await background, { id: 'three' });
  assert.deepEqual(await newerPick, { id: 'four' });
});

test('a pick of the course being downloaded joins the download, and cancelling the download keeps it for the pick', async () => {
  const { coordinator, calls } = controllable();
  const download = new AbortController();
  const background = coordinator.acquire(course(5), { signal: download.signal });
  const pick = coordinator.acquire(course(5), { abortDifferent: true });
  assert.equal(calls.length, 1, 'the pick does not start the course again');

  download.abort();
  await assert.rejects(background, { name: 'AbortError' });
  assert.equal(calls[0].signal.aborted, false, 'the pick still wants it');

  calls[0].resolve({ id: 'five' });
  assert.deepEqual(await pick, { id: 'five' });
});

test('a pick still cancels the previous pick of another course when nothing else wants it', async () => {
  const { coordinator, calls } = controllable();
  const first = coordinator.acquire(course(6), { abortDifferent: true });
  const second = coordinator.acquire(course(7), { abortDifferent: true });
  assert.equal(calls[0].signal.aborted, true);
  await assert.rejects(first, { name: 'AbortError' });
  calls[1].resolve({ id: 'seven' });
  assert.deepEqual(await second, { id: 'seven' });
});

test('a caller with no signal is never cancelled by someone else picking another course', async () => {
  const { coordinator, calls } = controllable();
  const tool = coordinator.acquire(course(8));
  const pick = coordinator.acquire(course(9), { abortDifferent: true });
  assert.equal(calls[0].signal.aborted, false);
  calls[0].resolve({ id: 'eight' });
  calls[1].resolve({ id: 'nine' });
  assert.deepEqual(await Promise.all([tool, pick]), [{ id: 'eight' }, { id: 'nine' }]);
});

test('an already-aborted caller starts nothing and cancels nothing', async () => {
  const { coordinator, calls } = controllable();
  const earlier = coordinator.acquire(course(10), { abortDifferent: true });
  const gone = new AbortController();
  gone.abort(new Error('gone already'));
  await assert.rejects(coordinator.acquire(course(11), { signal: gone.signal, abortDifferent: true }), /gone already/);
  assert.equal(calls.length, 1, 'no acquisition started');
  assert.equal(calls[0].signal.aborted, false, 'the earlier pick was not cancelled');
  calls[0].resolve({ id: 'ten' });
  assert.deepEqual(await earlier, { id: 'ten' });
});

test('a caller signal carries no listener from the coordinator once its course settles', async () => {
  const { coordinator, calls } = controllable();
  const download = new AbortController();
  const ok = coordinator.acquire(course(12), { signal: download.signal });
  assert.equal(getEventListeners(download.signal, 'abort').length, 1);
  calls[0].resolve({ id: 'twelve' });
  await ok;
  assert.equal(getEventListeners(download.signal, 'abort').length, 0);

  const failing = coordinator.acquire(course(13), { signal: download.signal });
  calls[1].reject(new Error('Overpass down'));
  await assert.rejects(failing, /Overpass down/);
  assert.equal(getEventListeners(download.signal, 'abort').length, 0);
});

test('a failed acquisition reaches every caller, signal or not', async () => {
  const { coordinator, calls } = controllable();
  const download = new AbortController();
  const background = coordinator.acquire(course(14), { signal: download.signal });
  const pick = coordinator.acquire(course(14), { abortDifferent: true });
  const plain = coordinator.acquire(course(14));
  calls[0].reject(new Error('not a golf course'));
  for (const p of [background, pick, plain]) await assert.rejects(p, /not a golf course/);
});
