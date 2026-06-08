// src/lib.ts
var YF_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Accept-Language": "en-US,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  Connection: "keep-alive"
};
var yahooAuth = {
  cookie: null,
  crumb: null,
  expiry: 0
};
var AUTH_TTL_MS = 15 * 60 * 1e3;
var authRefreshPromise = null;
async function refreshYahooAuth() {
  console.log("--- Starting new Yahoo auth refresh (v4) ---");
  const initRes = await fetch("https://fc.yahoo.com", {
    headers: YF_HEADERS,
    redirect: "follow"
  });
  const setCookieHeaders = [];
  initRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      setCookieHeaders.push(value.split(";")[0]);
    }
  });
  if (setCookieHeaders.length === 0) {
    console.log("fc.yahoo.com returned no cookies, trying finance.yahoo.com...");
    const fallbackRes = await fetch("https://finance.yahoo.com/quote/SPY", {
      headers: YF_HEADERS,
      redirect: "follow"
    });
    fallbackRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        setCookieHeaders.push(value.split(";")[0]);
      }
    });
  }
  if (setCookieHeaders.length === 0) {
    throw new Error("Failed to get Yahoo cookies from both fc.yahoo.com and fallback.");
  }
  const cookie = setCookieHeaders.join("; ");
  const headersWithFullCookie = { ...YF_HEADERS, Cookie: cookie };
  const crumbRes = await fetch(
    "https://query1.finance.yahoo.com/v1/test/getcrumb",
    {
      headers: headersWithFullCookie
    }
  );
  if (!crumbRes.ok) {
    throw new Error(`Failed to get Yahoo crumb: ${crumbRes.statusText}`);
  }
  const crumb = await crumbRes.text();
  if (!crumb) throw new Error("Crumb response was empty.");
  const newAuth = { cookie, crumb };
  yahooAuth = { ...newAuth, expiry: Date.now() + AUTH_TTL_MS };
  console.log("--- Successfully refreshed Yahoo auth. ---");
  return newAuth;
}
async function getYahooAuth() {
  if (Date.now() <= yahooAuth.expiry && yahooAuth.cookie && yahooAuth.crumb) {
    return yahooAuth;
  }
  if (authRefreshPromise) {
    return await authRefreshPromise;
  }
  authRefreshPromise = refreshYahooAuth();
  try {
    const newAuth = await authRefreshPromise;
    return newAuth;
  } catch (error) {
    console.error("Yahoo auth refresh failed:", error);
    throw error;
  } finally {
    authRefreshPromise = null;
  }
}
function getStorageKey(ticker, timeZone, now = /* @__PURE__ */ new Date(), mode = "gex") {
  const dateStr = getDateStr(0, timeZone, now);
  const { mkt_hours } = getMarketStatus(timeZone, now);
  return {
    key: `data_${mode.toLowerCase()}_${ticker.toUpperCase()}_${dateStr}_${mkt_hours}`,
    session: mkt_hours
  };
}
function getDateStr(daysAgo, timeZone, now = /* @__PURE__ */ new Date()) {
  const parts = getZonedParts(now, timeZone);
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - daysAgo));
  const year = shifted.getUTCFullYear();
  const month = (shifted.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = shifted.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function getMarketStatus(timeZone, now = /* @__PURE__ */ new Date()) {
  const parts = getZonedParts(now, timeZone);
  const marketOpenMinute = 9 * 60 + 30;
  const marketCloseMinute = 16 * 60;
  const currentMinute = parts.hour * 60 + parts.minute;
  const mins_passed = currentMinute - marketOpenMinute;
  if (parts.dayOfWeek === 0 || parts.dayOfWeek === 6)
    return { mkt_hours: "mkt_closed", mins_passed };
  if (currentMinute >= marketOpenMinute && currentMinute < marketCloseMinute)
    return { mkt_hours: "mkt_open", mins_passed };
  return { mkt_hours: "mkt_closed", mins_passed };
}
function getZonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short"
  });
  const values = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  const dayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour) % 24,
    minute: Number(values.minute),
    dayOfWeek: dayMap[values.weekday] ?? 0
  };
}
function getMteList(mkt_hours, mins_passed, interval = 1) {
  if (mkt_hours === "mkt_open") {
    const parts2 = Math.floor(390 / interval) + 1;
    return {
      mte_list: Array.from({ length: parts2 }, (_, i) => 390 - i * interval),
      mte_len: parts2
    };
  }
  const max_time = 960;
  const parts = Math.floor(max_time / interval) + 1;
  const mte_list = Array.from({ length: parts }, (_, i) => max_time - i * interval);
  while (mte_list.length > 0 && mte_list[mte_list.length - 1] < 0) mte_list.pop();
  if (mte_list.length === 0 || mte_list[mte_list.length - 1] !== 0) mte_list.push(0);
  return { mte_list, mte_len: mte_list.length };
}
async function calc_exposure(ticker, mte_list, options = {}) {
  const mode = options.mode || "gex";
  const expirationCount = Math.max(1, Math.min(12, options.expirations || 3));
  const now = options.now || /* @__PURE__ */ new Date();
  const { cookie, crumb } = await getYahooAuth();
  const authedHeaders = { ...YF_HEADERS, Cookie: cookie };
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=5m&crumb=${crumb}`;
  const chartRes = await fetch(chartUrl, { headers: authedHeaders });
  if (!chartRes.ok) {
    if (chartRes.status === 401 || chartRes.status === 403) yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch chart/spot price: ${chartRes.status}`);
  }
  const chartJson = await chartRes.json();
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
  const optionsJson = await optionsRes.json();
  const expirationDates = optionsJson?.optionChain?.result?.[0]?.expirationDates?.slice(0, expirationCount) || [];
  if (expirationDates.length === 0)
    throw new Error(`Could not get expiration dates for ${ticker}`);
  const exposureByStrike = {};
  const allStrikes = /* @__PURE__ */ new Set();
  for (const expiration of expirationDates) {
    const chainUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${expiration}&crumb=${crumb}`;
    const chainRes = await fetch(chainUrl, { headers: authedHeaders });
    if (!chainRes.ok) {
      if (chainRes.status === 401 || chainRes.status === 403)
        yahooAuth.expiry = 0;
      throw new Error(`Failed to fetch options chain: ${chainRes.status}`);
    }
    const chainJson = await chainRes.json();
    const chain = chainJson?.optionChain?.result?.[0]?.options?.[0];
    if (!chain || !chain.calls || !chain.puts) {
      console.error(
        "Failed to parse chain. Full API response:",
        JSON.stringify(chainJson, null, 2)
      );
      throw new Error(`Could not fetch options chain for ${ticker}`);
    }
    for (const contract of [...chain.calls, ...chain.puts]) {
      if (!contract.strike) continue;
      allStrikes.add(contract.strike);
      exposureByStrike[contract.strike] ||= mte_list.map(() => 0);
    }
    const callsByStrike = new Map(chain.calls.map((contract) => [contract.strike, contract]));
    const putsByStrike = new Map(chain.puts.map((contract) => [contract.strike, contract]));
    for (const K of allStrikes) {
      exposureByStrike[K] ||= mte_list.map(() => 0);
      const call = callsByStrike.get(K);
      const put = putsByStrike.get(K);
      for (let i = 0; i < mte_list.length; i++) {
        const projectedMinutesElapsed = 390 - mte_list[i];
        const minutesToExpiration = getMinutesToExpiration(expiration, now, projectedMinutesElapsed);
        const callValue = call ? calcContractExposure(mode, "call", spot, K, minutesToExpiration, call) : 0;
        const putValue = put ? calcContractExposure(mode, "put", spot, K, minutesToExpiration, put) : 0;
        exposureByStrike[K][i] += callValue + putValue;
      }
    }
  }
  const df = {
    index: Array.from(allStrikes).sort((a, b) => b - a),
    columns: mte_list,
    values: []
  };
  df.index.forEach((strike) => {
    df.values.push((exposureByStrike[strike] || mte_list.map(() => 0)).map((value) => Math.round(value * 10) / 10));
  });
  return { df, spot };
}
async function calc_expiry_matrix(ticker, options = {}) {
  const mode = options.mode || "gex";
  const expirationCount = Math.max(1, Math.min(30, options.expirations || 3));
  const now = options.now || /* @__PURE__ */ new Date();
  const { cookie, crumb } = await getYahooAuth();
  const authedHeaders = { ...YF_HEADERS, Cookie: cookie };
  const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=5m&crumb=${crumb}`;
  const chartRes = await fetch(chartUrl, { headers: authedHeaders });
  if (!chartRes.ok) {
    if (chartRes.status === 401 || chartRes.status === 403) yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch chart/spot price: ${chartRes.status}`);
  }
  const chartJson = await chartRes.json();
  const spot = chartJson?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (!spot) throw new Error(`Could not get spot price for ${ticker} from chart API`);
  const optionsUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?crumb=${crumb}`;
  const optionsRes = await fetch(optionsUrl, { headers: authedHeaders });
  if (!optionsRes.ok) {
    if (optionsRes.status === 401 || optionsRes.status === 403) yahooAuth.expiry = 0;
    throw new Error(`Failed to fetch options dates: ${optionsRes.status}`);
  }
  const optionsJson = await optionsRes.json();
  const expirationDates = optionsJson?.optionChain?.result?.[0]?.expirationDates?.slice(0, expirationCount) || [];
  if (expirationDates.length === 0) throw new Error(`Could not get expiration dates for ${ticker}`);
  const exposureByStrike = {};
  const allStrikes = /* @__PURE__ */ new Set();
  for (let columnIndex = 0; columnIndex < expirationDates.length; columnIndex++) {
    const expiration = expirationDates[columnIndex];
    const chainUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${expiration}&crumb=${crumb}`;
    const chainRes = await fetch(chainUrl, { headers: authedHeaders });
    if (!chainRes.ok) {
      if (chainRes.status === 401 || chainRes.status === 403) yahooAuth.expiry = 0;
      throw new Error(`Failed to fetch options chain: ${chainRes.status}`);
    }
    const chainJson = await chainRes.json();
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
        "call",
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
        "put",
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
    columns: expirationDates.map((expiration) => new Date(expiration * 1e3).toISOString().slice(0, 10)),
    values: strikes.map((strike) => (exposureByStrike[strike] || expirationDates.map(() => 0)).map((value) => Math.round(value * 10) / 10))
  };
}
function getMinutesToExpiration(expirationTimestampSeconds, now, projectedMinutesElapsed) {
  const expirationMs = expirationTimestampSeconds * 1e3;
  const projectedNowMs = now.getTime() + projectedMinutesElapsed * 6e4;
  return Math.max(1, (expirationMs - projectedNowMs) / 6e4);
}
function calcContractExposure(mode, type, S, K, minutesToExpiration, contract) {
  const sigma = Number(contract.impliedVolatility) > 0 ? Number(contract.impliedVolatility) : 0.2;
  const openInterest = Number(contract.openInterest || 0);
  const volume = Number(contract.volume || 0);
  const contractCount = openInterest + volume * 0.25;
  if (!contractCount) return 0;
  const sign = type === "call" ? 1 : -1;
  if (mode === "vex") {
    const vanna = blackScholesVanna(S, K, minutesToExpiration, sigma);
    return sign * vanna * contractCount * S * 0.01;
  }
  const gamma = blackScholesGamma(S, K, minutesToExpiration, sigma);
  return sign * gamma * contractCount * S * S * 0.01;
}
function blackScholesGamma(S, K, minutesToExpiration, sigma, r = 0.05) {
  const T = minutesToExpiration / (365 * 24 * 60);
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  return normalPdf(d1) / (S * sigma * Math.sqrt(T));
}
function blackScholesVanna(S, K, minutesToExpiration, sigma, r = 0.05) {
  const T = minutesToExpiration / (365 * 24 * 60);
  if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return -normalPdf(d1) * d2 / sigma;
}
function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function getChartLimits(df, mte_len) {
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
      limit_down: Math.round(min_strike * 0.99)
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
  const limit_up = Math.round(max_strike_sum / near_expiry_count * 1.01);
  const limit_down = Math.round(min_strike_sum / near_expiry_count * 0.99);
  return { limit_up, limit_down };
}
async function makeCS(ticker, interval, mkt_hours) {
  const { cookie, crumb } = await getYahooAuth();
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=2d&interval=${interval}&includePrePost=true&crumb=${crumb}`;
  const res = await fetch(url, {
    headers: {
      ...YF_HEADERS,
      "Cookie": cookie
    }
  });
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators.quote[0]) {
    throw new Error("Invalid API response from Yahoo Finance");
  }
  const quotes = result.indicators.quote[0];
  const timestamps = result.timestamp;
  let valid_quotes = [];
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
  const open_slicer = { "1m": 308, "2m": 157, "5m": 63, "15m": 21, "30m": 11 };
  const open_max_cs = { "1m": 390, "2m": 195, "5m": 78, "15m": 26, "30m": 13 };
  const closed_max_cs = { "1m": 960, "2m": 480, "5m": 192, "15m": 64, "30m": 32 };
  let range_start = 0;
  let sliced_quotes = valid_quotes;
  if (mkt_hours === "mkt_open") {
    range_start = 390;
    let slice_start = open_slicer[interval];
    if (slice_start >= valid_quotes.length) {
      console.warn(`OHLC slicer index ${slice_start} out of bounds. Using all ${valid_quotes.length} quotes.`);
      slice_start = 0;
    }
    sliced_quotes = valid_quotes.slice(slice_start);
  } else {
    range_start = 960;
    sliced_quotes = valid_quotes;
  }
  const x_axis_mte = Array.from(
    { length: sliced_quotes.length > 0 ? sliced_quotes.length : 1 },
    // Prevent length 0
    (_, i) => range_start - i * (range_start / (sliced_quotes.length - 1 || 1))
  );
  const ohlc = {
    x: x_axis_mte,
    open: sliced_quotes.map((q) => q.open),
    high: sliced_quotes.map((q) => q.high),
    low: sliced_quotes.map((q) => q.low),
    close: sliced_quotes.map((q) => q.close)
  };
  if (sliced_quotes.length === 0) {
    console.error("OHLC slicing resulted in 0 quotes. Returning empty chart.");
    return { ohlc: { x: [], open: [], high: [], low: [], close: [] }, mktHoursRange: [range_start, 0] };
  }
  return { ohlc, mktHoursRange: [range_start, 0] };
}

// src/index.ts
var APP_TIMEZONE = "America/New_York";
var DAYS_OF_DATA_TO_KEEP = 20;
var TICKER = "SPY";
var SCHEDULED_TICKERS = ["SPY", "QQQ", "^SPX"];
var DEFAULT_EXPIRATIONS = 3;
function normalizeTicker(input) {
  const ticker = (input || TICKER).trim().toUpperCase();
  if (!/^[A-Z0-9.^-]{1,12}$/.test(ticker)) {
    throw new Error("Invalid ticker");
  }
  return ticker;
}
function normalizeInterval(input) {
  const interval = input || "5m";
  if (!["1m", "2m", "5m", "15m", "30m"].includes(interval)) {
    throw new Error("Invalid interval");
  }
  return interval;
}
function normalizeDate(input) {
  if (!input) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    throw new Error("Invalid date");
  }
  const parsed = /* @__PURE__ */ new Date(`${input}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== input) {
    throw new Error("Invalid date");
  }
  return input;
}
function normalizeDays(input) {
  const days = Number(input || "1");
  if (!Number.isInteger(days) || days < 1 || days > 10) {
    throw new Error("Invalid days");
  }
  return days;
}
function normalizeExpirations(input) {
  const expirations = Number(input || "3");
  if (!Number.isInteger(expirations) || expirations < 1 || expirations > 30) {
    throw new Error("Invalid expirations");
  }
  return expirations;
}
function normalizeMode(input) {
  const mode = (input || "gex").toLowerCase();
  if (mode !== "gex" && mode !== "vex") {
    throw new Error("Invalid mode");
  }
  return mode;
}
function storagePrefix(ticker, mode) {
  return `data_${mode}_${ticker}_`;
}
function legacyStoragePrefix(ticker) {
  return `data_${ticker}_`;
}
function getDateFromStorageKey(key, ticker, mode) {
  if (key.startsWith(storagePrefix(ticker, mode))) return key.split("_")[3] || null;
  return null;
}
function keyMatchesDate(key, ticker, mode, date) {
  return key.startsWith(`${storagePrefix(ticker, mode)}${date}_`);
}
function validateChartPayload(payload) {
  const x = payload.heatmapTrace?.x || [];
  const y = payload.heatmapTrace?.y || [];
  const z = payload.heatmapTrace?.z || [];
  const issues = [];
  if (x.length === 0) issues.push("heatmap x-axis is empty");
  if (y.length === 0) issues.push("heatmap y-axis is empty");
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
  if (x.some((value) => !Number.isFinite(value))) issues.push("x-axis contains non-finite values");
  if (y.some((value) => !Number.isFinite(value))) issues.push("y-axis contains non-finite values");
  if (!Number.isFinite(payload.spot) || payload.spot <= 0) issues.push("spot is missing or invalid");
  if (!Number.isFinite(payload.limits?.up) || !Number.isFinite(payload.limits?.down)) {
    issues.push("limits are missing or invalid");
  } else if (payload.limits.down >= payload.limits.up) {
    issues.push("limit down is not below limit up");
  }
  const segments = payload.daySegments?.length ? payload.daySegments : [{ date: payload.date, start: 0, end: x.length - 1 }];
  for (const segment of segments) {
    const segmentX = x.slice(segment.start, segment.end + 1);
    const duplicateX = segmentX.filter((value, index) => segmentX.indexOf(value) !== index);
    if (duplicateX.length > 0) issues.push(`x-axis contains duplicate MTE buckets for ${segment.date}`);
    const xMonotonic = segmentX.every((value, index) => index === 0 || value <= segmentX[index - 1]);
    if (!xMonotonic) issues.push(`x-axis MTE values are not monotonically descending for ${segment.date}`);
  }
  const yDescending = y.every((value, index) => index === 0 || value <= y[index - 1]);
  if (!yDescending) issues.push("y-axis strikes are not monotonically descending");
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
      limits: payload.limits
    }
  };
}
function summarizeConfluence(payload) {
  const x = payload.heatmapTrace?.x || [];
  const y = payload.heatmapTrace?.y || [];
  const z = payload.heatmapTrace?.z || [];
  const latestIndex = payload.daySegments?.length ? payload.daySegments[payload.daySegments.length - 1].end : x.length - 1;
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
  const bias = upsideMass > downsideMass * 1.15 ? "upside" : downsideMass > upsideMass * 1.15 ? "downside" : "balanced";
  return {
    date: payload.date,
    mode: payload.mode || "gex",
    spot,
    king,
    floor,
    ceiling,
    bias,
    upsideMass,
    downsideMass
  };
}
function buildHistoryMatrixFromPayload(payload) {
  const x = payload.heatmapTrace.x || [];
  const y = payload.heatmapTrace.y || [];
  const z = payload.heatmapTrace.z || [];
  const segments = payload.daySegments?.length ? payload.daySegments : [{ date: payload.date, start: 0, end: x.length - 1 }];
  const columns = segments.map((segment) => segment.date);
  const values = y.map(
    (_, rowIndex) => segments.map((segment) => z[rowIndex]?.[segment.end] || 0)
  );
  return {
    ticker: "",
    mode: payload.mode || "gex",
    spot: payload.spot,
    strikes: y,
    columns,
    values,
    source: "history"
  };
}
function isAuthorizedCron(request, env) {
  if (!env.ADMIN_SECRET) return false;
  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization") || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : "";
  const headerSecret = request.headers.get("X-Admin-Secret") || "";
  const querySecret = url.searchParams.get("secret") || "";
  return [bearer, headerSecret, querySecret].includes(env.ADMIN_SECRET);
}
var HeatmapBuilderDO = class {
  state;
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/api/v1/addStrip") {
      const newData = await request.json();
      const ticker = normalizeTicker(newData.ticker);
      const mode = normalizeMode(newData.mode || "gex");
      const { key } = getStorageKey(ticker, APP_TIMEZONE, /* @__PURE__ */ new Date(), mode);
      let sessionData = await this.state.storage.get(key) || {
        y_strikes: newData.futureMap.y_strikes,
        // Initialize with FIRST strip's strikes
        strips: [],
        mtes: [],
        limits: newData.limits,
        spot: newData.spot,
        future_x_mte: [],
        future_z_values: []
      };
      const incomingStrikes = newData.futureMap.y_strikes;
      const incomingValues = newData.historicalStrip.z_strip;
      const alignedStrip = new Array(sessionData.y_strikes.length).fill(0);
      for (let i = 0; i < incomingStrikes.length; i++) {
        const strike = incomingStrikes[i];
        const val = incomingValues[i];
        const sessionIndex = sessionData.y_strikes.indexOf(strike);
        if (sessionIndex !== -1) {
          alignedStrip[sessionIndex] = val;
        }
      }
      const newMte = newData.historicalStrip.x_mte;
      if (sessionData.mtes.length > 0 && sessionData.mtes[0] === newMte) {
        return new Response("OK (Duplicate skipped)");
      }
      sessionData.strips.unshift(alignedStrip);
      sessionData.mtes.unshift(newMte);
      sessionData.limits = newData.limits;
      sessionData.spot = newData.spot;
      sessionData.future_x_mte = newData.futureMap.x_mte;
      sessionData.future_z_values = newData.futureMap.z_values;
      await this.state.storage.put(key, sessionData);
      return new Response("OK");
    }
    if (request.method === "GET" && url.pathname === "/api/v1/getChartData") {
      const requestedDate = url.searchParams.get("date");
      const ticker = normalizeTicker(url.searchParams.get("ticker"));
      const mode = normalizeMode(url.searchParams.get("mode"));
      const targetRequestedDate = normalizeDate(requestedDate);
      const days = normalizeDays(url.searchParams.get("days"));
      const includeFuture = url.searchParams.get("includeFuture") !== "false";
      const listMap = await this.state.storage.list({
        prefix: storagePrefix(ticker, mode)
      });
      if (listMap.size === 0) {
        return new Response(JSON.stringify({ error: "No data available" }), { status: 404 });
      }
      const allKeys = Array.from(listMap.keys()).sort();
      const uniqueDates = [...new Set(allKeys.map((k) => getDateFromStorageKey(k, ticker, mode)).filter(Boolean))].sort();
      const endDate = targetRequestedDate || uniqueDates[uniqueDates.length - 1];
      const endDateIndex = uniqueDates.indexOf(endDate);
      if (endDateIndex === -1) {
        return new Response(JSON.stringify({ error: "No data for date" }), { status: 404 });
      }
      const targetDates = uniqueDates.slice(Math.max(0, endDateIndex - days + 1), endDateIndex + 1);
      const keysForWindow = allKeys.filter(
        (key) => targetDates.some((date) => keyMatchesDate(key, ticker, mode, date))
      );
      if (keysForWindow.length === 0) {
        return new Response(JSON.stringify({ error: "No data for date" }), { status: 404 });
      }
      const y_strikes = Array.from(new Set(
        keysForWindow.flatMap((key) => listMap.get(key)?.y_strikes || [])
      )).sort((a, b) => b - a);
      const combined_x_mte = [];
      const combined_z_values = y_strikes.map(() => []);
      const sessionMarkers = [];
      const daySegments = [];
      let lastKnownSpot = 0;
      let lastKnownLimits = { up: 0, down: 0 };
      let latestSession = null;
      for (const date of targetDates) {
        const dayStart = combined_x_mte.length;
        const keysForDate = allKeys.filter((key) => keyMatchesDate(key, ticker, mode, date));
        for (const key of keysForDate) {
          const sessionData = listMap.get(key);
          if (!sessionData || !sessionData.mtes) continue;
          const sessionName = key.split("_").pop() || "session";
          if (combined_x_mte.length > 0) {
            sessionMarkers.push({
              x: combined_x_mte[combined_x_mte.length - 1],
              label: sessionName,
              date
            });
          }
          const historicalPairs = sessionData.mtes.map((mte, index) => ({ mte, strip: sessionData.strips[index] })).filter((pair) => pair.strip).sort((a, b) => b.mte - a.mte);
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
          type: "heatmap",
          x: combined_x_mte,
          y: y_strikes,
          z: combined_z_values,
          colorscale: "Edge",
          zmid: 0,
          zsmooth: "best"
        },
        limits: lastKnownLimits,
        spot: lastKnownSpot,
        sessionMarkers,
        daySegments
      };
      return new Response(JSON.stringify(payload), {
        headers: { "Content-Type": "application/json" }
      });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/getAvailableDates") {
      const ticker = normalizeTicker(url.searchParams.get("ticker"));
      const mode = normalizeMode(url.searchParams.get("mode"));
      const listMap = await this.state.storage.list({ prefix: storagePrefix(ticker, mode) });
      const allKeys = Array.from(listMap.keys());
      const uniqueDates = [...new Set(allKeys.map((k) => getDateFromStorageKey(k, ticker, mode)).filter(Boolean))].sort();
      return new Response(JSON.stringify(uniqueDates), {
        headers: { "Content-Type": "application/json" }
      });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/deleteOldData") {
      const ticker = normalizeTicker(url.searchParams.get("ticker"));
      const mode = normalizeMode(url.searchParams.get("mode"));
      const listMap = await this.state.storage.list({
        prefix: storagePrefix(ticker, mode)
      });
      const keysToDelete = [];
      const now = /* @__PURE__ */ new Date();
      const cutoffTime = now.getTime() - DAYS_OF_DATA_TO_KEEP * 24 * 60 * 60 * 1e3;
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
        return new Response(`Deleted: ${keysToDelete.join(", ")}`);
      }
      return new Response("No old data to delete.");
    }
    if (request.method === "POST" && url.pathname === "/api/v1/deleteLegacyData") {
      const ticker = normalizeTicker(url.searchParams.get("ticker"));
      const listMap = await this.state.storage.list({ prefix: legacyStoragePrefix(ticker) });
      const keysToDelete = Array.from(listMap.keys());
      if (keysToDelete.length > 0) {
        await this.state.storage.delete(keysToDelete);
      }
      return new Response(JSON.stringify({ ticker, deleted: keysToDelete.length, keys: keysToDelete }), {
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};
var ALLOWED_ORIGIN = "https://1001encore.github.io";
function addCORSHeaders(response) {
  const newResponse = new Response(response.body, response);
  newResponse.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  newResponse.headers.append("Vary", "Origin");
  return newResponse;
}
var index_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Admin-Secret"
        }
      });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === "/__cron") {
        if (!isAuthorizedCron(request, env)) {
          return addCORSHeaders(new Response("Unauthorized", { status: 401 }));
        }
        await this.scheduled(null, env, ctx);
        return addCORSHeaders(new Response("Cron Ran"));
      }
      if (url.pathname === "/api/get-gamma-api") {
        const ticker = normalizeTicker(url.searchParams.get("ticker"));
        const mode = normalizeMode(url.searchParams.get("mode"));
        const requestedDate = normalizeDate(url.searchParams.get("date"));
        const days = normalizeDays(url.searchParams.get("days"));
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        const includeFuture = url.searchParams.get("includeFuture");
        let doUrl = `https://dummy/api/v1/getChartData?ticker=${encodeURIComponent(ticker)}&mode=${mode}&days=${days}`;
        if (requestedDate) doUrl += `&date=${requestedDate}`;
        if (includeFuture === "false") doUrl += "&includeFuture=false";
        return addCORSHeaders(await stub.fetch(doUrl));
      }
      if (url.pathname === "/api/diagnostics") {
        const ticker = normalizeTicker(url.searchParams.get("ticker"));
        const mode = normalizeMode(url.searchParams.get("mode"));
        const requestedDate = normalizeDate(url.searchParams.get("date"));
        const days = normalizeDays(url.searchParams.get("days"));
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        let doUrl = `https://dummy/api/v1/getChartData?ticker=${encodeURIComponent(ticker)}&mode=${mode}&days=${days}`;
        if (requestedDate) doUrl += `&date=${requestedDate}`;
        const chartResponse = await stub.fetch(doUrl);
        if (!chartResponse.ok) return addCORSHeaders(chartResponse);
        const payload = await chartResponse.json();
        return addCORSHeaders(new Response(JSON.stringify(validateChartPayload(payload)), {
          headers: { "Content-Type": "application/json" }
        }));
      }
      if (url.pathname === "/api/get-dates") {
        const ticker = normalizeTicker(url.searchParams.get("ticker"));
        const mode = normalizeMode(url.searchParams.get("mode"));
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        return addCORSHeaders(await stub.fetch(`https://dummy/api/v1/getAvailableDates?ticker=${encodeURIComponent(ticker)}&mode=${mode}`));
      }
      if (url.pathname === "/api/confluence") {
        const mode = normalizeMode(url.searchParams.get("mode"));
        const requestedDate = normalizeDate(url.searchParams.get("date"));
        const days = normalizeDays(url.searchParams.get("days"));
        const tickers = (url.searchParams.get("tickers") || "SPY,QQQ,^SPX").split(",").map((ticker) => normalizeTicker(ticker)).slice(0, 5);
        const results = await Promise.all(tickers.map(async (ticker) => {
          const doId = env.GEX_HISTORY_DO.idFromName(ticker);
          const stub = env.GEX_HISTORY_DO.get(doId);
          let doUrl = `https://dummy/api/v1/getChartData?ticker=${encodeURIComponent(ticker)}&mode=${mode}&days=${days}&includeFuture=false`;
          if (requestedDate) doUrl += `&date=${requestedDate}`;
          const response = await stub.fetch(doUrl);
          if (!response.ok) return { ticker, ok: false, error: await response.text() };
          const payload = await response.json();
          return { ticker, ok: true, summary: summarizeConfluence(payload) };
        }));
        return addCORSHeaders(new Response(JSON.stringify({ mode, tickers: results }), {
          headers: { "Content-Type": "application/json" }
        }));
      }
      if (url.pathname === "/api/live-exposure") {
        const ticker = normalizeTicker(url.searchParams.get("ticker"));
        const mode = normalizeMode(url.searchParams.get("mode"));
        const expirations = DEFAULT_EXPIRATIONS;
        const currentOnly = url.searchParams.get("currentOnly") === "true";
        const { mkt_hours, mins_passed } = getMarketStatus(APP_TIMEZONE);
        const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
        const { df, spot } = await calc_exposure(ticker, mte_list, { mode, expirations });
        const { limit_up, limit_down } = getChartLimits(df, mte_len);
        const currentMte = mkt_hours === "mkt_open" ? 390 - Math.floor(mins_passed) : df.columns[0];
        const currentIndex = Math.max(0, df.columns.indexOf(currentMte));
        const liveColumns = currentOnly ? [df.columns[currentIndex]] : df.columns;
        const liveValues = currentOnly ? df.values.map((row) => [row[currentIndex] || 0]) : df.values;
        const payload = {
          date: getDateStr(0, APP_TIMEZONE),
          dates: [getDateStr(0, APP_TIMEZONE)],
          mode,
          heatmapTrace: {
            x: liveColumns,
            y: df.index,
            z: liveValues
          },
          limits: { up: limit_up, down: limit_down },
          spot,
          sessionMarkers: [],
          daySegments: [{ date: getDateStr(0, APP_TIMEZONE), start: 0, end: liveColumns.length - 1 }]
        };
        return addCORSHeaders(new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" }
        }));
      }
      if (url.pathname === "/api/future-matrix") {
        const ticker = normalizeTicker(url.searchParams.get("ticker"));
        const mode = normalizeMode(url.searchParams.get("mode"));
        const expirations = normalizeExpirations(url.searchParams.get("horizon"));
        const matrix = await calc_expiry_matrix(ticker, { mode, expirations });
        return addCORSHeaders(new Response(JSON.stringify({ ...matrix, source: "future" }), {
          headers: { "Content-Type": "application/json" }
        }));
      }
      if (url.pathname === "/api/history-matrix") {
        const ticker = normalizeTicker(url.searchParams.get("ticker"));
        const mode = normalizeMode(url.searchParams.get("mode"));
        const requestedDate = normalizeDate(url.searchParams.get("date"));
        const days = normalizeDays(url.searchParams.get("days"));
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        let doUrl = `https://dummy/api/v1/getChartData?ticker=${encodeURIComponent(ticker)}&mode=${mode}&days=${days}&includeFuture=false`;
        if (requestedDate) doUrl += `&date=${requestedDate}`;
        const response = await stub.fetch(doUrl);
        if (!response.ok) return addCORSHeaders(response);
        const payload = await response.json();
        return addCORSHeaders(new Response(JSON.stringify({ ...buildHistoryMatrixFromPayload(payload), ticker }), {
          headers: { "Content-Type": "application/json" }
        }));
      }
      if (url.pathname === "/admin/delete-legacy") {
        if (!isAuthorizedCron(request, env)) {
          return addCORSHeaders(new Response("Unauthorized", { status: 401 }));
        }
        const tickers = (url.searchParams.get("tickers") || SCHEDULED_TICKERS.join(",")).split(",").map((ticker) => normalizeTicker(ticker));
        const results = await Promise.all(tickers.map(async (ticker) => {
          const doId = env.GEX_HISTORY_DO.idFromName(ticker);
          const stub = env.GEX_HISTORY_DO.get(doId);
          const response = await stub.fetch(`https://dummy/api/v1/deleteLegacyData?ticker=${encodeURIComponent(ticker)}`, { method: "POST" });
          return response.json();
        }));
        return addCORSHeaders(new Response(JSON.stringify({ deleted: results }), {
          headers: { "Content-Type": "application/json" }
        }));
      }
      if (url.pathname === "/api/get-ohlc") {
        const ticker = normalizeTicker(url.searchParams.get("ticker"));
        const interval = normalizeInterval(url.searchParams.get("interval"));
        const { mkt_hours } = getMarketStatus(APP_TIMEZONE);
        const { ohlc, mktHoursRange } = await makeCS(ticker, interval, mkt_hours);
        const ohlcTrace = {
          type: "candlestick",
          x: ohlc.x,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
          xaxis: "x2",
          yaxis: "y",
          increasing: { line: { color: "#26a69a" } },
          decreasing: { line: { color: "#ef5350" } }
        };
        return addCORSHeaders(new Response(JSON.stringify({ ohlcTrace, mktHoursRange }), {
          headers: { "Content-Type": "application/json" }
        }));
      }
      return addCORSHeaders(new Response("Not found", { status: 404 }));
    } catch (error) {
      const err = error;
      return addCORSHeaders(new Response(JSON.stringify({ error: err.message }), { status: 500 }));
    }
  },
  async scheduled(controller, env, ctx) {
    const now = new Date((/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone: APP_TIMEZONE }));
    if (now.getHours() === 0 && now.getMinutes() < 15) {
      for (const ticker of SCHEDULED_TICKERS) {
        const cleanupDoId = env.GEX_HISTORY_DO.idFromName(ticker);
        const cleanupStub = env.GEX_HISTORY_DO.get(cleanupDoId);
        for (const mode of ["gex", "vex"]) {
          ctx.waitUntil(cleanupStub.fetch(`https://dummy/api/v1/deleteOldData?ticker=${encodeURIComponent(ticker)}&mode=${mode}`, { method: "POST" }));
        }
      }
    }
    const { mkt_hours, mins_passed } = getMarketStatus(APP_TIMEZONE);
    if (mkt_hours !== "mkt_open") return;
    const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
    const current_bucket_mins = Math.floor(mins_passed);
    const target_mte = 390 - current_bucket_mins;
    for (const ticker of SCHEDULED_TICKERS) {
      for (const mode of ["gex", "vex"]) {
        try {
          const { df, spot } = await calc_exposure(ticker, mte_list, { mode, expirations: DEFAULT_EXPIRATIONS });
          const { limit_up, limit_down } = getChartLimits(df, mte_len);
          const splitIndex = df.columns.indexOf(target_mte);
          if (splitIndex === -1) {
            console.log(`Target MTE ${target_mte} not found in ${ticker} ${mode} grid.`);
            continue;
          }
          const historical_z_strip = df.values.map((row) => row[splitIndex]);
          const future_columns = df.columns.slice(splitIndex + 1);
          const future_z_values = df.values.map((row) => row.slice(splitIndex + 1));
          const stripData = {
            ticker,
            mode,
            historicalStrip: {
              x_mte: target_mte,
              z_strip: historical_z_strip
            },
            futureMap: {
              x_mte: future_columns,
              y_strikes: df.index,
              z_values: future_z_values
            },
            limits: { up: limit_up, down: limit_down },
            spot
          };
          const doId = env.GEX_HISTORY_DO.idFromName(ticker);
          const stub = env.GEX_HISTORY_DO.get(doId);
          ctx.waitUntil(stub.fetch("https://dummy/api/v1/addStrip", {
            method: "POST",
            body: JSON.stringify(stripData),
            headers: { "Content-Type": "application/json" }
          }));
        } catch (error) {
          console.error(`Failed scheduled ${mode} collection for ${ticker}:`, error);
        }
      }
    }
  }
};
export {
  HeatmapBuilderDO,
  index_default as default,
  normalizeDate,
  normalizeDays,
  normalizeExpirations,
  normalizeInterval,
  normalizeMode,
  normalizeTicker,
  summarizeConfluence,
  validateChartPayload
};
//# sourceMappingURL=_worker.js.map
