// functions/_worker.ts

/// <reference types="@cloudflare/workers-types" />

import {
  DurableObjectNamespace,
  ExecutionContext,
  ScheduledController,
  DurableObjectState,
  DurableObject,
} from '@cloudflare/workers-types';

// Import ALL our logic from the one _lib.ts file
import {
  calc_gamma,
  getMteList,
  getMarketStatus,
  getChartLimits,
  makeCS,
} from './lib'; // <-- THIS IS THE CORRECT PATH
import type { GammaDf } from './lib';

// --- 1. DEFINE AND EXPORT THE DURABLE OBJECT ---
// We define the class right here in the main worker file
// -----------------------------------------------------------------

export interface FinalPayload {
  heatmapTrace: {
    type: 'heatmap';
    x: number[];
    y: number[];
    z: number[][];
    colorscale: 'Edge';
    zmid: 0;
    zsmooth: 'best';
  };
  limits: { up: number; down: number };
  mteList: number[];
  spot: number;
  marketTime: string;
  marketStatus: string;
}
interface HeatmapState {
  y_strikes: number[];
  locked_x_mte: number[];
  locked_z_strips: number[][];
  future_x_mte: number[];
  future_z_values: number[][];
  limits: { up: number; down: number };
  spot: number;
  marketStatus: string;
}
interface UpdateMapData {
  futureMap: { x_mte: number[]; y_strikes: number[]; z_values: number[][] };
  historicalStrip: { x_mte: number; z_strip: number[] };
  limits: { up: number; down: number };
  spot: number;
  marketStatus: string;
}

// This is the class wrangler needs to see exported
export class HeatmapBuilderDO implements DurableObject {
  state: DurableObjectState;
  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/updateMap') {
      const data = (await request.json()) as UpdateMapData;
      await this.updateMap(data);
      return new Response('OK');
    }
    if (request.method === 'GET' && url.pathname === '/getCombinedPayload') {
      const payload = await this.getCombinedPayload();
      if (payload) {
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        return new Response(JSON.stringify({ error: 'No data available' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response('Not found', { status: 404 });
  }

  async updateMap(data: UpdateMapData) {
    let currentState: HeatmapState = (await this.state.storage.get(
      'heatmapState'
    )) || {
      y_strikes: data.futureMap.y_strikes,
      locked_x_mte: [],
      locked_z_strips: [],
      future_x_mte: [],
      future_z_values: [],
      limits: data.limits,
      spot: data.spot,
      marketStatus: data.marketStatus,
    };
    currentState.future_x_mte = data.futureMap.x_mte;
    currentState.future_z_values = data.futureMap.z_values;
    currentState.locked_x_mte.push(data.historicalStrip.x_mte);
    currentState.locked_z_strips.push(data.historicalStrip.z_strip);
    currentState.limits = data.limits;
    currentState.spot = data.spot;
    currentState.marketStatus = data.marketStatus;
    await this.state.storage.put('heatmapState', currentState);
  }

  async getCombinedPayload(): Promise<FinalPayload | null> {
    const currentState: HeatmapState | undefined =
      await this.state.storage.get('heatmapState');
    if (!currentState) return null;
    const combined_x_mte = [
      ...[...currentState.locked_x_mte].reverse(),
      ...currentState.future_x_mte,
    ];
    const numStrikes = currentState.y_strikes.length;
    const numLockedStrips = currentState.locked_x_mte.length;
    const combined_z_values: number[][] = [];
    const reversedLockedStrips = [...currentState.locked_z_strips].reverse();
    for (let i = 0; i < numStrikes; i++) {
      const row: number[] = [];
      for (let j = 0; j < numLockedStrips; j++) {
        row.push(reversedLockedStrips[j][i] || 0);
      }
      row.push(...(currentState.future_z_values[i] || []));
      combined_z_values.push(row);
    }
    return {
      heatmapTrace: {
        type: 'heatmap',
        x: combined_x_mte,
        y: currentState.y_strikes,
        z: combined_z_values,
        colorscale: 'Edge',
        zmid: 0,
        zsmooth: 'best',
      },
      limits: currentState.limits,
      mteList: combined_x_mte,
      spot: currentState.spot,
      marketTime: new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Istanbul',
      }),
      marketStatus: currentState.marketStatus,
    };
  }
}

// --- 2. DEFINE THE ENVIRONMENT ---
// -----------------------------------------------------------------
export interface Env {
  GEX_HISTORY_DO: DurableObjectNamespace;
  ASSETS: Fetcher; // <-- ADD THIS LINE
}

// --- 3. MASTER HANDLER (fetch + scheduled) ---
export default {
  /**
   * This is the main router for ALL requests.
   */
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    try {
      // --- ROUTE 1: /api/get-gamma-api ---
      if (url.pathname === '/api/get-gamma-api') {
        const ticker = url.searchParams.get('ticker')?.toUpperCase() || 'SPY';
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);

        const resp = await stub.fetch('https://dummy/getCombinedPayload');
        if (!resp.ok) {
          return new Response(
            JSON.stringify({
              error:
                'No heatmap data available yet. Please wait for the next cron run.',
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } }
          );
        }
        const payload = (await resp.json()) as FinalPayload;
        return new Response(JSON.stringify(payload), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 's-maxage=10',
          },
        });
      }

      // --- ROUTE 2: /api/get-ohlc ---
      if (url.pathname === '/api/get-ohlc') {
        const ticker = url.searchParams.get('ticker')?.toUpperCase() || 'SPY';
        const interval = url.searchParams.get('interval') || '5m';
        const { mkt_hours } = getMarketStatus('Asia/Istanbul');

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

      // --- 4. FALLBACK TO SERVE STATIC ASSETS ---
      // This is the correct fallback.
      // It serves your index.html and any other assets.
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
   * This is the cron job handler.
   * (No changes needed, this is correct)
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const ticker = 'SPY';
    //console.log('--- RUNNING IN DEV MODE: FORCING MARKET OPEN ---');
    //const { mkt_hours, mins_passed } = { mkt_hours: 'mkt_open', mins_passed: 10 };
    const { mkt_hours, mins_passed } = getMarketStatus('Asia/Istanbul');
    if (mkt_hours === 'mkt_closed') {
      console.log('Market closed, cron skipping.');
      return;
    }
    const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
    const { df, spot } = await calc_gamma(ticker, mte_list);
    const { limit_up, limit_down } = getChartLimits(df, mte_len);
    const historicalStrip = {
      x_mte: df.columns[0],
      z_strip: df.values.map((row) => row[0]),
    };
    const futureMap = {
      x_mte: df.columns.slice(1),
      y_strikes: df.index,
      z_values: df.values.map((row) => row.slice(1)),
    };
    const doId = env.GEX_HISTORY_DO.idFromName(ticker);
    const stub = env.GEX_HISTORY_DO.get(doId);
    ctx.waitUntil(
      stub.fetch('https://dummy/updateMap', {
        method: 'POST',
        body: JSON.stringify({
          futureMap,
          historicalStrip,
          limits: { up: limit_up, down: limit_down },
          spot: spot,
          marketStatus: mkt_hours,
        }),
        headers: { 'Content-Type': 'application/json' },
      })
    );
  },
};