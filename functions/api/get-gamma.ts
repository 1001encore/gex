// --- The Golden Headers ---
// Use these for EVERY fetch
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Connection': 'keep-alive',
};

// No imports needed
export const onRequest = async (context: { request: Request }): Promise<Response> => {
  try {
    const url = new URL(context.request.url);
    const ticker = url.searchParams.get('ticker')?.toUpperCase() || 'SPY';
    const { mkt_hours, mins_passed } = getMarketStatus('Asia/Istanbul');
    if (mkt_hours === 'mkt_closed') {
      console.log('Market is closed, showing last available map.');
    }
    const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
    
    // We are back to the simple 3-fetch call, all on query1
    const { df, spot } = await calc_gamma(ticker, mte_list);
    
    const { limit_up, limit_down } = getChartLimits(df, mte_len);
    const heatmapTrace = {
      type: 'heatmap',
      x: df.columns,
      y: df.index,
      z: df.values,
      colorscale: 'Edge',
      zmid: 0,
      zsmooth: 'best',
      xaxis: 'x',
      yaxis: 'y',
    };
    const responsePayload = {
      heatmapTrace,
      limits: { up: limit_up, down: limit_down },
      mteList: mte_list,
      spot,
      marketTime: new Date().toLocaleString('en-US', { timeZone: 'Asia/Istanbul' }),
      marketStatus: mkt_hours,
    };
    return new Response(JSON.stringify(responsePayload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=60', // Cache for 60 seconds
      },
    });
  } catch (error) {
    console.error('Error in get-gamma function:', error);
    const err = error as Error;
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// --- Helper Functions ---

function getMarketStatus(timeZone: string): { mkt_hours: string; mins_passed: number } {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
  const mkt_open = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 30, 0);
  const dayOfWeek = now.getDay(); 
  const nowInTZ = new Date(now.toLocaleString('en-US', { timeZone }));
  const mktOpenInTZ = new Date(mkt_open.toLocaleString('en-US', { timeZone }));
  const mins_passed = Math.floor((nowInTZ.getTime() - mktOpenInTZ.getTime()) / 60000);
  if (dayOfWeek === 0 || dayOfWeek === 6) return { mkt_hours: 'mkt_closed', mins_passed };
  if (mins_passed > 630 && mins_passed < 1110) return { mkt_hours: 'mkt_closed', mins_passed };
  if (mins_passed >= 390 && mins_passed <= 630) return { mkt_hours: 'post_mkt', mins_passed };
  if (mins_passed >= 0 && mins_passed <= 390) return { mkt_hours: 'mkt_open', mins_passed };
  if (mins_passed >= 1110 && mins_passed <= 1440) return { mkt_hours: 'pre_mkt', mins_passed };
  return { mkt_hours: 'mkt_closed', mins_passed };
}

function getMteList(mkt_hours: string, mins_passed: number, interval = 10) {
  const max_mkt_mins: Record<string, number> = {
    "mkt_open": 390, "pre_mkt": 330, "post_mkt": 240, "mkt_closed": 960,
  };
  let current_interval = Math.floor(mins_passed / 10) * 10;
  let parts = Math.floor((max_mkt_mins[mkt_hours] - current_interval) / 10);
  if (mkt_hours === 'pre_mkt') current_interval -= 1110;
  else if (mkt_hours === 'mkt_open') current_interval -= 0;
  else if (mkt_hours === 'post_mkt') current_interval -= 390;
  else if (mkt_hours === 'mkt_closed') { current_interval = 480; parts = 48; }
  if (parts < 5) {
    current_interval = (Math.floor(max_mkt_mins[mkt_hours] / interval) - 5) * interval;
    parts = 5;
  }
  const mte_list = Array.from(
    { length: parts },
    (_, i) => max_mkt_mins[mkt_hours] - i * (max_mkt_mins[mkt_hours] - current_interval) / (parts - 1 || 1)
  ).map(Math.floor);
  const mte_len = mte_list.length;
  return { mte_list, mte_len };
}

// This object will hold our cached auth.
let yahooAuth: { cookie: string | null; crumb: string | null; expiry: number } = {
  cookie: null,
  crumb: null,
  expiry: 0,
};

// How long to cache the auth in milliseconds (e.g., 15 minutes)
const AUTH_TTL_MS = 15 * 60 * 1000;

// --- FIX 1: A proper, Promise-based lock to prevent race conditions ---
let authRefreshPromise: Promise<{ cookie: string; crumb: string }> | null = null;

async function refreshYahooAuth(): Promise<{ cookie: string; crumb: string }> {
  console.log('--- Starting new Yahoo auth refresh... ---');
  
  const consentCookie = 'A3=d=AQAB&S=AQABCAFFp2QAAAAifp2Q-Z3-l1kBEiL2S-sYBwEBAgABBwE-mAAAAg&Y=YAIA';

  // 1. Fetch page to get cookies
  const headersWithConsent = {
    ...YF_HEADERS, // Use the golden headers
    'Cookie': consentCookie,
  };
  
  const cookieRes = await fetch('https://finance.yahoo.com/quote/SPY', {
    headers: headersWithConsent, // Use the combined headers
    cache: 'no-cache',
    redirect: 'follow',
  });

  // 2. Get new cookies
  const setCookieHeaders = cookieRes.headers.getSetCookie();
  if (!setCookieHeaders || setCookieHeaders.length === 0) {
    console.error(`Failed to get Yahoo cookie headers. Status: ${cookieRes.status} ${cookieRes.statusText}`);
    const body = await cookieRes.text();
    console.error('Response body snippet:', body.substring(0, 500));
    if (body.includes('guce.yahoo.com')) {
      throw new Error('Failed to get Yahoo cookie. STILL seeing consent page despite all new headers.');
    }
    throw new Error('Failed to get Yahoo cookie. No consent page, but no cookies either.');
  }

  // 3. Combine cookies
  const receivedCookies = setCookieHeaders.join('; ');
  const cookie = consentCookie + '; ' + receivedCookies;

  // 4. Use combined cookies to get crumb
  const headersWithFullCookie = {
    ...YF_HEADERS, // Use the golden headers
    'Cookie': cookie,
  };

  const crumbRes = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: headersWithFullCookie, // Use the combined headers
    cache: 'no-cache',
  });

  if (!crumbRes.ok) {
    throw new Error(`Failed to get Yahoo crumb: ${crumbRes.statusText} ${await crumbRes.text()}`);
  }

  const crumb = await crumbRes.text();
  if (!crumb) {
    throw new Error('Crumb response was empty.');
  }

  // 5. Cache the new, combined auth
  const newAuth = {
    cookie, // This is a string
    crumb,  // This is a string
  };
  
  yahooAuth = {
    ...newAuth,
    expiry: Date.now() + AUTH_TTL_MS,
  };
  
  console.log('--- Successfully refreshed Yahoo auth. ---');
  return newAuth; // <-- NOW WE RETURN THE NEW OBJECT, WHICH MATCHES THE PROMISE
}
/**
 * Gets the cached cookie and crumb, refreshing if needed.
 * --- FIX 1: Now uses a robust Promise-based lock ---
 */
async function getYahooAuth() {
  // 1. Check if auth is valid
  if (Date.now() <= yahooAuth.expiry && yahooAuth.cookie && yahooAuth.crumb) {
    return yahooAuth;
  }

  // 2. Check if another request is *already* refreshing
  if (authRefreshPromise) {
    console.log('Auth refresh already in progress, awaiting...');
    // Wait for the existing refresh promise to finish
    return await authRefreshPromise;
  }

  // 3. If not, we are the first. Create the refresh promise and store it.
  console.log('Auth expired. This request is triggering a refresh.');
  authRefreshPromise = refreshYahooAuth();

  try {
    // Wait for our new promise to finish and return its result
    const newAuth = await authRefreshPromise;
    return newAuth;
  } catch (error) {
    console.error('Yahoo auth refresh failed:', error);
    // The refresh failed, but we still re-throw the error
    // so the caller (makeCS/calc_gamma) can fail gracefully.
    throw error;
  } finally {
    // 4. IMPORTANT: Win or lose, clear the promise
    // This allows the *next* request to trigger a new refresh.
    authRefreshPromise = null;
  }
}


async function calc_gamma(ticker: string, mte_list: number[]) {
  // 1. Get auth
  const { cookie, crumb } = await getYahooAuth();

  // 2. Define headers to be reused <-- THIS IS THE FIX
  const authedHeaders = {
    ...YF_HEADERS,     // Use the golden headers
    'Cookie': cookie!, // Add the auth cookie
  };
  // --- END FIX ---
  
  // --- Call 1: Get Spot Price ---
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=5m&crumb=${crumb}`;
  const chartRes = await fetch(chartUrl, { headers: authedHeaders }); // Use authedHeaders
  
  if (!chartRes.ok) {
    if (chartRes.status === 401 || chartRes.status === 403) yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch chart/spot price: ${chartRes.status} ${chartRes.statusText}`);
  }
  
  // THIS IS THE FIXED LINE:
  const chartJson: any = await chartRes.json();
  const spot = chartJson?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!spot) throw new Error(`Could not get spot price for ${ticker} from chart API`);

  // --- Call 2: Get Expiration Dates ---
  const optionsUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${crumb}`;
  const optionsRes = await fetch(optionsUrl, { headers: authedHeaders }); // Use authedHeaders

  if (!optionsRes.ok) {
    if (optionsRes.status === 401 || optionsRes.status === 403) yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch options dates: ${optionsRes.status} ${optionsRes.statusText}`);
  }
  const optionsJson: any = await optionsRes.json();
  const exp_date_timestamp = optionsJson?.optionChain?.result?.[0]?.expirationDates?.[0];
  if (!exp_date_timestamp) throw new Error(`Could not get expiration dates for ${ticker}`);

  // --- Call 3: Get Full Options Chain ---
  const chainUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${exp_date_timestamp}&crumb=${crumb}`;
  const chainRes = await fetch(chainUrl, { headers: authedHeaders }); // Use authedHeaders
  
  if (!chainRes.ok) {
    if (chainRes.status === 401 || chainRes.status === 403) yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch options chain: ${chainRes.status} ${chainRes.statusText}`);
  }
  
  // --- DEBUGGING STEP ---
  // Let's log what we get, just in case
  const chainJson: any = await chainRes.json();
  // THIS IS THE FIXED LINE:
  const chain = chainJson?.optionChain?.result?.[0]?.options?.[0];
  
  if (!chain || !chain.calls || !chain.puts) {
    console.error("Failed to parse chain. Full API response:", JSON.stringify(chainJson, null, 2));
    throw new Error(`Could not fetch options chain for ${ticker}`);
  }
  
  const calls: any[] = chain.calls;
  const puts: any[] = chain.puts;
  
  const spot2 = spot * spot;
  const mte_len = mte_list.length;

  const gamma_values_c: Record<string, number[]> = {};
  const gamma_values_p: Record<string, number[]> = {};
  const allStrikes = new Set<number>();
  
  calls.forEach(c => { if(c.strike) allStrikes.add(c.strike); gamma_values_c[c.strike] = [] });
  puts.forEach(p => { if(p.strike) allStrikes.add(p.strike); gamma_values_p[p.strike] = [] });

  for (const K of allStrikes) {
    for (const T of mte_list) {
      const call = calls.find(c => c.strike === K);
      if (call) {
        const gex_cc = (call.openInterest || 0) * (call.volume || 0);
        const gamma_c = gamma_function_call(spot, K, T);
        const value = Math.round(gamma_c * gex_cc * spot2 * 0.01 * 10) / 10;
        gamma_values_c[K].push(value);
      } else {
        gamma_values_c[K]?.push(0);
      }
      const put = puts.find(p => p.strike === K);
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

  const df: { index: number[]; columns: number[]; values: number[][] } = {
    index: Array.from(allStrikes).sort((a, b) => b - a),
    columns: mte_list,
    values: [],
  };
  
  df.index.forEach(strike => {
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
// ... (gamma_function_call, gamma_function_put, binomial_price, getChartLimits functions are the same) ...
function gamma_function_call(S: number, K: number, T: number): number {
  const r = 0.05; const sigma = 0.2; const N = 10;
  const T_yrs = T / (365 * 24 * 60); const dt = T_yrs / N;
  if (dt <= 0) return 0;
  const u = Math.exp(sigma * Math.sqrt(dt)); const d = 1 / u;
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
function gamma_function_put(S: number, K: number, T: number): number {
  const r = 0.05; const sigma = 0.2; const N = 10;
  const T_yrs = T / (365 * 24 * 60); const dt = T_yrs / N;
  if (dt <= 0) return 0;
  const u = Math.exp(sigma * Math.sqrt(dt)); const d = 1 / u;
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
function binomial_price(S: number, K: number, T: number, r: number, sigma: number, N: number, type: 'call' | 'put'): number {
  if (N <= 0 || T <= 0) {
    if (type === 'call') return Math.max(0, S - K); else return Math.max(0, K - S);
  }
  const dt = T / N;
  const u = Math.exp(sigma * Math.sqrt(dt)); const d = 1 / u;
  const p = (Math.exp(r * dt) - d) / (u - d);
  if (p < 0 || p > 1 || isNaN(p)) return (type === 'call') ? Math.max(0, S-K) : Math.max(0, K-S);
  const df = Math.exp(-r * dt);
  let option_values: number[] = new Array(N + 1);
  for (let j = 0; j <= N; j++) {
    const ST = S * Math.pow(u, j) * Math.pow(d, N - j);
    option_values[j] = (type === 'call') ? Math.max(0, ST - K) : Math.max(0, K - ST);
  }
  for (let i = N - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const ST = S * Math.pow(u, j) * Math.pow(d, i - j);
      const intrinsic_value = (type === 'call') ? Math.max(0, ST - K) : Math.max(0, K - ST);
      const expected_value = df * (p * option_values[j + 1] + (1 - p) * option_values[j]);
      option_values[j] = Math.max(intrinsic_value, expected_value);
    }
  }
  return option_values[0];
}
function getChartLimits(df: { index: number[]; columns: number[]; values: number[][] }, mte_len: number) {
  const y_axis_strikes = df.index;
  const heatmap_values = df.values;
  const near_expiry_start_index = Math.round(mte_len * 0.9);
  const near_expiry_count = mte_len - near_expiry_start_index;
  if (near_expiry_count <= 0) {
    if (y_axis_strikes.length === 0) return { limit_up: 100, limit_down: 0 };
    const min_strike = Math.min(...y_axis_strikes);
    const max_strike = Math.max(...y_axis_strikes);
    return { limit_up: max_strike * 1.01, limit_down: min_strike * 0.99 };
  }
  let max_strike_sum = 0;
  let min_strike_sum = 0;
  for (let i = near_expiry_start_index; i < mte_len; i++) {
    let max_val_in_col = -Infinity; let min_val_in_col = Infinity;
    let max_strike_for_col = y_axis_strikes[0]; let min_strike_for_col = y_axis_strikes[0];
    for (let j = 0; j < y_axis_strikes.length; j++) {
      const val = heatmap_values[j][i];
      if (val > max_val_in_col) { max_val_in_col = val; max_strike_for_col = y_axis_strikes[j]; }
      if (val < min_val_in_col) { min_val_in_col = val; min_strike_for_col = y_axis_strikes[j]; }
    }
    max_strike_sum += max_strike_for_col;
    min_strike_sum += min_strike_for_col;
  }
  const limit_up = Math.round((max_strike_sum / near_expiry_count) * 1.01);
  const limit_down = Math.round((min_strike_sum / near_expiry_count) * 0.99);
  return { limit_up, limit_down };
}