// src/index.ts

/// <reference types="@cloudflare/workers-types" />

import {
  DurableObjectNamespace,
  ExecutionContext,
  ScheduledController,
  DurableObjectState,
  DurableObject,
} from '@cloudflare/workers-types';

import {
  calc_exposure,
  ExposureMode,
  getMteList,
  getMarketStatus,
  getChartLimits,
  makeCS,
  getStorageKey,
  getDateStr,
} from './lib';

// --- CONSTANTS ---
const APP_TIMEZONE = 'America/New_York';
const DAYS_OF_DATA_TO_KEEP = 20;
const TICKER = 'SPY';
const SCHEDULED_TICKERS = ['SPY', 'QQQ', '^SPX'];

// --- INTERFACES ---
interface SessionData {
  y_strikes: number[];
  strips: number[][];
  mtes: number[];
  limits: { up: number; down: number };
  spot: number;
  future_x_mte: number[];
  future_z_values: number[][];
}

interface NewStripData {
  ticker: string;
  mode?: ExposureMode;
  historicalStrip: {
    x_mte: number;
    z_strip: number[];
  };
  futureMap: {
    x_mte: number[];
    y_strikes: number[];
    z_values: number[][];
  };
  limits: { up: number; down: number };
  spot: number;
}

interface ChartPayload {
  date: string;
  dates?: string[];
  mode?: ExposureMode;
  heatmapTrace: {
    x: number[];
    y: number[];
    z: number[][];
  };
  limits: { up: number; down: number };
  spot: number;
  sessionMarkers: { x: number; label: string; date?: string }[];
  daySegments?: { date: string; start: number; end: number }[];
}

export function normalizeTicker(input: string | null): string {
  const ticker = (input || TICKER).trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,12}$/.test(ticker)) {
    throw new Error('Invalid ticker');
  }
  return ticker;
}

export function normalizeInterval(input: string | null): '1m' | '2m' | '5m' | '15m' | '30m' {
  const interval = input || '5m';
  if (!['1m', '2m', '5m', '15m', '30m'].includes(interval)) {
    throw new Error('Invalid interval');
  }
  return interval as '1m' | '2m' | '5m' | '15m' | '30m';
}

export function normalizeDate(input: string | null): string | null {
  if (!input) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error('Invalid date');
  }
  const parsed = new Date(`${input}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) {
    throw new Error('Invalid date');
  }
  return input;
}

export function normalizeDays(input: string | null): number {
  const days = Number(input || '1');
  if (!Number.isInteger(days) || days < 1 || days > 10) {
    throw new Error('Invalid days');
  }
  return days;
}

export function normalizeExpirations(input: string | null): number {
  const expirations = Number(input || '3');
  if (!Number.isInteger(expirations) || expirations < 1 || expirations > 12) {
    throw new Error('Invalid expirations');
  }
  return expirations;
}

export function normalizeMode(input: string | null): ExposureMode {
  const mode = (input || 'gex').toLowerCase();
  if (mode !== 'gex' && mode !== 'vex') {
    throw new Error('Invalid mode');
  }
  return mode;
}

function storagePrefix(ticker: string, mode: ExposureMode): string {
  return `data_${mode}_${ticker}_`;
}

function legacyStoragePrefix(ticker: string): string {
  return `data_${ticker}_`;
}

function getDateFromStorageKey(key: string, ticker: string, mode: ExposureMode): string | null {
  if (key.startsWith(storagePrefix(ticker, mode))) return key.split('_')[3] || null;
  if (mode === 'gex' && key.startsWith(legacyStoragePrefix(ticker))) return key.split('_')[2] || null;
  return null;
}

function keyMatchesDate(key: string, ticker: string, mode: ExposureMode, date: string): boolean {
  return key.startsWith(`${storagePrefix(ticker, mode)}${date}_`)
    || (mode === 'gex' && key.startsWith(`${legacyStoragePrefix(ticker)}${date}_`));
}

export function validateChartPayload(payload: ChartPayload) {
  const x = payload.heatmapTrace?.x || [];
  const y = payload.heatmapTrace?.y || [];
  const z = payload.heatmapTrace?.z || [];
  const issues: string[] = [];

  if (x.length === 0) issues.push('heatmap x-axis is empty');
  if (y.length === 0) issues.push('heatmap y-axis is empty');
  if (z.length !== y.length) issues.push(`z row count ${z.length} does not match y length ${y.length}`);

  for (let rowIndex = 0; rowIndex < z.length; rowIndex++) {
    const row = z[rowIndex] || [];
    if (row.length !== x.length) {
      issues.push(`z row ${rowIndex} length ${row.length} does not match x length ${x.length}`);
      break;
    }
    if (row.some((value) => !Number.isFinite(value))) {
      issues.push(`z row ${rowIndex} contains non-finite values`);
      break;
    }
  }

  if (x.some((value) => !Number.isFinite(value))) issues.push('x-axis contains non-finite values');
  if (y.some((value) => !Number.isFinite(value))) issues.push('y-axis contains non-finite values');
  if (!Number.isFinite(payload.spot) || payload.spot <= 0) issues.push('spot is missing or invalid');
  if (!Number.isFinite(payload.limits?.up) || !Number.isFinite(payload.limits?.down)) {
    issues.push('limits are missing or invalid');
  } else if (payload.limits.down >= payload.limits.up) {
    issues.push('limit down is not below limit up');
  }

  const segments = payload.daySegments?.length
    ? payload.daySegments
    : [{ date: payload.date, start: 0, end: x.length - 1 }];

  for (const segment of segments) {
    const segmentX = x.slice(segment.start, segment.end + 1);
    const duplicateX = segmentX.filter((value, index) => segmentX.indexOf(value) !== index);
    if (duplicateX.length > 0) issues.push(`x-axis contains duplicate MTE buckets for ${segment.date}`);

    const xMonotonic = segmentX.every((value, index) => index === 0 || value <= segmentX[index - 1]);
    if (!xMonotonic) issues.push(`x-axis MTE values are not monotonically descending for ${segment.date}`);
  }

  const yDescending = y.every((value, index) => index === 0 || value <= y[index - 1]);
  if (!yDescending) issues.push('y-axis strikes are not monotonically descending');

  return {
    ok: issues.length === 0,
    issues,
    summary: {
      date: payload.date,
      xBuckets: x.length,
      strikes: y.length,
      sessionMarkers: payload.sessionMarkers?.length || 0,
      days: payload.dates?.length || payload.daySegments?.length || 1,
      spot: payload.spot,
      limits: payload.limits,
    },
  };
}

export function summarizeConfluence(payload: ChartPayload) {
  const x = payload.heatmapTrace?.x || [];
  const y = payload.heatmapTrace?.y || [];
  const z = payload.heatmapTrace?.z || [];
  const latestIndex = payload.daySegments?.length
    ? payload.daySegments[payload.daySegments.length - 1].end
    : x.length - 1;
  const spot = payload.spot;
  const nodes = y.map((strike, rowIndex) => {
    const value = z[rowIndex]?.[latestIndex] || 0;
    return { strike, value, abs: Math.abs(value) };
  }).sort((a, b) => b.abs - a.abs);
  const king = nodes[0] || null;
  const floor = nodes.filter((node) => node.strike < spot).sort((a, b) => b.abs - a.abs)[0] || null;
  const ceiling = nodes.filter((node) => node.strike > spot).sort((a, b) => b.abs - a.abs)[0] || null;
  const upsideMass = nodes.filter((node) => node.strike > spot).reduce((sum, node) => sum + node.abs, 0);
  const downsideMass = nodes.filter((node) => node.strike < spot).reduce((sum, node) => sum + node.abs, 0);
  const bias = upsideMass > downsideMass * 1.15
    ? 'upside'
    : downsideMass > upsideMass * 1.15
      ? 'downside'
      : 'balanced';

  return {
    date: payload.date,
    mode: payload.mode || 'gex',
    spot,
    king,
    floor,
    ceiling,
    bias,
    upsideMass,
    downsideMass,
  };
}

function isAuthorizedCron(request: Request, env: Env): boolean {
  if (!env.ADMIN_SECRET) return false;
  const url = new URL(request.url);
  const authHeader = request.headers.get('Authorization') || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';
  const headerSecret = request.headers.get('X-Admin-Secret') || '';
  const querySecret = url.searchParams.get('secret') || '';
  return [bearer, headerSecret, querySecret].includes(env.ADMIN_SECRET);
}

// --- 1. THE DURABLE OBJECT ---
export class HeatmapBuilderDO implements DurableObject {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // In backend/src/index.ts (Inside HeatmapBuilderDO class)

    if (request.method === 'POST' && url.pathname === '/api/v1/addStrip') {
      const newData = (await request.json()) as NewStripData;
      const ticker = normalizeTicker(newData.ticker);
      const mode = normalizeMode(newData.mode || 'gex');
      const { key } = getStorageKey(ticker, APP_TIMEZONE, new Date(), mode);

      let sessionData: SessionData = (await this.state.storage.get(key)) || {
        y_strikes: newData.futureMap.y_strikes, // Initialize with FIRST strip's strikes
        strips: [],
        mtes: [],
        limits: newData.limits,
        spot: newData.spot,
        future_x_mte: [],
        future_z_values: []
      };

      // --- ALIGNMENT LOGIC START ---
      const incomingStrikes = newData.futureMap.y_strikes; // Strikes from the new data
      const incomingValues = newData.historicalStrip.z_strip; // Values to save

      // 1. Create a blank strip matching the SESSION'S y-axis (filled with 0s)
      const alignedStrip = new Array(sessionData.y_strikes.length).fill(0);

      // 2. Map the new data into the correct slots
      for (let i = 0; i < incomingStrikes.length; i++) {
        const strike = incomingStrikes[i];
        const val = incomingValues[i];

        // Where does this strike live in our saved session history?
        const sessionIndex = sessionData.y_strikes.indexOf(strike);

        // If it exists in our history, save the value. If not, it's dropped (or you could expand the axis, but dropping is safer for now)
        if (sessionIndex !== -1) {
          alignedStrip[sessionIndex] = val;
        }
      }
      // --- ALIGNMENT LOGIC END ---

      // Prevent Duplicates
      const newMte = newData.historicalStrip.x_mte;
      if (sessionData.mtes.length > 0 && sessionData.mtes[0] === newMte) {
        return new Response('OK (Duplicate skipped)');
      }

      // Prepend the ALIGNED strip
      sessionData.strips.unshift(alignedStrip);
      sessionData.mtes.unshift(newMte);

      // Update limits and spot
      sessionData.limits = newData.limits;
      sessionData.spot = newData.spot;

      // Overwrite the future map (User confirmed this doesn't need alignment)
      sessionData.future_x_mte = newData.futureMap.x_mte;
      sessionData.future_z_values = newData.futureMap.z_values;

      await this.state.storage.put(key, sessionData);
      return new Response('OK');
    }

    // --- ROUTE B: Get Chart Data (Filtered by Date) ---
    if (request.method === 'GET' && url.pathname === '/api/v1/getChartData') {
      const requestedDate = url.searchParams.get('date'); // YYYY-MM-DD
      const ticker = normalizeTicker(url.searchParams.get('ticker'));
      const mode = normalizeMode(url.searchParams.get('mode'));
      const targetRequestedDate = normalizeDate(requestedDate);
      const days = normalizeDays(url.searchParams.get('days'));
      const includeFuture = url.searchParams.get('includeFuture') !== 'false';

      // 1. Fetch ALL keys first to find available dates
      // (Optimization: We could list with prefix if we knew the date, 
      // but listing all keys for 3 days of data is very cheap/fast)
      const listMap = await this.state.storage.list<SessionData>({
        prefix: storagePrefix(ticker, mode),
      });
      if (mode === 'gex') {
        const legacyMap = await this.state.storage.list<SessionData>({
          prefix: legacyStoragePrefix(ticker),
        });
        for (const [key, value] of legacyMap) listMap.set(key, value);
      }

      if (listMap.size === 0) {
        return new Response(JSON.stringify({ error: 'No data available' }), { status: 404 });
      }

      // 2. Determine which date to show
      // Extract unique dates from keys: data_SPY_2023-10-25_mkt_open
      const allKeys = Array.from(listMap.keys()).sort();
      const uniqueDates = [...new Set(allKeys.map(k => getDateFromStorageKey(k, ticker, mode)).filter(Boolean) as string[])].sort();

      // Default to the latest available date, then include the requested trailing window.
      const endDate = targetRequestedDate || uniqueDates[uniqueDates.length - 1];
      const endDateIndex = uniqueDates.indexOf(endDate);
      if (endDateIndex === -1) {
        return new Response(JSON.stringify({ error: 'No data for date' }), { status: 404 });
      }
      const targetDates = uniqueDates.slice(Math.max(0, endDateIndex - days + 1), endDateIndex + 1);

      // 3. Filter keys for the requested date window
      const keysForWindow = allKeys.filter((key) =>
        targetDates.some((date) => keyMatchesDate(key, ticker, mode, date))
      );

      if (keysForWindow.length === 0) {
        return new Response(JSON.stringify({ error: 'No data for date' }), { status: 404 });
      }

      const y_strikes = Array.from(new Set(
        keysForWindow.flatMap((key) => listMap.get(key)?.y_strikes || [])
      )).sort((a, b) => b - a);

      const combined_x_mte: number[] = [];
      const combined_z_values: number[][] = y_strikes.map(() => []);
      const sessionMarkers: { x: number; label: string; date?: string }[] = [];
      const daySegments: { date: string; start: number; end: number }[] = [];

      let lastKnownSpot = 0;
      let lastKnownLimits = { up: 0, down: 0 };
      let latestSession: { date: string; data: SessionData } | null = null;

      // 4. Stitch sessions, preserving day boundaries for the table renderer.
      for (const date of targetDates) {
        const dayStart = combined_x_mte.length;
        const keysForDate = allKeys.filter((key) => keyMatchesDate(key, ticker, mode, date));

        for (const key of keysForDate) {
          const sessionData = listMap.get(key);
          if (!sessionData || !sessionData.mtes) continue;

          const sessionName = key.split('_').pop() || 'session';

          // Only add marker if we are appending a second session or day.
          if (combined_x_mte.length > 0) {
            sessionMarkers.push({
              x: combined_x_mte[combined_x_mte.length - 1],
              label: sessionName,
              date,
            });
          }

          const historicalPairs = sessionData.mtes
            .map((mte, index) => ({ mte, strip: sessionData.strips[index] }))
            .filter((pair) => pair.strip)
            .sort((a, b) => b.mte - a.mte);

          combined_x_mte.push(...historicalPairs.map((pair) => pair.mte));

          for (let i = 0; i < y_strikes.length; i++) {
            const strike = y_strikes[i];
            const sessionStrikeIndex = sessionData.y_strikes.indexOf(strike);
            for (const { strip } of historicalPairs) {
              combined_z_values[i].push(sessionStrikeIndex === -1 ? 0 : strip[sessionStrikeIndex] || 0);
            }
          }
          latestSession = { date, data: sessionData };
        }

        if (combined_x_mte.length > dayStart) {
          daySegments.push({ date, start: dayStart, end: combined_x_mte.length - 1 });
        }
      }

      if (latestSession) {
        lastKnownSpot = latestSession.data.spot;
        lastKnownLimits = latestSession.data.limits;
      }

      // 5. Append future projection only to the final selected day when requested.
      if (includeFuture && latestSession && latestSession.data.future_x_mte && latestSession.data.future_x_mte.length > 0) {
        const activeSegment = daySegments[daySegments.length - 1];
        combined_x_mte.push(...latestSession.data.future_x_mte);
        for (let i = 0; i < y_strikes.length; i++) {
          const strike = y_strikes[i];
          const sessionStrikeIndex = latestSession.data.y_strikes.indexOf(strike);
          const futureRow = sessionStrikeIndex === -1 ? [] : latestSession.data.future_z_values[sessionStrikeIndex] || [];
          combined_z_values[i].push(...latestSession.data.future_x_mte.map((_, index) => futureRow[index] || 0));
        }
        if (activeSegment && latestSession.date === activeSegment.date) {
          activeSegment.end = combined_x_mte.length - 1;
        }
      }

      const payload = {
        date: endDate,
        dates: targetDates,
        mode,
        heatmapTrace: {
          type: 'heatmap',
          x: combined_x_mte,
          y: y_strikes,
          z: combined_z_values,
          colorscale: 'Edge',
          zmid: 0,
          zsmooth: 'best',
        },
        limits: lastKnownLimits,
        spot: lastKnownSpot,
        sessionMarkers: sessionMarkers,
        daySegments,
      };

      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- ROUTE E: Get Available Dates (For Dropdown) ---
    if (request.method === 'GET' && url.pathname === '/api/v1/getAvailableDates') {
      const ticker = normalizeTicker(url.searchParams.get('ticker'));
      const mode = normalizeMode(url.searchParams.get('mode'));
      const listMap = await this.state.storage.list({ prefix: storagePrefix(ticker, mode) });
      if (mode === 'gex') {
        const legacyMap = await this.state.storage.list({ prefix: legacyStoragePrefix(ticker) });
        for (const [key, value] of legacyMap) listMap.set(key, value);
      }
      const allKeys = Array.from(listMap.keys());
      // Extract "2023-10-25" from "data_SPY_2023-10-25_mkt_open"
      const uniqueDates = [...new Set(allKeys.map(k => getDateFromStorageKey(k, ticker, mode)).filter(Boolean) as string[])].sort();

      return new Response(JSON.stringify(uniqueDates), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- ROUTE C: Smart Atomic Deletion ---
    if (request.method === 'POST' && url.pathname === '/api/v1/deleteOldData') {
      const ticker = normalizeTicker(url.searchParams.get('ticker'));
      const mode = normalizeMode(url.searchParams.get('mode'));
      const listMap = await this.state.storage.list<SessionData>({
        prefix: storagePrefix(ticker, mode),
      });
      if (mode === 'gex') {
        const legacyMap = await this.state.storage.list<SessionData>({
          prefix: legacyStoragePrefix(ticker),
        });
        for (const [key, value] of legacyMap) listMap.set(key, value);
      }

      const keysToDelete: string[] = [];
      const now = new Date();
      const cutoffTime = now.getTime() - (DAYS_OF_DATA_TO_KEEP * 24 * 60 * 60 * 1000);

      for (const key of listMap.keys()) {
        const dateStr = getDateFromStorageKey(key, ticker, mode);
        if (!dateStr) continue;
        const keyDate = new Date(dateStr);
        if (isNaN(keyDate.getTime()) || keyDate.getTime() < cutoffTime) {
          keysToDelete.push(key);
        }
      }

      if (keysToDelete.length > 0) {
        await this.state.storage.delete(keysToDelete);
        return new Response(`Deleted: ${keysToDelete.join(', ')}`);
      }
      return new Response('No old data to delete.');
    }

    return new Response('Not found', { status: 404 });
  }
}

// --- 2. THE WORKER ---
export interface Env {
  GEX_HISTORY_DO: DurableObjectNamespace;
  ADMIN_SECRET: string;
}

const ALLOWED_ORIGIN = "https://1001encore.github.io";
function addCORSHeaders(response: Response): Response {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  newResponse.headers.append("Vary", "Origin");
  return newResponse;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Admin-Secret",
        },
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/__cron') {
        if (!isAuthorizedCron(request, env)) {
          return addCORSHeaders(new Response('Unauthorized', { status: 401 }));
        }
        await this.scheduled(null, env, ctx);
        return addCORSHeaders(new Response('Cron Ran'));
      }

      if (url.pathname === '/api/get-gamma-api') {
        const ticker = normalizeTicker(url.searchParams.get('ticker'));
        const mode = normalizeMode(url.searchParams.get('mode'));
        const requestedDate = normalizeDate(url.searchParams.get('date'));
        const days = normalizeDays(url.searchParams.get('days'));

        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);

        // Pass the date query to the DO
        const includeFuture = url.searchParams.get('includeFuture');
        let doUrl = `https://dummy/api/v1/getChartData?ticker=${encodeURIComponent(ticker)}&mode=${mode}&days=${days}`;
        if (requestedDate) doUrl += `&date=${requestedDate}`;
        if (includeFuture === 'false') doUrl += '&includeFuture=false';

        return addCORSHeaders(await stub.fetch(doUrl));
      }

      if (url.pathname === '/api/diagnostics') {
        const ticker = normalizeTicker(url.searchParams.get('ticker'));
        const mode = normalizeMode(url.searchParams.get('mode'));
        const requestedDate = normalizeDate(url.searchParams.get('date'));
        const days = normalizeDays(url.searchParams.get('days'));

        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        let doUrl = `https://dummy/api/v1/getChartData?ticker=${encodeURIComponent(ticker)}&mode=${mode}&days=${days}`;
        if (requestedDate) doUrl += `&date=${requestedDate}`;

        const chartResponse = await stub.fetch(doUrl);
        if (!chartResponse.ok) return addCORSHeaders(chartResponse);

        const payload = (await chartResponse.json()) as ChartPayload;
        return addCORSHeaders(new Response(JSON.stringify(validateChartPayload(payload)), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      // --- Expose Available Dates to Frontend ---
      if (url.pathname === '/api/get-dates') {
        const ticker = normalizeTicker(url.searchParams.get('ticker'));
        const mode = normalizeMode(url.searchParams.get('mode'));
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        return addCORSHeaders(await stub.fetch(`https://dummy/api/v1/getAvailableDates?ticker=${encodeURIComponent(ticker)}&mode=${mode}`));
      }

      if (url.pathname === '/api/confluence') {
        const mode = normalizeMode(url.searchParams.get('mode'));
        const requestedDate = normalizeDate(url.searchParams.get('date'));
        const days = normalizeDays(url.searchParams.get('days'));
        const tickers = (url.searchParams.get('tickers') || 'SPY,QQQ,^SPX')
          .split(',')
          .map((ticker) => normalizeTicker(ticker))
          .slice(0, 5);

        const results = await Promise.all(tickers.map(async (ticker) => {
          const doId = env.GEX_HISTORY_DO.idFromName(ticker);
          const stub = env.GEX_HISTORY_DO.get(doId);
          let doUrl = `https://dummy/api/v1/getChartData?ticker=${encodeURIComponent(ticker)}&mode=${mode}&days=${days}&includeFuture=false`;
          if (requestedDate) doUrl += `&date=${requestedDate}`;
          const response = await stub.fetch(doUrl);
          if (!response.ok) return { ticker, ok: false, error: await response.text() };
          const payload = (await response.json()) as ChartPayload;
          return { ticker, ok: true, summary: summarizeConfluence(payload) };
        }));

        return addCORSHeaders(new Response(JSON.stringify({ mode, tickers: results }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      if (url.pathname === '/api/live-exposure') {
        const ticker = normalizeTicker(url.searchParams.get('ticker'));
        const mode = normalizeMode(url.searchParams.get('mode'));
        const expirations = normalizeExpirations(url.searchParams.get('expirations'));
        const { mkt_hours, mins_passed } = getMarketStatus(APP_TIMEZONE);
        const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
        const { df, spot } = await calc_exposure(ticker, mte_list, { mode, expirations });
        const { limit_up, limit_down } = getChartLimits(df, mte_len);
        const payload: ChartPayload = {
          date: getDateStr(0, APP_TIMEZONE),
          dates: [getDateStr(0, APP_TIMEZONE)],
          mode,
          heatmapTrace: {
            x: df.columns,
            y: df.index,
            z: df.values,
          },
          limits: { up: limit_up, down: limit_down },
          spot,
          sessionMarkers: [],
          daySegments: [{ date: getDateStr(0, APP_TIMEZONE), start: 0, end: df.columns.length - 1 }],
        };

        return addCORSHeaders(new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
        }));
      }

      if (url.pathname === '/api/get-ohlc') {
        const ticker = normalizeTicker(url.searchParams.get('ticker'));
        const interval = normalizeInterval(url.searchParams.get('interval'));
        const { mkt_hours } = getMarketStatus(APP_TIMEZONE);
        const { ohlc, mktHoursRange } = await makeCS(ticker, interval, mkt_hours);

        const ohlcTrace = {
          type: 'candlestick',
          x: ohlc.x,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
          xaxis: 'x2',
          yaxis: 'y',
          increasing: { line: { color: '#26a69a' } },
          decreasing: { line: { color: '#ef5350' } }
        };

        return addCORSHeaders(new Response(JSON.stringify({ ohlcTrace, mktHoursRange }), {
          headers: { 'Content-Type': 'application/json' }
        }));
      }

      return addCORSHeaders(new Response('Not found', { status: 404 }));

    } catch (error) {
      const err = error as Error;
      return addCORSHeaders(new Response(JSON.stringify({ error: err.message }), { status: 500 }));
    }
  },

  async scheduled(controller: ScheduledController | null, env: Env, ctx: ExecutionContext): Promise<void> {
    // --- 1. Daily cleanup (runs regardless of market status) ---
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: APP_TIMEZONE }));
    if (now.getHours() === 0 && now.getMinutes() < 15) {
      for (const ticker of SCHEDULED_TICKERS) {
        const cleanupDoId = env.GEX_HISTORY_DO.idFromName(ticker);
        const cleanupStub = env.GEX_HISTORY_DO.get(cleanupDoId);
        for (const mode of ['gex', 'vex'] as ExposureMode[]) {
          ctx.waitUntil(cleanupStub.fetch(`https://dummy/api/v1/deleteOldData?ticker=${encodeURIComponent(ticker)}&mode=${mode}`, { method: 'POST' }));
        }
      }
    }

    // --- 2. Data collection (only during market open) ---
    const { mkt_hours, mins_passed } = getMarketStatus(APP_TIMEZONE);
    if (mkt_hours !== 'mkt_open') return;

    const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
    const current_bucket_mins = Math.floor(mins_passed);
    const target_mte = 390 - current_bucket_mins;

    for (const ticker of SCHEDULED_TICKERS) {
      for (const mode of ['gex', 'vex'] as ExposureMode[]) {
        try {
          const { df, spot } = await calc_exposure(ticker, mte_list, { mode, expirations: 3 });
          const { limit_up, limit_down } = getChartLimits(df, mte_len);

          const splitIndex = df.columns.indexOf(target_mte);
          if (splitIndex === -1) {
            console.log(`Target MTE ${target_mte} not found in ${ticker} ${mode} grid.`);
            continue;
          }

          const historical_z_strip = df.values.map(row => row[splitIndex]);
          const future_columns = df.columns.slice(splitIndex + 1);
          const future_z_values = df.values.map(row => row.slice(splitIndex + 1));

          const stripData: NewStripData = {
            ticker,
            mode,
            historicalStrip: {
              x_mte: target_mte,
              z_strip: historical_z_strip,
            },
            futureMap: {
              x_mte: future_columns,
              y_strikes: df.index,
              z_values: future_z_values,
            },
            limits: { up: limit_up, down: limit_down },
            spot: spot,
          };

          const doId = env.GEX_HISTORY_DO.idFromName(ticker);
          const stub = env.GEX_HISTORY_DO.get(doId);

          ctx.waitUntil(stub.fetch('https://dummy/api/v1/addStrip', {
            method: 'POST',
            body: JSON.stringify(stripData),
            headers: { 'Content-Type': 'application/json' },
          }));
        } catch (error) {
          console.error(`Failed scheduled ${mode} collection for ${ticker}:`, error);
        }
      }
    }
  },
};
