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
  strips: number[][]; // Historical Z-values
  mtes: number[];     // Historical MTE values (e.g., [390, 380...])
  limits: { up: number; down: number };
  spot: number;
  
  // The "Future" cache (Overwritten every minute)
  future_x_mte: number[];
  future_z_values: number[][];
}

interface NewStripData {
  historicalStrip: {
    x_mte: number;       // The MTE value for this minute
    z_strip: number[];   // The column of values
  };
  futureMap: {
    x_mte: number[];     // MTEs for the rest of the day
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

      // Get existing data or init new
      let sessionData: SessionData = (await this.state.storage.get(key)) || {
        y_strikes: newData.futureMap.y_strikes,
        strips: [],
        mtes: [],
        limits: newData.limits,
        spot: newData.spot,
        future_x_mte: [],
        future_z_values: []
      };

      // 1. Append the new HISTORICAL strip
      // We check to avoid duplicates if cron misfires
      if (!sessionData.mtes.includes(newData.historicalStrip.x_mte)) {
          sessionData.strips.push(newData.historicalStrip.z_strip);
          sessionData.mtes.push(newData.historicalStrip.x_mte);
      }

      // 2. Overwrite the FUTURE map
      // The worker has already sliced this to exclude history, so we just save it.
      sessionData.future_x_mte = newData.futureMap.x_mte;
      sessionData.future_z_values = newData.futureMap.z_values;
      
      // 3. Update metadata
      sessionData.limits = newData.limits;
      sessionData.spot = newData.spot;
      // Update strikes if they expanded (rare but possible)
      if (newData.futureMap.y_strikes.length > sessionData.y_strikes.length) {
          sessionData.y_strikes = newData.futureMap.y_strikes;
      }

      await this.state.storage.put(key, sessionData);
      return new Response('OK');
    }

    // --- ROUTE B: Get combined data (called by front-end) ---
    if (request.method === 'GET' && url.pathname === '/api/v1/getChartData') {
      const startDate = getDateStr(DAYS_OF_DATA_TO_KEEP, APP_TIMEZONE);
      
      const keys = await this.state.storage.list<SessionData>({
        prefix: `data_${TICKER}_`,
        start: `data_${TICKER}_${startDate}`,
      });

      if (keys.size === 0) {
        return new Response(JSON.stringify({ error: 'No data available' }), { status: 404 });
      }

      // Arrays to hold the final stitched chart
      const combined_x_mte: number[] = [];
      const combined_z_values: number[][] = [];
      const sessionMarkers: { x: number; label: string }[] = [];
      
      let lastKnownSpot = 0;
      let lastKnownLimits = { up: 0, down: 0 };
      let y_strikes: number[] = [];
      let latestSession: SessionData | null = null;

      // 1. Iterate over all saved sessions (Days)
      for (const [key, sessionData] of keys) {
        if (!sessionData || !sessionData.mtes) continue;
        
        // Marker for visual separation of days
        const sessionName = key.split('_').pop() || 'session'; 
        if (combined_x_mte.length > 0) {
            sessionMarkers.push({
                x: combined_x_mte[combined_x_mte.length - 1], 
                label: sessionName,
            });
        }

        // Initialize Z-matrix dimensions if this is the first data found
        if (combined_z_values.length === 0) {
            y_strikes = sessionData.y_strikes;
            for (let i = 0; i < y_strikes.length; i++) combined_z_values.push([]);
        }

        // Append HISTORICAL data
        // Note: mtes are stored like [390, 380...]. We append them in that order (Time Ascending).
        combined_x_mte.push(...sessionData.mtes);

        // Append Z-strips
        for (let i = 0; i < y_strikes.length; i++) {
            for (const strip of sessionData.strips) {
                combined_z_values[i].push(strip[i] || 0);
            }
        }
        
        latestSession = sessionData;
      }
      
      // 2. Append the FUTURE projection (Only for the latest session)
      // Since the Worker sliced this perfectly, we just paste it on the end.
      if (latestSession && latestSession.future_x_mte && latestSession.future_x_mte.length > 0) {
          
          combined_x_mte.push(...latestSession.future_x_mte);
          
          for (let i = 0; i < y_strikes.length; i++) {
              // Get the row for this strike from the future map
              const futureRow = latestSession.future_z_values[i] || [];
              combined_z_values[i].push(...futureRow);
          }
          
          lastKnownSpot = latestSession.spot;
          lastKnownLimits = latestSession.limits;
      }

      const payload = {
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
    
    // --- ROUTE C: Delete Old Data ---
    if (request.method === 'POST' && url.pathname === '/api/v1/deleteOldData') {
        const endDate = getDateStr(DAYS_OF_DATA_TO_KEEP + 1, APP_TIMEZONE);
        const oldKeys = await this.state.storage.list({
            prefix: `data_${TICKER}_`,
            end: `data_${TICKER}_${endDate}T23:59:59Z`,
        });
        if (oldKeys.size > 0) {
            await this.state.storage.delete(Array.from(oldKeys.keys()));
        }
        return new Response('Cleaned');
    }

    return new Response('Not found', { status: 404 });
  }
}

// --- 2. THE WORKER ---
export interface Env {
  GEX_HISTORY_DO: DurableObjectNamespace;
}

// CORS Helpers
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
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        return addCORSHeaders(await stub.fetch('https://dummy/api/v1/getChartData'));
      }

      if (url.pathname === '/api/get-ohlc') {
        const ticker = url.searchParams.get('ticker')?.toUpperCase() || TICKER;
        const interval = url.searchParams.get('interval') || '5m';
        const { mkt_hours } = getMarketStatus(APP_TIMEZONE);
        const { ohlc, mktHoursRange } = await makeCS(ticker, interval, mkt_hours);
        return addCORSHeaders(new Response(JSON.stringify({ ohlc, mktHoursRange }), {
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
      // 1. Check Market Status
      const { mkt_hours, mins_passed } = getMarketStatus(APP_TIMEZONE);
      
      if (mkt_hours === 'mkt_closed' || mkt_hours === 'post_mkt') {
        // Optional: Run cleanup logic here if needed
        return;
      }
      
      // 2. Calculate Full Gamma Chart (History + Future)
      // mte_list will be [390, 380, ... 0]
      const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
      const { df, spot } = await calc_gamma(TICKER, mte_list);
      const { limit_up, limit_down } = getChartLimits(df, mte_len);
      
      // 3. IDENTIFY THE CURRENT STRIPE VS FUTURE
      // We need to map "mins_passed" (time up) to "MTE" (time down).
      // Example: mins_passed = 12. Round to 10. MTE = 390 - 10 = 380.
      
      // Round down to nearest 10-min bucket
      const current_bucket_mins = Math.round(mins_passed / 10) * 10;
      
      // Convert to MTE (Assuming 390 is start of day, 0 is end)
      // Note: If you want 390 to be 9:30AM, use: target_mte = 390 - current_bucket_mins
      const target_mte = 390 - current_bucket_mins;
      
      // Find where this MTE lives in the columns [390, 380 ... 0]
      const splitIndex = df.columns.indexOf(target_mte);
      
      if (splitIndex === -1) {
          console.log(`Current MTE ${target_mte} not found in columns. Likely pre/post market fringe. Skipping.`);
          return;
      }

      // 4. PREPARE PAYLOAD
      
      // The Stripe: The single column at splitIndex
      const historical_z_strip = df.values.map(row => row[splitIndex]);

      // The Future: Everything AFTER splitIndex (because columns are descending 390->0)
      // If splitIndex is 1 (MTE 380), we want indices 2...end (MTE 370...0)
      const future_columns = df.columns.slice(splitIndex + 1);
      
      // We must slice every row in the 2D array
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

      // 5. Send to DO
      const doId = env.GEX_HISTORY_DO.idFromName(TICKER);
      const stub = env.GEX_HISTORY_DO.get(doId);
      
      ctx.waitUntil(stub.fetch('https://dummy/api/v1/addStrip', {
          method: 'POST',
          body: JSON.stringify(stripData),
          headers: { 'Content-Type': 'application/json' },
      }));

      // Cleanup trigger (Runs once at midnight)
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: APP_TIMEZONE }));
      if (now.getHours() === 0 && now.getMinutes() < 5) {
          ctx.waitUntil(stub.fetch('https://dummy/api/v1/deleteOldData', { method: 'POST' }));
      }
  },
};