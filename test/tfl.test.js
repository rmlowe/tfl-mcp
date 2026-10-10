import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journeyTime } from '../src/time.js';
import { createTflClient, planJourney, getLineStatus, journeyInput } from '../src/tfl.js';

const retrievedAt = '2026-10-10T20:00:00Z';
const journey = {
  startDateTime: '2026-10-12T08:00:00', arrivalDateTime: '2026-10-12T08:40:00', duration: 40,
  legs: [{ duration: 40, mode: { id: 'tube' }, departurePoint: { commonName: 'Mill Hill East', naptanId: 'origin' },
    arrivalPoint: { commonName: 'Bank', naptanId: 'destination' },
    instruction: { summary: 'Northern line via Bank', steps: [{ description: 'Change at Finchley Central' }] },
    routeOptions: [{ name: 'Northern', direction: 'southbound', lineIdentifier: [{ id: 'northern' }] }, { name: 'Alternative' }],
    disruptions: [{ description: 'Branch disruption', lastUpdate: '2026-10-10T19:00:00' }],
    path: { stopPoints: [{ name: 'Finchley Central', id: 'interchange' }] },
  }],
};
const args = { from: 'Mill Hill East', to: 'Bank', at: '2026-10-12T09:00:00+01:00', timeIs: 'Arriving' };
const response = data => ({ status: 200, retrievedAt, data });

test('London conversion covers summer, winter, UTC date rollover and spring transition', () => {
  for (const [iso, date, time] of [
    ['2026-07-01T08:30:00Z', '20260701', '0930'],
    ['2026-12-01T08:30:00Z', '20261201', '0830'],
    ['2026-07-01T23:30:00Z', '20260702', '0030'],
    ['2026-03-29T00:59:00Z', '20260329', '0059'],
    ['2026-03-29T01:00:00Z', '20260329', '0200'],
  ]) {
    const actual = journeyTime(iso);
    assert.equal(actual.date, date);
    assert.equal(actual.time, time);
  }
});

test('repeated autumn hour is rejected for both absolute instants', () => {
  for (const at of ['2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z']) {
    assert.throws(() => journeyTime(at), /occurs twice/);
  }
  assert.equal(journeyTime('2026-10-25T02:30:00Z').time, '0230');
});

test('arrival requests map to documented TfL parameters and preserve evidence', async () => {
  const result = await planJourney({ ...args, preference: 'LeastWalking' }, async (path, params) => {
    assert.match(path, /Mill%20Hill%20East\/to\/Bank$/);
    assert.equal(params.journeyPreference, 'LeastWalking');
    assert.equal(params.routePreference, undefined);
    assert.equal(params.time, '0900');
    assert.equal(params.date, '20261012');
    assert.equal(params.timeIs, 'Arriving');
    return response({ journeys: [journey] });
  });
  const leg = result.journeys[0].legs[0];
  assert.equal(result.retrievedAt, retrievedAt);
  assert.equal(leg.routeOptions.length, 2);
  assert.equal(leg.disruptions[0].description, 'Branch disruption');
  assert.equal(leg.isDisrupted, null);
  assert.equal(leg.stops[0].name, 'Finchley Central');
  assert.equal(leg.steps[0].description, 'Change at Finchley Central');
});

test('departing now uses one fixed instant; deadlines and invalid inputs are validated', async () => {
  const r = await planJourney({ from: 'A', to: 'B' }, async (_p, params) => {
    assert.equal(params.time, '0900');
    return response({ journeys: [] });
  }, new Date('2026-07-01T08:00:59Z'));
  assert.equal(r.outcome, 'no_journeys');
  for (const changes of [{ at: undefined }, { at: '2026-10-12T09:00:00' }, { at: '2026-02-30T09:00:00Z' },
    { at: 'now' }, { maxWalkingMinutes: -1 }, { preference: 'Time' }, { from: '' }, { other: true }]) {
    assert.equal(journeyInput.safeParse({ ...args, ...changes }).success, false);
  }
});

test('ambiguous locations return choices without guessing', async () => {
  const r = await planJourney(args, async () => ({ status: 300, retrievedAt, data: {
    fromLocationDisambiguation: { disambiguationOptions: [
      { parameterValue: '1', place: { commonName: 'Station A' }, matchQuality: 99 },
      { parameterValue: '2', place: { commonName: 'Station B' }, matchQuality: 98 },
    ] },
  } }));
  assert.equal(r.outcome, 'needs_disambiguation');
  assert.deepEqual(r.choices.from.map(x => x.parameterValue), ['1', '2']);
  assert.equal(r.journeys, undefined);
});

test('malformed upstream journey results cannot become empty successes', async () => {
  for (const data of [{}, { journeys: null }, { journeys: [{}] }, { journeys: [{ ...journey, legs: [null] }] }]) {
    await assert.rejects(planJourney(args, async () => response(data)), /TfL returned/);
  }
});

test('line statuses preserve multiple disruptions, validity and missing lines', async () => {
  const r = await getLineStatus({ lineIds: ['northern', 'jubilee', 'northern'] }, async path => {
    assert.equal(path, '/Line/northern,jubilee/Status');
    return response([{ id: 'northern', name: 'Northern', lineStatuses: [
      { statusSeverity: 10, statusSeverityDescription: 'Good Service' },
      { statusSeverity: 3, reason: 'Branch closure', validityPeriods: [{ isNow: true }], disruption: { description: 'Closure details' } },
    ] }]);
  });
  assert.equal(r.lines[0].statuses.length, 2);
  assert.equal(r.lines[0].statuses[1].disruption.description, 'Closure details');
  assert.deepEqual(r.missingLineIds, ['jubilee']);
  const empty = await getLineStatus({ lineIds: ['northern'] }, async () => response([]));
  assert.deepEqual(empty.missingLineIds, ['northern']);
});

test('client authenticates only to TfL, disables redirects, and records retrieval time', async () => {
  const client = createTflClient({ TFL_API_KEY: 'test-secret' }, { fetcher: async (url, init) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.tfl.gov.uk');
    assert.equal(u.searchParams.get('app_key'), 'test-secret');
    assert.equal(init.redirect, 'error');
    return Response.json({ journeys: [] });
  } });
  const r = await client('/Journey/JourneyResults/A/to/B');
  assert.ok(Number.isFinite(Date.parse(r.retrievedAt)));
  assert.doesNotMatch(JSON.stringify(r), /test-secret/);
});

test('client distinguishes rate limits and sanitizes errors and invalid JSON', async () => {
  for (const [fetcher, code] of [
    [async () => new Response('secret details', { status: 429 }), 'rate_limited'],
    [async () => new Response('secret details', { status: 500 }), 'upstream_error'],
    [async () => new Response('secret details'), 'unavailable'],
    [async () => { throw new Error('secret details'); }, 'unavailable'],
  ]) {
    await assert.rejects(createTflClient({ TFL_API_KEY: 'key' }, { fetcher })('/test'), e => {
      assert.equal(e.code, code); assert.doesNotMatch(e.message, /secret/); return true;
    });
  }
  await assert.rejects(createTflClient({})('/test'), { code: 'not_configured' });
});

test('upstream timeout aborts a stalled request', async () => {
  const client = createTflClient({ TFL_API_KEY: 'key' }, { timeoutMs: 5,
    fetcher: (_u, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
  });
  await assert.rejects(client('/test'), { code: 'timeout' });
});
