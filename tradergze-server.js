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
  const post = async (body) => {
    const r = await A.fetch(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`Hyperliquid answered HTTP ${r.status}`);
    return r.json();
  };
  A.fetch = (...a) => fetch(...a);
  A.post = (body) => post(body);
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
  async function candles(coin = "BTC", interval = "5m", hours = 24 * 14) {
    const end = Date.now(), start = end - hours * 3600e3;
    const r = await post({ type: "candleSnapshot", req: { coin, interval, startTime: start, endTime: end } });
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
const SC = (function () { const module = { exports: {} };
// TraderGze opportunity scanner: textbook setups with the whole trade planned before entry
// (entry, stop, target, reward-to-risk), scored and tracked to see which setups actually work.
(function (root) {
  "use strict";
  const S = {};

  // ---------------------------------------------------------------- indicators on [{t,o,h,l,c,v}]
  const ema = (xs, n) => { const k = 2 / (n + 1); let e = null; return xs.map((x) => (e = e == null ? x : x * k + e * (1 - k))); };
  function atr(bars, n = 14) {
    const tr = bars.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l));
    let a = null; return tr.map((x, i) => (a = i < n ? tr.slice(0, i + 1).reduce((s, y) => s + y, 0) / (i + 1) : (a * (n - 1) + x) / n));
  }
  /** Swing pivots: bar i is a high pivot if its high is the highest of k bars each side. */
  function pivots(bars, k = 3) {
    const hi = [], lo = [];
    for (let i = k; i < bars.length - k; i++) {
      const w = bars.slice(i - k, i + k + 1);
      if (bars[i].h === Math.max(...w.map((b) => b.h))) hi.push(i);
      if (bars[i].l === Math.min(...w.map((b) => b.l))) lo.push(i);
    }
    return { hi, lo };
  }
  /** Session VWAP over intraday bars (resets each UTC day of the bar's exchange session). */
  function vwap(bars) {
    let pv = 0, vol = 0, day = null;
    return bars.map((b) => {
      const d = Math.floor(b.t / 86400);
      if (d !== day) { pv = 0; vol = 0; day = d; }
      const v = b.v || 1, tp = (b.h + b.l + b.c) / 3;
      pv += tp * v; vol += v; return pv / vol;
    });
  }
  Object.assign(S, { ema, atr, pivots, vwap });

  const plan = (side, entry, stop, target) => {
    const risk = side === "long" ? entry - stop : stop - entry, reward = side === "long" ? target - entry : entry - target;
    return risk > 0 && reward > 0 ? { side, entry, stop, target, rr: reward / risk } : null;
  };
  S.plan = plan;

  // ---------------------------------------------------------------- the setups
  // each returns null or { setup, side, entry, stop, target, rr, trigger: "now" | "stop order" | "limit order", why, book }
  const SETUPS = {
    /** Pullback to the 20/50 EMA inside an established trend, then the bar closes back with the trend. */
    emaPullback(b) {
      if (b.length < 210) return null;
      const c = b.map((x) => x.c), e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200), a = atr(b), i = b.length - 1, x = b[i];
      const up = e50[i] > e200[i] && c[i] > e50[i] && e50[i] > e50[i - 10], dn = e50[i] < e200[i] && c[i] < e50[i] && e50[i] < e50[i - 10];
      const swingHi = Math.max(...b.slice(-30).map((y) => y.h)), swingLo = Math.min(...b.slice(-30).map((y) => y.l));
      if (up && x.l <= e20[i] + 0.25 * a[i] && x.c > e20[i] && x.c > x.o) {
        const entry = x.h + 0.05 * a[i], stop = Math.min(x.l, e50[i]) - 0.3 * a[i], p = plan("long", entry, stop, Math.max(swingHi, entry + 2 * (entry - stop)));
        return p && Object.assign(p, { setup: "EMA pullback", trigger: "stop order", why: `Uptrend (EMA50 above EMA200 and rising). Price pulled back to the 20 EMA and closed back up. Buy above this bar's high; stop under the 50 EMA / bar low; target the recent swing high or 2R.`, book: "Murphy, Technical Analysis of the Financial Markets — trading pullbacks to moving averages in a trend" });
      }
      if (dn && x.h >= e20[i] - 0.25 * a[i] && x.c < e20[i] && x.c < x.o) {
        const entry = x.l - 0.05 * a[i], stop = Math.max(x.h, e50[i]) + 0.3 * a[i], p = plan("short", entry, stop, Math.min(swingLo, entry - 2 * (stop - entry)));
        return p && Object.assign(p, { setup: "EMA pullback", trigger: "stop order", why: `Downtrend (EMA50 below EMA200 and falling). Price rallied to the 20 EMA and closed back down. Sell below this bar's low; stop above the 50 EMA / bar high; target the recent swing low or 2R.`, book: "Murphy, Technical Analysis of the Financial Markets — trading pullbacks to moving averages in a trend" });
      }
      return null;
    },
    /** Close through a trendline drawn across the last two falling swing highs (or rising swing lows). */
    trendlineBreak(b) {
      if (b.length < 60) return null;
      const { hi, lo } = pivots(b.slice(0, -1), 3), a = atr(b), i = b.length - 1, x = b[i], prev = b[i - 1];
      const avgV = b.slice(-21, -1).reduce((s, y) => s + (y.v || 0), 0) / 20, volOk = !avgV || (x.v || 0) >= 1.2 * avgV;
      const line = (p1, p2, k) => p1.y + ((p2.y - p1.y) * (k - p1.i)) / (p2.i - p1.i);
      if (hi.length >= 2) {
        const [i1, i2] = hi.slice(-2), p1 = { i: i1, y: b[i1].h }, p2 = { i: i2, y: b[i2].h };
        if (p2.y < p1.y && i - i2 <= 30 && i2 - i1 >= 5) {
          const lv = line(p1, p2, i), lvPrev = line(p1, p2, i - 1);
          if (x.c > lv && prev.c <= lvPrev && volOk) {
            const low = Math.min(...b.slice(i1, i + 1).map((y) => y.l)), stop = Math.max(low, x.c - 2 * a[i]) - 0.2 * a[i];
            const p = plan("long", x.c, stop, x.c + Math.max(p1.y - low, 2 * (x.c - stop)));
            return p && Object.assign(p, { setup: "Trendline breakout", trigger: "now", line: [[b[i1].t, p1.y], [x.t, lv]], why: `Closed above the down-trendline joining the ${new Date(b[i1].t * 1000).toISOString().slice(0, 10)} and ${new Date(b[i2].t * 1000).toISOString().slice(0, 10)} highs${avgV ? " on above-average volume" : ""}. Stop under the swing low inside the pattern; target the measured move (pattern height) or 2R.`, book: "Murphy, Technical Analysis of the Financial Markets — trendline breaks and measured moves" });
          }
        }
      }
      if (lo.length >= 2) {
        const [i1, i2] = lo.slice(-2), p1 = { i: i1, y: b[i1].l }, p2 = { i: i2, y: b[i2].l };
        if (p2.y > p1.y && i - i2 <= 30 && i2 - i1 >= 5) {
          const lv = line(p1, p2, i), lvPrev = line(p1, p2, i - 1);
          if (x.c < lv && prev.c >= lvPrev && volOk) {
            const high = Math.max(...b.slice(i1, i + 1).map((y) => y.h)), stop = Math.min(high, x.c + 2 * a[i]) + 0.2 * a[i];
            const p = plan("short", x.c, stop, x.c - Math.max(high - p1.y, 2 * (stop - x.c)));
            return p && Object.assign(p, { setup: "Trendline breakdown", trigger: "now", line: [[b[i1].t, p1.y], [x.t, lv]], why: `Closed below the up-trendline joining the ${new Date(b[i1].t * 1000).toISOString().slice(0, 10)} and ${new Date(b[i2].t * 1000).toISOString().slice(0, 10)} lows. Stop above the swing high inside the pattern; target the measured move or 2R.`, book: "Murphy, Technical Analysis of the Financial Markets — trendline breaks and measured moves" });
          }
        }
      }
      return null;
    },
    /** Turtle-style 55-bar channel breakout. */
    channelBreakout(b) {
      if (b.length < 60) return null;
      const a = atr(b, 20), i = b.length - 1, x = b[i], w = b.slice(i - 55, i), hh = Math.max(...w.map((y) => y.h)), ll = Math.min(...w.map((y) => y.l));
      if (x.c > hh && b[i - 1].c <= hh) { const p = plan("long", x.c, x.c - 2 * a[i], x.c + 4 * a[i]); return p && Object.assign(p, { setup: "55-bar breakout", trigger: "now", why: `New 55-bar closing high above ${hh.toFixed(2)}. Stop 2 ATR (the Turtles' "2N"); target 4 ATR, or trail the 20-bar low.`, book: "Curtis Faith, Way of the Turtle — 55-day breakout, 2N stop" }); }
      if (x.c < ll && b[i - 1].c >= ll) { const p = plan("short", x.c, x.c + 2 * a[i], x.c - 4 * a[i]); return p && Object.assign(p, { setup: "55-bar breakdown", trigger: "now", why: `New 55-bar closing low below ${ll.toFixed(2)}. Stop 2 ATR; target 4 ATR, or trail the 20-bar high.`, book: "Curtis Faith, Way of the Turtle — 55-day breakout, 2N stop" }); }
      return null;
    },
    /** Price coming back to the 200 EMA from one side: a planned limit order at the big moving average. */
    bigMaTest(b) {
      if (b.length < 220) return null;
      const c = b.map((x) => x.c), e200 = ema(c, 200), a = atr(b), i = b.length - 1, x = b[i], d = (x.c - e200[i]) / a[i];
      const above = c.slice(-40).every((y, k) => y > e200[i - 39 + k]), below = c.slice(-40).every((y, k) => y < e200[i - 39 + k]);
      const swingHi = Math.max(...b.slice(-40).map((y) => y.h)), swingLo = Math.min(...b.slice(-40).map((y) => y.l));
      if (above && d > 0 && d < 1.5) { const p = plan("long", e200[i], e200[i] - 1.2 * a[i], swingHi); return p && p.rr >= 1.5 && Object.assign(p, { setup: "200 EMA support", trigger: "limit order", why: `Above the 200 EMA for 40+ bars and now ${d.toFixed(1)} ATR from it. Big funds defend the 200: plan a buy limit at the line, stop 1.2 ATR under, target the recent high.`, book: "Brent Donnelly, Alpha Trader — plan levels in advance; trade the levels everyone watches" }); }
      if (below && d < 0 && d > -1.5) { const p = plan("short", e200[i], e200[i] + 1.2 * a[i], swingLo); return p && p.rr >= 1.5 && Object.assign(p, { setup: "200 EMA resistance", trigger: "limit order", why: `Below the 200 EMA for 40+ bars and now ${(-d).toFixed(1)} ATR from it. Plan a sell limit at the line, stop 1.2 ATR above, target the recent low.`, book: "Brent Donnelly, Alpha Trader — plan levels in advance; trade the levels everyone watches" }); }
      return null;
    },
  };
  /** Intraday: price reclaims (or loses) session VWAP in the direction of the daily trend. */
  function vwapSetup(m5, dailyTrend) {
    if (!m5 || m5.length < 30 || !dailyTrend) return null;
    const vw = vwap(m5), a = atr(m5, 14), i = m5.length - 1, x = m5[i], day = Math.floor(x.t / 86400);
    const today = m5.filter((b) => Math.floor(b.t / 86400) === day);
    if (today.length < 6) return null;
    const below = m5.slice(-7, -1).filter((b, k) => b.c < vw[i - 6 + k]).length, above = 6 - below;
    if (dailyTrend === "up" && x.c > vw[i] && below >= 4) {
      const lo = Math.min(...today.map((b) => b.l)), stop = Math.max(lo, vw[i] - 2 * a[i]) - 0.2 * a[i], p = plan("long", x.c, stop, x.c + 2 * (x.c - stop));
      return p && Object.assign(p, { setup: "VWAP reclaim", tf: "5m", trigger: "now", why: "Daily trend is up; price was below session VWAP and just reclaimed it. Stop under the session low (or 2 ATR); target 2R. Exit by the close.", book: "VWAP is the benchmark institutions execute against; Alpha Trader — know where the market's average buyer is" });
    }
    if (dailyTrend === "down" && x.c < vw[i] && above >= 4) {
      const hi = Math.max(...today.map((b) => b.h)), stop = Math.min(hi, vw[i] + 2 * a[i]) + 0.2 * a[i], p = plan("short", x.c, stop, x.c - 2 * (stop - x.c));
      return p && Object.assign(p, { setup: "VWAP rejection", tf: "5m", trigger: "now", why: "Daily trend is down; price was above session VWAP and just lost it. Stop over the session high (or 2 ATR); target 2R. Exit by the close.", book: "VWAP is the benchmark institutions execute against; Alpha Trader — know where the market's average buyer is" });
    }
    return null;
  }
  S.SETUPS = SETUPS; S.vwapSetup = vwapSetup;

  const trendOf = (b) => { if (b.length < 60) return null; const c = b.map((x) => x.c), e20 = ema(c, 20), e50 = ema(c, 50), i = c.length - 1; return c[i] > e50[i] && e20[i] > e50[i] ? "up" : c[i] < e50[i] && e20[i] < e50[i] ? "down" : null; };
  S.trendOf = trendOf;

  /** Every setup that fires on the latest bar of a symbol. daily = 1y of daily bars, m5 = intraday bars (optional). */
  function scanSymbol(item, daily, m5, { minRR = 1.5 } = {}) {
    const out = [], last = daily[daily.length - 1];
    for (const [k, fn] of Object.entries(SETUPS)) {
      let o; try { o = fn(daily); } catch { o = null; }
      if (o && o.rr >= minRR) out.push(Object.assign({ tf: "1D", key: k }, o));
    }
    const v = vwapSetup(m5, trendOf(daily));
    if (v && v.rr >= minRR) out.push(Object.assign({ key: "vwap" }, v));
    const bar = (o) => (o.tf === "5m" ? m5[m5.length - 1] : last);
    return out.map((o) => Object.assign(o, { sym: item.sym, code: item.code, name: item.name, group: item.group, time: bar(o).t, last: bar(o).c, id: `${item.sym}:${o.key}:${o.side}:${bar(o).t}` }));
  }
  S.scanSymbol = scanSymbol;

  /** Settle a tracked idea against bars after it was found: filled? stopped? target hit? Stops win ties (conservative). */
  function settle(o, bars) {
    if (o.result && o.result !== "open" && o.result !== "pending") return o;
    const after = bars.filter((b) => b.t > o.time), long = o.side === "long";
    let filled = o.trigger === "now" ? true : !!o.filled;
    for (const b of after) {
      if (!filled) {
        if (o.trigger === "stop order" ? (long ? b.h >= o.entry : b.l <= o.entry) : (long ? b.l <= o.entry : b.h >= o.entry)) filled = true;
        else { if (b.t - o.time > 10 * 86400) return Object.assign(o, { result: "expired" }); continue; }
      }
      if (long ? b.l <= o.stop : b.h >= o.stop) return Object.assign(o, { filled, result: "loss", R: -1, closed: b.t });
      if (long ? b.h >= o.target : b.l <= o.target) return Object.assign(o, { filled, result: "win", R: +o.rr.toFixed(2), closed: b.t });
    }
    return Object.assign(o, { filled, result: filled ? "open" : "pending" });
  }
  S.settle = settle;

  /** Per-setup scoreboard from settled ideas. */
  function scoreboard(history) {
    const by = {};
    for (const o of history) {
      if (o.result !== "win" && o.result !== "loss") continue;
      const s = (by[o.setup] = by[o.setup] || { setup: o.setup, trades: 0, wins: 0, R: 0, gross: 0, loss: 0 });
      s.trades++; s.R += o.R; if (o.R > 0) { s.wins++; s.gross += o.R; } else s.loss += -o.R;
    }
    return Object.values(by).map((s) => Object.assign(s, { winRate: s.wins / s.trades, expectancy: s.R / s.trades, profitFactor: s.loss ? s.gross / s.loss : null })).sort((a, b) => b.expectancy - a.expectancy);
  }
  S.scoreboard = scoreboard;

  if (typeof module !== "undefined" && module.exports) module.exports = S;
  else root.Scanner = S;
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
    if (X.STABLES.includes(e.asset)) learnFromStable(e);
    walletTouched(e);
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
      cache.lb = X.topTraders(lbRaw, "month", 300);
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
const every = (ms, fn) => { const run = () => fn().catch((e) => log("job failed:", e.message)); run(); return setInterval(run, ms); };

// ---------------------------------------------------------------- top human traders: rank by real closed trades, alert on followed ones
// trader categories: BTC only, stock perps (Hyperliquid HIP-3 markets such as xyz:TSLA), commodities & energy
const CATS = { btc: [(c) => RS.category(c) === "btc", 20], stocks: [(c) => RS.category(c) === "stocks", 8], commodities: [(c) => RS.category(c) === "commodities", 8] };
/** A stable virtual name per address: Trader1, Trader2, … in the order they were first ranked. */
function alias(address) {
  const m = kvGet("aliases", {}), k = address.toLowerCase();
  if (!m[k]) { m[k] = Object.keys(m).length + 1; kvSet("aliases", m); }
  return "Trader" + m[k];
}
// addresses seen trading HIP-3 (stock / commodity) markets, gathered from their recent trades
async function collectHip3Traders() {
  const seen = kvGet("hip3Users", {});
  let coins = [];
  try {
    const dexs = (await AG.post({ type: "perpDexs" })) || [];
    for (const d of dexs.filter((x) => x && x.name)) { try { const m = await AG.post({ type: "meta", dex: d.name }); coins.push(...(m.universe || []).filter((u) => !u.isDelisted).map((u) => u.name)); } catch {} }
  } catch (e) { log("perpDexs:", e.message); }
  coins = coins.filter((c) => RS.category(c) !== "crypto").slice(0, 60);
  cache.hip3Coins = coins;
  for (const coin of coins) {
    try { for (const t of (await AG.post({ type: "recentTrades", coin })) || []) for (const u of t.users || []) { const k = u.toLowerCase(); seen[k] = seen[k] || { n: 0, cats: {} }; seen[k].n++; seen[k].cats[RS.category(coin)] = 1; seen[k].at = Date.now(); } } catch {}
  }
  const cut = Date.now() - 14 * 86400e3;
  kvSet("hip3Users", Object.fromEntries(Object.entries(seen).filter(([, v]) => v.at > cut).sort((a, b) => b[1].n - a[1].n).slice(0, 400)));
}
async function refreshTraders() {
  if (!cache.lb) return;
  const cand = cache.lb.filter((t) => t.accountValue >= 50000).slice(0, 60);
  const hip = Object.entries(kvGet("hip3Users", {})).slice(0, 60).map(([address]) => ({ address, accountValue: null, pnl: null }));
  const seen = new Set(), all = [...cand, ...hip].filter((c) => !seen.has(c.address.toLowerCase()) && seen.add(c.address.toLowerCase()));
  const out = { btc: [], stocks: [], commodities: [] };
  for (const c of all) {
    try { const r = AG.scoreCategories(c, await AG.fills(c.address, 30), CATS); for (const k in r) out[k].push(r[k]); } catch {}
  }
  for (const k in out) out[k] = out[k].sort((a, b) => b.score - a.score).slice(0, 40).map((t) => Object.assign(t, { name: alias(t.address), handle: t.name || null }));
  cache.traders = { at: Math.floor(Date.now() / 1000), rows: out.btc, cats: out };
}
let followWs = null;
function openFollowStream() {
  const follows = kvGet("follows", []);
  try { followWs && followWs.close(); } catch {}
  if (!follows.length || !globalThis.WebSocket) return;
  const ws = (followWs = new WebSocket("wss://api.hyperliquid.xyz/ws"));
  ws.onopen = () => { for (const f of follows) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user: f.address } })); status.copy = `live · ${follows.length} followed`; };
  ws.onmessage = (m) => {
    let j; try { j = JSON.parse(m.data); } catch { return; }
    if (j.channel !== "userFills" || !j.data || j.data.isSnapshot) return;
    const f = follows.find((x) => x.address.toLowerCase() === String(j.data.user).toLowerCase()), name = (f && f.name) || X.short(j.data.user);
    const log = kvGet("copyFeed", []);
    for (const fill of j.data.fills || []) {
      const item = { time: Math.floor(fill.time / 1000), user: j.data.user, name, coin: fill.coin, dir: fill.dir, px: +fill.px, sz: +fill.sz, pnl: +(fill.closedPnl || 0), text: AG.fillAlert(name, fill) };
      log.push(item); broadcast("copy", item);
      const cat = (f && f.cat) || "btc";
      if (!f || f.coins === "all" || RS.category(fill.coin) === cat) tgSend((/^Open|>/.test(fill.dir) ? "🟢 OPENED · " : "👤 ") + item.text + `
https://app.hyperliquid.xyz/explorer/address/${j.data.user}`);
    }
    kvSet("copyFeed", log.slice(-300));
  };
  ws.onclose = () => { status.copy = "reconnecting"; setTimeout(openFollowStream, 5000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}
function follow(address, name, on, cat = "btc") {
  let list = kvGet("follows", []).filter((f) => f.address.toLowerCase() !== address.toLowerCase());
  if (on) list.push({ address, name: name || alias(address), cat: CATS[cat] ? cat : "btc", since: Math.floor(Date.now() / 1000) });
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
    tgSend(msg + "\n(paper trade, not advice)");
    broadcast("agent", e);
  }
}

// ---------------------------------------------------------------- opportunity scanner: textbook setups, planned in advance, tracked to the result
const SCAN_SKIP = new Set(["Volatility & rates"]);
const dailyCache = {};
async function refreshScanner() {
  const items = MK.ALL.filter((i) => !SCAN_SKIP.has(i.group)), found = [], errors = [];
  let watch = (cache.watch && cache.watch.rows) || [];
  for (const it of items) {
    try {
      let d = dailyCache[it.sym];
      if (!d || Date.now() - d.at > 3600e3) d = dailyCache[it.sym] = { at: Date.now(), data: await MK.candles(it.sym, "2Y") };
      const state = d.data.meta.state, bars = d.data.bars.slice();
      const today = Math.floor(Date.now() / 86400e3);
      if (state === "open" && bars.length && Math.floor(bars[bars.length - 1].t / 86400) === today) bars.pop();  // only completed daily bars
      let m5 = null;
      if (state === "open") { try { m5 = (await MK.candles(it.sym, "1D")).bars; } catch {} }
      found.push(...SC.scanSymbol(it, bars, m5));
      it._bars = d.data.bars;
    } catch (e) { errors.push(`${it.code}: ${e.message}`); }
  }
  // track every idea to its result
  const hist = kvGet("opps", []), known = new Set(hist.map((o) => o.id)), fresh = found.filter((o) => !known.has(o.id));
  hist.push(...fresh);
  for (const o of hist) { const it = items.find((x) => x.sym === o.sym); if (it && it._bars) SC.settle(o, o.tf === "5m" ? it._bars.filter((b) => b.t > o.time) : it._bars); }
  kvSet("opps", hist.slice(-800));
  cache.opps = { at: Math.floor(Date.now() / 1000), scanned: items.length, errors: errors.slice(0, 20) };
  if (fresh.length && kvGet("oppAlerts", true) && kvGet("muteUntil", 0) < Date.now())
    for (const o of fresh.slice(0, 8)) tgSend(`🎯 SETUP · ${o.code} ${o.setup} (${o.tf}) ${o.side.toUpperCase()}\nEntry ${fmtP(o.entry)} (${o.trigger}) · Stop ${fmtP(o.stop)} · Target ${fmtP(o.target)} · RR ${o.rr.toFixed(1)}\n${o.why}`);
  for (const it of items) delete it._bars;
}
const fmtP = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(4));
function oppsView() {
  const hist = kvGet("opps", []), now = Math.floor(Date.now() / 1000);
  const active = hist.filter((o) => (o.result === "open" || o.result === "pending") && now - o.time < 12 * 86400).sort((a, b) => b.time - a.time);
  return Object.assign({}, cache.opps || { pending: true }, { active, settled: hist.filter((o) => o.result === "win" || o.result === "loss").slice(-60).reverse(), board: SC.scoreboard(hist) });
}

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
const chainOf = (a) => (/^0x[0-9a-fA-F]{40}$/.test(a) ? "ethereum" : /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) ? "tron" : /^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$/.test(a) ? "bitcoin" : null);
async function rpc(method, params) { const r = await fetch("https://ethereum-rpc.publicnode.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json()); if (r.error) throw new Error(r.error.message); return r.result; }
async function walletBalance(w) {
  if (w.chain === "bitcoin") { const j = await fetch(`https://mempool.space/api/address/${w.address}`).then((r) => r.json()); const c = j.chain_stats, m = j.mempool_stats; return { BTC: (c.funded_txo_sum - c.spent_txo_sum + m.funded_txo_sum - m.spent_txo_sum) / 1e8, txs: c.tx_count + m.tx_count }; }
  if (w.chain === "ethereum") {
    const out = { ETH: Number(BigInt(await rpc("eth_getBalance", [w.address, "latest"]))) / 1e18 };
    for (const [tok, [sym, dec]] of Object.entries(X.TOKENS.ethereum)) { try { const v = Number(BigInt(await rpc("eth_call", [{ to: tok, data: "0x70a08231" + w.address.slice(2).toLowerCase().padStart(64, "0") }, "latest"]) || "0x0")) / 10 ** dec; if (v >= 1) out[sym] = v; } catch {} }
    return out;
  }
  if (w.chain === "tron") { const j = await fetch(`https://api.trongrid.io/v1/accounts/${w.address}`).then((r) => r.json()), a = (j.data || [])[0] || {}; const out = { TRX: (a.balance || 0) / 1e6 }; for (const t of a.trc20 || []) for (const [k, v] of Object.entries(t)) if (k === "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t") out.USDT = Number(v) / 1e6; return out; }
  return {};
}
async function refreshWallets() {
  const list = kvGet("wallets", []), seen = kvGet("walletSeen", {});
  for (const w of list) {
    try { w.balance = await walletBalance(w); w.at = Math.floor(Date.now() / 1000); w.error = null; } catch (e) { w.error = e.message; }
    if (w.chain !== "bitcoin") continue;
    try {   // every BTC transaction of a tracked wallet, not only whale-sized ones
      const txs = await fetch(`https://mempool.space/api/address/${w.address}/txs`).then((r) => r.json());
      const ids = txs.map((t) => t.txid), had = seen[w.address];
      if (had) for (const t of txs.filter((t) => !had.includes(t.txid)).slice(0, 5)) {
        const got = t.vout.filter((o) => o.scriptpubkey_address === w.address).reduce((s, o) => s + o.value, 0), sent = t.vin.filter((i) => i.prevout && i.prevout.scriptpubkey_address === w.address).reduce((s, i) => s + i.prevout.value, 0);
        const net = (got - sent) / 1e8;
        tgSend(`👛 ${w.name}: ${net >= 0 ? "received" : "sent"} ${X.fmtNum(Math.abs(net), 4)} BTC${price ? ` (${X.fmtUsd(Math.abs(net) * price)})` : ""}\nhttps://mempool.space/tx/${t.txid}`);
      }
      seen[w.address] = ids.slice(0, 50);
    } catch {}
  }
  kvSet("wallets", list); kvSet("walletSeen", seen);
}
function walletTouched(e) {
  const list = kvGet("wallets", []); if (!list.length || e.chain === "hyperliquid") return;
  const m = list.find((w) => w.chain !== "bitcoin" && [e.from, e.to].some((a) => a && a.toLowerCase() === w.address.toLowerCase()));
  if (m) tgSend(`👛 ${m.name}: ${e.from && e.from.toLowerCase() === m.address.toLowerCase() ? "sent" : "received"} ${X.fmtUsd(e.usd)} ${e.asset} on ${X.CHAIN_NAME[e.chain]}\n${X.EXPLORER[e.chain]}${e.hash}`);
}
function walletsView() {
  return kvGet("wallets", []).map((w) => Object.assign({}, w, { events: rows("SELECT data FROM events WHERE data LIKE ? ORDER BY time DESC LIMIT 25", "%" + (w.chain === "bitcoin" ? w.address : w.address.toLowerCase()) + "%") }));
}
function setWallet(address, name, on) {
  const chain = chainOf(address || "");
  if (on && !chain) throw new Error("Not a Bitcoin, Ethereum/EVM (0x…) or Tron (T…) address");
  let list = kvGet("wallets", []).filter((w) => w.address.toLowerCase() !== String(address).toLowerCase());
  if (on) list.push({ address: chain === "ethereum" ? address.toLowerCase() : address, name: name || X.short(address), chain, added: Math.floor(Date.now() / 1000) });
  kvSet("wallets", list.slice(-30));
  if (on) refreshWallets().catch(() => {});
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
    return tgSend("Connected. You'll get high and critical alerts here.\nCommands: /status /flows /whales /odds /brief /opps /traders /wallets /mute 2h /unmute", chat);
  }
  if (chat !== String(CFG.telegramChat)) return tgSend("This bot is private.", chat);
  if (cmd === "/status") return tgSend(`Tracking since ${new Date(stats.started).toUTCString()}\n${Object.entries(status).map(([k, v]) => `${X.CHAIN_NAME[k] || k}: ${v}`).join("\n")}\nTransfers recorded: ${db.prepare("SELECT COUNT(*) n FROM events").get().n}\nAnomalies: ${db.prepare("SELECT COUNT(*) n FROM anomalies").get().n}\nLearned exchange wallets: ${db.prepare("SELECT COUNT(*) n FROM labels WHERE source = 'learned'").get().n}`);
  if (cmd === "/flows") return tgSend(flowText());
  if (cmd === "/whales") return tgSend(cache.holders ? cache.holders.rows.filter((h) => !h.error).map((h) => `${h.name}: ${X.fmtNum(h.balance, 0)} BTC, 7d ${h.d7 >= 0 ? "+" : ""}${X.fmtNum(h.d7, 0)} (${h.action})`).join("\n") : "Still loading.");
  if (cmd === "/perps") { const p = cache.perps || {}; return tgSend(p.hl ? `Hyperliquid BTC ${X.fmtNum(p.hl.mark, 0)} · funding ${(p.hl.funding * 100).toFixed(4)}%/h · OI ${X.fmtUsd(p.hl.oiUsd)}${p.pos && p.pos.traders ? `\nTop traders ${(p.pos.longShare * 100).toFixed(0)}% long BTC (${p.pos.traders} positions, median ${p.pos.medianLeverage}x)` : ""}` : "Still loading."); }
  if (cmd === "/odds") return tgSend(cache.macro && cache.macro.markets ? cache.macro.markets.slice(0, 10).map((m) => `${m.event}: ${m.question} ${m.yes != null ? Math.round(m.yes * 100) + "%" : ""}`).join("\n") : "Still loading.");
  if (cmd === "/brief") { tgSend("Reading the last 24 hours…"); try { return tgSend(await briefText()); } catch (e) { return tgSend("Briefing failed: " + e.message); } }
  if (cmd === "/traders") return tgSend(cache.traders ? "Top BTC traders (30 days, closed trades):\n" + cache.traders.rows.slice(0, 10).map((t, i) => `${i + 1}. ${t.name || X.short(t.address)} · score ${t.score} · win ${Math.round(t.stats.winRate * 100)}% · RR ${t.stats.payoff ? t.stats.payoff.toFixed(2) : "—"} · ${t.stats.trades} trades · ${X.fmtUsd(t.stats.pnl)}\n   ${t.address}`).join("\n") + "\n\n/follow <address> to get their trades" : "Still ranking: the first list is ready about an hour after start.");
  if (cmd === "/follow" && args[0]) { const l = follow(args[0], args.slice(1).join(" "), true); return tgSend(`Following ${l.length} trader(s). You'll get their BTC trades here.`); }
  if (cmd === "/unfollow" && args[0]) { follow(args[0], "", false); return tgSend("Unfollowed."); }
  if (cmd === "/agents") return tgSend(cache.agents ? "AI agents (BTC paper trading):\n" + cache.agents.board.map((a, i) => `${i + 1}. ${a.name} · ${a.stats.returnPct >= 0 ? "+" : ""}${a.stats.returnPct.toFixed(1)}% · win ${a.stats.winRate != null ? Math.round(a.stats.winRate * 100) + "%" : "—"} · PF ${a.stats.profitFactor != null && isFinite(a.stats.profitFactor) ? a.stats.profitFactor.toFixed(2) : "—"} · ${a.stats.trades} trades${a.open ? ` · OPEN ${a.open.side}` : ""}`).join("\n") : "Agents are warming up.");
  if (cmd === "/agentalerts") { const m = ["top", "all", "off"].includes(args[0]) ? args[0] : "top"; kvSet("agentAlerts", m); return tgSend(`Agent trade alerts: ${m}.`); }
  if (cmd === "/opps") { const v = oppsView(); return tgSend(v.active.length ? "Live setups (entry · stop · target · RR):\n" + v.active.slice(0, 15).map((o) => `${o.code} ${o.side.toUpperCase()} ${o.setup} ${o.tf} · ${fmtP(o.entry)} · ${fmtP(o.stop)} · ${fmtP(o.target)} · ${o.rr.toFixed(1)}R${o.result === "open" ? " · filled" : ""}`).join("\n") : "No live setups right now. The scanner runs every 15 minutes."); }
  if (cmd === "/oppalerts") { const on = args[0] !== "off"; kvSet("oppAlerts", on); return tgSend(`New-setup alerts ${on ? "on" : "off"}.`); }
  if (cmd === "/wallets") { const l = kvGet("wallets", []); return tgSend(l.length ? l.map((w) => `${w.name} (${w.chain}): ${Object.entries(w.balance || {}).filter(([k]) => k !== "txs").map(([k, v]) => `${X.fmtNum(v, k === "BTC" ? 4 : 0)} ${k}`).join(", ") || "—"}`).join("\n") : "No tracked wallets. /track <address> <name>"); }
  if (cmd === "/track" && args[0]) { try { setWallet(args[0], args.slice(1).join(" "), true); return tgSend("Tracking. You'll get its moves here."); } catch (e) { return tgSend(e.message); } }
  if (cmd === "/untrack" && args[0]) { setWallet(args[0], "", false); return tgSend("Stopped tracking."); }
  if (cmd === "/mute") { const h = parseFloat(args[0]) || 2; kvSet("muteUntil", Date.now() + h * 3600e3); return tgSend(`Muted for ${h} hours.`); }
  if (cmd === "/unmute") { kvSet("muteUntil", 0); return tgSend("Alerts back on."); }
  return tgSend("Commands: /status /flows /whales /odds /brief /opps /oppalerts on|off /traders /follow <addr> /unfollow <addr> /wallets /track <addr> <name> /untrack <addr> /mute 2h /unmute");
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
  if (p === "/api/opps") return json(res, 200, Object.assign(oppsView(), { alerts: kvGet("oppAlerts", true) }));
  if (p === "/api/oppalerts" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { kvSet("oppAlerts", !!JSON.parse(b || "{}").on); json(res, 200, { alerts: kvGet("oppAlerts") }); }); return; }
  if (p === "/api/flowbars") return json(res, 200, flowBars(Math.min(168, +q("hours", 48))));
  if (p === "/api/whales") return json(res, 200, whaleMoves());
  if (p === "/api/wallets" && req.method === "GET") return json(res, 200, { wallets: walletsView() });
  if (p === "/api/wallets" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const { address, name, on } = JSON.parse(b); setWallet(String(address || "").trim(), name, on !== false); json(res, 200, { wallets: walletsView() }); } catch (e) { json(res, 400, { error: e.message }); } }); return; }
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
    const cat = CATS[q("cat")] ? q("cat") : "btc", flt = CATS[cat][0];
    AG.fills(a, 30).then(async (f) => {
      const n = {}; for (const x of f) if (flt(x.coin)) n[x.coin] = (n[x.coin] || 0) + 1;
      const coin = q("coin") || Object.entries(n).sort((x, y) => y[1] - x[1]).map((x) => x[0])[0] || (cat === "btc" ? "BTC" : null);
      const c = coin ? await AG.candles(coin, "1h", 24 * 30).catch(() => []) : [];
      const st = AG.traderStats(f, flt), mine = f.filter((x) => x.coin === coin).map((x) => ({ t: Math.floor(x.time / 1000), dir: x.dir, px: +x.px, sz: +x.sz, pnl: +(x.closedPnl || 0) }));
      json(res, 200, { address: a, name: alias(a), cat, coin, coins: Object.keys(n), stats: st, score: AG.copyScore(st, CATS[cat][1]), btcFills: mine.slice(-400), candles: c, following: kvGet("follows", []).some((x) => x.address.toLowerCase() === a.toLowerCase()) });
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
  every(30 * 60e3, refreshHolders);
  every(5 * 60e3, () => refreshPerps(false));
  setTimeout(() => every(60 * 60e3, () => refreshPerps(true)), 20000);
  every(15 * 60e3, refreshMacro);
  setTimeout(() => every(60 * 60e3, refreshTraders), 120000);
  setTimeout(() => every(30 * 60e3, collectHip3Traders), 60000);
  setTimeout(() => every(15 * 60e3, refreshScanner), 45000);
  setTimeout(() => every(5 * 60e3, refreshWallets), 15000);
  setTimeout(() => every(30 * 60e3, refreshResearch), 25000);
  openFollowStream();
  setInterval(netflowCheck, 10 * 60e3);
  setInterval(dailyDigest, 5 * 60e3);
  setInterval(() => { const cut = Math.floor(Date.now() / 1000) - CFG.keepDays * 86400; db.prepare("DELETE FROM events WHERE time < ?").run(cut); db.prepare("DELETE FROM anomalies WHERE time < ?").run(cut); }, 6 * 3600e3);
  telegramLoop();
  http.createServer(serve).listen(CFG.port, CFG.host, () => log(`TraderGze Intel server on http://${CFG.host}:${CFG.port}`));
  if (CFG.telegramChat) tgSend("🐻 TraderGze Intel server started. /status for details.");
}
if (require.main === module) start();
module.exports = { refreshScanner, refreshResearch, refreshWallets, setWallet, flowBars, research, serve, addEvents, learnFromBtc, netflowCheck, db, CFG, onTelegram, cache, refreshDesk, refreshTraders, follow, kvGet };
