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

// backend/src/lib.ts

export async function refreshYahooAuth(): Promise<{
  cookie: string;
  crumb: string;
}> {
  console.log('--- Starting new Yahoo auth refresh (v4) ---');

  // 1. Fetch fc.yahoo.com to initialize the session (more reliable)
  // We don't care about the body, just the set-cookie headers
  const initRes = await fetch('https://fc.yahoo.com', {
    headers: YF_HEADERS,
    redirect: 'follow',
  });

  const setCookieHeaders: string[] = [];
  initRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      setCookieHeaders.push(value.split(';')[0]);
    }
  });

  // If fc.yahoo.com fails to set cookies, fallback to main page
  if (setCookieHeaders.length === 0) {
    console.log('fc.yahoo.com returned no cookies, trying finance.yahoo.com...');
    const fallbackRes = await fetch('https://finance.yahoo.com/quote/SPY', {
      headers: YF_HEADERS,
      redirect: 'follow',
    });
    fallbackRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        setCookieHeaders.push(value.split(';')[0]);
      }
    });
  }

  if (setCookieHeaders.length === 0) {
    throw new Error('Failed to get Yahoo cookies from both fc.yahoo.com and fallback.');
  }

  const cookie = setCookieHeaders.join('; ');
  const headersWithFullCookie = { ...YF_HEADERS, Cookie: cookie };

  // 2. Get the Crumb
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

/**
 * Generates the standardized storage key for the DO.
 * @param ticker The stock ticker (e.g. 'SPY')
 * @param timeZone The app's timezone (e.g., 'America/New_York')
 * @returns { key: string, session: string }
 */
export function getStorageKey(
  ticker: string,
  timeZone: string,
  now = new Date(),
  mode = 'gex'
): { key: string, session: string } {
  const dateStr = getDateStr(0, timeZone, now);
  const { mkt_hours } = getMarketStatus(timeZone, now);

  // Key format: data_MODE_TICKER_YYYY-MM-DD_SESSION
  return {
    key: `data_${mode.toLowerCase()}_${ticker.toUpperCase()}_${dateStr}_${mkt_hours}`,
    session: mkt_hours
  };
}

/**
 * Gets a date string for X days ago.
 * @param daysAgo How many days ago
 * @param timeZone The app's timeZone
 * @returns YYYY-MM-DD string
 */
export function getDateStr(daysAgo: number, timeZone: string, now = new Date()): string {
  const parts = getZonedParts(now, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - daysAgo));
  const year = shifted.getUTCFullYear();
  const month = (shifted.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = shifted.getUTCDate().toString().padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getMarketStatus(timeZone: string): {
  mkt_hours: string;
  mins_passed: number;
};
export function getMarketStatus(timeZone: string, now: Date): {
  mkt_hours: string;
  mins_passed: number;
};
export function getMarketStatus(timeZone: string, now = new Date()): {
  mkt_hours: string;
  mins_passed: number;
} {
  const parts = getZonedParts(now, timeZone);
  const marketOpenMinute = 9 * 60 + 30;
  const marketCloseMinute = 16 * 60;
  const currentMinute = parts.hour * 60 + parts.minute;
  const mins_passed = currentMinute - marketOpenMinute;

  // Options market is only open during regular hours (6.5h = 390 mins)
  if (parts.dayOfWeek === 0 || parts.dayOfWeek === 6)
    return { mkt_hours: 'mkt_closed', mins_passed };

  if (currentMinute >= marketOpenMinute && currentMinute < marketCloseMinute)
    return { mkt_hours: 'mkt_open', mins_passed };

  return { mkt_hours: 'mkt_closed', mins_passed };
}

function getZonedParts(date: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    dayOfWeek: dayMap[values.weekday] ?? 0,
  };
}

export function getMteList(mkt_hours: string, mins_passed: number, interval = 1) {
  // Market open: full 390-minute grid [390, 389, ..., 0]
  if (mkt_hours === 'mkt_open') {
    const parts = Math.floor(390 / interval) + 1;
    return {
      mte_list: Array.from({ length: parts }, (_, i) => 390 - (i * interval)),
      mte_len: parts,
    };
  }

  // Closed: show full day grid for display purposes
  const max_time = 960;
  const parts = Math.floor(max_time / interval) + 1;
  const mte_list = Array.from({ length: parts }, (_, i) => max_time - (i * interval));
  while (mte_list.length > 0 && mte_list[mte_list.length - 1] < 0) mte_list.pop();
  if (mte_list.length === 0 || mte_list[mte_list.length - 1] !== 0) mte_list.push(0);
  return { mte_list, mte_len: mte_list.length };
}

export interface GammaDf {
  index: number[];
  columns: number[];
  values: number[][];
}

export type ExposureMode = 'gex' | 'vex';

export interface ExposureOptions {
  mode?: ExposureMode;
  expirations?: number;
  now?: Date;
}

export interface ExposureMatrix {
  ticker: string;
  mode: ExposureMode;
  spot: number;
  strikes: number[];
  columns: string[];
  values: number[][];
}

export async function calc_gamma(
  ticker: string,
  mte_list: number[],
  options: ExposureOptions = {}
): Promise<{ df: GammaDf; spot: number }> {
  return calc_exposure(ticker, mte_list, { ...options, mode: options.mode || 'gex' });
}

export async function calc_exposure(
  ticker: string,
  mte_list: number[],
  options: ExposureOptions = {}
): Promise<{ df: GammaDf; spot: number }> {
  const mode = options.mode || 'gex';
  const expirationCount = Math.max(1, Math.min(12, options.expirations || 3));
  const now = options.now || new Date();
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
  const expirationDates: number[] =
    optionsJson?.optionChain?.result?.[0]?.expirationDates?.slice(0, expirationCount) || [];
  if (expirationDates.length === 0)
    throw new Error(`Could not get expiration dates for ${ticker}`);

  const exposureByStrike: Record<string, number[]> = {};
  const allStrikes = new Set<number>();

  for (const expiration of expirationDates) {
    const chainUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${expiration}&crumb=${crumb}`;
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

    for (const contract of [...chain.calls, ...chain.puts]) {
      if (!contract.strike) continue;
      allStrikes.add(contract.strike);
      exposureByStrike[contract.strike] ||= mte_list.map(() => 0);
    }

    const callsByStrike = new Map<number, any>(chain.calls.map((contract: any) => [contract.strike, contract]));
    const putsByStrike = new Map<number, any>(chain.puts.map((contract: any) => [contract.strike, contract]));

    for (const K of allStrikes) {
      exposureByStrike[K] ||= mte_list.map(() => 0);
      const call = callsByStrike.get(K);
      const put = putsByStrike.get(K);

      for (let i = 0; i < mte_list.length; i++) {
        const projectedMinutesElapsed = 390 - mte_list[i];
        const minutesToExpiration = getMinutesToExpiration(expiration, now, projectedMinutesElapsed);
        const callValue = call ? calcContractExposure(mode, 'call', spot, K, minutesToExpiration, call) : 0;
        const putValue = put ? calcContractExposure(mode, 'put', spot, K, minutesToExpiration, put) : 0;
        exposureByStrike[K][i] += callValue + putValue;
      }
    }
  }

  const df: GammaDf = {
    index: Array.from(allStrikes).sort((a, b) => b - a),
    columns: mte_list,
    values: [],
  };
  df.index.forEach((strike) => {
    df.values.push((exposureByStrike[strike] || mte_list.map(() => 0)).map((value) => Math.round(value * 10) / 10));
  });
  return { df, spot };
}

export async function calc_expiry_matrix(
  ticker: string,
  options: ExposureOptions = {}
): Promise<ExposureMatrix> {
  const mode = options.mode || 'gex';
  const expirationCount = Math.max(1, Math.min(30, options.expirations || 3));
  const now = options.now || new Date();
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
  if (!spot) throw new Error(`Could not get spot price for ${ticker} from chart API`);

  const optionsUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${crumb}`;
  const optionsRes = await fetch(optionsUrl, { headers: authedHeaders });
  if (!optionsRes.ok) {
    if (optionsRes.status === 401 || optionsRes.status === 403) yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch options dates: ${optionsRes.status}`);
  }
  const optionsJson = (await optionsRes.json()) as any;
  const expirationDates: number[] =
    optionsJson?.optionChain?.result?.[0]?.expirationDates?.slice(0, expirationCount) || [];
  if (expirationDates.length === 0) throw new Error(`Could not get expiration dates for ${ticker}`);

  const exposureByStrike: Record<string, number[]> = {};
  const allStrikes = new Set<number>();

  for (let columnIndex = 0; columnIndex < expirationDates.length; columnIndex++) {
    const expiration = expirationDates[columnIndex];
    const chainUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${expiration}&crumb=${crumb}`;
    const chainRes = await fetch(chainUrl, { headers: authedHeaders });
    if (!chainRes.ok) {
      if (chainRes.status === 401 || chainRes.status === 403) yahooAuth.expiry = 0;
      throw new Error(`Failed to fetch options chain: ${chainRes.status}`);
    }
    const chainJson = (await chainRes.json()) as any;
    const chain = chainJson?.optionChain?.result?.[0]?.options?.[0];
    if (!chain || !chain.calls || !chain.puts) {
      throw new Error(`Could not fetch options chain for ${ticker}`);
    }

    for (const contract of [...chain.calls, ...chain.puts]) {
      if (!contract.strike) continue;
      allStrikes.add(contract.strike);
      exposureByStrike[contract.strike] ||= expirationDates.map(() => 0);
    }

    for (const contract of chain.calls) {
      if (!contract.strike) continue;
      exposureByStrike[contract.strike][columnIndex] += calcContractExposure(
        mode,
        'call',
        spot,
        contract.strike,
        getMinutesToExpiration(expiration, now, 0),
        contract
      );
    }
    for (const contract of chain.puts) {
      if (!contract.strike) continue;
      exposureByStrike[contract.strike][columnIndex] += calcContractExposure(
        mode,
        'put',
        spot,
        contract.strike,
        getMinutesToExpiration(expiration, now, 0),
        contract
      );
    }
  }

  const strikes = Array.from(allStrikes).sort((a, b) => b - a);
  return {
    ticker,
    mode,
    spot,
    strikes,
    columns: expirationDates.map((expiration) => new Date(expiration * 1000).toISOString().slice(0, 10)),
    values: strikes.map((strike) => (exposureByStrike[strike] || expirationDates.map(() => 0)).map((value) => Math.round(value * 10) / 10)),
  };
}

function getMinutesToExpiration(expirationTimestampSeconds: number, now: Date, projectedMinutesElapsed: number): number {
  const expirationMs = expirationTimestampSeconds * 1000;
  const projectedNowMs = now.getTime() + projectedMinutesElapsed * 60_000;
  return Math.max(1, (expirationMs - projectedNowMs) / 60_000);
}

function calcContractExposure(
  mode: ExposureMode,
  type: 'call' | 'put',
  S: number,
  K: number,
  minutesToExpiration: number,
  contract: any
): number {
  const sigma = Number(contract.impliedVolatility) > 0 ? Number(contract.impliedVolatility) : 0.2;
  const openInterest = Number(contract.openInterest || 0);
  const volume = Number(contract.volume || 0);
  const contractCount = openInterest + volume * 0.25;
  if (!contractCount) return 0;

  const sign = type === 'call' ? 1 : -1;
  if (mode === 'vex') {
    const vanna = blackScholesVanna(S, K, minutesToExpiration, sigma);
    return sign * vanna * contractCount * S * 0.01;
  }

  const gamma = blackScholesGamma(S, K, minutesToExpiration, sigma);
  return sign * gamma * contractCount * S * S * 0.01;
}

export function blackScholesGamma(S: number, K: number, minutesToExpiration: number, sigma: number, r = 0.05): number {
  const T = minutesToExpiration / (365 * 24 * 60);
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normalPdf(d1) / (S * sigma * Math.sqrt(T));
}

export function blackScholesVanna(S: number, K: number, minutesToExpiration: number, sigma: number, r = 0.05): number {
  const T = minutesToExpiration / (365 * 24 * 60);
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return -normalPdf(d1) * d2 / sigma;
}

function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
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
  const open_max_cs: Record<string, number> = { "1m": 390, "2m": 195, "5m": 78, "15m": 26, "30m": 13 };
  const closed_max_cs: Record<string, number> = { "1m": 960, "2m": 480, "5m": 192, "15m": 64, "30m": 32 };

  let range_start = 0;
  let sliced_quotes = valid_quotes;

  if (mkt_hours === 'mkt_open') {
    range_start = 390;
    let slice_start = open_slicer[interval];
    if (slice_start >= valid_quotes.length) {
      console.warn(`OHLC slicer index ${slice_start} out of bounds. Using all ${valid_quotes.length} quotes.`);
      slice_start = 0;
    }
    sliced_quotes = valid_quotes.slice(slice_start);
  } else {
    // mkt_closed — show full available data
    range_start = 960;
    sliced_quotes = valid_quotes;
  }

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
