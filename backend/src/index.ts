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

      // Atomic Update: We modify the object in memory and save it once.
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

    // --- ROUTE B: Get combined data (called by front-end) ---
    if (request.method === 'GET' && url.pathname === '/api/v1/getChartData') {
      // List all keys. We will filter them in memory to be safe.
      const listMap = await this.state.storage.list<SessionData>({
        prefix: `data_${TICKER}_`,
      });

      if (listMap.size === 0) {
        return new Response(JSON.stringify({ error: 'No data available' }), { status: 404 });
      }

      // Sort keys to ensure chronological order (Oldest -> Newest)
      // Key format: data_SPY_YYYY-MM-DD_session
      const sortedKeys = Array.from(listMap.keys()).sort();

      const combined_x_mte: number[] = [];
      const combined_z_values: number[][] = [];
      const sessionMarkers: { x: number; label: string }[] = [];
      
      let lastKnownSpot = 0;
      let lastKnownLimits = { up: 0, down: 0 };
      let y_strikes: number[] = [];
      let latestSession: SessionData | null = null;

      for (const key of sortedKeys) {
        const sessionData = listMap.get(key);
        if (!sessionData || !sessionData.mtes) continue;
        
        const sessionName = key.split('_').pop() || 'session'; 
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
    
    // --- ROUTE C: Smart Atomic Deletion ---
    // Deletes any data older than DAYS_OF_DATA_TO_KEEP
    if (request.method === 'POST' && url.pathname === '/api/v1/deleteOldData') {
        const listMap = await this.state.storage.list<SessionData>({
            prefix: `data_${TICKER}_`,
        });

        const keysToDelete: string[] = [];
        const now = new Date();
        const cutoffTime = now.getTime() - (DAYS_OF_DATA_TO_KEEP * 24 * 60 * 60 * 1000);

        for (const key of listMap.keys()) {
            // Key: data_SPY_2023-10-25_mkt_open
            const parts = key.split('_');
            const dateStr = parts[2]; // 2023-10-25
            
            if (!dateStr) continue;

            const keyDate = new Date(dateStr);
            // If date is invalid or older than cutoff, mark for death
            if (isNaN(keyDate.getTime()) || keyDate.getTime() < cutoffTime) {
                keysToDelete.push(key);
            }
        }

        if (keysToDelete.length > 0) {
            console.log(`Deleting ${keysToDelete.length} old keys:`, keysToDelete);
            // ATOMIC DELETE: This removes all passed keys in one transaction.
            await this.state.storage.delete(keysToDelete);
            return new Response(`Deleted: ${keysToDelete.join(', ')}`);
        }
        return new Response('No old data to delete.');
    }

    // --- ROUTE D: THE NUKE (Clean Slate) ---
    if (request.method === 'POST' && url.pathname === '/api/v1/nuke') {
        await this.state.storage.deleteAll();
        return new Response('DO Storage Nuked. Clean slate for tomorrow.');
    }

    return new Response('Not found', { status: 404 });
  }
}

// --- 2. THE WORKER ---
export interface Env {
  GEX_HISTORY_DO: DurableObjectNamespace;
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
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        return addCORSHeaders(await stub.fetch('https://dummy/api/v1/getChartData'));
      }

      // --- NUKE ENDPOINT EXPOSED TO WORKER ---
      // Use this once to clear your bad data: https://your-worker.dev/api/nuke
      if (url.pathname === '/api/nuke') {
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
      
      // Strict Check: Even if Cron fires, we exit if market is closed.
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

      // Cleanup trigger (Runs once at midnight local time)
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: APP_TIMEZONE }));
      if (now.getHours() === 0 && now.getMinutes() < 15) {
          ctx.waitUntil(stub.fetch('https://dummy/api/v1/deleteOldData', { method: 'POST' }));
      }
  },
};