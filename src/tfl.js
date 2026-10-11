import { z } from 'zod';
import { journeyTime } from './time.js';

const location = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
export const journeyInput = z.object({
  from: location.describe('Origin: TfL stop ID, postcode, coordinates or place name. Prefer returned location IDs when available.'),
  to: location.describe('Destination: TfL stop ID, postcode, coordinates or place name.'),
  at: z.iso.datetime({ offset: true }).optional().describe('ISO date/time with explicit Z or UTC offset. Converted to Europe/London for TfL; seconds are rounded down to the minute. Omit only for departing now.'),
  timeIs: z.enum(['Departing', 'Arriving']).default('Departing'),
  preference: z.enum(['LeastTime', 'LeastInterchange', 'LeastWalking']).default('LeastTime'),
  walkingSpeed: z.enum(['Slow', 'Average', 'Fast']).default('Average'),
  maxWalkingMinutes: z.number().int().min(1).max(240).optional(),
}).strict().refine(x => x.timeIs !== 'Arriving' || x.at !== undefined, {
  message: 'An arrival deadline requires at with an explicit timezone offset.', path: ['at'],
});
export const statusInput = z.object({
  lineIds: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(60)).min(1).max(10)
    .describe('TfL line IDs, e.g. northern, jubilee, elizabeth, lioness. Returns all reported statuses for these lines.'),
}).strict();

export class TflError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const text = value => typeof value === 'string' ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const array = value => Array.isArray(value) ? value : [];

export function createTflClient(env, { fetcher = (...args) => fetch(...args), timeoutMs = 10000 } = {}) {
  return async function request(path, params = {}) {
    if (!env.TFL_API_KEY?.trim()) throw new TflError('not_configured', 'TfL access is not configured.');
    const url = new URL(path, 'https://api.tfl.gov.uk');
    for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, value);
    url.searchParams.set('app_key', env.TFL_API_KEY);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url.toString(), {
        headers: { Accept: 'application/json' }, signal: controller.signal, redirect: 'manual',
      });
      if (response.status === 429) throw new TflError('rate_limited', 'TfL rate limit reached. Try again later.');
      if (!response.ok && response.status !== 300) throw new TflError('upstream_error', 'TfL could not complete the request. Try again later.');
      const data = await response.json();
      if (!data || typeof data !== 'object') throw new TflError('invalid_response', 'TfL returned an unexpected response.');
      return { data, status: response.status, retrievedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof TflError) throw error;
      if (controller.signal.aborted) throw new TflError('timeout', 'TfL did not respond in time. Try again later.');
      // Never forward upstream bodies, URLs, credentials or transport errors.
      throw new TflError('unavailable', 'TfL data is unavailable or invalid. Try again later.');
    } finally { clearTimeout(timer); }
  };
}

function disruption(d) {
  return {
    category: text(d.category), type: text(d.type), description: text(d.description),
    summary: text(d.summary), closureText: text(d.closureText),
    additionalInfo: text(d.additionalInfo), created: text(d.created), lastUpdate: text(d.lastUpdate),
  };
}
function leg(l) {
  return {
    mode: text(l.mode?.id) ?? text(l.mode?.name), durationMinutes: number(l.duration),
    departureTime: text(l.departureTime), arrivalTime: text(l.arrivalTime),
    from: { name: text(l.departurePoint?.commonName), id: text(l.departurePoint?.naptanId) },
    to: { name: text(l.arrivalPoint?.commonName), id: text(l.arrivalPoint?.naptanId) },
    instruction: text(l.instruction?.summary),
    steps: array(l.instruction?.steps).map(s => ({ description: text(s.description), turnDirection: text(s.turnDirection) })),
    distanceMetres: number(l.distance), isDisrupted: boolean(l.isDisrupted),
    disruptions: array(l.disruptions).map(disruption),
    routeOptions: array(l.routeOptions).map(r => ({
      name: text(r.name), direction: text(r.direction),
      lineIds: [text(r.lineIdentifier?.id)].filter(Boolean),
    })),
    stops: array(l.path?.stopPoints).map(p => ({ name: text(p.name), id: text(p.id) })),
  };
}
function choices(d) {
  return array(d?.disambiguationOptions).map(o => ({
    parameterValue: text(o.parameterValue), name: text(o.place?.commonName),
    placeType: text(o.place?.placeType), matchQuality: number(o.matchQuality),
  }));
}

export async function planJourney(raw, request, now) {
  const input = journeyInput.parse(raw);
  let time;
  try { time = journeyTime(input.at, now); }
  catch (error) { throw new TflError('invalid_time', error.message); }
  const response = await request(`/Journey/JourneyResults/${encodeURIComponent(input.from)}/to/${encodeURIComponent(input.to)}`, {
    date: time.date, time: time.time, timeIs: input.timeIs,
    journeyPreference: input.preference, walkingSpeed: input.walkingSpeed,
    maxWalkingMinutes: input.maxWalkingMinutes,
  });
  const base = {
    source: 'TfL Unified API', retrievedAt: response.retrievedAt,
    timeZone: 'Europe/London', timestampMeaning: 'retrievedAt is retrieval time; journey times are TfL local timetable/planner values, not live departure predictions.',
    request: { ...input, ...time },
  };
  if (response.status === 300) {
    const from = choices(response.data.fromLocationDisambiguation);
    const to = choices(response.data.toLocationDisambiguation);
    if (!from.length && !to.length) throw new TflError('invalid_response', 'TfL requested location clarification but supplied no choices.');
    return { ...base, outcome: 'needs_disambiguation', choices: { from, to } };
  }
  if (!Array.isArray(response.data.journeys)) throw new TflError('invalid_response', 'TfL returned no valid journey result.');
  const journeys = response.data.journeys.map(j => {
    if (!j || !Array.isArray(j.legs) || !j.legs.length || !text(j.startDateTime) || !text(j.arrivalDateTime)
      || number(j.duration) === null || j.legs.some(l => !l || typeof l !== 'object')) {
      throw new TflError('invalid_response', 'TfL returned an incomplete journey.');
    }
    return {
      departureTime: j.startDateTime, arrivalTime: j.arrivalDateTime,
      durationMinutes: j.duration, legs: j.legs.map(leg)
    };
  });
  return { ...base, outcome: journeys.length ? 'journeys_found' : 'no_journeys', journeys };
}

export async function getLineStatus(raw, request) {
  const { lineIds } = statusInput.parse(raw);
  const ids = [...new Set(lineIds)];
  const response = await request(`/Line/${ids.map(encodeURIComponent).join(',')}/Status`);
  if (response.status !== 200 || !Array.isArray(response.data) || response.data.some(l => !l || !text(l.id) || !Array.isArray(l.lineStatuses))) {
    throw new TflError('invalid_response', 'TfL returned an invalid line status response.');
  }
  const lines = response.data.map(l => ({
    id: l.id, name: text(l.name), mode: text(l.modeName),
    statuses: l.lineStatuses.map(s => ({
      severity: number(s.statusSeverity), description: text(s.statusSeverityDescription),
      reason: text(s.reason), validityPeriods: array(s.validityPeriods).map(p => ({ from: text(p.fromDate), to: text(p.toDate), isNow: boolean(p.isNow) })),
      disruption: s.disruption ? disruption(s.disruption) : null,
    })),
  }));
  return {
    source: 'TfL Unified API', retrievedAt: response.retrievedAt,
    timestampMeaning: 'Retrieval time, not the time TfL last updated a status. Line-wide status does not establish that a particular branch or journey is unaffected.',
    lines, missingLineIds: ids.filter(id => !lines.some(l => l.id === id)),
  };
}
