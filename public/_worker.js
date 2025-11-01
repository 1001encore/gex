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
  console.log("--- Starting new Yahoo auth refresh... ---");
  const consentCookie = "A3=d=AQAB&S=AQABCAFFp2QAAAAifp2Q-Z3-l1kBEiL2S-sYBwEBAgABBwE-mAAAAg&Y=YAIA";
  const headersWithConsent = { ...YF_HEADERS, Cookie: consentCookie };
  const cookieRes = await fetch("https://finance.yahoo.com/quote/SPY", {
    headers: headersWithConsent,
    redirect: "follow"
  });
  const setCookieHeaders = [];
  cookieRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      setCookieHeaders.push(value);
    }
  });
  if (setCookieHeaders.length === 0) {
    console.error(`Failed to get Yahoo cookie headers. Status: ${cookieRes.status}`);
    const body = await cookieRes.text();
    console.error("Response body snippet:", body.substring(0, 500));
    throw new Error("Failed to get Yahoo cookie. No consent page, but no cookies either.");
  }
  const receivedCookies = setCookieHeaders.join("; ");
  const cookie = consentCookie + "; " + receivedCookies;
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
function getMarketStatus(timeZone) {
  const now = new Date((/* @__PURE__ */ new Date()).toLocaleString("en-US", { timeZone }));
  const mkt_open = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    16,
    30,
    0
  );
  const dayOfWeek = now.getDay();
  const nowInTZ = new Date(now.toLocaleString("en-US", { timeZone }));
  const mktOpenInTZ = new Date(mkt_open.toLocaleString("en-US", { timeZone }));
  const mins_passed = Math.floor(
    (nowInTZ.getTime() - mktOpenInTZ.getTime()) / 6e4
  );
  if (dayOfWeek === 0 || dayOfWeek === 6)
    return { mkt_hours: "mkt_closed", mins_passed };
  if (mins_passed > 630 && mins_passed < 1110)
    return { mkt_hours: "mkt_closed", mins_passed };
  if (mins_passed >= 390 && mins_passed <= 630)
    return { mkt_hours: "post_mkt", mins_passed };
  if (mins_passed >= 0 && mins_passed <= 390)
    return { mkt_hours: "mkt_open", mins_passed };
  if (mins_passed >= 1110 && mins_passed <= 1440)
    return { mkt_hours: "pre_mkt", mins_passed };
  return { mkt_hours: "mkt_closed", mins_passed };
}
function getMteList(mkt_hours, mins_passed, interval = 10) {
  const max_mkt_mins = {
    mkt_open: 390,
    pre_mkt: 330,
    post_mkt: 240,
    mkt_closed: 960
  };
  let current_interval = Math.floor(mins_passed / 10) * 10;
  let parts = Math.floor((max_mkt_mins[mkt_hours] - current_interval) / 10);
  if (mkt_hours === "pre_mkt") current_interval -= 1110;
  else if (mkt_hours === "mkt_open") current_interval -= 0;
  else if (mkt_hours === "post_mkt") current_interval -= 390;
  else if (mkt_hours === "mkt_closed") {
    current_interval = 480;
    parts = 48;
  }
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
async function calc_gamma(ticker, mte_list) {
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
  const exp_date_timestamp = optionsJson?.optionChain?.result?.[0]?.expirationDates?.[0];
  if (!exp_date_timestamp)
    throw new Error(`Could not get expiration dates for ${ticker}`);
  const chainUrl = `https://query1.finance.yahoo.com/v7/finance/options/${ticker}?date=${exp_date_timestamp}&crumb=${crumb}`;
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
  const calls = chain.calls;
  const puts = chain.puts;
  const spot2 = spot * spot;
  const gamma_values_c = {};
  const gamma_values_p = {};
  const allStrikes = /* @__PURE__ */ new Set();
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
  const df = {
    index: Array.from(allStrikes).sort((a, b) => b - a),
    columns: mte_list,
    values: []
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
function gamma_function_call(S, K, T) {
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
  const V0 = binomial_price(S, K, T_yrs, r, sigma, N, "call");
  const V_u = binomial_price(S * u, K, T_yrs - dt, r, sigma, N - 1, "call");
  const V_d = binomial_price(S * d, K, T_yrs - dt, r, sigma, N - 1, "call");
  const delta_up = (V_u - V0) / (S * u - S);
  const delta_down = (V0 - V_d) / (S - S * d);
  const gamma = (delta_up - delta_down) / (0.5 * (S * u - S * d));
  return isNaN(gamma) ? 0 : gamma;
}
function gamma_function_put(S, K, T) {
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
  const V0 = binomial_price(S, K, T_yrs, r, sigma, N, "put");
  const V_u = binomial_price(S * u, K, T_yrs - dt, r, sigma, N - 1, "put");
  const V_d = binomial_price(S * d, K, T_yrs - dt, r, sigma, N - 1, "put");
  const delta_up = (V_u - V0) / (S * u - S);
  const delta_down = (V0 - V_d) / (S - S * d);
  const gamma = (delta_up - delta_down) / (0.5 * (S * u - S * d));
  return isNaN(gamma) ? 0 : gamma;
}
function binomial_price(S, K, T, r, sigma, N, type) {
  if (N <= 0 || T <= 0) {
    if (type === "call") return Math.max(0, S - K);
    else return Math.max(0, K - S);
  }
  const dt = T / N;
  const u = Math.exp(sigma * Math.sqrt(dt));
  const d = 1 / u;
  const p = (Math.exp(r * dt) - d) / (u - d);
  if (p < 0 || p > 1 || isNaN(p))
    return type === "call" ? Math.max(0, S - K) : Math.max(0, K - S);
  const df = Math.exp(-r * dt);
  let option_values = new Array(N + 1);
  for (let j = 0; j <= N; j++) {
    const ST = S * Math.pow(u, j) * Math.pow(d, N - j);
    option_values[j] = type === "call" ? Math.max(0, ST - K) : Math.max(0, K - ST);
  }
  for (let i = N - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const ST = S * Math.pow(u, j) * Math.pow(d, i - j);
      const intrinsic_value = type === "call" ? Math.max(0, ST - K) : Math.max(0, K - ST);
      const expected_value = df * (p * option_values[j + 1] + (1 - p) * option_values[j]);
      option_values[j] = Math.max(intrinsic_value, expected_value);
    }
  }
  return option_values[0];
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
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1d&interval=${interval}&includePrePost=true&crumb=${crumb}`;
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
  const post_slicer = { "1m": 702, "2m": 353, "5m": 141, "15m": 47, "30m": 24 };
  const pre_max_cs = { "1m": 330, "2m": 165, "5m": 66, "15m": 22, "30m": 11 };
  const open_max_cs = { "1m": 390, "2m": 195, "5m": 78, "15m": 26, "30m": 13 };
  const post_max_cs = { "1m": 240, "2m": 120, "5m": 48, "15m": 16, "30m": 8 };
  const closed_max_cs = { "1m": 960, "2m": 480, "5m": 192, "15m": 64, "30m": 32 };
  let range_start = 0;
  let max_cs = 0;
  let sliced_quotes = valid_quotes;
  if (mkt_hours === "pre_mkt") {
    range_start = 330;
    max_cs = pre_max_cs[interval];
    sliced_quotes = valid_quotes.slice(0, max_cs + 1);
  } else if (mkt_hours === "mkt_open") {
    range_start = 390;
    max_cs = open_max_cs[interval];
    sliced_quotes = valid_quotes.slice(open_slicer[interval]);
  } else if (mkt_hours === "post_mkt") {
    range_start = 240;
    max_cs = post_max_cs[interval];
    sliced_quotes = valid_quotes.slice(post_slicer[interval]);
  } else if (mkt_hours === "mkt_closed") {
    range_start = 960;
    max_cs = closed_max_cs[interval];
    sliced_quotes = valid_quotes;
  }
  const x_axis_mte = Array.from(
    { length: sliced_quotes.length },
    (_, i) => range_start - i * (range_start / (sliced_quotes.length - 1 || 1))
  );
  const ohlc = {
    x: x_axis_mte,
    open: sliced_quotes.map((q) => q.open),
    high: sliced_quotes.map((q) => q.high),
    low: sliced_quotes.map((q) => q.low),
    close: sliced_quotes.map((q) => q.close)
  };
  return { ohlc, mktHoursRange: [range_start, 0] };
}

// src/index.ts
var HeatmapBuilderDO = class {
  state;
  constructor(state) {
    this.state = state;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/updateMap") {
      const data = await request.json();
      await this.updateMap(data);
      return new Response("OK");
    }
    if (request.method === "GET" && url.pathname === "/getCombinedPayload") {
      const payload = await this.getCombinedPayload();
      if (payload) {
        return new Response(JSON.stringify(payload), {
          headers: { "Content-Type": "application/json" }
        });
      } else {
        return new Response(JSON.stringify({ error: "No data available" }), {
          status: 404,
          headers: { "Content-Type": "application/json" }
        });
      }
    }
    return new Response("Not found", { status: 404 });
  }
  async updateMap(data) {
    let currentState = await this.state.storage.get(
      "heatmapState"
    ) || {
      y_strikes: data.futureMap.y_strikes,
      locked_x_mte: [],
      locked_z_strips: [],
      future_x_mte: [],
      future_z_values: [],
      limits: data.limits,
      spot: data.spot,
      marketStatus: data.marketStatus
    };
    currentState.future_x_mte = data.futureMap.x_mte;
    currentState.future_z_values = data.futureMap.z_values;
    currentState.locked_x_mte.push(data.historicalStrip.x_mte);
    currentState.locked_z_strips.push(data.historicalStrip.z_strip);
    currentState.limits = data.limits;
    currentState.spot = data.spot;
    currentState.marketStatus = data.marketStatus;
    await this.state.storage.put("heatmapState", currentState);
  }
  async getCombinedPayload() {
    const currentState = await this.state.storage.get("heatmapState");
    if (!currentState) return null;
    const combined_x_mte = [
      ...[...currentState.locked_x_mte].reverse(),
      ...currentState.future_x_mte
    ];
    const numStrikes = currentState.y_strikes.length;
    const numLockedStrips = currentState.locked_x_mte.length;
    const combined_z_values = [];
    const reversedLockedStrips = [...currentState.locked_z_strips].reverse();
    for (let i = 0; i < numStrikes; i++) {
      const row = [];
      for (let j = 0; j < numLockedStrips; j++) {
        row.push(reversedLockedStrips[j][i] || 0);
      }
      row.push(...currentState.future_z_values[i] || []);
      combined_z_values.push(row);
    }
    return {
      heatmapTrace: {
        type: "heatmap",
        x: combined_x_mte,
        y: currentState.y_strikes,
        z: combined_z_values,
        colorscale: "Edge",
        zmid: 0,
        zsmooth: "best"
      },
      limits: currentState.limits,
      mteList: combined_x_mte,
      spot: currentState.spot,
      marketTime: (/* @__PURE__ */ new Date()).toLocaleString("en-US", {
        timeZone: "Asia/Istanbul"
      }),
      marketStatus: currentState.marketStatus
    };
  }
};
var index_default = {
  /**
   * This is the main router for ALL requests.
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/get-gamma-api") {
        const ticker = url.searchParams.get("ticker")?.toUpperCase() || "SPY";
        const doId = env.GEX_HISTORY_DO.idFromName(ticker);
        const stub = env.GEX_HISTORY_DO.get(doId);
        const resp = await stub.fetch("https://dummy/getCombinedPayload");
        if (!resp.ok) {
          return new Response(
            JSON.stringify({
              error: "No heatmap data available yet. Please wait for the next cron run."
            }),
            { status: 404, headers: { "Content-Type": "application/json" } }
          );
        }
        const payload = await resp.json();
        return new Response(JSON.stringify(payload), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "s-maxage=10"
          }
        });
      }
      if (url.pathname === "/api/get-ohlc") {
        const ticker = url.searchParams.get("ticker")?.toUpperCase() || "SPY";
        const interval = url.searchParams.get("interval") || "5m";
        const { mkt_hours } = getMarketStatus("Asia/Istanbul");
        const { ohlc, mktHoursRange } = await makeCS(
          ticker,
          interval,
          mkt_hours
        );
        const ohlcTrace = {
          type: "candlestick",
          x: ohlc.x,
          open: ohlc.open,
          high: ohlc.high,
          low: ohlc.low,
          close: ohlc.close,
          xaxis: "x2",
          yaxis: "y"
        };
        const responsePayload = { ohlcTrace, mktHoursRange };
        return new Response(JSON.stringify(responsePayload), {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "s-maxage=60"
          }
        });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      const err = error;
      return new Response(
        JSON.stringify({ error: err.message, stack: err.stack }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
  },
  /**
   * This is the cron job handler.
   * (No changes needed, this is correct)
   */
  async scheduled(controller, env, ctx) {
    const ticker = "SPY";
    const { mkt_hours, mins_passed } = getMarketStatus("Asia/Istanbul");
    if (mkt_hours === "mkt_closed") {
      console.log("Market closed, cron skipping.");
      return;
    }
    const { mte_list, mte_len } = getMteList(mkt_hours, mins_passed);
    const { df, spot } = await calc_gamma(ticker, mte_list);
    const { limit_up, limit_down } = getChartLimits(df, mte_len);
    const historicalStrip = {
      x_mte: df.columns[0],
      z_strip: df.values.map((row) => row[0])
    };
    const futureMap = {
      x_mte: df.columns.slice(1),
      y_strikes: df.index,
      z_values: df.values.map((row) => row.slice(1))
    };
    const doId = env.GEX_HISTORY_DO.idFromName(ticker);
    const stub = env.GEX_HISTORY_DO.get(doId);
    ctx.waitUntil(
      stub.fetch("https://dummy/updateMap", {
        method: "POST",
        body: JSON.stringify({
          futureMap,
          historicalStrip,
          limits: { up: limit_up, down: limit_down },
          spot,
          marketStatus: mkt_hours
        }),
        headers: { "Content-Type": "application/json" }
      })
    );
  }
};
export {
  HeatmapBuilderDO,
  index_default as default
};
//# sourceMappingURL=_worker.js.map
