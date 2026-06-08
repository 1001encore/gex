import assert from 'node:assert/strict';
import { getDateStr, getMarketStatus, getStorageKey } from '../src/lib';
import {
  normalizeDate,
  normalizeDays,
  normalizeExpirations,
  normalizeInterval,
  normalizeMode,
  normalizeTicker,
  validateChartPayload,
} from '../src/index';

const TZ = 'America/New_York';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test('market is closed one minute before New York open during DST', () => {
  assert.deepEqual(getMarketStatus(TZ, new Date('2026-06-08T13:29:00Z')), {
    mkt_hours: 'mkt_closed',
    mins_passed: -1,
  });
});

test('market opens at 9:30 New York time during DST', () => {
  assert.deepEqual(getMarketStatus(TZ, new Date('2026-06-08T13:30:00Z')), {
    mkt_hours: 'mkt_open',
    mins_passed: 0,
  });
});

test('market closes at 16:00 New York time during DST', () => {
  assert.deepEqual(getMarketStatus(TZ, new Date('2026-06-08T20:00:00Z')), {
    mkt_hours: 'mkt_closed',
    mins_passed: 390,
  });
});

test('market opens at 9:30 New York time outside DST', () => {
  assert.deepEqual(getMarketStatus(TZ, new Date('2026-01-05T14:30:00Z')), {
    mkt_hours: 'mkt_open',
    mins_passed: 0,
  });
});

test('weekends are closed even during regular clock hours', () => {
  assert.equal(getMarketStatus(TZ, new Date('2026-06-06T15:00:00Z')).mkt_hours, 'mkt_closed');
});

test('storage key uses ticker and New York trading date', () => {
  assert.deepEqual(getStorageKey('spy', TZ, new Date('2026-06-08T13:30:00Z')), {
    key: 'data_gex_SPY_2026-06-08_mkt_open',
    session: 'mkt_open',
  });
  assert.deepEqual(getStorageKey('spy', TZ, new Date('2026-06-08T13:30:00Z'), 'vex'), {
    key: 'data_vex_SPY_2026-06-08_mkt_open',
    session: 'mkt_open',
  });
});

test('date helper is stable across timezone boundaries', () => {
  assert.equal(getDateStr(0, TZ, new Date('2026-06-09T03:30:00Z')), '2026-06-08');
  assert.equal(getDateStr(1, TZ, new Date('2026-06-09T03:30:00Z')), '2026-06-07');
});

test('request normalizers accept expected values', () => {
  assert.equal(normalizeTicker(' spy '), 'SPY');
  assert.equal(normalizeTicker('brk-b'), 'BRK-B');
  assert.equal(normalizeDays('3'), 3);
  assert.equal(normalizeExpirations('6'), 6);
  assert.equal(normalizeMode('VEX'), 'vex');
  assert.equal(normalizeInterval('15m'), '15m');
  assert.equal(normalizeDate('2026-06-08'), '2026-06-08');
});

test('request normalizers reject malformed values', () => {
  assert.throws(() => normalizeTicker('SPY;DROP'), /Invalid ticker/);
  assert.throws(() => normalizeDays('0'), /Invalid days/);
  assert.throws(() => normalizeDays('11'), /Invalid days/);
  assert.throws(() => normalizeExpirations('0'), /Invalid expirations/);
  assert.throws(() => normalizeExpirations('31'), /Invalid expirations/);
  assert.throws(() => normalizeMode('delta'), /Invalid mode/);
  assert.throws(() => normalizeInterval('3m'), /Invalid interval/);
  assert.throws(() => normalizeDate('06-08-2026'), /Invalid date/);
  assert.throws(() => normalizeDate('2026-02-30'), /Invalid date/);
});

test('chart diagnostics accept a structurally valid payload', () => {
  const diagnostics = validateChartPayload({
    date: '2026-06-08',
    dates: ['2026-06-07', '2026-06-08'],
    heatmapTrace: {
      x: [390, 385, 390, 0],
      y: [610, 605],
      z: [
        [1, 2, 3, 4],
        [-1, -2, -3, -4],
      ],
    },
    limits: { down: 590, up: 620 },
    spot: 604.5,
    sessionMarkers: [],
    daySegments: [
      { date: '2026-06-07', start: 0, end: 1 },
      { date: '2026-06-08', start: 2, end: 3 },
    ],
  });

  assert.equal(diagnostics.ok, true);
});

test('chart diagnostics catch dirty MTE ordering and matrix shape bugs', () => {
  const diagnostics = validateChartPayload({
    date: '2026-06-08',
    heatmapTrace: {
      x: [385, 390, 384],
      y: [610, 605],
      z: [
        [1, 2],
        [-1, -2, -3],
      ],
    },
    limits: { down: 620, up: 590 },
    spot: 0,
    sessionMarkers: [],
  });

  assert.equal(diagnostics.ok, false);
  assert.match(diagnostics.issues.join('\n'), /does not match x length/);
  assert.match(diagnostics.issues.join('\n'), /not monotonically descending/);
  assert.match(diagnostics.issues.join('\n'), /spot is missing or invalid/);
  assert.match(diagnostics.issues.join('\n'), /limit down is not below limit up/);
});
