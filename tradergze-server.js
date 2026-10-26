#!/usr/bin/env node
// Single-file build of server/server.js with src/intel.js inlined (made by build.js). Upload next to tradergze-intel.html and install.sh.
// TraderGze Intel server: tracks BTC, USDT and USDC around the clock, keeps the record in SQLite,
// runs the anomaly agent, serves the app and its API, and alerts on Telegram.
// Node 22+, no packages. Configuration: environment variables (see config.example.env).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const X = (function () { const module = { exports: {} };
// TraderGze Intel engine: live whale flows for BTC, USDT and USDC, top BTC holders, perp traders,
// prediction markets and an anomaly agent. Pure functions plus thin network readers; runs in the
// browser and in Node 18+ (tests swap Net.fetch and the WebSocket class).
(function (root) {
  "use strict";
  const I = {};

  // ================================================================ network

  const Net = {
    fetch: (...a) => fetch(...a),
    WS: typeof WebSocket !== "undefined" ? WebSocket : null,
    next: {},
    gaps: { "api.hyperliquid.xyz": 120, "mempool.space": 220, "api.trongrid.io": 400, "gamma-api.polymarket.com": 200, "api.elections.kalshi.com": 300 },
    async slot(host) {
      const gap = this.gaps[host] != null ? this.gaps[host] : 120;
      const now = Date.now(), at = Math.max(now, this.next[host] || 0);
      this.next[host] = at + gap;
      if (at > now) await new Promise((r) => setTimeout(r, at - now));
    },
    async request(url, init, as = "json") {
      const host = new URL(url).host;
      let last;
      for (let i = 0; i < 3; i++) {
        await this.slot(host);
        let res;
        try { res = await this.fetch(url, init); } catch (e) { last = new Error(`${host}: could not connect (${e.message || e})`); await sleep(800 * (i + 1)); continue; }
        if (res.status === 429 || res.status >= 500) { last = new Error(`${host} answered HTTP ${res.status}`); await sleep(1500 * (i + 1)); continue; }
        if (!res.ok) { let t = ""; try { t = (await res.text()).slice(0, 200); } catch {} throw new Error(`${host} answered HTTP ${res.status}${t ? ": " + t : ""}`); }
        return as === "json" ? res.json() : res.text();
      }
      throw last;
    },
    get(url, as) { return this.request(url, undefined, as); },
    post(url, body, headers = {}) { return this.request(url, { method: "POST", headers: Object.assign({ "Content-Type": "application/json" }, headers), body: JSON.stringify(body) }); },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  I.Net = Net;

  // ================================================================ settings

  const Settings = {
    btcMin: 100,            // BTC: report transfers at or above this
    stableMin: 5e6,         // USDT/USDC: report at or above this many dollars
    perpMin: 1e6,           // Hyperliquid: a "big trade" in dollars
    chains: { ethereum: true, bsc: true, polygon: true, tron: true },
    rpc: { ethereum: "https://ethereum-rpc.publicnode.com", bsc: "https://bsc-rpc.publicnode.com", polygon: "https://polygon-bor-rpc.publicnode.com" },
    anthropicKey: "", trongridKey: "",
    labels: {},             // your own: address -> [name, kind]
    holders: [],            // extra BTC addresses you watch
  };
  I.Settings = Settings;

  // ================================================================ formatting

  const fmtUsd = (x) => (x == null || !isFinite(x) ? "—" : Math.abs(x) >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : Math.abs(x) >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${x.toFixed(0)}`);
  const fmtNum = (x, d = 2) => (x == null || !isFinite(x) ? "—" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d }));
  const short = (a) => (a && a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a || "?");
  Object.assign(I, { fmtUsd, fmtNum, short });

  // ================================================================ labels

  // Public, widely cited wallets. kind: exchange | treasury | gov | hacker | dormant | custodian | bridge
  const LABELS = {
    // Bitcoin
    "1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s": ["Binance hot wallet", "exchange", "Binance"],
    "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo": ["Binance cold wallet", "exchange", "Binance"],
    "3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6": ["Binance cold wallet", "exchange", "Binance"],
    "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h": ["Binance wallet", "exchange", "Binance"],
    "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97": ["Bitfinex cold wallet", "exchange", "Bitfinex"],
    "bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2": ["Robinhood custody", "custodian", "Robinhood"],
    "1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF": ["Mt.Gox hack (2011), dormant", "hacker", "Mt.Gox hacker"],
    "bc1qazcm763858nkj2dj986etajv6wquslv8uxwczt": ["Bitfinex hack funds (seized by the US)", "gov", "US Government"],
    "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa": ["Genesis block (Satoshi)", "dormant", "Satoshi"],
    // EVM (same address on Ethereum and BNB Chain where the exchange reuses it)
    "0x28c6c06298d514db089934071355e5743bf21d60": ["Binance 14", "exchange", "Binance"],
    "0x21a31ee1afc51d94c2efccaa2092ad1028285549": ["Binance 15", "exchange", "Binance"],
    "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": ["Binance 16", "exchange", "Binance"],
    "0x56eddb7aa87536c09ccc2793473599fd21a8b17f": ["Binance 17", "exchange", "Binance"],
    "0x9696f59e4d72e237be84ffd425dcad154bf96976": ["Binance 18", "exchange", "Binance"],
    "0xf977814e90da44bfa03b6295a0616a897441acec": ["Binance 8", "exchange", "Binance"],
    "0xbe0eb53f46cd790cd13851d5eff43d12404d33e8": ["Binance 7", "exchange", "Binance"],
    "0x8894e0a0c962cb723c1976a4421c95949be2d4e3": ["Binance hot wallet (BNB Chain)", "exchange", "Binance"],
    "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": ["Coinbase 1", "exchange", "Coinbase"],
    "0x503828976d22510aad0201ac7ec88293211d23da": ["Coinbase 2", "exchange", "Coinbase"],
    "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": ["Coinbase 10", "exchange", "Coinbase"],
    "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": ["Kraken 1", "exchange", "Kraken"],
    "0x267be1c1d684f78cb4f6a176c4911b741e4ffdc0": ["Kraken 4", "exchange", "Kraken"],
    "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": ["OKX", "exchange", "OKX"],
    "0xf89d7b9c864f589bbf53a82105107622b35eaa40": ["Bybit", "exchange", "Bybit"],
    "0x5754284f345afc66a98fbb0a0afe71e0f007b949": ["Tether Treasury", "treasury", "Tether"],
    "0x55fe002aeff02f77364de339a1292923a15844b8": ["Circle", "treasury", "Circle"],
    "0x0000000000000000000000000000000000000000": ["Mint / burn", "mint", "Mint"],
    // Tron
    "TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi": ["Binance hot wallet (Tron)", "exchange", "Binance"],
  };
  const norm = (a) => (/^0x/i.test(a || "") ? a.toLowerCase() : a);
  function label(a) {
    const k = norm(a);
    const own = Settings.labels[k];
    if (own) return { name: own[0], kind: own[1] || "exchange", entity: own[2] || own[0], source: "yours" };
    const b = LABELS[k];
    return b ? { name: b[0], kind: b[1], entity: b[2], source: "built in" } : null;
  }
  I.label = label; I.LABELS = LABELS;
  const isEx = (l) => l && (l.kind === "exchange" || l.kind === "custodian");

  /** What a transfer means for the market, from who sent it and who got it. */
  function classify(ev) {
    const f = label(ev.from), t = label(ev.to);
    ev.fromLabel = f ? f.name : null; ev.toLabel = t ? t.name : null;
    ev.fromEntity = f ? f.entity : null; ev.toEntity = t ? t.entity : null;
    const stable = ev.asset !== "BTC";
    let type = "transfer", bias = "neutral", note = "";
    if (f && f.kind === "mint") { type = "mint"; bias = "bullish"; note = `${ev.asset} minted: new dollars enter crypto`; }
    else if (t && t.kind === "mint") { type = "burn"; bias = "bearish"; note = `${ev.asset} burned: dollars leave crypto`; }
    else if (isEx(f) && isEx(t)) { type = f.entity === t.entity ? "internal" : "exchange-to-exchange"; note = f.entity === t.entity ? `${f.entity} moving its own funds` : `${f.entity} to ${t.entity}`; }
    else if (isEx(t)) { type = "inflow"; bias = stable ? "bullish" : "bearish"; note = stable ? `stablecoins into ${t.entity}: buying power` : `BTC into ${t.entity}: possible selling`; }
    else if (isEx(f)) { type = "outflow"; bias = stable ? "neutral" : "bullish"; note = stable ? `stablecoins leaving ${f.entity}` : `BTC withdrawn from ${f.entity}: accumulation or cold storage`; }
    else if (f && f.kind === "treasury") { type = "treasury-out"; bias = "bullish"; note = `${f.entity} treasury sent ${ev.asset}`; }
    else if (f && (f.kind === "hacker" || f.kind === "gov" || f.kind === "dormant")) { type = "watched-move"; bias = "bearish"; note = `${f.name} moved coins`; }
    ev.type = type; ev.bias = bias; ev.note = note;
    return ev;
  }
  I.classify = classify;

  // ================================================================ BTC: the mempool firehose (blockchain.info)

  /** One blockchain.info "utx" message -> a transfer, or null below the threshold. */
  function btcFromUtx(msg, price, min = Settings.btcMin) {
    const x = msg && msg.x;
    if (!x || !x.out) return null;
    const ins = (x.inputs || []).map((i) => i.prev_out || {}).filter((p) => p.addr);
    const inAddrs = new Set(ins.map((p) => p.addr));
    // value that leaves the senders (change back to an input address is not a transfer)
    const outs = x.out.filter((o) => o.addr && !inAddrs.has(o.addr));
    const moved = outs.reduce((s, o) => s + o.value, 0) / 1e8;
    if (moved < min) return null;
    const topIn = ins.slice().sort((a, b) => b.value - a.value)[0] || {};
    const topOut = outs.slice().sort((a, b) => b.value - a.value)[0] || {};
    // label-aware sender/receiver: prefer a known entity on either side
    const knownIn = ins.find((p) => label(p.addr)), knownOut = outs.slice().sort((a, b) => b.value - a.value).find((o) => label(o.addr));
    const ev = {
      id: "btc:" + x.hash, chain: "bitcoin", asset: "BTC", hash: x.hash, time: x.time || Math.floor(Date.now() / 1000),
      from: (knownIn || topIn).addr || "unknown", to: (knownOut || topOut).addr || "unknown",
      amount: moved, usd: price ? moved * price : null, inputs: ins.length, outputs: outs.length, confirmed: false,
    };
    return classify(ev);
  }
  I.btcFromUtx = btcFromUtx;

  function openBtcStream(onEvent, onStatus) {
    if (!Net.WS) { onStatus && onStatus("bitcoin", "no WebSocket in this browser"); return { close() {} }; }
    let ws, stop = false, tries = 0;
    const connect = () => {
      ws = new Net.WS("wss://ws.blockchain.info/inv");
      ws.onopen = () => { tries = 0; ws.send(JSON.stringify({ op: "unconfirmed_sub" })); onStatus && onStatus("bitcoin", "live"); };
      ws.onmessage = (m) => { try { const j = JSON.parse(m.data); if (j.op === "utx") onEvent(j); } catch {} };
      ws.onclose = () => { if (stop) return; onStatus && onStatus("bitcoin", "reconnecting"); setTimeout(connect, Math.min(30000, 2000 * ++tries)); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    connect();
    return { close() { stop = true; try { ws.close(); } catch {} } };
  }
  I.openBtcStream = openBtcStream;

  async function btcPrice() {
    try { const j = await Net.get("https://mempool.space/api/v1/prices"); if (j.USD) return j.USD; } catch {}
    try { const j = await Net.post("https://api.hyperliquid.xyz/info", { type: "allMids" }); return Number(j.BTC) || null; } catch {}
    return null;
  }
  I.btcPrice = btcPrice;

  /** How old were the coins a whale transaction spends? (dormant coins waking up) */
  async function coinAge(txid) {
    const t = await Net.get(`https://mempool.space/api/tx/${txid}`);
    const prev = [...new Set((t.vin || []).map((v) => v.txid))].slice(0, 5);
    let oldest = null;
    for (const p of prev) {
      try { const pt = await Net.get(`https://mempool.space/api/tx/${p}`); const bt = pt.status && pt.status.block_time; if (bt && (!oldest || bt < oldest)) oldest = bt; } catch {}
    }
    return oldest;
  }
  I.coinAge = coinAge;

  // ================================================================ USDT / USDC on EVM chains (Transfer logs, block by block)

  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const TOKENS = {
    ethereum: { "0xdac17f958d2ee523a2206206994597c13d831ec7": ["USDT", 6], "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ["USDC", 6] },
    bsc: { "0x55d398326f99059ff775485246999027b3197955": ["USDT", 18], "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": ["USDC", 18] },
    polygon: { "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": ["USDT", 6], "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": ["USDC", 6], "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": ["USDC", 6] },
  };
  const EXPLORER = { bitcoin: "https://mempool.space/tx/", ethereum: "https://etherscan.io/tx/", bsc: "https://bscscan.com/tx/", polygon: "https://polygonscan.com/tx/", tron: "https://tronscan.org/#/transaction/" };
  const ADDR_URL = { bitcoin: "https://mempool.space/address/", ethereum: "https://etherscan.io/address/", bsc: "https://bscscan.com/address/", polygon: "https://polygonscan.com/address/", tron: "https://tronscan.org/#/address/" };
  const CHAIN_NAME = { bitcoin: "Bitcoin", ethereum: "Ethereum", bsc: "BNB Chain", polygon: "Polygon", tron: "Tron", hyperliquid: "Hyperliquid" };
  Object.assign(I, { TOKENS, EXPLORER, ADDR_URL, CHAIN_NAME });

  /** eth_getLogs results -> transfers at or above min dollars. */
  function stableFromLogs(chain, logs, blockTimes = {}, min = Settings.stableMin) {
    const out = [];
    for (const l of logs || []) {
      const tok = TOKENS[chain][String(l.address).toLowerCase()];
      if (!tok || !l.topics || l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
      const amount = Number(BigInt(l.data === "0x" ? 0 : l.data)) / Math.pow(10, tok[1]);
      if (amount < min) continue;
      const bn = parseInt(l.blockNumber, 16);
      out.push(classify({
        id: `${chain}:${l.transactionHash}:${parseInt(l.logIndex, 16)}`, chain, asset: tok[0], hash: l.transactionHash,
        time: blockTimes[bn] || Math.floor(Date.now() / 1000), block: bn,
        from: "0x" + l.topics[1].slice(-40), to: "0x" + l.topics[2].slice(-40), amount, usd: amount, confirmed: true,
      }));
    }
    return out;
  }
  I.stableFromLogs = stableFromLogs;

  const rpc = (chain, method, params) => Net.post(Settings.rpc[chain], { jsonrpc: "2.0", id: 1, method, params }).then((j) => { if (j.error) throw new Error(`${CHAIN_NAME[chain]} RPC: ${j.error.message}`); return j.result; });
  I.rpc = rpc;

  /** Poll new blocks of one EVM chain; calls onEvents with each batch. */
  function openEvmWatcher(chain, onEvents, onStatus, every = { ethereum: 12000, bsc: 6000, polygon: 6000 }[chain]) {
    let stop = false, from = null;
    const MAX = { ethereum: 5, bsc: 20, polygon: 10 }[chain];
    const tick = async () => {
      if (stop) return;
      try {
        const head = parseInt(await rpc(chain, "eth_blockNumber", []), 16);
        if (from == null) from = head - 1;
        if (head - from > MAX * 4) { onStatus && onStatus(chain, `skipped ${head - from - MAX} blocks to catch up`); from = head - MAX; }
        const to = Math.min(head, from + MAX - 1);
        if (to >= from) {
          const logs = await rpc(chain, "eth_getLogs", [{ fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), address: Object.keys(TOKENS[chain]), topics: [TRANSFER] }]);
          const big = stableFromLogs(chain, logs);
          if (big.length) {
            // block timestamps for the few blocks that matter
            const times = {};
            for (const bn of [...new Set(big.map((e) => e.block))].slice(0, 6)) { try { const b = await rpc(chain, "eth_getBlockByNumber", ["0x" + bn.toString(16), false]); times[bn] = parseInt(b.timestamp, 16); } catch {} }
            for (const e of big) if (times[e.block]) e.time = times[e.block];
            onEvents(big);
          }
          from = to + 1;
        }
        onStatus && onStatus(chain, `live · block ${head.toLocaleString("en-US")}`);
      } catch (e) { onStatus && onStatus(chain, "error: " + e.message); }
      if (!stop) setTimeout(tick, every);
    };
    tick();
    return { close() { stop = true; } };
  }
  I.openEvmWatcher = openEvmWatcher;

  // ================================================================ USDT on Tron (TronGrid events)

  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function sha256(bytes) {
    const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const l = bytes.length, n = ((l + 9 + 63) >> 6) << 6, m = new Uint8Array(n);
    m.set(bytes); m[l] = 0x80;
    const bits = l * 8; m[n - 4] = bits >>> 24; m[n - 3] = bits >>> 16; m[n - 2] = bits >>> 8; m[n - 1] = bits;
    const w = new Uint32Array(64), r = (x, k) => (x >>> k) | (x << (32 - k));
    for (let o = 0; o < n; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = (m[o + 4 * i] << 24) | (m[o + 4 * i + 1] << 16) | (m[o + 4 * i + 2] << 8) | m[o + 4 * i + 3];
      for (let i = 16; i < 64; i++) w[i] = (w[i - 16] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10))) | 0;
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      [a, b, c, d, e, f, g, h].forEach((v, i) => (H[i] = (H[i] + v) | 0));
    }
    const out = new Uint8Array(32);
    H.forEach((v, i) => { out[4 * i] = v >>> 24; out[4 * i + 1] = v >>> 16; out[4 * i + 2] = v >>> 8; out[4 * i + 3] = v; });
    return out;
  }
  function tronAddr(hex) {
    if (!hex || hex[0] === "T") return hex;
    let h = hex.replace(/^0x/, "");
    if (h.length === 40) h = "41" + h;
    const bytes = new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
    const all = new Uint8Array(25); all.set(bytes); all.set(sha256(sha256(bytes)).slice(0, 4), 21);
    let x = 0n; for (const b of all) x = x * 256n + BigInt(b);
    let s = ""; while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; }
    return s;
  }
  I.tronAddr = tronAddr; I.sha256 = sha256;
  const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

  function tronFromEvents(data, min = Settings.stableMin) {
    const out = [];
    for (const e of data || []) {
      const r = e.result || {};
      const amount = Number(r.value || r._value || 0) / 1e6;
      if (amount < min) continue;
      out.push(classify({ id: `tron:${e.transaction_id}:${e.event_index || 0}`, chain: "tron", asset: "USDT", hash: e.transaction_id, time: Math.floor(e.block_timestamp / 1000), block: e.block_number,
        from: tronAddr(r.from || r._from), to: tronAddr(r.to || r._to), amount, usd: amount, confirmed: true }));
    }
    return out;
  }
  I.tronFromEvents = tronFromEvents;

  function openTronWatcher(onEvents, onStatus, every = 8000) {
    let stop = false, since = Date.now() - 60000;
    const seen = new Set();
    const tick = async () => {
      if (stop) return;
      try {
        const h = Settings.trongridKey ? { headers: { "TRON-PRO-API-KEY": Settings.trongridKey } } : undefined;
        const j = await Net.request(`https://api.trongrid.io/v1/contracts/${TRON_USDT}/events?event_name=Transfer&only_confirmed=false&order_by=block_timestamp,asc&limit=200&min_block_timestamp=${since}`, h);
        const data = j.data || [];
        if (data.length) since = Math.max(since, ...data.map((e) => e.block_timestamp));
        const big = tronFromEvents(data).filter((e) => !seen.has(e.id) && seen.add(e.id));
        if (big.length) onEvents(big);
        onStatus && onStatus("tron", "live");
      } catch (e) { onStatus && onStatus("tron", "error: " + e.message); }
      if (!stop) setTimeout(tick, every);
    };
    tick();
    return { close() { stop = true; } };
  }
  I.openTronWatcher = openTronWatcher;

  // ================================================================ top BTC holders: buying or selling?

  const HOLDERS = [
    "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo", "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97", "3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6",
    "bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2", "bc1qazcm763858nkj2dj986etajv6wquslv8uxwczt", "1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  ];
  I.HOLDERS = HOLDERS;

  /** Net change of an address over windows, from its recent transactions (mempool.space format). */
  function netChange(address, txs, now = Date.now() / 1000) {
    const W = { d1: 86400, d7: 7 * 86400, d30: 30 * 86400 };
    const res = { d1: 0, d7: 0, d30: 0, lastMove: null, recent: [] };
    for (const t of txs) {
      const time = (t.status && t.status.block_time) || now;
      const inV = (t.vin || []).filter((v) => v.prevout && v.prevout.scriptpubkey_address === address).reduce((s, v) => s + v.prevout.value, 0);
      const outV = (t.vout || []).filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + o.value, 0);
      const delta = (outV - inV) / 1e8;
      if (res.lastMove == null || time > res.lastMove) res.lastMove = time;
      for (const [k, w] of Object.entries(W)) if (now - time <= w) res[k] += delta;
      if (res.recent.length < 8) res.recent.push({ txid: t.txid, time, delta, pending: !(t.status && t.status.confirmed) });
    }
    return res;
  }
  I.netChange = netChange;

  async function holder(address, price, now = Date.now() / 1000) {
    const [a, txs] = await Promise.all([Net.get(`https://mempool.space/api/address/${address}`), Net.get(`https://mempool.space/api/address/${address}/txs`)]);
    const cs = a.chain_stats || {}, ms = a.mempool_stats || {};
    const balance = (cs.funded_txo_sum - cs.spent_txo_sum + (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0)) / 1e8;
    const n = netChange(address, txs, now);
    const l = label(address);
    const span = n.d7;
    const action = Math.abs(span) < Math.max(1, balance * 0.001) ? (n.lastMove && now - n.lastMove > 365 * 86400 ? "dormant" : "holding") : span > 0 ? "accumulating" : "distributing";
    return { address, name: l ? l.name : "Watched wallet", entity: l ? l.entity : null, kind: l ? l.kind : null, balance, usd: price ? balance * price : null, txCount: cs.tx_count, pending: ms.tx_count || 0, ...n, action };
  }
  I.holder = holder;

  // ================================================================ perps: Hyperliquid (positions are public) and Aster

  const HL = "https://api.hyperliquid.xyz/info";
  async function hlMarket(coin = "BTC") {
    const [meta, ctxs] = await Net.post(HL, { type: "metaAndAssetCtxs" });
    const i = meta.universe.findIndex((u) => u.name === coin);
    if (i < 0) throw new Error(`${coin} not listed on Hyperliquid`);
    const c = ctxs[i];
    return { coin, mark: Number(c.markPx), funding: Number(c.funding), oi: Number(c.openInterest), oiUsd: Number(c.openInterest) * Number(c.markPx), vol24: Number(c.dayNtlVlm), premium: Number(c.premium), maxLeverage: meta.universe[i].maxLeverage };
  }
  I.hlMarket = hlMarket;

  /** Leaderboard rows -> the top traders by a window's profit. */
  function topTraders(lb, window = "month", n = 25) {
    return (lb.leaderboardRows || []).map((r) => {
      const w = Object.fromEntries((r.windowPerformances || []).map(([k, v]) => [k, v]));
      const p = w[window] || {};
      return { address: r.ethAddress, name: r.displayName || null, accountValue: Number(r.accountValue), pnl: Number(p.pnl || 0), roi: Number(p.roi || 0), volume: Number(p.vlm || 0) };
    }).sort((a, b) => b.pnl - a.pnl).slice(0, n);
  }
  I.topTraders = topTraders;

  async function hlLeaderboard() { return Net.get("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard"); }
  I.hlLeaderboard = hlLeaderboard;

  /** A trader's open positions (Hyperliquid clearinghouseState). */
  function positionsFrom(state) {
    return (state.assetPositions || []).map((p) => p.position).filter(Boolean).map((p) => {
      const size = Number(p.szi);
      return { coin: p.coin, side: size > 0 ? "long" : "short", size: Math.abs(size), entry: Number(p.entryPx), value: Number(p.positionValue), pnl: Number(p.unrealizedPnl), leverage: p.leverage ? Number(p.leverage.value) : null, leverageType: p.leverage ? p.leverage.type : null, liq: p.liquidationPx ? Number(p.liquidationPx) : null, margin: Number(p.marginUsed) };
    });
  }
  async function hlPositions(user) {
    const s = await Net.post(HL, { type: "clearinghouseState", user });
    return { equity: Number((s.marginSummary || {}).accountValue || 0), positions: positionsFrom(s) };
  }
  Object.assign(I, { positionsFrom, hlPositions });

  /** Long vs short among the traders we looked at, for one coin. */
  function positioning(traders, coin = "BTC") {
    let long = 0, short = 0, lev = [], n = 0;
    for (const t of traders) for (const p of t.positions || []) if (p.coin === coin) { n++; if (p.side === "long") long += p.value; else short += p.value; if (p.leverage) lev.push(p.leverage); }
    lev.sort((a, b) => a - b);
    return { coin, long, short, traders: n, longShare: long + short ? long / (long + short) : null, medianLeverage: lev.length ? lev[Math.floor(lev.length / 2)] : null };
  }
  I.positioning = positioning;

  /** Hyperliquid trades WebSocket -> big trades. */
  function bigTrades(msg, min = Settings.perpMin) {
    if (!msg || msg.channel !== "trades") return [];
    return (msg.data || []).map((t) => ({ id: `hl:${t.hash}:${t.tid}`, chain: "hyperliquid", asset: "BTC-PERP", coin: t.coin, side: t.side === "B" ? "buy" : "sell", px: Number(t.px), sz: Number(t.sz), usd: Number(t.px) * Number(t.sz), time: Math.floor(t.time / 1000), users: t.users || [], hash: t.hash, bias: t.side === "B" ? "bullish" : "bearish", type: "perp-trade" }))
      .filter((t) => t.usd >= min);
  }
  I.bigTrades = bigTrades;

  function openHlTrades(onTrades, onStatus, coin = "BTC") {
    if (!Net.WS) return { close() {} };
    let ws, stop = false, tries = 0;
    const connect = () => {
      ws = new Net.WS("wss://api.hyperliquid.xyz/ws");
      ws.onopen = () => { tries = 0; ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "trades", coin } })); onStatus && onStatus("hyperliquid", "live"); };
      ws.onmessage = (m) => { try { const t = bigTrades(JSON.parse(m.data)); if (t.length) onTrades(t); } catch {} };
      ws.onclose = () => { if (stop) return; onStatus && onStatus("hyperliquid", "reconnecting"); setTimeout(connect, Math.min(30000, 2000 * ++tries)); };
      ws.onerror = () => { try { ws.close(); } catch {} };
    };
    connect();
    return { close() { stop = true; try { ws.close(); } catch {} } };
  }
  I.openHlTrades = openHlTrades;

  async function asterMarket(symbol = "BTCUSDT") {
    const b = "https://fapi.asterdex.com/fapi/v1";
    const [p, oi, t] = await Promise.all([Net.get(`${b}/premiumIndex?symbol=${symbol}`), Net.get(`${b}/openInterest?symbol=${symbol}`), Net.get(`${b}/ticker/24hr?symbol=${symbol}`)]);
    return { symbol, mark: Number(p.markPrice), funding: Number(p.lastFundingRate), nextFunding: p.nextFundingTime, oi: Number(oi.openInterest), oiUsd: Number(oi.openInterest) * Number(p.markPrice), vol24: Number(t.quoteVolume), change24: Number(t.priceChangePercent) };
  }
  I.asterMarket = asterMarket;

  // ================================================================ macro: calendar and prediction markets

  // FOMC decision days (second day of each meeting), 2026 schedule. Add later years from federalreserve.gov.
  const FOMC = ["2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"];
  /** Upcoming market-moving events: FOMC from the schedule, jobs report (NFP) on the usual first Friday. */
  function calendar(now = new Date(), days = 60) {
    const out = [];
    const end = new Date(now.getTime() + days * 86400e3), today = now.toISOString().slice(0, 10);
    for (const d of FOMC) if (d >= today && new Date(d) <= end) out.push({ date: d, time: "14:00 ET", name: "Fed rate decision (FOMC)", kind: "fed", confirmed: true, note: "Statement 2:00 PM ET, press conference 2:30 PM; confirm at federalreserve.gov" });
    for (let m = 0; m < 3; m++) {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + m, 1));
      const fri = new Date(first.getTime() + ((5 - first.getUTCDay() + 7) % 7) * 86400e3);
      const d = fri.toISOString().slice(0, 10);
      if (d >= today && fri <= end) out.push({ date: d, time: "08:30 ET", name: "US jobs report (NFP)", kind: "jobs", confirmed: false, note: "Usually the first Friday; confirm on bls.gov" });
    }
    return out.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  I.calendar = calendar;
  I.FOMC = FOMC;

  const MACRO_RX = /\bfed\b|fomc|rate (cut|hike)|interest rate|powell|cpi|inflation|jobs|payroll|nfp|unemployment|recession|gdp|bitcoin|btc|tether|usdt|usdc|stablecoin/i;
  /** Polymarket events -> markets with their current odds. */
  function polyMarkets(events) {
    const out = [];
    for (const e of events || []) {
      if (!MACRO_RX.test(`${e.title} ${e.slug || ""}`)) continue;
      for (const m of e.markets || []) {
        if (m.closed) continue;
        let outcomes = [], prices = [];
        try { outcomes = typeof m.outcomes === "string" ? JSON.parse(m.outcomes) : m.outcomes || []; prices = (typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices || []).map(Number); } catch {}
        out.push({ source: "Polymarket", event: e.title, question: m.groupItemTitle || m.question, yes: outcomes[0] === "Yes" ? prices[0] : prices[0], outcomes, prices, volume: Number(m.volume || 0), volume24: Number(m.volume24hr || 0), change24: m.oneDayPriceChange != null ? Number(m.oneDayPriceChange) : null, ends: m.endDate || e.endDate, url: `https://polymarket.com/event/${e.slug}` });
      }
    }
    return out;
  }
  I.polyMarkets = polyMarkets;

  async function predictions() {
    const res = { markets: [], errors: [] };
    try {
      const evs = [];
      for (const tag of ["fed", "economy", "crypto"]) {
        try { evs.push(...(await Net.get(`https://gamma-api.polymarket.com/events?closed=false&limit=40&order=volume24hr&ascending=false&tag_slug=${tag}`))); } catch (e) { res.errors.push(`Polymarket ${tag}: ${e.message}`); }
      }
      const seen = new Set();
      res.markets.push(...polyMarkets(evs.filter((e) => !seen.has(e.id) && seen.add(e.id))));
    } catch (e) { res.errors.push("Polymarket: " + e.message); }
    for (const series of ["KXFEDDECISION", "KXFED"]) {
      try {
        const j = await Net.get(`https://api.elections.kalshi.com/trade-api/v2/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=3`);
        for (const e of j.events || []) for (const m of e.markets || []) res.markets.push({ source: "Kalshi", event: e.title, question: m.yes_sub_title || m.subtitle || m.title, yes: m.last_price != null ? m.last_price / 100 : null, volume: Number(m.volume || 0), volume24: Number(m.volume_24h || 0), change24: m.previous_price != null && m.last_price != null ? (m.last_price - m.previous_price) / 100 : null, ends: m.close_time, url: `https://kalshi.com/markets/${(e.series_ticker || series).toLowerCase()}` });
        break;
      } catch (e) { res.errors.push(`Kalshi ${series}: ${e.message}`); }
    }
    res.markets.sort((a, b) => b.volume24 - a.volume24 || b.volume - a.volume);
    return res;
  }
  I.predictions = predictions;

  async function fearGreed() { const j = await Net.get("https://api.alternative.me/fng/?limit=2"); const d = j.data || []; return d.length ? { value: Number(d[0].value), label: d[0].value_classification, prev: d[1] ? Number(d[1].value) : null } : null; }
  I.fearGreed = fearGreed;

  // ================================================================ the anomaly agent

  const SEV = (x) => (x >= 80 ? "critical" : x >= 55 ? "high" : x >= 30 ? "medium" : "low");

  /**
   * Look at one new event in the light of what came before (history: recent events, newest last).
   * Returns zero or more anomalies: {id, time, score, severity, bias, title, why, event}.
   */
  function detect(ev, history = [], ctx = {}) {
    const out = [];
    const add = (score, title, why, extra = {}) => out.push(Object.assign({ id: `a:${ev.id}:${out.length}`, time: ev.time, score: Math.round(Math.min(100, score)), severity: SEV(score), bias: ev.bias, title, why, event: ev }, extra));
    const btc = ev.asset === "BTC";
    const size = btc ? ev.amount : ev.usd;
    const big = btc ? Settings.btcMin : Settings.stableMin;
    const mult = size / big;                     // how many times the threshold
    // 1x the threshold ~ low, 4x ~ medium, 16x ~ high, 64x+ ~ critical (before the per-signal bonus)
    const base = 15 + 14 * Math.log2(Math.max(1, mult));
    if (ev.type === "inflow" && btc && !label(ev.from)) add(base + 15, `${fmtNum(ev.amount, 0)} BTC from an unknown wallet into ${ev.toEntity}`, `${fmtUsd(ev.usd)} landed in an exchange wallet. Coins sent to an exchange are usually there to be sold or used as collateral: watch for selling pressure.`);
    else if (ev.type === "inflow" && !btc) add(base + 5, `${fmtUsd(ev.usd)} ${ev.asset} into ${ev.toEntity}`, `Stablecoins arriving on an exchange are buying power: often a large buyer getting ready, sometimes a market maker refilling.`);
    else if (ev.type === "outflow" && btc) add(base, `${fmtNum(ev.amount, 0)} BTC withdrawn from ${ev.fromEntity}`, `Coins leaving an exchange to a private wallet usually means accumulation or cold storage: fewer coins for sale.`);
    else if (ev.type === "mint") add(base + 20, `${fmtUsd(ev.usd)} ${ev.asset} minted on ${CHAIN_NAME[ev.chain]}`, `${ev.asset === "USDT" ? "Tether" : "Circle"} created new tokens. New stablecoins have historically come before buying.`);
    else if (ev.type === "burn") add(base + 10, `${fmtUsd(ev.usd)} ${ev.asset} burned on ${CHAIN_NAME[ev.chain]}`, `Stablecoins redeemed for dollars: money leaving crypto.`);
    else if (ev.type === "watched-move") add(90, `${ev.fromLabel} moved ${btc ? fmtNum(ev.amount, 0) + " BTC" : fmtUsd(ev.usd)}`, `A watched wallet (long dormant, seized, or hacked funds) moved. Such moves often come before coins reach exchanges.`);
    else if (ev.type === "treasury-out") add(base + 5, `${ev.fromEntity} sent ${fmtUsd(ev.usd)} ${ev.asset}`, `Fresh stablecoins leaving the issuer's treasury, usually to an exchange or a market maker.`);
    else if (ev.type === "exchange-to-exchange" && mult >= 3) add(base - 5, `${btc ? fmtNum(ev.amount, 0) + " BTC" : fmtUsd(ev.usd)} from ${ev.fromEntity} to ${ev.toEntity}`, `A large move between exchanges: often arbitrage or an OTC settlement.`);
    else if (ev.type === "transfer" && mult >= 10) add(base, `${btc ? fmtNum(ev.amount, 0) + " BTC" : fmtUsd(ev.usd)} moved between unknown wallets`, `A very large transfer between unlabeled wallets: could be an OTC desk, a fund or a custodian reshuffling. Label the wallets if you know them.`);
    if (ev.coinAgeYears != null && ev.coinAgeYears >= 3 && btc) add(70 + Math.min(25, ev.coinAgeYears * 2), `Coins dormant ${ev.coinAgeYears.toFixed(1)} years just moved (${fmtNum(ev.amount, 0)} BTC)`, `Old coins waking up is one of the strongest on-chain signals: long-term holders rarely move unless they plan to sell or re-custody.`, { bias: "bearish" });
    if (ev.type === "perp-trade") add(20 + 14 * Math.log2(Math.max(1, ev.usd / Settings.perpMin)), `${fmtUsd(ev.usd)} ${ev.side === "buy" ? "market buy" : "market sell"} of ${ev.coin} on Hyperliquid`, `A single aggressive ${ev.side} of this size moves the order book. Traders: ${ev.users.map(short).join(" vs ")}.`);
    // burst: the same direction into exchanges several times within an hour
    if (["inflow", "outflow"].includes(ev.type)) {
      const hour = history.filter((h) => h.type === ev.type && h.asset === ev.asset && ev.time - h.time <= 3600 && h.id !== ev.id);
      if (hour.length >= 3) {
        const sum = hour.reduce((s, h) => s + (h.usd || 0), 0) + (ev.usd || 0);
        add(60 + Math.min(30, hour.length * 4), `${hour.length + 1} large ${ev.asset} ${ev.type === "inflow" ? "deposits to" : "withdrawals from"} exchanges in an hour (${fmtUsd(sum)})`, ev.type === "inflow" ? (btc ? "Repeated deposits are a classic sign of a holder preparing to sell in pieces." : "Repeated stablecoin deposits: a buyer may be getting ready.") : "Repeated withdrawals: someone is accumulating.", { id: `a:burst:${ev.asset}:${ev.type}:${Math.floor(ev.time / 3600)}` });
      }
    }
    return out;
  }
  I.detect = detect;

  /** Exchange net flow per asset over a window: negative means coins leaving exchanges. */
  function netflow(events, now = Date.now() / 1000, window = 86400) {
    const res = {};
    for (const e of events) {
      if (now - e.time > window) continue;
      const k = e.asset === "BTC" ? "BTC" : "stables";
      res[k] = res[k] || { in: 0, out: 0, inUsd: 0, outUsd: 0, n: 0 };
      if (e.type === "inflow") { res[k].in += e.amount; res[k].inUsd += e.usd || 0; }
      if (e.type === "outflow") { res[k].out += e.amount; res[k].outUsd += e.usd || 0; }
      res[k].n++;
    }
    return res;
  }
  I.netflow = netflow;

  /** Market checks that are not single transfers: funding extremes and crowded positioning. */
  function marketAnomalies(m, pos, now = Math.floor(Date.now() / 1000)) {
    const out = [];
    if (m && Math.abs(m.funding) >= 0.0001) {
      const annual = m.funding * 24 * 365 * 100;
      out.push({ id: `a:funding:${Math.floor(now / 3600)}`, time: now, score: Math.min(95, 40 + Math.abs(annual) / 2), severity: SEV(40 + Math.abs(annual) / 2), bias: m.funding > 0 ? "bearish" : "bullish", title: `Hyperliquid BTC funding ${m.funding > 0 ? "+" : ""}${(m.funding * 100).toFixed(4)}% an hour (${annual.toFixed(0)}% a year)`, why: m.funding > 0 ? "Longs are paying a lot to stay open: crowded longs can unwind fast (long squeeze risk)." : "Shorts are paying to stay open: crowded shorts can be squeezed upward." });
    }
    if (pos && pos.longShare != null && pos.traders >= 5 && (pos.longShare > 0.75 || pos.longShare < 0.25)) {
      const s = 45 + Math.abs(pos.longShare - 0.5) * 80;
      out.push({ id: `a:crowd:${Math.floor(now / 3600)}`, time: now, score: Math.round(s), severity: SEV(s), bias: pos.longShare > 0.5 ? "bullish" : "bearish", title: `Top Hyperliquid traders are ${(pos.longShare * 100).toFixed(0)}% long BTC`, why: `Across ${pos.traders} BTC positions of the most profitable traders (median leverage ${pos.medianLeverage || "?"}x). Top traders' side is worth watching; extreme agreement can also mark a turning point.` });
    }
    return out;
  }
  I.marketAnomalies = marketAnomalies;

  // ================================================================ AI briefing (your Claude key, called from this browser)

  async function brief({ anomalies, flows, market, positioning: pos, predictions: preds, calendar: cal }) {
    if (!Settings.anthropicKey) throw new Error("Add your Anthropic API key in Settings to get AI briefings.");
    const data = {
      now: new Date().toISOString(),
      anomalies: anomalies.slice(0, 40).map((a) => ({ time: new Date(a.time * 1000).toISOString(), severity: a.severity, bias: a.bias, title: a.title })),
      exchange_netflow_24h: flows, hyperliquid_btc: market, top_trader_positioning: pos,
      prediction_markets: (preds || []).slice(0, 15).map((p) => ({ source: p.source, market: `${p.event}: ${p.question}`, yes: p.yes, change24: p.change24 })),
      calendar: cal,
    };
    const res = await Net.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": Settings.anthropicKey, "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({
        model: "claude-opus-5-5", max_tokens: 16000, fallbacks: "default", output_config: { effort: "medium" },
        system: "You are an on-chain market analyst for BTC, USDT and USDC. You get a JSON snapshot of whale transfers, exchange flows, perp positioning, prediction markets and the macro calendar. Write a short briefing for a trader reading on a phone: what stands out, what it may mean (cite the specific transfers and numbers), the main upcoming event and what prediction markets expect, and what to watch next. Separate facts from interpretation, say when the data is thin, and never present a guess as certain. No financial advice. Plain text, under 250 words.",
        messages: [{ role: "user", content: JSON.stringify(data) }],
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error((j.error && j.error.message) || `Anthropic API answered HTTP ${res.status}`);
    if (j.stop_reason === "refusal") throw new Error("The model declined this request.");
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  }
  I.brief = brief;

  // ================================================================ diagnostics

  const PROBES = [
    ["Bitcoin price (mempool.space)", () => Net.get("https://mempool.space/api/v1/prices")],
    ["Ethereum RPC (PublicNode)", () => rpc("ethereum", "eth_blockNumber", [])],
    ["BNB Chain RPC (PublicNode)", () => rpc("bsc", "eth_blockNumber", [])],
    ["Polygon RPC (PublicNode)", () => rpc("polygon", "eth_blockNumber", [])],
    ["Tron USDT events (TronGrid)", () => Net.get(`https://api.trongrid.io/v1/contracts/${TRON_USDT}/events?event_name=Transfer&limit=1`)],
    ["Hyperliquid", () => hlMarket("BTC")],
    ["Aster", () => asterMarket("BTCUSDT")],
    ["Polymarket", () => Net.get("https://gamma-api.polymarket.com/events?closed=false&limit=1")],
    ["Kalshi", () => Net.get("https://api.elections.kalshi.com/trade-api/v2/events?limit=1")],
    ["Fear & Greed (alternative.me)", () => fearGreed()],
    ["BTC live stream (blockchain.info)", () => new Promise((ok, no) => { if (!Net.WS) return no(new Error("no WebSocket")); const ws = new Net.WS("wss://ws.blockchain.info/inv"); const t = setTimeout(() => { try { ws.close(); } catch {} no(new Error("no answer in 8 s")); }, 8000); ws.onopen = () => ws.send(JSON.stringify({ op: "ping" })); ws.onmessage = () => { clearTimeout(t); ws.close(); ok(); }; ws.onerror = () => { clearTimeout(t); no(new Error("could not connect")); }; })],
  ];
  async function diagnostics(onRow) {
    for (const [name, fn] of PROBES) {
      const t = Date.now();
      try { await fn(); onRow({ name, ok: true, ms: Date.now() - t }); } catch (e) { onRow({ name, ok: false, error: e.message }); }
    }
  }
  I.diagnostics = diagnostics;

  if (typeof module !== "undefined" && module.exports) module.exports = I;
  else root.Intel = I;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();

// ---------------------------------------------------------------- configuration
const env = process.env;
const CFG = {
  port: +(env.PORT || 8787),
  host: env.HOST || "127.0.0.1",                 // Caddy in front handles HTTPS
  key: env.ACCESS_KEY || "",                     // the password the app and API need
  db: env.DB_FILE || path.join(__dirname, "data", "intel.db"),
  app: env.APP_FILE || path.join(__dirname, "tradergze-intel.html"),
  telegramToken: env.TELEGRAM_BOT_TOKEN || "",
  telegramChat: env.TELEGRAM_CHAT_ID || "",       // filled in automatically by /start <ACCESS_KEY>
  alertMin: env.ALERT_MIN || "high",             // high | critical
  keepDays: +(env.KEEP_DAYS || 365),
  digestHourUtc: +(env.DIGEST_HOUR_UTC || 13),
};
if (!CFG.key || CFG.key.length < 8) { console.error("Set ACCESS_KEY (8+ characters) so only you can open the app."); process.exit(1); }
const S = X.Settings;
S.btcMin = +(env.BTC_MIN || S.btcMin);
S.stableMin = +(env.STABLE_MIN || S.stableMin);
S.perpMin = +(env.PERP_MIN || S.perpMin);
S.anthropicKey = env.ANTHROPIC_API_KEY || "";
S.trongridKey = env.TRONGRID_KEY || "";
for (const c of ["ethereum", "bsc", "polygon"]) if (env[`RPC_${c.toUpperCase()}`]) S.rpc[c] = env[`RPC_${c.toUpperCase()}`];
for (const c of ["ethereum", "bsc", "polygon", "tron"]) if (env[`CHAIN_${c.toUpperCase()}`] === "0") S.chains[c] = false;
X.Net.WS = globalThis.WebSocket;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------------------------------------------------------------- database
fs.mkdirSync(path.dirname(CFG.db), { recursive: true });
const db = new DatabaseSync(CFG.db);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, time INTEGER, chain TEXT, asset TEXT, type TEXT, bias TEXT, usd REAL, data TEXT);
  CREATE INDEX IF NOT EXISTS events_time ON events(time);
  CREATE TABLE IF NOT EXISTS anomalies (id TEXT PRIMARY KEY, time INTEGER, severity TEXT, score INTEGER, data TEXT);
  CREATE INDEX IF NOT EXISTS anomalies_time ON anomalies(time);
  CREATE TABLE IF NOT EXISTS labels (address TEXT PRIMARY KEY, name TEXT, kind TEXT, entity TEXT, source TEXT, seen INTEGER, added INTEGER);
  CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);
const kvGet = (k, d = null) => { const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(k); return r ? JSON.parse(r.v) : d; };
const kvSet = (k, v) => db.prepare("INSERT INTO kv(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));
const insEvent = db.prepare("INSERT OR IGNORE INTO events(id, time, chain, asset, type, bias, usd, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)");
const insAnom = db.prepare("INSERT OR IGNORE INTO anomalies(id, time, severity, score, data) VALUES(?, ?, ?, ?, ?)");
const rows = (sql, ...a) => db.prepare(sql).all(...a).map((r) => JSON.parse(r.data));
if (!CFG.telegramChat) CFG.telegramChat = kvGet("telegramChat", "");

// labels you or the learner added are applied on top of the built-in ones
function loadLabels() {
  const out = {};
  for (const r of db.prepare("SELECT * FROM labels").all()) out[r.address] = [r.name, r.kind, r.entity];
  S.labels = out;
}
loadLabels();

// ---------------------------------------------------------------- learning exchange deposit wallets
// An exchange sweeps its many deposit addresses into a known hot or cold wallet. When a BTC
// transaction gathers several inputs into one known exchange wallet, or a stablecoin wallet sends
// a large amount straight to one, the sending addresses are learned as that exchange's deposits.
const learnLabel = db.prepare("INSERT INTO labels(address, name, kind, entity, source, seen, added) VALUES(?, ?, 'exchange', ?, 'learned', 1, ?) ON CONFLICT(address) DO UPDATE SET seen = seen + 1 WHERE source = 'learned'");
function learnFromBtc(msg) {
  const x = msg.x;
  if (!x || !x.out || !x.inputs) return 0;
  const outs = x.out.filter((o) => o.addr);
  if (outs.length !== 1) return 0;
  const target = X.label(outs[0].addr);
  if (!target || target.kind !== "exchange" || target.source === "learned") return 0;
  const ins = [...new Set(x.inputs.map((i) => i.prev_out && i.prev_out.addr).filter(Boolean))].filter((a) => !X.label(a));
  if (ins.length < 3) return 0;                     // a consolidation, not one customer's withdrawal
  for (const a of ins) learnLabel.run(a, `${target.entity} deposit (learned)`, target.entity, Math.floor(Date.now() / 1000));
  loadLabels();
  return ins.length;
}
function learnFromStable(e) {
  if (e.type !== "inflow" || X.label(e.from)) return;
  learnLabel.run(e.from.toLowerCase(), `${e.toEntity} deposit (learned)`, e.toEntity, Math.floor(Date.now() / 1000));
}

// ---------------------------------------------------------------- the live pipeline
const recent = [];                                   // last events, for the agent's burst checks
const clients = new Set();                           // open app streams (server-sent events)
let price = null, stats = { started: Date.now(), events: 0, anomalies: 0, learned: 0 }, status = {};

function broadcast(kind, data) { const line = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(line); }
function addEvents(list) {
  for (const e of list) {
    if (!insEvent.run(e.id, e.time, e.chain, e.asset, e.type, e.bias, e.usd || 0, JSON.stringify(e)).changes) continue;
    stats.events++;
    recent.push(e); if (recent.length > 1000) recent.shift();
    broadcast("transfer", e);
    if (e.asset === "USDT" || e.asset === "USDC") learnFromStable(e);
    addAnomalies(X.detect(e, recent));
    if (e.asset === "BTC" && e.amount >= Math.max(S.btcMin * 2, 200)) setTimeout(() => checkAge(e), 15000);
  }
}
async function checkAge(e) {
  try {
    const oldest = await X.coinAge(e.hash);
    if (!oldest) return;
    e.coinAgeYears = (e.time - oldest) / (365.25 * 86400);
    db.prepare("UPDATE events SET data = ? WHERE id = ?").run(JSON.stringify(e), e.id);
    if (e.coinAgeYears >= 3) addAnomalies(X.detect(e, []).filter((a) => /dormant/.test(a.title)));
  } catch {}
}
const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
function addAnomalies(list) {
  for (const a of list) {
    if (!insAnom.run(a.id, a.time, a.severity, a.score, JSON.stringify(a)).changes) continue;
    stats.anomalies++;
    broadcast("anomaly", a);
    if (RANK[a.severity] >= RANK[CFG.alertMin]) telegramAlert(a);
  }
}

// hourly exchange netflow far outside the last week's range
function netflowCheck() {
  const now = Math.floor(Date.now() / 1000), hour = 3600;
  for (const asset of ["BTC", "stables"]) {
    const assets = asset === "BTC" ? ["BTC"] : ["USDT", "USDC"];
    const q = db.prepare(`SELECT time / ${hour} AS h, SUM(CASE WHEN type = 'inflow' THEN usd WHEN type = 'outflow' THEN -usd ELSE 0 END) AS net FROM events WHERE time > ? AND asset IN (${assets.map(() => "?").join(",")}) GROUP BY h`).all(now - 7 * 86400, ...assets);
    const cur = Math.floor(now / hour) - 1;
    const past = q.filter((r) => r.h < cur).map((r) => r.net), last = q.find((r) => r.h === cur);
    if (past.length < 48 || !last) continue;
    const mean = past.reduce((s, x) => s + x, 0) / past.length, sd = Math.sqrt(past.reduce((s, x) => s + (x - mean) ** 2, 0) / past.length) || 1;
    const z = (last.net - mean) / sd;
    if (Math.abs(z) >= 3) addAnomalies([{ id: `a:netflow:${asset}:${cur}`, time: now, score: Math.min(95, 50 + Math.abs(z) * 8), severity: Math.abs(z) >= 5 ? "critical" : "high", bias: (last.net > 0) === (asset === "BTC") ? "bearish" : "bullish",
      title: `Unusual hour: ${X.fmtUsd(Math.abs(last.net))} of ${asset === "BTC" ? "BTC" : "stablecoins"} net ${last.net > 0 ? "into" : "out of"} exchanges (${z.toFixed(1)}σ)`,
      why: `The last hour's exchange net flow is ${Math.abs(z).toFixed(1)} standard deviations from the past week's hourly average (${X.fmtUsd(mean)}).` }]);
  }
}

// ---------------------------------------------------------------- slow-moving data, cached for the app
const cache = { holders: null, perps: null, macro: null };
async function refreshHolders() {
  const out = [];
  for (const a of X.HOLDERS.concat(kvGet("holders", []))) { try { out.push(await X.holder(a, price)); } catch (e) { out.push({ address: a, error: e.message }); } }
  const prev = kvGet("holdersPrev", {});
  for (const h of out) if (h.balance != null && prev[h.address] != null && Math.abs(h.balance - prev[h.address]) >= Math.max(100, S.btcMin))
    addAnomalies([{ id: `a:holder:${h.address}:${Math.floor(Date.now() / 3600e3)}`, time: Math.floor(Date.now() / 1000), score: 70, severity: "high", bias: h.balance < prev[h.address] ? "bearish" : "bullish", title: `${h.name} ${h.balance < prev[h.address] ? "sent out" : "received"} ${X.fmtNum(Math.abs(h.balance - prev[h.address]), 0)} BTC`, why: `Balance went from ${X.fmtNum(prev[h.address], 0)} to ${X.fmtNum(h.balance, 0)} BTC since the last check.` }]);
  kvSet("holdersPrev", Object.fromEntries(out.filter((h) => h.balance != null).map((h) => [h.address, h.balance])));
  cache.holders = { at: Math.floor(Date.now() / 1000), rows: out };
}
async function refreshPerps(withTraders) {
  const p = cache.perps || {};
  try { p.hl = await X.hlMarket("BTC"); } catch (e) { p.hlError = e.message; }
  try { p.aster = await X.asterMarket("BTCUSDT"); } catch (e) { p.asterError = e.message; }
  if (withTraders) {
    try {
      const top = X.topTraders(await X.hlLeaderboard(), "month", 30);
      for (const t of top) { try { Object.assign(t, await X.hlPositions(t.address)); } catch (e) { t.error = e.message; } }
      p.traders = top; p.pos = X.positioning(top, "BTC"); p.tradersAt = Math.floor(Date.now() / 1000);
    } catch (e) { p.tradersError = e.message; }
  }
  p.at = Math.floor(Date.now() / 1000);
  cache.perps = p;
  addAnomalies(X.marketAnomalies(p.hl, p.pos));
}
async function refreshMacro() {
  const m = { at: Math.floor(Date.now() / 1000), calendar: X.calendar() };
  try { Object.assign(m, await X.predictions()); } catch (e) { m.errors = [e.message]; }
  try { m.fearGreed = await X.fearGreed(); } catch {}
  cache.macro = m;
}
const every = (ms, fn) => { const run = () => fn().catch((e) => log("job failed:", e.message)); run(); return setInterval(run, ms); };

// ---------------------------------------------------------------- Telegram
const tg = (method, body) => CFG.telegramToken ? fetch(`https://api.telegram.org/bot${CFG.telegramToken}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()) : Promise.resolve(null);
const tgSend = (text, chat = CFG.telegramChat) => (chat ? tg("sendMessage", { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }) : null);
const icon = { bullish: "🟢", bearish: "🔴", neutral: "⚪" };
function telegramAlert(a) {
  if (kvGet("muteUntil", 0) > Date.now()) return;
  const e = a.event, link = e && e.hash && X.EXPLORER[e.chain] ? `\n${X.EXPLORER[e.chain]}${e.hash}` : "";
  tgSend(`${icon[a.bias] || ""} ${a.severity.toUpperCase()}: ${a.title}\n${a.why}${link}`);
}
function flowText() {
  const ev = rows("SELECT data FROM events WHERE time > ?", Math.floor(Date.now() / 1000) - 86400);
  const nf = X.netflow(ev), b = nf.BTC || {}, s = nf.stables || {};
  return `Last 24h on exchanges (labeled wallets):\nBTC in ${X.fmtUsd(b.inUsd || 0)} · out ${X.fmtUsd(b.outUsd || 0)} · net ${X.fmtUsd((b.inUsd || 0) - (b.outUsd || 0))}\nUSDT+USDC in ${X.fmtUsd(s.inUsd || 0)} · out ${X.fmtUsd(s.outUsd || 0)} · net ${X.fmtUsd((s.inUsd || 0) - (s.outUsd || 0))}\n${ev.length} whale transfers recorded.`;
}
async function briefText() {
  const an = rows("SELECT data FROM anomalies WHERE time > ? ORDER BY time DESC LIMIT 60", Math.floor(Date.now() / 1000) - 86400);
  const ev = rows("SELECT data FROM events WHERE time > ?", Math.floor(Date.now() / 1000) - 86400);
  return X.brief({ anomalies: an, flows: X.netflow(ev), market: cache.perps && cache.perps.hl, positioning: cache.perps && cache.perps.pos, predictions: cache.macro && cache.macro.markets, calendar: X.calendar() });
}
async function onTelegram(msg) {
  const chat = String(msg.chat.id), text = (msg.text || "").trim();
  const [cmd, ...args] = text.split(/\s+/);
  if (cmd === "/start") {
    if (args[0] !== CFG.key) return tgSend("Send /start followed by your ACCESS_KEY to connect this chat.", chat);
    CFG.telegramChat = chat; kvSet("telegramChat", chat);
    return tgSend("Connected. You'll get high and critical alerts here.\nCommands: /status /flows /whales /perps /odds /brief /mute 2h /unmute", chat);
  }
  if (chat !== String(CFG.telegramChat)) return tgSend("This bot is private.", chat);
  if (cmd === "/status") return tgSend(`Tracking since ${new Date(stats.started).toUTCString()}\n${Object.entries(status).map(([k, v]) => `${X.CHAIN_NAME[k] || k}: ${v}`).join("\n")}\nTransfers recorded: ${db.prepare("SELECT COUNT(*) n FROM events").get().n}\nAnomalies: ${db.prepare("SELECT COUNT(*) n FROM anomalies").get().n}\nLearned exchange wallets: ${db.prepare("SELECT COUNT(*) n FROM labels WHERE source = 'learned'").get().n}`);
  if (cmd === "/flows") return tgSend(flowText());
  if (cmd === "/whales") return tgSend(cache.holders ? cache.holders.rows.filter((h) => !h.error).map((h) => `${h.name}: ${X.fmtNum(h.balance, 0)} BTC, 7d ${h.d7 >= 0 ? "+" : ""}${X.fmtNum(h.d7, 0)} (${h.action})`).join("\n") : "Still loading.");
  if (cmd === "/perps") { const p = cache.perps || {}; return tgSend(p.hl ? `Hyperliquid BTC ${X.fmtNum(p.hl.mark, 0)} · funding ${(p.hl.funding * 100).toFixed(4)}%/h · OI ${X.fmtUsd(p.hl.oiUsd)}${p.pos && p.pos.traders ? `\nTop traders ${(p.pos.longShare * 100).toFixed(0)}% long BTC (${p.pos.traders} positions, median ${p.pos.medianLeverage}x)` : ""}` : "Still loading."); }
  if (cmd === "/odds") return tgSend(cache.macro && cache.macro.markets ? cache.macro.markets.slice(0, 10).map((m) => `${m.event}: ${m.question} ${m.yes != null ? Math.round(m.yes * 100) + "%" : ""}`).join("\n") : "Still loading.");
  if (cmd === "/brief") { tgSend("Reading the last 24 hours…"); try { return tgSend(await briefText()); } catch (e) { return tgSend("Briefing failed: " + e.message); } }
  if (cmd === "/mute") { const h = parseFloat(args[0]) || 2; kvSet("muteUntil", Date.now() + h * 3600e3); return tgSend(`Muted for ${h} hours.`); }
  if (cmd === "/unmute") { kvSet("muteUntil", 0); return tgSend("Alerts back on."); }
  return tgSend("Commands: /status /flows /whales /perps /odds /brief /mute 2h /unmute");
}
async function telegramLoop() {
  if (!CFG.telegramToken) return;
  let offset = kvGet("tgOffset", 0);
  for (;;) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${CFG.telegramToken}/getUpdates?timeout=50&offset=${offset}`).then((x) => x.json());
      for (const u of r.result || []) { offset = u.update_id + 1; kvSet("tgOffset", offset); if (u.message) onTelegram(u.message).catch((e) => log("telegram:", e.message)); }
    } catch (e) { log("telegram poll:", e.message); await new Promise((r) => setTimeout(r, 5000)); }
  }
}
async function dailyDigest() {
  const today = new Date().toISOString().slice(0, 10);
  if (new Date().getUTCHours() !== CFG.digestHourUtc || kvGet("digestDay") === today) return;
  kvSet("digestDay", today);
  let text = "☀️ Daily digest\n" + flowText();
  if (S.anthropicKey) { try { text += "\n\n" + (await briefText()); } catch (e) { text += "\n(AI briefing failed: " + e.message + ")"; } }
  tgSend(text);
}

// ---------------------------------------------------------------- HTTP: the app, the API and the live stream
const authed = (req, url) => {
  const k = url.searchParams.get("key") || (req.headers.authorization || "").replace(/^Bearer /, "") || (req.headers.cookie || "").match(/tgkey=([^;]+)/)?.[1];
  return k && crypto.timingSafeEqual(Buffer.from(crypto.createHash("sha256").update(decodeURIComponent(k)).digest()), Buffer.from(crypto.createHash("sha256").update(CFG.key).digest()));
};
const json = (res, code, data) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
const LOGIN = `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>TraderGze Intel</title><body style="font:16px system-ui;background:#0a0d14;color:#e8edf6;display:grid;place-items:center;height:100vh;margin:0"><form method=get style="display:grid;gap:10px;width:min(320px,90vw)"><b>TraderGze Intel</b><input name=key type=password placeholder="Access key" style="padding:12px;border-radius:10px;border:1px solid #243;background:#111622;color:inherit"><button style="padding:12px;border-radius:10px;border:0;background:#34d399;font-weight:700">Open</button></form>`;
function serve(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/health") return json(res, 200, { ok: true });
  if (!authed(req, url)) {
    if (url.pathname.startsWith("/api/")) return json(res, 401, { error: "access key required" });
    res.writeHead(200, { "Content-Type": "text/html" }); return res.end(LOGIN);
  }
  const p = url.pathname, q = (k, d) => url.searchParams.get(k) || d;
  if (p === "/" || p === "/index.html") {
    const k = url.searchParams.get("key");
    res.writeHead(200, Object.assign({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }, k ? { "Set-Cookie": `tgkey=${encodeURIComponent(k)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict; Secure` } : {}));
    return res.end(fs.readFileSync(CFG.app));
  }
  if (p === "/api/events") {
    const since = +q("since", Math.floor(Date.now() / 1000) - 7 * 86400), limit = Math.min(5000, +q("limit", 2000));
    return json(res, 200, rows(`SELECT data FROM events WHERE time >= ? ${q("asset") ? "AND asset = ?" : ""} ORDER BY time DESC LIMIT ?`, ...[since, q("asset"), limit].filter((x) => x != null)).reverse());
  }
  if (p === "/api/anomalies") return json(res, 200, rows("SELECT data FROM anomalies WHERE time >= ? ORDER BY time DESC LIMIT ?", +q("since", 0), Math.min(2000, +q("limit", 600))).reverse());
  if (p === "/api/stats") {
    const now = Math.floor(Date.now() / 1000);
    return json(res, 200, { status, price, started: stats.started, events: db.prepare("SELECT COUNT(*) n FROM events").get().n, anomalies: db.prepare("SELECT COUNT(*) n FROM anomalies").get().n,
      learned: db.prepare("SELECT COUNT(*) n FROM labels WHERE source = 'learned'").get().n, netflow24: X.netflow(rows("SELECT data FROM events WHERE time > ?", now - 86400), now), netflow7d: X.netflow(rows("SELECT data FROM events WHERE time > ?", now - 7 * 86400), now, 7 * 86400),
      settings: { btcMin: S.btcMin, stableMin: S.stableMin, perpMin: S.perpMin, chains: S.chains, ai: !!S.anthropicKey, telegram: !!CFG.telegramChat } });
  }
  if (p === "/api/holders") return json(res, 200, cache.holders || { rows: [] });
  if (p === "/api/perps") return json(res, 200, cache.perps || {});
  if (p === "/api/macro") return json(res, 200, cache.macro || {});
  if (p === "/api/labels" && req.method === "GET") return json(res, 200, db.prepare("SELECT * FROM labels ORDER BY seen DESC LIMIT 2000").all());
  if (p === "/api/labels" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { try { const { address, name, kind } = JSON.parse(body); db.prepare("INSERT INTO labels(address, name, kind, entity, source, seen, added) VALUES(?, ?, ?, ?, 'yours', 0, ?) ON CONFLICT(address) DO UPDATE SET name = excluded.name, kind = excluded.kind, entity = excluded.entity, source = 'yours'").run(/^0x/i.test(address) ? address.toLowerCase() : address, name, kind || "exchange", name.split(/\s/)[0], Math.floor(Date.now() / 1000)); loadLabels(); json(res, 200, { ok: true }); } catch (e) { json(res, 400, { error: e.message }); } });
    return;
  }
  if (p === "/api/brief") { briefText().then((text) => json(res, 200, { text }), (e) => json(res, 400, { error: e.message })); return; }
  if (p === "/api/stream") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: hello\ndata: ${JSON.stringify({ status })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25000);
    req.on("close", () => { clearInterval(ping); clients.delete(res); });
    return;
  }
  json(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------- start
function start() {
  const onStatus = (src, s) => { status[src] = s; broadcast("status", { src, s }); };
  X.btcPrice().then((p) => (price = p || price));
  setInterval(async () => { const p = await X.btcPrice(); if (p) price = p; }, 60000);
  X.openBtcStream((msg) => { const learned = learnFromBtc(msg); if (learned) stats.learned += learned; const e = X.btcFromUtx(msg, price); if (e) addEvents([e]); }, onStatus);
  for (const c of ["ethereum", "bsc", "polygon"]) if (S.chains[c]) X.openEvmWatcher(c, addEvents, onStatus);
  if (S.chains.tron) X.openTronWatcher(addEvents, onStatus);
  X.openHlTrades(addEvents, onStatus);
  every(30 * 60e3, refreshHolders);
  every(5 * 60e3, () => refreshPerps(false));
  setTimeout(() => every(60 * 60e3, () => refreshPerps(true)), 20000);
  every(15 * 60e3, refreshMacro);
  setInterval(netflowCheck, 10 * 60e3);
  setInterval(dailyDigest, 5 * 60e3);
  setInterval(() => { const cut = Math.floor(Date.now() / 1000) - CFG.keepDays * 86400; db.prepare("DELETE FROM events WHERE time < ?").run(cut); db.prepare("DELETE FROM anomalies WHERE time < ?").run(cut); }, 6 * 3600e3);
  telegramLoop();
  http.createServer(serve).listen(CFG.port, CFG.host, () => log(`TraderGze Intel server on http://${CFG.host}:${CFG.port}`));
  if (CFG.telegramChat) tgSend("🐻 TraderGze Intel server started. /status for details.");
}
if (require.main === module) start();
module.exports = { serve, addEvents, learnFromBtc, netflowCheck, db, CFG, onTelegram, cache };
