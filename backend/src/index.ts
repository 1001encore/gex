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
  calc_gamma,
  getMteList,
  getMarketStatus,
  getChartLimits,
  makeCS,
  getStorageKey,
  getDateStr,
} from './lib';

// --- CONSTANTS ---
const APP_TIMEZONE = 'Asia/Istanbul';
const DAYS_OF_DATA_TO_KEEP = 3;
const TICKER = 'SPY';

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

// --- 1. THE DURABLE OBJECT ---
export class HeatmapBuilderDO implements DurableObject {
  state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // --- ROUTE A: Add a new data strip (called by cron) ---
    if (request.method === 'POST' && url.pathname === '/api/v1/addStrip') {
      const { key } = getStorageKey(APP_TIMEZONE);
      const newData = (await request.json()) as NewStripData;

      let sessionData: SessionData = (await this.state.storage.get(key)) || {
        y_strikes: newData.futureMap.y_strikes,
        strips: [],
        mtes: [],
        limits: newData.limits,
        spot: newData.spot,
        future_x_mte: [],
        future_z_values: []
      };

      if (!sessionData.mtes.includes(newData.historicalStrip.x_mte)) {
          sessionData.strips.push(newData.historicalStrip.z_strip);
          sessionData.mtes.push(newData.historicalStrip.x_mte);
      }

      sessionData.future_x_mte = newData.futureMap.x_mte;
      sessionData.future_z_values = newData.futureMap.z_values;
      sessionData.limits = newData.limits;
      sessionData.spot = newData.spot;
      
      if (newData.futureMap.y_strikes.length > sessionData.y_strikes.length) {
          sessionData.y_strikes = newData.futureMap.y_strikes;
      }

      await this.state.storage.put(key, sessionData);
      return new Response('OK');
    }

    // --- ROUTE B: Get Chart Data (Filtered by Date) ---
    if (request.method === 'GET' && url.pathname === '/api/v1/getChartData') {
      const requestedDate = url.searchParams.get('date'); // YYYY-MM-DD
      
      // 1. Fetch ALL keys first to find available dates
      // (Optimization: We could list with prefix if we knew the date, 
      // but listing all keys for 3 days of data is very cheap/fast)
      const listMap = await this.state.storage.list<SessionData>({
        prefix: `data_${TICKER}_`,
      });

      if (listMap.size === 0) {
        return new Response(JSON.stringify({ error: 'No data available' }), { status: 404 });
      }

      // 2. Determine which date to show
      // Extract unique dates from keys: data_SPY_2023-10-25_mkt_open
      const allKeys = Array.from(listMap.keys()).sort();
      const uniqueDates = [...new Set(allKeys.map(k => k.split('_')[2]))];
      
      // Default to the LATEST date if none provided
      const targetDate = requestedDate || uniqueDates[uniqueDates.length - 1];

      // 3. Filter keys for that specific date
      const keysForDate = allKeys.filter(k => k.includes(targetDate));

      if (keysForDate.length === 0) {
         return new Response(JSON.stringify({ error: 'No data for date' }), { status: 404 });
      }

      const combined_x_mte: number[] = [];
      const combined_z_values: number[][] = [];
      const sessionMarkers: { x: number; label: string }[] = [];
      
      let lastKnownSpot = 0;
      let lastKnownLimits = { up: 0, down: 0 };
      let y_strikes: number[] = [];
      let latestSession: SessionData | null = null;

      // 4. Stitch sessions (Only for the target date)
      for (const key of keysForDate) {
        const sessionData = listMap.get(key);
        if (!sessionData || !sessionData.mtes) continue;
        
        const sessionName = key.split('_').pop() || 'session'; 
        
        // Only add marker if we are appending a second session (e.g. post-market)
        if (combined_x_mte.length > 0) {
            sessionMarkers.push({
                x: combined_x_mte[combined_x_mte.length - 1], 
                label: sessionName,
            });
        }

        if (combined_z_values.length === 0) {
            y_strikes = sessionData.y_strikes;
            for (let i = 0; i < y_strikes.length; i++) combined_z_values.push([]);
        }

        combined_x_mte.push(...sessionData.mtes);

        for (let i = 0; i < y_strikes.length; i++) {
            for (const strip of sessionData.strips) {
                combined_z_values[i].push(strip[i] || 0);
            }
        }
        latestSession = sessionData;
      }
      
      // 5. Append Future (only if viewing TODAY/Latest)
      // If viewing a past date, we theoretically only want historical data.
      // But for simplicity, if it's the latest session of that day, we show its future projection.
      if (latestSession && latestSession.future_x_mte && latestSession.future_x_mte.length > 0) {
          combined_x_mte.push(...latestSession.future_x_mte);
          for (let i = 0; i < y_strikes.length; i++) {
              const futureRow = latestSession.future_z_values[i] || [];
              combined_z_values[i].push(...futureRow);
          }
          lastKnownSpot = latestSession.spot;
          lastKnownLimits = latestSession.limits;
      }

      const payload = {
        date: targetDate,
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
      };

      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // --- ROUTE E: Get Available Dates (For Dropdown) ---
    if (request.method === 'GET' && url.pathname === '/api/v1/getAvailableDates') {
        const listMap = await this.state.storage.list({ prefix: `data_${TICKER}_` });
        const allKeys = Array.from(listMap.keys());
        // Extract "2023-10-25" from "data_SPY_2023-10-25_mkt_open"
        const uniqueDates = [...new Set(allKeys.map(k => k.split('_')[2]))].sort();
        
        return new Response(JSON.stringify(uniqueDates), {
            headers: { 'Content-Type': 'application/json' },
        });
    }
    
    // --- ROUTE C: Smart Atomic Deletion ---
    if (request.method === 'POST' && url.pathname === '/api/v1/deleteOldData') {
        const listMap = await this.state.storage.list<SessionData>({
            prefix: `data_${TICKER}_`,
        });

        const keysToDelete: string[] = [];
        const now = new Date();
        const cutoffTime = now.getTime() - (DAYS_OF_DATA_TO_KEEP * 24 * 60 * 60 * 1000);

        for (const key of listMap.keys()) {
            const parts = key.split('_');
            const dateStr = parts[2]; 
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

    // --- ROUTE D: THE SECURE NUKE ---
    if (request.method === 'POST' && url.pathname === '/api/v1/nuke') {
        // Retrieve the secret header passed from the Worker
        const authHeader = request.headers.get("X-Admin-Secret");
        
        // Check against the stored secret (passed via constructor or handled in worker)
        // Since DOs don't access `env` easily in `fetch`, we check this in the Worker layer 
        // OR pass it down. 
        // SIMPLER APPROACH: The Worker handles the Auth check before calling this DO method.
        
        await this.state.storage.deleteAll();
        return new Response('DO Storage Nuked. Clean slate for tomorrow.');
    }

    return new Response('Not found', { status: 404 });
  }
}

// --- 2. THE WORKER ---
export interface Env {
  GEX_HISTORY_DO: DurableObjectNamespace;
  ADMIN_SECRET: string; // <--- NEW SECRET
}

const ALLOWED_ORIGIN = "*";
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
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === '/__cron') {
        await this.scheduled(null, env, ctx);
        return new Response('Cron Ran');
      }

      if (url.pathname === '/api/get-gamma-api') {
        const ticker = url.searchParams.get('ticker')?.toUpperCase() || TICKER;
        const requestedDate = url.searchParams.get('date'); // New Param

        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        
        // Pass the date query to the DO
        let doUrl = 'https://dummy/api/v1/getChartData';
        if (requestedDate) doUrl += `?date=${requestedDate}`;

        return addCORSHeaders(await stub.fetch(doUrl));
      }

      // --- NEW: Expose Available Dates to Frontend ---
      if (url.pathname === '/api/get-dates') {
          const ticker = url.searchParams.get('ticker')?.toUpperCase() || TICKER;
          const doId = env.GEX_HISTORY_DO.idFromName(ticker);
          const stub = env.GEX_HISTORY_DO.get(doId);
          return addCORSHeaders(await stub.fetch('https://dummy/api/v1/getAvailableDates'));
      }

      // --- SECURED NUKE ENDPOINT ---
      if (url.pathname === '/api/nuke') {
        // 1. Check for the Secret Header
        const providedSecret = request.headers.get("X-Admin-Secret");
        if (providedSecret !== env.ADMIN_SECRET) {
            return new Response("Unauthorized", { status: 401 });
        }

        const doId = env.GEX_HISTORY_DO.idFromName(TICKER);
        const stub = env.GEX_HISTORY_DO.get(doId);
        return await stub.fetch('https://dummy/api/v1/nuke', { method: 'POST' });
      }

      if (url.pathname === '/api/get-ohlc') {
        const ticker = url.searchParams.get('ticker')?.toUpperCase() || TICKER;
        const interval = url.searchParams.get('interval') || '5m';
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
      const { mkt_hours, mins_passed } = getMarketStatus(APP_TIMEZONE);
      
      if (mkt_hours === 'mkt_closed') return;
      
      const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
      const { df, spot } = await calc_gamma(TICKER, mte_list);
      const { limit_up, limit_down } = getChartLimits(df, mte_len);
      
      const current_bucket_mins = Math.round(mins_passed / 10) * 10;
      const target_mte = 390 - current_bucket_mins;
      
      const splitIndex = df.columns.indexOf(target_mte);
      
      if (splitIndex === -1) return;

      const historical_z_strip = df.values.map(row => row[splitIndex]);
      const future_columns = df.columns.slice(splitIndex + 1);
      const future_z_values = df.values.map(row => row.slice(splitIndex + 1));

      const stripData: NewStripData = {
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

      const doId = env.GEX_HISTORY_DO.idFromName(TICKER);
      const stub = env.GEX_HISTORY_DO.get(doId);
      
      ctx.waitUntil(stub.fetch('https://dummy/api/v1/addStrip', {
          method: 'POST',
          body: JSON.stringify(stripData),
          headers: { 'Content-Type': 'application/json' },
      }));

      const now = new Date(new Date().toLocaleString('en-US', { timeZone: APP_TIMEZONE }));
      if (now.getHours() === 0 && now.getMinutes() < 15) {
          ctx.waitUntil(stub.fetch('https://dummy/api/v1/deleteOldData', { method: 'POST' }));
      }
  },
};