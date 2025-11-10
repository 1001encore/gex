// --- The Golden Headers ---
// Use these for EVERY fetch
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Connection': 'keep-alive',
};

type ValidInterval = "1m" | "2m" | "5m" | "15m" | "30m";
const validIntervals: ValidInterval[] = ["1m", "2m", "5m", "15m", "30m"];

// This is the main function, no more yahooFinance import
export const onRequest = async (context: { request: Request }): Promise<Response> => {
  try {
    const url = new URL(context.request.url);
    const ticker = url.searchParams.get('ticker')?.toUpperCase() || 'SPY';
    
    const intervalParam = url.searchParams.get('interval') || '5m';
    if (!validIntervals.includes(intervalParam as ValidInterval)) {
      throw new Error('Invalid interval.');
    }
    const interval: ValidInterval = intervalParam as ValidInterval;

    const { mkt_hours } = getMarketStatus('Asia/Istanbul');
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
    };

    const responsePayload = {
      ohlcTrace,
      mktHoursRange,
    };
    
    return new Response(JSON.stringify(responsePayload), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=60',
      },
    });

  } catch (error) {
    console.error('Error in get-ohlc function:', error);
    const err = error as Error;
    return new Response(JSON.stringify({ error: err.message, stack: err.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

// ... (getMarketStatus function remains the same) ...
function getMarketStatus(timeZone: string): { mkt_hours: string } {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone }));
    const mkt_open = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 30, 0);
    const dayOfWeek = now.getDay();
    const nowInTZ = new Date(now.toLocaleString('en-US', { timeZone }));
    const mktOpenInTZ = new Date(mkt_open.toLocaleString('en-US', { timeZone }));
    const mins_passed = Math.floor((nowInTZ.getTime() - mktOpenInTZ.getTime()) / 60000);

    if (dayOfWeek === 0 || dayOfWeek === 6) return { mkt_hours: 'mkt_closed' };
    if (mins_passed > 630 && mins_passed < 1110) return { mkt_hours: 'mkt_closed' };
    if (mins_passed >= 390 && mins_passed <= 630) return { mkt_hours: 'post_mkt' };
    if (mins_passed >= 0 && mins_passed <= 390) return { mkt_hours: 'mkt_open' };
    if (mins_passed >= 1110 && mins_passed <= 1440) return { mkt_hours: 'pre_mkt' };
    return { mkt_hours: 'mkt_closed' };
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

async function makeCS(ticker: string, interval: ValidInterval, mkt_hours: string) {
  const { cookie, crumb } = await getYahooAuth();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=${interval}&includePrePost=true&crumb=${crumb}`;

  // --- THIS IS THE FIX ---
  const res = await fetch(url, {
    headers: {
      ...YF_HEADERS,     // Use the golden headers
      'Cookie': cookie!, // Add the auth cookie
    }
  });
  // --- END FIX ---

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      yahooAuth.expiry = 0;
    }
    throw new Error(`Failed to fetch Yahoo chart data: ${res.status} ${res.statusText}`);
  }

  const json: any = await res.json();
  // ... rest of your function ...

  const result = json?.chart?.result?.[0];

  if (!result || !result.timestamp || !result.indicators.quote[0]) {
    throw new Error('Invalid API response from Yahoo Finance');
  }

  const quotes = result.indicators.quote[0];
  const timestamps = result.timestamp;

  // The YF API returns timestamps and OHLC data in separate arrays.
  // We need to zip them together, but only for valid data points.
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

  // --- Your original slicer logic remains identical ---
  const open_slicer: Record<string, number> = { "1m": 308, "2m": 157, "5m": 63, "15m": 21, "30m": 11 };
  const post_slicer: Record<string, number> = { "1m": 702, "2m": 353, "5m": 141, "15m": 47, "30m": 24 };
  const pre_max_cs: Record<string, number> = { "1m": 330, "2m": 165, "5m": 66, "15m": 22, "30m": 11 };
  const open_max_cs: Record<string, number> = { "1m": 390, "2m": 195, "5m": 78, "15m": 26, "30m": 13 };
  const post_max_cs: Record<string, number> = { "1m": 240, "2m": 120, "5m": 48, "15m": 16, "30m": 8 };
  const closed_max_cs: Record<string, number> = { "1m": 960, "2m": 480, "5m": 192, "15m": 64, "30m": 32 };
  
  let range_start = 0;
  let max_cs = 0;
  let sliced_quotes = valid_quotes;

  if (mkt_hours === 'pre_mkt') {
    range_start = 330;
    max_cs = pre_max_cs[interval];
    sliced_quotes = valid_quotes.slice(0, max_cs + 1);
  } else if (mkt_hours === 'mkt_open') {
    range_start = 390;
    max_cs = open_max_cs[interval];
    sliced_quotes = valid_quotes.slice(open_slicer[interval]);
  } else if (mkt_hours === 'post_mkt') {
    range_start = 240;
    max_cs = post_max_cs[interval];
    sliced_quotes = valid_quotes.slice(post_slicer[interval]);
  } else if (mkt_hours === 'mkt_closed') {
    range_start = 960;
    max_cs = closed_max_cs[interval];
    sliced_quotes = valid_quotes;
  }

  // --- Your original np.linspace logic ---
  const x_axis_mte = Array.from(
    { length: sliced_quotes.length },
    (_, i) => range_start - i * (range_start / (sliced_quotes.length - 1 || 1))
  );

  const ohlc = {
    x: x_axis_mte,
    open: sliced_quotes.map(q => q.open),
    high: sliced_quotes.map(q => q.high),
    low: sliced_quotes.map(q => q.low),
    close: sliced_quotes.map(q => q.close),
  };

  return { ohlc, mktHoursRange: [range_start, 0] };
}