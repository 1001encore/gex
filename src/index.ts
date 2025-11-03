// src/index.ts

/// <reference types="@cloudflare/workers-types" />

import {
  DurableObjectNamespace,
  ExecutionContext,
  ScheduledController,
  DurableObjectState,
  DurableObject,
} from '@cloudflare/workers-types';

// 1. IMPORT PATH FIXED (and new helpers)
import {
  calc_gamma,
  getMteList,
  getMarketStatus,
  getChartLimits,
  makeCS,
  getStorageKey, // <-- NEW
  getDateStr,   // <-- NEW
} from './lib';
import type { GammaDf } from './lib';

// --- CONSTANTS ---
const APP_TIMEZONE = 'Asia/Istanbul';
const DAYS_OF_DATA_TO_KEEP = 3;
const TICKER = 'SPY';

// --- NEW TYPE DEFINITIONS ---
// This is what we store for *each session*
interface SessionData {
  y_strikes: number[];
  strips: number[][]; // An array of value arrays (z-strips)
  mtes: number[];     // An array of mte values (x-axis)
  limits: { up: number; down: number };
  spot: number;

  // --- ADD THESE TWO LINES ---
  future_x_mte: number[];
  future_z_values: number[][];
}

// This is what we send to the front-end
interface FinalPayload {
  heatmapTrace: {
    type: 'heatmap';
    x: number[]; // All mtes combined
    y: number[]; // All strikes
    z: number[][]; // All strips combined
    colorscale: 'Edge';
    zmid: 0;
    zsmooth: 'best';
  };
  limits: { up: number; down: number };
  spot: number;
  sessionMarkers: { x: number, label: string }[]; // <-- NEW: for drawing lines
}

// This is the data format from the scheduled function
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


// --- 1. THE REFACTORED DURABLE OBJECT ---
// The DO is now a pure key-value storage manager.
// -----------------------------------------------------------------
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

      // Get existing data for this session, or create new
      let sessionData: SessionData = (await this.state.storage.get(key)) || {
        y_strikes: newData.futureMap.y_strikes,
        strips: [],
        mtes: [],
        limits: newData.limits,
        spot: newData.spot,
        future_x_mte: [], // <-- Initialize new field
        future_z_values: [] // <-- Initialize new field
      };

      // Append new strip
      sessionData.strips.push(newData.historicalStrip.z_strip);
      sessionData.mtes.push(newData.historicalStrip.x_mte);
      
      // --- UPDATE THESE LINES ---
      // Update with latest "future" data, spot, and limits
      sessionData.limits = newData.limits;
      sessionData.spot = newData.spot;
      sessionData.future_x_mte = newData.futureMap.x_mte;
      sessionData.future_z_values = newData.futureMap.z_values;
      // --------------------------

      // Write back to the unique key
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
        return new Response(JSON.stringify({ error: 'No data available' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Stitch all session data together
      const combined_x_mte: number[] = [];
      const combined_z_values: number[][] = [];
      const sessionMarkers: { x: number; label: string }[] = [];
      let lastKnownSpot = 0;
      let lastKnownLimits = { up: 0, down: 0 };
      let y_strikes: number[] = [];
      
      // --- NEW: Need to track the latest session to get its future map ---
      let latestSession: SessionData | null = null;
      let lastKey = "";

      for (const [key, sessionData] of keys) {
        if (!sessionData || !sessionData.mtes || !sessionData.strips) continue;
        
        const sessionName = key.split('_').pop() || 'session'; 

        if (combined_x_mte.length > 0 && !key.endsWith(lastKey.split('_').pop()!)) {
            sessionMarkers.push({
                x: combined_x_mte[combined_x_mte.length - 1], 
                label: sessionName,
            });
        }
        lastKey = key;

        // Combine historical mtes (x-axis)
        combined_x_mte.push(...[...sessionData.mtes].reverse());

        // Combine historical strips (z-axis)
        if (combined_z_values.length === 0) {
            y_strikes = sessionData.y_strikes;
            for (let i = 0; i < y_strikes.length; i++) {
                combined_z_values.push([]);
            }
        }
        
        const reversedStrips = [...sessionData.strips].reverse();
        for (let i = 0; i < y_strikes.length; i++) {
            for (const strip of reversedStrips) {
                combined_z_values[i].push(strip[i] || 0);
            }
        }
        
        // --- Store the *latest* session data ---
        latestSession = sessionData;
      }
      
      // --- NEW: Append the latest "future" map ---
      if (latestSession && latestSession.future_x_mte) {
          // Add future x-axis values
          combined_x_mte.push(...latestSession.future_x_mte);
          
          // Add future z-axis values
          for (let i = 0; i < y_strikes.length; i++) {
              combined_z_values[i].push(...(latestSession.future_z_values[i] || []));
          }
          
          // Update spot/limits to the absolute latest
          lastKnownSpot = latestSession.spot;
          lastKnownLimits = latestSession.limits;
      }
      // ------------------------------------------

      const payload: FinalPayload = {
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

    // --- ROUTE C: Increment Dev Time (FOR LOCAL TESTING) ---
    if (request.method === 'POST' && url.pathname === '/api/v1/incrementDevTime') {
        // Get the last time, or default to 10
        let lastMins = await this.state.storage.get<number>('dev_mins_passed') || 10;
        
        // Increment by 1 minute
        lastMins += 1; 

        await this.state.storage.put('dev_mins_passed', lastMins);
        return new Response(JSON.stringify(lastMins), {
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // --- ROUTE D: Delete old data (called by cron) ---
    if (request.method === 'POST' && url.pathname === '/api/v1/deleteOldData') {
        const endDate = getDateStr(DAYS_OF_DATA_TO_KEEP + 1, APP_TIMEZONE);

        // List all keys *up to* 4 days ago
        const oldKeys = await this.state.storage.list({
            prefix: `data_${TICKER}_`,
            end: `data_${TICKER}_${endDate}T23:59:59Z`, // T23:59:59Z ensures we get the whole day
        });

        if (oldKeys.size > 0) {
            await this.state.storage.delete(Array.from(oldKeys.keys()));
            return new Response(`Deleted ${oldKeys.size} old keys.`);
        }
        return new Response('No old keys to delete.');
    }

    return new Response('Not found', { status: 404 });
  }
}

// --- 2. DEFINE THE WORKER ENVIRONMENT ---
// -----------------------------------------------------------------
export interface Env {
  GEX_HISTORY_DO: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// --- 3. THE REFACTORED WORKER (fetch + scheduled) ---
// -----------------------------------------------------------------
export default {
  /**
   * Main router for all requests.
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    try {
      // --- FRONT-END API: Get Chart Data ---
      if (url.pathname === '/api/get-gamma-api') {
        const doId = env.GEX_HISTORY_DO.idFromName(TICKER); // One DO per ticker
        const stub = env.GEX_HISTORY_DO.get(doId);
        
        // Forward the request to the DO's /api/v1/getChartData route
        return await stub.fetch('https://dummy/api/v1/getChartData');
      }

      // --- FRONT-END API: Get OHLC Data ---
      if (url.pathname === '/api/get-ohlc') {
        // ... (This logic is unchanged and still correct)
        const ticker = url.searchParams.get('ticker')?.toUpperCase() || TICKER;
        const interval = url.searchParams.get('interval') || '5m';
        const { mkt_hours } = getMarketStatus(APP_TIMEZONE);
        const { ohlc, mktHoursRange } = await makeCS(
          ticker,
          interval,
          mkt_hours
        );
        const ohlcTrace = {
          type: 'candlestick',
          x: ohlc.x,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
          xaxis: 'x2',
          yaxis: 'y',
        };
        const responsePayload = { ohlcTrace, mktHoursRange };
        return new Response(JSON.stringify(responsePayload), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 's-maxage=60',
          },
        });
      }

      // --- Fallback: Serve Static Assets ---
      return env.ASSETS.fetch(request);
    } catch (error) {
      const err = error as Error;
      return new Response(
        JSON.stringify({ error: err.message, stack: err.stack }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },

  /**
   * Cron job handler.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // --- 1. Perform Computation ---
    // const { mkt_hours, mins_passed } = getMarketStatus(APP_TIMEZONE);
    //const { mkt_hours, mins_passed } = { mkt_hours: 'mkt_open', mins_passed: 30 };

    // --- STATEFUL DEV-MODE HACK ---
    // Get the DO stub
    const doId_dev = env.GEX_HISTORY_DO.idFromName(TICKER);
    const stub_dev = env.GEX_HISTORY_DO.get(doId_dev);
    
    // Call our new endpoint to get the *next* minute
    const devTimeRes = await stub_dev.fetch('https://dummy/api/v1/incrementDevTime', {
        method: 'POST',
    });
    const new_mins_passed = await devTimeRes.json() as number;
    
    console.log(`--- RUNNING IN DEV MODE: FORCING MARKET OPEN (Minute: ${new_mins_passed}) ---`);
    const { mkt_hours, mins_passed } = { mkt_hours: 'mkt_open', mins_passed: new_mins_passed };
    // ----- DEV-MODE HACK END ------

    // const { mkt_hours, mins_passed } = getMarketStatus(APP_TIMEZONE); // Real code
    if (mkt_hours === 'mkt_closed') {
      console.log('Market closed, cron skipping.');
      return;
    }

    const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
    const { df, spot } = await calc_gamma(TICKER, mte_list);
    const { limit_up, limit_down } = getChartLimits(df, mte_len);

    const stripData: NewStripData = {
      historicalStrip: {
        x_mte: df.columns[0],
        z_strip: df.values.map((row) => row[0]),
      },
      futureMap: {
        x_mte: df.columns.slice(1),
        y_strikes: df.index,
        z_values: df.values.map((row) => row.slice(1)),
      },
      limits: { up: limit_up, down: limit_down },
      spot: spot,
    };

    // --- 2. Call DO to Store Data ---
    const doId = env.GEX_HISTORY_DO.idFromName(TICKER);
    const stub = env.GEX_HISTORY_DO.get(doId);
    
    ctx.waitUntil(
      stub.fetch('https://dummy/api/v1/addStrip', {
        method: 'POST',
        body: JSON.stringify(stripData),
        headers: { 'Content-Type': 'application/json' },
      })
    );

    // --- 3. Trigger Old Data Deletion (once per day) ---
    // This runs just after midnight in the app's timezone.
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: APP_TIMEZONE }));
    if (now.getHours() === 0 && now.getMinutes() < 5) { // Run between 00:00 and 00:05
        console.log('Running daily cleanup of old DO keys...');
        ctx.waitUntil(
            stub.fetch('https://dummy/api/v1/deleteOldData', {
                method: 'POST',
            })
        );
    }
  },
};