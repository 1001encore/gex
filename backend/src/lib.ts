// functions/api/_lib.ts

/// <reference types="@cloudflare/workers-types" />

export const YF_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  Connection: 'keep-alive',
};

// This object will hold our cached auth.
let yahooAuth: { cookie: string | null; crumb: string | null; expiry: number } = {
  cookie: null,
  crumb: null,
  expiry: 0,
};
const AUTH_TTL_MS = 15 * 60 * 1000;
let authRefreshPromise: Promise<{ cookie: string; crumb: string }> | null = null;

export async function refreshYahooAuth(): Promise<{
  cookie: string;
  crumb: string;
}> {
  console.log('--- Starting new Yahoo auth refresh... ---');
  const consentCookie =
    'A3=d=AQAB&S=AQABCAFFp2QAAAAifp2Q-Z3-l1kBEiL2S-sYBwEBAgABBwE-mAAAAg&Y=YAIA';
  const headersWithConsent = { ...YF_HEADERS, Cookie: consentCookie };
  const cookieRes = await fetch('https://finance.yahoo.com/quote/SPY', {
    headers: headersWithConsent,
    redirect: 'follow',
  });

  // Manual, bulletproof way to get cookies
  const setCookieHeaders: string[] = [];
  cookieRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      setCookieHeaders.push(value);
    }
  });

  if (setCookieHeaders.length === 0) {
    console.error(`Failed to get Yahoo cookie headers. Status: ${cookieRes.status}`);
    const body = await cookieRes.text();
    console.error('Response body snippet:', body.substring(0, 500));
    throw new Error('Failed to get Yahoo cookie. No consent page, but no cookies either.');
  }

  const receivedCookies = setCookieHeaders.join('; ');
  const cookie = consentCookie + '; ' + receivedCookies;
  const headersWithFullCookie = { ...YF_HEADERS, Cookie: cookie };

  const crumbRes = await fetch(
    'https://query1.finance.yahoo.com/v1/test/getcrumb',
    {
      headers: headersWithFullCookie,
    }
  );
  if (!crumbRes.ok) {
    throw new Error(`Failed to get Yahoo crumb: ${crumbRes.statusText}`);
  }
  const crumb = await crumbRes.text();
  if (!crumb) throw new Error('Crumb response was empty.');

  const newAuth = { cookie, crumb };
  yahooAuth = { ...newAuth, expiry: Date.now() + AUTH_TTL_MS };
  console.log('--- Successfully refreshed Yahoo auth. ---');
  return newAuth;
}

export async function getYahooAuth(): Promise<{ cookie: string; crumb: string }> {
  if (Date.now() <= yahooAuth.expiry && yahooAuth.cookie && yahooAuth.crumb) {
    return yahooAuth as { cookie: string; crumb: string };
  }
  if (authRefreshPromise) {
    return await authRefreshPromise;
  }
  authRefreshPromise = refreshYahooAuth();
  try {
    const newAuth = await authRefreshPromise;
    return newAuth;
  } catch (error) {
    console.error('Yahoo auth refresh failed:', error);
    throw error;
  } finally {
    authRefreshPromise = null;
  }
}

// --- NEW HELPER FUNCTION ---
/**
 * Generates the standardized storage key for the DO.
 * @param timeZone The app's timeZone (e.g., 'Asia/Istanbul')
 * @returns { key: string, session: string }
 */
export function getStorageKey(timeZone: string): { key: string, session: string } {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
  
  // Get YYYY-MM-DD
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, '0');
  const day = now.getDate().toString().padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  const { mkt_hours } = getMarketStatus(timeZone);

  // Key format: data_TICKER_YYYY-MM-DD_SESSION
  return {
    key: `data_SPY_${dateStr}_${mkt_hours}`,
    session: mkt_hours
  };
}

/**
 * Gets a date string for X days ago.
 * @param daysAgo How many days ago
 * @param timeZone The app's timeZone
 * @returns YYYY-MM-DD string
 */
export function getDateStr(daysAgo: number, timeZone: string): string {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
    now.setDate(now.getDate() - daysAgo);
    
    const year = now.getFullYear();
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const day = now.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export function getMarketStatus(timeZone: string): {
  mkt_hours: string;
  mins_passed: number;
} {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
  const mkt_open = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    16,
    30,
    0
  );
  const dayOfWeek = now.getDay();
  const nowInTZ = new Date(now.toLocaleString('en-US', { timeZone }));
  const mktOpenInTZ = new Date(mkt_open.toLocaleString('en-US', { timeZone }));
  const mins_passed = Math.floor(
    (nowInTZ.getTime() - mktOpenInTZ.getTime()) / 60000
  );
  if (dayOfWeek === 0 || dayOfWeek === 6)
    return { mkt_hours: 'mkt_closed', mins_passed };
  if (mins_passed > 630 && mins_passed < 1110)
    return { mkt_hours: 'mkt_closed', mins_passed };
  if (mins_passed >= 390 && mins_passed <= 630)
    return { mkt_hours: 'post_mkt', mins_passed };
  if (mins_passed >= 0 && mins_passed <= 390)
    return { mkt_hours: 'mkt_open', mins_passed };
  if (mins_passed >= 1110 && mins_passed <= 1440)
    return { mkt_hours: 'pre_mkt', mins_passed };
  return { mkt_hours: 'mkt_closed', mins_passed };
}

export function getMteList(mkt_hours: string, mins_passed: number, interval = 10) {
  const max_mkt_mins: Record<string, number> = {
    mkt_open: 390,
    pre_mkt: 330,
    post_mkt: 240,
    mkt_closed: 960,
  };

  const max_time = max_mkt_mins[mkt_hours];
  
  if (mkt_hours === 'mkt_closed') {
      // This case isn't used by the cron but good to have
      const parts = Math.floor(max_time / interval) + 1;
      const mte_list = Array.from({ length: parts }, (_, i) => max_time - (i * interval)).filter(t => t >= 0);
      if (mte_list.length === 0 || mte_list[mte_list.length - 1] !== 0) mte_list.push(0);
      return { mte_list, mte_len: mte_list.length };
  }

  // --- THIS IS THE FIX ---
  // The `mins_passed` argument is now ignored for the calculation,
  // so the mte_list is always the full list.
  // -----------------------
  const parts = Math.floor(max_time / interval) + 1; // +1 to include 0
  const mte_list = Array.from(
      { length: parts },
      (_, i) => max_time - (i * interval)
  );
  
  // Ensure list doesn't go negative and ends at 0
  while (mte_list.length > 0 && mte_list[mte_list.length - 1] < 0) {
      mte_list.pop();
  }
  if (mte_list.length === 0 || mte_list[mte_list.length - 1] !== 0) {
      mte_list.push(0);
  }
  
  const mte_len = mte_list.length;
  // mte_list will be [390, 380, 370, ..., 10, 0]
  return { mte_list, mte_len };
}

export interface GammaDf {
  index: number[];
  columns: number[];
  values: number[][];
}

export async function calc_gamma(
  ticker: string,
  mte_list: number[]
): Promise<{ df: GammaDf; spot: number }> {
  const { cookie, crumb } = await getYahooAuth();
  const authedHeaders = { ...YF_HEADERS, Cookie: cookie! };
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=5m&crumb=${crumb}`;
  const chartRes = await fetch(chartUrl, { headers: authedHeaders });
  if (!chartRes.ok) {
    if (chartRes.status === 401 || chartRes.status === 403) yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch chart/spot price: ${chartRes.status}`);
  }
  const chartJson = (await chartRes.json()) as any;
  const spot = chartJson?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!spot)
    throw new Error(`Could not get spot price for ${ticker} from chart API`);

  const optionsUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${crumb}`;
  const optionsRes = await fetch(optionsUrl, { headers: authedHeaders });
  if (!optionsRes.ok) {
    if (optionsRes.status === 401 || optionsRes.status === 403)
      yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch options dates: ${optionsRes.status}`);
  }
  const optionsJson = (await optionsRes.json()) as any;
  const exp_date_timestamp =
    optionsJson?.optionChain?.result?.[0]?.expirationDates?.[0];
  if (!exp_date_timestamp)
    throw new Error(`Could not get expiration dates for ${ticker}`);

  const chainUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${exp_date_timestamp}&crumb=${crumb}`;
  const chainRes = await fetch(chainUrl, { headers: authedHeaders });
  if (!chainRes.ok) {
    if (chainRes.status === 401 || chainRes.status === 403)
      yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch options chain: ${chainRes.status}`);
  }
  const chainJson = (await chainRes.json()) as any;
  const chain = chainJson?.optionChain?.result?.[0]?.options?.[0];
  if (!chain || !chain.calls || !chain.puts) {
    console.error(
      'Failed to parse chain. Full API response:',
      JSON.stringify(chainJson, null, 2)
    );
    throw new Error(`Could not fetch options chain for ${ticker}`);
  }
  const calls: any[] = chain.calls;
  const puts: any[] = chain.puts;
  const spot2 = spot * spot;
  const gamma_values_c: Record<string, number[]> = {};
  const gamma_values_p: Record<string, number[]> = {};
  const allStrikes = new Set<number>();
  calls.forEach((c) => {
    if (c.strike) allStrikes.add(c.strike);
    gamma_values_c[c.strike] = [];
  });
  puts.forEach((p) => {
    if (p.strike) allStrikes.add(p.strike);
    gamma_values_p[p.strike] = [];
  });
  for (const K of allStrikes) {
    for (const T of mte_list) {
      const call = calls.find((c) => c.strike === K);
      if (call) {
        const gex_cc = (call.openInterest || 0) * (call.volume || 0);
        const gamma_c = gamma_function_call(spot, K, T);
        const value = Math.round(gamma_c * gex_cc * spot2 * 0.01 * 10) / 10;
        gamma_values_c[K].push(value);
      } else {
        gamma_values_c[K]?.push(0);
      }
      const put = puts.find((p) => p.strike === K);
      if (put) {
        const gex_pp = (put.openInterest || 0) * (put.volume || 0);
        const gamma_p = gamma_function_put(spot, K, T);
        const value = Math.round(gamma_p * gex_pp * spot2 * 0.01 * 10) / 10;
        gamma_values_p[K].push(value);
      } else {
        gamma_values_p[K]?.push(0);
      }
    }
  }
  const df: GammaDf = {
    index: Array.from(allStrikes).sort((a, b) => b - a),
    columns: mte_list,
    values: [],
  };
  df.index.forEach((strike) => {
    const call_row = gamma_values_c[strike] || mte_list.map(() => 0);
    const put_row = gamma_values_p[strike] || mte_list.map(() => 0);
    const combined_row = call_row.map((call_val, i) => {
      const put_val = put_row[i] || 0;
      return (call_val || 0) + (put_val || 0);
    });
    df.values.push(combined_row);
  });
  return { df, spot };
}
export function gamma_function_call(S: number, K: number, T: number): number {
  const r = 0.05;
  const sigma = 0.2;
  const N = 10;
  const T_yrs = T / (365 * 24 * 60);
  const dt = T_yrs / N;
  if (dt <= 0) return 0;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp(r * dt) - d) / (u - d);
  if (p < 0 || p > 1 || isNaN(p)) return 0;
  const V0 = binomial_price(S, K, T_yrs, r, sigma, N, 'call');
  const V_u = binomial_price(S * u, K, T_yrs - dt, r, sigma, N - 1, 'call');
  const V_d = binomial_price(S * d, K, T_yrs - dt, r, sigma, N - 1, 'call');
  const delta_up = (V_u - V0) / (S * u - S);
  const delta_down = (V0 - V_d) / (S - S * d);
  const gamma = (delta_up - delta_down) / (0.5 * (S * u - S * d));
  return isNaN(gamma) ? 0 : gamma;
}
export function gamma_function_put(S: number, K: number, T: number): number {
  const r = 0.05;
  const sigma = 0.2;
  const N = 10;
  const T_yrs = T / (365 * 24 * 60);
  const dt = T_yrs / N;
  if (dt <= 0) return 0;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp(r * dt) - d) / (u - d);
  if (p < 0 || p > 1 || isNaN(p)) return 0;
  const V0 = binomial_price(S, K, T_yrs, r, sigma, N, 'put');
  const V_u = binomial_price(S * u, K, T_yrs - dt, r, sigma, N - 1, 'put');
  const V_d = binomial_price(S * d, K, T_yrs - dt, r, sigma, N - 1, 'put');
  const delta_up = (V_u - V0) / (S * u - S);
  const delta_down = (V0 - V_d) / (S - S * d);
  const gamma = (delta_up - delta_down) / (0.5 * (S * u - S * d));
  return isNaN(gamma) ? 0 : gamma;
}
export function binomial_price(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  N: number,
  type: 'call' | 'put'
): number {
  if (N <= 0 || T <= 0) {
    if (type === 'call') return Math.max(0, S - K);
    else return Math.max(0, K - S);
  }
  const dt = T / N;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp(r * dt) - d) / (u - d);
  if (p < 0 || p > 1 || isNaN(p))
    return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
  const df = Math.exp(-r * dt);
  let option_values: number[] = new Array(N + 1);
  for (let j = 0; j <= N; j++) {
    const ST = S * Math.pow(u, j) * Math.pow(d, N - j);
    option_values[j] =
      type === 'call' ? Math.max(0, ST - K) : Math.max(0, K - ST);
  }
  for (let i = N - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const ST = S * Math.pow(u, j) * Math.pow(d, i - j);
      const intrinsic_value =
        type === 'call' ? Math.max(0, ST - K) : Math.max(0, K - ST);
      const expected_value =
        df * (p * option_values[j + 1] + (1 - p) * option_values[j]);
      option_values[j] = Math.max(intrinsic_value, expected_value);
    }
  }
  return option_values[0];
}
export function getChartLimits(df: GammaDf, mte_len: number) {
  const y_axis_strikes = df.index;
  const heatmap_values = df.values;
  const near_expiry_start_index = Math.round(mte_len * 0.9);
  const near_expiry_count = mte_len - near_expiry_start_index;
  if (near_expiry_count <= 0) {
    if (y_axis_strikes.length === 0) return { limit_up: 100, limit_down: 0 };
    const min_strike = Math.min(...y_axis_strikes);
    const max_strike = Math.max(...y_axis_strikes);
    return {
      limit_up: Math.round(max_strike * 1.01),
      limit_down: Math.round(min_strike * 0.99),
    };
  }
  let max_strike_sum = 0;
  let min_strike_sum = 0;
  for (let i = near_expiry_start_index; i < mte_len; i++) {
    let max_val_in_col = -Infinity;
    let min_val_in_col = Infinity;
    let max_strike_for_col = y_axis_strikes[0];
    let min_strike_for_col = y_axis_strikes[0];
    for (let j = 0; j < y_axis_strikes.length; j++) {
      const val = heatmap_values[j][i];
      if (val > max_val_in_col) {
        max_val_in_col = val;
        max_strike_for_col = y_axis_strikes[j];
      }
      if (val < min_val_in_col) {
        min_val_in_col = val;
        min_strike_for_col = y_axis_strikes[j];
      }
    }
    max_strike_sum += max_strike_for_col;
    min_strike_sum += min_strike_for_col;
  }
  const limit_up = Math.round((max_strike_sum / near_expiry_count) * 1.01);
  const limit_down = Math.round((min_strike_sum / near_expiry_count) * 0.99);
  return { limit_up, limit_down };
}

// This is the makeCS function from get-ohlc.ts
export type ValidInterval = "1m" | "2m" | "5m" | "15m" | "30m";

export async function makeCS(ticker: string, interval: string, mkt_hours: string) {
  const { cookie, crumb } = await getYahooAuth();
  // Keep range=2d, it helps provide enough data
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2d&interval=${interval}&includePrePost=true&crumb=${crumb}`;
  
  const res = await fetch(url, {
    headers: {
      ...YF_HEADERS,
      'Cookie': cookie!,
    }
  });

  const json: any = await res.json();
  const result = json?.chart?.result?.[0];

  if (!result || !result.timestamp || !result.indicators.quote[0]) {
    throw new Error('Invalid API response from Yahoo Finance');
  }
  const quotes = result.indicators.quote[0];
  const timestamps = result.timestamp;
  let valid_quotes: { open: number, high: number, low: number, close: number, timestamp: number }[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quotes.open[i] && quotes.high[i] && quotes.low[i] && quotes.close[i]) {
      valid_quotes.push({
        open: quotes.open[i],
        high: quotes.high[i],
        low: quotes.low[i],
        close: quotes.close[i],
        timestamp: timestamps[i]
      });
    }
  }

  const open_slicer: Record<string, number> = { "1m": 308, "2m": 157, "5m": 63, "15m": 21, "30m": 11 };
  const post_slicer: Record<string, number> = { "1m": 702, "2m": 353, "5m": 141, "15m": 47, "30m": 24 };
  const pre_max_cs: Record<string, number> = { "1m": 330, "2m": 165, "5m": 66, "15m": 22, "30m": 11 };
  const open_max_cs: Record<string, number> = { "1m": 390, "2m": 195, "5m": 78, "15m": 26, "30m": 13 };
  const post_max_cs: Record<string, number> = { "1m": 240, "2m": 120, "5m": 48, "15m": 16, "30m": 8 };
  const closed_max_cs: Record<string, number> = { "1m": 960, "2m": 480, "5m": 192, "15m": 64, "30m": 32 };
  
  let range_start = 0;
  let max_cs = 0;
  let sliced_quotes = valid_quotes;

// --- ADD SAFETY CHECKS TO SLICING LOGIC ---
  if (mkt_hours === 'pre_mkt') {
    range_start = 330;
    max_cs = pre_max_cs[interval];
    sliced_quotes = valid_quotes.slice(0, max_cs + 1);
  } else if (mkt_hours === 'mkt_open') {
    range_start = 390;
    max_cs = open_max_cs[interval];
    
    let slice_start = open_slicer[interval];
    if (slice_start >= valid_quotes.length) {
        console.warn(`OHLC 'mkt_open' slicer index ${slice_start} out of bounds. Using all ${valid_quotes.length} quotes.`);
        slice_start = 0; // Use all data
    }
    sliced_quotes = valid_quotes.slice(slice_start);

  } else if (mkt_hours === 'post_mkt') {
    range_start = 240;
    max_cs = post_max_cs[interval];
    
    let slice_start = post_slicer[interval];
    if (slice_start >= valid_quotes.length) {
        console.warn(`OHLC 'post_mkt' slicer index ${slice_start} out of bounds. Using all ${valid_quotes.length} quotes.`);
        slice_start = 0; // Use all data
    }
    sliced_quotes = valid_quotes.slice(slice_start);

  } else if (mkt_hours === 'mkt_closed') {
    range_start = 960;
    max_cs = closed_max_cs[interval];
    sliced_quotes = valid_quotes;
  }
  // --- END OF SAFETY CHECKS ---

  // Safety for the x-axis calculation
  const x_axis_mte = Array.from(
    { length: sliced_quotes.length > 0 ? sliced_quotes.length : 1 }, // Prevent length 0
    (_, i) => range_start - i * (range_start / (sliced_quotes.length - 1 || 1))
  );

  const ohlc = {
    x: x_axis_mte,
    open: sliced_quotes.map(q => q.open),
    high: sliced_quotes.map(q => q.high),
    low: sliced_quotes.map(q => q.low),
    close: sliced_quotes.map(q => q.close),
  };
  
  // If we ended up with no data, return empty arrays but don't crash
  if (sliced_quotes.length === 0) {
      console.error("OHLC slicing resulted in 0 quotes. Returning empty chart.");
      return { ohlc: { x: [], open: [], high: [], low: [], close: [] }, mktHoursRange: [range_start, 0] };
  }
  
  return { ohlc, mktHoursRange: [range_start, 0] };
}