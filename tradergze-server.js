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
  // queries. Every call waits for budget (900 a minute, leaving room for the rest of the app) and backs off on HTTP 429.
  const BUDGET = 900, limiter = { tokens: BUDGET, at: Date.now(), chain: Promise.resolve() };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  async function take(w) {
    for (;;) {
      const now = Date.now(); limiter.tokens = Math.min(BUDGET, limiter.tokens + ((now - limiter.at) / 60000) * BUDGET); limiter.at = now;
      if (limiter.tokens >= w) { limiter.tokens -= w; return; }
      await sleep(Math.ceil(((w - limiter.tokens) / BUDGET) * 60000));
    }
  }
  const post = (body) => {
    const run = limiter.chain.then(async () => {
      for (let attempt = 0; ; attempt++) {
        await take(20);
        const r = await A.fetch(HL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (r.status === 429 && attempt < 3) { limiter.tokens = 0; await sleep(15000 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error(`Hyperliquid answered HTTP ${r.status}`);
        const j = await r.json();
        if (Array.isArray(j) && j.length > 20) limiter.tokens -= Math.floor(j.length / 20);
        return j;
      }
    });
    limiter.chain = run.catch(() => {});
    return run;
  };
  A.limiter = limiter;
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
  /** Every fill in the window: Hyperliquid returns at most 2000 per call, so page forward by time. */
  async function fillsAll(user, days = 90, pages = 6) {
    let start = Date.now() - days * 86400e3, out = [];
    for (let k = 0; k < pages; k++) {
      const r = (await post({ type: "userFillsByTime", user, startTime: start, aggregateByTime: true })) || [];
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
      (s > 0 ? P.r[i] : 100 - P.r[i]) / 25 - 2, clip(s * (x.c - (style === "scalp" ? P.vw[i] : P.e20[i])) / a),
      (s > 0 ? rng : 1 - rng) * 2 - 1, clip(a / (avgA || a) - 1, 2) * 2, clip(s * (x.c - b[i - 5].c) / a),
      style === "scalp" ? Math.sin(hr) : 0, style === "scalp" ? Math.cos(hr) : 0,
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
  function walk(bars, t, p, horizon) {
    let k = indexAt(bars, t) + 1; if (k <= 0) return null;
    for (; k < bars.length && bars[k].t <= t + horizon; k++) {
      const b = bars[k];
      if (p.side === "long" ? b.l <= p.stop : b.h >= p.stop) return 0;
      if (p.side === "long" ? b.h >= p.target : b.l <= p.target) return 1;
    }
    return k < bars.length ? 0 : null;
  }
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
      const y = walk(fine, P.bars[i].t + barSec - 1, planPips(P, i, side, style, ticker), RULES[style].horizon);
      if (y != null) out.push({ f, y, side });
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
    for (const b of bars.filter((x) => x.t > o.time)) {
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
const every = (ms, fn) => { const run = () => fn().catch((e) => log("job failed:", e.message)); run(); return setInterval(run, ms); };

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
const PER_RUN = 120, RUNS_PER_HOUR = 6;
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
  const batch = db.prepare("SELECT address FROM tpool ORDER BY (at > 0) ASC, (src = 'leaderboard') ASC, at ASC LIMIT ?").all(PER_RUN).map((r) => r.address);
  for (const address of batch) {
    try {
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
    try { handleFills(f.address, await AG.post({ type: "userFillsByTime", user: f.address, startTime: Math.max((f.since || 0) * 1000, Date.now() - 3600e3), aggregateByTime: false })); } catch (e) { log("follow poll:", e.message); }
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
  if (coin) { try { const b = await AG.candles(coin, iv, iv === "15m" ? 24 * 52 : 24 * 200); if (b.length > 100) return { src: "Hyperliquid " + coin, coin, bars: b }; } catch {} }
  if (!t.yahoo) throw new Error(`no ${t.name} market on Hyperliquid yet`);
  return { src: "Yahoo " + t.yahoo, bars: await ybars(t.yahoo, iv === "15m" ? "60d" : "730d", iv === "15m" ? "15m" : "60m") };
}
async function fundingHistory(coin) {
  const out = []; let start = Date.now() - 80 * 86400e3;
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
      if (hourly && r.coin) S.fundingRaw = await fundingHistory(r.coin);
      S.fine = keepBars(k, "15m", r.bars, 180); S.scalp = LN.prepX(closedOnly(S.fine, 900), S.fundingRaw || []);
      if (hourly || !S.swing) { S.h1 = keepBars(k, "1h", (await tickerBars(k, "1h")).bars, 400); S.swing = LN.prepX(closedOnly(LN.to4h(S.h1), 14400), S.fundingRaw || []); }
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
    for (const k of OPP_TICKERS) for (const st of ["scalp", "swing"]) learn.base[k + st] = LN.baseline(learn.series, k, st);
    learn.at = now;
  }
  const plans = kvGet("plans2", []), adj = kvGet("gateAdj", 0), mistakes = kvGet("mistakes", []);
  for (const o of plans) { const S = learn.series[o.ticker]; if (S && S.fine) LN.settlePips(o, o.style === "scalp" ? S.fine : S.h1 || S.fine, LN.PIP[o.ticker]); }
  // three planned losses in a row: review them and adjust the database
  const streak = LN.losingStreak(plans, kvGet("reviewed", []));
  if (streak) {
    const r = LN.review(streak, learn.db, mistakes);
    kvSet("mistakes", r.mistakes); kvSet("reviewed", kvGet("reviewed", []).concat(streak.map((o) => o.id)).slice(-300));
    kvSet("demoted", kvGet("demoted", []).concat(learn.db.filter((e) => e.demoted).map((e) => `${e.ticker}:${e.t}:${e.trader}`)).slice(-3000));
    const newAdj = Math.min(0.3, adj + 0.03); kvSet("gateAdj", newAdj);
    const rv = { time: Math.floor(now / 1000), ids: streak.map((o) => o.id), demoted: r.demoted, common: r.common, minP: LN.GATE.minP + newAdj };
    kvSet("reviews", kvGet("reviews", []).concat([rv]).slice(-30));
    alertSend(`🧠 REVIEW after 3 planned losses in a row (${streak.map((o) => `${o.name} ${o.style} ${o.side}`).join(", ")})\nSimilar setups are now blocked, ${r.demoted} database entries that pointed to them were demoted, and the bar for A+ is raised to ${Math.round(rv.minP * 100)}%.${r.common.length ? `\nThe losers had in common: ${r.common.join(", ")}.` : ""}`);
  }
  const today = new Date().toISOString().slice(0, 10), counts = (st) => learn.db.filter((e) => e.style === st).length, readings = [];
  for (const k of OPP_TICKERS) for (const style of ["scalp", "swing"]) {
    const S = learn.series[k], P = S && S[style]; if (!P || P.bars.length < 80) { readings.push({ ticker: k, style }); continue; }
    const i = P.bars.length - 1, best = [];
    for (const side of ["long", "short"]) {
      const f = LN.features2(P, i, side, style); if (!f) continue;
      const sc = LN.score(learn.db.filter((e) => e.style === style), learn.base[k + style] || [], f, { ticker: k, mistakes: mistakes.filter((m) => m.style === style) });
      best.push(Object.assign({ side, f, aplus: LN.isAplus(sc, counts(style), style, adj) }, sc, LN.planPips(P, i, side, style, k)));
    }
    best.sort((a, b) => (b.aplus - a.aplus) || (b.p || 0) - (a.p || 0));
    const c = best[0]; if (!c) continue;
    readings.push({ ticker: k, style, side: c.side, p: c.p, like: c.like, n: c.n, aplus: c.aplus, blocked: c.blocked });
    if (!c.aplus) continue;
    if (plans.filter((o) => o.style === style && new Date(o.time * 1000).toISOString().slice(0, 10) === today).length >= DAILY[style]) continue;
    if (plans.some((o) => o.ticker === k && o.style === style && (o.result === "open" || o.time === P.bars[i].t))) continue;
    const t = LN.ticker(k), o = { id: `${k}:${style}:${c.side}:${P.bars[i].t}`, ticker: k, name: t.name, label: t.label, style, side: c.side, time: P.bars[i].t + (style === "scalp" ? 900 : 14400), entry: c.entry, stop: c.stop, target: c.target,
      slPips: c.slPips, tpPips: c.tpPips, rr: c.rr, risk: c.risk, horizon: LN.RULES[style].horizon, p: c.p, like: c.like, n: c.n, traders: c.traders, reasons: c.reasons.map((x) => x.r), f: c.f, result: "open", src: S.src };
    plans.push(o);
    if (kvGet("oppAlerts", true)) alertSend(`PLANNED OPPORTUNITY\n${o.side === "long" ? "🟢 LONG" : "🔴 SHORT"} on ${o.name} at ${fmtP(o.entry)}, SL ${fmtP(o.stop)} (${o.slPips} pips) and TP ${fmtP(o.target)} (${o.tpPips} pips)\nSetup name: ${style === "scalp" ? "Scalp" : "Swing"}\nA+ · ${Math.round(o.p * 100)}% of the ${o.n} most similar past moments hit TP before SL · ${o.like.toFixed(1)}× more like profitable traders' entries than an ordinary moment${o.reasons.length ? `\nWhy: ${o.reasons.join(", ")}` : ""}`);
  }
  learn.readings = readings;
  kvSet("plans2", plans.slice(-600));
  learn.built = now;
}
function oppsView() {
  const plans = kvGet("plans2", []), set = plans.filter((o) => o.result !== "open"), count = (st) => learn.db.filter((e) => e.style === st).length;
  const board = ["scalp", "swing"].map((style) => { const xs = set.filter((o) => o.style === style), w = xs.filter((o) => o.pips > 0); return { style, trades: xs.length, wins: w.length, winRate: xs.length ? w.length / xs.length : null, pips: xs.reduce((s, o) => s + (o.pips || 0), 0), totalR: +xs.reduce((s, o) => s + (o.R || 0), 0).toFixed(2) }; });
  const done = set.slice().sort((a, b) => a.closed - b.closed); let streak = 0; for (let i = done.length - 1; i >= 0 && done[i].R < 0; i--) streak++;
  return { at: learn.built ? Math.floor(learn.built / 1000) : null, tickers: OPP_TICKERS.map((k) => Object.assign({}, LN.ticker(k), { pip: LN.PIP[k], src: learn.series[k] && learn.series[k].src, error: learn.errors[k] || null })),
    rules: LN.RULES, db: { trades: learn.trades || 0, scalp: count("scalp"), swing: count("swing"), byTicker: OPP_TICKERS.map((k) => ({ ticker: k, scalp: learn.db.filter((e) => e.ticker === k && e.style === "scalp").length, swing: learn.db.filter((e) => e.ticker === k && e.style === "swing").length })), rejected: learn.rejected, demoted: learn.db.filter((e) => e.demoted).length,
      reasons: { scalp: LN.reasonStats(learn.db, "scalp"), swing: LN.reasonStats(learn.db, "swing") } },
    gate: { minP: LN.GATE.minP + kvGet("gateAdj", 0), minLike: LN.GATE.minLike }, readings: learn.readings || [], active: plans.filter((o) => o.result === "open").reverse().map(({ f, ...o }) => o), settled: set.slice(-60).reverse().map(({ f, ...o }) => o), board, streak, reviews: kvGet("reviews", []).slice().reverse(), alerts: kvGet("oppAlerts", true), daily: DAILY };
}
function oppBars(id) {
  const o = kvGet("plans2", []).find((x) => x.id === id); if (!o) return null;
  const S = learn.series[o.ticker] || {}, P = o.style === "scalp" ? S.scalp : S.swing, { f, ...plan } = o;
  return { plan, bars: P ? P.bars.slice(-400) : [] };
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
    return tgSend("Connected. You'll get high and critical alerts here.\nCommands: /status /flows /whales /odds /brief /opps /traders /wallets /mute 2h /unmute", chat);
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
  if (cmd === "/agents") return tgSend(cache.agents ? "AI agents (BTC paper trading):\n" + cache.agents.board.map((a, i) => `${i + 1}. ${a.name} · ${a.stats.returnPct >= 0 ? "+" : ""}${a.stats.returnPct.toFixed(1)}% · win ${a.stats.winRate != null ? Math.round(a.stats.winRate * 100) + "%" : "—"} · PF ${a.stats.profitFactor != null && isFinite(a.stats.profitFactor) ? a.stats.profitFactor.toFixed(2) : "—"} · ${a.stats.trades} trades${a.open ? ` · OPEN ${a.open.side}` : ""}`).join("\n") : "Agents are warming up.");
  if (cmd === "/agentalerts") { const m = ["top", "all", "off"].includes(args[0]) ? args[0] : "top"; kvSet("agentAlerts", m); return tgSend(`Agent trade alerts: ${m}.`); }
  if (cmd === "/opps") { const v = oppsView(); return tgSend(v.active.length ? "Planned opportunities (open):\n" + v.active.slice(0, 10).map((o) => `${o.side === "long" ? "🟢 LONG" : "🔴 SHORT"} ${o.name} ${o.style} · entry ${fmtP(o.entry)} · SL ${fmtP(o.stop)} (${o.slPips}p) · TP ${fmtP(o.target)} (${o.tpPips}p)`).join("\n") : `No open plan. Database: ${v.db.scalp}/150 scalps and ${v.db.swing}/60 swings from profitable traders.`); }
  if (cmd === "/oppalerts") { const on = args[0] !== "off"; kvSet("oppAlerts", on); return tgSend(`New-setup alerts ${on ? "on" : "off"}.`); }
  if (cmd === "/wallets") { const l = kvGet("wallets", []).slice().sort((a, b) => ((b.summary && b.summary.totalUsd) || 0) - ((a.summary && a.summary.totalUsd) || 0)); return tgSend(l.length ? `${l.length} wallets tracked${kvGet("walletAlertsOff", false) ? " (alerts off)" : ""}, total ${X.fmtUsd(l.reduce((s, w) => s + ((w.summary && w.summary.totalUsd) || 0), 0))}:\n` + l.slice(0, 40).map((w) => `${w.name}: ${w.summary ? X.fmtUsd(w.summary.totalUsd) : "reading…"}`).join("\n") + (l.length > 40 ? `\n…and ${l.length - 40} more (see the Wallets tab)` : "") : "No tracked wallets. /track <address> <name>"); }
  if (cmd === "/track" && args[0]) { try { setWallet(args[0], args.slice(1).join(" "), true); return tgSend("Tracking. You'll get its moves here."); } catch (e) { return tgSend(e.message); } }
  if (cmd === "/untrackall") { const n = kvGet("wallets", []).length; kvSet("wallets", []); kvSet("walletSeen2", {}); return tgSend(n ? `Stopped tracking all ${n} wallet(s).` : "You weren't tracking any wallets."); }
  if (cmd === "/untrack" && args[0]) { setWallet(args[0], "", false); return tgSend("Stopped tracking."); }
  if (cmd === "/alerts") { const off = args[0] === "off"; kvSet("alertsOff", off); return tgSend(off ? "🔕 All alerts off. Commands still work. /alerts on to turn them back on." : "🔔 All alerts on."); }
  if (cmd === "/walletalerts") { const off = args[0] === "off"; kvSet("walletAlertsOff", off); return tgSend(`Wallet alerts ${off ? "off" : "on"} (${kvGet("wallets", []).length} wallets tracked).`); }
  if (cmd === "/mute") { const h = parseFloat(args[0]) || 2; kvSet("muteUntil", Date.now() + h * 3600e3); return tgSend(`Muted for ${h} hours.`); }
  if (cmd === "/unmute") { kvSet("muteUntil", 0); return tgSend("Alerts back on."); }
  return tgSend("Commands: /status /flows /whales /odds /brief /opps /oppalerts on|off /traders /follow <addr> /following /unfollow <addr> /wallets /track <addr> <name> /untrack <addr> /untrackall /walletalerts on|off /alerts on|off /mute 2h /unmute");
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
  if (p === "/api/opps") return json(res, 200, oppsView());
  if (p === "/api/opp") { const d = oppBars(q("id")); return d ? json(res, 200, d) : json(res, 404, { error: "This plan is no longer listed." }); }
  if (p === "/api/oppalerts" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { kvSet("oppAlerts", !!JSON.parse(b || "{}").on); json(res, 200, { alerts: kvGet("oppAlerts") }); }); return; }
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
    AG.fillsAll(a, 90).then(async (f) => {
      const trips = LN.roundTrips(f, flt), n = {}; for (const p of trips) n[p.coin] = (n[p.coin] || 0) + 1;
      const coin = q("coin") || Object.entries(n).sort((x, y) => y[1] - x[1]).map((x) => x[0])[0] || cf.coins[0] || null;
      const c = coin ? await AG.candles(coin, "1h", 24 * 90).catch(() => []) : [];
      const st = LN.positionStats(trips), mine = f.filter((x) => x.coin === coin).map((x) => ({ t: Math.floor(x.time / 1000), dir: x.dir, px: +x.px, sz: +x.sz, pnl: +(x.closedPnl || 0) }));
      json(res, 200, { address: a, name: alias(a, cat), cat, ticker: cf.t, coin, coins: Object.keys(n), stats: st, why: LN.copyCheck(st, cf.t.main), score: Math.round(LN.copyRank(st) * 100), btcFills: mine.slice(-600), candles: c, following: kvGet("follows", []).some((x) => x.address.toLowerCase() === a.toLowerCase()) });
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
  setTimeout(() => every(60e3 * 60 / RUNS_PER_HOUR, refreshTraders), 120000);
  setTimeout(() => every(30 * 60e3, collectHip3Traders), 60000);
  setTimeout(() => every(5 * 60e3, refreshLearner), 45000);
  setTimeout(() => every(5 * 60e3, refreshWallets), 15000);
  setTimeout(() => every(30 * 60e3, refreshResearch), 25000);
  openFollowStream();
  try { buildBoards(); } catch (e) { log("boards:", e.message); }
  setInterval(() => pollFollows().catch(() => {}), 120e3);
  setInterval(netflowCheck, 10 * 60e3);
  setInterval(dailyDigest, 5 * 60e3);
  setInterval(() => { const cut = Math.floor(Date.now() / 1000) - CFG.keepDays * 86400; db.prepare("DELETE FROM events WHERE time < ?").run(cut); db.prepare("DELETE FROM anomalies WHERE time < ?").run(cut); }, 6 * 3600e3);
  telegramLoop();
  http.createServer(serve).listen(CFG.port, CFG.host, () => log(`TraderGze Intel server on http://${CFG.host}:${CFG.port}`));
  if (CFG.telegramChat) tgSend("🐻 TraderGze Intel server started. /status for details.");
}
if (require.main === module) start();
module.exports = { buildBoards, refreshLearner, learn, orderAlert, handleFills, pollFollows, refreshResearch, refreshWallets, setWallet, flowBars, research, serve, addEvents, learnFromBtc, netflowCheck, db, CFG, onTelegram, cache, refreshDesk, refreshTraders, follow, kvGet };
