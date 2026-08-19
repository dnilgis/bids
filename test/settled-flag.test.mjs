/* The settled-flag truncation, 2026-08-19.
 *
 * Their futures cell gains a trailing "s" once the contract settles
 * ("513-6s"). parseTicks did not allow for it, fell through to parseNum,
 * whose regex is not end-anchored, and got 513 -- silently dropping six
 * eighths. Two Mar 27 rows failed the identity check, the reader refused a
 * correct board every ten minutes, and the feed froze.
 *
 * The fixture is the real page, captured after the 1:20pm settle. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseTicks, tickFlag, extractBids } from '../lib/parse.mjs';
import { buildFile, TORN_MAX_CENTS } from '../lib/board.mjs';

const HTML = fs.readFileSync(new URL('../fixtures/bigriver-2121-settled.html', import.meta.url), 'utf8');
const rows = () => extractBids(HTML, 'test');
const implied = (b) => Math.round((b.cash - b.basis) * 10000) / 100;
const offBy = (b) => Math.round((implied(b) - b.futuresPrice) * 100) / 100;

test('a settled quote keeps its eighths', () => {
  assert.equal(parseTicks('513-6s'), 513.75);
  assert.equal(parseTicks('512-4s'), 512.5);
  assert.equal(parseTicks('471-6s'), 471.75);
});

test('an unsettled quote is unchanged', () => {
  assert.equal(parseTicks('513-6'), 513.75);
  assert.equal(parseTicks('459-4'), 459.5);
  assert.equal(parseTicks('+9-6'), 9.75);
});

test('a whole-cent settle still parses -- the case that hid the bug', () => {
  // These were right all along, which is exactly why nobody saw it: the
  // truncation is a no-op when the fraction is zero.
  assert.equal(parseTicks('473-0s'), 473);
  assert.equal(parseTicks('498-0s'), 498);
  assert.equal(parseTicks('473-0'), 473);
});

test('a fraction outside the eighths grid is refused, not guessed', () => {
  assert.equal(parseTicks('513-9s'), null);
  assert.equal(parseTicks('513-12'), null);
});

test('tick-shaped but unparsed returns null instead of a truncated number', () => {
  // The precise failure mode: parseNum would have returned 513 for all of these.
  assert.equal(parseTicks('513-6x9'), null);
  assert.equal(parseTicks('513-6 7'), null);
});

test('plain numbers and junk are untouched', () => {
  assert.equal(parseTicks('4.2100'), 4.21);
  assert.equal(parseTicks('-0.5200'), -0.52);
  assert.equal(parseTicks('abc'), null);
  assert.equal(parseTicks(null), null);
});

test('tickFlag reports the settle letter and nothing else', () => {
  assert.equal(tickFlag('513-6s'), 's');
  assert.equal(tickFlag('513-6'), null);
  assert.equal(tickFlag('4.21'), null);
});

test('the board that was refused now balances on every row', () => {
  const bs = rows();
  assert.equal(bs.length, 7, 'seven corn rows');
  for (const b of bs)
    assert.ok(Math.abs(offBy(b)) <= TORN_MAX_CENTS,
      `${b.delivery} out by ${offBy(b)}c (cash ${b.cash}, basis ${b.basis}, futures ${b.futuresPrice})`);
});

test('the two rows that failed read 513.75, not 513', () => {
  const mar = rows().filter((b) => /Mar 27/.test(b.futures || ''));
  assert.equal(mar.length, 2);
  for (const b of mar) assert.equal(b.futuresPrice, 513.75);
});

test('every row on this capture is flagged settled', () => {
  for (const b of rows()) assert.equal(b.futuresFlag, 's');
});

test('the settle flag is NOT published -- it would fake a daily price change', () => {
  const { file } = buildFile(HTML, { now: new Date('2026-08-19T20:39:27Z'), sourceUrl: 'test' });
  assert.equal(file.status, 'ok');
  assert.equal(file.count, 7, 'all seven rows publish');
  assert.ok(!/futuresFlag/.test(JSON.stringify(file)), 'futuresFlag must not reach the published file');
  const mar = file.bids.filter((b) => b.futuresMonth === 'Mar 27');
  assert.equal(mar.length, 2);
  for (const b of mar) assert.equal(b.futuresPriceCents, 513.75, 'the eighths survive into the published file');
});

test('MUTATION: the old regex reproduces the incident exactly', () => {
  // Restore the pre-fix behaviour and confirm this suite would have caught it:
  // two rows fail, and they are the Mar 27 pair.
  const old = (text) => {
    if (text == null) return null;
    const t = String(text).trim();
    const m = t.match(/^([+-]?)(\d+)-(\d+)$/);
    if (m) {
      const v = parseInt(m[2], 10) + parseInt(m[3], 10) / 8;
      return m[1] === '-' ? -v : v;
    }
    // parseNum's un-anchored fallback
    const n = t.replace(/[$,\s]/g, '').match(/^([+-]?)(\d*\.?\d+)/);
    return n ? (n[1] === '-' ? -parseFloat(n[2]) : parseFloat(n[2])) : null;
  };
  assert.equal(old('513-6s'), 513, 'the old code truncated');
  assert.equal(old('473-0s'), 473, 'and was correct by luck on whole cents');

  const broken = rows().map((b) => ({ ...b, futuresPrice: old(`${b.futures ? '' : ''}${b.futuresPrice === 513.75 ? '513-6s' : b.futuresPrice === 473 ? '473-0s' : '498-0s'}`) }));
  const failing = broken.filter((b) => Math.abs(Math.round((implied(b) - b.futuresPrice) * 100) / 100) > TORN_MAX_CENTS);
  assert.equal(failing.length, 2, 'exactly two rows fail under the old parser');
  assert.ok(failing.every((b) => /Mar 27/.test(b.futures || '')), 'and they are the Mar 27 pair');
});
