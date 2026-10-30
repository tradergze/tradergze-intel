#!/usr/bin/env node
// Single-file build of server/server.js (made by build.js). Upload next to tradergze-intel.html and install.sh.
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
    ethereum: { "0xdac17f958d2ee523a2206206994597c13d831ec7": ["USDT", 6], "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ["USDC", 6],
      "0x6b175474e89094c44da98b954eedeac495271d0f": ["DAI", 18], "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": ["FDUSD", 18], "0x6c3ea9036406852006290770bedfcaba0e23a0e8": ["PYUSD", 6], "0x4c9edd5852cd905f086c759e8383e09bff1e68b3": ["USDe", 18] },
    bsc: { "0x55d398326f99059ff775485246999027b3197955": ["USDT", 18], "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": ["USDC", 18], "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409": ["FDUSD", 18] },
    polygon: { "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": ["USDT", 6], "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": ["USDC", 6], "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": ["USDC", 6] },
  };
  const EXPLORER = { bitcoin: "https://mempool.space/tx/", ethereum: "https://etherscan.io/tx/", bsc: "https://bscscan.com/tx/", polygon: "https://polygonscan.com/tx/", tron: "https://tronscan.org/#/transaction/" };
  const ADDR_URL = { bitcoin: "https://mempool.space/address/", ethereum: "https://etherscan.io/address/", bsc: "https://bscscan.com/address/", polygon: "https://polygonscan.com/address/", tron: "https://tronscan.org/#/address/" };
  const CHAIN_NAME = { bitcoin: "Bitcoin", ethereum: "Ethereum", bsc: "BNB Chain", polygon: "Polygon", tron: "Tron", hyperliquid: "Hyperliquid" };
  const STABLES = ["USDT", "USDC", "DAI", "FDUSD", "PYUSD", "USDe"];
  Object.assign(I, { TOKENS, EXPLORER, ADDR_URL, CHAIN_NAME, STABLES });

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
const AG = (function () { const module = { exports: {} };
// TraderGze Intel: (1) top human traders on Hyperliquid, ranked by win rate and payoff, with live
// copy-trade alerts; (2) AI agent day traders on BTC, trading paper money with the day-trader method:
// setup -> trigger -> stop and target before entry -> 1% risk sizing -> daily limits.
// Pure logic plus thin Hyperliquid readers; runs in Node 18+ (the server) and the browser.
(function (root) {
  "use strict";
  const A = {};
  const HL = "https://api.hyperliquid.xyz/info";
  // Hyperliquid allows 1200 "weight" a minute per IP: 20 a request, plus 1 per 20 items returned by fill and candle
  // queries. Every call waits for budget (1050 a minute, leaving room for the rest of the app) and backs off on HTTP 429.
  const BUDGET = 1050, limiter = { tokens: BUDGET, at: Date.now(), chain: Promise.resolve() };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  // background work leaves RESERVE untouched, so a page you open or a follow alert never waits for the scan's budget
  const RESERVE = 350;
  async function take(w, urgent) {
    for (;;) {
      const now = Date.now(); limiter.tokens = Math.min(BUDGET, limiter.tokens + ((now - limiter.at) / 60000) * BUDGET); limiter.at = now;
      const need = urgent ? w : w + RESERVE;
      if (limiter.tokens >= need) { limiter.tokens -= w; return; }
      if (!urgent && (queue.hi.length)) return "yield";
      await sleep(Math.min(2000, Math.ceil(((need - limiter.tokens) / BUDGET) * 60000)));
    }
  }
  // one request at a time; requests for a page you opened (urgent) go before the background trader scan
  const queue = { hi: [], lo: [] }; let busy = false;
  async function send(body, urgent) {
    for (let attempt = 0; ; attempt++) {
      if ((await take(20, urgent)) === "yield") { await sendUrgentFirst(); attempt--; continue; }
      const r = await A.fetch(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429 && attempt < 3) { limiter.tokens = 0; await sleep(A.backoffMs * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`Hyperliquid answered HTTP ${r.status}`);
      const j = await r.json();
      if (Array.isArray(j) && j.length > 20) limiter.tokens -= Math.floor(j.length / 20);
      return j;
    }
  }
  async function pump() {
    if (busy) return; busy = true;
    try { for (let it; (it = queue.hi.shift() || queue.lo.shift()); ) { try { it.ok(await send(it.body, it.urgent)); } catch (e) { it.fail(e); } } } finally { busy = false; }
  }
  // a background request waiting for budget lets urgent ones that arrived meanwhile go first
  async function sendUrgentFirst() { for (let it; (it = queue.hi.shift()); ) { try { it.ok(await send(it.body, true)); } catch (e) { it.fail(e); } } }
  const post = (body, opt = {}) => new Promise((ok, fail) => { (opt.urgent ? queue.hi : queue.lo).push({ body, ok, fail, urgent: !!opt.urgent }); pump(); });
  A.queue = queue; A.backoffMs = 15000;
  A.limiter = limiter;
  A.fetch = (...a) => fetch(...a);
  A.post = (body, opt) => post(body, opt);
  const round = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

  // ================================================================ 1. top human traders

  /** A trader's fills -> closed-trade statistics (Hyperliquid reports closedPnl on closing fills). */
  function traderStats(fills, coin = null) {
    const fs = (fills || []).filter((f) => !coin || (typeof coin === "function" ? coin(f.coin) : f.coin === coin)).slice().sort((a, b) => a.time - b.time);
    // group closing fills of the same order into one trade
    const closes = new Map();
    for (const f of fs) {
      const pnl = Number(f.closedPnl || 0), fee = Number(f.fee || 0);
      if (!/^Close|Long > Short|Short > Long/.test(f.dir || "") || pnl === 0) continue;
      const k = f.oid || f.hash || f.tid;
      const c = closes.get(k) || { time: f.time, coin: f.coin, pnl: 0, fee: 0, side: /Long/.test(f.dir) && /^Close Long|Long > Short/.test(f.dir) ? "long" : "short", px: Number(f.px), sz: 0 };
      c.pnl += pnl; c.fee += fee; c.sz += Number(f.sz); c.time = Math.max(c.time, f.time);
      closes.set(k, c);
    }
    const trades = [...closes.values()].sort((a, b) => a.time - b.time).map((c) => Object.assign(c, { net: c.pnl - c.fee }));
    const wins = trades.filter((t) => t.net > 0), losses = trades.filter((t) => t.net <= 0);
    const sumW = wins.reduce((s, t) => s + t.net, 0), sumL = -losses.reduce((s, t) => s + t.net, 0);
    let cum = 0, peak = 0, maxDD = 0;
    const equity = trades.map((t) => { cum += t.net; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); return [Math.floor(t.time / 1000), round(cum)]; });
    const btc = fs.filter((f) => f.coin === "BTC").length;
    return {
      trades: trades.length, wins: wins.length, losses: losses.length,
      winRate: trades.length ? wins.length / trades.length : null,
      avgWin: wins.length ? sumW / wins.length : null, avgLoss: losses.length ? sumL / losses.length : null,
      payoff: wins.length && losses.length && sumL > 0 ? (sumW / wins.length) / (sumL / losses.length) : null,
      profitFactor: sumL > 0 ? sumW / sumL : wins.length ? Infinity : null,
      pnl: cum, maxDrawdown: maxDD, btcShare: fs.length ? btc / fs.length : 0,
      first: fs.length ? Math.floor(fs[0].time / 1000) : null, last: fs.length ? Math.floor(fs[fs.length - 1].time / 1000) : null,
      equity, recent: trades.slice(-30).reverse(),
    };
  }
  A.traderStats = traderStats;

  /**
   * One number for "worth copying": rewards win rate, payoff and profit factor, needs enough trades,
   * punishes a drawdown that is large next to the profit. 0-100.
   */
  function copyScore(s, minTrades = 20) {
    if (!s || s.trades < minTrades || s.pnl <= 0) return 0;
    const wr = s.winRate || 0, po = Math.min(s.payoff || 0, 4) / 4, pf = Math.min(isFinite(s.profitFactor) ? s.profitFactor : 4, 4) / 4;
    const depth = Math.min(1, Math.log10(s.trades) / 2);                  // 100 trades = full weight
    const dd = s.pnl > 0 ? Math.min(1, s.maxDrawdown / s.pnl) : 1;
    return Math.round(100 * (0.35 * wr + 0.3 * po + 0.35 * pf) * (0.6 + 0.4 * depth) * (1 - 0.5 * dd));
  }
  A.copyScore = copyScore;

  async function fills(user, days = 30) {
    return post({ type: "userFillsByTime", user, startTime: Date.now() - days * 86400e3, aggregateByTime: true });
  }
  /** Score one trader's fills in several categories at once: cats = {name: [coinFilter, minTrades]}. */
  function scoreCategories(c, f, cats) {
    const out = {};
    for (const [k, [flt, minT]] of Object.entries(cats)) {
      const s = traderStats(f, flt), sc = copyScore(s, minT);
      if (sc > 0) {
        const n = {}; for (const x of f) if (flt(x.coin)) n[x.coin] = (n[x.coin] || 0) + 1;
        const eq = s.equity, step = Math.max(1, Math.ceil(eq.length / 40));
        out[k] = Object.assign({}, c, { curve: eq.filter((_, i) => i % step === 0 || i === eq.length - 1), stats: Object.assign({}, s, { equity: undefined, recent: undefined }), score: sc, coins: Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 5).map((x) => x[0]) });
      }
    }
    return out;
  }
  /** Every fill in the window: Hyperliquid returns at most 2000 per call, so page forward by time. */
  async function fillsAll(user, days = 90, pages = 6, opt = {}) {
    let start = Date.now() - days * 86400e3, out = [];
    for (let k = 0; k < pages; k++) {
      const r = (await post({ type: "userFillsByTime", user, startTime: start, aggregateByTime: true }, opt)) || [];
      out = out.concat(r);
      if (r.length < 2000) break;
      start = Math.max(...r.map((f) => f.time)) + 1;
    }
    const seen = new Set(); return out.filter((f) => { const k = `${f.hash}:${f.tid}:${f.time}`; return !seen.has(k) && seen.add(k); });
  }
  A.fillsAll = fillsAll;
  A.fills = fills; A.scoreCategories = scoreCategories;

  /** Rank leaderboard traders by their real closed trades. candidates: [{address, name, accountValue, pnl}] */
  async function rankTraders(candidates, { days = 30, coin = null, minTrades = 20, onProgress } = {}) {
    const out = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      try {
        const f = await fills(c.address, days);
        const s = traderStats(f, coin);
        out.push(Object.assign({}, c, { stats: Object.assign({}, s, { equity: undefined, recent: undefined }), score: copyScore(s, minTrades) }));
      } catch (e) { out.push(Object.assign({}, c, { error: e.message, score: 0 })); }
      if (onProgress) onProgress(i + 1, candidates.length);
    }
    return out.filter((t) => t.score > 0).sort((a, b) => b.score - a.score);
  }
  A.rankTraders = rankTraders;

  /** A fill as a copy-trade alert line. */
  function fillAlert(name, f) {
    const usd = Number(f.px) * Number(f.sz);
    const verb = { "Open Long": "opened / added LONG", "Open Short": "opened / added SHORT", "Close Long": "closed LONG", "Close Short": "closed SHORT", "Long > Short": "flipped to SHORT", "Short > Long": "flipped to LONG" }[f.dir] || f.dir;
    const pnl = Number(f.closedPnl || 0);
    return `${name} ${verb} ${Number(f.sz)} ${f.coin} @ ${Number(f.px).toLocaleString("en-US")} (≈$${Math.round(usd).toLocaleString("en-US")})${pnl ? ` · realized ${pnl > 0 ? "+" : ""}$${Math.round(pnl).toLocaleString("en-US")}` : ""}`;
  }
  A.fillAlert = fillAlert;

  // ================================================================ candles and indicators

  /** Hyperliquid candles -> [{t (s), o, h, l, c, v}] oldest first. */
  async function candles(coin = "BTC", interval = "5m", hours = 24 * 14, opt = {}) {
    const end = Date.now(), start = end - hours * 3600e3;
    const r = await post({ type: "candleSnapshot", req: { coin, interval, startTime: start, endTime: end } }, opt);
    return (r || []).map((k) => ({ t: Math.floor(k.t / 1000), o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v }));
  }
  A.candles = candles;

  const ema = (vals, n) => { const k = 2 / (n + 1); let e = null; return vals.map((v) => (e = e == null ? v : v * k + e * (1 - k))); };
  function rsi(closes, n = 14) {
    const out = new Array(closes.length).fill(null);
    let ag = 0, al = 0;
    for (let i = 1; i < closes.length; i++) {
      const g = Math.max(0, closes[i] - closes[i - 1]), l = Math.max(0, closes[i - 1] - closes[i]);
      if (i <= n) { ag += g / n; al += l / n; if (i === n) out[i] = al ? 100 - 100 / (1 + ag / al) : 100; continue; }
      ag = (ag * (n - 1) + g) / n; al = (al * (n - 1) + l) / n;
      out[i] = al ? 100 - 100 / (1 + ag / al) : 100;
    }
    return out;
  }
  function atr(bars, n = 14) {
    const out = []; let a = null;
    bars.forEach((b, i) => { const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l; a = a == null ? tr : (a * (n - 1) + tr) / n; out.push(a); });
    return out;
  }
  function indicators(bars) {
    const c = bars.map((b) => b.c);
    const sma20 = c.map((_, i) => (i >= 19 ? c.slice(i - 19, i + 1).reduce((s, x) => s + x, 0) / 20 : null));
    const sd20 = c.map((_, i) => (i >= 19 ? Math.sqrt(c.slice(i - 19, i + 1).reduce((s, x) => s + (x - sma20[i]) ** 2, 0) / 20) : null));
    return { ema20: ema(c, 20), ema50: ema(c, 50), ema200: ema(c, 200), rsi: rsi(c), atr: atr(bars), sma20, upper: sma20.map((m, i) => (m == null ? null : m + 2 * sd20[i])), lower: sma20.map((m, i) => (m == null ? null : m - 2 * sd20[i])) };
  }
  A.indicators = indicators;

  // ================================================================ 2. the AI agents (strategies)

  const dayOf = (t) => Math.floor(t / 86400);
  const minuteOfDay = (t) => Math.floor((t % 86400) / 60);
  // Each decide() sees closed bars up to i and returns null or {side, stop, target, why}. Entry is bar i's close.
  const AGENTS = [
    { id: "orb", name: "ORB Sniper", style: "Opening-range breakout (the Day Trader method): the first hour of the UTC day sets the range; the first 5-minute close outside it triggers. Stop at the range midpoint, target 2R.",
      decide({ bars, i }) {
        const b = bars[i], m = minuteOfDay(b.t + 300);
        if (m <= 60 || m > 16 * 60) return null;                       // after the range, before 16:00 UTC
        const day = dayOf(b.t), range = [];
        for (let j = i; j >= 0 && dayOf(bars[j].t) === day; j--) if (minuteOfDay(bars[j].t) < 60) range.push(bars[j]);
        if (range.length < 12) return null;
        const hi = Math.max(...range.map((x) => x.h)), lo = Math.min(...range.map((x) => x.l)), mid = (hi + lo) / 2;
        const prev = bars[i - 1];
        if (b.c > hi && prev.c <= hi) return { side: "long", stop: mid, target: b.c + 2 * (b.c - mid), why: `5m close ${b.c.toFixed(0)} broke the opening range high ${hi.toFixed(0)}` };
        if (b.c < lo && prev.c >= lo) return { side: "short", stop: mid, target: b.c - 2 * (mid - b.c), why: `5m close ${b.c.toFixed(0)} broke the opening range low ${lo.toFixed(0)}` };
        return null;
      } },
    { id: "breakout", name: "Breakout Hunter", style: "Buys a close above the 4-hour high (sells below the 4-hour low). Stop 1.5×ATR, target 3×ATR.",
      decide({ bars, i, ind }) {
        if (i < 49) return null;
        const w = bars.slice(i - 48, i), hi = Math.max(...w.map((x) => x.h)), lo = Math.min(...w.map((x) => x.l)), b = bars[i], a = ind.atr[i];
        if (b.c > hi) return { side: "long", stop: b.c - 1.5 * a, target: b.c + 3 * a, why: `close above the 4h high ${hi.toFixed(0)}` };
        if (b.c < lo) return { side: "short", stop: b.c + 1.5 * a, target: b.c - 3 * a, why: `close below the 4h low ${lo.toFixed(0)}` };
        return null;
      } },
    { id: "meanrev", name: "Mean Reverter", style: "Fades stretched moves: RSI under 25 and a close below the lower Bollinger band (or the mirror). Stop 1.2×ATR, target the 20-bar average.",
      decide({ bars, i, ind }) {
        const b = bars[i], r = ind.rsi[i], a = ind.atr[i];
        if (r == null || ind.lower[i] == null) return null;
        if (r < 25 && b.c < ind.lower[i] && ind.sma20[i] - b.c > a) return { side: "long", stop: b.c - 1.2 * a, target: ind.sma20[i], why: `RSI ${r.toFixed(0)} under the lower band` };
        if (r > 75 && b.c > ind.upper[i] && b.c - ind.sma20[i] > a) return { side: "short", stop: b.c + 1.2 * a, target: ind.sma20[i], why: `RSI ${r.toFixed(0)} over the upper band` };
        return null;
      } },
    { id: "trend", name: "Trend Rider", style: "Joins the trend when the 20 EMA crosses the 50 EMA on the side of the 200 EMA. Stop 2×ATR, target 4×ATR.",
      decide({ bars, i, ind }) {
        if (i < 200) return null;
        const b = bars[i], up = ind.ema20[i] > ind.ema50[i] && ind.ema20[i - 1] <= ind.ema50[i - 1], dn = ind.ema20[i] < ind.ema50[i] && ind.ema20[i - 1] >= ind.ema50[i - 1], a = ind.atr[i];
        if (up && b.c > ind.ema200[i]) return { side: "long", stop: b.c - 2 * a, target: b.c + 4 * a, why: "20 EMA crossed above the 50 EMA, price above the 200 EMA" };
        if (dn && b.c < ind.ema200[i]) return { side: "short", stop: b.c + 2 * a, target: b.c - 4 * a, why: "20 EMA crossed below the 50 EMA, price below the 200 EMA" };
        return null;
      } },
    { id: "funding", name: "Funding Fader", style: "Trades against crowded perps: shorts a 1-hour high when funding is very positive, buys a 1-hour low when it is negative. Stop 1.5×ATR, target 2.5×ATR.",
      decide({ bars, i, ind, ctx }) {
        const f = ctx && ctx.funding;
        if (f == null || i < 13) return null;
        const w = bars.slice(i - 12, i), b = bars[i], a = ind.atr[i];
        if (f > 0.0001 && b.h >= Math.max(...w.map((x) => x.h))) return { side: "short", stop: b.c + 1.5 * a, target: b.c - 2.5 * a, why: `funding +${(f * 100).toFixed(4)}%/h at a 1h high` };
        if (f < -0.00005 && b.l <= Math.min(...w.map((x) => x.l))) return { side: "long", stop: b.c - 1.5 * a, target: b.c + 2.5 * a, why: `funding ${(f * 100).toFixed(4)}%/h at a 1h low` };
        return null;
      } },
    { id: "whale", name: "Whale Follower", style: "Trades the anomaly agent: big BTC deposits to exchanges → short; stablecoin mints and deposits → long. Stop 1.5×ATR, target 3×ATR.",
      decide({ bars, i, ind, ctx }) {
        const list = (ctx && ctx.anomalies) || [], b = bars[i], a = ind.atr[i];
        const recent = list.filter((x) => x.time > b.t - 3600 && x.time <= b.t + 300 && (x.severity === "critical" || x.severity === "high"));
        let bull = 0, bear = 0;
        for (const x of recent) { if (x.bias === "bullish") bull += x.score; if (x.bias === "bearish") bear += x.score; }
        if (bull >= 140 && bull > bear * 2) return { side: "long", stop: b.c - 1.5 * a, target: b.c + 3 * a, why: `${recent.length} bullish whale signals in the last hour` };
        if (bear >= 140 && bear > bull * 2) return { side: "short", stop: b.c + 1.5 * a, target: b.c - 3 * a, why: `${recent.length} bearish whale signals in the last hour` };
        return null;
      } },
  ];
  const LLM_AGENT = { id: "claude", name: "Claude Strategist", style: "Claude Opus 5.5 reads the last 2 days of 5-minute bars, indicators, funding and whale anomalies every hour and decides: long, short or wait, with its own stop and target. Same risk rules as the others.", llm: true };
  A.AGENTS = AGENTS; A.LLM_AGENT = LLM_AGENT;

  // ================================================================ the paper broker and the day-trader risk rules

  const RULES = { equity: 10000, riskPct: 1, feePct: 0.045, maxTradesPerDay: 4, maxDailyLossR: 3, minRR: 1.2, maxHoldBars: 288, flatByMinute: 23 * 60 + 55 };
  A.RULES = RULES;
  const newBook = (id) => ({ id, equity: RULES.equity, peak: RULES.equity, maxDD: 0, open: null, trades: [], curve: [], lastT: 0, day: null, dayTrades: 0, dayR: 0 });
  A.newBook = newBook;

  function closePos(book, t, px, why) {
    const p = book.open, dir = p.side === "long" ? 1 : -1;
    const gross = dir * (px - p.entry) * p.size, fees = (p.entry + px) * p.size * RULES.feePct / 100;
    const net = gross - fees, R = net / p.riskUsd;
    book.equity += net; book.peak = Math.max(book.peak, book.equity); book.maxDD = Math.max(book.maxDD, (book.peak - book.equity) / book.peak);
    book.dayR += R;
    book.trades.push({ side: p.side, entry: p.entry, exit: px, stop: p.stop, target: p.target, size: p.size, opened: p.opened, closed: t, net: round(net), R: round(R), why: p.why, exitWhy: why, live: p.live });
    if (book.trades.length > 500) book.trades.shift();
    book.open = null;
  }

  /**
   * Walk one agent over new closed bars. decideFn(bars, i, ind) -> plan or null. Returns the
   * trades opened and closed in this step (for alerts). `live` marks trades taken after the backtest.
   */
  function step(book, bars, ind, decideFn, { live = false } = {}) {
    const events = [];
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i];
      if (b.t <= book.lastT) continue;
      const d = dayOf(b.t);
      if (d !== book.day) { book.day = d; book.dayTrades = 0; book.dayR = 0; }
      // manage the open position on this bar: stop first when both are inside one bar (conservative)
      if (book.open) {
        const p = book.open, held = (b.t - p.opened) / 300;
        if (p.side === "long" ? b.l <= p.stop : b.h >= p.stop) { closePos(book, b.t + 300, p.stop, "stop"); events.push({ kind: "close", trade: book.trades[book.trades.length - 1] }); }
        else if (p.side === "long" ? b.h >= p.target : b.l <= p.target) { closePos(book, b.t + 300, p.target, "target"); events.push({ kind: "close", trade: book.trades[book.trades.length - 1] }); }
        else if (held >= RULES.maxHoldBars || minuteOfDay(b.t + 300) >= RULES.flatByMinute) { closePos(book, b.t + 300, b.c, held >= RULES.maxHoldBars ? "time" : "flat by day end"); events.push({ kind: "close", trade: book.trades[book.trades.length - 1] }); }
      }
      // look for a new entry at this bar's close
      if (!book.open && book.dayTrades < RULES.maxTradesPerDay && book.dayR > -RULES.maxDailyLossR && minuteOfDay(b.t + 300) < RULES.flatByMinute - 30) {
        const plan = decideFn(bars, i, ind);
        if (plan && plan.stop && plan.target) {
          const entry = b.c, risk = Math.abs(entry - plan.stop), rr = Math.abs(plan.target - entry) / risk;
          const valid = plan.side === "long" ? plan.stop < entry && plan.target > entry : plan.stop > entry && plan.target < entry;
          if (valid && risk / entry > 0.0008 && rr >= RULES.minRR) {
            const riskUsd = book.equity * RULES.riskPct / 100, size = riskUsd / risk;
            book.open = { side: plan.side, entry, stop: plan.stop, target: plan.target, size, riskUsd, opened: b.t + 300, why: plan.why, live };
            book.dayTrades++;
            events.push({ kind: "open", position: book.open });
          }
        }
      }
      book.lastT = b.t;
      if (i % 12 === 0 || i === bars.length - 1) { book.curve.push([b.t, round(book.equity)]); if (book.curve.length > 1500) book.curve.splice(0, book.curve.length - 1500); }
    }
    return events;
  }
  A.step = step;

  /** Leaderboard figures for one agent's book. */
  function bookStats(book, { liveOnly = false } = {}) {
    const t = liveOnly ? book.trades.filter((x) => x.live) : book.trades;
    const wins = t.filter((x) => x.net > 0), losses = t.filter((x) => x.net <= 0);
    const sumW = wins.reduce((s, x) => s + x.net, 0), sumL = -losses.reduce((s, x) => s + x.net, 0);
    return { trades: t.length, winRate: t.length ? wins.length / t.length : null, avgR: t.length ? t.reduce((s, x) => s + x.R, 0) / t.length : null,
      payoff: wins.length && losses.length && sumL ? (sumW / wins.length) / (sumL / losses.length) : null, profitFactor: sumL ? sumW / sumL : wins.length ? Infinity : null,
      pnl: t.reduce((s, x) => s + x.net, 0), returnPct: (book.equity / RULES.equity - 1) * 100, maxDDPct: book.maxDD * 100, equity: book.equity, open: book.open };
  }
  A.bookStats = bookStats;
  /** Rank agents: return, consistency and drawdown, with enough trades to mean something. */
  function agentScore(s) {
    if (!s.trades) return 0;
    const pf = Math.min(isFinite(s.profitFactor) ? s.profitFactor || 0 : 3, 3) / 3, wr = s.winRate || 0, ret = Math.max(-1, Math.min(1, s.returnPct / 20));
    return Math.round(100 * Math.max(0, 0.4 * pf + 0.25 * wr + 0.35 * (ret + 1) / 2) * Math.min(1, s.trades / 15) * (1 - Math.min(0.5, s.maxDDPct / 40)));
  }
  A.agentScore = agentScore;

  // ================================================================ the Claude strategist (one decision per hour)

  function marketSummary(bars, ind, ctx) {
    const i = bars.length - 1, b = bars[i], h = (n) => bars.slice(-n);
    const chg = (n) => ((b.c / bars[Math.max(0, i - n)].c - 1) * 100).toFixed(2) + "%";
    const hourly = [];
    for (let j = Math.max(0, i - 576); j <= i; j += 12) { const w = bars.slice(j, j + 12); if (w.length) hourly.push([new Date(w[0].t * 1000).toISOString().slice(5, 16), w[0].o, Math.max(...w.map((x) => x.h)), Math.min(...w.map((x) => x.l)), w[w.length - 1].c].map((x) => (typeof x === "number" ? Math.round(x) : x))); }
    return {
      now_utc: new Date((b.t + 300) * 1000).toISOString(), price: b.c, change: { "1h": chg(12), "4h": chg(48), "24h": chg(288) },
      indicators_5m: { ema20: Math.round(ind.ema20[i]), ema50: Math.round(ind.ema50[i]), ema200: Math.round(ind.ema200[i]), rsi14: round(ind.rsi[i], 1), atr14: Math.round(ind.atr[i]), bollinger: [Math.round(ind.lower[i]), Math.round(ind.upper[i])] },
      range_24h: [Math.round(Math.min(...h(288).map((x) => x.l))), Math.round(Math.max(...h(288).map((x) => x.h)))],
      hyperliquid_funding_per_hour: ctx.funding, top_trader_long_share: ctx.longShare,
      whale_anomalies_last_6h: (ctx.anomalies || []).filter((x) => x.time > b.t - 6 * 3600).slice(-15).map((x) => ({ severity: x.severity, bias: x.bias, title: x.title })),
      hourly_ohlc_last_48h: hourly,
    };
  }
  A.marketSummary = marketSummary;

  const PLAN_SCHEMA = { type: "object", additionalProperties: false, required: ["action", "stop", "target", "confidence", "why"],
    properties: { action: { type: "string", enum: ["long", "short", "wait"] }, stop: { type: "number" }, target: { type: "number" }, confidence: { type: "number" }, why: { type: "string" } } };

  /** Ask Claude for one decision. Returns a plan for step() or null (wait). */
  async function claudeDecide(summary, apiKey, fetchFn = A.fetch) {
    const res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2026-10-21", "anthropic-beta": "server-side-fallback-2026-07-01" },
      body: JSON.stringify({
        model: "claude-opus-5-5", max_tokens: 16000, fallbacks: "default",
        output_config: { effort: "medium", format: { type: "json_schema", schema: PLAN_SCHEMA } },
        system: "You are a disciplined BTC intraday trader running a paper account. Every hour you see the market snapshot and decide one thing: open a long, open a short, or wait. Trade only clear setups; waiting is the default. Any trade needs a stop beyond recent structure and a target at least 1.5 times the risk away, both as absolute BTC prices. Positions are closed by stop, target, or 23:55 UTC. Give the reason in one sentence. confidence is 0 to 1.",
        messages: [{ role: "user", content: JSON.stringify(summary) }],
      }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error((j.error && j.error.message) || `Anthropic API answered HTTP ${res.status}`);
    if (j.stop_reason === "refusal") return null;
    const text = (j.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const d = JSON.parse(text);
    if (d.action === "wait") return { wait: true, why: d.why };
    return { side: d.action, stop: d.stop, target: d.target, why: `${d.why} (confidence ${Math.round(d.confidence * 100)}%)` };
  }
  A.claudeDecide = claudeDecide;
  A.PLAN_SCHEMA = PLAN_SCHEMA;

  // ================================================================ the agent desk: every agent over the same bars

  /** Backtest all rule agents over history, then keep stepping them live. state = {books: {id: book}} */
  function runDesk(state, bars, ctx, { live = false } = {}) {
    const ind = indicators(bars);
    const events = [];
    for (const ag of AGENTS) {
      const book = state.books[ag.id] = state.books[ag.id] || newBook(ag.id);
      const ev = step(book, bars, ind, (bs, i, id) => ag.decide({ bars: bs, i, ind: id, ctx }), { live });
      for (const e of ev) events.push(Object.assign({ agent: ag.id, name: ag.name }, e));
    }
    return events;
  }
  A.runDesk = runDesk;

  function leaderboard(state) {
    const list = AGENTS.concat(state.books.claude ? [LLM_AGENT] : []).map((ag) => {
      const book = state.books[ag.id] || newBook(ag.id), s = bookStats(book), live = bookStats(book, { liveOnly: true });
      return { id: ag.id, name: ag.name, style: ag.style, llm: !!ag.llm, stats: s, live, score: agentScore(s), curve: book.curve, open: book.open, recent: book.trades.slice(-25).reverse() };
    });
    return list.sort((a, b) => b.score - a.score);
  }
  A.leaderboard = leaderboard;

  if (typeof module !== "undefined" && module.exports) module.exports = A;
  else root.Agents = A;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();
const MK = (function () { const module = { exports: {} };
// TraderGze markets: the multi-asset watchlist (indices, stocks, commodities, energy, crypto, FX and
// rates) and chart data, read on the server from Yahoo Finance's chart endpoints.
(function (root) {
  "use strict";
  const M = {};
  M.fetch = (...a) => fetch(...a);
  const UA = { "User-Agent": "Mozilla/5.0 (compatible; TraderGze/1.0)" };

  // ---------------------------------------------------------------- the watchlist
  // [symbol, short code, name]
  const GROUPS = [
    ["Americas", [["^GSPC", "SPX", "S&P 500"], ["^NDX", "NDX", "Nasdaq 100"], ["^DJI", "DJIA", "Dow Jones Industrial Average"], ["^DJT", "DJT", "Dow Jones Transportation"], ["^RUT", "RUT", "Russell 2000"], ["^GSPTSE", "TSX", "S&P/TSX Composite"], ["^BVSP", "BVSP", "Bovespa"]]],
    ["Europe", [["^FTSE", "FTSE", "FTSE 100"], ["^GDAXI", "DAX", "DAX"], ["^FCHI", "CAC", "CAC 40"], ["^STOXX50E", "SX5E", "Euro Stoxx 50"], ["^SSMI", "SMI", "Swiss Market Index"]]],
    ["Asia-Pacific", [["^N225", "NKY", "Nikkei 225"], ["^HSI", "HSI", "Hang Seng Index"], ["000001.SS", "SHCOMP", "Shanghai Composite"], ["^KS11", "KOSPI", "KOSPI"], ["^AXJO", "ASX", "ASX 200"], ["^BSESN", "SENSEX", "BSE Sensex"]]],
    ["Volatility & rates", [["^VIX", "VIX", "CBOE Volatility Index"], ["^TNX", "US10Y", "US 10-year yield"], ["^FVX", "US5Y", "US 5-year yield"], ["^IRX", "US3M", "US 13-week bill"], ["DX-Y.NYB", "DXY", "US Dollar Index"]]],
    ["Mega-cap stocks", [["AAPL", "AAPL", "Apple"], ["MSFT", "MSFT", "Microsoft"], ["NVDA", "NVDA", "Nvidia"], ["AMZN", "AMZN", "Amazon"], ["GOOGL", "GOOGL", "Alphabet"], ["META", "META", "Meta Platforms"], ["TSLA", "TSLA", "Tesla"], ["AVGO", "AVGO", "Broadcom"], ["BRK-B", "BRK.B", "Berkshire Hathaway"], ["JPM", "JPM", "JPMorgan Chase"]]],
    ["Metals & agriculture", [["GC=F", "GOLD", "Gold"], ["SI=F", "SILVER", "Silver"], ["HG=F", "COPPER", "Copper"], ["PL=F", "PLAT", "Platinum"], ["ZC=F", "CORN", "Corn"], ["ZW=F", "WHEAT", "Wheat"], ["ZS=F", "SOY", "Soybeans"], ["KC=F", "COFFEE", "Coffee"]]],
    ["Energy", [["CL=F", "WTI", "WTI crude oil"], ["BZ=F", "BRENT", "Brent crude oil"], ["NG=F", "NATGAS", "Natural gas"], ["RB=F", "RBOB", "Gasoline (RBOB)"], ["HO=F", "HEAT", "Heating oil"], ["XLE", "XLE", "Energy Select Sector ETF"], ["XOM", "XOM", "Exxon Mobil"], ["CVX", "CVX", "Chevron"]]],
    ["Crypto", [["BTC-USD", "BTC", "Bitcoin"], ["ETH-USD", "ETH", "Ethereum"], ["SOL-USD", "SOL", "Solana"], ["XRP-USD", "XRP", "XRP"], ["BNB-USD", "BNB", "BNB"]]],
    ["FX", [["EURUSD=X", "EURUSD", "Euro / US dollar"], ["GBPUSD=X", "GBPUSD", "British pound / US dollar"], ["JPY=X", "USDJPY", "US dollar / Japanese yen"], ["CHF=X", "USDCHF", "US dollar / Swiss franc"], ["AUDUSD=X", "AUDUSD", "Australian dollar / US dollar"], ["INR=X", "USDINR", "US dollar / Indian rupee"]]],
  ];
  M.GROUPS = GROUPS;
  M.ALL = GROUPS.flatMap(([g, rows]) => rows.map(([sym, code, name]) => ({ sym, code, name, group: g })));
  const CUR = { USD: "$", EUR: "€", GBP: "£", GBp: "p", JPY: "¥", CNY: "CN¥", HKD: "HK$", KRW: "₩", AUD: "A$", INR: "₹", CAD: "CA$", BRL: "R$", CHF: "CHF " };
  M.CUR = CUR;

  // ---------------------------------------------------------------- Yahoo readers
  const hosts = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
  async function yget(path) {
    let last;
    for (const h of hosts) {
      try {
        const r = await M.fetch(h + path, { headers: UA });
        if (r.status === 429 || r.status >= 500) { last = new Error(`Yahoo answered HTTP ${r.status}`); continue; }
        if (!r.ok) throw new Error(`Yahoo answered HTTP ${r.status}`);
        return await r.json();
      } catch (e) { last = e; }
    }
    throw last;
  }
  M.yget = yget;

  /** Market open / pre-post / closed from a Yahoo meta block, at time now (seconds). */
  function marketState(meta, now = Date.now() / 1000) {
    const p = meta && meta.currentTradingPeriod;
    if (!p || !p.regular) return "unknown";
    const inP = (x) => x && now >= x.start && now < x.end;
    if (inP(p.regular)) return "open";
    if (inP(p.pre) || inP(p.post)) return "extended";
    return "closed";
  }
  M.marketState = marketState;

  /** One Yahoo chart result -> a watchlist row (last, change, day range, sparkline). */
  function rowFrom(res, item, now) {
    const m = res.meta || {}, q = ((res.indicators || {}).quote || [{}])[0] || {};
    const closes = (q.close || []).map((c, i) => [res.timestamp ? res.timestamp[i] : i, c]).filter((x) => x[1] != null);
    const last = m.regularMarketPrice != null ? m.regularMarketPrice : closes.length ? closes[closes.length - 1][1] : null;
    const prev = m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose;
    const hi = q.high ? Math.max(...q.high.filter((x) => x != null)) : null, lo = q.low ? Math.min(...q.low.filter((x) => x != null)) : null;
    return Object.assign({}, item, {
      last, prev, change: last != null && prev ? last - prev : null, changePct: last != null && prev ? (last / prev - 1) * 100 : null,
      high: m.regularMarketDayHigh || (isFinite(hi) ? hi : null), low: m.regularMarketDayLow || (isFinite(lo) ? lo : null),
      currency: m.currency || "USD", state: marketState(m, now), time: m.regularMarketTime || null,
      spark: closes.length > 60 ? closes.filter((_, i) => i % Math.ceil(closes.length / 60) === 0).map((x) => +x[1].toFixed(6)) : closes.map((x) => +x[1].toFixed(6)),
    });
  }
  M.rowFrom = rowFrom;

  /** Watchlist rows for every symbol (Yahoo v8 chart, one day of 5-minute bars each). */
  async function watchlist(items = M.ALL, { concurrency = 6, now } = {}) {
    const out = new Array(items.length);
    let k = 0;
    const worker = async () => {
      while (k < items.length) {
        const i = k++, it = items[i];
        try {
          const j = await yget(`/v8/finance/chart/${encodeURIComponent(it.sym)}?range=1d&interval=5m&includePrePost=false`);
          const res = j.chart && j.chart.result && j.chart.result[0];
          out[i] = res ? rowFrom(res, it, now) : Object.assign({}, it, { error: "no data" });
        } catch (e) { out[i] = Object.assign({}, it, { error: e.message }); }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    return out;
  }
  M.watchlist = watchlist;

  const RANGES = { "1D": ["1d", "5m"], "5D": ["5d", "30m"], "1M": ["1mo", "1h"], "6M": ["6mo", "1d"], "1Y": ["1y", "1d"], "2Y": ["2y", "1d"], "5Y": ["5y", "1wk"] };
  M.RANGES = RANGES;
  /** Candles for a symbol: [{t, o, h, l, c, v}] oldest first. */
  async function candles(sym, range = "6M") {
    const [r, iv] = RANGES[range] || RANGES["6M"];
    const j = await yget(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${r}&interval=${iv}&includePrePost=false`);
    const res = j.chart && j.chart.result && j.chart.result[0];
    if (!res) throw new Error(`no chart data for ${sym}`);
    const q = res.indicators.quote[0];
    return { meta: { currency: res.meta.currency, name: res.meta.longName || res.meta.shortName, exchange: res.meta.exchangeName, state: marketState(res.meta) },
      bars: (res.timestamp || []).map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume ? q.volume[i] || 0 : 0 })).filter((b) => b.o != null && b.c != null && b.h != null && b.l != null) };
  }
  M.candles = candles;

  if (typeof module !== "undefined" && module.exports) module.exports = M;
  else root.Markets = M;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();
const RS = (function () { const module = { exports: {} };
// TraderGze research feeds, read on the server: the week's economic calendar, CFTC positioning,
// insider buying, superinvestor 13F changes, a reading library with live RSS, and trader categories.
(function (root) {
  "use strict";
  const R = {};
  R.fetch = (...a) => fetch(...a);
  R.UA = "TraderGze Intel (self-hosted) admin@localhost";
  async function get(url, type = "json", headers = {}) {
    const r = await R.fetch(url, { headers: Object.assign({ "User-Agent": R.UA, Accept: type === "json" ? "application/json" : "*/*" }, headers) });
    if (!r.ok) throw new Error(`${new URL(url).host} answered HTTP ${r.status}`);
    return type === "json" ? r.json() : r.text();
  }
  R.get = get;
  const strip = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  R.strip = strip;

  // ---------------------------------------------------------------- economic calendar (Forex Factory weekly export)
  /** This week's events: [{title, country, time, impact, forecast, previous}] sorted by time. */
  async function calendar() {
    const j = await get("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
    return parseCalendar(j);
  }
  function parseCalendar(j) {
    return (j || []).map((e) => ({ title: e.title, country: e.country, time: Math.floor(Date.parse(e.date) / 1000), impact: e.impact, forecast: e.forecast || "", previous: e.previous || "", actual: e.actual || "" }))
      .filter((e) => isFinite(e.time)).sort((a, b) => a.time - b.time);
  }
  Object.assign(R, { calendar, parseCalendar });

  // ---------------------------------------------------------------- CFTC Commitments of Traders (disaggregated, futures only)
  const COT = [
    ["088691", "Gold", "metals"], ["084691", "Silver", "metals"], ["085692", "Copper", "metals"], ["076651", "Platinum", "metals"],
    ["067651", "WTI crude oil", "energy"], ["023651", "Natural gas (Henry Hub)", "energy"], ["111659", "Gasoline (RBOB)", "energy"], ["022651", "Heating oil (ULSD)", "energy"],
    ["002602", "Corn", "ags"], ["001602", "Wheat (SRW)", "ags"], ["005602", "Soybeans", "ags"], ["083731", "Coffee", "ags"],
  ];
  R.COT = COT;
  /** Managed money (hedge funds / CTAs) and producer net positions, last 26 weeks per market. */
  async function cot() {
    const codes = COT.map((c) => `'${c[0]}'`).join(",");
    const url = `https://publicreporting.cftc.gov/resource/72hh-3qpy.json?$where=${encodeURIComponent(`cftc_contract_market_code in(${codes})`)}&$order=${encodeURIComponent("report_date_as_yyyy_mm_dd DESC")}&$limit=${COT.length * 30}`;
    return parseCot(await get(url));
  }
  function parseCot(rows) {
    const n = (x) => Number(x || 0);
    return COT.map(([code, name, kind]) => {
      const hist = rows.filter((r) => r.cftc_contract_market_code === code).map((r) => ({
        date: String(r.report_date_as_yyyy_mm_dd).slice(0, 10), oi: n(r.open_interest_all),
        mm: n(r.m_money_positions_long_all) - n(r.m_money_positions_short_all), prod: n(r.prod_merc_positions_long_all) - n(r.prod_merc_positions_short_all),
      })).sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-26);
      const last = hist[hist.length - 1], prev = hist[hist.length - 2];
      const mms = hist.map((h) => h.mm), lo = Math.min(...mms), hi = Math.max(...mms);
      return { code, name, kind, hist, last, change: last && prev ? last.mm - prev.mm : null, mmPctile: last && hi > lo ? (last.mm - lo) / (hi - lo) : null };
    }).filter((m) => m.last);
  }
  Object.assign(R, { cot, parseCot });

  // ---------------------------------------------------------------- insider buying (OpenInsider)
  /** Latest open-market insider purchases: [{filed, traded, ticker, company, insider, title, type, price, qty, value}] */
  async function insiders(url = "http://openinsider.com/latest-insider-purchases-25k") { return parseInsiders(await get(url, "text")); }
  function parseInsiders(html) {
    const t = (html.match(/<table[^>]*class="tinytable"[^>]*>([\s\S]*?)<\/table>/i) || [])[1] || "";
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => strip(c[1])));
    const num = (s) => Number(String(s).replace(/[$,+]/g, "")) || 0;
    return rows.filter((c) => c.length >= 13).map((c) => ({ filed: c[1], traded: c[2], ticker: c[3], company: c[4], insider: c[5], title: c[6], type: c[7], price: num(c[8]), qty: num(c[9]), owned: c[10], deltaOwn: c[11], value: num(c[12]) }));
  }
  Object.assign(R, { insiders, parseInsiders });

  // ---------------------------------------------------------------- superinvestor 13F (SEC EDGAR)
  const FUNDS = [
    ["0001067983", "Berkshire Hathaway", "Warren Buffett"], ["0001649339", "Scion Asset Management", "Michael Burry"], ["0001336528", "Pershing Square", "Bill Ackman"],
    ["0001536411", "Duquesne Family Office", "Stanley Druckenmiller"], ["0001656456", "Appaloosa", "David Tepper"], ["0001350694", "Bridgewater Associates", "Ray Dalio's firm"],
    ["0000949509", "Oaktree Capital", "Howard Marks"], ["0001709323", "Himalaya Capital", "Li Lu"], ["0001061768", "Baupost Group", "Seth Klarman"], ["0001040273", "Third Point", "Dan Loeb"],
  ];
  R.FUNDS = FUNDS;
  /** Parse a 13F information table XML into {name -> {name, cusip, value, shares}} (puts/calls kept separate). */
  function parse13f(xml) {
    const out = {};
    for (const m of xml.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi)) {
      const g = (tag) => strip((m[1].match(new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, "i")) || [])[1]);
      const name = g("nameOfIssuer"), cusip = g("cusip"), pc = g("putCall"), k = cusip + (pc ? ":" + pc : "");
      const o = (out[k] = out[k] || { name: name + (pc ? ` (${pc})` : ""), cusip, value: 0, shares: 0 });
      o.value += Number(g("value")) || 0; o.shares += Number(g("sshPrnamt")) || 0;
    }
    return out;
  }
  /** What changed between two 13F holdings maps: new, added, trimmed, sold out. */
  function diff13f(cur, prev) {
    const tot = Object.values(cur).reduce((s, x) => s + x.value, 0) || 1, ch = [];
    for (const [k, h] of Object.entries(cur)) {
      const p = prev[k];
      if (!p) ch.push({ name: h.name, action: "new", value: h.value, weight: h.value / tot });
      else if (h.shares > p.shares * 1.1) ch.push({ name: h.name, action: "added", value: h.value, weight: h.value / tot, pct: h.shares / p.shares - 1 });
      else if (h.shares < p.shares * 0.9) ch.push({ name: h.name, action: "trimmed", value: h.value, weight: h.value / tot, pct: h.shares / p.shares - 1 });
    }
    for (const [k, p] of Object.entries(prev)) if (!cur[k]) ch.push({ name: p.name, action: "sold out", value: p.value, weight: 0 });
    const top = Object.values(cur).sort((a, b) => b.value - a.value).slice(0, 10).map((h) => ({ name: h.name, value: h.value, weight: h.value / tot }));
    return { total: tot, top, changes: ch.sort((a, b) => b.value - a.value).slice(0, 15) };
  }
  Object.assign(R, { parse13f, diff13f });
  async function holdingsOf(cik, acc) {
    const dir = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}`;
    const idx = await get(dir + "/index.json");
    const files = (idx.directory && idx.directory.item) || [];
    const xml = files.map((f) => f.name).filter((n) => /\.xml$/i.test(n) && !/primary_doc/i.test(n));
    for (const n of xml) { const h = parse13f(await get(`${dir}/${n}`, "text")); if (Object.keys(h).length) return h; }
    throw new Error("no information table in " + acc);
  }
  /** Latest 13F of each fund vs its previous one. Slow (SEC asks for ≤10 requests a second): run daily. */
  async function superinvestors(funds = FUNDS) {
    const out = [];
    for (const [cik, fund, manager] of funds) {
      try {
        const sub = await get(`https://data.sec.gov/submissions/CIK${cik}.json`), r = sub.filings.recent, f = [];
        for (let i = 0; i < r.form.length && f.length < 2; i++) if (r.form[i] === "13F-HR") f.push({ acc: r.accessionNumber[i], date: r.reportDate[i], filed: r.filingDate[i] });
        if (!f.length) throw new Error("no 13F filed");
        const cur = await holdingsOf(cik, f[0].acc), prev = f[1] ? await holdingsOf(cik, f[1].acc) : {};
        out.push(Object.assign({ cik, fund, manager, period: f[0].date, filed: f[0].filed, url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=13F` }, diff13f(cur, prev)));
      } catch (e) { out.push({ cik, fund, manager, error: e.message }); }
      await new Promise((ok) => setTimeout(ok, 400));
    }
    return out;
  }
  R.superinvestors = superinvestors;

  // ---------------------------------------------------------------- reading library
  const FEEDS = [
    ["Federal Reserve press releases", "https://www.federalreserve.gov/feeds/press_all.xml", "central banks"],
    ["ECB press", "https://www.ecb.europa.eu/rss/press.html", "central banks"],
    ["BIS central bank speeches", "https://www.bis.org/doclist/cbspeeches.rss", "central banks"],
    ["Aswath Damodaran — Musings on Markets", "https://aswathdamodaran.blogspot.com/feeds/posts/default", "valuation"],
    ["Collaborative Fund (Morgan Housel)", "https://collabfund.com/blog/feed.xml", "investing"],
    ["Farnam Street", "https://fs.blog/feed/", "thinking"],
    ["AQR insights", "https://www.aqr.com/Insights/Research/rss", "quant"],
    ["a16z", "https://a16z.com/feed/", "tech & crypto"],
  ];
  const LIBRARY = [
    ["Investor letters & memos", [["Berkshire Hathaway shareholder letters", "https://www.berkshirehathaway.com/letters/letters.html", "Buffett's annual letters since 1977"], ["Oaktree memos (Howard Marks)", "https://www.oaktreecapital.com/insights/memos", "Cycles, risk and market psychology"], ["Bridgewater research", "https://www.bridgewater.com/research-and-insights", "Debt cycles, macro regimes"], ["GMO research", "https://www.gmo.com/americas/research-library/", "7-year asset class forecasts, valuation"], ["AQR research", "https://www.aqr.com/Insights/Research", "Factors, trend following, risk premia"], ["ARK Invest research", "https://www.ark-invest.com/research", "Disruptive tech and crypto theses"], ["J.P. Morgan Guide to the Markets", "https://am.jpmorgan.com/us/en/asset-management/adv/insights/market-insights/guide-to-the-markets/", "The quarterly chart book of the whole market"]]],
    ["What the big money holds", [["Dataroma", "https://www.dataroma.com/m/home.php", "Superinvestor portfolios and buys"], ["WhaleWisdom", "https://whalewisdom.com/", "13F filings of every fund"], ["13f.info", "https://13f.info/", "Clean 13F holdings tables"], ["SEC EDGAR", "https://www.sec.gov/edgar/search/", "The source filings: 13F, Form 4, 10-K"], ["OpenInsider", "http://openinsider.com/", "Insider buys and sells (Form 4)"], ["Capitol Trades", "https://www.capitoltrades.com/trades", "US Congress members' stock trades"]]],
    ["Macro data", [["FRED", "https://fred.stlouisfed.org/", "Every US macro series: rates, real yields, inflation"], ["Federal Reserve", "https://www.federalreserve.gov/", "FOMC statements, minutes, dot plot"], ["ECB", "https://www.ecb.europa.eu/", "Euro area policy"], ["BIS", "https://www.bis.org/", "Global liquidity, central bank research"], ["Trading Economics", "https://tradingeconomics.com/", "Indicators and forecasts for every country"], ["Forex Factory calendar", "https://www.forexfactory.com/calendar", "The week's market-moving releases"]]],
    ["Stocks & valuation", [["Damodaran Online", "https://pages.stern.nyu.edu/~adamodar/", "Equity risk premium, sector multiples, valuation classes"], ["Macrotrends", "https://www.macrotrends.net/", "Long-term charts of stocks and macro"], ["Stock Analysis", "https://stockanalysis.com/", "Financials, ETFs, IPOs"], ["Finviz", "https://finviz.com/", "Screener and market heat map"], ["TradingView", "https://www.tradingview.com/", "Charts and ideas"], ["Koyfin", "https://www.koyfin.com/", "Pro-style dashboards and charts"]]],
    ["Thinking & process", [["Collaborative Fund blog", "https://collabfund.com/blog/", "Morgan Housel on behavior and money"], ["Farnam Street", "https://fs.blog/", "Mental models and decision making"], ["a16z", "https://a16z.com/", "Tech and crypto research"]]],
    ["Books referenced in this app", [["Alpha Trader — Brent Donnelly", "https://www.goodreads.com/search?q=alpha+trader+donnelly", "Process, risk, planning trades before entry, narrative and correlation regimes"], ["Way of the Turtle — Curtis Faith", "https://www.goodreads.com/search?q=way+of+the+turtle", "55-day breakouts, ATR stops and position sizing"], ["Technical Analysis of the Financial Markets — John Murphy", "https://www.goodreads.com/search?q=technical+analysis+of+the+financial+markets+murphy", "Trendlines, moving averages, measured moves"], ["Intermarket Analysis — John Murphy", "https://www.goodreads.com/search?q=intermarket+analysis+murphy", "How stocks, bonds, commodities and the dollar move together"], ["The Most Important Thing — Howard Marks", "https://www.goodreads.com/search?q=the+most+important+thing+marks", "Risk, cycles and second-level thinking"], ["Big Debt Crises — Ray Dalio", "https://www.goodreads.com/search?q=big+debt+crises", "The debt-cycle template behind macro regimes"]]],
  ];
  Object.assign(R, { FEEDS, LIBRARY });
  /** RSS 2.0 or Atom -> [{title, link, time, summary}] */
  function parseFeed(xml) {
    const items = [...xml.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
    return items.map((it) => {
      const g = (tag) => strip((it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")) || [])[1]);
      const link = (it.match(/<link[^>]*href="([^"]+)"[^>]*\/?>(?![\s\S]*rel="replies")/i) || [])[1] || g("link") || g("guid");
      const time = Date.parse(g("pubDate") || g("published") || g("updated") || g("dc:date"));
      return { title: g("title"), link, time: isFinite(time) ? Math.floor(time / 1000) : null, summary: (g("description") || g("summary") || g("content")).slice(0, 280) };
    }).filter((x) => x.title && x.link);
  }
  R.parseFeed = parseFeed;
  async function readFeeds(feeds = FEEDS) {
    const out = await Promise.all(feeds.map(async ([name, url, kind]) => { try { return { name, url, kind, items: parseFeed(await get(url, "text")).slice(0, 8) }; } catch (e) { return { name, url, kind, items: [], error: e.message }; } }));
    return out;
  }
  R.readFeeds = readFeeds;

  // ---------------------------------------------------------------- Hyperliquid market categories
  const METALS = ["GOLD", "SILVER", "COPPER", "PLATINUM", "PALLADIUM", "XAU", "XAG", "PAXG"];
  const ENERGY = ["CL", "OIL", "WTI", "BRENT", "BRENTOIL", "NATGAS", "NG", "USOIL", "UKOIL", "GAS", "URANIUM"];
  const AGS = ["CORN", "WHEAT", "SOY", "COFFEE", "COCOA", "SUGAR"];
  const base = (coin) => String(coin).split(":").pop().toUpperCase();
  /** "btc" | "stocks" | "commodities" | "crypto" for a Hyperliquid coin name (HIP-3 markets look like "xyz:TSLA"). */
  function category(coin) {
    const c = String(coin), b = base(c);
    if (c === "BTC" || c === "UBTC") return "btc";
    if (METALS.includes(b) || ENERGY.includes(b) || AGS.includes(b)) return "commodities";
    if (c.includes(":")) return "stocks";
    return "crypto";
  }
  R.category = category; R.base = base;
  R.sector = (coin) => { const b = base(coin); return METALS.includes(b) ? "metals" : ENERGY.includes(b) ? "energy" : AGS.includes(b) ? "ags" : null; };

  if (typeof module !== "undefined" && module.exports) module.exports = R;
  else root.Research = R;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();
const LN = (function () { const module = { exports: {} };
// TraderGze learner: a database of profitable traders' real trades, the market conditions at each of their
// entries, and A+ setups (2R, planned in advance) chosen when today's conditions match the ones where
// those traders' entries most often went on to reach 2R. Pure logic; the server feeds it trades and candles.
(function (root) {
  "use strict";
  const L = {};

  // ---------------------------------------------------------------- the tickers you trade
  // key, display, tab, Hyperliquid market name aliases (base name after "dex:"), Yahoo symbol for prices
  const TICKERS = [
    { key: "BTC", name: "BTC", label: "Bitcoin", tab: "btc", hl: ["BTC"], yahoo: "BTC-USD", main: true },
    { key: "XYZ100", name: "XYZ100", label: "Nasdaq 100 (XYZ100)", tab: "stocks", hl: ["XYZ100"], yahoo: "^NDX" },
    { key: "SPCX", name: "SPCX", label: "SPCX", tab: "stocks", hl: ["SPCX"], yahoo: null },
    { key: "US500", name: "S&P500", label: "S&P 500", tab: "stocks", hl: ["S&P500", "SP500", "US500", "SPX500"], yahoo: "^GSPC" },
    { key: "USOIL", name: "WTIOIL", label: "WTI crude oil", tab: "commodities", hl: ["WTIOIL", "WTI", "USOIL", "CL"], yahoo: "CL=F" },
    { key: "GOLD", name: "GOLD", label: "Gold", tab: "commodities", hl: ["GOLD"], yahoo: "GC=F" },
    { key: "SILVER", name: "SILVER", label: "Silver", tab: "commodities", hl: ["SILVER"], yahoo: "SI=F" },
  ];
  L.TICKERS = TICKERS;
  L.ticker = (k) => TICKERS.find((t) => t.key === k);
  /** Which Hyperliquid coins belong to each ticker: {BTC: ["BTC"], GOLD: ["xyz:GOLD", "flx:GOLD"], ...} */
  function matchCoins(coins) {
    const out = {};
    for (const t of TICKERS) out[t.key] = t.main ? ["BTC"] : coins.filter((c) => t.hl.includes(String(c).split(":").pop().toUpperCase()));
    return out;
  }
  L.matchCoins = matchCoins;
  L.tickerOf = (coin, map) => { for (const [k, cs] of Object.entries(map)) if (cs.includes(coin)) return k; return null; };
  /** Virtual name: BTCTrader1, US500Trader3, GOLDTrader2 … */
  L.traderName = (key, n) => `${key}Trader${n}`;

  // ---------------------------------------------------------------- round trips from fills
  /** Fills -> complete trades (flat -> position -> flat), with average entry / exit. */
  function roundTrips(fills, keep = () => true) {
    const by = {};
    for (const f of (fills || []).filter((x) => keep(x.coin)).sort((a, b) => a.time - b.time)) (by[f.coin] = by[f.coin] || []).push(f);
    const out = [];
    for (const [coin, fs] of Object.entries(by)) {
      let pos = Number(fs[0].startPosition || 0), cur = null;
      for (const f of fs) {
        const sz = Number(f.sz), px = Number(f.px), d = f.side === "B" ? sz : -sz, before = pos;
        pos = +(pos + d).toFixed(10);
        if (before === 0 && pos !== 0) cur = { coin, side: pos > 0 ? "long" : "short", t0: Math.floor(f.time / 1000), qty: Math.abs(pos), cost: Math.abs(pos) * px, pnl: 0, exitQty: 0, exitCost: 0 };
        else if (cur) {
          if (Math.sign(d) === (cur.side === "long" ? 1 : -1)) { cur.qty += sz; cur.cost += sz * px; }
          else { const q = Math.min(sz, Math.abs(before)); cur.exitQty += q; cur.exitCost += q * px; }
          cur.pnl += Number(f.closedPnl || 0) - Number(f.fee || 0);
          if (pos === 0 || Math.sign(pos) !== Math.sign(before)) {
            out.push({ coin, side: cur.side, t0: cur.t0, px0: cur.cost / cur.qty, t1: Math.floor(f.time / 1000), px1: cur.exitQty ? cur.exitCost / cur.exitQty : px, pnl: cur.pnl, qty: cur.qty });
            cur = pos !== 0 ? { coin, side: pos > 0 ? "long" : "short", t0: Math.floor(f.time / 1000), qty: Math.abs(pos), cost: Math.abs(pos) * px, pnl: 0, exitQty: 0, exitCost: 0 } : null;
          }
        }
      }
    }
    return out.sort((a, b) => a.t0 - b.t0);
  }
  L.roundTrips = roundTrips;

  // ---------------------------------------------------------------- candles and features
  const ema = (xs, n) => { const k = 2 / (n + 1); let e = null; return xs.map((x) => (e = e == null ? x : x * k + e * (1 - k))); };
  function atr(b, n = 14) { let a = null; return b.map((x, i) => { const tr = i ? Math.max(x.h - x.l, Math.abs(x.h - b[i - 1].c), Math.abs(x.l - b[i - 1].c)) : x.h - x.l; return (a = a == null ? tr : (a * (n - 1) + tr) / n); }); }
  function rsi(c, n = 14) { let g = 0, l = 0; return c.map((x, i) => { if (!i) return 50; const d = x - c[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; return l === 0 ? 100 : 100 - 100 / (1 + g / l); }); }
  /** 1h bars -> 4h bars aligned to UTC 0/4/8/… */
  function to4h(bars) { const out = []; for (const b of bars) { const k = Math.floor(b.t / 14400) * 14400, o = out[out.length - 1]; if (o && o.t === k) { o.h = Math.max(o.h, b.h); o.l = Math.min(o.l, b.l); o.c = b.c; o.v += b.v || 0; } else out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }); } return out; }
  L.to4h = to4h; L.ema = ema; L.atr = atr;
  /** Indicators for a bar series, computed once. */
  function prep(bars) {
    const c = bars.map((b) => b.c);
    let pv = 0, vv = 0, day = null;
    const vw = bars.map((b) => { const d = Math.floor(b.t / 86400); if (d !== day) { pv = 0; vv = 0; day = d; } const v = b.v || 1; pv += ((b.h + b.l + b.c) / 3) * v; vv += v; return pv / vv; });
    return { bars, e20: ema(c, 20), e50: ema(c, 50), e200: ema(c, 200), a: atr(bars), r: rsi(c), vw };
  }
  L.prep = prep;
  const FEATURES = ["vs EMA20", "vs EMA50", "EMA20 vs 50", "vs EMA200", "RSI", "vs VWAP", "in 20-bar range", "volatility", "5-bar momentum", "hour (sin)", "hour (cos)"];
  L.FEATURES = FEATURES;
  /** Feature vector at bar i, mirrored for shorts so "with the trade" always points the same way. */
  function features(P, i, side, style) {
    const b = P.bars, x = b[i], a = P.a[i] || 1, s = side === "long" ? 1 : -1;
    if (i < 60) return null;
    const w = b.slice(i - 19, i + 1), hi = Math.max(...w.map((y) => y.h)), lo = Math.min(...w.map((y) => y.l)), rng = (x.c - lo) / (hi - lo || 1);
    const avgA = P.a.slice(Math.max(0, i - 100), i + 1).reduce((t, y) => t + y, 0) / Math.min(101, i + 1);
    const hr = (new Date(x.t * 1000).getUTCHours() + new Date(x.t * 1000).getUTCMinutes() / 60) / 24 * 2 * Math.PI;
    const clip = (v, m = 4) => Math.max(-m, Math.min(m, v));
    return [
      clip(s * (x.c - P.e20[i]) / a), clip(s * (x.c - P.e50[i]) / a), clip(s * (P.e20[i] - P.e50[i]) / a), clip(s * (x.c - P.e200[i]) / a / 2),
      (s > 0 ? P.r[i] : 100 - P.r[i]) / 25 - 2, clip(s * (x.c - (style !== "swing" ? P.vw[i] : P.e20[i])) / a),
      (s > 0 ? rng : 1 - rng) * 2 - 1, clip(a / (avgA || a) - 1, 2) * 2, clip(s * (x.c - b[i - 5].c) / a),
      style !== "swing" ? Math.sin(hr) : 0, style !== "swing" ? Math.cos(hr) : 0,
    ];
  }
  L.features = features;
  const indexAt = (bars, t) => { let lo = 0, hi = bars.length - 1; if (!bars.length || t < bars[0].t) return -1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (bars[m].t <= t) lo = m; else hi = m - 1; } return lo; };
  L.indexAt = indexAt;

  // ---------------------------------------------------------------- the 2R plan
  const STYLE = { scalp: { stopBars: 6, minA: 0.6, maxA: 2, horizon: 96, bar: "15m" }, swing: { stopBars: 10, minA: 1, maxA: 3, horizon: 60, bar: "4h" } };
  L.STYLE = STYLE;
  /** Stop beyond the recent swing (clamped in ATRs), target exactly 2R. */
  function plan2R(P, i, side, style) {
    const st = STYLE[style], b = P.bars, x = b[i], a = P.a[i], w = b.slice(Math.max(0, i - st.stopBars + 1), i + 1);
    let stop = side === "long" ? Math.min(...w.map((y) => y.l)) - 0.2 * a : Math.max(...w.map((y) => y.h)) + 0.2 * a;
    let risk = Math.abs(x.c - stop);
    risk = Math.max(st.minA * a, Math.min(st.maxA * a, risk));
    stop = side === "long" ? x.c - risk : x.c + risk;
    return { side, entry: x.c, stop, target: side === "long" ? x.c + 2 * risk : x.c - 2 * risk, risk, rr: 2 };
  }
  L.plan2R = plan2R;
  /** Walk the bars after i: 1 = target first, 0 = stop first (stops win ties), null = neither within the horizon. */
  function outcome(bars, i, p, horizon) {
    for (let k = i + 1; k < Math.min(bars.length, i + 1 + horizon); k++) {
      const b = bars[k];
      if (p.side === "long" ? b.l <= p.stop : b.h >= p.stop) return { y: 0, t: b.t };
      if (p.side === "long" ? b.h >= p.target : b.l <= p.target) return { y: 1, t: b.t };
    }
    return bars.length > i + horizon ? { y: 0, t: bars[i + horizon].t, timeout: true } : null;
  }
  L.outcome = outcome;

  // ---------------------------------------------------------------- the database and the model
  /**
   * Turn learned trades into examples: features at each entry, and whether OUR 2R plan from that entry worked.
   * trades: [{ticker, side, t0, t1, pnl, trader}], series: {ticker: {scalp: prep(15m), swing: prep(4h)}}
   */
  function buildExamples(trades, series) {
    const out = [];
    for (const tr of trades) {
      const style = tr.t1 - tr.t0 < 12 * 3600 ? "scalp" : "swing", P = series[tr.ticker] && series[tr.ticker][style];
      if (!P) continue;
      const i = indexAt(P.bars, tr.t0) - (style === "scalp" ? 0 : 0);
      if (i < 60 || i >= P.bars.length - 2) continue;
      const f = features(P, i, tr.side, style); if (!f) continue;
      const o = outcome(P.bars, i, plan2R(P, i, tr.side, style), STYLE[style].horizon);
      if (!o) continue;
      out.push({ ticker: tr.ticker, style, side: tr.side, t: tr.t0, f, y: o.y, traderWin: tr.pnl > 0, trader: tr.trader });
    }
    return out;
  }
  L.buildExamples = buildExamples;
  const dist = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += (a[k] - b[k]) ** 2; return Math.sqrt(s); };
  /** k nearest past entries: P(2R) and how many are close enough to count. */
  function predict(examples, f, { style, ticker, k = 30, maxDist = 2.5 } = {}) {
    const pool = examples.filter((e) => e.style === style).map((e) => ({ e, d: dist(e.f, f) * (e.ticker === ticker ? 0.85 : 1) })).sort((a, b) => a.d - b.d).slice(0, k).filter((x) => x.d <= maxDist);
    if (!pool.length) return { p: null, n: 0 };
    let w = 0, s = 0, tw = 0;
    for (const { e, d } of pool) { const wt = 1 / (0.3 + d); w += wt; s += wt * e.y; tw += wt * (e.traderWin ? 1 : 0); }
    return { p: s / w, n: pool.length, traderWinRate: tw / w, traders: new Set(pool.map((x) => x.e.trader)).size, sameTicker: pool.filter((x) => x.e.ticker === ticker).length };
  }
  L.predict = predict;
  /** What separates entries that reached 2R from the ones that didn't (mean feature, winners vs losers). */
  function insights(examples, style) {
    const ex = examples.filter((e) => e.style === style), W = ex.filter((e) => e.y === 1), Lo = ex.filter((e) => e.y === 0);
    if (W.length < 10 || Lo.length < 10) return [];
    const mean = (xs, k) => xs.reduce((s, e) => s + e.f[k], 0) / xs.length;
    return FEATURES.map((name, k) => ({ name, win: mean(W, k), loss: mean(Lo, k), gap: mean(W, k) - mean(Lo, k) })).filter((x) => !/hour/.test(x.name)).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 4);
  }
  L.insights = insights;
  const DESCRIBE = {
    "vs EMA20": ["entering stretched away from the 20 EMA", "entering close to the 20 EMA (pullback)"], "vs EMA50": ["price well on the trade's side of the 50 EMA", "price near or against the 50 EMA"],
    "EMA20 vs 50": ["fast trend already pointing the trade's way", "entering before the trend turns"], "vs EMA200": ["with the big 200 EMA trend", "against the 200 EMA trend"],
    RSI: ["momentum (RSI) with the trade", "RSI stretched against the trade (buying dips / selling rips)"], "vs VWAP": ["on the trade's side of VWAP / the average", "entering at or through VWAP / the average"],
    "in 20-bar range": ["breaking out of the 20-bar range", "entering from the opposite end of the range"], volatility: ["volatility expanding", "volatility quiet"], "5-bar momentum": ["after a push in the trade's direction", "after a pullback against the trade"],
  };
  L.describe = (ins) => ins.map((x) => (DESCRIBE[x.name] || [x.name, x.name])[x.gap > 0 ? 0 : 1]);

  /**
   * Scan the latest closed bar of each ticker and style. Returns ranked candidates with their plan.
   * A+ = enough history, P(2R) >= minP (2R breaks even at 33%), and enough close neighbours.
   */
  function candidates(examples, series, { minP = 0.5, minN = 15, minData = { scalp: 150, swing: 60 } } = {}) {
    const out = [];
    for (const [ticker, S] of Object.entries(series)) for (const style of ["scalp", "swing"]) {
      const P = S[style]; if (!P || P.bars.length < 80) continue;
      const i = P.bars.length - 1, size = examples.filter((e) => e.style === style).length;
      for (const side of ["long", "short"]) {
        const f = features(P, i, side, style); if (!f) continue;
        const pr = predict(examples, f, { style, ticker }), pl = plan2R(P, i, side, style);
        out.push(Object.assign({ ticker, style, side, time: P.bars[i].t, last: P.bars[i].c, f, dataset: size, aplus: size >= minData[style] && pr.n >= minN && pr.p >= minP }, pr, pl));
      }
    }
    return out.sort((a, b) => (b.p || 0) - (a.p || 0));
  }
  L.candidates = candidates;

  /** Settle a planned trade against later bars (stop first on ties). Unfilled if price never traded through entry: entries are market at plan time. */
  function settle(o, bars, horizonSec) {
    if (o.result && o.result !== "open") return o;
    for (const b of bars.filter((x) => x.t > o.time)) {
      if (o.side === "long" ? b.l <= o.stop : b.h >= o.stop) return Object.assign(o, { result: "loss", R: -1, closed: b.t });
      if (o.side === "long" ? b.h >= o.target : b.l <= o.target) return Object.assign(o, { result: "win", R: 2, closed: b.t });
      if (b.t - o.time > horizonSec) return Object.assign(o, { result: "timeout", R: +(((o.side === "long" ? b.c - o.entry : o.entry - b.c) / o.risk)).toFixed(2), closed: b.t });
    }
    return Object.assign(o, { result: "open" });
  }
  L.settle = settle;

  // ================================================================ copy-trader ranking on whole positions
  /** Copy rules: whole positions (open -> fully closed), over 90 days, still profitable in the last 30. */
  const COPY = { minPositions: { main: 20, other: 9 }, minWinRate: 0.7, minPF: 2, maxPerDay: 30, minMedianHoldSec: 300 };
  L.COPY = COPY;
  /** Statistics on whole positions. Field names match the trader page (winRate, profitFactor, payoff, pnl, maxDrawdown…). */
  function positionStats(trips, now = Date.now() / 1000) {
    const ps = trips.slice().sort((a, b) => a.t1 - b.t1), wins = ps.filter((p) => p.pnl > 0), losses = ps.filter((p) => p.pnl <= 0);
    const gw = wins.reduce((s, p) => s + p.pnl, 0), gl = -losses.reduce((s, p) => s + p.pnl, 0);
    let cum = 0, peak = 0, dd = 0; const equity = ps.map((p) => { cum += p.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); return [p.t1, Math.round(cum * 100) / 100]; });
    const holds = ps.map((p) => p.t1 - p.t0).sort((a, b) => a - b), span = ps.length ? Math.max(1, (now - ps[0].t0) / 86400) : 1;
    const n = ps.length, conf = n >= 60 ? "High" : n >= 30 ? "Medium" : "Low";
    return { trades: n, wins: wins.length, losses: losses.length, winRate: n ? wins.length / n : null, profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null,
      payoff: wins.length && losses.length && gl > 0 ? (gw / wins.length) / (gl / losses.length) : null, avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? gl / losses.length : null,
      pnl: cum, pnl30: ps.filter((p) => p.t1 >= now - 30 * 86400).reduce((s, p) => s + p.pnl, 0), maxDrawdown: dd, medianHoldSec: holds.length ? holds[Math.floor(holds.length / 2)] : null, perDay: n / span, confidence: conf,
      equity, recent: ps.slice(-30).reverse().map((p) => ({ time: p.t1 * 1000, coin: p.coin, side: p.side, sz: p.qty, net: p.pnl, entry: p.px0, exit: p.px1, opened: p.t0 })) };
  }
  L.positionStats = positionStats;
  /** Why a trader does not qualify (empty = qualifies). */
  function copyCheck(s, main) {
    const why = [];
    if (s.trades < (main ? COPY.minPositions.main : COPY.minPositions.other)) why.push("too few positions");
    if (!(s.winRate >= COPY.minWinRate)) why.push("win rate under 70%");
    if (!(s.profitFactor >= COPY.minPF)) why.push("profit factor under 2");
    if (!(s.pnl30 > 0)) why.push("not profitable in the last 30 days");
    if (s.perDay > COPY.maxPerDay || (s.medianHoldSec != null && s.medianHoldSec < COPY.minMedianHoldSec)) why.push("bot or market maker");
    return why;
  }
  L.copyCheck = copyCheck;
  /** Rank: win rate and profit factor (counted up to 6) equally; a worst drop bigger than half the profit costs 30%. */
  L.copyRank = (s) => (0.5 * (s.winRate || 0) + 0.5 * Math.min(isFinite(s.profitFactor) ? s.profitFactor : 6, 6) / 6) * (s.maxDrawdown > s.pnl / 2 ? 0.7 : 1);

  // ================================================================ strategy features for the agent lab
  // Textbook and institutional signal families, each as one number "with the trade" (mirrored for shorts):
  // Bollinger z-score (mean reversion), Connors RSI(2), 55-bar Donchian breakout (Turtles), MACD histogram,
  // time-series momentum (Moskowitz), distance beyond the prior day's high/low, opening-range breakout, Keltner breakout.
  const LAB_EXTRA = ["Bollinger z-score", "RSI(2)", "55-bar breakout", "MACD histogram", "time-series momentum", "beyond prior-day high/low", "opening-range breakout", "Keltner breakout"];
  const FEATURES3 = [];                      // filled below (after FEATURES2 exists)
  L.LAB_EXTRA = LAB_EXTRA;
  function prepLab(P) {
    if (P.lab) return P.lab;
    const b = P.bars, c = b.map((x) => x.c), n = b.length, sma = new Array(n), sd = new Array(n);
    for (let i = 0; i < n; i++) { const w = c.slice(Math.max(0, i - 19), i + 1), m = w.reduce((s, x) => s + x, 0) / w.length; sma[i] = m; sd[i] = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / w.length) || 1e-9; }
    const r2 = (() => { let g = 0, l = 0; return c.map((x, i) => { if (!i) return 50; const d = x - c[i - 1]; g = (g + Math.max(d, 0)) / 2; l = (l + Math.max(-d, 0)) / 2; return l === 0 ? 100 : 100 - 100 / (1 + g / l); }); })();
    const e12 = ema(c, 12), e26 = ema(c, 26), macd = e12.map((x, i) => x - e26[i]), sig = ema(macd, 9);
    const day = b.map((x) => Math.floor(x.t / 86400)), pdh = new Array(n).fill(null), pdl = new Array(n).fill(null), orh = new Array(n).fill(null), orl = new Array(n).fill(null);
    let curD = null, hi = -Infinity, lo = Infinity, prevHi = null, prevLo = null, oh = -Infinity, ol = Infinity;
    for (let i = 0; i < n; i++) {
      if (day[i] !== curD) { if (curD !== null) { prevHi = hi; prevLo = lo; } curD = day[i]; hi = -Infinity; lo = Infinity; oh = -Infinity; ol = Infinity; }
      hi = Math.max(hi, b[i].h); lo = Math.min(lo, b[i].l);
      if (b[i].t - curD * 86400 < 3600) { oh = Math.max(oh, b[i].h); ol = Math.min(ol, b[i].l); }
      pdh[i] = prevHi; pdl[i] = prevLo;
      if (b[i].t - curD * 86400 >= 3600 && isFinite(oh)) { orh[i] = oh; orl[i] = ol; }
    }
    return (P.lab = { sma, sd, r2, hist: macd.map((x, i) => x - sig[i]), pdh, pdl, orh, orl });
  }
  /** Agent-lab features: the 16 chart features plus 8 strategy-family signals (24 numbers). */
  function features3(P, i, side, style) {
    const f = features2(P, i, side, style); if (!f || i < 60) return null;
    const X = prepLab(P), b = P.bars, x = b[i], a = P.a[i] || 1, s = side === "long" ? 1 : -1, clip = (v, m = 4) => Math.max(-m, Math.min(m, v));
    const w = b.slice(i - 55, i), hh = Math.max(...w.map((y) => y.h)), ll = Math.min(...w.map((y) => y.l)), back = b[Math.max(0, i - 48)].c;
    return f.concat([
      clip(s * (x.c - X.sma[i]) / X.sd[i]), (s > 0 ? X.r2[i] : 100 - X.r2[i]) / 25 - 2, s > 0 ? (x.c > hh ? 1 : x.c < ll ? -1 : 0) : (x.c < ll ? 1 : x.c > hh ? -1 : 0), clip(s * X.hist[i] / a), clip(s * (x.c - back) / a / 3),
      X.pdh[i] == null ? 0 : clip(s > 0 ? (x.c - X.pdh[i]) / a : (X.pdl[i] - x.c) / a), X.orh[i] == null ? 0 : clip(s > 0 ? (x.c - X.orh[i]) / a : (X.orl[i] - x.c) / a), clip(s * (x.c - (P.e20[i] + s * 2 * a)) / a),
    ]);
  }
  L.features3 = features3;
  /** Lab styles: 5-minute scalps (out within 6 hours), 15-minute scalps (a day), 4-hour swings (10 days). Pip rules per style. */
  L.LAB_STYLES = { scalp5: { rules: "scalp", bar: 300, horizon: 6 * 3600, step: 1 }, scalp: { rules: "scalp", bar: 900, horizon: 86400, step: 2 }, swing: { rules: "swing", bar: 14400, horizon: 10 * 86400, step: 1 }, h1: { rules: "scalp", bar: 3600, horizon: 2 * 86400, step: 1 } };
  /** Every past bar of a ticker for one lab style, both sides: features, the pip-plan outcome, and price/ATR for other plans. */
  function labSamples(series, ticker, style) {
    const S = series[ticker], st = L.LAB_STYLES[style], P = S && (style === "scalp5" ? S.m5 : style === "h1" ? S.h1p : S[style]), fine = S && (style === "scalp5" ? S.fine5 : style === "scalp" ? S.fine5 || S.fine : style === "h1" ? S.fine : S.h1), out = [];
    if (!P || !fine) return out;
    for (let i = 60; i < P.bars.length - 1; i += st.step) for (const side of ["long", "short"]) {
      const f = features3(P, i, side, style); if (!f) continue;
      const pl = planPips(P, i, side, st.rules, ticker), w = walkT(fine, P.bars[i].t + st.bar - 1, pl, st.horizon);
      if (w) out.push({ f, y: w.y, side, t: P.bars[i].t + st.bar, tc: w.tc, rr: pl.rr, ticker, style, c: P.bars[i].c, a: P.a[i], plan: { side, entry: pl.entry, stop: pl.stop, target: pl.target }, slPips: pl.slPips, tpPips: pl.tpPips });
    }
    return out;
  }
  L.labSamples = labSamples;

  // ================================================================ pip-based planner (v2)
  // A pip per ticker: BTC $10 (81,300 -> 81,400 = 10 pips), GOLD $1 (4,120 -> 4,130 = 10 pips), SILVER $0.01 (63.30 -> 63.50 = 20 pips).
  const PIP = { BTC: 10, GOLD: 1, SILVER: 0.01 };
  L.PIP = PIP;
  // what goes in the database (profitable and quick), and how every planned trade is built
  const RULES = {
    scalp: { minMove: 20, maxMove: 80, maxDD: 20, sl: [5, 10], tp: 20, horizon: 24 * 3600, need: 150, stopBars: 6 },
    swing: { minMove: 100, maxMove: 1000, maxDD: 70, sl: [30, 70], tp: 100, horizon: 10 * 86400, need: 60, stopBars: 10 },
  };
  L.RULES = RULES;
  /** Volume, order-flow proxy (close location x volume), higher-timeframe trend. */
  function prepX(bars, funding = []) {
    const P = prep(bars), v = bars.map((b) => b.v || 0);
    P.vAvg = v.map((_, i) => { const w = v.slice(Math.max(0, i - 19), i + 1); return w.reduce((s, x) => s + x, 0) / w.length || 1; });
    P.clv = bars.map((b) => (b.h > b.l ? ((b.c - b.l) - (b.h - b.c)) / (b.h - b.l) : 0));
    P.e100 = ema(bars.map((b) => b.c), 100);
    P.funding = funding.slice().sort((a, b) => a.t - b.t);
    return P;
  }
  L.prepX = prepX;
  const fundingAt = (P, t) => { const f = P.funding; if (!f || !f.length) return 0; const i = indexAt(f, t); return i < 0 ? 0 : f[i].rate; };
  const FEATURES2 = FEATURES.concat(["relative volume", "order flow (5 bars)", "funding", "higher-timeframe trend", "candle close location"]);
  L.FEATURES2 = FEATURES2;
  FEATURES3.push(...FEATURES2, ...LAB_EXTRA); L.FEATURES3 = FEATURES3;
  function features2(P, i, side, style) {
    const base = features(P, i, side, style); if (!base) return null;
    const s = side === "long" ? 1 : -1, clip = (v, m = 4) => Math.max(-m, Math.min(m, v));
    let flow = 0, vs = 0; for (let k = i - 4; k <= i; k++) { flow += P.clv[k] * (P.bars[k].v || 0); vs += P.bars[k].v || 0; }
    const fr = fundingAt(P, P.bars[i].t);
    return base.concat([clip(Math.log(((P.bars[i].v || 0) + 1) / (P.vAvg[i] + 1)), 2), clip(s * (vs ? flow / vs : 0) * 2, 2), clip(-s * fr * 1e5, 2), clip(s * (P.e50[i] - P.e100[i]) / (P.a[i] || 1)), s * P.clv[i]]);
  }
  L.features2 = features2;
  /** Plain-language reasons a trade was taken, read from the chart at the entry bar. */
  function reasons(P, i, side) {
    const b = P.bars, x = b[i], s = side === "long" ? 1 : -1, a = P.a[i] || 1, out = [];
    const hi = Math.max(...b.slice(i - 20, i).map((y) => y.h)), lo = Math.min(...b.slice(i - 20, i).map((y) => y.l));
    if (s * (P.e20[i] - P.e50[i]) > 0 && b.slice(i - 2, i + 1).some((y) => (s > 0 ? y.l : y.h) * s <= (P.e20[i] + s * 0.3 * a) * s)) out.push("trend pullback to EMA20");
    if (s > 0 ? x.c > hi : x.c < lo) out.push(s > 0 ? "breakout above the 20-bar high" : "breakdown below the 20-bar low");
    if (s > 0 ? x.c - lo < 0.15 * (hi - lo) : hi - x.c < 0.15 * (hi - lo)) out.push(s > 0 ? "bounce from the range low" : "rejection at the range high");
    if (b.slice(i - 3, i).some((y, k) => s * (y.c - P.vw[i - 3 + k]) < 0) && s * (x.c - P.vw[i]) > 0) out.push(s > 0 ? "VWAP reclaim" : "VWAP loss");
    if ((x.v || 0) > 2 * P.vAvg[i]) out.push("volume spike");
    let fl = 0, vs = 0; for (let k = i - 4; k <= i; k++) { fl += P.clv[k] * (b[k].v || 0); vs += b[k].v || 0; }
    if (vs && s * fl / vs > 0.25) out.push(s > 0 ? "buyers in control (order-flow proxy)" : "sellers in control (order-flow proxy)");
    if (s > 0 ? Math.min(...P.r.slice(i - 3, i)) < 30 && P.r[i] > P.r[i - 1] : Math.max(...P.r.slice(i - 3, i)) > 70 && P.r[i] < P.r[i - 1]) out.push(s > 0 ? "oversold reversal (RSI)" : "overbought reversal (RSI)");
    const fr = fundingAt(P, x.t); if (fr && -s * fr > 0) out.push(s > 0 ? "funding negative: shorts crowded" : "funding positive: longs crowded");
    if (s * (P.e50[i] - P.e100[i]) > 0) out.push("with the higher-timeframe trend");
    const h = new Date(x.t * 1000).getUTCHours(); if (h >= 7 && h < 9) out.push("London open"); else if (h >= 13 && h < 15) out.push("New York open");
    return out;
  }
  L.reasons = reasons;
  /** The plan: SL beyond the recent swing, kept inside the pip limits; TP fixed (20 / 100 pips). */
  function planPips(P, i, side, style, ticker) {
    const R = RULES[style], pip = PIP[ticker] || 1, b = P.bars, x = b[i], w = b.slice(Math.max(0, i - R.stopBars + 1), i + 1);
    const struct = side === "long" ? (x.c - Math.min(...w.map((y) => y.l))) / pip + 1 : (Math.max(...w.map((y) => y.h)) - x.c) / pip + 1;
    const slPips = Math.round(Math.max(R.sl[0], Math.min(R.sl[1], struct))), s = side === "long" ? 1 : -1;
    return { side, entry: x.c, stop: x.c - s * slPips * pip, target: x.c + s * R.tp * pip, slPips, tpPips: R.tp, risk: slPips * pip, rr: +(R.tp / slPips).toFixed(2) };
  }
  L.planPips = planPips;
  /** Walk finer bars after time t: 1 target first, 0 stop first (stops win ties), null if neither within the horizon. */
  function walkT(bars, t, p, horizon) {
    let k = indexAt(bars, t) + 1; if (k <= 0) return null;
    for (; k < bars.length && bars[k].t <= t + horizon; k++) {
      const b = bars[k];
      if (p.side === "long" ? b.l <= p.stop : b.h >= p.stop) return { y: 0, tc: b.t };
      if (p.side === "long" ? b.h >= p.target : b.l <= p.target) return { y: 1, tc: b.t };
    }
    return k < bars.length ? { y: 0, tc: bars[k - 1].t, timeout: true } : null;
  }
  L.walkT = walkT;
  function walk(bars, t, p, horizon) { const r = walkT(bars, t, p, horizon); return r ? r.y : null; }
  L.walk = walk;
  /** How far a past trade went against the trader (pips) on bars between entry and exit. */
  function drawdown(bars, tr, pip) {
    const xs = bars.filter((b) => b.t >= Math.floor(tr.t0 / 900) * 900 && b.t <= tr.t1);
    if (!xs.length) return null;
    return Math.max(0, tr.side === "long" ? (tr.px0 - Math.min(...xs.map((b) => b.l))) / pip : (Math.max(...xs.map((b) => b.h)) - tr.px0) / pip);
  }
  L.drawdown = drawdown;
  /**
   * Classify learned trades and build the database. series[ticker] = {scalp: prepX(15m), swing: prepX(4h), fine: 15m bars, h1: 1h bars}
   * Returns { rows: [{ticker, style, side, t, f, reasons, movePips, ddPips, trader}], rejected: {reason: n} }
   */
  function buildDatabase(trades, series) {
    const rows = [], rejected = { "not profitable": 0, "move outside 20-80 / 100-1000 pips": 0, "too much drawdown": 0, "no price history": 0 };
    for (const tr of trades) {
      const pip = PIP[tr.ticker], S = series[tr.ticker];
      if (!pip || !S) continue;
      const move = (tr.side === "long" ? tr.px1 - tr.px0 : tr.px0 - tr.px1) / pip;
      if (!(tr.pnl > 0) || move <= 0) { rejected["not profitable"]++; continue; }
      const style = move >= RULES.scalp.minMove && move <= RULES.scalp.maxMove ? "scalp" : move >= RULES.swing.minMove && move <= RULES.swing.maxMove ? "swing" : null;
      if (!style) { rejected["move outside 20-80 / 100-1000 pips"]++; continue; }
      const P = S[style], dd = drawdown(S.fine || [], tr, pip);
      if (!P || dd == null) { rejected["no price history"]++; continue; }
      if (dd > RULES[style].maxDD) { rejected["too much drawdown"]++; continue; }
      const i = indexAt(P.bars, tr.t0) - 1;                    // the last bar fully closed before their entry
      if (i < 60) { rejected["no price history"]++; continue; }
      const f = features2(P, i, tr.side, style); if (!f) continue;
      rows.push({ ticker: tr.ticker, style, side: tr.side, t: tr.t0, f, reasons: reasons(P, i, tr.side), movePips: Math.round(move), ddPips: Math.round(dd), trader: tr.trader });
    }
    return { rows, rejected };
  }
  L.buildDatabase = buildDatabase;
  /** Every past bar (both sides) with the result our plan would have had: the honest base rate around any setup. */
  function baseline(series, ticker, style, step = style === "scalp" ? 2 : 1) {
    const S = series[ticker], P = S && S[style], fine = style === "scalp" ? S && S.fine : S && S.h1, out = [];
    if (!P || !fine) return out;
    const barSec = style === "scalp" ? 900 : 14400;
    for (let i = 60; i < P.bars.length - 1; i += step) for (const side of ["long", "short"]) {
      const f = features2(P, i, side, style); if (!f) continue;
      const pl = planPips(P, i, side, style, ticker), w = walkT(fine, P.bars[i].t + barSec - 1, pl, RULES[style].horizon);
      if (w) out.push({ f, y: w.y, side, t: P.bars[i].t + barSec, tc: w.tc, rr: pl.rr, ticker, style, plan: { side, entry: pl.entry, stop: pl.stop, target: pl.target } });
    }
    return out;
  }
  L.baseline = baseline;
  const dist2 = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += (a[k] - b[k]) ** 2; return Math.sqrt(s); };
  /**
   * Score the current bar. P(TP) = how often the most similar past moments reached TP before SL with this plan.
   * Likeness = how much more the current bar looks like the profitable traders' entries than like an ordinary moment.
   */
  function score(db, base, f, { ticker, k = 40, radius = 2.2, mistakes = [] } = {}) {
    const nb = base.map((e) => ({ e, d: dist2(e.f, f) })).sort((a, b) => a.d - b.d).slice(0, k).filter((x) => x.d <= radius * 1.4);
    let w = 0, s = 0; for (const { e, d } of nb) { const wt = 1 / (0.3 + d); w += wt; s += wt * e.y; }
    const wins = db.map((e) => ({ e, d: dist2(e.f, f) * (e.ticker === ticker ? 0.85 : 1) })), nearW = wins.filter((x) => x.d <= radius && !x.e.demoted).length;
    const nearB = base.filter((e) => dist2(e.f, f) <= radius).length;
    const like = db.length && base.length ? ((nearW + 0.5) / db.length) / ((nearB + 0.5) / base.length) : 0;
    const blocked = mistakes.some((m) => dist2(m.f, f) <= 0.9);
    const top = wins.filter((x) => x.d <= radius).sort((a, b) => a.d - b.d).slice(0, 15);
    const rs = {}; for (const { e } of top) for (const r of e.reasons) rs[r] = (rs[r] || 0) + 1;
    return { p: w ? s / w : null, n: nb.length, like, nearW, blocked, traders: new Set(top.map((x) => x.e.trader)).size, reasons: Object.entries(rs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r, n]) => ({ r, share: n / top.length })) };
  }
  L.score = score;
  /** Which reasons show up more often in the database than in ordinary moments (lift > 1). */
  function reasonStats(rows, style) {
    const xs = rows.filter((r) => r.style === style), c = {};
    for (const r of xs) for (const t of r.reasons) c[t] = (c[t] || 0) + 1;
    return Object.entries(c).map(([r, n]) => ({ r, n, share: n / xs.length })).sort((a, b) => b.n - a.n).slice(0, 8);
  }
  L.reasonStats = reasonStats;
  /** Thresholds; the review after a losing streak tightens them. */
  L.GATE = { minP: 0.55, minLike: 1.5, minN: 20, minNearW: 5 };
  /** A+ = database full, high P(TP) (TP/SL of 2R+ breaks even at 33%), clearly like the winners, not like a past mistake. */
  L.isAplus = (sc, dbCount, style, adj = 0) => dbCount >= RULES[style].need && !sc.blocked && sc.p >= L.GATE.minP + adj && sc.like >= L.GATE.minLike && sc.n >= L.GATE.minN && sc.nearW >= L.GATE.minNearW;
  /** Settle a plan on finer bars: win = TP, loss = SL, timeout closes at market. R and pips both reported. */
  function settlePips(o, bars, pip) {
    if (o.result && o.result !== "open") return o;
    const s = o.side === "long" ? 1 : -1;
    for (const b of bars.filter((x) => x.t >= o.time)) {
      if (s > 0 ? b.l <= o.stop : b.h >= o.stop) return Object.assign(o, { result: "loss", pips: -o.slPips, R: -1, closed: b.t });
      if (s > 0 ? b.h >= o.target : b.l <= o.target) return Object.assign(o, { result: "win", pips: o.tpPips, R: o.rr, closed: b.t });
      if (b.t - o.time > o.horizon) { const pips = Math.round((s * (b.c - o.entry)) / pip); return Object.assign(o, { result: "timeout", pips, R: +(pips / o.slPips).toFixed(2), closed: b.t }); }
    }
    return Object.assign(o, { result: "open" });
  }
  L.settlePips = settlePips;
  /** Three planned losses in a row (by close time) that were not reviewed yet. */
  function losingStreak(plans, reviewed = []) {
    const done = plans.filter((o) => o.result && o.result !== "open").sort((a, b) => a.closed - b.closed), last = done.slice(-3);
    return last.length === 3 && last.every((o) => o.R < 0) && !last.some((o) => reviewed.includes(o.id)) ? last : null;
  }
  L.losingStreak = losingStreak;
  /** Review: remember the losing setups (similar ones are blocked) and demote database entries that pointed to them. */
  function review(streak, db, mistakes) {
    const add = streak.map((o) => ({ id: o.id, f: o.f, style: o.style, ticker: o.ticker, side: o.side, reasons: o.reasons || [], time: o.closed }));
    let demoted = 0;
    for (const m of add) for (const e of db) if (e.style === m.style && !e.demoted && dist2(e.f, m.f) <= 1.2) { e.demoted = true; demoted++; }
    const common = {}; for (const m of add) for (const r of m.reasons) common[r] = (common[r] || 0) + 1;
    return { mistakes: mistakes.concat(add).slice(-60), demoted, common: Object.entries(common).filter(([, n]) => n >= 2).map(([r]) => r) };
  }
  L.review = review;

  if (typeof module !== "undefined" && module.exports) module.exports = L;
  else root.Learner = L;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();
const WL = (function () { const module = { exports: {} };
// TraderGze wallets: read any address on the main chains and turn its history into analytics:
// balances, every recent transaction (in / out, asset, counterparty), daily flows, balance over time, top counterparties.
// Free public sources only: mempool.space / litecoinspace (UTXO), Blockscout (EVM), TronGrid, Solana RPC.
(function (root) {
  "use strict";
  const W = {};
  W.fetch = (...a) => fetch(...a);
  const get = async (url, init) => { const r = await W.fetch(url, Object.assign({ headers: { Accept: "application/json", "User-Agent": "TraderGze/1.0" } }, init)); if (!r.ok) throw new Error(`${new URL(url).host} answered HTTP ${r.status}`); return r.json(); };

  const EVM = { ethereum: ["eth.blockscout.com", "ETH", "Ethereum", "https://etherscan.io"], base: ["base.blockscout.com", "ETH", "Base", "https://basescan.org"], arbitrum: ["arbitrum.blockscout.com", "ETH", "Arbitrum", "https://arbiscan.io"],
    optimism: ["optimism.blockscout.com", "ETH", "Optimism", "https://optimistic.etherscan.io"], polygon: ["polygon.blockscout.com", "POL", "Polygon", "https://polygonscan.com"], gnosis: ["gnosis.blockscout.com", "xDAI", "Gnosis", "https://gnosisscan.io"] };
  const UTXO = { bitcoin: ["https://mempool.space/api", "BTC", "Bitcoin", "https://mempool.space"], litecoin: ["https://litecoinspace.org/api", "LTC", "Litecoin", "https://litecoinspace.org"] };
  W.CHAINS = Object.assign({}, Object.fromEntries(Object.entries(EVM).map(([k, v]) => [k, v[2]])), { bitcoin: "Bitcoin", litecoin: "Litecoin", tron: "Tron", solana: "Solana" });
  W.EXPLORER = Object.assign({}, Object.fromEntries(Object.entries(EVM).map(([k, v]) => [k, v[3]])), { bitcoin: "https://mempool.space", litecoin: "https://litecoinspace.org", tron: "https://tronscan.org/#", solana: "https://solscan.io" });
  W.txUrl = (chain, h) => (chain === "tron" ? `${W.EXPLORER.tron}/transaction/${h}` : `${W.EXPLORER[chain]}/tx/${h}`);
  W.addrUrl = (chain, a) => `${W.EXPLORER[chain]}/${chain === "solana" || chain === "tron" ? "account" : "address"}/${a}`.replace("tronscan.org/#/account", "tronscan.org/#/address");

  /** Which chains an address can be on. EVM addresses are the same on every EVM chain. */
  function detect(a) {
    a = String(a || "").trim();
    if (/^0x[0-9a-fA-F]{40}$/.test(a)) return Object.keys(EVM);
    if (/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return ["tron"];
    if (/^(bc1[02-9ac-hj-np-z]{8,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/.test(a)) return ["bitcoin"];
    if (/^(ltc1[02-9ac-hj-np-z]{8,87}|[LM][1-9A-HJ-NP-Za-km-z]{26,33})$/.test(a)) return ["litecoin"];
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return ["solana"];
    return [];
  }
  W.detect = detect;

  // every reader returns { chain, balances: {SYM: amount}, txs: [{hash, time, dir: "in"|"out"|"self", asset, amount, counterparty, fee?}] }
  async function utxo(chain, a) {
    const [base, sym] = UTXO[chain], info = await get(`${base}/address/${a}`);
    let txs = await get(`${base}/address/${a}/txs`);
    for (let p = 0; p < 3 && txs.length >= 25 * (p + 1); p++) { const more = await get(`${base}/address/${a}/txs/chain/${txs[txs.length - 1].txid}`); if (!more.length) break; txs = txs.concat(more); }
    const c = info.chain_stats, m = info.mempool_stats;
    return { chain, balances: { [sym]: (c.funded_txo_sum - c.spent_txo_sum + m.funded_txo_sum - m.spent_txo_sum) / 1e8 }, txCount: c.tx_count + m.tx_count,
      txs: txs.map((t) => {
        const got = t.vout.filter((o) => o.scriptpubkey_address === a).reduce((s, o) => s + o.value, 0), sent = t.vin.filter((i) => i.prevout && i.prevout.scriptpubkey_address === a).reduce((s, i) => s + i.prevout.value, 0), net = (got - sent) / 1e8;
        const cp = net >= 0 ? (t.vin.find((i) => i.prevout && i.prevout.scriptpubkey_address !== a) || {}).prevout : t.vout.filter((o) => o.scriptpubkey_address && o.scriptpubkey_address !== a).sort((x, y) => y.value - x.value)[0];
        return { hash: t.txid, time: (t.status && t.status.block_time) || Math.floor(Date.now() / 1000), dir: net > 0 ? "in" : net < 0 ? "out" : "self", asset: sym, amount: Math.abs(net), counterparty: (cp && cp.scriptpubkey_address) || null, pending: !(t.status && t.status.confirmed) };
      }) };
  }
  async function evm(chain, a) {
    const host = `https://${EVM[chain][0]}/api/v2/addresses/${a}`, sym = EVM[chain][1], lc = a.toLowerCase();
    const [info, txs, tts, toks] = await Promise.all([get(host), get(host + "/transactions").catch(() => ({ items: [] })), get(host + "/token-transfers").catch(() => ({ items: [] })), get(host + "/token-balances").catch(() => [])]);
    const bal = { [sym]: Number(info.coin_balance || 0) / 1e18 };
    for (const t of Array.isArray(toks) ? toks : []) { const tk = t.token || {}, d = Number(tk.decimals || 18), v = Number(t.value || 0) / 10 ** d; if (v > 0 && tk.symbol && (tk.exchange_rate || /USD|DAI|BTC|ETH/i.test(tk.symbol))) bal[tk.symbol] = v; }
    const list = [];
    for (const t of txs.items || []) { const v = Number(t.value || 0) / 1e18, from = ((t.from || {}).hash || "").toLowerCase(), to = ((t.to || {}).hash || "").toLowerCase(); if (!v && t.method) continue; list.push({ hash: t.hash, time: Math.floor(Date.parse(t.timestamp) / 1000), dir: from === lc && to === lc ? "self" : from === lc ? "out" : "in", asset: sym, amount: v, counterparty: from === lc ? to : from }); }
    for (const t of tts.items || []) {
      const tk = t.token || {}, tot = t.total || {}, d = Number(tot.decimals || tk.decimals || 18), v = Number(tot.value || 0) / 10 ** d, from = ((t.from || {}).hash || "").toLowerCase(), to = ((t.to || {}).hash || "").toLowerCase();
      if (!tk.symbol || !isFinite(v) || tk.type === "ERC-721" || tk.type === "ERC-1155") continue;
      list.push({ hash: t.transaction_hash || t.tx_hash, time: Math.floor(Date.parse(t.timestamp) / 1000), dir: from === lc ? "out" : "in", asset: tk.symbol, amount: v, counterparty: from === lc ? to : from });
    }
    return { chain, balances: bal, txCount: info.transactions_count != null ? Number(info.transactions_count) : null, txs: list };
  }
  async function tron(a) {
    const acc = ((await get(`https://api.trongrid.io/v1/accounts/${a}`)).data || [])[0] || {}, bal = { TRX: (acc.balance || 0) / 1e6 };
    for (const t of acc.trc20 || []) for (const [k, v] of Object.entries(t)) if (k === "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t") bal.USDT = Number(v) / 1e6; else if (k === "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8") bal.USDC = Number(v) / 1e6;
    const tx = await get(`https://api.trongrid.io/v1/accounts/${a}/transactions/trc20?limit=100`).catch(() => ({ data: [] }));
    return { chain: "tron", balances: bal, txs: (tx.data || []).map((t) => ({ hash: t.transaction_id, time: Math.floor(t.block_timestamp / 1000), dir: t.from === a ? "out" : "in", asset: (t.token_info || {}).symbol || "TRC20", amount: Number(t.value) / 10 ** Number((t.token_info || {}).decimals || 6), counterparty: t.from === a ? t.to : t.from })) };
  }
  const SOL = "https://api.mainnet-beta.solana.com";
  const srpc = (method, params) => get(SOL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
  async function solana(a) {
    const [b, sigs, toks] = await Promise.all([srpc("getBalance", [a]), srpc("getSignaturesForAddress", [a, { limit: 40 }]), srpc("getTokenAccountsByOwner", [a, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] }))]);
    const bal = { SOL: (b.value || 0) / 1e9 }, MINTS = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT" };
    for (const t of toks.value || []) { const i = t.account.data.parsed.info, s = MINTS[i.mint]; if (s) bal[s] = (bal[s] || 0) + Number(i.tokenAmount.uiAmount || 0); }
    const txs = [];
    for (const s of sigs.slice(0, 20)) {
      try {
        const t = await srpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]); if (!t) continue;
        const keys = t.transaction.message.accountKeys.map((k) => k.pubkey || k), i = keys.indexOf(a), d = i >= 0 ? (t.meta.postBalances[i] - t.meta.preBalances[i]) / 1e9 : 0;
        const tok = {}; for (const x of t.meta.preTokenBalances || []) if (x.owner === a && MINTS[x.mint]) tok[MINTS[x.mint]] = -Number(x.uiTokenAmount.uiAmount || 0);
        for (const x of t.meta.postTokenBalances || []) if (x.owner === a && MINTS[x.mint]) tok[MINTS[x.mint]] = (tok[MINTS[x.mint]] || 0) + Number(x.uiTokenAmount.uiAmount || 0);
        const cp = keys.find((k, j) => j !== i && j > 0 && !/1111111111|Token|Compute|Program/.test(k)) || null;
        for (const [sym, v] of Object.entries(tok)) if (Math.abs(v) > 1e-9) txs.push({ hash: s.signature, time: s.blockTime, dir: v > 0 ? "in" : "out", asset: sym, amount: Math.abs(v), counterparty: cp });
        if (Math.abs(d) > 0.00001) txs.push({ hash: s.signature, time: s.blockTime, dir: d > 0 ? "in" : "out", asset: "SOL", amount: Math.abs(d), counterparty: cp });
      } catch {}
    }
    return { chain: "solana", balances: bal, txs };
  }
  async function readChain(chain, a) { if (UTXO[chain]) return utxo(chain, a); if (EVM[chain]) return evm(chain, a); if (chain === "tron") return tron(a); if (chain === "solana") return solana(a); throw new Error("unknown chain " + chain); }
  W.readChain = readChain;

  const STABLE = /^(USDT|USDC|DAI|FDUSD|PYUSD|USDE|USDC\.E|BUSD|TUSD|USDS)$/i;
  /** USD value of an amount when it can be known (stablecoins 1:1, BTC / ETH / SOL… from prices). */
  const usdOf = (asset, amount, px) => (STABLE.test(asset) ? amount : px && px[asset.toUpperCase()] ? amount * px[asset.toUpperCase()] : null);
  W.usdOf = usdOf;
  /** Raw chain reads -> analytics the app draws. */
  function analyze(reads, px = {}) {
    const txs = reads.flatMap((r) => r.txs.map((t) => Object.assign({ chain: r.chain }, t, { usd: usdOf(t.asset, t.amount, px) }))).filter((t) => t.time).sort((a, b) => b.time - a.time);
    const balances = []; for (const r of reads) for (const [k, v] of Object.entries(r.balances)) if (v > 0) balances.push({ chain: r.chain, asset: k, amount: v, usd: usdOf(k, v, px) });
    const day = (t) => Math.floor(t / 86400) * 86400, now = Math.floor(Date.now() / 1000), d0 = day(now) - 29 * 86400;
    const daily = Array.from({ length: 30 }, (_, i) => ({ t: d0 + i * 86400, in: 0, out: 0, n: 0 }));
    for (const t of txs) { const b = daily[(day(t.time) - d0) / 86400]; if (b && t.usd != null) { b[t.dir === "in" ? "in" : "out"] += t.dir === "self" ? 0 : t.usd; b.n++; } else if (b) b.n++; }
    const cps = {}; for (const t of txs) if (t.counterparty) { const c = (cps[t.counterparty] = cps[t.counterparty] || { address: t.counterparty, chain: t.chain, in: 0, out: 0, n: 0 }); c.n++; if (t.usd != null) c[t.dir === "in" ? "in" : "out"] += t.usd; }
    // balance over time for the main coin of each chain, walking back from today's balance
    const curves = reads.filter((r) => UTXO[r.chain] || r.chain === "solana" || EVM[r.chain]).map((r) => {
      const sym = Object.keys(r.balances)[0], cur = r.balances[sym] || 0, xs = r.txs.filter((t) => t.asset === sym).sort((a, b) => b.time - a.time);
      let b = cur; const pts = [[now, cur]]; for (const t of xs) { pts.push([t.time, b]); b -= t.dir === "in" ? t.amount : t.dir === "out" ? -t.amount : 0; pts.push([t.time - 1, Math.max(0, b)]); }
      return { chain: r.chain, asset: sym, pts: pts.reverse() };
    }).filter((c) => c.pts.length > 2);
    const byAsset = {}; for (const t of txs) { const k = t.asset, o = (byAsset[k] = byAsset[k] || { asset: k, in: 0, out: 0, n: 0 }); o.n++; o[t.dir === "in" ? "in" : "out"] += t.dir === "self" ? 0 : t.amount; }
    const known = txs.filter((t) => t.usd != null);
    return { txs: txs.slice(0, 200), balances: balances.sort((a, b) => (b.usd || 0) - (a.usd || 0)), totalUsd: balances.reduce((s, b) => s + (b.usd || 0), 0), daily, counterparties: Object.values(cps).sort((a, b) => b.in + b.out - (a.in + a.out) || b.n - a.n).slice(0, 10), curves, byAsset: Object.values(byAsset).sort((a, b) => b.n - a.n),
      summary: { txs: txs.length, first: txs.length ? txs[txs.length - 1].time : null, last: txs.length ? txs[0].time : null, inUsd: known.filter((t) => t.dir === "in").reduce((s, t) => s + t.usd, 0), outUsd: known.filter((t) => t.dir === "out").reduce((s, t) => s + t.usd, 0) } };
  }
  W.analyze = analyze;
  /** Read an address on every chain it can be on (EVM: all six), keep chains with activity. */
  async function inspect(address, chain, px) {
    const chains = Array.isArray(chain) && chain.length ? chain : chain && chain !== "auto" ? [chain] : detect(address);
    if (!chains.length) throw new Error("Unrecognised address. Supported: Bitcoin, Litecoin, Ethereum, Base, Arbitrum, Optimism, Polygon, Gnosis, Tron, Solana.");
    const reads = [], errors = [];
    await Promise.all(chains.map(async (c) => { try { const r = await readChain(c, address); if (chains.length === 1 || r.txs.length || Object.values(r.balances).some((v) => v > 0)) reads.push(r); } catch (e) { errors.push(`${W.CHAINS[c]}: ${e.message}`); } }));
    return Object.assign({ address, chains: reads.map((r) => r.chain), errors }, analyze(reads, px));
  }
  W.inspect = inspect;

  if (typeof module !== "undefined" && module.exports) module.exports = W;
  else root.Wallets = W;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();
const BL = (function () { const module = { exports: {} };
// TraderGze agent lab: learning agents. Each agent is a 0/1 classifier (logistic regression: will this plan hit TP before
// SL?) on a chosen set of chart features, with its own confidence bar and position management. Agents are tested
// walk-forward (learn from the past, trade the unseen future), evolve every hour, paper-trade live, and learn from losses.
(function (root) {
  "use strict";
  const B = {};

  // ---------------------------------------------------------------- the classifier
  /** Logistic regression with L2 and per-sample weights. X: rows of numbers, y: 0/1. Returns {w, b, mu, sd}. */
  function train(X, y, { lambda = 0.01, iters = 80, lr = 0.5, weights = null } = {}) {
    const n = X.length, m = n ? X[0].length : 0, mu = new Array(m).fill(0), sd = new Array(m).fill(0);
    for (const x of X) for (let j = 0; j < m; j++) mu[j] += x[j] / n;
    for (const x of X) for (let j = 0; j < m; j++) sd[j] += (x[j] - mu[j]) ** 2 / n;
    for (let j = 0; j < m; j++) sd[j] = Math.sqrt(sd[j]) || 1;
    const Z = X.map((x) => x.map((v, j) => (v - mu[j]) / sd[j]));
    let w = new Array(m).fill(0), b = 0;
    const W = weights || new Array(n).fill(1), sw = W.reduce((s, v) => s + v, 0) || 1;
    for (let it = 0; it < iters; it++) {
      const gw = new Array(m).fill(0); let gb = 0;
      for (let i = 0; i < n; i++) {
        let z = b; for (let j = 0; j < m; j++) z += w[j] * Z[i][j];
        const e = (1 / (1 + Math.exp(-z)) - y[i]) * W[i];
        for (let j = 0; j < m; j++) gw[j] += e * Z[i][j];
        gb += e;
      }
      for (let j = 0; j < m; j++) w[j] -= lr * (gw[j] / sw + lambda * w[j]);
      b -= lr * (gb / sw);
    }
    return { w, b, mu, sd };
  }
  /** Train an agent and set its cut: the score of its top (1 - q - bump) setups on the data it learned from. */
  function fit(g, tr) {
    const M = train(tr.map((s) => sel(g, s.f)), tr.map((s) => s.y), { lambda: g.lambda, weights: tr.map((s) => s.w || 1) });
    const step = Math.max(1, Math.ceil(tr.length / 4000)), ps = tr.filter((_, i) => i % step === 0).map((s) => predict(M, sel(g, s.f))).sort((a, b) => a - b);
    const q = Math.min(0.998, (g.q != null ? g.q : 0.95) + (g.bump || 0));
    M.cut = ps[Math.min(ps.length - 1, Math.floor(ps.length * q))]; M.base = tr.reduce((s, x) => s + x.y, 0) / tr.length;
    return M;
  }
  const predict = (M, x) => { let z = M.b; for (let j = 0; j < M.w.length; j++) z += M.w[j] * ((x[j] - M.mu[j]) / M.sd[j]); return 1 / (1 + Math.exp(-z)); };
  Object.assign(B, { train, predict, fit });

  // ---------------------------------------------------------------- agents (genomes)
  // Two kinds: "rule" agents follow your pip rules (SL <= 10 / TP 20 scalps, SL <= 70 / TP 100 swings) and the Elite levels;
  // "free" agents have no rules: any timeframe, any stop/target size (in ATRs), any risk, any number of trades. Both start with $500.
  const NF = 24;
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  B.seed = (s) => (seed = s || 1);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const TICKERS = ["BTC", "GOLD", "SILVER"], STYLES = ["scalp5", "scalp", "h1", "swing"];
  B.START = 500;
  // selectivity: an agent trades only its top (1 - q) most confident setups, measured on what it learned from
  const Q = [0.9, 0.93, 0.95, 0.97, 0.98, 0.99], QF = [0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99];
  /** Free agents' stop / target in ATRs of their timeframe. */
  const PRESETS = [[0.5, 0.5], [0.5, 1], [1, 1], [0.5, 2], [1, 2], [1, 3], [2, 2], [2, 4], [1.5, 4.5], [3, 6]];
  B.PRESETS = PRESETS;
  const RISK = [0.5, 1, 2, 3], RISKF = [1, 2, 5, 10, 15, 20, 30];
  /** Older agents: fixed confidence bar -> selectivity; 16 features -> 24; no capital -> $500 and a risk %. */
  B.upgrade = (g) => {
    if (g.q == null) { g.q = pick(Q); g.bump = 0; } if (g.minLike > 1) g.minLike = 1; delete g.theta;
    while (g.mask.length < NF) g.mask.push(rnd() < 0.4);
    if (!g.kind) g.kind = "rule";
    if (g.riskPct == null) g.riskPct = g.kind === "free" ? pick(RISKF) : pick(RISK);
    return g;
  };
  function randomGenome(id, kind = "rule", style) {
    const mask = Array.from({ length: NF }, () => rnd() < 0.45); if (!mask.some(Boolean)) mask[4] = true;
    const tick = TICKERS.filter(() => rnd() < 0.6); if (!tick.length) tick.push(pick(TICKERS));
    const g = { id, kind, style: style || pick(STYLES), tickers: tick, mask, lambda: pick([0.001, 0.01, 0.05, 0.2]), q: kind === "free" ? pick(QF) : pick(Q), minLike: kind === "free" ? 0 : pick([0, 0, 0, 1]),
      riskPct: kind === "free" ? pick(RISKF) : pick(RISK), mgmt: { partial: rnd() < 0.5, breakeven: rnd() < 0.5, add: rnd() < 0.3 }, gen: 0, parent: null, bump: 0 };
    if (kind === "free") { g.preset = Math.floor(rnd() * PRESETS.length); g.maxPerDay = pick([2, 5, 10, 20, 50]); }
    return g;
  }
  /**
   * hints: importance of each of the 24 inputs among the best agents (0..1). Changes then favour switching ON inputs
   * that work for winners and switching OFF inputs that don't, instead of flipping at random.
   */
  function flip(c, hints) {
    if (!hints) { const j = Math.floor(rnd() * NF); c.mask[j] = !c.mask[j]; return; }
    const on = rnd() < 0.5, cand = c.mask.map((m, j) => j).filter((j) => c.mask[j] !== on), w = cand.map((j) => (on ? 0.05 + hints[j] : 1.05 - hints[j]));
    let r = rnd() * w.reduce((s, x) => s + x, 0); for (let k = 0; k < cand.length; k++) { r -= w[k]; if (r <= 0) { c.mask[cand[k]] = on; return; } }
  }
  function mutate(g, id, gen, style, hints) {
    const c = B.upgrade(JSON.parse(JSON.stringify(g))); c.id = id; c.parent = g.id; c.gen = gen; c.bump = 0; delete c.state; delete c.capital; delete c.busted; delete c.btTrades; delete c.cash; delete c.btCap;
    const flips = 1 + Math.floor(rnd() * 3); for (let k = 0; k < flips; k++) flip(c, hints);
    if (!c.mask.some(Boolean)) c.mask[Math.floor(rnd() * NF)] = true;
    if (c.kind === "free") {
      if (rnd() < 0.5) c.q = pick(QF);
      if (rnd() < 0.3) c.preset = Math.floor(rnd() * PRESETS.length);
      if (rnd() < 0.3) c.riskPct = pick(RISKF);
      if (rnd() < 0.3) c.maxPerDay = pick([2, 5, 10, 20, 50]);
      if (rnd() < 0.15) c.style = pick(STYLES);
    } else {
      if (rnd() < 0.6) c.q = +Math.min(0.995, Math.max(0.85, c.q + (rnd() - 0.5) * 0.04)).toFixed(3);
      if (rnd() < 0.3) c.minLike = pick([0, 0, 0, 1]);
      if (rnd() < 0.2) c.riskPct = pick(RISK);
    }
    if (style) c.style = style;
    if (rnd() < 0.3) c.lambda = pick([0.001, 0.01, 0.05, 0.2]);
    if (rnd() < 0.3) { const k = pick(["partial", "breakeven", "add"]); c.mgmt[k] = !c.mgmt[k]; }
    if (rnd() < 0.2) { const t = pick(TICKERS); c.tickers = c.tickers.includes(t) && c.tickers.length > 1 ? c.tickers.filter((x) => x !== t) : [...new Set(c.tickers.concat(t))]; }
    return c;
  }
  /** Crossover: a child takes each input, setting and management choice from one of two parents, then a small change. */
  function crossover(a, b, id, gen, style, hints) {
    const c = B.upgrade(JSON.parse(JSON.stringify(a))), x = B.upgrade(JSON.parse(JSON.stringify(b)));
    c.mask = c.mask.map((m, j) => (rnd() < 0.5 ? m : x.mask[j])); if (!c.mask.some(Boolean)) c.mask[Math.floor(rnd() * NF)] = true;
    for (const k of ["lambda", "q", "minLike", "riskPct", "preset", "maxPerDay"]) if (x[k] !== undefined && rnd() < 0.5) c[k] = x[k];
    for (const k of ["partial", "breakeven", "add"]) if (rnd() < 0.5) c.mgmt[k] = x.mgmt[k];
    if (rnd() < 0.5) c.tickers = x.tickers.slice();
    if (rnd() < 0.5 && !style) c.style = x.style;
    const child = mutate(c, id, gen, style, hints); child.parent = a.id; child.parent2 = b.id;
    return child;
  }
  /** Near-copies share a signature: same timeframe, markets, plan and nearly the same inputs (inputs rounded to groups of 4). */
  B.signature = (g) => [g.kind, g.style, g.tickers.slice().sort().join("/"), g.preset || 0, g.mask.reduce((s, m, j) => s + (m ? 1 << (j % 30) : 0), 0) >> 2].join("|");
  Object.assign(B, { randomGenome, mutate, crossover, TICKERS, STYLES });
  const sel = (g, f) => f.filter((_, j) => g.mask[j]);
  B.sel = sel;
  /** The plan a free agent uses: stop and target in ATRs from the entry. */
  B.freePlan = (g, s) => { const [k1, k2] = PRESETS[g.preset || 0], d = s.side === "long" ? 1 : -1; return { side: s.side, entry: s.c, stop: s.c - d * k1 * s.a, target: s.c + d * k2 * s.a, rr: k2 / k1 }; };

  // ---------------------------------------------------------------- position management, simulated on fine bars
  /**
   * One paper trade from time t. plan: {side, entry, stop, target, risk}. mgmt:
   * partial = close half at halfway to TP; breakeven = then move the stop to entry; add = add one unit at half the stop distance.
   * Returns {R (in units of the first position's risk), tc, events: [{t, kind, px}]}, or {open: true, events} while still running.
   */
  function simulate(bars, t, plan, mgmt = {}, horizon = 86400) {
    const s = plan.side === "long" ? 1 : -1, risk = Math.abs(plan.entry - plan.stop);
    let size = 1, avg = plan.entry, stop = plan.stop, R = 0, halfDone = false, added = false; const ev = [];
    const half = plan.entry + s * Math.abs(plan.target - plan.entry) / 2, addAt = plan.entry - s * risk / 2;
    for (const b of bars) {
      if (b.t <= t) continue;
      const worst = s > 0 ? b.l : b.h, best = s > 0 ? b.h : b.l;
      if (mgmt.add && !added && (s > 0 ? worst <= addAt : worst >= addAt) && (s > 0 ? worst > stop : worst < stop)) { avg = (avg * size + addAt) / (size + 1); size += 1; added = true; ev.push({ t: b.t, kind: "added", px: addAt }); }
      if (s > 0 ? worst <= stop : worst >= stop) { R += (size * s * (stop - avg)) / risk; ev.push({ t: b.t, kind: "stop", px: stop }); return { R: +R.toFixed(3), tc: b.t, events: ev }; }
      if (mgmt.partial && !halfDone && (s > 0 ? best >= half : best <= half)) { R += ((size / 2) * s * (half - avg)) / risk; size /= 2; halfDone = true; ev.push({ t: b.t, kind: "partial", px: half }); if (mgmt.breakeven) stop = avg; }
      if (s > 0 ? best >= plan.target : best <= plan.target) { R += (size * s * (plan.target - avg)) / risk; ev.push({ t: b.t, kind: "target", px: plan.target }); return { R: +R.toFixed(3), tc: b.t, events: ev }; }
      if (b.t - t > horizon) { R += (size * s * (b.c - avg)) / risk; ev.push({ t: b.t, kind: "time", px: b.c }); return { R: +R.toFixed(3), tc: b.t, events: ev }; }
    }
    return { R: null, open: true, events: ev };
  }
  B.simulate = simulate;

  // ---------------------------------------------------------------- results
  function metrics(trades) {
    const xs = trades.slice().sort((a, b) => a.tc - b.tc);
    let cum = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0; const curve = [];
    for (const x of xs) { cum += x.R; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); streak = x.R <= 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); curve.push([x.tc, +cum.toFixed(2)]); }
    const w = xs.filter((x) => x.R > 0), l = xs.filter((x) => x.R <= 0), gw = w.reduce((s, x) => s + x.R, 0), gl = -l.reduce((s, x) => s + x.R, 0);
    return { trades: xs.length, wins: w.length, winRate: xs.length ? w.length / xs.length : null, totalR: +cum.toFixed(2), profitFactor: gl > 0 ? gw / gl : w.length ? Infinity : null, maxDD: +dd.toFixed(2), maxLossStreak: maxStreak, curve };
  }
  B.metrics = metrics;
  /** Paper capital: $500 start, each trade risks riskPct of current equity (compounding). */
  function capital(trades, riskPct, start = B.START) {
    const xs = trades.slice().sort((a, b) => a.tc - b.tc);
    let eq = start, peak = start, dd = 0; const curve = [];
    for (const x of xs) { eq = Math.min(1e12, Math.max(0, eq * (1 + (x.R * riskPct) / 100))); peak = Math.max(peak, eq); dd = Math.max(dd, peak ? (peak - eq) / peak : 0); curve.push([x.tc, +eq.toFixed(2)]); }
    const days = xs.length ? Math.max(1, (xs[xs.length - 1].tc - xs[0].t) / 86400) : 1;
    return { start, equity: +eq.toFixed(2), roi: eq / start - 1, roiPerDay: (eq / start - 1) / days, maxDDPct: dd, days: +days.toFixed(1), busted: eq < 25, curve };
  }
  B.capital = capital;
  /** Free agents: only money matters, and how fast. */
  B.freeFitness = (c, trades) => (!c || trades < 5 ? -1 + Math.min(0.5, (trades || 0) / 20) : c.busted ? -5 : Math.min(50, (Math.log(Math.max(c.equity, 1) / c.start) / Math.max(1, c.days)) * 100));
  /** One number to rank agents: win rate and profit, punished by drawdown and losing streaks; needs enough trades. */
  B.fitness = (m, minTrades = 25) => !m || m.trades < minTrades || m.totalR <= 0 ? -1 + (m ? Math.min(0.5, m.trades / 200) : 0) : m.winRate * 2 + Math.min(isFinite(m.profitFactor) ? m.profitFactor : 5, 5) * 0.3 + Math.log1p(m.totalR) * 0.3 - m.maxDD * 0.05 - Math.max(0, m.maxLossStreak - 2) * 0.4;
  /** What counts as an edge (backtest) and as confirmed (live paper). */
  B.GOALS = { edge: { trades: 30, winRate: 0.75, pf: 2, maxDD: 6, maxLossStreak: 2 }, live: null,
    elite: { trades: 60, winRate: 0.85, pf: 2, maxDD: 6, maxLossStreak: 2 }, eliteLive: { trades: 100, winRate: 0.85, pf: 2, maxDD: 6, maxLossStreak: 2 } };
  const pass = (m, G) => !!m && m.trades >= G.trades && m.winRate >= G.winRate && m.profitFactor >= G.pf && m.maxDD <= G.maxDD && m.maxLossStreak <= G.maxLossStreak && m.totalR > 0;
  /** Elite Edge: unseen-data test. Elite Live: live paper trading. */
  B.isElite = (m) => pass(m, B.GOALS.elite);
  B.isEliteLive = (m) => pass(m, B.GOALS.eliteLive);
  /** Ratings by R earned: the top third High, the middle third Medium, the rest Low. list: [{id, R}] */
  B.rate = (list) => { const xs = list.slice().sort((a, b) => b.R - a.R), n = xs.length, out = {}; xs.forEach((x, i) => (out[x.id] = n < 3 ? (i === 0 ? "High" : i === 1 ? "Medium" : "Low") : i < Math.ceil(n / 3) ? "High" : i < Math.ceil((2 * n) / 3) ? "Medium" : "Low")); return out; };
  B.isEdge = (m) => m && m.trades >= B.GOALS.edge.trades && m.winRate >= B.GOALS.edge.winRate && m.profitFactor >= B.GOALS.edge.pf && m.maxDD <= B.GOALS.edge.maxDD && m.maxLossStreak <= B.GOALS.edge.maxLossStreak;
  B.isConfirmed = () => false;                 // the 20-trade "confirmed" level was removed

  // ---------------------------------------------------------------- walk-forward backtest
  const CAP = { scalp5: 8, scalp: 8, h1: 6, swing: 4 };       // trades a day per rule agent (raised to reach 100 live trades sooner)
  B.CAP = CAP;
  /**
   * samples: [{t, tc, f, y, rr, side, ticker, style, like?, i?}] sorted by t. fine[ticker] = bars for simulating management.
   * Trains on what was known before each test segment (closed before it started), trades the segment, moves on.
   */
  const HORIZON = { scalp5: 6 * 3600, scalp: 86400, h1: 2 * 86400, swing: 10 * 86400 };
  B.HORIZON = HORIZON;
  /**
   * label(s) -> {y, rr, tc, plan} gives the outcome of the agent's own plan (free agents); rule agents use the pip plan in the sample.
   */
  function backtest(g, samples, fine, { folds = 5, maxTrain = 12000, extra = [], label = null } = {}) {
    const xs = samples.filter((s) => s.style === g.style && g.tickers.includes(s.ticker));
    if (xs.length < 400) return { metrics: metrics([]), trades: [] };
    const L = label || ((s) => s), cap = g.kind === "free" ? g.maxPerDay || 10 : CAP[g.style] || 4;
    const t0 = xs[0].t, t1 = xs[xs.length - 1].t, start = t0 + (t1 - t0) * 0.4, seg = (t1 - start) / folds, trades = [];
    for (let k = 0; k < folds; k++) {
      const a = start + k * seg, z = a + seg, past = xs.filter((s) => s.tc < a), step = Math.max(1, Math.ceil(past.length / maxTrain));
      const tr = past.filter((_, i) => i % step === 0).map((s) => { const o = L(s); return o ? { f: s.f, y: o.y, w: s.w || 1 } : null; }).filter(Boolean).concat(extra.filter((e) => e.tc < a));
      if (tr.length < 200) continue;
      const M = fit(g, tr);
      const busy = {}, perDay = {};
      for (const s of xs) {
        if (s.t < a || s.t >= z) continue;
        if (busy[s.ticker] && s.t < busy[s.ticker]) continue;
        const day = Math.floor(s.t / 86400); if ((perDay[day] || 0) >= cap) continue;
        if (g.minLike && (s.like || 0) < g.minLike) continue;
        const p = predict(M, sel(g, s.f)); if (p < M.cut) continue;
        const o = L(s); if (!o) continue;
        let R = o.y ? o.rr : -1, tc = o.tc;
        if ((g.mgmt.partial || g.mgmt.add) && o.plan && fine[s.ticker]) { const r = simulate(fine[s.ticker], s.t, o.plan, g.mgmt, HORIZON[g.style]); if (r.open) continue; R = r.R; tc = r.tc; }
        trades.push({ t: s.t, tc, R, p, side: s.side, ticker: s.ticker, f: s.f }); busy[s.ticker] = tc; perDay[day] = (perDay[day] || 0) + 1;
      }
    }
    return { metrics: metrics(trades), trades };
  }
  B.backtest = backtest;

  // ---------------------------------------------------------------- the edge, in words
  const SAY = {
    "vs EMA20": ["price stretched in the trade's direction from EMA20", "price at or against EMA20 (a pullback)"], "vs EMA50": ["on the trade's side of EMA50", "near or against EMA50"],
    "EMA20 vs 50": ["fast trend (EMA20 vs EMA50) already with the trade", "before the fast trend turns"], "vs EMA200": ["with the 200 EMA trend", "against the 200 EMA trend"], RSI: ["RSI with the trade", "RSI stretched against the trade (buy dips / sell rips)"],
    "vs VWAP": ["on the trade's side of VWAP", "at or through VWAP"], "in 20-bar range": ["near the top of the range for longs / bottom for shorts (breakout)", "from the opposite end of the range (reversal)"], volatility: ["volatility expanding", "volatility quiet"],
    "5-bar momentum": ["after a push in the trade's direction", "after a pullback against the trade"], "hour (sin)": ["at certain hours of the day", "at certain hours of the day"], "hour (cos)": ["at certain hours of the day", "at certain hours of the day"],
    "relative volume": ["on above-average volume", "on quiet volume"], "order flow (5 bars)": ["buyers in control for longs / sellers for shorts (order-flow estimate)", "after the other side was in control (absorption)"], funding: ["funding against the crowd (crowded other side)", "funding with the crowd"],
    "higher-timeframe trend": ["with the higher-timeframe trend", "against the higher-timeframe trend"],
    "Bollinger z-score": ["stretched beyond the Bollinger mean in the trade's direction (momentum)", "stretched against the trade from the Bollinger mean (mean reversion)"], "RSI(2)": ["short-term RSI(2) with the trade", "RSI(2) extreme against the trade (Connors pullback)"],
    "55-bar breakout": ["breaking a 55-bar high/low with the trade (Turtle breakout)", "breaking the opposite 55-bar extreme (fade)"], "MACD histogram": ["MACD momentum turning with the trade", "MACD momentum against the trade"],
    "time-series momentum": ["the last 48 bars trending with the trade (time-series momentum)", "the last 48 bars against the trade (reversal)"], "beyond prior-day high/low": ["through the prior day's high/low with the trade", "inside / short of the prior day's range"],
    "opening-range breakout": ["beyond the first hour's range with the trade (opening-range breakout)", "back inside the opening range"], "Keltner breakout": ["outside the Keltner band with the trade (volatility breakout)", "inside the Keltner band"], "candle close location": ["candle closing strong in the trade's direction", "candle closing weak (wick)"],
  };
  /** The model's strongest drivers as plain rules. names = feature names (all 16). */
  function explain(g, M, names) {
    const used = names.filter((_, j) => g.mask[j]);
    return used.map((n, j) => ({ n, w: M.w[j] })).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 4).map((x) => ({ feature: x.n, weight: +x.w.toFixed(2), rule: (SAY[x.n] || [x.n, x.n])[x.w > 0 ? 0 : 1] }));
  }
  B.explain = explain;
  const STYLE_NAME = { scalp5: "Scalp 5m", scalp: "Scalp 15m", h1: "Intraday 1h", swing: "Swing 4h" };
  B.STYLE_NAME = STYLE_NAME;
  B.describe = (g) => g.kind === "council" ? "COUNCIL · trades only when at least 3 of the 10 best rule agents of a timeframe agree on a side and none disagree · your pip rules · risks 1% a trade on BTC, GOLD, SILVER" : (g.kind === "free" ? `FREE agent · ${STYLE_NAME[g.style]} · SL ${PRESETS[g.preset || 0][0]} ATR / TP ${PRESETS[g.preset || 0][1]} ATR · risks ${g.riskPct}% a trade · up to ${g.maxPerDay} trades a day` : `${STYLE_NAME[g.style]} (${g.style === "swing" ? "SL ≤ 70 pips, TP 100" : "SL ≤ 10 pips, TP 20"}) · risks ${g.riskPct}% a trade`) + ` on ${g.tickers.join(", ")} · takes only its top ${+((1 - Math.min(0.998, g.q + (g.bump || 0))) * 100).toFixed(1)}% most confident setups${g.minLike ? ` and at least ${g.minLike} profitable human entr${g.minLike > 1 ? "ies look" : "y looks"} like it` : ""}${g.mgmt.partial ? " · takes half profit halfway" : ""}${g.mgmt.breakeven && g.mgmt.partial ? " then moves SL to entry" : ""}${g.mgmt.add ? " · adds once on a pullback" : ""}`;

  if (typeof module !== "undefined" && module.exports) module.exports = B;
  else root.Lab = B;
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

const liveUsers = new Map();                          // addresses seen in big Hyperliquid BTC trades
function broadcast(kind, data) { const line = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of clients) c.write(line); }
function addEvents(list) {
  for (const e of list) {
    if (!insEvent.run(e.id, e.time, e.chain, e.asset, e.type, e.bias, e.usd || 0, JSON.stringify(e)).changes) continue;
    stats.events++;
    recent.push(e); if (recent.length > 1000) recent.shift();
    broadcast("transfer", e);
    if (X.STABLES.includes(e.asset)) learnFromStable(e);
    if (e.chain === "hyperliquid" && e.users) for (const u of e.users) liveUsers.set(u.toLowerCase(), (liveUsers.get(u.toLowerCase()) || 0) + 1);
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
  if (process.env.ANOMALIES !== "on") return;               // the anomaly agent is switched off (set ANOMALIES=on to bring it back)
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
    const assets = asset === "BTC" ? ["BTC"] : X.STABLES;
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
const cache = { holders: null, perps: null, macro: null, traders: null, agents: null, lb: null };
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
      const lbRaw = await X.hlLeaderboard();
      cache.lb = X.topTraders(lbRaw, "month", 1e6).filter((t) => t.pnl > 0);     // every profitable trader, small accounts too
      const top = cache.lb.slice(0, 30);
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
// background jobs: each one runs on its own clock, never twice at the same time, and reports what it is doing (/jobs)
const jobs = {};
const every = (ms, fn, name = fn.name || "job") => {
  const j = (jobs[name] = { name, every: ms, runs: 0, running: false, started: null, finished: null, took: null, error: null });
  const run = () => {
    if (j.running) { j.skipped = (j.skipped || 0) + 1; return; }
    j.running = true; j.started = Date.now();
    Promise.resolve().then(fn).then(() => (j.error = null), (e) => { j.error = e.message; log(`job ${name} failed:`, e.message); })
      .finally(() => { j.running = false; j.finished = Date.now(); j.took = j.finished - j.started; j.runs++; });
  };
  run(); return setInterval(run, ms);
};
function jobsText() {
  const now = Date.now(), m = (ms) => (ms == null ? "—" : ms < 60e3 ? Math.round(ms / 1000) + "s" : Math.round(ms / 60e3) + "m");
  const q = AG.queue || { hi: [], lo: [] };
  return "Server jobs right now:\n" + Object.values(jobs).map((j) => `${j.running ? "⏳" : j.error ? "⚠️" : "✅"} ${j.name}: ${j.running ? `running for ${m(now - j.started)}` : `last ran ${m(now - (j.finished || now))} ago, took ${m(j.took)}`}${j.error ? ` · error: ${j.error}` : ""}`).join("\n") +
    `\n\nHyperliquid queue: ${q.hi.length} urgent, ${q.lo.length} background · budget left ${Math.round((AG.limiter || {}).tokens || 0)}/min\nMemory: ${Math.round(process.memoryUsage().rss / 1e6)} MB · up ${m(now - stats.started)}`;
}

// ---------------------------------------------------------------- top human traders: rank by real closed trades, alert on followed ones
// traders are ranked per ticker: BTC; XYZ100, SPCX, S&P500 (stocks tab); WTIOIL, GOLD, SILVER (commodities tab).
// Hyperliquid lists index and commodity perps as HIP-3 markets ("dex:NAME"); each ticker maps to every market with a matching name.
db.exec("CREATE TABLE IF NOT EXISTS candles (ticker TEXT, iv TEXT, t INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY (ticker, iv, t))");
db.exec("CREATE TABLE IF NOT EXISTS ltrades (id TEXT PRIMARY KEY, ticker TEXT, coin TEXT, trader TEXT, side TEXT, t0 INTEGER, px0 REAL, t1 INTEGER, px1 REAL, pnl REAL)");
const OLD_CAT = { btc: "BTC", stocks: "US500", commodities: "GOLD" };
const tickerCoins = () => Object.assign(LN.matchCoins(cache.hip3Coins || kvGet("hip3Coins", [])), { BTC: ["BTC"] });
function catFor(key) {
  const k = OLD_CAT[key] || key, t = LN.ticker(k); if (!t) return null;
  const coins = tickerCoins()[k] || [];
  return { key: k, t, coins, filter: (c) => coins.includes(c), minTrades: t.main ? 20 : 6 };
}
const CATS = new Proxy({}, { get: (_, k) => { const c = catFor(String(k)); return c ? [c.filter, c.minTrades] : undefined; } });
/** A stable virtual name per ticker and address: BTCTrader1, GOLDTrader2, … */
function alias(address, key = "BTC") {
  const k = OLD_CAT[key] || key, m = kvGet("aliases2", {}), id = k + ":" + address.toLowerCase();
  if (!m[id]) { m[id] = Object.keys(m).filter((x) => x.startsWith(k + ":")).length + 1; kvSet("aliases2", m); }
  return LN.traderName(k, m[id]);
}
// addresses seen trading the mapped index / commodity markets, gathered from their recent trades
async function collectHip3Traders() {
  const seen = kvGet("hip3Users", {});
  let coins = [];
  try {
    const dexs = (await AG.post({ type: "perpDexs" })) || [];
    for (const d of dexs.filter((x) => x && x.name)) { try { const m = await AG.post({ type: "meta", dex: d.name }); coins.push(...(m.universe || []).filter((u) => !u.isDelisted).map((u) => u.name)); } catch {} }
  } catch (e) { log("perpDexs:", e.message); }
  if (coins.length) { cache.hip3Coins = coins; kvSet("hip3Coins", coins); }
  const map = tickerCoins();
  for (const [u] of liveUsers) addPool.run(u, "live trades");
  liveUsers.clear();
  for (const [key, cs] of Object.entries(map)) for (const coin of cs) {
    try { for (const t of (await AG.post({ type: "recentTrades", coin })) || []) for (const u of t.users || []) { const k = u.toLowerCase(); seen[k] = seen[k] || { n: 0, cats: {} }; seen[k].n++; seen[k].cats[key] = 1; seen[k].at = Date.now(); } } catch {}
  }
  const cut = Date.now() - 21 * 86400e3;
  kvSet("hip3Users", Object.fromEntries(Object.entries(seen).filter(([, v]) => v.at > cut).sort((a, b) => b[1].n - a[1].n).slice(0, 5000)));
  for (const a of Object.keys(seen)) addPool.run(a, "markets");
}
const insTrade = db.prepare("INSERT OR IGNORE INTO ltrades(id, ticker, coin, trader, side, t0, px0, t1, px1, pnl) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
let ranking = false;
async function refreshTraders() {
  if (ranking) return;
  ranking = true;
  try { await rankAll(); } finally { ranking = false; }
}
// Every address seen trading one of the copy tickers (leaderboard, market trades, the live BTC stream) goes into a pool.
// Each hour the 400 checked longest ago are re-read: 90 days of fills -> whole positions -> stats per ticker.
db.exec("CREATE TABLE IF NOT EXISTS tpool (address TEXT PRIMARY KEY, src TEXT, at INTEGER DEFAULT 0)");
db.exec("CREATE TABLE IF NOT EXISTS tstats (address TEXT, ticker TEXT, ok INTEGER, rank REAL, data TEXT, at INTEGER, PRIMARY KEY (address, ticker))");
// traders seen in your markets or the live BTC stream are checked before general leaderboard traders
const addPool = db.prepare("INSERT INTO tpool(address, src, at) VALUES(?, ?, 0) ON CONFLICT(address) DO UPDATE SET src = excluded.src WHERE excluded.src != 'leaderboard'");
const putStats = db.prepare("INSERT OR REPLACE INTO tstats(address, ticker, ok, rank, data, at) VALUES(?, ?, ?, ?, ?, ?)");
const PER_RUN = 200, RUNS_PER_HOUR = 6;
const traderPages = new Map(), candleCache = new Map();   // trader pages you open: 5 min, candles: 10 min
function fillPool() {
  db.exec("BEGIN");
  try {
    for (const t of cache.lb || []) addPool.run(t.address.toLowerCase(), "leaderboard");
    for (const a of Object.keys(kvGet("hip3Users", {}))) addPool.run(a.toLowerCase(), "markets");
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
}
const lbInfo = () => Object.fromEntries((cache.lb || []).map((t) => [t.address.toLowerCase(), t]));
/** Whole-position stats of one trader in every ticker they trade. */
function traderTickers(address, fills, map, now) {
  const out = {};
  for (const t of LN.TICKERS) {
    const coins = map[t.key] || [], trips = LN.roundTrips(fills, (c) => coins.includes(c));
    if (!trips.length) continue;
    const st = LN.positionStats(trips, now), why = LN.copyCheck(st, t.main), n = {};
    for (const p of trips) n[p.coin] = (n[p.coin] || 0) + 1;
    const step = Math.max(1, Math.ceil(st.equity.length / 40));
    out[t.key] = { trips, stats: st, why, coins: Object.entries(n).sort((a, b) => b[1] - a[1]).map((x) => x[0]), curve: st.equity.filter((_, i) => i % step === 0 || i === st.equity.length - 1) };
  }
  return out;
}
async function rankAll() {
  fillPool();
  const map = tickerCoins(), now = Math.floor(Date.now() / 1000), info = lbInfo();
  let skipped = 0;
  const batch = db.prepare("SELECT address FROM tpool ORDER BY (at > 0) ASC, (src = 'leaderboard') ASC, at ASC LIMIT ?").all(PER_RUN).map((r) => r.address);
  for (const address of batch) {
    try {
      // quick check first: one page of the last 30 days. No trades in our markets, or a bot's flood of fills: skip the 90-day read.
      const pre = (await AG.post({ type: "userFillsByTime", user: address, startTime: (now - 30 * 86400) * 1000, aggregateByTime: true })) || [];
      const ours = new Set(Object.values(map).flat()), span = pre.length ? (Math.max(...pre.map((f) => f.time)) - Math.min(...pre.map((f) => f.time))) / 86400e3 : 0;
      if (!pre.some((f) => ours.has(f.coin)) || (pre.length >= 2000 && span < 3)) {
        db.prepare("DELETE FROM tstats WHERE address = ?").run(address); db.prepare("UPDATE tpool SET at = ? WHERE address = ?").run(now, address); skipped++; continue;
      }
      const fills = await AG.fillsAll(address, 90), res = traderTickers(address, fills, map, now);
      db.prepare("DELETE FROM tstats WHERE address = ?").run(address);
      for (const [k, r] of Object.entries(res)) {
        const ok = r.why.length === 0, { equity, recent, ...stats } = r.stats;
        putStats.run(address, k, ok ? 1 : 0, ok ? LN.copyRank(r.stats) : 0, JSON.stringify({ stats, why: r.why, coins: r.coins.slice(0, 5), curve: r.curve, accountValue: info[address] ? info[address].accountValue : null, handle: info[address] ? info[address].name : null }), now);
        // qualifying traders: every position they closed goes into the learning database
        if (ok) for (const tr of r.trips) insTrade.run(`${address}:${tr.coin}:${tr.t0}`, k, tr.coin, address, tr.side, tr.t0, tr.px0, tr.t1, tr.px1, tr.pnl);
      }
      db.prepare("UPDATE tpool SET at = ? WHERE address = ?").run(now, address);
    } catch (e) { db.prepare("UPDATE tpool SET at = ? WHERE address = ?").run(now - 3000, address); }
  }
  buildBoards(map);
}
function buildBoards(map = tickerCoins()) {
  const cut = Math.floor(Date.now() / 1000) - 4 * 86400, out = {};
  for (const t of LN.TICKERS) {
    out[t.key] = db.prepare("SELECT address, data FROM tstats WHERE ticker = ? AND ok = 1 AND at > ? ORDER BY rank DESC LIMIT 40").all(t.key, cut).map((r) => {
      const d = JSON.parse(r.data);
      return { address: r.address, name: alias(r.address, t.key), handle: d.handle, ticker: t.key, stats: d.stats, curve: d.curve, coins: d.coins, accountValue: d.accountValue, confidence: d.stats.confidence, score: Math.round(LN.copyRank(d.stats) * 100) };
    });
  }
  const pool = db.prepare("SELECT COUNT(*) n, SUM(at > ?) checked FROM tpool").get(cut);
  cache.traders = { at: Math.floor(Date.now() / 1000), rows: out.BTC, cats: out, markets: map, pool: { total: pool.n, checked: pool.checked || 0, perRun: PER_RUN * RUNS_PER_HOUR, hour: db.prepare("SELECT COUNT(*) n FROM tpool WHERE at > ?").get(Math.floor(Date.now() / 1000) - 3600).n }, rules: LN.COPY };
}
// Followed traders: a live Hyperliquid stream (kept alive with pings) plus a poll every 2 minutes as a
// safety net, so a dropped connection never loses a trade. Each fill is alerted once.
let followWs = null, followPing = null;
const fillKey = (f) => `${f.hash || ""}:${f.tid || f.oid || ""}`;
/** One order's fills -> the Telegram line: opened, added, reduced, closed or flipped. */
function orderAlert(name, tName, group) {
  const sp = Number(group[0].startPosition || 0), d = group.reduce((t, x) => t + (x.side === "B" ? 1 : -1) * Number(x.sz), 0), end = +(sp + d).toFixed(10);
  const qty = group.reduce((t, x) => t + Number(x.sz), 0), px = group.reduce((t, x) => t + Number(x.px) * Number(x.sz), 0) / qty, pnl = group.reduce((t, x) => t + Number(x.closedPnl || 0), 0);
  const at = `on ${tName} at ${fmtP(px)} by ${name}`, side = (v) => (v > 0 ? "LONG" : "SHORT");
  if (sp === 0) return `${end > 0 ? "🟢" : "🔴"} ${side(end)} ${at}`;
  if (end === 0) return `✖️ closed ${side(sp)} ${at}${pnl ? ` · PnL ${pnl > 0 ? "+" : ""}$${Math.round(pnl).toLocaleString("en-US")}` : ""}`;
  if (Math.sign(end) !== Math.sign(sp)) return `${end > 0 ? "🟢" : "🔴"} ${side(end)} ${at} (flipped from ${side(sp)})`;
  return `${Math.abs(end) > Math.abs(sp) ? "➕ added" : "➖ reduced"} ${side(sp)} ${at}`;
}
function handleFills(user, fills) {
  const follows = kvGet("follows", []), f = follows.find((x) => x.address.toLowerCase() === String(user).toLowerCase());
  if (!f || !fills || !fills.length) return 0;
  const done = new Set(kvGet("alertedFills", [])), oids = new Set(kvGet("alertedOids", [])), log = kvGet("copyFeed", []), since = (f.since || 0) * 1000;
  const c = catFor(f.cat || "BTC"), groups = new Map();
  let n = 0;
  for (const fill of fills.slice().sort((x, y) => x.time - y.time)) {
    const k = fillKey(fill);
    if (done.has(k) || fill.time < since) continue;
    done.add(k); n++;
    const item = { time: Math.floor(fill.time / 1000), user, name: f.name, coin: fill.coin, dir: fill.dir, px: +fill.px, sz: +fill.sz, pnl: +(fill.closedPnl || 0), text: AG.fillAlert(f.name, fill) };
    log.push(item); broadcast("copy", item);
    if (f.coins === "all" || (c && c.filter(fill.coin))) { const g = String(fill.oid || fill.hash); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(fill); }
  }
  for (const [oid, g] of groups) {
    if (oids.has(oid)) continue;                               // later partial fills of an order already alerted
    oids.add(oid);
    alertSend(orderAlert(f.name, c ? c.t.name : g[0].coin, g) + `\nhttps://app.hyperliquid.xyz/explorer/address/${user}`);
  }
  if (n) { kvSet("copyFeed", log.slice(-300)); kvSet("alertedFills", [...done].slice(-3000)); kvSet("alertedOids", [...oids].slice(-2000)); }
  return n;
}
function openFollowStream() {
  const follows = kvGet("follows", []), old = followWs;
  followWs = null; clearInterval(followPing);
  try { old && old.close(); } catch {}
  if (!follows.length || !globalThis.WebSocket) { status.copy = follows.length ? "polling" : "off"; return; }
  const ws = (followWs = new WebSocket("wss://api.hyperliquid.xyz/ws"));
  ws.onopen = () => { for (const f of follows) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user: f.address } })); status.copy = `live · ${follows.length} followed`; followPing = setInterval(() => { try { ws.send(JSON.stringify({ method: "ping" })); } catch {} }, 30000); };
  ws.onmessage = (m) => {
    let j; try { j = JSON.parse(m.data); } catch { return; }
    if (j.channel === "userFills" && j.data && !j.data.isSnapshot) handleFills(j.data.user, j.data.fills);
  };
  ws.onclose = () => { if (followWs !== ws) return; status.copy = "reconnecting"; clearInterval(followPing); setTimeout(() => followWs === ws && openFollowStream(), 5000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
async function pollFollows() {
  for (const f of kvGet("follows", [])) {
    try { handleFills(f.address, await AG.post({ type: "userFillsByTime", user: f.address, startTime: Math.max((f.since || 0) * 1000, Date.now() - 3600e3), aggregateByTime: false }, { urgent: true })); } catch (e) { log("follow poll:", e.message); }
  }
}
function follow(address, name, on, cat = "BTC") {
  let list = kvGet("follows", []).filter((f) => f.address.toLowerCase() !== address.toLowerCase());
  const k = (catFor(cat) || catFor("BTC")).key;
  if (on) list.push({ address, name: name || alias(address, k), cat: k, since: Math.floor(Date.now() / 1000) });
  list = list.slice(-10);                                // Hyperliquid allows a handful of user streams per connection
  kvSet("follows", list); openFollowStream();
  return list;
}

// ---------------------------------------------------------------- AI agent desk: BTC paper trading, 5-minute bars
let deskBars = [], claudePlan = null, claudeNext = 0;
async function refreshDesk() {
  const state = kvGet("desk", null) || { books: {}, created: Math.floor(Date.now() / 1000) };
  const fresh = await AG.candles("BTC", "5m", deskBars.length ? 6 : 24 * 14);
  const byT = new Map(deskBars.map((b) => [b.t, b]));
  for (const b of fresh) byT.set(b.t, b);
  const nowS = Math.floor(Date.now() / 1000);
  deskBars = [...byT.values()].filter((b) => b.t + 300 <= nowS).sort((a, b) => a.t - b.t).slice(-4500);
  if (deskBars.length < 300) return;
  const anomalies = rows("SELECT data FROM anomalies WHERE time > ?", deskBars[0].t);
  const ctx = { funding: cache.perps && cache.perps.hl ? cache.perps.hl.funding : null, longShare: cache.perps && cache.perps.pos ? cache.perps.pos.longShare : null, anomalies };
  const live = Object.keys(state.books).length > 0;      // the first run is the backtest
  const events = AG.runDesk(state, deskBars, ctx, { live });
  // the Claude strategist: one decision an hour, managed bar by bar like the others
  if (S.anthropicKey) {
    const book = state.books.claude = state.books.claude || Object.assign(AG.newBook("claude"), { lastT: deskBars[deskBars.length - 2].t });
    if (!book.open && Date.now() >= claudeNext) {
      claudeNext = Date.now() + 3600e3;
      try { claudePlan = await AG.claudeDecide(AG.marketSummary(deskBars, AG.indicators(deskBars), ctx), S.anthropicKey); state.lastClaude = { at: nowS, decision: claudePlan }; } catch (e) { state.lastClaude = { at: nowS, error: e.message }; }
    }
    const lastI = deskBars.length - 1, plan = claudePlan && !claudePlan.wait ? claudePlan : null;
    for (const e of AG.step(book, deskBars, AG.indicators(deskBars), (bs, i) => (i === lastI ? plan : null), { live: true })) events.push(Object.assign({ agent: "claude", name: AG.LLM_AGENT.name }, e));
    claudePlan = null;
  }
  kvSet("desk", state);
  const board = AG.leaderboard(state);
  cache.agents = { at: nowS, bars: deskBars.length, from: deskBars[0].t, board, lastClaude: state.lastClaude || null };
  // alerts: trades of the current top agent (or every agent with /agentalerts all)
  const mode = kvGet("agentAlerts", "top");
  if (live && mode !== "off") for (const e of events) {
    if (mode === "top" && board[0] && e.agent !== board[0].id) continue;
    const msg = e.kind === "open" ? `🤖 ${e.name} opened ${e.position.side.toUpperCase()} BTC @ ${X.fmtNum(e.position.entry, 0)} · stop ${X.fmtNum(e.position.stop, 0)} · target ${X.fmtNum(e.position.target, 0)}
${e.position.why}`
      : `🤖 ${e.name} closed ${e.trade.side.toUpperCase()} BTC @ ${X.fmtNum(e.trade.exit, 0)} (${e.trade.exitWhy}) · ${e.trade.R > 0 ? "+" : ""}${e.trade.R}R · $${X.fmtNum(e.trade.net, 0)}`;
    alertSend(msg + "\n(paper trade, not advice)");
    broadcast("agent", e);
  }
}

const fmtP = (v) => (Math.abs(v) >= 10000 ? Math.round(v).toLocaleString("en-US") : Math.abs(v) >= 10 ? v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v.toFixed(4));
// ---------------------------------------------------------------- planned opportunities, learned from profitable traders (pip rules)
// Database: profitable, quick trades by profitable BTC / GOLD / SILVER traders on Hyperliquid — scalps 20-80 pips with at most
// 20 pips against them, swings 100-1000 pips with at most 70 — each with the chart, volume, order-flow proxy and funding at entry.
// Once it holds 400 scalps and 300 swings, every 5 minutes today's bar is compared with it. A+ only; max 4 scalps + 3 swings a day.
const OPP_TICKERS = ["BTC", "GOLD", "SILVER"], DAILY = { scalp: 4, swing: 3 };
db.exec("CREATE TABLE IF NOT EXISTS ldb (id TEXT PRIMARY KEY, ok INTEGER, style TEXT, data TEXT)");   // analysed trades: database rows (ok = 1) or the reason left out
const insLdb = db.prepare("INSERT OR REPLACE INTO ldb(id, ok, style, data) VALUES(?, ?, ?, ?)");
const learn = { series: {}, db: [], base: {}, rejected: {}, at: 0, built: 0, errors: {} };
async function ybars(sym, range, iv) {
  const j = await MK.yget(`/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${iv}&includePrePost=false`), r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("no data for " + sym);
  const q = r.indicators.quote[0];
  return (r.timestamp || []).map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: (q.volume && q.volume[i]) || 0 })).filter((b) => b.o != null && b.c != null && b.h != null && b.l != null);
}
/** Price bars for a ticker: its Hyperliquid market (where the learned trades happened), else Yahoo. */
async function tickerBars(key, iv) {
  const t = LN.ticker(key), coin = (tickerCoins()[key] || [])[0];
  if (coin) {
    // prices are saved on the server, so after the first read only the newest bars are downloaded
    const last = db.prepare("SELECT MAX(t) t, COUNT(*) n FROM candles WHERE ticker = ? AND iv = ?").get(key, iv), full = iv === "5m" ? 24 * 17 : iv === "15m" ? 24 * 52 : 24 * 200;
    const hours = last && last.n > 100 && last.t ? Math.min(full, Math.ceil((Date.now() / 1000 - last.t) / 3600) + 3) : full;
    try { const b = await AG.candles(coin, iv, hours); if (b.length > 100 || (hours < full && b.length)) return { src: "Hyperliquid " + coin, coin, bars: b }; } catch {}
    if (last && last.n > 100) return { src: "Hyperliquid " + coin + " (saved)", coin, bars: [] };   // never mix another price source into saved bars
  }
  if (!t.yahoo) throw new Error(`no ${t.name} market on Hyperliquid yet`);
  return { src: "Yahoo " + t.yahoo, bars: await ybars(t.yahoo, iv === "1h" ? "730d" : "60d", iv === "1h" ? "60m" : iv) };
}
async function fundingHistory(coin, have = []) {
  const out = have.slice(); let start = have.length ? (have[have.length - 1].t + 1) * 1000 : Date.now() - 80 * 86400e3;
  for (let k = 0; k < 6; k++) { const r = await AG.post({ type: "fundingHistory", coin, startTime: start }).catch(() => []); if (!r || !r.length) break; out.push(...r.map((x) => ({ t: Math.floor(x.time / 1000), rate: +x.fundingRate }))); start = r[r.length - 1].time + 1; if (r.length < 400) break; }
  return out;
}
// prices are kept on the server from the first read on, so the database never loses old trades
const insCandle = db.prepare("INSERT OR REPLACE INTO candles(ticker, iv, t, o, h, l, c, v) VALUES(?, ?, ?, ?, ?, ?, ?, ?)");
function keepBars(key, iv, bars, days) {
  db.exec("BEGIN"); try { for (const b of bars) insCandle.run(key, iv, b.t, b.o, b.h, b.l, b.c, b.v || 0); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
  return db.prepare("SELECT t, o, h, l, c, v FROM candles WHERE ticker = ? AND iv = ? AND t >= ? ORDER BY t").all(key, iv, Math.floor(Date.now() / 1000) - days * 86400).map((r) => ({ t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v }));
}
const closedOnly = (bars, sec) => (bars.length && bars[bars.length - 1].t + sec > Date.now() / 1000 ? bars.slice(0, -1) : bars);
async function refreshLearner() {
  const now = Date.now(), hourly = now - learn.at > 3600e3 || !learn.db.length;
  for (const k of OPP_TICKERS) {
    const S = (learn.series[k] = learn.series[k] || {});
    try {
      const r = await tickerBars(k, "15m"); S.src = r.src;
      if (hourly && r.coin) S.fundingRaw = (await fundingHistory(r.coin, S.fundingRaw || [])).filter((x) => x.t > Date.now() / 1000 - 400 * 86400);
      S.fine = keepBars(k, "15m", r.bars, 120); S.scalp = LN.prepX(closedOnly(S.fine, 900), S.fundingRaw || []);
      try { S.fine5 = keepBars(k, "5m", (await tickerBars(k, "5m")).bars, 45); S.m5 = LN.prepX(closedOnly(S.fine5, 300), S.fundingRaw || []); } catch (e) { learn.errors[k + "5m"] = e.message; }
      if (hourly || !S.swing) { S.h1 = keepBars(k, "1h", (await tickerBars(k, "1h")).bars, 400); S.swing = LN.prepX(closedOnly(LN.to4h(S.h1), 14400), S.fundingRaw || []); S.h1p = LN.prepX(closedOnly(S.h1.slice(-24 * 120), 3600), S.fundingRaw || []); }
      delete learn.errors[k];
    } catch (e) { learn.errors[k] = e.message; }
  }
  if (hourly) {
    // each trade is analysed once and saved; later runs only analyse trades not seen before
    const fresh = db.prepare(`SELECT id, ticker, side, t0, px0, t1, px1, pnl, trader FROM ltrades WHERE ticker IN (${OPP_TICKERS.map(() => "?").join(",")}) AND id NOT IN (SELECT id FROM ldb)`).all(...OPP_TICKERS);
    db.exec("BEGIN");
    try {
      for (const tr of fresh) {
        const one = LN.buildDatabase([tr], learn.series), row = one.rows[0], why = Object.keys(one.rejected).find((k) => one.rejected[k]);
        if (row) insLdb.run(tr.id, 1, row.style, JSON.stringify(row));
        else if (why && why !== "no price history") insLdb.run(tr.id, 0, why, null);     // no price yet: try again next hour
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    const demoted = new Set(kvGet("demoted", [])), rejected = { "not profitable": 0, "move outside 20-80 / 100-1000 pips": 0, "too much drawdown": 0, "no price history": 0 };
    for (const r of db.prepare("SELECT style, COUNT(*) n FROM ldb WHERE ok = 0 GROUP BY style").all()) rejected[r.style] = r.n;
    rejected["no price history"] = db.prepare(`SELECT COUNT(*) n FROM ltrades WHERE ticker IN (${OPP_TICKERS.map(() => "?").join(",")}) AND id NOT IN (SELECT id FROM ldb)`).get(...OPP_TICKERS).n;
    const built = { rows: db.prepare("SELECT data FROM ldb WHERE ok = 1").all().map((r) => JSON.parse(r.data)), rejected };
    for (const r of built.rows) if (demoted.has(`${r.ticker}:${r.t}:${r.trader}`)) r.demoted = true;
    const trades = { length: db.prepare(`SELECT COUNT(*) n FROM ltrades WHERE ticker IN (${OPP_TICKERS.map(() => "?").join(",")})`).get(...OPP_TICKERS).n };
    learn.db = built.rows; learn.rejected = built.rejected; learn.trades = trades.length;
    learn.at = now;
  }
  learn.built = now;
}
/** The human-trade database (profitable, quick trades of profitable traders) that the agents learn from. */
function dbView() {
  const count = (st) => learn.db.filter((e) => e.style === st).length;
  return { at: learn.built ? Math.floor(learn.built / 1000) : null, rules: LN.RULES, tickers: OPP_TICKERS.map((k) => Object.assign({}, LN.ticker(k), { pip: LN.PIP[k], src: learn.series[k] && learn.series[k].src, error: learn.errors[k] || null })),
    trades: learn.trades || 0, scalp: count("scalp"), swing: count("swing"), byTicker: OPP_TICKERS.map((k) => ({ ticker: k, scalp: learn.db.filter((e) => e.ticker === k && e.style === "scalp").length, swing: learn.db.filter((e) => e.ticker === k && e.style === "swing").length })),
    rejected: learn.rejected, reasons: { scalp: LN.reasonStats(learn.db, "scalp"), swing: LN.reasonStats(learn.db, "swing") } };
}
// the planned-opportunities feature was removed: clear its plans and history once (the human-trade database stays)
if (!kvGet("oppsRemoved", false)) { for (const k of ["plans2", "reviews", "mistakes", "gateAdj", "gateCalib", "reviewed", "oppAlerts"]) db.prepare("DELETE FROM kv WHERE k = ?").run(k); kvSet("oppsRemoved", true); }

// ---------------------------------------------------------------- agent lab: 60 rule agents + 30 free agents, $500 paper capital each
// Rule agents follow your pip rules and the Elite levels. Free agents have no rules: they only try to grow $500 as fast as possible.
// Every 30 minutes both pools evolve; every 5 minutes they paper-trade live. Results stay on this server and your Telegram.
db.exec("CREATE TABLE IF NOT EXISTS lab_trades (id TEXT PRIMARY KEY, agent INTEGER, ticker TEXT, style TEXT, side TEXT, t INTEGER, p REAL, shadow INTEGER, status TEXT, R REAL, tc INTEGER, data TEXT)");
const LAB_SIZE = 60, LAB_KEEP = 30, FREE_SIZE = 30, FREE_KEEP = 15, STREAK = 3;
const lab = { models: {}, samples: null, samplesAt: 0, running: false, at: 0, labels: {}, kinds: {} };
const labAgents = () => kvGet("labAgents", []);
const labName = (id) => lab.kinds[id] === "council" ? "Council " + id : (lab.kinds[id] === "free" || (!lab.kinds[id] && kvGet("labFreeIds", []).includes(id)) ? "Free agent " : "Agent ") + id;
const SERIES = (k) => learn.series[k] || {};
const fineFor = (style) => Object.fromEntries(OPP_TICKERS.map((k) => [k, style === "swing" ? SERIES(k).h1 || [] : style === "h1" ? SERIES(k).fine || [] : SERIES(k).fine5 || SERIES(k).fine || []]));
const barsFor = (k, style) => (style === "scalp5" ? SERIES(k).m5 : style === "h1" ? SERIES(k).h1p : SERIES(k)[style]);
const nearWinners = (style, f) => { const st = style === "swing" ? "swing" : "scalp"; let n = 0; for (const e of learn.db) { if (e.style !== st || e.demoted) continue; let d = 0; for (let j = 0; j < 16 && d <= 4.84; j++) d += (e.f[j] - f[j]) ** 2; if (d <= 4.84) n++; } return n; };
/** Every labelled past moment (3 markets × 5m / 15m / 4h × both sides), each with how many winning human entries sit close to it. */
function labSamples() {
  if (lab.samples && lab.samplesAt === learn.at) return lab.samples;
  const out = [];
  for (const k of OPP_TICKERS) for (const st of BL.STYLES) for (const s of LN.labSamples(learn.series, k, st)) out.push(s);
  const win = { scalp: learn.db.filter((e) => e.style === "scalp" && !e.demoted), swing: learn.db.filter((e) => e.style === "swing" && !e.demoted) };
  for (const s of out) { let n = 0; for (const e of win[s.style === "swing" ? "swing" : "scalp"]) { let d = 0; for (let j = 0; j < 16 && d <= 4.84; j++) d += (e.f[j] - s.f[j]) ** 2; if (d <= 4.84) n++; } s.like = n; }
  out.sort((a, b) => a.t - b.t); out.forEach((s, i) => (s.i = i));
  lab.samples = out; lab.samplesAt = learn.at; lab.labels = {};
  return out;
}
/** Free agents' own plan outcome for every sample (stop / target in ATRs), cached per style and preset. */
/**
 * The shared knowledge pool. Every live paper trade of every agent (shadow trades included) is a real labelled outcome:
 * 1 = won, 0 = lost. All agents of the same kind and timeframe (and, for free agents, the same stop/target plan) train on all of them,
 * and every agent's losing setups are lessons for all of them, not only the one that lost.
 */
const poolKey = (g) => (g.kind === "free" ? `free|${g.style}|${g.preset || 0}` : `rule|${g.style}`);
function sharedPool(agents, lessons) {
  const byId = Object.fromEntries(agents.map((a) => [a.id, a])), out = {};
  for (const r of db.prepare("SELECT agent, R, tc, data FROM lab_trades WHERE status = 'closed' ORDER BY tc DESC LIMIT 6000").all()) {
    const g = byId[r.agent], o = JSON.parse(r.data); if (!o.f || o.f.length !== 24) continue;
    const key = g ? poolKey(g) : o.kind === "free" ? null : `rule|${r.style || o.style}`; if (!key) continue;
    (out[key] = out[key] || []).push({ f: o.f, y: r.R > 0 ? 1 : 0, w: 3, tc: r.tc });
  }
  for (const [id, xs] of Object.entries(lessons)) {
    const g = byId[id]; if (!g || g.kind === "council") continue;
    for (const x of xs) if (x.f && x.f.length === 24) (out[poolKey(g)] = out[poolKey(g)] || []).push({ f: x.f, y: 0, w: 4, tc: x.tc });
  }
  for (const k of Object.keys(out)) out[k] = out[k].slice(0, 1500);
  lab.poolSize = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length]));
  return out;
}
/** Which of the 24 inputs the best agents lean on (average |weight|, 0..1): new agents favour them. */
function featureHints(best) {
  const imp = new Array(24).fill(0);
  for (const g of best) { const M = lab.models[g.id]; if (!M) continue; let k = 0; g.mask.forEach((m, j) => { if (m) { imp[j] += Math.abs(M.w[k] || 0); k++; } }); }
  const mx = Math.max(...imp) || 1;
  return imp.map((x) => +(x / mx).toFixed(3));
}
function freeLabel(g) {
  const key = g.style + "|" + (g.preset || 0);
  if (!lab.labels[key]) {
    const fine = fineFor(g.style), m = new Map();
    for (const s of lab.samples) { if (s.style !== g.style) continue; const plan = BL.freePlan(g, s), w = LN.walkT(fine[s.ticker], s.t - 1, plan, BL.HORIZON[g.style]); if (w) m.set(s.i, { y: w.y, rr: plan.rr, tc: w.tc, plan }); }
    lab.labels[key] = m;
  }
  const m = lab.labels[key];
  return (s) => m.get(s.i) || null;
}
const tick = () => new Promise((ok) => setImmediate(ok));
const btSummary = (r) => { const m = r.metrics, step = Math.max(1, Math.ceil(m.curve.length / 80)); return Object.assign({}, m, { curve: m.curve.filter((_, i) => i % step === 0 || i === m.curve.length - 1) }); };
const thin = (curve, n = 120) => { const step = Math.max(1, Math.ceil(curve.length / n)); return curve.filter((_, i) => i % step === 0 || i === curve.length - 1); };
// a "new challenge" restarts an agent's live record from that moment (older trades stay in the database and the shared pool)
function liveTrades(id) { return db.prepare("SELECT R, tc, t, data FROM lab_trades WHERE agent = ? AND status = 'closed' AND shadow = 0 AND t >= ? ORDER BY tc").all(id, kvGet("labChallenge", {})[id] || 0); }
function liveMetrics(id) { return BL.metrics(liveTrades(id)); }
/** Live paper capital: $500 start, each closed trade moves it by R × the risk taken at entry. */
function liveCapital(id) {
  let eq = BL.START, peak = eq, dd = 0; const curve = [], rows = liveTrades(id);
  for (const r of rows) { const o = JSON.parse(r.data); eq = Math.max(0, eq * (1 + (r.R * (o.riskPct || 1)) / 100)); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); curve.push([r.tc, +eq.toFixed(2)]); }
  const days = rows.length ? Math.max(1, (Date.now() / 1000 - rows[0].t) / 86400) : 1;
  return { start: BL.START, equity: +eq.toFixed(2), roi: eq / BL.START - 1, roiPerDay: (eq / BL.START - 1) / days, maxDDPct: dd, trades: rows.length, busted: eq < 25, curve: thin(curve) };
}
// every timeframe keeps a minimum share of the rule pool, so no type of strategy dies out (5m 14, 15m 14, 1h 10, 4h 8)
const STYLE_MIN = { scalp5: 14, scalp: 14, h1: 10, swing: 8 };
const pickStyle = (agents) => { const n = (st) => agents.filter((a) => a.kind === "rule" && a.style === st).length; const short = Object.keys(STYLE_MIN).map((st) => [st, n(st) / STYLE_MIN[st]]).sort((a, b) => a[1] - b[1])[0]; return short && short[1] < 1 ? short[0] : undefined; };
/** Every 30 minutes: evolve both pools, backtest every agent walk-forward on unseen data, retrain, look for edges. */
async function refreshLab() {
  if (lab.running || !learn.db.length) return;
  lab.running = true;
  try {
    const samples = labSamples(); if (samples.length < 1000) return;
    let agents = labAgents(), gen = kvGet("labGen", 0), nextId = kvGet("labNextId", 1);
    BL.seed(Date.now() % 2147483647);
    agents.forEach(BL.upgrade);
    const rules = () => agents.filter((a) => a.kind === "rule"), frees = () => agents.filter((a) => a.kind === "free");
    // the council: one extra agent that trades only when the best agents agree (live only, no evolution)
    let council = agents.find((a) => a.kind === "council");
    if (!council) { council = { id: nextId++, kind: "council", style: "scalp5", tickers: BL.TICKERS.slice(), mask: Array(24).fill(false), riskPct: 1, q: 0.95, mgmt: {}, gen: 0, parent: null, bump: 0 }; agents.push(council); }
    if (!rules().length) agents = agents.concat(Array.from({ length: LAB_SIZE }, (_, i) => BL.randomGenome(nextId++, "rule", BL.STYLES[i % 3])));
    if (!frees().length) agents = agents.concat(Array.from({ length: FREE_SIZE }, () => BL.randomGenome(nextId++, "free")));
    const lessons = kvGet("labLessons", {});
    const hints = kvGet("labHints", {});
    if (agents.filter((a) => a.kind !== "council").every((a) => a.bt)) {
      gen++;
      const eliteSet = kvGet("labElite", {}), eliteLiveSet = kvGet("labEliteLive", {});
      // rule pool: keep elites and the best 30; children inherit their parent's lessons; at least 15 scalp agents each of 5m and 15m
      const score = (a) => BL.fitness(a.bt) + (a.live && a.live.trades >= 10 ? BL.fitness(a.live, 10) : 0) + (eliteLiveSet[a.id] ? 100 : eliteSet[a.id] ? 50 : 0);
      // diversity: a near-copy of a better agent is not kept (elites always are), so strategies stay different
      const seenSig = new Set(), R = rules().sort((a, b) => score(b) - score(a)).filter((a) => { const sg = BL.signature(a); if (seenSig.has(sg) && !eliteSet[a.id] && !eliteLiveSet[a.id]) return false; seenSig.add(sg); return true; });
      const keepN = Math.min(LAB_SIZE - 10, Math.max(LAB_KEEP, R.filter((a) => eliteSet[a.id] || eliteLiveSet[a.id]).length), R.length);
      const keepR = R.slice(0, keepN), bestR = keepR.slice(0, 10), newR = [];
      // progress check: if the best agent has not improved for 6 generations, children change more
      const hist = kvGet("labHistory", []), stalled = hist.length >= 6 && Math.max(...hist.slice(-6).map((x) => x.best)) <= (hist[hist.length - 7] || { best: -Infinity }).best + 1e-6;
      const IMMIGRANTS = 5;                                   // brand-new random agents every generation (fresh ideas)
      for (let i = 0; i < IMMIGRANTS && keepN + newR.length < LAB_SIZE; i++) newR.push(BL.randomGenome(nextId++, "rule", pickStyle(keepR.concat(newR))));
      // 60% crossover of two top agents, 40% a changed copy of one; both guided by which inputs work for winners
      for (let i = newR.length; i < LAB_SIZE - keepN; i++) {
        const p = bestR[i % bestR.length], q2 = bestR[Math.floor(Math.random() * bestR.length)], st = pickStyle(keepR.concat(newR));
        let c = q2 && q2.id !== p.id && Math.random() < 0.6 ? BL.crossover(p, q2, nextId++, gen, st, hints.rule) : BL.mutate(p, nextId++, gen, st, hints.rule);
        if (stalled) { const id0 = c.id, p0 = c.parent, p2 = c.parent2; c = BL.mutate(BL.mutate(c, id0, gen, st, null), id0, gen, st, null); c.parent = p0; c.parent2 = p2; }
        lessons[c.id] = (lessons[p.id] || []).concat(c.parent2 ? lessons[c.parent2] || [] : []).slice(-60); newR.push(c);
      }
      // free pool: money per day decides; busted agents always go
      const fscore = (a) => (a.capital && a.capital.trades >= 5 ? BL.freeFitness(a.capital, a.capital.trades) * 2 : 0) + BL.freeFitness(a.btCap, a.bt ? a.bt.trades : 0);
      const seenF = new Set(), F = frees().sort((a, b) => fscore(b) - fscore(a)).filter((a) => { const sg = BL.signature(a); if (seenF.has(sg)) return false; seenF.add(sg); return true; });
      const keepF = F.filter((a) => !(a.capital && a.capital.busted)).slice(0, FREE_KEEP), bestF = keepF.slice(0, 8), newF = [];
      for (let i = 0; i < 3; i++) newF.push(BL.randomGenome(nextId++, "free"));            // fresh free ideas every generation
      for (let i = newF.length; i < FREE_SIZE - keepF.length; i++) { const p = bestF[i % Math.max(1, bestF.length)], q2 = bestF[Math.floor(Math.random() * bestF.length)];
        newF.push(!p ? BL.randomGenome(nextId++, "free") : q2 && q2.id !== p.id && Math.random() < 0.6 ? BL.crossover(p, q2, nextId++, gen, null, hints.free) : BL.mutate(p, nextId++, gen, null, hints.free)); }
      for (const a of newR.concat(newF)) delete a.bt;
      agents = keepR.concat(newR, keepF, newF, [council]);
      const ids = new Set(agents.map((a) => a.id)); for (const id of Object.keys(lab.models)) if (!ids.has(+id)) delete lab.models[id];
    }
    lab.kinds = Object.fromEntries(agents.map((a) => [a.id, a.kind])); kvSet("labFreeIds", agents.filter((a) => a.kind === "free").map((a) => a.id));
    const edges = kvGet("labEdges", {}), fresh = [], elite = kvGet("labElite", {}), freshElite = [];
    const pool = sharedPool(agents, lessons);
    for (const g of agents) {
      if (g.kind === "council") { g.live = liveMetrics(g.id); delete g.live.curve; g.capital = liveCapital(g.id); g.capital.curve = undefined; continue; }
      const label = g.kind === "free" ? freeLabel(g) : null;
      const own = (lessons[g.id] || []).filter((x) => x.f && x.f.length === 24).map((x) => ({ f: x.f, y: 0, w: 5, tc: x.tc }));
      const extra = own.concat(pool[poolKey(g)] || []);
      const r = BL.backtest(g, samples, fineFor(g.style), { extra, label });
      g.bt = btSummary(r); g.btCap = BL.capital(r.trades, g.riskPct); g.btCap.curve = thin(g.btCap.curve);
      g.live = liveMetrics(g.id); delete g.live.curve; g.capital = liveCapital(g.id); g.capital.curve = undefined;
      // the live model: everything known now, plus the lessons from its losses
      const xs = samples.filter((s) => s.style === g.style && g.tickers.includes(s.ticker)), step = Math.max(1, Math.ceil(xs.length / 12000));
      const tr = xs.filter((_, i) => i % step === 0).map((s) => { const o = label ? label(s) : s; return o ? { f: s.f, y: o.y } : null; }).filter(Boolean).concat(extra);
      if (tr.length >= 200) { lab.models[g.id] = BL.fit(g, tr); g.rules = BL.explain(g, lab.models[g.id], LN.FEATURES3); }
      if (g.kind !== "free") {
        if (!BL.isElite(g.bt) && elite[g.id]) delete elite[g.id];
        if (BL.isElite(g.bt)) { g.btTrades = r.trades.slice(-600).map((x) => ({ t: x.t, tc: x.tc, R: x.R, p: +x.p.toFixed(3), side: x.side, ticker: x.ticker })); if (!elite[g.id]) { elite[g.id] = { at: Math.floor(Date.now() / 1000) }; freshElite.push(g); } } else delete g.btTrades;
        if (BL.isEdge(g.bt) && !edges[g.id]) { edges[g.id] = { at: Math.floor(Date.now() / 1000) }; fresh.push(g); }
      }
      await tick();
    }
    lab.kinds = Object.fromEntries(agents.map((a) => [a.id, a.kind]));
    kvSet("labHints", { rule: featureHints(agents.filter((a) => a.kind === "rule").sort((a, b) => BL.fitness(b.bt) - BL.fitness(a.bt)).slice(0, 10)), free: featureHints(agents.filter((a) => a.kind === "free").sort((a, b) => BL.freeFitness(b.btCap, b.bt ? b.bt.trades : 0) - BL.freeFitness(a.btCap, a.bt ? a.bt.trades : 0)).slice(0, 8)), at: Math.floor(Date.now() / 1000) });
    fresh.sort((a, b) => BL.fitness(b.bt) - BL.fitness(a.bt));
    for (const g of fresh.slice(0, 3)) alertSend(`🧪 EDGE FOUND · ${labName(g.id)}\n${BL.describe(g)}\nUnseen-data test: ${g.bt.trades} trades, ${Math.round(g.bt.winRate * 100)}% win, PF ${isFinite(g.bt.profitFactor) ? g.bt.profitFactor.toFixed(2) : "∞"}, ${g.bt.totalR > 0 ? "+" : ""}${g.bt.totalR}R, drawdown ${g.bt.maxDD}R · $500 → $${g.btCap.equity}\nRules:\n${(g.rules || []).map((x) => "• " + x.rule).join("\n")}\n/followagent ${g.id}`);
    if (fresh.length > 3) alertSend(`🧪 …and ${fresh.length - 3} more agents found an edge. /edges`);
    const ratings = BL.rate(agents.filter((a) => elite[a.id] && a.bt).map((a) => ({ id: a.id, R: a.bt.totalR })));
    for (const g of freshElite.sort((a, b) => b.bt.totalR - a.bt.totalR).slice(0, 3)) alertSend(`🏆 ELITE EDGE · ${labName(g.id)} · rating ${ratings[g.id] || "—"}\n${BL.describe(g)}\nUnseen-data test: ${g.bt.trades} trades, ${Math.round(g.bt.winRate * 100)}% win, PF ${isFinite(g.bt.profitFactor) ? g.bt.profitFactor.toFixed(2) : "∞"}, ${g.bt.totalR > 0 ? "+" : ""}${g.bt.totalR}R, drawdown ${g.bt.maxDD}R, max ${g.bt.maxLossStreak} losses in a row · $500 → $${g.btCap.equity}\nNext: Elite Live (100 live paper trades). /followagent ${g.id}`);
    if (freshElite.length > 3) alertSend(`🏆 …and ${freshElite.length - 3} more Elite Edge agents. /elite`);
    kvSet("labElite", elite); kvSet("labLessons", lessons);
    const rf = agents.filter((a) => a.kind === "rule").map((a) => BL.fitness(a.bt)), ff = agents.filter((a) => a.kind === "free");
    kvSet("labHistory", kvGet("labHistory", []).concat([{ gen, t: Math.floor(Date.now() / 1000), trading: agents.filter((a) => a.bt && a.bt.trades > 0).length, best: +Math.max(...rf).toFixed(3), avg: +(rf.reduce((s, x) => s + x, 0) / rf.length).toFixed(3),
      stalled: (() => { const h = kvGet("labHistory", []); return h.length >= 6 && Math.max(...h.slice(-6).map((x) => x.best)) <= (h[h.length - 7] || { best: -Infinity }).best + 1e-6; })(), unique: new Set(agents.map(BL.signature)).size,
      bestWin: Math.max(...agents.filter((a) => a.kind === "rule").map((a) => (a.bt && a.bt.trades >= 25 ? a.bt.winRate : 0))), bestFreeRoi: Math.max(...ff.map((a) => (a.btCap ? a.btCap.roi : -1))), bestFreeLive: Math.max(...ff.map((a) => (a.capital ? a.capital.equity : 0))) }]).slice(-1000));
    kvSet("labAgents", agents); kvSet("labGen", gen); kvSet("labNextId", nextId); kvSet("labEdges", edges);
    lab.at = Date.now();
  } finally { lab.running = false; lab.samples = null; lab.samplesAt = 0; lab.labels = {}; }   // free the training data until the next evolution
}
const labMsg = (g, o, head) => `🤖 ${labName(g.id)} · ${head}${o.side === "long" ? "🟢 LONG" : "🔴 SHORT"} on ${LN.ticker(o.ticker).name} at ${fmtP(o.plan.entry)}, SL ${fmtP(o.plan.stop)} (${o.slPips} pips), TP ${fmtP(o.plan.target)} (${o.tpPips} pips) · ${BL.STYLE_NAME[o.style] || o.style} · risk ${o.riskPct}% of $${o.equity}`;
/** Every 5 minutes: settle open paper trades, apply the losing-streak rule, open new trades where an agent is confident. */
function labLive() {
  const agents = labAgents(); if (!agents.length) return;
  lab.kinds = Object.fromEntries(agents.map((a) => [a.id, a.kind]));
  const follow = new Set(kvGet("labFollow", [])), lessons = kvGet("labLessons", {}), now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const row of db.prepare("SELECT * FROM lab_trades WHERE status = 'open'").all()) {
    const g = agents.find((a) => a.id === row.agent), o = JSON.parse(row.data), fine = fineFor(row.style)[row.ticker];
    if (!g) { db.prepare("UPDATE lab_trades SET status = 'closed', R = 0, tc = ? WHERE id = ?").run(now, row.id); continue; }
    if (!fine || !fine.length) continue;
    const r = BL.simulate(fine, row.t, o.plan, g.mgmt, BL.HORIZON[row.style] || 86400);
    const seen = o.seen || 0; o.seen = r.events.length;
    if (follow.has(g.id) && !row.shadow) for (const e of r.events.slice(seen)) if (e.kind === "partial" || e.kind === "added") alertSend(`🤖 ${labName(g.id)} · ${e.kind === "added" ? "➕ added" : "➖ took half profit on"} ${row.side.toUpperCase()} ${LN.ticker(row.ticker).name} at ${fmtP(e.px)}${e.kind === "partial" && g.mgmt.breakeven ? " · SL moved to entry" : ""}`);
    if (r.open) { db.prepare("UPDATE lab_trades SET data = ? WHERE id = ?").run(JSON.stringify(o), row.id); continue; }
    o.pnl = row.shadow ? 0 : +((o.equity || BL.START) * (r.R * (o.riskPct || 1)) / 100).toFixed(2);
    db.prepare("UPDATE lab_trades SET status = 'closed', R = ?, tc = ?, data = ? WHERE id = ?").run(r.R, r.tc, JSON.stringify(o), row.id);
    if (!row.shadow) { g.cash = +Math.max(0, (g.cash != null ? g.cash : BL.START) + o.pnl).toFixed(2); if (g.cash < 25) g.busted = true; }
    if (follow.has(g.id) && !row.shadow) alertSend(`🤖 ${labName(g.id)} · ${r.R > 0 ? "✅ WIN" : "❌ LOSS"} ${row.side.toUpperCase()} ${LN.ticker(row.ticker).name} · ${r.R > 0 ? "+" : ""}${r.R}R · ${o.pnl >= 0 ? "+" : ""}$${o.pnl} → capital $${g.cash}`);
    // rule agents: 3 live losses in a row -> learn from them, become more selective, trade in shadow until a win. Free agents just keep the lesson.
    g.state = g.state || { streak: 0, shadow: false };
    if (r.R > 0) { if (row.shadow) g.state.shadow = false; g.state.streak = 0; }
    else {
      (lessons[g.id] = lessons[g.id] || []).push({ f: o.f, tc: r.tc, ticker: row.ticker, side: row.side }); lessons[g.id] = lessons[g.id].slice(-60);
      if (g.kind !== "free" && !row.shadow && ++g.state.streak >= STREAK) {
        g.state.shadow = true; g.bump = Math.min(0.03, (g.bump || 0) + 0.005);
        const xs = labSamples().filter((s) => s.style === g.style && g.tickers.includes(s.ticker)), step = Math.max(1, Math.ceil(xs.length / 12000)), tr = xs.filter((_, i) => i % step === 0).concat(lessons[g.id].filter((x) => x.f && x.f.length === 24).map((x) => ({ f: x.f, y: 0, w: 5 })));
        lab.models[g.id] = BL.fit(g, tr);
        kvSet("labLog", kvGet("labLog", []).concat([{ t: now, agent: g.id, text: `${STREAK} losses in a row: retrained with ${lessons[g.id].length} losing setups as lessons, now takes only its top ${+((1 - Math.min(0.998, g.q + g.bump)) * 100).toFixed(1)}% setups, shadow trading until a win.` }]).slice(-300));
        if (follow.has(g.id)) alertSend(`🧠 ${labName(g.id)} lost ${STREAK} in a row: retrained on its mistakes, became more selective, and pauses live alerts until it wins a shadow trade.`);
      }
    }
    changed = true;
    if (g.kind === "free") {
      const cap = liveCapital(g.id), ready = kvGet("labFreeReady", {});
      if (cap.trades >= 30 && cap.roi > 0 && !ready[g.id]) { ready[g.id] = now; kvSet("labFreeReady", ready); alertSend(`💰 FREE AGENT READY FOR REVIEW · ${labName(g.id)}\n${cap.trades} live paper trades · $500 → $${cap.equity} (${cap.roi > 0 ? "+" : ""}${Math.round(cap.roi * 100)}%, ${(cap.roiPerDay * 100).toFixed(2)}% a day) · worst drop ${Math.round(cap.maxDDPct * 100)}%\n${BL.describe(g)}\nIt trades on MT5 only after you /approve ${g.id} on @TraderGzeEdgebot.`); try { DP.send(`💰 READY FOR YOUR REVIEW · ${labName(g.id)} (free agent): $500 → $${cap.equity} in ${cap.trades} live paper trades. Review its data, then /approve ${g.id}`); } catch (e) {} }
    }
    if (g.kind !== "free") {
      const lm = liveMetrics(g.id), eliteLive = kvGet("labEliteLive", {});
      if (BL.isEliteLive(lm) && !eliteLive[g.id]) { eliteLive[g.id] = now; kvSet("labEliteLive", eliteLive); alertSend(`🏆✅ ELITE LIVE PASSED · ${labName(g.id)}\n${lm.trades} live paper trades, ${Math.round(lm.winRate * 100)}% win, PF ${isFinite(lm.profitFactor) ? lm.profitFactor.toFixed(2) : "∞"}, ${lm.totalR > 0 ? "+" : ""}${lm.totalR}R, drawdown ${lm.maxDD}R · capital $${g.cash}\n${BL.describe(g)}\nDownload: Settings → Download data → Elite agents / Elite trades. It trades on MT5 only after you /approve it on @TraderGzeEdgebot.`); try { DP.onEliteLive(g, lm, eliteLiveRating(g.id)); } catch (e) { log("deployer:", e.message); } }
    }
  }
  // new trades
  const today = Math.floor(now / 86400);
  // the council's voters: the 10 best rule agents of each timeframe (by their unseen-data test)
  const voters = Object.fromEntries(BL.STYLES.map((st) => [st, agents.filter((x) => x.kind === "rule" && x.style === st && lab.models[x.id] && x.bt && x.bt.trades >= 20).sort((x, y) => BL.fitness(y.bt) - BL.fitness(x.bt)).slice(0, 10)]));
  for (const g of agents) {
    const council = g.kind === "council", M = lab.models[g.id]; if ((!M && !council) || g.busted) continue;
    const open = db.prepare("SELECT ticker FROM lab_trades WHERE agent = ? AND status = 'open'").all(g.id).map((r) => r.ticker);
    let todayN = db.prepare("SELECT COUNT(*) n FROM lab_trades WHERE agent = ? AND t >= ?").get(g.id, today * 86400).n;
    const cap = g.kind === "free" ? g.maxPerDay || 10 : council ? 8 : BL.CAP[g.style] || 8;
    for (const style of council ? BL.STYLES : [g.style]) for (const k of g.tickers) {
      if (todayN >= cap || open.includes(k)) continue;
      const P = barsFor(k, style); if (!P || P.bars.length < 80) continue;
      const bar = LN.LAB_STYLES[style].bar, i = P.bars.length - 1, t = P.bars[i].t + bar;
      if (now - t > Math.max(bar, 600)) continue;                       // the bar is stale
      let best = null;
      if (council) {
        // a vote: each voter that would take the trade backs that side; trade only with 3+ votes and no vote against
        const votes = { long: [], short: [] };
        for (const v of voters[style]) { if (!v.tickers.includes(k)) continue; const Mv = lab.models[v.id]; for (const side of ["long", "short"]) { const f = LN.features3(P, i, side, style); if (f && BL.predict(Mv, BL.sel(v, f)) >= Mv.cut) votes[side].push(v.id); } }
        for (const side of ["long", "short"]) { const other = side === "long" ? "short" : "long"; if (votes[side].length >= 3 && !votes[other].length) best = { side, f: LN.features3(P, i, side, style), p: votes[side].length / Math.max(1, voters[style].length), voters: votes[side] }; }
      } else for (const side of ["long", "short"]) {
        const f = LN.features3(P, i, side, style); if (!f) continue;
        const p = BL.predict(M, BL.sel(g, f)); if (p < M.cut) continue;
        if (g.minLike && nearWinners(style, f) < g.minLike) continue;
        if (!best || p > best.p) best = { side, f, p };
      }
      if (!best) continue;
      const pip = LN.PIP[k], c = P.bars[i].c, a = P.a[i];
      let plan, slPips, tpPips;
      if (g.kind === "free") { plan = BL.freePlan(g, { side: best.side, c, a }); slPips = Math.round(Math.abs(plan.entry - plan.stop) / pip); tpPips = Math.round(Math.abs(plan.target - plan.entry) / pip); }
      else { const pl = LN.planPips(P, i, best.side, LN.LAB_STYLES[style].rules, k); plan = { side: best.side, entry: pl.entry, stop: pl.stop, target: pl.target }; slPips = pl.slPips; tpPips = pl.tpPips; }
      const shadow = g.kind !== "free" && g.state && g.state.shadow ? 1 : 0, id = `${g.id}:${k}:${style}:${t}`, equity = g.cash != null ? g.cash : BL.START;
      const o = { ticker: k, style, side: best.side, f: best.f, p: best.p, slPips, tpPips, plan, riskPct: g.riskPct, equity, kind: g.kind, voters: best.voters };
      const inserted = db.prepare("INSERT OR IGNORE INTO lab_trades(id, agent, ticker, style, side, t, p, shadow, status, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)").run(id, g.id, k, style, best.side, t, best.p, shadow, JSON.stringify(o)).changes;
      if (!inserted) continue;
      open.push(k); todayN++;
      if (follow.has(g.id) && !shadow) alertSend(labMsg(g, o, "") + `\n${council ? `Council vote: ${best.voters.length} of ${voters[style].length} top ${BL.STYLE_NAME[style]} agents agree (${best.voters.map((x) => "Agent " + x).join(", ")})` : `Confidence ${Math.round(best.p * 100)}%`}${g.mgmt.partial ? " · will take half profit halfway" : ""}${g.mgmt.add ? " · may add once on a pullback" : ""}`);
      changed = true;
    }
  }
  if (changed) { kvSet("labAgents", agents); kvSet("labLessons", lessons); }
}
// ---------------------------------------------------------------- frozen strategies: what you approved is exactly what trades on MT5
// /approve takes a snapshot of the agent's model and settings (for the Council: its voters' models). Only the snapshot sends
// trades to MT5; the agent itself keeps learning in the lab. Approve again to replace the snapshot with the newer version.
const plainModel = (M) => ({ w: M.w.slice(), b: M.b, mu: M.mu.slice(), sd: M.sd.slice(), cut: M.cut });
const plainGenome = (g) => ({ id: g.id, kind: g.kind, style: g.style, tickers: g.tickers.slice(), mask: g.mask.slice(), riskPct: g.riskPct, minLike: g.minLike || 0, preset: g.preset, mgmt: Object.assign({}, g.mgmt) });
/** /approve: deploy the snapshot you froze earlier, or freeze the current version now. */
function approveSnapshot(id) { const f = kvGet("labFrozen", {})[id]; return f ? { ok: true, message: `🧊 Using your frozen version of ${new Date(f.at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC. /freeze ${id} to replace it with the current version.` } : freezeAgent(id); }
/** Paper results of each frozen snapshot since it was frozen. */
function frozenStats() {
  const f = kvGet("labFrozen", {}), trades = kvGet("labFrozenTrades", []), appr = new Set(DP.approved());
  return Object.entries(f).map(([id, snap]) => { const xs = trades.filter((x) => x.agent === +id && x.done), m = BL.metrics(xs.map((x) => ({ R: x.R, tc: x.tc }))); return { id: +id, at: snap.at, kind: snap.kind, onMT5: appr.has(+id), open: trades.filter((x) => x.agent === +id && !x.done).length, trades: m.trades, winRate: m.winRate, R: m.totalR, dd: m.maxDD }; });
}
function freezeAgent(id) {
  const agents = labAgents(), g = agents.find((a) => a.id === id);
  if (!g) return { ok: false, message: `Agent ${id} no longer exists in the lab.` };
  let members;
  if (g.kind === "council") members = agents.filter((x) => x.kind === "rule" && lab.models[x.id] && x.bt && x.bt.trades >= 20).sort((x, y) => BL.fitness(y.bt) - BL.fitness(x.bt)).reduce((acc, x) => ((acc[x.style] = acc[x.style] || []).length < 10 && acc[x.style].push(x), acc), {});
  else if (!lab.models[id]) return { ok: false, message: `Agent ${id} has no trained model yet (wait for the next evolution, ≤ 30 min) and try again.` };
  const snap = { at: Math.floor(Date.now() / 1000), kind: g.kind, self: plainGenome(g), members: g.kind === "council" ? Object.values(members).flat().map((x) => ({ genome: plainGenome(x), model: plainModel(lab.models[x.id]) })) : [{ genome: plainGenome(g), model: plainModel(lab.models[id]) }] };
  const frozen = kvGet("labFrozen", {}); frozen[id] = snap; kvSet("labFrozen", frozen);
  return { ok: true, message: `🧊 Frozen: the exact version of ${new Date(snap.at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC (${g.kind === "council" ? snap.members.length + " voter models" : "model and settings"}). It is paper-tracked unchanged (/frozen) and only goes to MT5 if you /approve ${id}. The agent keeps learning in the lab; /freeze ${id} again to save its newer version.` };
}
function unfreezeAgent(id) { const f = kvGet("labFrozen", {}); delete f[id]; kvSet("labFrozen", f); }
/** Every 5 minutes: frozen snapshots of approved agents decide MT5 trades (separate from the lab's paper trades). */
function frozenLive() {
  const frozen = kvGet("labFrozen", {}), approved = new Set(DP.approved()), now = Math.floor(Date.now() / 1000), today = Math.floor(now / 86400);
  const trades = kvGet("labFrozenTrades", []);
  // settle: SL / TP happen on MT5 by themselves; the time limit is sent as a close
  for (const tr of trades.filter((x) => !x.done)) {
    const fine = fineFor(tr.style)[tr.ticker]; if (!fine || !fine.length) continue;
    const r = BL.simulate(fine, tr.t, tr.plan, tr.mgmt, BL.HORIZON[tr.style] || 86400);
    if (r.open) continue;
    tr.done = true; tr.R = r.R; tr.tc = r.tc;
    if (tr.mt5 && r.events.length && r.events[r.events.length - 1].kind === "time") { try { DP.onClose({ id: tr.agent }, tr.id, "time limit"); } catch (e) { log("deployer:", e.message); } }
  }
  for (const [ids, snap] of Object.entries(frozen)) {
    const id = +ids, live = approved.has(id);        // frozen but not approved: paper-tracked only, nothing goes to MT5
    const mine = trades.filter((x) => x.agent === id), open = mine.filter((x) => !x.done).map((x) => x.ticker), cap = snap.kind === "council" ? 8 : snap.kind === "free" ? snap.self.maxPerDay || 10 : BL.CAP[snap.self.style] || 8;
    let todayN = mine.filter((x) => x.t >= today * 86400).length;
    const styles = snap.kind === "council" ? BL.STYLES : [snap.self.style];
    for (const style of styles) for (const k of snap.self.tickers) {
      if (todayN >= cap || open.includes(k)) continue;
      const P = barsFor(k, style); if (!P || P.bars.length < 80) continue;
      const bar = LN.LAB_STYLES[style].bar, i = P.bars.length - 1, t = P.bars[i].t + bar;
      if (now - t > Math.max(bar, 600)) continue;
      const id2 = `frozen:${id}:${k}:${style}:${t}`; if (mine.some((x) => x.id === id2)) continue;
      let side = null;
      if (snap.kind === "council") {
        const v = { long: 0, short: 0 };
        for (const m of snap.members.filter((x) => x.genome.style === style && x.genome.tickers.includes(k))) for (const sd of ["long", "short"]) { const f = LN.features3(P, i, sd, style); if (f && BL.predict(m.model, BL.sel(m.genome, f)) >= m.model.cut) v[sd]++; }
        side = v.long >= 3 && !v.short ? "long" : v.short >= 3 && !v.long ? "short" : null;
      } else {
        const m = snap.members[0]; let bestP = -1;
        for (const sd of ["long", "short"]) { const f = LN.features3(P, i, sd, style); if (!f) continue; const p = BL.predict(m.model, BL.sel(m.genome, f)); if (p >= m.model.cut && p > bestP && (!m.genome.minLike || nearWinners(style, f) >= m.genome.minLike)) { bestP = p; side = sd; } }
      }
      if (!side) continue;
      const pip = LN.PIP[k], c = P.bars[i].c, a = P.a[i];
      let plan, slPips, tpPips;
      if (snap.kind === "free") { plan = BL.freePlan(snap.self, { side, c, a }); slPips = Math.round(Math.abs(plan.entry - plan.stop) / pip); tpPips = Math.round(Math.abs(plan.target - plan.entry) / pip); }
      else { const pl = LN.planPips(P, i, side, LN.LAB_STYLES[style].rules, k); plan = { side, entry: pl.entry, stop: pl.stop, target: pl.target }; slPips = pl.slPips; tpPips = pl.tpPips; }
      const o = { ticker: k, style, side, slPips, tpPips, plan };
      let sent = false;
      if (live) { try { sent = !!DP.onOpen({ id, mgmt: snap.self.mgmt }, o, id2, eliteLiveRating(id)); } catch (e) { log("deployer:", e.message); } }
      trades.push({ id: id2, agent: id, ticker: k, style, side, t, plan, mgmt: snap.self.mgmt, done: false, mt5: sent }); open.push(k); todayN++;
    }
  }
  kvSet("labFrozenTrades", trades.slice(-2000));
}
// ---------------------------------------------------------------- review: agents that passed, for a human to freeze, approve or send back
function reviewList() {
  const v = labView(), el = kvGet("labEliteLive", {}), fr = kvGet("labFreeReady", {}), frozen = kvGet("labFrozen", {}), appr = new Set(DP.approved()), ch = kvGet("labChallenge", {});
  return v.agents.filter((a) => el[a.id] || fr[a.id] || frozen[a.id]).map((a) => ({ id: a.id, name: a.name, kind: a.kind, style: a.style, tickers: a.tickers, describe: a.describe, rating: a.rating, passed: el[a.id] ? "Elite Live" : fr[a.id] ? "Free agent: 30+ profitable live trades" : "frozen by you",
    passedAt: el[a.id] || fr[a.id] || null, riskPct: a.riskPct, live: a.live, capital: a.capital, bt: a.bt, btCap: a.btCap, frozenAt: frozen[a.id] ? frozen[a.id].at : null, approved: appr.has(a.id), challengedAt: ch[a.id] || null }));
}
function reviewAction(id, action) {
  const agents = labAgents(), g = agents.find((a) => a.id === id); if (!g) return { ok: false, message: "This agent no longer exists." };
  if (action === "freeze") return freezeAgent(id);
  if (action === "unfreeze") { unfreezeAgent(id); kvSet("deployApproved", DP.approved().filter((x) => x !== id)); return { ok: true, message: `Agent ${id}: snapshot deleted, not trading on MT5.` }; }
  if (action === "challenge") {
    const ch = kvGet("labChallenge", {}), el = kvGet("labEliteLive", {}), fr = kvGet("labFreeReady", {});
    ch[id] = Math.floor(Date.now() / 1000); delete el[id]; delete fr[id]; kvSet("labChallenge", ch); kvSet("labEliteLive", el); kvSet("labFreeReady", fr);
    unfreezeAgent(id); kvSet("deployApproved", DP.approved().filter((x) => x !== id));
    g.cash = BL.START; g.busted = false; g.state = { streak: 0, shadow: false }; kvSet("labAgents", agents);
    kvSet("labLog", kvGet("labLog", []).concat([{ t: ch[id], agent: id, text: "New challenge from the human reviewer: back to $500 and a fresh live record; it must pass again." }]).slice(-300));
    return { ok: true, message: `Agent ${id} starts a new challenge: $500, fresh live record, back in the pool. It will be sent for review again when it passes.` };
  }
  return { ok: false, message: "unknown action" };
}
function labRow(g, ctx) {
  const live = ctx.live[g.id], cap = liveCapital(g.id);
  return { id: g.id, name: labName(g.id), kind: g.kind || "rule", gen: g.gen, parent: g.parent, style: g.style, tickers: g.tickers, riskPct: g.riskPct, describe: BL.describe(g), rules: g.rules || [],
    bt: g.bt ? Object.assign({}, g.bt, { curve: undefined }) : null, curve: g.bt ? g.bt.curve : [], btCap: g.btCap ? Object.assign({}, g.btCap, { curve: undefined }) : null, btCapCurve: g.btCap ? g.btCap.curve : [],
    live: Object.assign({}, live, { curve: undefined }), capital: Object.assign({}, cap, { curve: undefined }), capCurve: cap.curve, shadow: !!(g.state && g.state.shadow), busted: !!g.busted || cap.busted,
    mt5: ctx.mt5.has(g.id), frozen: !!ctx.frozen[g.id], frozenAt: (ctx.frozen[g.id] || {}).at || null, elite: !!ctx.elite[g.id], eliteLive: !!ctx.eliteLive[g.id], rating: ctx.eliteLive[g.id] ? ctx.rateL[g.id] : ctx.elite[g.id] ? ctx.rateE[g.id] : null,
    status: g.kind === "council" ? (ctx.eliteLive[g.id] ? "eliteLive" : "council") : g.kind === "free" ? (cap.busted ? "busted" : "free") : ctx.eliteLive[g.id] ? "eliteLive" : ctx.elite[g.id] ? "elite" : ctx.edges[g.id] ? "edge" : g.bt ? "learning" : "new", following: ctx.follow.has(g.id),
    fitness: g.kind === "council" ? 1000 + (live.trades ? BL.fitness(live, 10) : 0) : g.kind === "free" ? (cap.trades >= 5 ? BL.freeFitness(cap, cap.trades) * 2 : 0) + BL.freeFitness(g.btCap, g.bt ? g.bt.trades : 0) : (g.bt ? BL.fitness(g.bt) : -9) + (ctx.eliteLive[g.id] ? 100 : ctx.elite[g.id] ? 50 : 0) };
}
function labView() {
  const agents = labAgents(); lab.kinds = Object.fromEntries(agents.map((a) => [a.id, a.kind]));
  const ctx = { follow: new Set(kvGet("labFollow", [])), edges: kvGet("labEdges", {}), elite: kvGet("labElite", {}), eliteLive: kvGet("labEliteLive", {}), mt5: new Set(kvGet("deployApproved", [])), frozen: kvGet("labFrozen", {}), live: Object.fromEntries(agents.map((g) => [g.id, liveMetrics(g.id)])) };
  ctx.rateE = BL.rate(agents.filter((g) => ctx.elite[g.id] && g.bt).map((g) => ({ id: g.id, R: g.bt.totalR }))); ctx.rateL = BL.rate(agents.filter((g) => ctx.eliteLive[g.id]).map((g) => ({ id: g.id, R: ctx.live[g.id].totalR })));
  const rows = agents.map((g) => labRow(g, ctx)).sort((a, b) => b.fitness - a.fitness || (b.bt ? b.bt.totalR : 0) - (a.bt ? a.bt.totalR : 0));
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0), R = rows.filter((r) => r.kind !== "free"), F = rows.filter((r) => r.kind === "free");
  const stats = (xs) => ({ n: xs.length, capital: +sum(xs, (x) => x.capital.equity).toFixed(2), start: xs.length * BL.START, trading: xs.filter((x) => x.bt && x.bt.trades > 0).length, liveTrades: sum(xs, (x) => x.capital.trades), busted: xs.filter((x) => x.busted).length,
    styles: Object.fromEntries(BL.STYLES.map((s) => [s, xs.filter((x) => x.style === s).length])), best: xs.slice().sort((a, b) => b.capital.equity - a.capital.equity)[0] || null });
  return { at: lab.at ? Math.floor(lab.at / 1000) : null, gen: kvGet("labGen", 0), size: agents.length, history: kvGet("labHistory", []).slice(-300), trading: agents.filter((a) => a.bt && a.bt.trades > 0).length, goals: BL.GOALS, streak: STREAK, start: BL.START,
    pools: { rule: stats(R), free: stats(F) }, agents: rows, shared: { pool: lab.poolSize || {}, hints: (() => { const h = kvGet("labHints", {}); return { rule: (h.rule || []).map((v, j) => ({ name: LN.FEATURES3[j], v })).sort((a, b) => b.v - a.v).slice(0, 6), free: (h.free || []).map((v, j) => ({ name: LN.FEATURES3[j], v })).sort((a, b) => b.v - a.v).slice(0, 6) }; })(), caps: BL.CAP }, log: kvGet("labLog", []).slice(-40).reverse(), running: lab.running };
}
function labAgentView(id) {
  const g = labAgents().find((a) => a.id === id); if (!g) return null;
  const v = labView().agents.find((a) => a.id === id) || {};
  const trades = db.prepare("SELECT * FROM lab_trades WHERE agent = ? ORDER BY t DESC LIMIT 300").all(id).map((r) => { const o = JSON.parse(r.data); return { t: r.t, tc: r.tc, ticker: r.ticker, name: LN.ticker(r.ticker).name, style: r.style, side: r.side, p: r.p, shadow: !!r.shadow, status: r.status, R: r.R, pnl: o.pnl, equity: o.equity, riskPct: o.riskPct, entry: o.plan.entry, stop: o.plan.stop, target: o.plan.target, slPips: o.slPips, tpPips: o.tpPips }; });
  return Object.assign({}, v, { genome: g, trades, lessons: (kvGet("labLessons", {})[id] || []).length, log: kvGet("labLog", []).filter((x) => x.agent === id).slice(-20).reverse(), state: g.state || {}, bt: g.bt || null, btCapCurve: g.btCap ? g.btCap.curve : [] });
}
// the strategy deployer: Elite Live agents' trades go to MT5 (server/deployer.js), with its own Telegram bot
const DP = (function () { const module = { exports: {} };
// TraderGze strategy deployer: trades of agents that passed Elite Live AND that you approved (/approve) go to your MetaTrader 5 through the
// TraderGze Deployer EA. The EA asks this server for new trades every few seconds, places them on your account
// and reports back. Your MT5 password never leaves MT5. Its own Telegram bot (TG_DEPLOY_TOKEN) reports everything.
"use strict";
const crypto = require("crypto");

module.exports = function deployer({ db, kvGet, kvSet, log, LN, labName, fmtP, CFG }) {
  const env = process.env, D = {};
  const token = env.TG_DEPLOY_TOKEN || "", eaKey = env.DEPLOY_KEY || "";
  db.exec("CREATE TABLE IF NOT EXISTS deploy_signals (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, type TEXT, data TEXT, t INTEGER)");
  const DEFAULTS = { risk: 7, maxOpen: 3, dailyLoss: 20, paused: false, tz: "UTC", days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "24:00", newsBlock: true, newsMin: 30 };
  const DAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  /** Your local weekday (0 = Sunday) and minutes since midnight, in the time zone you set (/timezone). */
  function localNow(tz, at = Date.now()) {
    if (/^[+-]?\d{1,2}(:\d\d)?$/.test(tz)) { const [h, m = 0] = tz.replace("+", "").split(":").map(Number), off = (Math.abs(h) * 60 + m) * (tz.startsWith("-") ? -1 : 1), d = new Date(at + off * 60e3); return { day: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at)).map((x) => [x.type, x.value]));
    return { day: DAY.indexOf(p.weekday.toUpperCase().slice(0, 3)), min: (+p.hour % 24) * 60 + +p.minute };
  }
  const toMin = (hm) => { const [h, m = 0] = String(hm).split(":").map(Number); return h * 60 + m; };
  /** Is MT5 trading allowed right now? Your days, your hours (overnight windows like 22:00-06:00 work), and no big news. */
  D.allowedNow = (at = Date.now()) => {
    const s = settings(); let ln; try { ln = localNow(s.tz, at); } catch (e) { ln = localNow("UTC", at); }
    if (!s.days.includes(ln.day)) return { ok: false, why: `${DAY[ln.day]} is not a trading day (/days)` };
    const a = toMin(s.from), b = toMin(s.to), inside = a <= b ? ln.min >= a && ln.min < b : ln.min >= a || ln.min < b;
    if (!inside) return { ok: false, why: `outside your trading hours ${s.from}-${s.to} ${s.tz} (/hours)` };
    if (s.newsBlock && D.newsNear) { const n = D.newsNear(at, s.newsMin); if (n) return { ok: false, why: `high-impact news: ${n} (/news off to allow)` }; }
    return { ok: true };
  };
  const settings = () => Object.assign({}, DEFAULTS, kvGet("deploySettings", {}));
  const setSettings = (x) => kvSet("deploySettings", Object.assign(settings(), x));
  D.settings = settings;

  // ---------------------------------------------------------------- its own Telegram bot
  const tg = (method, body) => token ? fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()).catch(() => null) : Promise.resolve(null);
  const send = (text, chat = kvGet("deployChat", "")) => (chat ? tg("sendMessage", { chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true }) : null);
  D.send = send;

  // ---------------------------------------------------------------- which agents may trade your MT5
  /** Nothing trades on its own: an agent must have passed Elite Live and been approved by you after your review. */
  const approved = () => kvGet("deployApproved", []);
  D.approved = approved;
  const passed = (id) => !!kvGet("labEliteLive", {})[id] || !!kvGet("labFreeReady", {})[id];   // Elite Live, or a free agent with 30+ profitable live trades
  D.eligible = (agentId) => passed(agentId) && approved().includes(+agentId);
  /** Called when an agent passes Elite Live: ask for a human review instead of trading. */
  D.onEliteLive = (g, lm, rating) => send(`🏆✅ READY FOR YOUR REVIEW · Agent ${g.id}${rating ? ` (${rating})` : ""}\nPassed Elite Live: ${lm.trades} live paper trades, ${Math.round(lm.winRate * 100)}% win, PF ${isFinite(lm.profitFactor) ? lm.profitFactor.toFixed(2) : "∞"}, ${lm.totalR > 0 ? "+" : ""}${lm.totalR}R, worst drawdown ${lm.maxDD}R.\nIt will NOT trade on MT5 until you approve it.\n1. Download its data: app → Settings → Download data → Elite agents / Elite trades\n2. Review it\n3. If you are happy: /approve ${g.id}`);
  function push(type, id, data) {
    db.prepare("INSERT INTO deploy_signals(id, type, data, t) VALUES(?, ?, ?, ?)").run(id, type, JSON.stringify(data), Math.floor(Date.now() / 1000));
  }
  /** An eligible agent opened a live paper trade: send the same trade to MT5. */
  D.onOpen = (g, o, tradeId, rating) => {
    if (!D.eligible(g.id)) return false;
    const s = settings(), pip = LN.PIP[o.ticker], allow = D.allowedNow();
    if (!allow.ok) { kvSet("deployLog", kvGet("deployLog", []).concat([{ t: Math.floor(Date.now() / 1000), type: "skipped", agent: g.id, ticker: o.ticker, side: o.side, ok: false, message: allow.why }]).slice(-500)); return false; }
    push("open", tradeId, { agent: g.id, ticker: o.ticker, side: o.side, slPips: o.slPips, tpPips: o.tpPips, pip, partial: !!g.mgmt.partial, breakeven: !!g.mgmt.breakeven, add: !!g.mgmt.add, ref: o.plan.entry, style: o.style });
    send(`📤 TO MT5 · ${labName(g.id)} (${rating || "Elite Live"})\n${o.side === "long" ? "🟢 LONG" : "🔴 SHORT"} ${LN.ticker(o.ticker).name} · SL ${o.slPips} pips · TP ${o.tpPips} pips · risk ${s.risk}% · ${o.style === "scalp" ? "Scalp" : "Swing"}${s.paused ? "\n⏸ Deployer is paused: the EA will skip it. /resume" : ""}`);
    return true;
  };
  /** The paper trade ended on time (not SL/TP): close it on MT5 too. */
  D.onClose = (g, tradeId, reason) => {
    const open = db.prepare("SELECT seq FROM deploy_signals WHERE id = ? AND type = 'open'").get(tradeId); if (!open) return;
    push("close", tradeId, { agent: g.id, reason, openSeq: open.seq });
  };

  // ---------------------------------------------------------------- the EA connection
  const okKey = (k) => eaKey && k && crypto.timingSafeEqual(crypto.createHash("sha256").update(String(k)).digest(), crypto.createHash("sha256").update(eaKey).digest());
  const text = (res, code, body) => { res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); };
  /** Plain-text lines (easy to read in MQL5): CFG|risk|maxOpen|dailyLoss|paused|serverTime, then SIG|seq|id|type|ticker|side|slPips|tpPips|pip|partial|breakeven|add|t|agent|openSeq */
  function poll(res, since) {
    const s = settings(), now = Math.floor(Date.now() / 1000);
    kvSet("deployLastPoll", now);
    const rows = db.prepare("SELECT * FROM deploy_signals WHERE seq > ? ORDER BY seq LIMIT 50").all(+since || 0);
    const lines = [`CFG|${s.risk}|${s.maxOpen}|${s.dailyLoss}|${s.paused ? 1 : 0}|${now}`];
    for (const r of rows) { const d = JSON.parse(r.data); lines.push(["SIG", r.seq, r.id, r.type, d.ticker || "", d.side || "", d.slPips || 0, d.tpPips || 0, d.pip || 0, d.partial ? 1 : 0, d.breakeven ? 1 : 0, d.add ? 1 : 0, r.t, d.agent || 0, d.openSeq || 0, d.ref || 0].join("|")); }
    text(res, 200, lines.join("\n") + "\n");
  }
  /** Lines from the EA: ACC|login|server|balance|equity|currency|name, POS|ticket|symbol|side|volume|price|sl|tp|profit|comment, RES|seq|ok|ticket|price|volume|message */
  function report(res, body) {
    const acc = {}, pos = [], results = [];
    for (const l of String(body).split(/\r?\n/)) {
      const p = l.split("|");
      if (p[0] === "ACC") Object.assign(acc, { login: p[1], server: p[2], balance: +p[3], equity: +p[4], currency: p[5], name: p[6] || "", at: Math.floor(Date.now() / 1000) });
      if (p[0] === "POS") pos.push({ ticket: p[1], symbol: p[2], side: p[3], volume: +p[4], price: +p[5], sl: +p[6], tp: +p[7], profit: +p[8], comment: p[9] || "" });
      if (p[0] === "RES") results.push({ seq: +p[1], ok: p[2] === "1", ticket: p[3], price: +p[4], volume: +p[5], message: p.slice(6).join("|") });
    }
    if (acc.login) { const prev = kvGet("deployAccount", null); kvSet("deployAccount", acc); if (!prev || prev.login !== acc.login) send(`🔗 MT5 connected: account ${acc.login} on ${acc.server}${acc.name ? ` (${acc.name})` : ""} · balance ${acc.balance} ${acc.currency}`); }
    kvSet("deployPositions", pos); kvSet("deployLastPoll", Math.floor(Date.now() / 1000));
    for (const r of results) {
      const sig = db.prepare("SELECT * FROM deploy_signals WHERE seq = ?").get(r.seq); if (!sig) continue;
      const d = JSON.parse(sig.data), name = d.ticker ? LN.ticker(d.ticker).name : "";
      kvSet("deployLog", kvGet("deployLog", []).concat([Object.assign({ t: Math.floor(Date.now() / 1000), type: sig.type, agent: d.agent, ticker: d.ticker, side: d.side }, r)]).slice(-500));
      if (sig.type === "open") send(r.ok ? `✅ MT5 FILLED · ${labName(d.agent)}\n${d.side === "long" ? "🟢 LONG" : "🔴 SHORT"} ${name} ${r.volume} lot at ${r.price} · ticket ${r.ticket}${r.message ? `\n${r.message}` : ""}` : `⚠️ MT5 SKIPPED · ${labName(d.agent)} ${d.side.toUpperCase()} ${name}\n${r.message}`);
      else if (sig.type === "test") send(r.ok ? `✅ Test trade worked: ${name} ${r.volume} lot at ${r.price} (ticket ${r.ticket}). It closes by itself in a few seconds.` : `⚠️ Test trade failed: ${r.message}`);
      else send(`${r.ok ? "✖️" : "⚠️"} MT5 ${sig.type} · ${labName(d.agent)} ${name}: ${r.message || (r.ok ? "done" : "failed")}`);
    }
    text(res, 200, "OK\n");
  }
  D.serve = (req, res, url) => {
    if (!url.pathname.startsWith("/ea/")) return false;
    if (!eaKey) { text(res, 503, "DEPLOY_KEY is not set on the server\n"); return true; }
    if (!okKey(url.searchParams.get("key"))) { text(res, 401, "wrong key\n"); return true; }
    if (url.pathname === "/ea/poll") { poll(res, url.searchParams.get("since")); return true; }
    if (url.pathname === "/ea/report" && req.method === "POST") { let b = ""; req.on("data", (c) => { b += c; if (b.length > 2e5) req.destroy(); }); req.on("end", () => report(res, b)); return true; }
    text(res, 404, "not found\n"); return true;
  };

  // ---------------------------------------------------------------- Telegram commands for the deployer bot
  function statusText() {
    const s = settings(), a = kvGet("deployAccount", null), last = kvGet("deployLastPoll", 0), pos = kvGet("deployPositions", []), now = Math.floor(Date.now() / 1000);
    const elite = Object.keys(kvGet("labEliteLive", {}));
    return `TraderGze Deployer ${s.paused ? "⏸ PAUSED" : "▶️ running"}\n` +
      `MT5: ${a ? `${a.login} on ${a.server} · balance ${a.balance} · equity ${a.equity} ${a.currency}` : "not connected yet"}\nEA last seen: ${last ? `${Math.round((now - last) / 60)} min ago` : "never"}\n` +
      `Risk ${s.risk}% per trade · max ${s.maxOpen} open · daily stop at -${s.dailyLoss}%\n` + scheduleText() + "\n" +
      `Approved for MT5: ${approved().length ? approved().map((x) => "Agent " + x).join(", ") : "none (only agents you /approve trade)"}\n` +
      `Elite Live, waiting for your review: ${elite.filter((x) => !approved().includes(+x)).map((x) => "Agent " + x).join(", ") || "none"}\n` +
      `Open on MT5: ${pos.length ? pos.map((p) => `${p.side} ${p.symbol} ${p.volume} @ ${p.price} (${p.profit >= 0 ? "+" : ""}${p.profit})`).join("; ") : "none"}`;
  }
  D.statusText = statusText;
  function scheduleText() { const s = settings(), now = D.allowedNow(); return `🗓 MT5 trading schedule (all agents): ${s.days.map((d) => DAY[d]).join(", ")} · ${s.from}-${s.to} · time zone ${s.tz} · news block ${s.newsBlock ? `on (±${s.newsMin} min)` : "off"}\nRight now: ${now.ok ? "✅ trading allowed" : "⛔ " + now.why}`; }
  D.scheduleText = scheduleText;
  async function onMessage(msg) {
    const chat = String(msg.chat.id), [cmd, ...args] = (msg.text || "").trim().split(/\s+/);
    if (cmd === "/start") {
      if (args[0] !== CFG.key) return send("Send /start followed by your ACCESS_KEY to connect this chat.", chat);
      kvSet("deployChat", chat); return send("Connected. This bot reports every trade sent to your MT5.\n" + help, chat);
    }
    if (chat !== String(kvGet("deployChat", ""))) return send("This bot is private.", chat);
    if (cmd === "/status") return send(statusText());
    if (cmd === "/pause") { setSettings({ paused: true }); return send("⏸ Paused: no new trades go to MT5. Open trades keep their SL/TP. /resume to continue."); }
    if (cmd === "/resume") { setSettings({ paused: false }); return send("▶️ Running: Elite Live trades go to MT5 again."); }
    if (cmd === "/risk") { const v = parseFloat(args[0]); if (!(v > 0 && v <= 20)) return send("Use /risk <percent>, e.g. /risk 2 (between 0.1 and 20)."); setSettings({ risk: v }); return send(`Risk set to ${v}% of balance per trade.${v > 3 ? " ⚠️ Above 3% a few losses in a row hurt a lot." : ""}`); }
    if (cmd === "/maxopen") { const v = parseInt(args[0]); if (!(v >= 1 && v <= 20)) return send("Use /maxopen <number>, e.g. /maxopen 3"); setSettings({ maxOpen: v }); return send(`At most ${v} trades open at once.`); }
    if (cmd === "/dailyloss") { const v = parseFloat(args[0]); if (!(v >= 1 && v <= 100)) return send("Use /dailyloss <percent>, e.g. /dailyloss 20"); setSettings({ dailyLoss: v }); return send(`New trades stop for the day once the account is down ${v}% that day.`); }
    if (cmd === "/approve") { const id = parseInt(args[0]); if (!id) return send("Use /approve <agent number>, e.g. /approve 12"); if (!passed(id)) return send(`Agent ${id} has not passed Elite Live (or, for a free agent, 30 profitable live trades), so it can't be approved. /candidates shows the ones that have.`);
      const fr = D.approveSnapshot ? D.approveSnapshot(id) : D.freeze ? D.freeze(id) : { ok: true, message: "" }; if (!fr.ok) return send("Not approved: " + fr.message);
      if (!approved().includes(id)) kvSet("deployApproved", approved().concat([id])); return send(`✅ Agent ${id} approved: its next trades go to MT5 (risk ${settings().risk}% each). /unapprove ${id} to stop.\n${fr.message}`); }
    if (cmd === "/freeze") { const id = parseInt(args[0]); if (!id) return send("Use /freeze <agent number>, e.g. /freeze 567"); const fr = D.freeze ? D.freeze(id) : { ok: false, message: "not available" }; return send(fr.ok ? fr.message + (approved().includes(id) ? "\n(It is approved, so this new version now trades on MT5.)" : "\nNothing goes to MT5.") : "Not frozen: " + fr.message); }
    if (cmd === "/unfreeze") { const id = parseInt(args[0]); if (D.unfreeze) D.unfreeze(id); kvSet("deployApproved", approved().filter((x) => x !== id)); return send(`Agent ${id}: snapshot deleted${"" }. It does not trade on MT5.`); }
    if (cmd === "/frozen") { const xs = D.frozenStats ? D.frozenStats() : []; return send(xs.length ? "🧊 Frozen versions (paper results since frozen):\n" + xs.map((x) => `Agent ${x.id} · frozen ${new Date(x.at * 1000).toISOString().slice(0, 10)} · ${x.onMT5 ? "💹 on MT5" : "paper only"} · ${x.trades} trades${x.trades ? `, ${Math.round(x.winRate * 100)}% win, ${x.R > 0 ? "+" : ""}${x.R}R, dd ${x.dd}R` : ""}${x.open ? ` · ${x.open} open` : ""}`).join("\n") : "Nothing frozen yet. /freeze <agent number>"); }
    if (cmd === "/unapprove") { const id = parseInt(args[0]); kvSet("deployApproved", approved().filter((x) => x !== id)); return send(`⛔ Agent ${id} no longer trades on MT5. Its open MT5 trades keep their SL/TP (/closeall closes everything). Its frozen version stays and is paper-tracked (/unfreeze ${id} deletes it).`); }
    if (cmd === "/approved") return send(approved().length ? "Approved for MT5: " + approved().map((x) => "Agent " + x).join(", ") : "No agent approved yet. /candidates");
    if (cmd === "/candidates") { const el = [...new Set(Object.keys(kvGet("labEliteLive", {})).concat(Object.keys(kvGet("labFreeReady", {}))))].map(Number); return send(el.length ? "Passed Elite Live:\n" + el.map((x) => `Agent ${x} ${approved().includes(x) ? "✅ approved" : "⏳ waiting for your review → /approve " + x}`).join("\n") + "\n\nData: app → Settings → Download data → Elite agents / Elite trades" : "No agent has passed Elite Live yet (it needs 100 live paper trades with 85%+ win, PF 2+, max 6R drawdown, never 3 losses in a row)."); }
    if (cmd === "/timezone") { const tz = args[0]; if (!tz) return send("Use /timezone <zone>, e.g. /timezone Europe/Berlin, /timezone Asia/Kolkata, or an offset like /timezone +2"); try { localNow(tz); } catch (e) { return send(`Unknown time zone "${tz}". Examples: Europe/London, Europe/Berlin, America/New_York, Asia/Dubai, Asia/Kolkata, or +2 / -5`); } setSettings({ tz }); return send(`Time zone set to ${tz}.\n` + scheduleText()); }
    if (cmd === "/days") { const want = (args.join(",").toUpperCase().match(/MON|TUE|WED|THU|FRI|SAT|SUN/g) || []).map((d) => DAY.indexOf(d)); if (!want.length) return send("Use /days MON,TUE,WED,THU,FRI (any of MON TUE WED THU FRI SAT SUN)"); setSettings({ days: [...new Set(want)].sort() }); return send(scheduleText()); }
    if (cmd === "/hours") { const m = String(args[0] || "").match(/^(\d{1,2}(?::\d\d)?)-(\d{1,2}(?::\d\d)?)$/); if (!m) return send("Use /hours 08:00-20:00 (your local time; 22:00-06:00 works overnight; 00:00-24:00 = all day)"); setSettings({ from: m[1].includes(":") ? m[1] : m[1] + ":00", to: m[2].includes(":") ? m[2] : m[2] + ":00" }); return send(scheduleText()); }
    if (cmd === "/news") { const on = args[0] !== "off", min = parseInt(args[1]) || settings().newsMin; setSettings({ newsBlock: on, newsMin: min }); return send(on ? `📰 News block on: no new MT5 trades from ${min} min before to ${min} min after a high-impact event (Forex Factory: USD and the markets you trade).` : "📰 News block off."); }
    if (cmd === "/schedule") return send(scheduleText());
    if (cmd === "/closeall") { push("closeall", "closeall-" + Date.now(), {}); return send("✖️ Asked the EA to close every TraderGze trade on MT5."); }
    if (cmd === "/test") { const k = ({ gold: "GOLD", btc: "BTC", silver: "SILVER" })[String(args[0] || "gold").toLowerCase()] || "GOLD"; push("test", "test-" + Date.now(), { ticker: k, side: "long", slPips: 10, tpPips: 20, pip: LN.PIP[k] }); return send(`🧪 Sent a test trade (${LN.ticker(k).name}, smallest lot, closes itself in a few seconds). The EA answers within ~10 seconds.`); }
    if (cmd === "/log") { const l = kvGet("deployLog", []).slice(-10).reverse(); return send(l.length ? l.map((x) => `${new Date(x.t * 1000).toISOString().slice(5, 16).replace("T", " ")} ${x.type} ${x.ticker || ""} ${x.ok ? "✅" : "⚠️"} ${x.message || ""}`).join("\n") : "Nothing sent to MT5 yet."); }
    return send(help);
  }
  const help = "Commands: /status /schedule /timezone <zone> /days MON,TUE,… /hours 08:00-20:00 /news on|off [minutes] /candidates /freeze <n> /frozen /unfreeze <n> /approve <n> /unapprove <n> /approved /pause /resume /risk <percent> /maxopen <n> /dailyloss <percent> /closeall /test gold|btc|silver /log";
  D.onMessage = onMessage;
  D.loop = async function () {
    if (!token) return;
    let offset = kvGet("deployTgOffset", 0);
    for (;;) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?timeout=50&offset=${offset}`).then((x) => x.json());
        for (const u of r.result || []) { offset = u.update_id + 1; kvSet("deployTgOffset", offset); if (u.message) onMessage(u.message).catch((e) => log("deploy bot:", e.message)); }
      } catch (e) { await new Promise((ok) => setTimeout(ok, 5000)); }
    }
  };
  /** Every few minutes: warn once if the EA stopped asking for trades. */
  D.watch = () => {
    const last = kvGet("deployLastPoll", 0), now = Math.floor(Date.now() / 1000), warned = kvGet("deployWarned", false);
    if (last && now - last > 600 && !warned) { kvSet("deployWarned", true); send("⚠️ The MT5 EA has not checked in for 10 minutes. Is MT5 / the VPS running? Trades are queued meanwhile."); }
    if (last && now - last < 120 && warned) { kvSet("deployWarned", false); send("✅ The MT5 EA is back online."); }
  };
  return D;
};

return module.exports; })()({ db, kvGet, kvSet, log, LN, labName, fmtP, CFG });
/** High-impact news (Forex Factory, USD) within ± minutes of a time: blocks new MT5 trades when /news is on. */
DP.newsNear = (at, min) => { const ev = (research.calendar && research.calendar.data) || [], t = at / 1000; const e = ev.find((x) => x.impact === "High" && x.country === "USD" && Math.abs(x.time - t) <= min * 60); return e ? `${e.title} at ${new Date(e.time * 1000).toISOString().slice(11, 16)} UTC` : null; };
DP.freeze = freezeAgent; DP.unfreeze = unfreezeAgent; DP.approveSnapshot = approveSnapshot; DP.frozenStats = frozenStats;
function eliteLiveRating(id) {
  const el = kvGet("labEliteLive", {}); if (!el[id]) return null;
  return BL.rate(Object.keys(el).map((a) => ({ id: +a, R: liveMetrics(+a).totalR })))[id] || null;
}
function labFollow(id, on) { let l = kvGet("labFollow", []).filter((x) => x !== id); if (on) l.push(id); kvSet("labFollow", l); return l; }

// ---------------------------------------------------------------- BTC flow: hourly exchange in / out, BTC vs stablecoins
function flowBars(hours = 48) {
  const now = Math.floor(Date.now() / 1000), h0 = Math.floor(now / 3600) - hours + 1;
  const r = db.prepare(`SELECT time / 3600 AS h, CASE WHEN asset = 'BTC' THEN 'btc' ELSE 'st' END AS a, type, SUM(usd) AS usd, COUNT(*) AS n FROM events WHERE time >= ? AND chain != 'hyperliquid' AND type IN ('inflow', 'outflow') GROUP BY h, a, type`).all(h0 * 3600);
  const bars = Array.from({ length: hours }, (_, i) => ({ t: (h0 + i) * 3600, btcIn: 0, btcOut: 0, stIn: 0, stOut: 0 }));
  for (const x of r) { const b = bars[x.h - h0]; if (b) b[x.a + (x.type === "inflow" ? "In" : "Out")] += x.usd; }
  const byAsset = db.prepare("SELECT asset, type, SUM(usd) usd FROM events WHERE time >= ? AND chain != 'hyperliquid' AND type IN ('inflow', 'outflow') GROUP BY asset, type").all(now - 86400);
  return { bars, byAsset };
}

// ---------------------------------------------------------------- BTC whales: exchange in / out only
function whaleMoves(days = 7) {
  const ev = rows("SELECT data FROM events WHERE time > ? AND asset = 'BTC' AND type IN ('inflow', 'outflow') ORDER BY time DESC LIMIT 400", Math.floor(Date.now() / 1000) - days * 86400);
  const sum = (t, h) => ev.filter((e) => e.type === t && e.time > Date.now() / 1000 - h * 3600).reduce((s, e) => s + e.amount, 0);
  return { moves: ev.slice(0, 150), d1: { in: sum("inflow", 24), out: sum("outflow", 24) }, d7: { in: sum("inflow", 168), out: sum("outflow", 168) }, holders: cache.holders };
}

// ---------------------------------------------------------------- personal wallet tracker
// any address on Bitcoin, Litecoin, the EVM chains, Tron or Solana; every new transaction alerts on Telegram
const walletData = {};
let mids = {};
async function walletPrices() { try { const m = await AG.post({ type: "allMids" }); mids = Object.fromEntries(Object.entries(m || {}).map(([k, v]) => [k.toUpperCase(), +v])); mids.POL = mids.POL || mids.MATIC; mids.XDAI = 1; mids.WETH = mids.ETH; } catch {} if (price) mids.BTC = price; return mids; }
async function inspectWallet(w, force) {
  const hit = walletData[w.address];
  if (!force && hit && Date.now() - hit.at < 180e3) return hit.data;
  // a 0x address is checked on all EVM chains once a day, otherwise only on the chains where it has activity
  const full = w.chain === "auto" && (!w.chains || !w.chains.length || Date.now() - (w.chainsAt || 0) > 86400e3);
  const data = await WL.inspect(w.address, w.chain === "auto" ? (full ? null : w.chains) : w.chain, await walletPrices());
  if (full) { w.chains = data.chains; w.chainsAt = Date.now(); }
  walletData[w.address] = { at: Date.now(), data };
  return data;
}
const WALLET_MAX = 200, WALLETS_PER_RUN = 25;      // 100+ wallets: each run refreshes the 25 checked longest ago
async function refreshWallets() {
  const list = kvGet("wallets", []).slice().sort((a, b) => (a.checked || 0) - (b.checked || 0)).slice(0, WALLETS_PER_RUN), seen = kvGet("walletSeen2", {}), done = {};
  for (const w of list) {
    try {
      const d = await inspectWallet(w, true), had = seen[w.address];
      w.summary = { totalUsd: d.totalUsd, balances: d.balances.slice(0, 6), chains: d.chains, last: d.summary.last, txs: d.summary.txs }; w.error = d.chains.length ? null : d.errors.join("; ") || null;
      if (had) for (const t of d.txs.filter((t) => !had.includes(t.hash + t.asset)).slice(0, 5))
        alertSend(`👛 ${w.name}: ${t.dir === "in" ? "received" : t.dir === "out" ? "sent" : "moved"} ${X.fmtNum(t.amount, t.amount < 10 ? 4 : 0)} ${t.asset}${t.usd != null ? ` (${X.fmtUsd(t.usd)})` : ""} on ${WL.CHAINS[t.chain]}${t.counterparty ? `\n${t.dir === "in" ? "from" : "to"} ${t.counterparty}` : ""}\n${WL.txUrl(t.chain, t.hash)}`, "wallet");
      seen[w.address] = d.txs.map((t) => t.hash + t.asset).slice(0, 300);
    } catch (e) { w.error = e.message; }
    w.checked = Date.now(); done[w.address] = w;
    await new Promise((ok) => setTimeout(ok, 500));
  }
  // write back onto the current list, so wallets added or removed meanwhile are kept as they are
  const now = kvGet("wallets", []), keep = new Set(now.map((w) => w.address));
  kvSet("wallets", now.map((w) => done[w.address] ? Object.assign({}, w, { summary: done[w.address].summary, error: done[w.address].error, checked: done[w.address].checked, chains: done[w.address].chains, chainsAt: done[w.address].chainsAt }) : w));
  kvSet("walletSeen2", Object.fromEntries(Object.entries(seen).filter(([a]) => keep.has(a))));
}
function seen2(w, d) { const seen = kvGet("walletSeen2", {}); seen[w.address] = d.txs.map((t) => t.hash + t.asset).slice(0, 300); kvSet("walletSeen2", seen); }
function walletsView() { return kvGet("wallets", []); }
function setWallet(address, name, on, chain) {
  address = String(address || "").trim();
  const chains = WL.detect(address);
  if (on && !chains.length) throw new Error("Unrecognised address. Supported: Bitcoin, Litecoin, Ethereum, Base, Arbitrum, Optimism, Polygon, Gnosis, Tron, Solana.");
  let list = kvGet("wallets", []).filter((w) => w.address.toLowerCase() !== address.toLowerCase());
  if (on) list.push({ address: /^0x/i.test(address) ? address.toLowerCase() : address, name: name || X.short(address), chain: chain && chain !== "auto" ? chain : chains.length === 1 ? chains[0] : "auto", added: Math.floor(Date.now() / 1000) });
  if (on && list.length > WALLET_MAX) throw new Error(`You can track up to ${WALLET_MAX} wallets. Remove some with /untrack first.`);
  kvSet("wallets", list);
  if (on) { const w = list[list.length - 1]; inspectWallet(w, true).then((d) => { seen2(w, d); }).catch(() => {}); }
  return list;
}

// ---------------------------------------------------------------- macro & research feeds (each on its own clock)
const research = {};
async function refreshResearch(force) {
  const due = (k, ms) => force || !research[k] || Date.now() - research[k].at > ms;
  const run = async (k, ms, fn) => { if (!due(k, ms)) return; try { research[k] = { at: Date.now(), data: await fn() }; } catch (e) { research[k] = { at: Date.now() - ms + 600e3, error: e.message, data: research[k] && research[k].data }; } };
  await run("calendar", 3600e3, RS.calendar);
  await run("insiders", 3600e3, () => RS.insiders());
  await run("feeds", 2 * 3600e3, () => RS.readFeeds());
  await run("cot", 12 * 3600e3, RS.cot);
  await run("funds", 24 * 3600e3, () => RS.superinvestors());
}
const rsOut = (k) => (research[k] ? { at: Math.floor(research[k].at / 1000), data: research[k].data || null, error: research[k].error || null } : { pending: true });

// ---------------------------------------------------------------- Telegram
const tg = (method, body) => CFG.telegramToken ? fetch(`https://api.telegram.org/bot${CFG.telegramToken}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json()) : Promise.resolve(null);
const tgSend = (text, chat = CFG.telegramChat) => (chat ? tg("sendMessage", { chat_id: chat, text: text.slice(0, 4000), disable_web_page_preview: true }) : null);
/** Alerts (not command replies): /alerts off pauses all of them, /walletalerts off only wallet moves. */
function alertSend(text, kind) {
  if (kvGet("alertsOff", false)) return null;
  if (kind === "wallet" && kvGet("walletAlertsOff", false)) return null;
  return tgSend(text);
}
const icon = { bullish: "🟢", bearish: "🔴", neutral: "⚪" };
function telegramAlert(a) {
  if (kvGet("muteUntil", 0) > Date.now()) return;
  const e = a.event, link = e && e.hash && X.EXPLORER[e.chain] ? `\n${X.EXPLORER[e.chain]}${e.hash}` : "";
  alertSend(`${icon[a.bias] || ""} ${a.severity.toUpperCase()}: ${a.title}\n${a.why}${link}`);
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
    return tgSend("Connected. You'll get high and critical alerts here.\nCommands: /status /flows /whales /odds /brief /traders /wallets /agents /mute 2h /unmute", chat);
  }
  if (chat !== String(CFG.telegramChat)) return tgSend("This bot is private.", chat);
  if (cmd === "/status") return tgSend(`Tracking since ${new Date(stats.started).toUTCString()}\n${Object.entries(status).map(([k, v]) => `${X.CHAIN_NAME[k] || k}: ${v}`).join("\n")}\nTransfers recorded: ${db.prepare("SELECT COUNT(*) n FROM events").get().n}\nAnomalies: ${db.prepare("SELECT COUNT(*) n FROM anomalies").get().n}\nLearned exchange wallets: ${db.prepare("SELECT COUNT(*) n FROM labels WHERE source = 'learned'").get().n}`);
  if (cmd === "/flows") return tgSend(flowText());
  if (cmd === "/whales") return tgSend(cache.holders ? cache.holders.rows.filter((h) => !h.error).map((h) => `${h.name}: ${X.fmtNum(h.balance, 0)} BTC, 7d ${h.d7 >= 0 ? "+" : ""}${X.fmtNum(h.d7, 0)} (${h.action})`).join("\n") : "Still loading.");
  if (cmd === "/perps") { const p = cache.perps || {}; return tgSend(p.hl ? `Hyperliquid BTC ${X.fmtNum(p.hl.mark, 0)} · funding ${(p.hl.funding * 100).toFixed(4)}%/h · OI ${X.fmtUsd(p.hl.oiUsd)}${p.pos && p.pos.traders ? `\nTop traders ${(p.pos.longShare * 100).toFixed(0)}% long BTC (${p.pos.traders} positions, median ${p.pos.medianLeverage}x)` : ""}` : "Still loading."); }
  if (cmd === "/odds") return tgSend(cache.macro && cache.macro.markets ? cache.macro.markets.slice(0, 10).map((m) => `${m.event}: ${m.question} ${m.yes != null ? Math.round(m.yes * 100) + "%" : ""}`).join("\n") : "Still loading.");
  if (cmd === "/brief") { tgSend("Reading the last 24 hours…"); try { return tgSend(await briefText()); } catch (e) { return tgSend("Briefing failed: " + e.message); } }
  if (cmd === "/traders") return tgSend(cache.traders && cache.traders.rows.length ? "Top BTC traders (90 days, whole positions; win ≥ 70%, PF ≥ 2):\n" + cache.traders.rows.slice(0, 10).map((t, i) => `${i + 1}. ${t.name} · win ${Math.round(t.stats.winRate * 100)}% · PF ${isFinite(t.stats.profitFactor) ? t.stats.profitFactor.toFixed(2) : "∞"} · ${t.stats.trades} positions · ${X.fmtUsd(t.stats.pnl)} · ${t.confidence} confidence\n   ${t.address}`).join("\n") + "\n\n/follow <address> to get their trades" : "No BTC trader passes the filters yet; the server checks 400 more every hour.");
  if (cmd === "/follow" && args[0]) { const l = follow(args[0], args.slice(1).join(" "), true); return tgSend(`Following ${l.length} trader(s). You'll get their BTC trades here.`); }
  if (cmd === "/following") { const l = kvGet("follows", []); return tgSend(l.length ? `Following (${status.copy || "—"}):\n` + l.map((f) => `${f.name} · ${f.cat === "stocks" ? "stocks" : f.cat === "commodities" ? "commodities & energy" : "BTC"} trades\n   ${f.address}`).join("\n") : "You don't follow anyone yet."); }
  if (cmd === "/unfollow" && args[0]) { follow(args[0], "", false); return tgSend("Unfollowed."); }
  if (cmd === "/jobs") return tgSend(jobsText());
  if (cmd === "/agents") { const v = labView(), R = v.agents.filter((a) => a.kind !== "free"), P = v.pools; return tgSend(R.length ? `Agent lab · generation ${v.gen}\nRule agents: $${P.rule.capital} total (started $${P.rule.start}) · ${P.rule.trading}/${P.rule.n} trading · styles 5m ${P.rule.styles.scalp5} / 15m ${P.rule.styles.scalp} / 4h ${P.rule.styles.swing}\n` + R.slice(0, 10).map((a, k) => `${k + 1}. ${a.name} ${a.status === "eliteLive" ? "🏆✅" : a.status === "elite" ? "🏆" : a.status === "edge" ? "🧪" : ""} ${BL.STYLE_NAME[a.style]} ${a.tickers.join("/")} · test ${a.bt ? `${a.bt.trades} tr ${a.bt.winRate != null ? Math.round(a.bt.winRate * 100) : 0}% ${a.bt.totalR}R` : "—"} · live $${a.capital.equity} (${a.capital.trades} tr)`).join("\n") + "\n\n/free · /elite · /edges · /followagent <n>" : "The lab starts about 5 minutes after the server."); }
  if (cmd === "/free") { const v = labView(), F = v.agents.filter((a) => a.kind === "free").sort((a, b) => b.capital.equity - a.capital.equity || (b.btCap ? b.btCap.roi : 0) - (a.btCap ? a.btCap.roi : 0)); return tgSend(F.length ? `Free agents (no rules, $500 each) · $${v.pools.free.capital} total · ${v.pools.free.busted} busted\n` + F.slice(0, 12).map((a, k) => `${k + 1}. ${a.name} ${a.busted ? "💀" : ""} ${BL.STYLE_NAME[a.style]} ${a.tickers.join("/")} risk ${a.riskPct}% · live $${a.capital.equity} (${a.capital.trades} tr, ${(a.capital.roiPerDay * 100).toFixed(2)}%/day) · test $500→$${a.btCap ? a.btCap.equity : "—"}`).join("\n") : "Free agents start with the next evolution (every 30 minutes)."); }
  if (cmd === "/elite") { const v = labView(), e = v.agents.filter((a) => a.elite || a.eliteLive); return tgSend(e.length ? "🏆 Elite agents:\n" + e.map((a) => `${a.eliteLive ? "🏆✅ Elite Live" : "🏆 Elite Edge"} · ${a.name} · ${a.rating} · test ${a.bt.trades} tr ${Math.round(a.bt.winRate * 100)}% PF ${isFinite(a.bt.profitFactor) ? a.bt.profitFactor.toFixed(2) : "∞"} ${a.bt.totalR}R · live ${a.live.trades}/100 tr${a.live.trades ? ` ${Math.round(a.live.winRate * 100)}% ${a.live.totalR}R` : ""}`).join("\n") : "No Elite agent yet (needs 85%+ win, PF 2+, 60+ unseen-data trades, never 3 losses in a row)."); }
  if (cmd === "/edges") { const v = labView(), e = v.agents.filter((a) => ["edge", "elite", "eliteLive"].includes(a.status)); return tgSend(e.length ? e.slice(0, 8).map((a) => `${a.status === "eliteLive" ? "🏆✅" : a.status === "elite" ? "🏆" : "🧪"} ${a.name}: ${a.describe}\nTest: ${a.bt.trades} trades, ${Math.round(a.bt.winRate * 100)}% win, ${a.bt.totalR}R, dd ${a.bt.maxDD}R · Live: ${a.live.trades} trades${a.live.trades ? `, ${Math.round(a.live.winRate * 100)}% win, ${a.live.totalR}R` : ""}\n${a.rules.map((r) => "• " + r.rule).join("\n")}`).join("\n\n") : "No edge found yet. The lab evolves every 30 minutes."); }
  if (cmd === "/followagent" && args[0]) { labFollow(+args[0], true); return tgSend(`Following Agent ${+args[0]}: you'll get its paper trades here.`); }
  if (cmd === "/unfollowagent" && args[0]) { labFollow(+args[0], false); return tgSend(`Stopped following Agent ${+args[0]}.`); }
  if (cmd === "/wallets") { const l = kvGet("wallets", []).slice().sort((a, b) => ((b.summary && b.summary.totalUsd) || 0) - ((a.summary && a.summary.totalUsd) || 0)); return tgSend(l.length ? `${l.length} wallets tracked${kvGet("walletAlertsOff", false) ? " (alerts off)" : ""}, total ${X.fmtUsd(l.reduce((s, w) => s + ((w.summary && w.summary.totalUsd) || 0), 0))}:\n` + l.slice(0, 40).map((w) => `${w.name}: ${w.summary ? X.fmtUsd(w.summary.totalUsd) : "reading…"}`).join("\n") + (l.length > 40 ? `\n…and ${l.length - 40} more (see the Wallets tab)` : "") : "No tracked wallets. /track <address> <name>"); }
  if (cmd === "/track" && args[0]) { try { setWallet(args[0], args.slice(1).join(" "), true); return tgSend("Tracking. You'll get its moves here."); } catch (e) { return tgSend(e.message); } }
  if (cmd === "/untrackall") { const n = kvGet("wallets", []).length; kvSet("wallets", []); kvSet("walletSeen2", {}); return tgSend(n ? `Stopped tracking all ${n} wallet(s).` : "You weren't tracking any wallets."); }
  if (cmd === "/untrack" && args[0]) { setWallet(args[0], "", false); return tgSend("Stopped tracking."); }
  if (cmd === "/alerts") { const off = args[0] === "off"; kvSet("alertsOff", off); return tgSend(off ? "🔕 All alerts off. Commands still work. /alerts on to turn them back on." : "🔔 All alerts on."); }
  if (cmd === "/walletalerts") { const off = args[0] === "off"; kvSet("walletAlertsOff", off); return tgSend(`Wallet alerts ${off ? "off" : "on"} (${kvGet("wallets", []).length} wallets tracked).`); }
  if (cmd === "/mute") { const h = parseFloat(args[0]) || 2; kvSet("muteUntil", Date.now() + h * 3600e3); return tgSend(`Muted for ${h} hours.`); }
  if (cmd === "/unmute") { kvSet("muteUntil", 0); return tgSend("Alerts back on."); }
  return tgSend("Commands: /status /flows /whales /odds /brief /traders /follow <addr> /following /unfollow <addr> /wallets /track <addr> <name> /untrack <addr> /untrackall /walletalerts on|off /jobs /agents /free /edges /elite /followagent <n> /alerts on|off /mute 2h /unmute");
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
  alertSend(text);
}

// ---------------------------------------------------------------- downloads (CSV for Excel / Google Sheets, or the whole database)
const csvCell = (v) => { if (v == null) return ""; if (typeof v === "object") v = JSON.stringify(v); const t = String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const iso = (t) => (t ? new Date((t > 1e12 ? t : t * 1000)).toISOString().replace("T", " ").slice(0, 19) : "");
const EXPORTS = {
  "opportunity-database": () => db.prepare("SELECT data FROM ldb WHERE ok = 1").all().map((r) => JSON.parse(r.data)).map((e) => Object.assign({ ticker: e.ticker, style: e.style, side: e.side, entry_time: iso(e.t), move_pips: e.movePips, drawdown_pips: e.ddPips, reasons: e.reasons.join("; "), trader: e.trader, demoted: !!e.demoted }, Object.fromEntries(LN.FEATURES2.map((n, k) => [n, e.f[k] != null ? +e.f[k].toFixed(4) : ""])))),
  "opportunity-rejected": () => db.prepare("SELECT l.id, l.style AS reason, t.ticker, t.side, t.t0, t.px0, t.t1, t.px1, t.pnl, t.trader FROM ldb l JOIN ltrades t ON t.id = l.id WHERE l.ok = 0").all().map((r) => ({ reason: r.reason, ticker: r.ticker, side: r.side, entry_time: iso(r.t0), entry: r.px0, exit_time: iso(r.t1), exit: r.px1, pnl_usd: r.pnl, trader: r.trader })),
  "learned-trades": () => db.prepare("SELECT * FROM ltrades ORDER BY t0").all().map((r) => ({ ticker: r.ticker, coin: r.coin, trader: r.trader, side: r.side, entry_time: iso(r.t0), entry: r.px0, exit_time: iso(r.t1), exit: r.px1, pnl_usd: r.pnl })),
  "copy-traders": () => db.prepare("SELECT address, ticker, ok, rank, data, at FROM tstats ORDER BY ticker, ok DESC, rank DESC").all().map((r) => { const d = JSON.parse(r.data), s = d.stats; return { ticker: r.ticker, name: r.ok ? alias(r.address, r.ticker) : "", address: r.address, qualifies: !!r.ok, why_not: d.why.join("; "), positions: s.trades, win_rate: s.winRate, profit_factor: isFinite(s.profitFactor) ? s.profitFactor : "inf", payoff: s.payoff, pnl_90d: s.pnl, pnl_30d: s.pnl30, max_drawdown: s.maxDrawdown, median_hold_min: s.medianHoldSec != null ? Math.round(s.medianHoldSec / 60) : "", positions_per_day: s.perDay, confidence: s.confidence, account_value: d.accountValue, checked: iso(r.at) }; }),
  "all-agents": () => labView().agents.map((a) => ({ agent: a.name, kind: a.kind, status: a.status, rating: a.rating || "", style: a.style, markets: a.tickers.join("; "), risk_pct: a.riskPct, live_capital: a.capital.equity, live_roi: a.capital.roi, live_roi_per_day: a.capital.roiPerDay, live_trades: a.capital.trades, live_worst_drop: a.capital.maxDDPct,
    live_win_rate: a.live.winRate, live_pf: a.live.profitFactor, live_R: a.live.totalR, test_capital: a.btCap ? a.btCap.equity : "", test_roi: a.btCap ? a.btCap.roi : "", test_roi_per_day: a.btCap ? a.btCap.roiPerDay : "", test_trades: a.bt ? a.bt.trades : "", test_win_rate: a.bt ? a.bt.winRate : "", test_pf: a.bt ? a.bt.profitFactor : "", test_R: a.bt ? a.bt.totalR : "", test_dd_R: a.bt ? a.bt.maxDD : "", generation: a.gen, strategy: a.describe, rules: a.rules.map((r) => r.rule).join("; ") })),
  "agent-trades": () => db.prepare("SELECT * FROM lab_trades ORDER BY t").all().map((r) => { const o = JSON.parse(r.data); return { agent: labName(r.agent), opened: iso(r.t), closed: iso(r.tc), market: r.ticker, style: r.style, side: r.side, shadow: !!r.shadow, confidence: r.p, entry: o.plan.entry, sl: o.plan.stop, tp: o.plan.target, sl_pips: o.slPips, tp_pips: o.tpPips, risk_pct: o.riskPct, equity_before: o.equity, status: r.status, R: r.R, pnl_usd: o.pnl }; }),
  "elite-agents": () => labView().agents.filter((a) => a.elite || a.eliteLive).map((a) => ({ agent: a.name, level: a.eliteLive ? "Elite Live" : "Elite Edge", rating: a.rating, style: a.style, markets: a.tickers.join("; "), strategy: a.describe, rules: a.rules.map((r) => r.rule).join("; "),
    test_trades: a.bt.trades, test_win_rate: a.bt.winRate, test_pf: a.bt.profitFactor, test_R: a.bt.totalR, test_max_dd_R: a.bt.maxDD, test_max_loss_streak: a.bt.maxLossStreak, live_trades: a.live.trades, live_win_rate: a.live.winRate, live_pf: a.live.profitFactor, live_R: a.live.totalR, live_max_dd_R: a.live.maxDD, live_max_loss_streak: a.live.maxLossStreak, generation: a.gen })),
  "elite-trades": () => { const el = new Set(labView().agents.filter((a) => a.elite || a.eliteLive).map((a) => a.id)), out = [];
    for (const g of labAgents().filter((x) => el.has(x.id))) for (const x of g.btTrades || []) out.push({ agent: labName(g.id), kind: "unseen-data test", opened: iso(x.t), closed: iso(x.tc), market: x.ticker, style: g.style, side: x.side, confidence: x.p, R: x.R });
    for (const r of db.prepare(`SELECT * FROM lab_trades WHERE agent IN (${[...el].map(() => "?").join(",") || "NULL"}) ORDER BY t`).all(...el)) { const o = JSON.parse(r.data); out.push({ agent: labName(r.agent), kind: r.shadow ? "live paper (shadow)" : "live paper", opened: iso(r.t), closed: iso(r.tc), market: r.ticker, style: r.style, side: r.side, confidence: r.p, entry: o.plan.entry, sl: o.plan.stop, tp: o.plan.target, sl_pips: o.slPips, tp_pips: o.tpPips, status: r.status, R: r.R }); }
    return out; },
  "followed-trades": () => kvGet("copyFeed", []).map((f) => ({ time: iso(f.time), trader: f.name, address: f.user, coin: f.coin, action: f.dir, price: f.px, size: f.sz, pnl: f.pnl })),
  "wallets": () => kvGet("wallets", []).map((w) => ({ name: w.name, address: w.address, chains: ((w.summary && w.summary.chains) || [w.chain]).join("; "), value_usd: w.summary ? w.summary.totalUsd : "", balances: w.summary ? w.summary.balances.map((b) => `${b.amount} ${b.asset}`).join("; ") : "", last_tx: w.summary ? iso(w.summary.last) : "", added: iso(w.added) })),
  "whale-transfers": () => rows("SELECT data FROM events WHERE time > ? AND chain != 'hyperliquid' ORDER BY time DESC LIMIT 50000", Math.floor(Date.now() / 1000) - 30 * 86400).map((e) => ({ time: iso(e.time), chain: e.chain, asset: e.asset, amount: e.amount, usd: e.usd, type: e.type, from: e.from, from_label: e.fromLabel || "", to: e.to, to_label: e.toLabel || "", tx: e.hash })),
};
function exportData(res, what) {
  if (what === "database") {
    const f = path.join(path.dirname(CFG.db), `tradergze-backup-${Date.now()}.db`);
    try { db.exec(`VACUUM INTO '${f.replace(/'/g, "")}'`); } catch (e) { return json(res, 500, { error: e.message }); }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="tradergze-${new Date().toISOString().slice(0, 10)}.db"` });
    return fs.createReadStream(f).on("close", () => fs.unlink(f, () => {})).pipe(res);
  }
  if (!EXPORTS[what]) return json(res, 200, { files: Object.keys(EXPORTS).concat(["database"]) });
  let list; try { list = EXPORTS[what](); } catch (e) { return json(res, 500, { error: e.message }); }
  const cols = [...new Set(list.flatMap((r) => Object.keys(r)))];
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${what}-${new Date().toISOString().slice(0, 10)}.csv"` });
  res.end("\ufeff" + [cols.join(","), ...list.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n"));
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
  if (DP.serve(req, res, url)) return;                  // the MT5 EA (its own DEPLOY_KEY)
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
  if (p === "/api/watch") {
    const now = Date.now();
    if (!cache.watch || now - cache.watch.at > 60000) { if (!cache.watchP) cache.watchP = MK.watchlist().then((rows) => (cache.watch = { at: Date.now(), rows })).finally(() => (cache.watchP = null)); }
    if (cache.watch) return json(res, 200, { groups: MK.GROUPS.map((g) => g[0]), ...cache.watch });
    cache.watchP.then(() => json(res, 200, { groups: MK.GROUPS.map((g) => g[0]), ...cache.watch }), (e) => json(res, 502, { error: e.message }));
    return;
  }
  if (p === "/api/chart") {
    const sym = q("symbol"), range = q("range") || "6M", k = sym + "|" + range;
    cache.charts = cache.charts || {};
    const hit = cache.charts[k];
    if (hit && Date.now() - hit.at < (range === "1D" ? 60000 : 600000)) return json(res, 200, hit.data);
    MK.candles(sym, range).then((data) => { cache.charts[k] = { at: Date.now(), data }; json(res, 200, data); }, (e) => json(res, 502, { error: e.message }));
    return;
  }
  if (p === "/api/export") return exportData(res, q("what"));
  if (p === "/api/lab") return json(res, 200, labView());
  if (p === "/api/lab/review" && req.method === "GET") return json(res, 200, { agents: reviewList(), schedule: DP.scheduleText ? DP.scheduleText() : "" });
  if (p === "/api/lab/review" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const { id, action } = JSON.parse(b || "{}"); json(res, 200, reviewAction(+id, action)); } catch (e) { json(res, 400, { error: e.message }); } }); return; }
  if (p === "/api/jobs") return json(res, 200, { text: jobsText(), jobs });
  if (p === "/api/lab/agent") { const v = labAgentView(+q("id")); return v ? json(res, 200, v) : json(res, 404, { error: "This agent was replaced by a better one." }); }
  if (p === "/api/lab/follow" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const { id, on } = JSON.parse(b || "{}"); json(res, 200, { follow: labFollow(+id, on !== false) }); }); return; }
  if (p === "/api/humandb") return json(res, 200, dbView());
  if (p === "/api/flowbars") return json(res, 200, flowBars(Math.min(168, +q("hours", 48))));
  if (p === "/api/whales") return json(res, 200, whaleMoves());
  if (p === "/api/wallets" && req.method === "GET") return json(res, 200, { wallets: walletsView(), chains: WL.CHAINS });
  if (p === "/api/wallet") { const a = q("address"), w = kvGet("wallets", []).find((x) => x.address.toLowerCase() === String(a).toLowerCase()) || { address: a, chain: q("chain") || "auto" }; inspectWallet(w, q("fresh") === "1").then((d) => json(res, 200, Object.assign({ name: w.name || null, explorer: d.chains.map((c) => ({ chain: c, name: WL.CHAINS[c], url: WL.addrUrl(c, w.address) })) }, d)), (e) => json(res, 400, { error: e.message })); return; }
  if (p === "/api/wallets" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const { address, name, on, chain } = JSON.parse(b); setWallet(address, name, on !== false, chain); json(res, 200, { wallets: walletsView() }); } catch (e) { json(res, 400, { error: e.message }); } }); return; }
  if (p === "/api/research") return json(res, 200, { calendar: rsOut("calendar"), insiders: rsOut("insiders"), feeds: rsOut("feeds"), cot: rsOut("cot"), funds: rsOut("funds"), library: RS.LIBRARY, odds: cache.macro || {} });
  if (p === "/api/labels" && req.method === "GET") return json(res, 200, db.prepare("SELECT * FROM labels ORDER BY seen DESC LIMIT 2000").all());
  if (p === "/api/labels" && req.method === "POST") {
    let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { try { const { address, name, kind } = JSON.parse(body); db.prepare("INSERT INTO labels(address, name, kind, entity, source, seen, added) VALUES(?, ?, ?, ?, 'yours', 0, ?) ON CONFLICT(address) DO UPDATE SET name = excluded.name, kind = excluded.kind, entity = excluded.entity, source = 'yours'").run(/^0x/i.test(address) ? address.toLowerCase() : address, name, kind || "exchange", name.split(/\s/)[0], Math.floor(Date.now() / 1000)); loadLabels(); json(res, 200, { ok: true }); } catch (e) { json(res, 400, { error: e.message }); } });
    return;
  }
  if (p === "/api/traders") return json(res, 200, cache.traders || { rows: [], cats: { btc: [], stocks: [], commodities: [] }, pending: true });
  if (p === "/api/follows") return json(res, 200, { follows: kvGet("follows", []), feed: kvGet("copyFeed", []).slice(-100).reverse() });
  if (p === "/api/follow" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const { address, name, on, cat } = JSON.parse(b); json(res, 200, { follows: follow(address, name, on !== false, cat) }); } catch (e) { json(res, 400, { error: e.message }); } }); return; }
  if (p === "/api/trader") {
    const a = q("address"); if (!/^0x[0-9a-fA-F]{40}$/.test(a || "")) return json(res, 400, { error: "address required" });
    const cf = catFor(q("cat") || "BTC") || catFor("BTC"), cat = cf.key, flt = cf.filter;
    const ck = `${a.toLowerCase()}|${cat}|${q("coin") || ""}`, hit = traderPages.get(ck);
    if (hit && Date.now() - hit.at < 300e3) return json(res, 200, Object.assign({}, hit.data, { following: kvGet("follows", []).some((x) => x.address.toLowerCase() === a.toLowerCase()) }));
    AG.fillsAll(a, 90, 6, { urgent: true }).then(async (f) => {
      const trips = LN.roundTrips(f, flt), n = {}; for (const p of trips) n[p.coin] = (n[p.coin] || 0) + 1;
      const coin = q("coin") || Object.entries(n).sort((x, y) => y[1] - x[1]).map((x) => x[0])[0] || cf.coins[0] || null;
      const cc = candleCache.get(coin), c = !coin ? [] : cc && Date.now() - cc.at < 600e3 ? cc.bars : await AG.candles(coin, "1h", 24 * 90, { urgent: true }).then((b) => (candleCache.set(coin, { at: Date.now(), bars: b }), b)).catch(() => []);
      const st = LN.positionStats(trips), mine = f.filter((x) => x.coin === coin).map((x) => ({ t: Math.floor(x.time / 1000), dir: x.dir, px: +x.px, sz: +x.sz, pnl: +(x.closedPnl || 0) }));
      const page = { address: a, name: alias(a, cat), cat, ticker: cf.t, coin, coins: Object.keys(n), stats: st, why: LN.copyCheck(st, cf.t.main), score: Math.round(LN.copyRank(st) * 100), btcFills: mine.slice(-600), candles: c, following: kvGet("follows", []).some((x) => x.address.toLowerCase() === a.toLowerCase()) };
      traderPages.set(ck, { at: Date.now(), data: page }); if (traderPages.size > 200) traderPages.delete(traderPages.keys().next().value);
      json(res, 200, page);
    }).catch((e) => json(res, 502, { error: e.message }));
    return;
  }
  if (p === "/api/agents") return json(res, 200, cache.agents ? Object.assign({}, cache.agents, { board: cache.agents.board.map((x) => Object.assign({}, x, { recent: x.recent.slice(0, 10) })), alerts: kvGet("agentAlerts", "top") } ) : { board: [], pending: true });
  if (p === "/api/agent") {
    const st = kvGet("desk", null), id = q("id"), book = st && st.books[id];
    if (!book) return json(res, 404, { error: "unknown agent" });
    return json(res, 200, { id, trades: book.trades.slice(-150), open: book.open, curve: book.curve, bars: deskBars.slice(-576) });
  }
  if (p === "/api/agentalerts" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { const m = JSON.parse(b || "{}").mode; kvSet("agentAlerts", ["top", "all", "off"].includes(m) ? m : "top"); json(res, 200, { mode: kvGet("agentAlerts") }); }); return; }
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
  every(30 * 60e3, refreshHolders, "BTC holders");
  every(5 * 60e3, () => refreshPerps(false), "BTC market");
  setTimeout(() => every(60 * 60e3, () => refreshPerps(true), "leaderboard read"), 20000);
  every(15 * 60e3, refreshMacro, "macro & odds");
  setTimeout(() => every(60e3 * 60 / RUNS_PER_HOUR, refreshTraders, "trader scan"), 120000);
  setTimeout(() => every(30 * 60e3, collectHip3Traders, "market traders"), 60000);
  setTimeout(() => every(5 * 60e3, async () => { await refreshLearner(); try { labLive(); frozenLive(); } catch (e) { log("lab live:", e.message); throw e; } }, "opportunities + agents live"), 45000);
  setTimeout(() => every(30 * 60e3, refreshLab, "agent evolution"), 4 * 60e3);
  setTimeout(() => every(5 * 60e3, refreshWallets, "wallets"), 15000);
  setTimeout(() => every(30 * 60e3, refreshResearch, "research feeds"), 25000);
  openFollowStream();
  try { buildBoards(); } catch (e) { log("boards:", e.message); }
  setInterval(() => pollFollows().catch(() => {}), 120e3);
  setInterval(netflowCheck, 10 * 60e3);
  setInterval(dailyDigest, 5 * 60e3);
  setInterval(() => { const cut = Math.floor(Date.now() / 1000) - CFG.keepDays * 86400; db.prepare("DELETE FROM events WHERE time < ?").run(cut); db.prepare("DELETE FROM anomalies WHERE time < ?").run(cut); }, 6 * 3600e3);
  telegramLoop();
  DP.loop(); setInterval(DP.watch, 120e3);
  http.createServer(serve).listen(CFG.port, CFG.host, () => log(`TraderGze Intel server on http://${CFG.host}:${CFG.port}`));
  if (CFG.telegramChat) tgSend("🐻 TraderGze Intel server started. /status for details.");
}
if (require.main === module) start();
module.exports = { reviewList, reviewAction, lab, frozenStats, approveSnapshot, freezeAgent, frozenLive, DP, refreshLab, labLive, labView, labAgentView, buildBoards, refreshLearner, learn, orderAlert, handleFills, pollFollows, refreshResearch, refreshWallets, setWallet, flowBars, research, serve, addEvents, learnFromBtc, netflowCheck, db, CFG, onTelegram, cache, refreshDesk, refreshTraders, follow, kvGet };
