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
  /** Any bar size from smaller bars (12 h from 1 h). */
  L.toN = (bars, sec) => { const out = []; for (const b of bars) { const k = Math.floor(b.t / sec) * sec, o = out[out.length - 1]; if (o && o.t === k) { o.h = Math.max(o.h, b.h); o.l = Math.min(o.l, b.l); o.c = b.c; o.v = (o.v || 0) + (b.v || 0); } else out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v || 0 }); } return out; };
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
  const SWINGY = (st) => st === "swing" || st === "h12";
  function features(P, i, side, style) {
    const b = P.bars, x = b[i], a = P.a[i] || 1, s = side === "long" ? 1 : -1;
    if (i < 60) return null;
    const w = b.slice(i - 19, i + 1), hi = Math.max(...w.map((y) => y.h)), lo = Math.min(...w.map((y) => y.l)), rng = (x.c - lo) / (hi - lo || 1);
    const avgA = P.a.slice(Math.max(0, i - 100), i + 1).reduce((t, y) => t + y, 0) / Math.min(101, i + 1);
    const hr = (new Date(x.t * 1000).getUTCHours() + new Date(x.t * 1000).getUTCMinutes() / 60) / 24 * 2 * Math.PI;
    const clip = (v, m = 4) => Math.max(-m, Math.min(m, v));
    return [
      clip(s * (x.c - P.e20[i]) / a), clip(s * (x.c - P.e50[i]) / a), clip(s * (P.e20[i] - P.e50[i]) / a), clip(s * (x.c - P.e200[i]) / a / 2),
      (s > 0 ? P.r[i] : 100 - P.r[i]) / 25 - 2, clip(s * (x.c - (!SWINGY(style) ? P.vw[i] : P.e20[i])) / a),
      (s > 0 ? rng : 1 - rng) * 2 - 1, clip(a / (avgA || a) - 1, 2) * 2, clip(s * (x.c - b[i - 5].c) / a),
      !SWINGY(style) ? Math.sin(hr) : 0, !SWINGY(style) ? Math.cos(hr) : 0,
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
  L.LAB_STYLES = { m1: { rules: "scalp", bar: 60, horizon: 2 * 3600, step: 2 }, h12: { rules: "swing", bar: 43200, horizon: 30 * 86400, step: 1 }, scalp5: { rules: "scalp", bar: 300, horizon: 6 * 3600, step: 1 }, scalp: { rules: "scalp", bar: 900, horizon: 86400, step: 2 }, swing: { rules: "swing", bar: 14400, horizon: 10 * 86400, step: 1 }, h1: { rules: "scalp", bar: 3600, horizon: 2 * 86400, step: 1 } };
  /** Every past bar of a ticker for one lab style, both sides: features, the pip-plan outcome, and price/ATR for other plans. */
  function labSamples(series, ticker, style) {
    const S = series[ticker], st = L.LAB_STYLES[style], P = S && (style === "m1" ? S.m1 : style === "scalp5" ? S.m5 : style === "h1" ? S.h1p : S[style]), fine = S && (style === "m1" ? S.fine1 : style === "h12" ? S.h1 : style === "scalp5" ? S.fine5 : style === "scalp" ? S.fine : style === "h1" ? S.fine : S.h1), out = [];
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
  const TICKERS = ["BTC", "GOLD", "SILVER"], STYLES = ["scalp", "h1", "swing", "h12"];             // 15m, 1h, 4h, 12h: 1m and 5m lose to trading costs
  B.START = 500;
  // selectivity: an agent trades only its top (1 - q) most confident setups, measured on what it learned from
  const Q = [0.9, 0.93, 0.95, 0.97, 0.98, 0.99], QF = [0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 0.99];
  /** Free agents' stop / target in ATRs of their timeframe. */
  // the last four are big swings (RR 4 to 5): with break-even and part profit they keep the win rate high and let winners run
  const PRESETS = [[0.5, 0.5], [0.5, 1], [1, 1], [0.5, 2], [1, 2], [1, 3], [2, 2], [2, 4], [1.5, 4.5], [3, 6], [1, 4], [1, 5], [1.5, 6], [2, 8]];
  B.PRESETS = PRESETS;
  const RISK = [0.5, 1, 2, 3], RISKF = [2, 3, 5, 8, 10, 12, 15];
  /**
   * Free agents always manage the trade (a few small rules, everything else is free):
   * SL to break-even once price moves beAt × risk their way, close partialPct of the position at partialAt × risk,
   * optionally trail the rest one risk behind the best price.
   */
  function freeMgmt() {
    const m = { beAt: pick([0.3, 0.5, 0.75, 1]), partialAt: pick([0.5, 0.75, 1, 1.5]), partialPct: pick([0.5, 0.6, 0.75]), trail: rnd() < 0.5 };
    m.beAt = Math.min(m.beAt, m.partialAt);
    return Object.assign(m, { partial: true, breakeven: true, add: false });
  }
  B.freeMgmt = freeMgmt;
  /** Older agents: fixed confidence bar -> selectivity; 16 features -> 24; no capital -> $500 and a risk %. */
  B.upgrade = (g) => {
    if (g.q == null) { g.q = pick(Q); g.bump = 0; } if (g.minLike > 1) g.minLike = 1; delete g.theta;
    while (g.mask.length < NF) g.mask.push(rnd() < 0.4);
    if (!g.kind) g.kind = "rule";
    if (g.riskPct == null) g.riskPct = g.kind === "free" ? pick(RISKF) : pick(RISK);
    if (!STYLES.includes(g.style)) g.style = pick(STYLES);                // agents of removed timeframes move to a kept one
    if (g.kind === "free") { if (g.riskPct > 15) g.riskPct = pick(RISKF); if (!g.mgmt || g.mgmt.beAt == null) g.mgmt = freeMgmt(); }
    return g;
  };
  function randomGenome(id, kind = "rule", style) {
    const mask = Array.from({ length: NF }, () => rnd() < 0.45); if (!mask.some(Boolean)) mask[4] = true;
    const tick = TICKERS.filter(() => rnd() < 0.6); if (!tick.length) tick.push(pick(TICKERS));
    const g = { id, kind, style: style || pick(STYLES), tickers: tick, mask, lambda: pick([0.001, 0.01, 0.05, 0.2]), q: kind === "free" ? pick(QF) : pick(Q), minLike: kind === "free" ? pick([0, 0, 0, 1]) : pick([0, 0, 0, 1]),
      riskPct: kind === "free" ? pick(RISKF) : pick(RISK), mgmt: { partial: rnd() < 0.5, breakeven: rnd() < 0.5, add: rnd() < 0.3 }, gen: 0, parent: null, bump: 0 };
    if (kind === "free") { g.preset = Math.floor(rnd() * PRESETS.length); g.maxPerDay = pick([2, 3, 5, 8]); g.mgmt = freeMgmt(); }
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
      if (rnd() < 0.3) c.maxPerDay = pick([2, 3, 5, 8]);
      if (rnd() < 0.15) c.style = pick(STYLES);
      if (rnd() < 0.2) c.minLike = pick([0, 0, 0, 1]);                 // free agents may also insist on "looks like a human winner"
      if (rnd() < 0.35) { const n = freeMgmt(), k = pick(["beAt", "partialAt", "partialPct", "trail"]); c.mgmt[k] = n[k]; c.mgmt.beAt = Math.min(c.mgmt.beAt, c.mgmt.partialAt); }
    } else {
      if (rnd() < 0.6) c.q = +Math.min(0.995, Math.max(0.85, c.q + (rnd() - 0.5) * 0.04)).toFixed(3);
      if (rnd() < 0.3) c.minLike = pick([0, 0, 0, 1]);
      if (rnd() < 0.2) c.riskPct = pick(RISK);
    }
    if (style) c.style = style;
    if (rnd() < 0.3) c.lambda = pick([0.001, 0.01, 0.05, 0.2]);
    if (c.kind !== "free" && rnd() < 0.3) { const k = pick(["partial", "breakeven", "add"]); c.mgmt[k] = !c.mgmt[k]; }
    if (rnd() < 0.2) { const t = pick(TICKERS); c.tickers = c.tickers.includes(t) && c.tickers.length > 1 ? c.tickers.filter((x) => x !== t) : [...new Set(c.tickers.concat(t))]; }
    return c;
  }
  /** Crossover: a child takes each input, setting and management choice from one of two parents, then a small change. */
  function crossover(a, b, id, gen, style, hints) {
    const c = B.upgrade(JSON.parse(JSON.stringify(a))), x = B.upgrade(JSON.parse(JSON.stringify(b)));
    c.mask = c.mask.map((m, j) => (rnd() < 0.5 ? m : x.mask[j])); if (!c.mask.some(Boolean)) c.mask[Math.floor(rnd() * NF)] = true;
    for (const k of ["lambda", "q", "minLike", "riskPct", "preset", "maxPerDay"]) if (x[k] !== undefined && rnd() < 0.5) c[k] = x[k];
    for (const k of c.kind === "free" ? ["beAt", "partialAt", "partialPct", "trail"] : ["partial", "breakeven", "add"]) if (rnd() < 0.5) c.mgmt[k] = x.mgmt[k];
    if (c.kind === "free") c.mgmt.beAt = Math.min(c.mgmt.beAt, c.mgmt.partialAt);
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
    if (mgmt.beAt != null) return simulateFree(bars, t, plan, mgmt, horizon);
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
  /**
   * Free-agent management, checked bar by bar (stop first, so a bar that touches both counts as the worse case):
   * break-even at beAt R, close partialPct at partialAt R, optional trail one risk behind the best price, rest at target.
   */
  function simulateFree(bars, t, plan, m, horizon) {
    const s = plan.side === "long" ? 1 : -1, risk = Math.abs(plan.entry - plan.stop), e = plan.entry;
    let size = 1, stop = plan.stop, R = 0, part = false, be = false, top = e; const ev = [];
    const done = (b, kind, px) => { R += (size * s * (px - e)) / risk; ev.push({ t: b.t, kind, px }); return { R: +R.toFixed(3), tc: b.t, events: ev }; };
    for (const b of bars) {
      if (b.t <= t) continue;
      const worst = s > 0 ? b.l : b.h, best = s > 0 ? b.h : b.l;
      if (s > 0 ? worst <= stop : worst >= stop) return done(b, be ? (part && m.trail && stop !== e ? "trail" : "breakeven") : "stop", stop);
      top = s > 0 ? Math.max(top, best) : Math.min(top, best);
      const fav = (s * (top - e)) / risk;
      if (!be && fav >= m.beAt) { be = true; stop = e; ev.push({ t: b.t, kind: "breakeven", px: e }); }
      if (!part && fav >= m.partialAt) { const px = e + s * m.partialAt * risk; R += (m.partialPct * s * (px - e)) / risk; size -= m.partialPct; part = true; ev.push({ t: b.t, kind: "partial", px }); }
      if (part && m.trail) { const ts = top - s * risk; if (s > 0 ? ts > stop : ts < stop) stop = ts; }
      if (s > 0 ? best >= plan.target : best <= plan.target) return done(b, "target", plan.target);
      if (b.t - t > horizon) return done(b, "time", b.c);
    }
    return { R: null, open: true, events: ev };
  }

  // ---------------------------------------------------------------- results
  const BE_EPS = 0.02;
  B.isLoss = (R) => R <= -BE_EPS;
  function metrics(trades) {
    const xs = trades.slice().sort((a, b) => a.tc - b.tc);
    let cum = 0, peak = 0, dd = 0, streak = 0, maxStreak = 0; const curve = [];
    for (const x of xs) { cum += x.R; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); if (Math.abs(x.R) >= BE_EPS) streak = x.R < 0 ? streak + 1 : 0; maxStreak = Math.max(maxStreak, streak); curve.push([x.tc, +cum.toFixed(2)]); }
    // a trade closed at break-even (|R| < 0.02) is neither a win nor a loss: win rate = wins / (wins + losses)
    const w = xs.filter((x) => x.R >= BE_EPS), l = xs.filter((x) => x.R <= -BE_EPS), gw = w.reduce((s, x) => s + x.R, 0), gl = -l.reduce((s, x) => s + x.R, 0), wl = w.length + l.length;
    const sided = xs.filter((x) => x.side), longShare = sided.length ? sided.filter((x) => x.side === "long").length / sided.length : null;
    return { trades: xs.length, wins: w.length, breakevens: xs.length - wl, longShare, winRate: wl ? w.length / wl : xs.length ? 0 : null, totalR: +cum.toFixed(2), profitFactor: gl > 0 ? gw / gl : w.length ? Infinity : null, maxDD: +dd.toFixed(2), maxLossStreak: maxStreak, curve };
  }
  B.metrics = metrics;
  /** Paper capital: $500 start, each trade risks riskPct of current equity (compounding). */
  function capital(trades, riskPct, start = B.START) {
    const xs = trades.slice().sort((a, b) => a.tc - b.tc);
    let eq = start, peak = start, dd = 0; const curve = [];
    for (const x of xs) { eq = Math.min(1e12, Math.max(0, eq * (1 + (x.R * riskPct) / 100))); peak = Math.max(peak, eq); dd = Math.max(dd, peak ? (peak - eq) / peak : 0); curve.push([x.tc, +eq.toFixed(2)]); }
    const days = xs.length ? Math.max(1, (xs[xs.length - 1].tc - xs[0].t) / 86400) : 1;
    return { start, equity: +eq.toFixed(2), roi: eq / start - 1, roiPerDay: (eq / start - 1) / days, maxDDPct: dd, days: +days.toFixed(1), busted: eq < 25, smooth: smooth(curve), curve };
  }
  B.capital = capital;
  /** How straight the equity curve climbs: R² of log equity against trade number, signed by direction (1 = a perfect upward line). */
  function smooth(curve) {
    const n = curve.length; if (n < 5) return 0;
    const y = curve.map((p) => Math.log(Math.max(p[1], 1e-6))), mx = (n - 1) / 2, my = y.reduce((s, v) => s + v, 0) / n;
    let sxy = 0, sxx = 0, syy = 0; y.forEach((v, i) => { sxy += (i - mx) * (v - my); sxx += (i - mx) ** 2; syy += (v - my) ** 2; });
    return syy ? +(Math.sign(sxy) * (sxy * sxy) / (sxx * syy)).toFixed(3) : 0;
  }
  B.smooth = smooth;
  /** Free agents: only money matters, and how fast. */
  /**
   * Free agents: a smooth rising equity curve with a high win rate. Growth per day counts, but the curve's straightness,
   * a win rate of 85%+ (anything below is punished hard) and a small drawdown count more.
   */
  /** The one challenge for a team: 100+ live paper trades, win rate 75%+, never more than 3 losses in a row. */
  B.TEAM_PASS = { trades: 100, winRate: 0.75, maxLossStreak: 3 };
  // a second route for edges with fewer but bigger wins: 150+ trades, 60%+ win (its profit factor must then be 1.8+)
  B.TEAM_PASS2 = { trades: 150, winRate: 0.6, maxLossStreak: 3, profitFactor: 1.8 };
  B.isTeamPass = (m) => !!m && m.maxLossStreak <= 3 && ((m.trades >= B.TEAM_PASS.trades && m.winRate >= B.TEAM_PASS.winRate) || (m.trades >= B.TEAM_PASS2.trades && m.winRate >= B.TEAM_PASS2.winRate));
  B.FREE_WIN = 0.7; B.FREE_STREAK = 3; B.FREE_TRADES = 100;
  B.freeFitness = (c, trades, m) => {
    if (!c || trades < 5) return -1 + Math.min(0.5, (trades || 0) / 20);
    if (c.busted) return -5;
    const growth = 3 * Math.tanh((Math.log(Math.max(c.equity, 1) / c.start) / Math.max(1, c.days)) * 10), wr = m && m.winRate != null ? m.winRate : 0.5;
    // never 4 losses in a row; trades both directions (not a long-only or short-only agent)
    const streak = m && m.maxLossStreak > B.FREE_STREAK ? (m.maxLossStreak - B.FREE_STREAK) * 2 : 0, ls = m && m.longShare != null && trades >= 20 ? Math.max(0, Math.abs(m.longShare - 0.5) - 0.3) * 10 : 0;
    return 2 * growth + 2 * (c.smooth || 0) + 3 * wr - Math.max(0, B.FREE_WIN - wr) * 12 - (c.maxDDPct || 0) * 3 + Math.min(1, trades / B.FREE_TRADES) - streak - ls;
  };
  /** What an agent actually traded (market + hour of entry): two agents taking mostly the same trades are copies. */
  B.tradeSig = (trades) => trades.slice(-300).map((x) => (x.ticker || "") + ":" + Math.floor(x.t / 3600));
  B.overlap = (a, b) => { if (!a || !b || !a.length || !b.length) return 0; const A = new Set(a); let n = 0; for (const x of new Set(b)) if (A.has(x)) n++; return n / Math.min(A.size, new Set(b).size); };
  /** Quick in-and-out plans (reward ≤ 2× risk) vs big-swing plans (≥ 3×). */
  B.planKind = (g) => { const [a, b] = PRESETS[g.preset || 0]; return b / a >= 3 ? "big" : b / a <= 2 ? "quick" : "mid"; };
  B.presetsOf = (kind) => PRESETS.map((p, i) => [i, p[1] / p[0]]).filter(([, r]) => (kind === "big" ? r >= 3 : kind === "quick" ? r <= 2 : r > 2 && r < 3)).map(([i]) => i);
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
  const CAP = { m1: 20, scalp5: 8, scalp: 8, h1: 6, swing: 4, h12: 3 };       // trades a day per rule agent (raised to reach 100 live trades sooner)
  B.CAP = CAP;
  /**
   * samples: [{t, tc, f, y, rr, side, ticker, style, like?, i?}] sorted by t. fine[ticker] = bars for simulating management.
   * Trains on what was known before each test segment (closed before it started), trades the segment, moves on.
   */
  const HORIZON = { m1: 2 * 3600, scalp5: 6 * 3600, scalp: 86400, h1: 2 * 86400, swing: 10 * 86400, h12: 30 * 86400 };
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
        if ((g.mgmt.partial || g.mgmt.add || g.mgmt.beAt != null) && o.plan && fine[s.ticker]) { const r = simulate(fine[s.ticker], s.t, o.plan, g.mgmt, HORIZON[g.style]); if (r.open) continue; R = r.R; tc = r.tc; }
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
  const STYLE_NAME = { m1: "Scalp 1m", h12: "Swing 12h", scalp5: "Scalp 5m", scalp: "Scalp 15m", h1: "Intraday 1h", swing: "Swing 4h" };
  B.STYLE_NAME = STYLE_NAME;
  B.describe = (g) => g.kind === "team" && B.teamDescribe ? B.teamDescribe(g) : g.kind === "council" ? "COUNCIL · trades only when at least 3 of the 10 best rule agents of a timeframe agree on a side and none disagree · your pip rules · risks 1% a trade on BTC, GOLD, SILVER" : (g.kind === "free" ? `FREE agent · ${STYLE_NAME[g.style]} · SL ${PRESETS[g.preset || 0][0]} ATR / TP ${PRESETS[g.preset || 0][1]} ATR · SL to break-even at +${g.mgmt.beAt}R · books ${Math.round(g.mgmt.partialPct * 100)}% at +${g.mgmt.partialAt}R${g.mgmt.trail ? " · trails the rest 1R behind" : ""} · risks ${g.riskPct}% a trade · up to ${g.maxPerDay} trades a day` : `${STYLE_NAME[g.style]} (${g.style === "swing" ? "SL ≤ 70 pips, TP 100" : "SL ≤ 10 pips, TP 20"}) · risks ${g.riskPct}% a trade`) + ` on ${g.tickers.join(", ")} · takes only its top ${+((1 - Math.min(0.998, g.q + (g.bump || 0))) * 100).toFixed(1)}% most confident setups${g.minLike ? ` and at least ${g.minLike} profitable human entr${g.minLike > 1 ? "ies look" : "y looks"} like it` : ""}${g.kind !== "free" && g.mgmt.partial ? " · takes half profit halfway" : ""}${g.kind !== "free" && g.mgmt.breakeven && g.mgmt.partial ? " then moves SL to entry" : ""}${g.mgmt.add ? " · adds once on a pullback" : ""}`;

  if (typeof module !== "undefined" && module.exports) module.exports = B;
  else root.Lab = B;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();
const TM = (function () { const module = { exports: {} };
/**
 * TraderGze Intel - agent teams.
 *
 * The market has phases. Every bar is put in one: TREND (fast and slow averages and the higher timeframe line up),
 * BREAKOUT (price leaves its 55-bar range or the Keltner band), FLOW (strong buying or selling pressure on high volume)
 * or RANGE (none of these). Each lab agent gets a skill score per phase from its own unseen-data trades.
 *
 * A team = a leader (the team agent, $500, trades like any agent) + per timeframe the 5 agents with the best skill
 * for that team's job. The leader only trades when its specialists agree and nobody in the team is against.
 * Teams: Phase Masters (the specialist of the current phase leads), Consensus Five, Trend Riders, Range Snipers,
 * Breakout Squad, Flow Hunters, and the Rotation Captain, who gives the order to whichever team is doing best now.
 * Teams learn from their mistakes but never stop: 3 losses in a row -> shadow trading (it keeps trading normally until
 * it wins one back), then one more vote is needed (at most one above its normal number); a phase that cost the team
 * 3 of its last 5 trades needs one more vote there for a day; their losing setups teach every agent of that timeframe.
 */
(function (root) {
  const T = {};
  const REGIMES = ["trend", "range", "breakout", "flow"];
  T.REGIMES = REGIMES;
  const NAME = { trend: "Trend", range: "Range", breakout: "Breakout", flow: "Order flow" };
  T.REGIME_NAME = NAME;
  const q = (xs, p) => { if (!xs.length) return 0; const s = xs.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
  /** Phase thresholds from the data itself (so each phase is reasonably common on every market). */
  T.cutsFrom = (samples) => {
    const xs = samples.filter((_, i) => i % 7 === 0 && _.f);
    return { trend: q(xs.map((s) => Math.abs(s.f[2])), 0.7), flow: q(xs.map((s) => Math.abs(s.f[12])), 0.8), vol: q(xs.map((s) => s.f[11]), 0.6), kelt: q(xs.map((s) => Math.abs(s.f[23])), 0.7) };
  };
  /** The market phase at a bar, from its 24 inputs (direction does not matter). */
  T.regimeOf = (f, c) => {
    if (!f || !c) return "range";
    if (f[18] !== 0 && Math.abs(f[23]) >= c.kelt) return "breakout";      // beyond the 55-bar range AND outside the Keltner band
    if (Math.abs(f[12]) >= c.flow && f[11] >= c.vol) return "flow";
    if (Math.abs(f[2]) >= c.trend && Math.sign(f[2]) === Math.sign(f[14])) return "trend";
    return "range";
  };
  /** An agent's record in each phase: trades, win rate, average R. */
  T.skillOf = (trades, c) => {
    const out = {}; for (const r of REGIMES) out[r] = { n: 0, w: 0, R: 0 };
    for (const x of trades) { if (!x.f) continue; const o = out[T.regimeOf(x.f, c)]; o.n++; o.R += x.R; if (x.R > 0.02) o.w++; }
    for (const r of REGIMES) { const o = out[r]; o.wr = o.n ? +(o.w / o.n).toFixed(3) : 0; o.R = +o.R.toFixed(2); }
    return out;
  };
  /** How good an agent is in some phases: win rate first, then R per trade; needs 8+ trades there. */
  T.skillScore = (sk, regs) => {
    if (!sk) return -1; let n = 0, w = 0, R = 0; for (const r of regs) { const o = sk[r]; if (!o) continue; n += o.n; w += o.w; R += o.R; }
    return n < 8 ? -1 + n / 100 : w / n + 0.15 * (R / n) + Math.min(0.1, n / 1000);
  };
  const ALL = REGIMES;
  /** The team models. regs = the phases it trades, need = votes needed, role = how members are picked. */
  const TYPES = {
    phase: { name: "Phase Masters", regs: ALL, need: 2, about: "the specialist of the current market phase must call the trade, one more member must agree, nobody against" },
    // the fast team: scalps only (5m and 15m), every phase, 2 of 5 votes, a looser vote bar, no daily limit
    consensus: { name: "Scalp Strike Team", regs: ALL, need: 2, styles: ["scalp"], vote: 0.93, about: "SCALPS ONLY (15m), every market phase; the 5 best scalpers per timeframe, 2+ agree, nobody against; trades as often as they agree" },
    // the patient team: 4h swings only, with the trend
    trend: { name: "Swing Trend Riders", regs: ["trend"], need: 2, htf: true, styles: ["swing", "h12"], about: "SWINGS ONLY (4h and 12h), only in a trend and with the higher-timeframe trend; the 5 best trend swing traders, 2+ agree, nobody against" },
    range: { name: "Range Snipers", regs: ["range"], need: 2, about: "only in a range; the 5 best range traders, 2+ agree, nobody against" },
    breakout: { name: "Breakout Squad", regs: ["breakout"], need: 2, about: "only on breakouts; the 5 best breakout traders, 2+ agree, nobody against" },
    flow: { name: "Flow Hunters", regs: ["flow", "breakout"], need: 2, flow: true, about: "only when buyers or sellers clearly push (order flow); the 5 best flow traders, 2+ agree, order flow with the trade" },
    day: { name: "Day Traders", regs: ALL, need: 2, styles: ["h1"], vote: 0.95, about: "DAY TRADES (1h), every market phase; the 5 best day traders per timeframe, 2+ agree, nobody against" },
    captain: { name: "Rotation Captain", regs: ALL, need: 0, about: "gives the order to the team with the best recent live record (last 20 trades); if no team is doing well it waits" },
  };
  T.TYPES = TYPES;
  /** The timeframes a team trades (scalp team: 5m + 15m, swing team: 4h, the others: all). */
  T.stylesOf = (g, all) => (TYPES[g.team] && TYPES[g.team].styles) || all;
  T.ORDER = ["phase", "consensus", "day", "trend", "range", "breakout", "flow", "captain"];
  T.describe = (g) => `${g.pool === "free" ? "FREE TEAM (members: free agents)" : "TEAM"} · ${TYPES[g.team].name} · ${TYPES[g.team].about}${g.need ? ` · now needs ${g.need} votes` : ""} · ${g.pool === "free" ? "the leading member's own stop/target, SL to entry and part profit" : "your pip rules, half profit halfway then SL to entry"} · risks ${g.riskPct}% a trade on ${g.tickers.join(", ")}`;
  /**
   * Members per timeframe: cands = [{id, style, skill, fit}] (the lab's agents with a trained model). Phase Masters takes
   * the best agent of each phase + the best all-rounder; the others take the 5 best at their own phases.
   */
  T.pickMembers = (type, cands, styles) => {
    const out = {};
    for (const st of (TYPES[type] && TYPES[type].styles) || styles) {
      const xs = cands.filter((c) => c.style === st), used = new Set(), m = [];
      const best = (regs, role) => { const c = xs.filter((x) => !used.has(x.id)).sort((a, b) => T.skillScore(b.skill, regs) - T.skillScore(a.skill, regs) || b.fit - a.fit)[0]; if (c) { used.add(c.id); m.push({ id: c.id, role }); } };
      if (type === "phase") { for (const r of REGIMES) best([r], r); best(ALL, "all-round"); }
      else if (type === "consensus") { for (let k = 0; k < 5; k++) { const c = xs.filter((x) => !used.has(x.id)).sort((a, b) => b.fit - a.fit)[0]; if (c) { used.add(c.id); m.push({ id: c.id, role: "all-round" }); } } }
      else if (TYPES[type] && type !== "captain") for (let k = 0; k < 5; k++) best(TYPES[type].regs, type);
      out[st] = m;
    }
    return out;
  };
  /**
   * The team's call at one bar. vote(member, side) -> true if that member would take that side (its model says yes).
   * fL / fS = the inputs for long / short. Returns {side, regime, voters} or {skip: reason}.
   */
  T.decide = (g, members, vote, fL, fS, c, now) => {
    const ty = TYPES[g.team], reg = T.regimeOf(fL, c);
    if (!ty.regs.includes(reg)) return { skip: `${NAME[reg]} phase is not this team's job` };
    // stricter, never stopped: +1 vote after a losing streak (not while in shadow, so it can win its way back),
    // +1 vote in a phase that lost recently; never more than its members can give
    const strict = g.block && g.block[reg] > now ? 1 : 0, shadow = g.state && g.state.shadow;
    const need = Math.min(4, (shadow ? ty.need : Math.min(ty.need + 1, Math.max(ty.need, g.need || 0))) + strict), v = { long: [], short: [] };
    for (const m of members) for (const side of ["long", "short"]) if (vote(m, side)) v[side].push(m.id);
    for (const side of ["long", "short"]) {
      const other = side === "long" ? "short" : "long", f = side === "long" ? fL : fS; if (!f || v[other].length) continue;
      if (g.team === "phase") { const lead = members.find((m) => m.role === reg); if (!lead || !v[side].includes(lead.id) || v[side].length < need) continue; }
      else if (v[side].length < need) continue;
      if (ty.htf && !(f[14] > 0)) continue;
      if (ty.flow && !(f[12] > 0)) continue;
      const lead = g.team === "phase" ? members.find((m) => m.role === reg).id : v[side][0];
      return { side, regime: reg, voters: v[side], lead };
    }
    return { skip: "no agreement" };
  };
  /** After a closed team trade: 3 of the last 5 trades in one phase lost -> one more vote needed in that phase for a day. */
  T.learn = (g, regime, R, now) => {
    g.regLog = g.regLog || {}; const L = (g.regLog[regime] = (g.regLog[regime] || []).concat([R > 0.02 ? 1 : R < -0.02 ? -1 : 0]).slice(-5));
    if (L.filter((x) => x < 0).length >= 3) { g.block = g.block || {}; g.block[regime] = now + 86400; g.regLog[regime] = []; return true; }
    return false;
  };
  /** The Captain's pick: the team with the best recent live record (5+ of its last 20 trades, win rate 60%+). */
  T.captainPick = (teams, recent) => {
    let best = null;
    for (const t of teams) { const xs = recent(t.id).slice(-20); if (xs.length < 5) continue; const w = xs.filter((r) => r > 0.02).length, l = xs.filter((r) => r < -0.02).length, wr = w / Math.max(1, w + l), sc = wr + 0.05 * xs.reduce((s, r) => s + r, 0) / xs.length;
      if (wr >= 0.6 && (!best || sc > best.sc)) best = { team: t, sc, wr }; }
    return best;
  };
  if (typeof module !== "undefined" && module.exports) module.exports = T; else root.TGZTeams = T;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();
const ED = (function () { const module = { exports: {} };
/**
 * TraderGze Intel - finding and proving an edge.
 *
 * EDGE LIBRARY: every setup gets one shared scorecard. A setup = market group (scalp / swing), market, side, market phase,
 * a fingerprint of 5 key signals (trend, RSI, place in the range, order flow, higher-timeframe trend - each low / mid / high)
 * and the trading session. Scorecards are filled from three sources: backtests on unseen data (weight 1), profitable and
 * unprofitable human trades (weight 2) and the teams' live paper trades (weight 3). Old results count less (half-life 30 days).
 * A team trades a setup the library knows to be good, tries an unknown setup at half risk, and skips a known-bad one.
 *
 * PROVING IT: win rate with 95% confidence (Wilson lower bound), profit factor, and a reshuffle test of the trades
 * (the worst drawdown in 95% of 500 random orders). Real costs (spread + slippage + commission) are taken off every trade.
 */
(function (root) {
  const E = {};
  // trading costs per market in pips (spread + slippage + commission, a round trip), like a typical MT5 broker
  E.COST_PIPS = { BTC: 3, GOLD: 0.5, SILVER: 3 };
  /** The cost of one trade in R: cost in price / the stop distance. */
  E.costR = (ticker, pip, plan) => { const risk = Math.abs(plan.entry - plan.stop); return risk > 0 ? +(((E.COST_PIPS[ticker] || 0) * pip) / risk).toFixed(3) : 0; };
  /** Asia 00-07 UTC, London 07-12, New York 12-17 (overlap and US session), late 17-24. */
  E.session = (t) => { const h = new Date(t * 1000).getUTCHours(); return h < 7 ? "asia" : h < 12 ? "london" : h < 17 ? "newyork" : "late"; };
  E.SESSION_NAME = { asia: "Asia", london: "London", newyork: "New York", late: "late US" };
  const b3 = (v, lo, hi) => (v == null ? "m" : v <= lo ? "l" : v >= hi ? "h" : "m");
  /** The setup's fingerprint: 5 signals in three levels each (all signals point the trade's way). */
  E.fingerprint = (f) => [b3(f[2], -0.3, 0.3), b3(f[4], -0.6, 0.6), b3(f[6], -0.5, 0.5), b3(f[12], -0.3, 0.3), b3(f[14], -0.3, 0.3)].join("");
  E.group = (style) => (style === "swing" || style === "h12" ? "swing" : "scalp");
  E.key = (o) => [E.group(o.style), o.ticker, o.side, o.phase, E.fingerprint(o.f), E.session(o.t)].join("|");
  const HALF = 30 * 86400, W = { bt: 1, human: 2, paper: 3 };
  /** Build the library from [{style, ticker, side, phase, f, t, R, src}] (src = bt / human / paper). */
  E.build = (rows, now = Date.now() / 1000) => {
    const L = {};
    for (const r of rows) {
      if (!r.f || r.R == null) continue;
      const k = E.key(r), w = (W[r.src] || 1) * Math.pow(0.5, Math.max(0, now - (r.t || now)) / HALF), o = (L[k] = L[k] || { n: 0, w: 0, win: 0, R: 0, gw: 0, gl: 0, src: {} });
      o.n++; o.w += w; o.R += w * r.R; if (r.R > 0.02) { o.win += w; o.gw += w * r.R; } else if (r.R < -0.02) o.gl -= w * r.R; o.src[r.src] = (o.src[r.src] || 0) + 1;
    }
    return L;
  };
  /** Wilson lower bound: the win rate we are 95% sure of (n trades, k wins). */
  E.wilson = (k, n, z = 1.96) => { if (!n) return 0; const p = k / n, d = 1 + (z * z) / n; return Math.max(0, (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d); };
  /** One setup's verdict: "good" (trade), "bad" (skip), "new" (not enough evidence: try at half risk). */
  E.judge = (s) => {
    if (!s || s.w < 4) return { verdict: "new", score: null };
    const wr = s.win / s.w, avg = s.R / s.w, lb = E.wilson(wr * Math.min(s.n, 200), Math.min(s.n, 200)), pf = s.gl > 0 ? s.gw / s.gl : s.gw > 0 ? 9 : 0;
    const score = +(lb * 100 + avg * 20).toFixed(1);
    return { verdict: avg > 0 && pf >= 1.2 && lb >= 0.45 ? "good" : avg <= 0 || pf < 1 ? "bad" : "new", score, winRate: +wr.toFixed(3), avgR: +avg.toFixed(3), pf: +pf.toFixed(2), n: s.n, src: s.src };
  };
  /** Proof numbers for a list of trade results (R): win rate, 95% sure win rate, profit factor, reshuffle worst drawdown. */
  E.proof = (Rs, runs = 500) => {
    const w = Rs.filter((r) => r > 0.02), l = Rs.filter((r) => r < -0.02), gw = w.reduce((s, x) => s + x, 0), gl = -l.reduce((s, x) => s + x, 0), wl = w.length + l.length;
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647), dds = [];
    for (let k = 0; k < (Rs.length >= 10 ? runs : 0); k++) { const xs = Rs.slice(); for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; } let c = 0, p = 0, d = 0; for (const x of xs) { c += x; p = Math.max(p, c); d = Math.max(d, p - c); } dds.push(d); }
    dds.sort((a, b) => a - b);
    return { trades: Rs.length, winRate: wl ? w.length / wl : null, sureWinRate: +E.wilson(w.length, wl).toFixed(3), profitFactor: gl > 0 ? +(gw / gl).toFixed(2) : gw > 0 ? 99 : 0, totalR: +Rs.reduce((s, x) => s + x, 0).toFixed(2), worstDD95: dds.length ? +dds[Math.floor(dds.length * 0.95)].toFixed(2) : null };
  };
  /**
   * The team's backtest on unseen data: members' walk-forward test trades (made on data their models never saw) are
   * combined like a team vote - a trade counts when `need` members took the same side at the same bar and none the other.
   */
  E.teamBacktest = (memberTrades, need) => {
    const at = new Map();
    for (const xs of memberTrades) for (const x of xs) { const k = x.k + "|" + x.t, o = at.get(k) || { long: [], short: [] }; o[x.s].push(x.R); at.set(k, o); }
    const Rs = [];
    for (const o of at.values()) for (const [a, b] of [["long", "short"], ["short", "long"]]) if (o[a].length >= need && !o[b].length) Rs.push(o[a].reduce((s, x) => s + x, 0) / o[a].length);
    return E.proof(Rs);
  };
  /** Edge decay: the last 30 trades are clearly worse than before (losing money and win rate 15+ points lower). */
  E.decayed = (Rs) => {
    if (Rs.length < 50) return false;
    const recent = Rs.slice(-30), before = Rs.slice(0, -30), wr = (xs) => xs.filter((r) => r > 0.02).length / Math.max(1, xs.filter((r) => Math.abs(r) > 0.02).length);
    return recent.reduce((s, x) => s + x, 0) < 0 && wr(recent) < wr(before) - 0.15;
  };
  if (typeof module !== "undefined" && module.exports) module.exports = E; else root.TGZEdge = E;
})(typeof window !== "undefined" ? window : globalThis);

return module.exports; })();
BL.teamDescribe = TM.describe;

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
    const last = db.prepare("SELECT MAX(t) t, COUNT(*) n FROM candles WHERE ticker = ? AND iv = ?").get(key, iv), full = iv === "1m" ? 24 * 3 : iv === "5m" ? 24 * 17 : iv === "15m" ? 24 * 52 : 24 * 200;
    const hours = last && last.n > 100 && last.t ? Math.min(full, Math.ceil((Date.now() / 1000 - last.t) / 3600) + 3) : full;
    try { const b = await AG.candles(coin, iv, hours); if (b.length > 100 || (hours < full && b.length)) return { src: "Hyperliquid " + coin, coin, bars: b }; } catch {}
    if (last && last.n > 100) return { src: "Hyperliquid " + coin + " (saved)", coin, bars: [] };   // never mix another price source into saved bars
  }
  if (!t.yahoo) throw new Error(`no ${t.name} market on Hyperliquid yet`);
  return { src: "Yahoo " + t.yahoo, bars: await ybars(t.yahoo, iv === "1h" ? "730d" : iv === "1m" ? "5d" : "60d", iv === "1h" ? "60m" : iv) };
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
      // 15m history grows on the server up to 180 days
      S.fine = keepBars(k, "15m", r.bars, 180); S.scalp = LN.prepX(closedOnly(S.fine, 900), S.fundingRaw || []);
      try { S.fine5 = keepBars(k, "5m", (await tickerBars(k, "5m")).bars, 45); S.m5 = LN.prepX(closedOnly(S.fine5, 300), S.fundingRaw || []); } catch (e) { learn.errors[k + "5m"] = e.message; }
      if (hourly || !S.swing) { S.h1 = keepBars(k, "1h", (await tickerBars(k, "1h")).bars, 400); S.swing = LN.prepX(closedOnly(LN.to4h(S.h1), 14400), S.fundingRaw || []); S.h1p = LN.prepX(closedOnly(S.h1.slice(-24 * 120), 3600), S.fundingRaw || []); S.h12 = LN.prepX(closedOnly(LN.toN(S.h1, 43200), 43200), S.fundingRaw || []); }
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
// ghost trades: signals a team's filters stopped, followed without risk to learn whether each filter helps or costs money
db.exec("CREATE TABLE IF NOT EXISTS ghost_trades (id TEXT PRIMARY KEY, agent INTEGER, ticker TEXT, style TEXT, side TEXT, t INTEGER, reason TEXT, status TEXT, R REAL, tc INTEGER, data TEXT)");
// the lab: 40 free agents (no rules) that only trade as members of 8 teams; no rule agents, no Council
const LAB_SIZE = 0, LAB_KEEP = 0, FREE_SIZE = 40, FREE_KEEP = 20, STREAK = 3, LAB_VERSION = 2;
const lab = { models: {}, samples: null, samplesAt: 0, running: false, at: 0, labels: {}, kinds: {} };
const labAgents = () => kvGet("labAgents", []);
const labName = (id) => +id === 99999 ? "You (Trade Terminal)" : lab.kinds[id] === "team" ? "Team " + id : lab.kinds[id] === "council" ? "Council " + id : (lab.kinds[id] === "free" || (!lab.kinds[id] && kvGet("labFreeIds", []).includes(id)) ? "Free agent " : "Agent ") + id;
const SERIES = (k) => learn.series[k] || {};
const fineFor = (style) => Object.fromEntries(OPP_TICKERS.map((k) => [k, style === "m1" ? SERIES(k).fine1 || [] : style === "swing" || style === "h12" ? SERIES(k).h1 || [] : style === "h1" || style === "scalp" ? SERIES(k).fine || [] : SERIES(k).fine5 || SERIES(k).fine || []]));   // 15m trades are followed on 15m bars (full history)
const barsFor = (k, style) => (style === "m1" ? SERIES(k).m1 : style === "scalp5" ? SERIES(k).m5 : style === "h1" ? SERIES(k).h1p : SERIES(k)[style]);
const nearWinners = (style, f) => { const st = style === "swing" ? "swing" : "scalp"; let n = 0; for (const e of learn.db) { if (e.style !== st || e.demoted) continue; let d = 0; for (let j = 0; j < 16 && d <= 4.84; j++) d += (e.f[j] - f[j]) ** 2; if (d <= 4.84) n++; } return n; };
/** Every labelled past moment (3 markets × 5m / 15m / 4h × both sides), each with how many winning human entries sit close to it. */
function labSamples() {
  if (lab.samples && lab.samplesAt === learn.at) return lab.samples;
  const out = [];
  for (const k of OPP_TICKERS) for (const st of BL.STYLES) for (const s of LN.labSamples(learn.series, k, st)) out.push(s);
  const win = { scalp: learn.db.filter((e) => e.style === "scalp" && !e.demoted), swing: learn.db.filter((e) => e.style === "swing" && !e.demoted) };
  for (const s of out) { let n = 0; for (const e of win[s.style === "swing" ? "swing" : "scalp"]) { let d = 0; for (let j = 0; j < 16 && d <= 4.84; j++) d += (e.f[j] - s.f[j]) ** 2; if (d <= 4.84) n++; } s.like = n; s.w = 1 + Math.min(1, n * 0.5); }   // setups like profitable human trades weigh up to 2x when every agent trains
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
  // every losing setup teaches every agent of the same timeframe, rule and free alike (full weight for its own kind, less for the other)
  const keys = [...new Set(agents.filter((a) => a.kind === "rule" || a.kind === "free").map(poolKey))];
  // (the Council's losses and the archive of retired agents' losses teach everyone too)
  for (const [id, xs] of Object.entries(lessons)) {
    const g = byId[id], from = g ? g.kind : "any";
    for (const x of xs) { const st = x.style || (g && g.style); if (!st || !x.f || x.f.length !== 24) continue;
      for (const k of keys) { const [kind, ks] = k.split("|"); if (ks === st) (out[k] = out[k] || []).push({ f: x.f, y: 0, w: kind === from ? 4 : 2, tc: x.tc }); } }
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
// a free agent learns to find setups that reach its FIRST target (where it books part profit and the SL is already at entry)
// before the stop; the full plan (break-even, part profit, trail, final target) is then simulated for the result
function freeLabel(g) {
  const pa = (g.mgmt && g.mgmt.partialAt) || 1, key = g.style + "|" + (g.preset || 0) + "|" + pa;
  if (!lab.labels[key]) {
    const fine = fineFor(g.style), m = new Map();
    for (const s of lab.samples) { if (s.style !== g.style) continue; const plan = BL.freePlan(g, s), d = plan.side === "long" ? 1 : -1, first = Object.assign({}, plan, { target: plan.entry + d * pa * Math.abs(plan.entry - plan.stop) }), w = LN.walkT(fine[s.ticker], s.t - 1, first, BL.HORIZON[g.style]); if (w) m.set(s.i, { y: w.y, rr: pa, tc: w.tc, plan }); }
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
function liveMetrics(id) { return BL.metrics(liveTrades(id).map((r) => ({ R: r.R, tc: r.tc, t: r.t, side: JSON.parse(r.data).side }))); }
/** Live paper capital: $500 start, each closed trade moves it by R × the risk taken at entry. */
function liveCapital(id) {
  let eq = BL.START, peak = eq, dd = 0; const curve = [], rows = liveTrades(id);
  for (const r of rows) { const o = JSON.parse(r.data); eq = Math.max(0, eq * (1 + (r.R * (o.riskPct || 1)) / 100)); peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); curve.push([r.tc, +eq.toFixed(2)]); }
  const days = rows.length ? Math.max(1, (Date.now() / 1000 - rows[0].t) / 86400) : 1;
  return { start: BL.START, equity: +eq.toFixed(2), roi: eq / BL.START - 1, roiPerDay: (eq / BL.START - 1) / days, maxDDPct: dd, trades: rows.length, busted: eq < 25, smooth: BL.smooth(curve), curve: thin(curve) };
}
// every timeframe keeps a minimum share of the rule pool, so no type of strategy dies out (5m 14, 15m 14, 1h 10, 4h 8)
const STYLE_MIN = { scalp5: 14, scalp: 14, h1: 10, swing: 8 };
const pickStyle = (agents) => { const n = (st) => agents.filter((a) => a.kind === "rule" && a.style === st).length; const short = Object.keys(STYLE_MIN).map((st) => [st, n(st) / STYLE_MIN[st]]).sort((a, b) => a[1] - b[1])[0]; return short && short[1] < 1 ? short[0] : undefined; };
/**
 * A team's call: members = the lab agents it picked for this timeframe (each votes with its own model).
 * The Rotation Captain passes the order to the team with the best recent live record.
 */
// a member's vote counts when it is within 3% of its own confidence bar: the team trades more often, while the agreement
// of several specialists and nobody against keeps the quality
// teams have no daily limit; a team that loses 3 in a row is held to 6 trades a day for 24 hours
const TEAM_VOTE = 0.97, TEAM_HOLD = 6, teamCap = (g) => (g.capUntil && g.capUntil > Date.now() / 1000 ? TEAM_HOLD : Infinity);
function teamCall(g, style, k, P, i, now, snap, agents) {
  const c = snap ? snap.cut : kvGet("labRegimeCut", null), fL = LN.features3(P, i, "long", style), fS = LN.features3(P, i, "short", style); if (!fL || !fS) return { skip: "no data" };
  const byId = agents ? (agents.byId = agents.byId || Object.fromEntries(agents.map((a) => [a.id, a]))) : {};
  const look = snap ? (id) => snap.models[id] : (id) => { const a = byId[id]; return a && lab.models[id] ? { genome: a, model: lab.models[id] } : null; };
  let vf = TM.TYPES[g.team].vote || TEAM_VOTE;
  const vote = (m, side) => { const x = look(m.id); if (!x || !x.genome.tickers.includes(k)) return false; const f = side === "long" ? fL : fS; return BL.predict(x.model, BL.sel(x.genome, f)) >= x.model.cut * vf; };
  if (g.team === "captain") {
    const teams = (snap ? snap.teams : agents.filter((a) => a.kind === "team" && a.team !== "captain" && (a.pool || "rule") === (g.pool || "rule"))).filter((t) => TM.stylesOf(t, BL.STYLES).includes(style));
    // Smart Captain: the team with the best record in THIS market phase on THIS timeframe (5+ trades, 60%+ win, making money)
    const reg = TM.regimeOf(fL, c); let smart = null;
    for (const t of teams) { const x = (lab.trust || {})[`${t.id}|${style}|${reg}`]; if (!x || x.n < 5 || x.w / x.n < 0.6 || x.R <= 0) continue; const sc = ED.wilson(x.w, x.n) + (x.R / x.n) * 0.1; if (!smart || sc > smart.sc) smart = { team: t, sc }; }
    const pick = smart || TM.captainPick(teams, (id) => db.prepare("SELECT R FROM lab_trades WHERE agent = ? AND status = 'closed' AND shadow = 0 ORDER BY tc DESC LIMIT 20").all(id).map((r) => r.R).reverse());
    if (!pick) return { skip: "no team is doing well right now" };
    if (!TM.stylesOf(pick.team, BL.STYLES).includes(style)) return { skip: "the leading team does not trade this timeframe" };
    vf = TM.TYPES[pick.team.team].vote || TEAM_VOTE;
    const d = TM.decide(pick.team, (pick.team.members || {})[style] || [], vote, fL, fS, c, now); return d.side ? Object.assign(d, { via: pick.team.id }) : d;
  }
  if (!TM.stylesOf(g, BL.STYLES).includes(style)) return { skip: "not this team's timeframe" };
  return TM.decide(g, (g.members || {})[style] || [], vote, fL, fS, c, now);
}
/**
 * A team improves right after every loss: each member that voted for the losing trade gets a strike; a member with
 * 2 strikes is swapped at once for the next best specialist (same timeframe, same role, not in the team yet).
 */
function teamAfterLoss(g, o, now) {
  const ms = (g.members || {})[o.style]; if (!ms || g.team === "captain" || inReview(g.id)) return;     // a team in review stays exactly as it passed
  g.strikes = g.strikes || {}; const out = [];
  for (const id of o.voters || []) {
    if ((g.strikes[id] = (g.strikes[id] || 0) + 1) < 2) continue;
    const k = ms.findIndex((m) => m.id === id); if (k < 0) continue;
    const role = ms[k].role, regs = TM.REGIMES.includes(role) ? [role] : TM.REGIMES, used = new Set(ms.map((m) => m.id));
    const inTeams = {}; for (const t of labAgents().filter((x) => x.kind === "team" && x.id !== g.id)) for (const ys of Object.values(t.members || {})) for (const y of ys) inTeams[y.id] = (inTeams[y.id] || 0) + 1;
    const next = (lab.teamCands || []).filter((c) => c.style === o.style && c.kind === (g.pool || "rule") && !used.has(c.id) && (inTeams[c.id] || 0) < 4).sort((a, b) => TM.skillScore(b.skill, regs) - TM.skillScore(a.skill, regs) || b.fit - a.fit)[0];
    if (!next) continue;
    ms[k] = { id: next.id, role }; delete g.strikes[id]; out.push(`${labName(id)} → ${labName(next.id)} (${TM.REGIME_NAME[role] || role}, ${BL.STYLE_NAME[o.style]})`);
  }
  if (out.length) kvSet("labLog", kvGet("labLog", []).concat([{ t: now, agent: g.id, text: `Learned from a loss: swapped ${out.join(", ")}.` }]).slice(-300));
}
/** Passed (Elite Live / free agent gate), not frozen, not sent back: waiting for the human review. */
function inReview(id) { return !!(kvGet("labEliteLive", {})[id] || kvGet("labFreeReady", {})[id]) && !kvGet("labFrozen", {})[id]; }
/** The exact model and settings at the moment an agent passes: this is what you review and what gets frozen. */
/** A team's exact state: leader settings, every member's model, the market-phase thresholds (the Captain: all teams). */
function teamSnapshot(g, agents) {
  const byId = Object.fromEntries(agents.map((a) => [a.id, a])), plainT = (t) => ({ id: t.id, kind: "team", team: t.team, pool: t.pool || "rule", need: t.need || 0, block: Object.assign({}, t.block || {}), members: JSON.parse(JSON.stringify(t.members || {})), tickers: t.tickers.slice(), riskPct: t.riskPct, mgmt: Object.assign({}, t.mgmt), style: t.style });
  const teams = g.team === "captain" ? agents.filter((a) => a.kind === "team" && a.team !== "captain" && (a.pool || "rule") === (g.pool || "rule")).map(plainT) : [], models = {};
  for (const t of [plainT(g)].concat(teams)) for (const ms of Object.values(t.members)) for (const m of ms) if (byId[m.id] && lab.models[m.id]) models[m.id] = { genome: plainGenome(byId[m.id]), model: plainModel(lab.models[m.id]) };
  return { self: Object.assign(plainGenome(g), plainT(g)), teams, models, cut: kvGet("labRegimeCut", null) };
}
function passSnapshot(g) { if (g.kind === "team") { const ps = kvGet("labPassSnap", {}); ps[g.id] = { at: Math.floor(Date.now() / 1000), teamSnap: teamSnapshot(g, labAgents()) }; kvSet("labPassSnap", ps); return; } const M = lab.models[g.id]; if (!M) return; const ps = kvGet("labPassSnap", {}); ps[g.id] = { at: Math.floor(Date.now() / 1000), genome: plainGenome(g), model: plainModel(M) }; kvSet("labPassSnap", ps); }
/** Every 30 minutes: evolve both pools, backtest every agent walk-forward on unseen data, retrain, look for edges. */
async function refreshLab() {
  if (lab.running || !learn.db.length) return;
  lab.running = true;
  try {
    const samples = labSamples(); if (samples.length < 1000) return;
    let agents = labAgents(), gen = kvGet("labGen", 0), nextId = kvGet("labNextId", 1);
    BL.seed(Date.now() % 2147483647);
    agents.forEach(BL.upgrade);
    const frozenNow = kvGet("labFrozen", {}); agents = agents.filter((a) => !frozenNow[a.id]);     // frozen: final, out of evolution
    // fresh start of the team lab (once): old rule agents, Council and teams go; frozen / approved / archived ones stay.
    // Their losing setups move to the shared archive (below), the human database is kept.
    if (kvGet("labVersion", 0) < LAB_VERSION) {
      const keep = new Set(Object.keys(frozenNow).map(Number).concat(Object.keys(kvGet("labArchive", {})).map(Number)));
      db.prepare(`DELETE FROM lab_trades WHERE agent NOT IN (${[...keep].concat([-1]).join(",")})`).run();
      for (const k of ["labEliteLive", "labFreeReady", "labElite", "labEdges", "labPassSnap", "labChallenge", "labNotes"]) kvSet(k, {});
      kvSet("labHistory", []); kvSet("labLog", []); kvSet("labVersion", LAB_VERSION); agents = []; lab.models = {};
    }
    const rules = () => agents.filter((a) => a.kind === "rule"), frees = () => agents.filter((a) => a.kind === "free");
    // the council: one extra agent that trades only when the best agents agree (live only, no evolution)
    agents = agents.filter((a) => a.kind === "free" || a.kind === "team"); const council = null;
    if (!frees().length) agents = agents.concat(Array.from({ length: FREE_SIZE }, () => BL.randomGenome(nextId++, "free")));
    // always 40 free agents: a removed agent's seat gets a newborn right away (it inherits the shared lessons through the pool)
    while (frees().length < FREE_SIZE) agents.push(BL.randomGenome(nextId++, "free"));
    const lessons = kvGet("labLessons", {});
    const hints = kvGet("labHints", {});
    // the teams: one team agent ($500) per team model, its members are picked from the lab every evolution
    const teams = () => agents.filter((a) => a.kind === "team");
    // 8 teams, all made of the free agents
    for (const pl of ["free"]) for (const ty of TM.ORDER) if (!teams().some((a) => a.team === ty && (a.pool || "rule") === pl)) agents.push({ id: nextId++, kind: "team", team: ty, pool: pl, style: "scalp5", tickers: BL.TICKERS.slice(), mask: Array(24).fill(false), riskPct: pl === "free" ? 3 : 1, q: 0.95, mgmt: { partial: true, breakeven: true }, need: 0, members: {}, gen: 0, parent: null, bump: 0 });
    const cut = TM.cutsFrom(samples); kvSet("labRegimeCut", cut);
    if (agents.filter((a) => a.kind === "rule" || a.kind === "free").every((a) => a.bt)) {
      gen++;
      const eliteSet = kvGet("labElite", {}), eliteLiveSet = kvGet("labEliteLive", {});
      // rule pool: keep elites and the best 30; children inherit their parent's lessons; at least 15 scalp agents each of 5m and 15m
      const score = (a) => BL.fitness(a.bt) + (a.live && a.live.trades >= 10 ? BL.fitness(a.live, 10) : 0) + (eliteLiveSet[a.id] ? 100 : eliteSet[a.id] ? 50 : 0);
      // diversity: a near-copy of a better agent is not kept (elites always are), so strategies stay different
      const seenSig = new Set(), R = rules().sort((a, b) => score(b) - score(a)).filter((a) => { const sg = BL.signature(a); if (seenSig.has(sg) && !eliteSet[a.id] && !eliteLiveSet[a.id]) return false; seenSig.add(sg); return true; });
      const keepN = !LAB_SIZE ? 0 : Math.min(LAB_SIZE - 10, Math.max(LAB_KEEP, R.filter((a) => eliteSet[a.id] || eliteLiveSet[a.id]).length), R.length);
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
      // free pool: smooth curve, 75%+ win, never 4 losses in a row, both directions; agents waiting for your review always stay
      const ready = kvGet("labFreeReady", {}), fscore = (a) => (ready[a.id] ? 100 : 0) + (a.capital && a.capital.trades >= 5 ? BL.freeFitness(a.capital, a.capital.trades, a.live) * 2 : 0) + BL.freeFitness(a.btCap, a.bt ? a.bt.trades : 0, a.bt);
      // no copies: same settings, or mostly the same trades (60%+ of the same market-hours) as a better agent -> dropped
      const seenF = new Set(), keptSig = [], F = frees().sort((a, b) => fscore(b) - fscore(a)).filter((a) => {
        const sg = BL.signature(a); if (!ready[a.id] && (seenF.has(sg) || keptSig.some((x) => BL.overlap(x, a.btSig) > 0.6))) return false; seenF.add(sg); if (a.btSig) keptSig.push(a.btSig); return true; });
      const keepF = F.filter((a) => ready[a.id] || !(a.capital && a.capital.busted)).slice(0, Math.max(FREE_KEEP, F.filter((a) => ready[a.id]).length)), bestF = keepF.slice(0, 8), newF = [];
      // the 30 cover everything: at least 10 quick in-and-out plans and 10 big-swing plans, at least 8 agents on each timeframe
      const need = (xs) => { const n = (f) => xs.filter(f).length, st = BL.STYLES.map((x) => [x, n((a) => a.style === x) / 8]).sort((a, b) => a[1] - b[1])[0], pk = ["quick", "big"].map((x) => [x, n((a) => BL.planKind(a) === x) / 10]).sort((a, b) => a[1] - b[1])[0];
        return { style: st[1] < 1 ? st[0] : null, plan: pk[1] < 1 ? pk[0] : null }; };
      const shape = (c) => { const nd = need(keepF.concat(newF)); if (nd.style) c.style = nd.style; if (nd.plan && BL.planKind(c) !== nd.plan) { const ps = BL.presetsOf(nd.plan); c.preset = ps[Math.floor(Math.random() * ps.length)]; } return c; };
      for (let i = 0; i < 3; i++) newF.push(shape(BL.randomGenome(nextId++, "free")));            // fresh free ideas every generation
      for (let i = newF.length; i < FREE_SIZE - keepF.length; i++) { const p = bestF[i % Math.max(1, bestF.length)], q2 = bestF[Math.floor(Math.random() * bestF.length)];
        newF.push(shape(!p ? BL.randomGenome(nextId++, "free") : q2 && q2.id !== p.id && Math.random() < 0.6 ? BL.crossover(p, q2, nextId++, gen, null, hints.free) : BL.mutate(p, nextId++, gen, null, hints.free))); }
      for (const c of newF) if (c.parent) lessons[c.id] = (lessons[c.parent] || []).concat(c.parent2 ? lessons[c.parent2] || [] : []).slice(-60);
      for (const a of newR.concat(newF)) delete a.bt;
      agents = keepR.concat(newR, keepF, newF, teams());
      // retired agents: their losing setups move to a shared archive (last 300 per timeframe), so no lesson is lost
      const alive = new Set(agents.map((a) => String(a.id))), styleOf = Object.fromEntries(labAgents().map((a) => [a.id, a.style]));
      for (const id of Object.keys(lessons)) { if (alive.has(id) || id.startsWith("arch:")) continue;
        for (const x of lessons[id]) { const st = x.style || styleOf[id]; if (st) (lessons["arch:" + st] = lessons["arch:" + st] || []).push(Object.assign({ style: st }, x)); }
        delete lessons[id]; }
      for (const id of Object.keys(lessons)) if (id.startsWith("arch:")) lessons[id] = lessons[id].sort((a, b) => a.tc - b.tc).slice(-300);
      const ids = new Set(agents.map((a) => a.id)); for (const id of Object.keys(lab.models)) if (!ids.has(+id)) delete lab.models[id];
    }
    lab.kinds = Object.fromEntries(agents.map((a) => [a.id, a.kind])); kvSet("labFreeIds", agents.filter((a) => a.kind === "free").map((a) => a.id));
    const edges = kvGet("labEdges", {}), fresh = [], elite = kvGet("labElite", {}), freshElite = [];
    const pool = sharedPool(agents, lessons), libRows = [];
    for (const g of agents) {
      if (g.kind === "council" || g.kind === "team") { g.live = liveMetrics(g.id); delete g.live.curve; g.capital = liveCapital(g.id); g.capital.curve = undefined; continue; }
      // waiting for your review: no retraining, no paper trading; it keeps exactly the model that passed
      if (inReview(g.id)) { const ps = kvGet("labPassSnap", {})[g.id]; if (ps && !lab.models[g.id]) lab.models[g.id] = ps.model; g.live = liveMetrics(g.id); delete g.live.curve; g.capital = liveCapital(g.id); g.capital.curve = undefined; continue; }
      const label = g.kind === "free" ? freeLabel(g) : null;
      const own = (lessons[g.id] || []).filter((x) => x.f && x.f.length === 24 && (!x.style || x.style === g.style)).map((x) => ({ f: x.f, y: 0, w: 5, tc: x.tc }));
      const extra = own.concat(pool[poolKey(g)] || []);
      const r = BL.backtest(g, samples, fineFor(g.style), { extra, label });
      g.bt = btSummary(r); g.btCap = BL.capital(r.trades, g.riskPct); g.btCap.curve = thin(g.btCap.curve); if (g.kind === "free") g.btSig = BL.tradeSig(r.trades);
      g.skill = TM.skillOf(r.trades, cut);                                // its record in each market phase (for the teams)
      g.btT = r.trades.slice(-400).map((x) => ({ k: x.ticker + "|" + g.style, t: x.t, s: x.side, R: x.R }));   // its unseen-data test trades (for the team backtest)
      for (const x of r.trades.slice(-300)) if (x.f) libRows.push({ style: g.style, ticker: x.ticker, side: x.side, phase: TM.regimeOf(x.f, cut), f: x.f, t: x.t, R: x.R, src: "bt" });
      g.live = liveMetrics(g.id); delete g.live.curve; g.capital = liveCapital(g.id); g.capital.curve = undefined;
      // the live model: everything known now, plus the lessons from its losses
      const xs = samples.filter((s) => s.style === g.style && g.tickers.includes(s.ticker)), step = Math.max(1, Math.ceil(xs.length / 12000));
      const tr = xs.filter((_, i) => i % step === 0).map((s) => { const o = label ? label(s) : s; return o ? { f: s.f, y: o.y, w: s.w || 1 } : null; }).filter(Boolean).concat(extra);
      if (tr.length >= 200) { lab.models[g.id] = BL.fit(g, tr); g.rules = BL.explain(g, lab.models[g.id], LN.FEATURES3); }
      if (g.kind !== "free") {
        if (!BL.isElite(g.bt) && elite[g.id]) delete elite[g.id];
        if (BL.isElite(g.bt)) { g.btTrades = r.trades.slice(-600).map((x) => ({ t: x.t, tc: x.tc, R: x.R, p: +x.p.toFixed(3), side: x.side, ticker: x.ticker })); if (!elite[g.id]) { elite[g.id] = { at: Math.floor(Date.now() / 1000) }; freshElite.push(g); } } else delete g.btTrades;
        if (BL.isEdge(g.bt) && !edges[g.id]) { edges[g.id] = { at: Math.floor(Date.now() / 1000) }; fresh.push(g); }
      }
      await tick();
    }
    lab.kinds = Object.fromEntries(agents.map((a) => [a.id, a.kind]));
    // every evolution the teams re-pick their members: the agents with the best skill for each team's job right now
    const cands = agents.filter((a) => (a.kind === "rule" || a.kind === "free") && lab.models[a.id] && a.bt && a.bt.trades >= 10).map((a) => ({ id: a.id, kind: a.kind, style: a.style, skill: a.skill, riskPct: a.riskPct, fit: a.kind === "free" ? BL.freeFitness(a.btCap, a.bt.trades, a.bt) : BL.fitness(a.bt) }));
    // no copied teams: an agent plays in at most 4 teams, and agents in fewer teams are preferred, so every team fields its own mix
    const used = {};
    for (const t of teams()) if (inReview(t.id)) for (const ms of Object.values(t.members || {})) for (const m of ms) used[m.id] = (used[m.id] || 0) + 1;
    for (const t of teams()) if (!inReview(t.id) && t.team !== "captain") {
      const own = cands.filter((c) => c.kind === (t.pool || "rule") && (used[c.id] || 0) < 4).map((c) => Object.assign({}, c, { fit: c.fit - (used[c.id] || 0) * 0.3, skill: c.skill && Object.fromEntries(Object.entries(c.skill).map(([r, o]) => [r, Object.assign({}, o, { w: Math.max(0, o.w - (used[c.id] || 0) * 0.05 * o.n) })])) })); t.members = TM.pickMembers(t.team, own, BL.STYLES); t.strikes = {};
      for (const ms of Object.values(t.members)) for (const m of ms) used[m.id] = (used[m.id] || 0) + 1;
      // a Free Team risks what its members risk (their middle value, 1-15%)
      if (t.pool === "free") { const rs = Object.values(t.members).flat().map((m) => (own.find((c) => c.id === m.id) || {}).riskPct).filter(Boolean).sort((a, b) => a - b); if (rs.length) t.riskPct = Math.min(15, Math.max(1, rs[Math.floor(rs.length / 2)])); }
    }
    { const ft = teams().filter((x) => x.pool === "free" && x.team !== "captain"), cap = teams().find((x) => x.pool === "free" && x.team === "captain"); if (cap && ft.length) cap.riskPct = Math.round(ft.reduce((s, x) => s + x.riskPct, 0) / ft.length) || 3; }
    lab.teamPool = Object.fromEntries(teams().map((t) => [t.id, t.pool || "rule"])); lab.teamCands = cands;
    // the edge library: one scorecard per setup from backtests, profitable human trades and the teams' live paper trades
    for (const e of learn.db) if (e.f && !e.demoted) libRows.push({ style: e.style, ticker: e.ticker, side: e.side, phase: TM.regimeOf(e.f, cut), f: e.f, t: e.t, R: 1, src: "human" });
    const teamIds = new Set(teams().map((t) => t.id));
    for (const r of db.prepare("SELECT agent, ticker, style, side, t, R, data FROM lab_trades WHERE status = 'closed' AND shadow = 0 ORDER BY tc DESC LIMIT 4000").all()) { if (!teamIds.has(r.agent)) continue; const o = JSON.parse(r.data); if (o.f) libRows.push({ style: r.style, ticker: r.ticker, side: r.side, phase: o.regime || TM.regimeOf(o.f, cut), f: o.f, t: r.t, R: r.R, src: "paper" }); }
    lab.library = ED.build(libRows);
    { const v = Object.values(lab.library).map(ED.judge); lab.libStats = { setups: v.length, good: v.filter((x) => x.verdict === "good").length, bad: v.filter((x) => x.verdict === "bad").length, rows: libRows.length, human: libRows.filter((x) => x.src === "human").length, paper: libRows.filter((x) => x.src === "paper").length, bt: libRows.filter((x) => x.src === "bt").length }; }
    // each team's own backtest on unseen data: its members' walk-forward test trades combined like a team vote
    { const byId = Object.fromEntries(agents.map((a) => [a.id, a])); for (const t of teams()) if (t.team !== "captain") t.teamBt = ED.teamBacktest(Object.values(t.members || {}).flat().map((m) => (byId[m.id] && byId[m.id].btT) || []), TM.TYPES[t.team].need || 2); }
    kvSet("labHints", { rule: featureHints(agents.filter((a) => a.kind === "rule").sort((a, b) => BL.fitness(b.bt) - BL.fitness(a.bt)).slice(0, 10)), free: featureHints(agents.filter((a) => a.kind === "free").sort((a, b) => BL.freeFitness(b.btCap, b.bt ? b.bt.trades : 0, b.bt) - BL.freeFitness(a.btCap, a.bt ? a.bt.trades : 0, a.bt)).slice(0, 8)), at: Math.floor(Date.now() / 1000) });
    fresh.sort((a, b) => BL.fitness(b.bt) - BL.fitness(a.bt));
    // (teams only: individual agents no longer send Edge / Elite Edge alerts; they learn quietly as team members)

    const ratings = BL.rate(agents.filter((a) => elite[a.id] && a.bt).map((a) => ({ id: a.id, R: a.bt.totalR })));


    kvSet("labElite", elite); kvSet("labLessons", lessons);
    const rf = agents.filter((a) => a.kind === "rule").map((a) => BL.fitness(a.bt)), ff = agents.filter((a) => a.kind === "free");
    kvSet("labHistory", kvGet("labHistory", []).concat([{ gen, t: Math.floor(Date.now() / 1000), trading: agents.filter((a) => a.bt && a.bt.trades > 0).length, best: +Math.max(...rf).toFixed(3), avg: +(rf.reduce((s, x) => s + x, 0) / rf.length).toFixed(3),
      stalled: (() => { const h = kvGet("labHistory", []); return h.length >= 6 && Math.max(...h.slice(-6).map((x) => x.best)) <= (h[h.length - 7] || { best: -Infinity }).best + 1e-6; })(), unique: new Set(agents.map(BL.signature)).size,
      bestWin: Math.max(...agents.filter((a) => a.kind === "rule").map((a) => (a.bt && a.bt.trades >= 25 ? a.bt.winRate : 0))), bestFreeRoi: Math.max(...ff.map((a) => (a.btCap ? a.btCap.roi : -1))), bestFreeLive: Math.max(...ff.map((a) => (a.capital ? a.capital.equity : 0))) }]).slice(-1000));
    kvSet("labAgents", agents); kvSet("labGen", gen); kvSet("labNextId", nextId); kvSet("labEdges", edges);
    lab.at = Date.now();
  } finally { lab.running = false; lab.samples = null; lab.samplesAt = 0; lab.labels = {}; }   // free the training data until the next evolution
}
/**
 * Recent losing setups of every agent, per timeframe, standardised. like(style, f) = how many of them are
 * nearly the same setup as f (cosine similarity ≥ 0.95 over all 24 inputs).
 */
function lossBank(agents, lessons) {
  const style = Object.fromEntries(agents.map((a) => [a.id, a.style])), by = {};
  for (const [id, xs] of Object.entries(lessons)) for (const x of xs) { const st = x.style || style[id]; if (st && x.f && x.f.length === 24) (by[st] = by[st] || []).push(x); }
  const bank = {};
  for (const [st, xs] of Object.entries(by)) {
    const L = xs.sort((a, b) => b.tc - a.tc).slice(0, 400); if (L.length < 20) continue;
    const mu = Array.from({ length: 24 }, (_, j) => L.reduce((s, x) => s + x.f[j], 0) / L.length), sd = mu.map((m, j) => Math.sqrt(L.reduce((s, x) => s + (x.f[j] - m) ** 2, 0) / L.length) || 1);
    const z = (f) => { const v = f.map((x, j) => (x - mu[j]) / sd[j]), n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
    bank[st] = { z, rows: L.map((x) => z(x.f)) };
  }
  return { like: (st, f) => { const b = bank[st]; if (!b || !f) return 0; const q = b.z(f); return b.rows.filter((r) => r.reduce((s, x, j) => s + x * q[j], 0) >= 0.95).length; } };
}
const labMsg = (g, o, head) => `🤖 ${labName(g.id)} · ${head}${o.side === "long" ? "🟢 LONG" : "🔴 SHORT"} on ${LN.ticker(o.ticker).name} at ${fmtP(o.plan.entry)}, SL ${fmtP(o.plan.stop)} (${o.slPips} pips), TP ${fmtP(o.plan.target)} (${o.tpPips} pips) · ${BL.STYLE_NAME[o.style] || o.style} · risk ${o.riskPct}% of $${o.equity}`;
/** Every 5 minutes: settle open paper trades, apply the losing-streak rule, open new trades where an agent is confident. */
/**
 * The challenge, all of it: 100+ live paper trades, win rate 75%+, never more than 3 losses in a row (live), AND
 * profit factor 1.5+ with money made, a win rate we are 95% sure is 65%+ (luck-proof), AND the double test: the team's
 * own backtest on unseen data shows 30+ trades, 70%+ win, profit factor 1.5+.
 */
// ---------------------------------------------------------------- Trade Terminal helpers
let TERM_HTML = null;
const TERMINAL_HTML = "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\"><meta name=\"theme-color\" content=\"#0d1014\">\n<title>TraderGze</title>\n<meta name=\"claude:viewport-fit-sides\" content=\"cover\">\n<link rel=\"stylesheet\" href=\"https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600&amp;display=swap\">\n<style>\n/* Layout: one-screen trading terminal. Header, timeframe strip, tool strip, canvas stage, bottom tabs. */\n:root{--bg:#0d1014;--panel:#141920;--line:#232b35;--fg:#d9dfe7;--mute:#7f8b99;--up:#26b585;--dn:#e5534b;--acc:#e8a838;--acc-ink:#1a1305;--grid:#1a2029;color-scheme:dark;\n--sans:\"IBM Plex Sans\",system-ui,sans-serif;--mono:\"IBM Plex Mono\",ui-monospace,monospace}\n@media (prefers-color-scheme:light){:root:not([data-theme=\"dark\"]){--bg:#f4f5f7;--panel:#fff;--line:#d9dde3;--fg:#161b22;--mute:#626d7b;--up:#0f9468;--dn:#d03a33;--acc:#b87a0a;--acc-ink:#fff;--grid:#e8ebef;color-scheme:light}}\n:root[data-theme=\"light\"]{--bg:#f4f5f7;--panel:#fff;--line:#d9dde3;--fg:#161b22;--mute:#626d7b;--up:#0f9468;--dn:#d03a33;--acc:#b87a0a;--acc-ink:#fff;--grid:#e8ebef;color-scheme:light}\nhtml,body{height:100%}\nbody{background:var(--bg);color:var(--fg);font:14px/1.4 var(--sans);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px);overflow:hidden}\n.top,.menu,#favs,.strip,.tabs{padding-left:8px;padding-right:8px}.scroll{padding-left:10px;padding-right:10px}\n*{box-sizing:border-box}\n[hidden]{display:none!important}\ninput[type=range]{accent-color:var(--acc)}\nbutton,select,input,textarea{font:inherit;color:inherit}\n#app{height:100%;display:flex;flex-direction:column;min-width:0}\n.brand{display:none!important;padding:6px 0 0;line-height:0}.logo{display:block;height:20px;width:auto;max-width:60%;filter:invert(.87)}\n:root[data-theme=\"light\"] .logo{filter:none}@media (prefers-color-scheme:light){:root:not([data-theme=\"dark\"]) .logo{filter:none}}\n.top{display:flex;align-items:center;gap:10px;padding:5px 0 2px;min-width:0}\n.top select{background:var(--panel);border:1px solid var(--line);border-radius:6px;height:30px;padding:0 8px;font-weight:600}\n.px{display:flex;flex-direction:column;line-height:1.15;font-family:var(--mono);min-width:0}\n.px b{font-size:17px;font-weight:500}.px span{font-size:12px}\n.badge{margin-left:auto;font-size:11px;border:1px solid var(--line);border-radius:10px;padding:2px 8px;color:var(--mute);white-space:nowrap}\n.badge.live{color:var(--up);border-color:var(--up)}\n.strip{display:flex;gap:6px;overflow-x:auto;padding:4px 0;scrollbar-width:none}\n.strip::-webkit-scrollbar{display:none}\n.strip button{flex:none;height:28px;padding:0 10px;border:1px solid var(--line);background:var(--panel);border-radius:6px;font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer}\n.strip button.on{background:var(--acc);color:var(--acc-ink);border-color:var(--acc)}\n.strip .lg{color:var(--up)}.strip .sh{color:var(--dn)}\n.strip .lbl{flex:none;align-self:center;font:12px var(--mono);color:var(--mute)}\n.sep{flex:none;width:1px;background:var(--line);margin:4px 2px}\n.menu{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:3px 0 4px}\n.menu button{padding:0 2px;height:28px;border:1px solid var(--line);background:var(--panel);border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.menu button.on{background:var(--acc);color:var(--acc-ink);border-color:var(--acc)}\n.panel{max-height:32vh;overflow-y:auto;border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:8px;margin-bottom:6px;display:flex;flex-direction:column;gap:8px}\n.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(78px,1fr));gap:6px}\n.grid button,.panel .strip button{height:34px;border:1px solid var(--line);background:var(--bg);border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap}\n.grid button.on,.panel .strip button.on{background:var(--acc);color:var(--acc-ink);border-color:var(--acc)}\n.fav::after{content:\"\\2605\";font-size:9px;margin-left:4px;color:var(--acc)}\n.on.fav::after{color:var(--acc-ink)}\n.grid .lg{color:var(--up)}.grid .sh{color:var(--dn)}\n.srow{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--mute);min-width:0}\n.srow label{flex:1;min-width:0}.srow input[type=range]{flex:1.4;min-width:0}\n.dsel{display:grid;grid-template-columns:1fr 1fr;gap:6px}\n.dsel label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--mute)}\n.dsel select{height:32px;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:0 6px;min-width:0}\n.cgrid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}\n.cgrid label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--mute)}\n.cgrid input[type=color]{width:100%;height:30px;padding:0;border:1px solid var(--line);border-radius:6px;background:none}\n#indChip{position:absolute;right:62px;bottom:24px;z-index:2;height:28px;padding:0 10px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:14px;font-size:12px;cursor:pointer;opacity:.92}\n#sbar{position:absolute;left:8px;bottom:30px;display:flex;gap:6px;z-index:2}\n#sbar button{height:32px;padding:0 12px;border:1px solid var(--line);background:var(--panel);border-radius:6px;font-size:12px;font-weight:500;cursor:pointer}\n#sbar button:last-child{color:var(--dn)}\n.props{display:flex;align-items:center;gap:6px;padding:2px 0 6px;overflow-x:auto;scrollbar-width:none}\n.props>*{flex:none}\n.sw{width:24px;height:24px;border-radius:50%;border:2px solid var(--line);padding:0;cursor:pointer}\n.sw.on{border-color:var(--fg)}\n.props input[type=color]{width:28px;height:28px;padding:0;border:0;background:none}\n.props input[type=text]{height:28px;width:110px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:0 8px}\n.props button{height:28px;padding:0 10px;border:1px solid var(--line);background:var(--panel);border-radius:6px;font-size:12px;cursor:pointer}\n.props .del{color:var(--dn)}\n.view{display:none;flex:1;min-height:0;flex-direction:column}\n.view.on{display:flex}\n.stage{flex:1;min-height:0;position:relative;border:0;border-radius:0;overflow:hidden}\n#cv{display:block;touch-action:none;width:100%;height:100%}\n.scroll{flex:1;min-height:0;overflow-y:auto;padding-bottom:8px}\n.row{display:grid;grid-template-columns:1fr auto auto;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);cursor:pointer}\n.row b{font-weight:600}.row .m{font:13px var(--mono);text-align:right}\n.row svg{width:70px;height:24px}\nh2{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:12px 0 6px}\n.form{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0}\n.form select,.form input{height:36px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:0 8px;min-width:0;flex:1 1 110px}\n.btn{height:36px;padding:0 14px;border:1px solid var(--acc);background:var(--acc);color:var(--acc-ink);border-radius:6px;font-weight:600;cursor:pointer}\n.btn.ghost{background:var(--panel);color:var(--fg);border-color:var(--line)}\n.al{display:flex;gap:10px;align-items:center;padding:9px 0;border-bottom:1px solid var(--line)}\n.al .t{flex:1;min-width:0;font-size:13px}.al.off{opacity:.5}\n.al button{height:28px;padding:0 10px;border:1px solid var(--line);background:var(--panel);border-radius:6px;font-size:12px;cursor:pointer}\n#code{flex:1;min-height:200px;width:100%;resize:none;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;font:13px/1.5 var(--mono);white-space:pre;overflow:auto;tab-size:2}\n#con{font:12px/1.5 var(--mono);padding:8px 0;color:var(--mute);max-height:96px;overflow:auto}\n#con.err{color:var(--dn)}\ndetails{font-size:12px;color:var(--mute);padding:4px 0}\n#inputs[open]{max-height:40vh;overflow:auto}#bk{border-top:1px solid var(--line);flex:none}#bk p{margin:4px 0}.irowc{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);min-width:0}\n.irowc.off .nm{opacity:.5}\n.irowc .nm{flex:1;min-width:0;text-align:left;border:0;background:none;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;padding:6px 0}\n.irowc .nm2{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\n.irowc .st{font-size:11px;color:var(--mute)}.irowc .bad{color:var(--dn)}\n.irowc button:not(.nm){height:30px;padding:0 10px;border:1px solid var(--line);background:var(--panel);border-radius:6px;font-size:12px;cursor:pointer}\n.irowc input[type=checkbox],.irow input[type=checkbox]{width:20px;height:20px;accent-color:var(--acc)}\n.irowc .del,.btn.del{color:var(--dn)}.btn[disabled]{opacity:.4}\n.ed{border:1px solid var(--line);border-radius:6px;background:var(--panel);padding:8px 10px;margin:6px 0}\n.ed h3{font-size:12px;color:var(--mute);margin:10px 0 2px}\n.ed textarea.code{width:100%;min-height:240px;resize:vertical;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;font:12px/1.5 var(--mono);white-space:pre;overflow:auto}\n.irow input[type=text]{width:160px;height:32px;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:0 8px}\n.tfrow{margin:6px 0}.tfrow>span{font-size:12px;color:var(--mute)}.tfrow .grid{margin:4px 0}.mut{color:var(--mute);font-size:12px;margin:4px 0}.err{color:var(--dn);font:12px/1.5 var(--mono);margin:4px 0}.msg{margin:6px 0}\ndetails h2{margin:10px 0 4px}.irow{display:flex;align-items:center;gap:10px;justify-content:space-between;padding:5px 0;color:var(--fg)}.irow span{flex:1;min-width:0}.irow input[type=number],.irow select{width:130px;height:32px;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:0 6px}.irow input[type=color]{width:48px;height:30px;padding:0;border:1px solid var(--line);background:none}\n.form{flex:none}\ndetails code{font-family:var(--mono);color:var(--fg)}\n.tabs{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line);margin:3px 0 0}\n.tabs button{height:32px;border:0;background:none;font-size:13px;font-weight:500;color:var(--mute);border-top:2px solid transparent;cursor:pointer}\n.tabs button.on{color:var(--fg);border-top-color:var(--acc)}\nbody.host .top,body.host .brand,body.host [data-go=watch],body.host #bk{display:none!important}\nbody.host .tabs{grid-template-columns:repeat(3,1fr)}\nbody.host{padding-left:6px;padding-right:6px}\n#toast{position:fixed;left:50%;bottom:calc(52px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:9px 14px;border-radius:8px;font-size:13px;max-width:90vw;opacity:0;pointer-events:none;transition:opacity .2s}\n#toast.on{opacity:1}\n#fold{position:absolute;top:0;right:3px;width:34px;height:14px;padding:0;border:1px solid var(--line);border-top:0;border-radius:0 0 8px 8px;background:var(--panel);color:var(--mute);font-size:8px;line-height:12px;cursor:pointer;z-index:3;opacity:.9}\n#autoBtn{position:absolute;right:4px;bottom:22px;height:22px;padding:0 8px;border:1px solid var(--acc);background:var(--panel);color:var(--acc);border-radius:11px;font-size:11px;font-weight:600;cursor:pointer;z-index:3}\nbody.fold .brand,body.fold .top,body.fold .menu,body.fold #favs,body.fold .panel,body.fold .tabs{display:none!important}\nbody.fold{padding-left:2px;padding-right:2px}\nbutton:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--acc);outline-offset:1px}\n@media (prefers-reduced-motion:reduce){#toast{transition:none}}\n</style>\n\n<script id=\"tk-embed\" type=\"application/json\">{\"app\":\"tickline\",\"ts\":1793458277721,\"data\":{\"tk.fold\":\"false\",\"tk.pi.-1212908162\":\"{\\\"Delta Text Size\\\":\\\"auto\\\",\\\"Filter Mode\\\":\\\"Remove Low Delta Rows\\\",\\\"Noise Filter Strength\\\":20,\\\"Show POC Line?\\\":false,\\\"Show Delta Value Text?\\\":true}\",\"tk.d.BTCUSDT\":\"[{\\\"id\\\":1,\\\"type\\\":\\\"rect\\\",\\\"c\\\":\\\"#e8a838\\\",\\\"w\\\":1,\\\"pts\\\":[{\\\"t\\\":1792656028285.4746,\\\"p\\\":82053.71313087147},{\\\"t\\\":1792811625001.7852,\\\"p\\\":81984.86813771773}]},{\\\"id\\\":2,\\\"type\\\":\\\"rect\\\",\\\"c\\\":\\\"#e8a838\\\",\\\"w\\\":1,\\\"pts\\\":[{\\\"t\\\":1792630796114.3894,\\\"p\\\":83006.87386517908},{\\\"t\\\":1792853571110.3018,\\\"p\\\":82807.47245434065}]},{\\\"id\\\":3,\\\"type\\\":\\\"rect\\\",\\\"c\\\":\\\"#e8a838\\\",\\\"w\\\":1,\\\"pts\\\":[{\\\"t\\\":1792347984818.0442,\\\"p\\\":81007.58410599564},{\\\"t\\\":1792780836152.0095,\\\"p\\\":80888.15528734773}]},{\\\"id\\\":1,\\\"type\\\":\\\"rect\\\",\\\"c\\\":\\\"#e8a838\\\",\\\"w\\\":1,\\\"pts\\\":[{\\\"t\\\":1792045154554.4546,\\\"p\\\":80670.15957257675},{\\\"t\\\":1792914175268.5276,\\\"p\\\":80538.54021183429}]},{\\\"id\\\":1,\\\"type\\\":\\\"hline\\\",\\\"c\\\":\\\"#e8a838\\\",\\\"w\\\":1,\\\"pts\\\":[{\\\"t\\\":1789723211287.5166,\\\"p\\\":76706.08379546946},{\\\"t\\\":1789723211287.5166,\\\"p\\\":76706.08379546946}]},{\\\"id\\\":2,\\\"type\\\":\\\"hline\\\",\\\"c\\\":\\\"#e8a838\\\",\\\"w\\\":1,\\\"pts\\\":[{\\\"t\\\":1789796329998.6316,\\\"p\\\":76513.2691753679},{\\\"t\\\":1789796329998.6316,\\\"p\\\":76513.2691753679}]}]\",\"tk.style\":\"{\\\"up\\\":\\\"#595959\\\",\\\"dn\\\":\\\"#c7c7c7\\\",\\\"bUp\\\":\\\"\\\",\\\"bDn\\\":\\\"\\\",\\\"wUp\\\":\\\"\\\",\\\"wDn\\\":\\\"\\\",\\\"bodyA\\\":1,\\\"borderA\\\":0,\\\"wickA\\\":0.1,\\\"hGrid\\\":false,\\\"vGrid\\\":false}\",\"tk.theme\":\"\\\"dark\\\"\",\"tk.alerts\":\"[]\",\"tk.tf\":\"\\\"30m\\\"\",\"tk.sym\":\"\\\"crypto:BTC/USDT\\\"\",\"tk.run\":\"1\",\"tk.lock\":\"true\",\"tk.delta\":\"{\\\"on\\\":false,\\\"sess\\\":\\\"Auto\\\",\\\"method\\\":\\\"polarity\\\",\\\"box\\\":0.5,\\\"poc\\\":\\\"#ffc800\\\",\\\"buy\\\":\\\"#2962ff\\\",\\\"sell\\\":\\\"#ff1744\\\",\\\"text\\\":true,\\\"pocLine\\\":false,\\\"pocLineC\\\":\\\"#ff3b30\\\",\\\"noise\\\":\\\"low\\\",\\\"level\\\":10,\\\"rows\\\":20,\\\"x2\\\":false,\\\"period\\\":20,\\\"mult\\\":2,\\\"outBull\\\":\\\"#00e676\\\",\\\"outBear\\\":\\\"#f23645\\\",\\\"norm\\\":\\\"#787b86\\\"}\",\"tk.code\":\"\\\"// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/\\\\n// © TraderGze - Delta Profile Multi-Session\\\\n// (Derived from \\\\\\\"Smart Volume Profile Multi-Session\\\\\\\" — the volume-profile\\\\n// box drawing has been REPLACED by delta (buy-sell) box drawing, in the\\\\n// SAME right-facing orientation/position the volume boxes used, so it\\\\n// still works across every session mode: 4H / 12H / 3D.)\\\\n\\\\n//@version=6\\\\nindicator(\\\\\\\"Smart Delta Profile High Vol\\\\\\\", overlay=true, max_labels_count=500, max_boxes_count=500, max_lines_count=500, max_bars_back=1000)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// SESSION TIMEFRAME SETTINGS\\\\n//   Auto mode:  5m chart → 4 Hour Profile | 15m chart → 12 Hour Profile | 45m chart → 3 Day Profile\\\\n//   Or force a specific session length manually.\\\\n// ─────────────────────────────────────────────\\\\nsess_mode = input.string(\\\\\\\"Auto (by chart TF)\\\\\\\", title=\\\\\\\"Delta Profile Session Length\\\\\\\", group=\\\\\\\"Profile Session\\\\\\\", options=[\\\\\\\"Auto (by chart TF)\\\\\\\", \\\\\\\"4 Hour\\\\\\\", \\\\\\\"12 Hour\\\\\\\", \\\\\\\"3 Day\\\\\\\"], tooltip=\\\\\\\"Auto: 5m→4H, 15m→12H, 45m→3D. Any other chart TF defaults to 4H.\\\\\\\")\\\\n\\\\n// resolve the session length in milliseconds\\\\nint chart_tf_min = timeframe.in_seconds() / 60\\\\nstring sess_name = \\\\\\\"\\\\\\\"\\\\nint sess_len_ms  = 0\\\\nif sess_mode == \\\\\\\"4 Hour\\\\\\\"\\\\n    sess_len_ms := 14400000\\\\n    sess_name   := \\\\\\\"4Hr\\\\\\\"\\\\nelse if sess_mode == \\\\\\\"12 Hour\\\\\\\"\\\\n    sess_len_ms := 43200000\\\\n    sess_name   := \\\\\\\"12Hr\\\\\\\"\\\\nelse if sess_mode == \\\\\\\"3 Day\\\\\\\"\\\\n    sess_len_ms := 259200000\\\\n    sess_name   := \\\\\\\"3D\\\\\\\"\\\\nelse\\\\n    // Auto\\\\n    if chart_tf_min == 15\\\\n        sess_len_ms := 43200000\\\\n        sess_name   := \\\\\\\"12Hr\\\\\\\"\\\\n    else if chart_tf_min == 45\\\\n        sess_len_ms := 259200000\\\\n        sess_name   := \\\\\\\"3D\\\\\\\"\\\\n    else\\\\n        sess_len_ms := 14400000\\\\n        sess_name   := \\\\\\\"4Hr\\\\\\\"\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// X2 VOLUME SETTINGS\\\\n// ─────────────────────────────────────────────\\\\nx2_period   = input.int(20, title=\\\\\\\"Volume EMA Period\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_strength = input.float(2, title=\\\\\\\"Volume Strength Multiplier\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\", minval=0, tooltip=\\\\\\\"2 = 200% of average volume. Candles above this threshold are highlighted.\\\\\\\")\\\\n\\\\nx2_out_bull_color  = input.color(color.lime, title=\\\\\\\"Outside VA — Bull Candle Color\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_out_bear_color  = input.color(color.red,  title=\\\\\\\"Outside VA — Bear Candle Color\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_in_bull_color   = input.color(color.gray, title=\\\\\\\"Inside VA — Bull Candle Color\\\\\\\",  group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_in_bear_color   = input.color(color.gray, title=\\\\\\\"Inside VA — Bear Candle Color\\\\\\\",  group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_norm_bull_color = input.color(color.gray, title=\\\\\\\"Normal — Bull Candle Color\\\\\\\",     group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_norm_bear_color = input.color(color.gray, title=\\\\\\\"Normal — Bear Candle Color\\\\\\\",     group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// DELTA PROFILE SETTINGS\\\\n// ─────────────────────────────────────────────\\\\ndelta_method_1   = \\\\\\\"Bar Polarity\\\\\\\"\\\\ndelta_method_2   = \\\\\\\"Bar Buying/Selling Pressure\\\\\\\"\\\\ndelta_method     = input.string(delta_method_1, title=\\\\\\\"Delta Polarity Method\\\\\\\", options=[delta_method_1, delta_method_2], group=\\\\\\\"Delta Profile\\\\\\\", tooltip=\\\\\\\"Bar Polarity: up if close>open.\\\\\\\\nBar Buying/Selling Pressure: up if (close-low) > (high-close).\\\\\\\")\\\\ndelta_box_size   = input.float(0.5, minval=0.1, maxval=10.0, step=0.1, title=\\\\\\\"Delta Box Size\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\", tooltip=\\\\\\\"Width multiplier. Smaller values merge more rows into fewer boxes.\\\\\\\")\\\\npoc_box_color    = input.color(color.rgb(255, 200, 0), title=\\\\\\\"POC (Highest Volume Row) Box Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_buy_color  = input.color(color.new(#2962FF, 15), title=\\\\\\\"Delta Buy-Dominant Color\\\\\\\",  group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_sell_color = input.color(color.new(#FF1744, 15), title=\\\\\\\"Delta Sell-Dominant Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_show_text  = input.bool(true, title=\\\\\\\"Show Delta Value Text?\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_text_size  = input.string(size.tiny, title=\\\\\\\"Delta Text Size\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\", options=[size.auto, size.tiny, size.small, size.normal])\\\\nshow_poc_line    = input.bool(true, title=\\\\\\\"Show POC Line?\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\npoc_line_color   = input.color(color.rgb(255, 0, 0, 100), title=\\\\\\\"POC Line Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// NOISE FILTER SETTINGS\\\\n//   Option 1: Remove Low Delta Rows  -> keep the strongest-|delta| nodes\\\\n//   Option 2: Remove High Delta Rows -> keep the weakest-|delta| nodes\\\\n// ─────────────────────────────────────────────\\\\nnoise_mode_off  = \\\\\\\"Off\\\\\\\"\\\\nnoise_mode_low  = \\\\\\\"Remove Low Delta Rows\\\\\\\"\\\\nnoise_mode_high = \\\\\\\"Remove High Delta Rows\\\\\\\"\\\\nnoise_mode = input.string(noise_mode_off, title=\\\\\\\"Filter Mode\\\\\\\", options=[noise_mode_off, noise_mode_low, noise_mode_high], group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"Ranks rows by the SIZE of their delta |buy - sell|, regardless of direction.\\\\\\\\n\\\\\\\\nRemove Low Delta Rows: hides rows with small |delta| so only the strongest buy/sell imbalance nodes remain.\\\\\\\\n\\\\\\\\nRemove High Delta Rows: hides rows with large |delta| so only the low-delta (balanced) nodes remain.\\\\\\\")\\\\nnoise_level = input.int(5, minval=1, maxval=10, title=\\\\\\\"Noise Filter Strength\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"1 = minimal filtering (show most rows), 10 = aggressive filtering (show only the highest-|delta| nodes in Low mode / only the low-|delta| nodes in High mode). Raise to cut noise, lower to see more detail.\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// TICK SIZE CONFIGURATION\\\\n// ─────────────────────────────────────────────\\\\nauto_tick_size_b  = input.bool(true, title=\\\\\\\"Auto Tick Size?\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\nint tick_bars_back = input.int(96, minval=1, title=\\\\\\\"Avg Tick Size - Bars Back\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\ntarget_session_ht = input.float(20, minval=1, title=\\\\\\\"Average Target Session Height for Tick Size\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\", tooltip=\\\\\\\"Approx. number of rows per session. LOWER = fewer rows = fewer boxes = MORE past sessions visible.\\\\\\\")\\\\nman_tick_size     = input.int(100, minval=1, title=\\\\\\\"Manual Tick Size\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// INFO TABLE\\\\n// ─────────────────────────────────────────────\\\\nshow_tpo_info         = input.bool(true, title=\\\\\\\"Show Info Text?\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\ninfo_table_txt_size   = input.string(size.small, title=\\\\\\\"Info Text Size\\\\\\\", group=\\\\\\\"Info Table\\\\\\\", options=[size.auto, size.tiny, size.small, size.normal, size.large, size.huge])\\\\ninfo_table_text_color = input.color(color.rgb(255, 255, 255), title=\\\\\\\"Info Box Letter Color\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\ninfo_table_color      = input.color(color.rgb(255, 255, 255), title=\\\\\\\"Info Box Background Color\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// GLOBAL CALCULATIONS (v6 consistency requirement)\\\\n// ─────────────────────────────────────────────\\\\navg_bar_ht_global = ta.sma(high, tick_bars_back) - ta.sma(low, tick_bars_back)\\\\nvol_ema_global    = ta.ema(volume, x2_period)\\\\n\\\\n// SESSION DETECTION — generic, epoch-anchored blocks (UTC)\\\\nsess_block  = math.floor(time / sess_len_ms)\\\\nsess_change = sess_block != sess_block[1]\\\\nsess_start_global = nz(ta.barssince(sess_change))\\\\n\\\\nbool is_in_session = true\\\\nint  sess_start    = sess_start_global\\\\n\\\\nif syminfo.type == \\\\\\\"economic\\\\\\\"\\\\n    is_in_session := false\\\\n\\\\nsess_start_bar = int(bar_index - sess_start)\\\\n\\\\n// PERFORMANCE GATE — is this the FINAL bar of its session?\\\\nsess_block_close = math.floor(time_close / sess_len_ms)\\\\nbool is_sess_last_bar = sess_block_close != sess_block\\\\nbool do_full_calc = barstate.islast or is_sess_last_bar\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// HELPER FUNCTIONS\\\\n// ─────────────────────────────────────────────\\\\n// A bar contributes its FULL volume to a row if its range [low, high]\\\\n// overlaps the half-open row bucket [row_low, row_low + tick_size).\\\\nfn_volume_per_tick(row_low, row_top_excl, bars_back) =>\\\\n    float row_volume = 0.0\\\\n    for i = 0 to bars_back\\\\n        if high[i] >= row_low and low[i] \\u003c row_top_excl\\\\n            row_volume := row_volume + volume[i]\\\\n    row_volume\\\\n\\\\n// Same \\\\\\\"touch\\\\\\\" test as fn_volume_per_tick, but splits the contributed\\\\n// volume into a BUY (bull) portion using the chosen polarity method.\\\\nfn_bull_volume_per_tick(row_low, row_top_excl, bars_back, use_pressure_method) =>\\\\n    float bull_volume = 0.0\\\\n    for i = 0 to bars_back\\\\n        if high[i] >= row_low and low[i] \\u003c row_top_excl\\\\n            bool bar_is_bull = use_pressure_method ? (close[i] - low[i]) > (high[i] - close[i]) : close[i] > open[i]\\\\n            if bar_is_bull\\\\n                bull_volume := bull_volume + volume[i]\\\\n    bull_volume\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// VISUAL OBJECT ARRAYS\\\\n// ─────────────────────────────────────────────\\\\nvar deltaBoxIDs      = array.new_box(0)\\\\nvar last_deltaBoxIDs = array.new_box(0)\\\\nvar pocLineID         = line(na)\\\\nvar lastPocLineIDs    = array.new_line(0)\\\\n\\\\nTPO_price      = array.new_float(0)\\\\nTPO_length     = array.new_float(0)   // total volume per row (still needed to find POC + scale boxes)\\\\nTPO_delta_bull = array.new_float(0)   // bull (buy-side) volume per row, parallel to TPO_length/TPO_price\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// TICK SIZE CALCULATION (na-safe on first bars: falls back to bar range)\\\\n// ─────────────────────────────────────────────\\\\nfloat tick_size = syminfo.mintick\\\\n\\\\ntick_size := if auto_tick_size_b and sess_start == 0\\\\n    float bar_ht = na(avg_bar_ht_global) ? (high - low) : avg_bar_ht_global\\\\n    float auto_tick = math.round_to_mintick(bar_ht / target_session_ht)\\\\n    if auto_tick == 0 or na(auto_tick)\\\\n        auto_tick := syminfo.mintick\\\\n    auto_tick\\\\nelse if sess_start == 0 and not auto_tick_size_b\\\\n    man_tick_size * syminfo.mintick\\\\nelse\\\\n    tick_size[sess_start]\\\\n\\\\nhalf_tick = math.round_to_mintick(tick_size * 0.5)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// SESSION HIGH/LOW — incremental (no per-bar loop over the session)\\\\n// ─────────────────────────────────────────────\\\\nvar float p_sess_hi = na\\\\nvar float p_sess_lo = na\\\\nif sess_start == 0\\\\n    p_sess_hi := na\\\\n    p_sess_lo := na\\\\nfloat highest_high = na(p_sess_hi) ? high : math.max(p_sess_hi, high)\\\\nfloat lowest_low   = na(p_sess_lo) ? low  : math.min(p_sess_lo, low)\\\\nif barstate.isconfirmed\\\\n    p_sess_hi := highest_high\\\\n    p_sess_lo := lowest_low\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// PROFILE RANGE — grid anchored at the actual session low\\\\n// ─────────────────────────────────────────────\\\\nfloat TPO_min  = lowest_low\\\\nint   TPO_rows = math.max(0, int(math.ceil((highest_high - TPO_min) / tick_size)) - 1)\\\\nfloat TPO_mid  = math.round_to_mintick((lowest_low + highest_high) / 2)\\\\nTPO_POC = float(na)\\\\n\\\\nvar float curr_TPO_POC = na\\\\nvar float prev_TPO_POC = na\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// MAIN DELTA PROFILE CALCULATION + DRAWING\\\\n// ─────────────────────────────────────────────\\\\nif is_in_session\\\\n\\\\n    // ── session rollover housekeeping (cheap, every session start) ──\\\\n    if sess_start == 0\\\\n        if not na(curr_TPO_POC)\\\\n            prev_TPO_POC := curr_TPO_POC\\\\n        array.concat(last_deltaBoxIDs, deltaBoxIDs)\\\\n        array.clear(deltaBoxIDs)\\\\n        if not na(pocLineID)\\\\n            array.push(lastPocLineIDs, pocLineID)\\\\n        while array.size(lastPocLineIDs) > 490\\\\n            line.delete(array.shift(lastPocLineIDs))\\\\n        pocLineID := line(na)\\\\n\\\\n    // ── heavy work only when we actually need to draw ──\\\\n    if do_full_calc\\\\n\\\\n        // live session gets fully redrawn on every update\\\\n        if array.size(deltaBoxIDs) > 0\\\\n            for i = 0 to array.size(deltaBoxIDs) - 1\\\\n                box.delete(array.shift(deltaBoxIDs))\\\\n            array.clear(deltaBoxIDs)\\\\n        if not na(pocLineID)\\\\n            line.delete(pocLineID)\\\\n            pocLineID := line(na)\\\\n\\\\n        // Build the volume + bull-volume histogram in the SAME pass.\\\\n        if TPO_rows \\u003c= 2000\\\\n            for i = 0 to TPO_rows\\\\n                row_low        = TPO_min + i * tick_size\\\\n                row_top_excl   = row_low + tick_size\\\\n                row_volume     = fn_volume_per_tick(row_low, row_top_excl, sess_start)\\\\n                row_bull_vol   = fn_bull_volume_per_tick(row_low, row_top_excl, sess_start, delta_method == delta_method_2)\\\\n                array.push(TPO_length,     row_volume)\\\\n                array.push(TPO_price,      row_low)\\\\n                array.push(TPO_delta_bull, row_bull_vol)\\\\n\\\\n        if array.size(TPO_length) > 0 and array.size(TPO_price) > 0\\\\n            max_vol = array.max(TPO_length)\\\\n\\\\n            // POC: among rows tied at max volume, take the one closest to session mid.\\\\n            int POC_index = array.indexof(TPO_length, max_vol)\\\\n            if POC_index != array.lastindexof(TPO_length, max_vol)\\\\n                float best_dist = na\\\\n                for i = 0 to array.size(TPO_length) - 1\\\\n                    if array.get(TPO_length, i) == max_vol\\\\n                        d = math.abs(array.get(TPO_price, i) + half_tick - TPO_mid)\\\\n                        if na(best_dist) or d \\u003c best_dist\\\\n                            best_dist := d\\\\n                            POC_index := i\\\\n            TPO_POC := array.get(TPO_price, POC_index)\\\\n            curr_TPO_POC := TPO_POC\\\\n\\\\n            // ── NOISE FILTER CUT-OFF (percentile of traded rows' |delta|) ──\\\\n            // |delta| = |buy - sell| = |2 * bull_vol - total_vol|\\\\n            // Level 1 -> ~9% of rows filtered, Level 10 -> ~90% filtered.\\\\n            float noise_cut = na\\\\n            if noise_mode != noise_mode_off\\\\n                traded_abs_deltas = array.new_float(0)\\\\n                for i = 0 to array.size(TPO_length) - 1\\\\n                    float v = array.get(TPO_length, i)\\\\n                    if v > 0\\\\n                        array.push(traded_abs_deltas, math.abs(2 * array.get(TPO_delta_bull, i) - v))\\\\n                if array.size(traded_abs_deltas) > 0\\\\n                    float pct = noise_level * 9.0\\\\n                    noise_cut := noise_mode == noise_mode_low ? array.percentile_nearest_rank(traded_abs_deltas, pct) : array.percentile_nearest_rank(traded_abs_deltas, 100 - pct)\\\\n\\\\n            color last_box_color = na\\\\n            bool  prev_row_drawn = false   // prevents merging across empty rows\\\\n\\\\n            for i = 0 to TPO_rows\\\\n                row_low     = array.get(TPO_price, i)\\\\n                // clamp the very top row to the actual session high\\\\n                row_top     = i == TPO_rows ? math.max(math.min(row_low + tick_size, highest_high), row_low + syminfo.mintick) : row_low + tick_size\\\\n                row_volume  = array.get(TPO_length, i)\\\\n\\\\n                // Rows where price NEVER traded are skipped completely.\\\\n                if row_volume == 0\\\\n                    prev_row_drawn := false\\\\n                    continue\\\\n\\\\n                left_side = sess_start_bar\\\\n                bool is_poc = i == POC_index\\\\n\\\\n                if is_poc and show_poc_line\\\\n                    line.delete(pocLineID)\\\\n                    pocLineID := line.new(left_side, row_low + half_tick, bar_index + 1, row_low + half_tick, color=poc_line_color)\\\\n\\\\n                // ── DELTA VALUE FOR THIS ROW ──\\\\n                row_bull_vol = array.get(TPO_delta_bull, i)\\\\n                row_sell_vol = row_volume - row_bull_vol\\\\n                row_delta    = row_bull_vol - row_sell_vol   // net buy(+)/sell(-) volume for this row\\\\n\\\\n                // ── NOISE FILTER: skip boxes by |delta| (POC line above stays) ──\\\\n                bool noise_hide = false\\\\n                if not na(noise_cut)\\\\n                    noise_hide := noise_mode == noise_mode_low ? math.abs(row_delta) \\u003c noise_cut : math.abs(row_delta) > noise_cut\\\\n                if noise_hide\\\\n                    prev_row_drawn := false\\\\n                    continue\\\\n\\\\n                box_color = is_poc ? poc_box_color : (row_delta >= 0 ? delta_buy_color : delta_sell_color)\\\\n\\\\n                // left = session start, right grows with |delta|.\\\\n                adjusted_right_side = sess_start_bar + math.round(math.abs(row_delta) / (vol_ema_global == 0 ? 1 : vol_ema_global) * delta_box_size * 10)\\\\n\\\\n                bool merged = false\\\\n                if prev_row_drawn and array.size(deltaBoxIDs) > 0\\\\n                    last_box_ID    = array.get(deltaBoxIDs, array.size(deltaBoxIDs) - 1)\\\\n                    last_box_right = box.get_right(last_box_ID)\\\\n                    if adjusted_right_side == last_box_right and not is_poc and box.get_bottom(last_box_ID) != TPO_POC and last_box_color == box_color\\\\n                        box.set_top(last_box_ID, row_top)\\\\n                        merged := true\\\\n\\\\n                if not merged\\\\n                    int total_boxes = array.size(deltaBoxIDs) + array.size(last_deltaBoxIDs)\\\\n                    if total_boxes > 499 and array.size(last_deltaBoxIDs) > 0\\\\n                        box.delete(array.shift(last_deltaBoxIDs))\\\\n                    total_boxes := array.size(deltaBoxIDs) + array.size(last_deltaBoxIDs)\\\\n                    if total_boxes > 499 and array.size(deltaBoxIDs) > 0\\\\n                        box.delete(array.shift(deltaBoxIDs))\\\\n                    delta_txt = delta_show_text ? str.tostring(row_delta, format.volume) : ''\\\\n                    delta_box = box.new(left=left_side, top=row_top, right=adjusted_right_side, bottom=row_low, bgcolor=color.new(box_color, 0), border_color=na,\\\\n                                         text=delta_txt, text_color=chart.fg_color, text_size=delta_text_size, text_halign=text.align_right)\\\\n                    array.push(deltaBoxIDs, delta_box)\\\\n\\\\n                last_box_color := box_color\\\\n                prev_row_drawn := true\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// X2 VOLUME CANDLE COLORING\\\\n// ─────────────────────────────────────────────\\\\neffective_POC = not na(curr_TPO_POC) ? curr_TPO_POC : prev_TPO_POC\\\\n\\\\nbool is_heavy = volume > vol_ema_global * x2_strength\\\\nbool is_bull  = close > open\\\\n\\\\nbool is_outside_POC = not na(effective_POC) and (close > effective_POC + tick_size or close \\u003c effective_POC - tick_size)\\\\n\\\\ncolor final_color = na\\\\nif is_heavy\\\\n    final_color := is_outside_POC ? (is_bull ? x2_out_bull_color : x2_out_bear_color) : (is_bull ? x2_in_bull_color : x2_in_bear_color)\\\\nelse\\\\n    final_color := is_bull ? x2_norm_bull_color : x2_norm_bear_color\\\\n\\\\nbarcolor(final_color)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// INFO TABLE\\\\n// ─────────────────────────────────────────────\\\\nfilter_txt  = noise_mode == noise_mode_off ? \\\\\\\"\\\\\\\" : \\\\\\\" | Filter: \\\\\\\" + (noise_mode == noise_mode_low ? \\\\\\\"Low-Delta\\\\\\\" : \\\\\\\"High-Delta\\\\\\\") + \\\\\\\" x\\\\\\\" + str.tostring(noise_level)\\\\ninfo_text_6 = sess_name + \\\\\\\" Delta Profile\\\\\\\" + filter_txt\\\\n\\\\nvar table ticktestarray = table.new(position.bottom_right, 1, 20, bgcolor=info_table_color, frame_width=2, frame_color=color.black)\\\\n\\\\nif show_tpo_info\\\\n    table.clear(ticktestarray, 0, 0, 0, 19)\\\\n    table.cell(ticktestarray, 0, 0, text=info_text_6, text_color=info_table_text_color, text_size=info_table_txt_size, bgcolor=color.rgb(90, 90, 90))\\\\nelse\\\\n    table.clear(ticktestarray, 0, 0, 0, 19)\\\"\",\"tk.fav\":\"[\\\"tf:5m\\\",\\\"tf:30m\\\",\\\"tf:8h\\\",\\\"tool:rect\\\",\\\"tool:long\\\",\\\"tool:short\\\",\\\"tf:3d\\\"]\",\"tk.inds\":\"[{\\\"id\\\":\\\"hvoiccj\\\",\\\"name\\\":\\\"V1\\\",\\\"code\\\":\\\"// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/\\\\n// © TraderGze - Delta Profile Multi-Session\\\\n// (Derived from \\\\\\\"Smart Volume Profile Multi-Session\\\\\\\" — the volume-profile\\\\n// box drawing has been REPLACED by delta (buy-sell) box drawing, in the\\\\n// SAME right-facing orientation/position the volume boxes used, so it\\\\n// still works across every session mode: 4H / 12H / 3D.)\\\\n//\\\\n// v2: Expanded Noise Filter (strength 1-20, filter basis, direction, fixed\\\\n//     thresholds, percentile band, top-N, imbalance ratio, neighbor-aware,\\\\n//     highlight-instead-of-hide, keep-POC, session scope).\\\\n\\\\n//@version=6\\\\nindicator(\\\\\\\"Smart Delta Profile High Vol\\\\\\\", overlay=true, max_labels_count=500, max_boxes_count=500, max_lines_count=500, max_bars_back=1000)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// SESSION TIMEFRAME SETTINGS\\\\n//   Auto mode:  5m chart → 4 Hour Profile | 15m chart → 12 Hour Profile | 45m chart → 3 Day Profile\\\\n//   Or force a specific session length manually.\\\\n// ─────────────────────────────────────────────\\\\nsess_mode = input.string(\\\\\\\"Auto (by chart TF)\\\\\\\", title=\\\\\\\"Delta Profile Session Length\\\\\\\", group=\\\\\\\"Profile Session\\\\\\\", options=[\\\\\\\"Auto (by chart TF)\\\\\\\", \\\\\\\"4 Hour\\\\\\\", \\\\\\\"12 Hour\\\\\\\", \\\\\\\"3 Day\\\\\\\"], tooltip=\\\\\\\"Auto: 5m→4H, 15m→12H, 45m→3D. Any other chart TF defaults to 4H.\\\\\\\")\\\\n\\\\n// resolve the session length in milliseconds\\\\nint chart_tf_min = timeframe.in_seconds() / 60\\\\nstring sess_name = \\\\\\\"\\\\\\\"\\\\nint sess_len_ms  = 0\\\\nif sess_mode == \\\\\\\"4 Hour\\\\\\\"\\\\n    sess_len_ms := 14400000\\\\n    sess_name   := \\\\\\\"4Hr\\\\\\\"\\\\nelse if sess_mode == \\\\\\\"12 Hour\\\\\\\"\\\\n    sess_len_ms := 43200000\\\\n    sess_name   := \\\\\\\"12Hr\\\\\\\"\\\\nelse if sess_mode == \\\\\\\"3 Day\\\\\\\"\\\\n    sess_len_ms := 259200000\\\\n    sess_name   := \\\\\\\"3D\\\\\\\"\\\\nelse\\\\n    // Auto\\\\n    if chart_tf_min == 15\\\\n        sess_len_ms := 43200000\\\\n        sess_name   := \\\\\\\"12Hr\\\\\\\"\\\\n    else if chart_tf_min == 45\\\\n        sess_len_ms := 259200000\\\\n        sess_name   := \\\\\\\"3D\\\\\\\"\\\\n    else\\\\n        sess_len_ms := 14400000\\\\n        sess_name   := \\\\\\\"4Hr\\\\\\\"\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// X2 VOLUME SETTINGS\\\\n// ─────────────────────────────────────────────\\\\nx2_period   = input.int(20, title=\\\\\\\"Volume EMA Period\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_strength = input.float(2, title=\\\\\\\"Volume Strength Multiplier\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\", minval=0, tooltip=\\\\\\\"2 = 200% of average volume. Candles above this threshold are highlighted.\\\\\\\")\\\\n\\\\nx2_out_bull_color  = input.color(color.lime, title=\\\\\\\"Outside VA — Bull Candle Color\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_out_bear_color  = input.color(color.red,  title=\\\\\\\"Outside VA — Bear Candle Color\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_in_bull_color   = input.color(color.gray, title=\\\\\\\"Inside VA — Bull Candle Color\\\\\\\",  group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_in_bear_color   = input.color(color.gray, title=\\\\\\\"Inside VA — Bear Candle Color\\\\\\\",  group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_norm_bull_color = input.color(color.gray, title=\\\\\\\"Normal — Bull Candle Color\\\\\\\",     group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_norm_bear_color = input.color(color.gray, title=\\\\\\\"Normal — Bear Candle Color\\\\\\\",     group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// DELTA PROFILE SETTINGS\\\\n// ─────────────────────────────────────────────\\\\ndelta_method_1   = \\\\\\\"Bar Polarity\\\\\\\"\\\\ndelta_method_2   = \\\\\\\"Bar Buying/Selling Pressure\\\\\\\"\\\\ndelta_method     = input.string(delta_method_1, title=\\\\\\\"Delta Polarity Method\\\\\\\", options=[delta_method_1, delta_method_2], group=\\\\\\\"Delta Profile\\\\\\\", tooltip=\\\\\\\"Bar Polarity: up if close>open.\\\\\\\\nBar Buying/Selling Pressure: up if (close-low) > (high-close).\\\\\\\")\\\\ndelta_box_size   = input.float(0.5, minval=0.1, maxval=10.0, step=0.1, title=\\\\\\\"Delta Box Size\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\", tooltip=\\\\\\\"Width multiplier. Smaller values merge more rows into fewer boxes.\\\\\\\")\\\\npoc_box_color    = input.color(color.rgb(255, 200, 0), title=\\\\\\\"POC (Highest Volume Row) Box Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_buy_color  = input.color(color.new(#2962FF, 15), title=\\\\\\\"Delta Buy-Dominant Color\\\\\\\",  group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_sell_color = input.color(color.new(#FF1744, 15), title=\\\\\\\"Delta Sell-Dominant Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_show_text  = input.bool(true, title=\\\\\\\"Show Delta Value Text?\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_text_size  = input.string(size.tiny, title=\\\\\\\"Delta Text Size\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\", options=[size.auto, size.tiny, size.small, size.normal])\\\\nshow_poc_line    = input.bool(true, title=\\\\\\\"Show POC Line?\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\npoc_line_color   = input.color(color.rgb(255, 0, 0, 100), title=\\\\\\\"POC Line Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// NOISE FILTER SETTINGS\\\\n// ─────────────────────────────────────────────\\\\n// --- Filter mode (how rows are ranked / selected) ---\\\\nnoise_mode_off   = \\\\\\\"Off\\\\\\\"\\\\nnoise_mode_low   = \\\\\\\"Remove Low Rows\\\\\\\"\\\\nnoise_mode_high  = \\\\\\\"Remove High Rows\\\\\\\"\\\\nnoise_mode_band  = \\\\\\\"Keep Percentile Band\\\\\\\"\\\\nnoise_mode_topn  = \\\\\\\"Top N Strongest Rows\\\\\\\"\\\\nnoise_mode = input.string(noise_mode_off, title=\\\\\\\"Filter Mode\\\\\\\", options=[noise_mode_off, noise_mode_low, noise_mode_high, noise_mode_band, noise_mode_topn], group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"Rows are ranked by the 'Filter Basis' metric chosen below.\\\\\\\\n\\\\\\\\nRemove Low Rows: hides rows with a small metric value (keeps the strongest).\\\\\\\\nRemove High Rows: hides rows with a large metric value (keeps the weakest / most balanced).\\\\\\\\nKeep Percentile Band: keeps only rows between the Band Lower and Band Upper percentiles.\\\\\\\\nTop N Strongest Rows: keeps only the N rows with the highest metric value.\\\\\\\")\\\\n\\\\n// --- Strength (now 1-20, 4.5 percentile points per level) ---\\\\nnoise_level = input.int(5, minval=1, maxval=20, title=\\\\\\\"Noise Filter Strength\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"1 = minimal filtering, 20 = aggressive filtering (~90% of rows filtered).\\\\\\\\nEach level = 4.5 percentile points.\\\\\\\\nUsed by 'Remove Low Rows' / 'Remove High Rows' in Percentile method.\\\\\\\")\\\\n\\\\n// --- Filter basis ---\\\\nbasis_abs_delta = \\\\\\\"|Delta|\\\\\\\"\\\\nbasis_volume    = \\\\\\\"Total Volume\\\\\\\"\\\\nbasis_delta_pct = \\\\\\\"Delta %\\\\\\\"\\\\nfilter_basis = input.string(basis_abs_delta, title=\\\\\\\"Filter Basis\\\\\\\", options=[basis_abs_delta, basis_volume, basis_delta_pct], group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"What each row is ranked by:\\\\\\\\n|Delta|: absolute net buy-sell volume.\\\\\\\\nTotal Volume: total volume traded in the row.\\\\\\\\nDelta %: |delta| / row volume x 100 (surfaces one-sided rows even if volume is small).\\\\\\\")\\\\n\\\\n// --- Percentile vs Fixed threshold ---\\\\nthr_percentile = \\\\\\\"Percentile (adaptive)\\\\\\\"\\\\nthr_fixed      = \\\\\\\"Fixed Threshold\\\\\\\"\\\\nthr_method = input.string(thr_percentile, title=\\\\\\\"Threshold Method\\\\\\\", options=[thr_percentile, thr_fixed], group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"Percentile: adapts to every session.\\\\\\\\nFixed: same absolute threshold for every session (comparable across sessions). Applies to 'Remove Low Rows' / 'Remove High Rows'.\\\\\\\")\\\\nfixed_thr = input.float(5.0, minval=0.0, step=0.5, title=\\\\\\\"Fixed Threshold Value\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"For |Delta| and Total Volume basis: multiple of the Volume EMA (e.g. 5 = 5x average bar volume).\\\\\\\\nFor Delta % basis: percent (0-100).\\\\\\\")\\\\n\\\\n// --- Band & Top N ---\\\\nband_lo = input.int(60, minval=1, maxval=100, title=\\\\\\\"Band Lower Percentile\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\", tooltip=\\\\\\\"Used by 'Keep Percentile Band'.\\\\\\\")\\\\nband_hi = input.int(90, minval=1, maxval=100, title=\\\\\\\"Band Upper Percentile\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\", tooltip=\\\\\\\"Used by 'Keep Percentile Band'. Removes extreme outliers above this percentile.\\\\\\\")\\\\ntop_n   = input.int(5, minval=1, maxval=200, title=\\\\\\\"Top N Rows\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\", tooltip=\\\\\\\"Used by 'Top N Strongest Rows'. Ties at the cut-off value are all kept.\\\\\\\")\\\\n\\\\n// --- Direction filter ---\\\\ndir_both = \\\\\\\"Both\\\\\\\"\\\\ndir_buy  = \\\\\\\"Buy-Dominant Only\\\\\\\"\\\\ndir_sell = \\\\\\\"Sell-Dominant Only\\\\\\\"\\\\ndir_mode = input.string(dir_both, title=\\\\\\\"Direction Filter\\\\\\\", options=[dir_both, dir_buy, dir_sell], group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"Independent of Filter Mode. Show only rows where buyers or sellers dominate.\\\\\\\")\\\\n\\\\n// --- Imbalance ratio filter ---\\\\nuse_imbalance = input.bool(false, title=\\\\\\\"Enable Imbalance Ratio Filter\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"Keeps only rows where the dominant side is at least X times the other side (footprint-style imbalance).\\\\\\\")\\\\nimbalance_ratio = input.float(3.0, minval=1.0, step=0.5, title=\\\\\\\"Imbalance Ratio (X : 1)\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\")\\\\n\\\\n// --- Display / behavior options ---\\\\nkeep_poc_always   = input.bool(true, title=\\\\\\\"Always Keep POC Row\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\", tooltip=\\\\\\\"POC box is never removed/faded by the filter.\\\\\\\")\\\\nneighbor_aware    = input.bool(false, title=\\\\\\\"Neighbor-Aware (bridge gaps)\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\", tooltip=\\\\\\\"A filtered row is kept if the rows directly above AND below it both pass the filter. Avoids a fragmented profile.\\\\\\\")\\\\nhighlight_mode    = input.bool(false, title=\\\\\\\"Highlight Instead of Hide\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\", tooltip=\\\\\\\"Filtered rows are drawn faded instead of removed, so you keep context while strong nodes stand out.\\\\\\\")\\\\nfade_transp       = input.int(88, minval=50, maxval=98, title=\\\\\\\"Faded Row Transparency\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\", tooltip=\\\\\\\"Higher = more transparent. Used when 'Highlight Instead of Hide' is on.\\\\\\\")\\\\n\\\\n// --- Session scope ---\\\\nscope_all  = \\\\\\\"All Sessions\\\\\\\"\\\\nscope_done = \\\\\\\"Completed Sessions Only (live unfiltered)\\\\\\\"\\\\nscope_live = \\\\\\\"Live Session Only (past unfiltered)\\\\\\\"\\\\nfilter_scope = input.string(scope_all, title=\\\\\\\"Apply Filter To\\\\\\\", options=[scope_all, scope_done, scope_live], group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"Live sessions have thin data early on and can look noisy. Choose where the filter is applied.\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// TICK SIZE CONFIGURATION\\\\n// ─────────────────────────────────────────────\\\\nauto_tick_size_b  = input.bool(true, title=\\\\\\\"Auto Tick Size?\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\nint tick_bars_back = input.int(96, minval=1, title=\\\\\\\"Avg Tick Size - Bars Back\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\ntarget_session_ht = input.float(20, minval=1, title=\\\\\\\"Average Target Session Height for Tick Size\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\", tooltip=\\\\\\\"Approx. number of rows per session. LOWER = fewer rows = fewer boxes = MORE past sessions visible.\\\\\\\")\\\\nman_tick_size     = input.int(100, minval=1, title=\\\\\\\"Manual Tick Size\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// INFO TABLE\\\\n// ─────────────────────────────────────────────\\\\nshow_tpo_info         = input.bool(true, title=\\\\\\\"Show Info Text?\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\ninfo_table_txt_size   = input.string(size.small, title=\\\\\\\"Info Text Size\\\\\\\", group=\\\\\\\"Info Table\\\\\\\", options=[size.auto, size.tiny, size.small, size.normal, size.large, size.huge])\\\\ninfo_table_text_color = input.color(color.rgb(255, 255, 255), title=\\\\\\\"Info Box Letter Color\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\ninfo_table_color      = input.color(color.rgb(255, 255, 255), title=\\\\\\\"Info Box Background Color\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// GLOBAL CALCULATIONS (v6 consistency requirement)\\\\n// ─────────────────────────────────────────────\\\\navg_bar_ht_global = ta.sma(high, tick_bars_back) - ta.sma(low, tick_bars_back)\\\\nvol_ema_global    = ta.ema(volume, x2_period)\\\\n\\\\n// SESSION DETECTION — generic, epoch-anchored blocks (UTC)\\\\nsess_block  = math.floor(time / sess_len_ms)\\\\nsess_change = sess_block != sess_block[1]\\\\nsess_start_global = nz(ta.barssince(sess_change))\\\\n\\\\nbool is_in_session = true\\\\nint  sess_start    = sess_start_global\\\\n\\\\nif syminfo.type == \\\\\\\"economic\\\\\\\"\\\\n    is_in_session := false\\\\n\\\\nsess_start_bar = int(bar_index - sess_start)\\\\n\\\\n// PERFORMANCE GATE — is this the FINAL bar of its session?\\\\nsess_block_close = math.floor(time_close / sess_len_ms)\\\\nbool is_sess_last_bar = sess_block_close != sess_block\\\\nbool do_full_calc = barstate.islast or is_sess_last_bar\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// HELPER FUNCTIONS\\\\n// ─────────────────────────────────────────────\\\\n// A bar contributes its FULL volume to a row if its range [low, high]\\\\n// overlaps the half-open row bucket [row_low, row_low + tick_size).\\\\nfn_volume_per_tick(row_low, row_top_excl, bars_back) =>\\\\n    float row_volume = 0.0\\\\n    for i = 0 to bars_back\\\\n        if high[i] >= row_low and low[i] \\u003c row_top_excl\\\\n            row_volume := row_volume + volume[i]\\\\n    row_volume\\\\n\\\\n// Same \\\\\\\"touch\\\\\\\" test as fn_volume_per_tick, but splits the contributed\\\\n// volume into a BUY (bull) portion using the chosen polarity method.\\\\nfn_bull_volume_per_tick(row_low, row_top_excl, bars_back, use_pressure_method) =>\\\\n    float bull_volume = 0.0\\\\n    for i = 0 to bars_back\\\\n        if high[i] >= row_low and low[i] \\u003c row_top_excl\\\\n            bool bar_is_bull = use_pressure_method ? (close[i] - low[i]) > (high[i] - close[i]) : close[i] > open[i]\\\\n            if bar_is_bull\\\\n                bull_volume := bull_volume + volume[i]\\\\n    bull_volume\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// VISUAL OBJECT ARRAYS\\\\n// ─────────────────────────────────────────────\\\\nvar deltaBoxIDs      = array.new_box(0)\\\\nvar last_deltaBoxIDs = array.new_box(0)\\\\nvar pocLineID         = line(na)\\\\nvar lastPocLineIDs    = array.new_line(0)\\\\n\\\\nTPO_price      = array.new_float(0)\\\\nTPO_length     = array.new_float(0)   // total volume per row (still needed to find POC + scale boxes)\\\\nTPO_delta_bull = array.new_float(0)   // bull (buy-side) volume per row, parallel to TPO_length/TPO_price\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// TICK SIZE CALCULATION (na-safe on first bars: falls back to bar range)\\\\n// ─────────────────────────────────────────────\\\\nfloat tick_size = syminfo.mintick\\\\n\\\\ntick_size := if auto_tick_size_b and sess_start == 0\\\\n    float bar_ht = na(avg_bar_ht_global) ? (high - low) : avg_bar_ht_global\\\\n    float auto_tick = math.round_to_mintick(bar_ht / target_session_ht)\\\\n    if auto_tick == 0 or na(auto_tick)\\\\n        auto_tick := syminfo.mintick\\\\n    auto_tick\\\\nelse if sess_start == 0 and not auto_tick_size_b\\\\n    man_tick_size * syminfo.mintick\\\\nelse\\\\n    tick_size[sess_start]\\\\n\\\\nhalf_tick = math.round_to_mintick(tick_size * 0.5)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// SESSION HIGH/LOW — incremental (no per-bar loop over the session)\\\\n// ─────────────────────────────────────────────\\\\nvar float p_sess_hi = na\\\\nvar float p_sess_lo = na\\\\nif sess_start == 0\\\\n    p_sess_hi := na\\\\n    p_sess_lo := na\\\\nfloat highest_high = na(p_sess_hi) ? high : math.max(p_sess_hi, high)\\\\nfloat lowest_low   = na(p_sess_lo) ? low  : math.min(p_sess_lo, low)\\\\nif barstate.isconfirmed\\\\n    p_sess_hi := highest_high\\\\n    p_sess_lo := lowest_low\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// PROFILE RANGE — grid anchored at the actual session low\\\\n// ─────────────────────────────────────────────\\\\nfloat TPO_min  = lowest_low\\\\nint   TPO_rows = math.max(0, int(math.ceil((highest_high - TPO_min) / tick_size)) - 1)\\\\nfloat TPO_mid  = math.round_to_mintick((lowest_low + highest_high) / 2)\\\\nTPO_POC = float(na)\\\\n\\\\nvar float curr_TPO_POC = na\\\\nvar float prev_TPO_POC = na\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// MAIN DELTA PROFILE CALCULATION + DRAWING\\\\n// ─────────────────────────────────────────────\\\\nif is_in_session\\\\n\\\\n    // ── session rollover housekeeping (cheap, every session start) ──\\\\n    if sess_start == 0\\\\n        if not na(curr_TPO_POC)\\\\n            prev_TPO_POC := curr_TPO_POC\\\\n        array.concat(last_deltaBoxIDs, deltaBoxIDs)\\\\n        array.clear(deltaBoxIDs)\\\\n        if not na(pocLineID)\\\\n            array.push(lastPocLineIDs, pocLineID)\\\\n        while array.size(lastPocLineIDs) > 490\\\\n            line.delete(array.shift(lastPocLineIDs))\\\\n        pocLineID := line(na)\\\\n\\\\n    // ── heavy work only when we actually need to draw ──\\\\n    if do_full_calc\\\\n\\\\n        // live session gets fully redrawn on every update\\\\n        if array.size(deltaBoxIDs) > 0\\\\n            for i = 0 to array.size(deltaBoxIDs) - 1\\\\n                box.delete(array.shift(deltaBoxIDs))\\\\n            array.clear(deltaBoxIDs)\\\\n        if not na(pocLineID)\\\\n            line.delete(pocLineID)\\\\n            pocLineID := line(na)\\\\n\\\\n        // Build the volume + bull-volume histogram in the SAME pass.\\\\n        if TPO_rows \\u003c= 2000\\\\n            for i = 0 to TPO_rows\\\\n                row_low        = TPO_min + i * tick_size\\\\n                row_top_excl   = row_low + tick_size\\\\n                row_volume     = fn_volume_per_tick(row_low, row_top_excl, sess_start)\\\\n                row_bull_vol   = fn_bull_volume_per_tick(row_low, row_top_excl, sess_start, delta_method == delta_method_2)\\\\n                array.push(TPO_length,     row_volume)\\\\n                array.push(TPO_price,      row_low)\\\\n                array.push(TPO_delta_bull, row_bull_vol)\\\\n\\\\n        if array.size(TPO_length) > 0 and array.size(TPO_price) > 0\\\\n            max_vol = array.max(TPO_length)\\\\n\\\\n            // POC: among rows tied at max volume, take the one closest to session mid.\\\\n            int POC_index = array.indexof(TPO_length, max_vol)\\\\n            if POC_index != array.lastindexof(TPO_length, max_vol)\\\\n                float best_dist = na\\\\n                for i = 0 to array.size(TPO_length) - 1\\\\n                    if array.get(TPO_length, i) == max_vol\\\\n                        d = math.abs(array.get(TPO_price, i) + half_tick - TPO_mid)\\\\n                        if na(best_dist) or d \\u003c best_dist\\\\n                            best_dist := d\\\\n                            POC_index := i\\\\n            TPO_POC := array.get(TPO_price, POC_index)\\\\n            curr_TPO_POC := TPO_POC\\\\n\\\\n            // ═════════════════════════════════════════════\\\\n            // NOISE FILTER PRE-PASS\\\\n            // Builds keep_arr[] (true = row passes all filters)\\\\n            // ═════════════════════════════════════════════\\\\n            int  sz            = array.size(TPO_length)\\\\n            bool is_live_calc  = barstate.islast\\\\n            bool scope_ok      = filter_scope == scope_all or (filter_scope == scope_done and not is_live_calc) or (filter_scope == scope_live and is_live_calc)\\\\n            bool rank_on       = scope_ok and noise_mode != noise_mode_off\\\\n            bool dir_on        = scope_ok and dir_mode != dir_both\\\\n            bool imb_on        = scope_ok and use_imbalance\\\\n\\\\n            metric_arr = array.new_float(sz, na)\\\\n            traded_vals = array.new_float(0)\\\\n\\\\n            // 1) metric per traded row\\\\n            for i = 0 to sz - 1\\\\n                float v = array.get(TPO_length, i)\\\\n                if v > 0\\\\n                    float bull_v = array.get(TPO_delta_bull, i)\\\\n                    float abs_d  = math.abs(2 * bull_v - v)\\\\n                    float m = filter_basis == basis_abs_delta ? abs_d : filter_basis == basis_volume ? v : abs_d / v * 100.0\\\\n                    array.set(metric_arr, i, m)\\\\n                    array.push(traded_vals, m)\\\\n\\\\n            // 2) cut-off values\\\\n            float cut_lo = na   // keep metric >= cut_lo\\\\n            float cut_hi = na   // keep metric \\u003c= cut_hi\\\\n            if rank_on and array.size(traded_vals) > 0\\\\n                float pct = noise_level * 4.5\\\\n                float fixed_val = filter_basis == basis_delta_pct ? fixed_thr : fixed_thr * (na(vol_ema_global) ? 0.0 : vol_ema_global)\\\\n                if noise_mode == noise_mode_low\\\\n                    cut_lo := thr_method == thr_fixed ? fixed_val : array.percentile_nearest_rank(traded_vals, pct)\\\\n                else if noise_mode == noise_mode_high\\\\n                    cut_hi := thr_method == thr_fixed ? fixed_val : array.percentile_nearest_rank(traded_vals, 100 - pct)\\\\n                else if noise_mode == noise_mode_band\\\\n                    float b_lo = math.min(band_lo, band_hi)\\\\n                    float b_hi = math.max(band_lo, band_hi)\\\\n                    cut_lo := array.percentile_nearest_rank(traded_vals, b_lo)\\\\n                    cut_hi := array.percentile_nearest_rank(traded_vals, b_hi)\\\\n                else if noise_mode == noise_mode_topn\\\\n                    sorted_vals = array.copy(traded_vals)\\\\n                    array.sort(sorted_vals, order.descending)\\\\n                    int n_idx = math.min(top_n, array.size(sorted_vals)) - 1\\\\n                    cut_lo := array.get(sorted_vals, n_idx)\\\\n\\\\n            // 3) rank pass per row\\\\n            rank_pass = array.new_bool(sz, true)\\\\n            for i = 0 to sz - 1\\\\n                float m = array.get(metric_arr, i)\\\\n                if not na(m) and rank_on\\\\n                    bool ok = true\\\\n                    if not na(cut_lo) and m \\u003c cut_lo\\\\n                        ok := false\\\\n                    if not na(cut_hi) and m > cut_hi\\\\n                        ok := false\\\\n                    array.set(rank_pass, i, ok)\\\\n\\\\n            // 4) neighbor-aware bridging (uses the ORIGINAL rank result)\\\\n            final_rank = array.copy(rank_pass)\\\\n            if rank_on and neighbor_aware and sz > 2\\\\n                for i = 1 to sz - 2\\\\n                    if not array.get(rank_pass, i) and not na(array.get(metric_arr, i))\\\\n                        bool up_ok = not na(array.get(metric_arr, i + 1)) and array.get(rank_pass, i + 1)\\\\n                        bool dn_ok = not na(array.get(metric_arr, i - 1)) and array.get(rank_pass, i - 1)\\\\n                        if up_ok and dn_ok\\\\n                            array.set(final_rank, i, true)\\\\n\\\\n            // 5) direction + imbalance + POC override -> final keep flags\\\\n            keep_arr = array.new_bool(sz, true)\\\\n            for i = 0 to sz - 1\\\\n                float v = array.get(TPO_length, i)\\\\n                if v > 0\\\\n                    bool k = array.get(final_rank, i)\\\\n                    float bull_v = array.get(TPO_delta_bull, i)\\\\n                    float sell_v = v - bull_v\\\\n                    if dir_on\\\\n                        float dlt = bull_v - sell_v\\\\n                        if dir_mode == dir_buy\\\\n                            k := k and dlt >= 0\\\\n                        else\\\\n                            k := k and dlt \\u003c 0\\\\n                    if imb_on\\\\n                        float big   = math.max(bull_v, sell_v)\\\\n                        float small = math.min(bull_v, sell_v)\\\\n                        bool imb_ok = small \\u003c= 0 ? big > 0 : big / small >= imbalance_ratio\\\\n                        k := k and imb_ok\\\\n                    if keep_poc_always and i == POC_index\\\\n                        k := true\\\\n                    array.set(keep_arr, i, k)\\\\n\\\\n            // ═════════════════════════════════════════════\\\\n            // DRAWING\\\\n            // ═════════════════════════════════════════════\\\\n            color last_box_color = na\\\\n            bool  prev_row_drawn = false   // prevents merging across empty rows\\\\n\\\\n            for i = 0 to TPO_rows\\\\n                row_low     = array.get(TPO_price, i)\\\\n                // clamp the very top row to the actual session high\\\\n                row_top     = i == TPO_rows ? math.max(math.min(row_low + tick_size, highest_high), row_low + syminfo.mintick) : row_low + tick_size\\\\n                row_volume  = array.get(TPO_length, i)\\\\n\\\\n                // Rows where price NEVER traded are skipped completely.\\\\n                if row_volume == 0\\\\n                    prev_row_drawn := false\\\\n                    continue\\\\n\\\\n                left_side = sess_start_bar\\\\n                bool is_poc = i == POC_index\\\\n\\\\n                if is_poc and show_poc_line\\\\n                    line.delete(pocLineID)\\\\n                    pocLineID := line.new(left_side, row_low + half_tick, bar_index + 1, row_low + half_tick, color=poc_line_color)\\\\n\\\\n                // ── DELTA VALUE FOR THIS ROW ──\\\\n                row_bull_vol = array.get(TPO_delta_bull, i)\\\\n                row_sell_vol = row_volume - row_bull_vol\\\\n                row_delta    = row_bull_vol - row_sell_vol   // net buy(+)/sell(-) volume for this row\\\\n\\\\n                // ── NOISE FILTER: hide or fade rows that failed (POC line above stays) ──\\\\n                bool row_kept  = array.get(keep_arr, i)\\\\n                bool is_faded  = false\\\\n                if not row_kept\\\\n                    if highlight_mode\\\\n                        is_faded := true\\\\n                    else\\\\n                        prev_row_drawn := false\\\\n                        continue\\\\n\\\\n                color base_color = is_poc ? poc_box_color : (row_delta >= 0 ? delta_buy_color : delta_sell_color)\\\\n                color box_color  = is_faded ? color.new(base_color, fade_transp) : base_color\\\\n\\\\n                // left = session start, right grows with |delta|.\\\\n                adjusted_right_side = sess_start_bar + math.round(math.abs(row_delta) / (vol_ema_global == 0 ? 1 : vol_ema_global) * delta_box_size * 10)\\\\n\\\\n                bool merged = false\\\\n                if prev_row_drawn and array.size(deltaBoxIDs) > 0\\\\n                    last_box_ID    = array.get(deltaBoxIDs, array.size(deltaBoxIDs) - 1)\\\\n                    last_box_right = box.get_right(last_box_ID)\\\\n                    if adjusted_right_side == last_box_right and not is_poc and box.get_bottom(last_box_ID) != TPO_POC and last_box_color == box_color\\\\n                        box.set_top(last_box_ID, row_top)\\\\n                        merged := true\\\\n\\\\n                if not merged\\\\n                    int total_boxes = array.size(deltaBoxIDs) + array.size(last_deltaBoxIDs)\\\\n                    if total_boxes > 499 and array.size(last_deltaBoxIDs) > 0\\\\n                        box.delete(array.shift(last_deltaBoxIDs))\\\\n                    total_boxes := array.size(deltaBoxIDs) + array.size(last_deltaBoxIDs)\\\\n                    if total_boxes > 499 and array.size(deltaBoxIDs) > 0\\\\n                        box.delete(array.shift(deltaBoxIDs))\\\\n                    delta_txt = (delta_show_text and not is_faded) ? str.tostring(row_delta, format.volume) : ''\\\\n                    box_bg    = is_faded ? box_color : color.new(box_color, 0)\\\\n                    delta_box = box.new(left=left_side, top=row_top, right=adjusted_right_side, bottom=row_low, bgcolor=box_bg, border_color=na,\\\\n                                         text=delta_txt, text_color=chart.fg_color, text_size=delta_text_size, text_halign=text.align_right)\\\\n                    array.push(deltaBoxIDs, delta_box)\\\\n\\\\n                last_box_color := box_color\\\\n                prev_row_drawn := true\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// X2 VOLUME CANDLE COLORING\\\\n// ─────────────────────────────────────────────\\\\neffective_POC = not na(curr_TPO_POC) ? curr_TPO_POC : prev_TPO_POC\\\\n\\\\nbool is_heavy = volume > vol_ema_global * x2_strength\\\\nbool is_bull  = close > open\\\\n\\\\nbool is_outside_POC = not na(effective_POC) and (close > effective_POC + tick_size or close \\u003c effective_POC - tick_size)\\\\n\\\\ncolor final_color = na\\\\nif is_heavy\\\\n    final_color := is_outside_POC ? (is_bull ? x2_out_bull_color : x2_out_bear_color) : (is_bull ? x2_in_bull_color : x2_in_bear_color)\\\\nelse\\\\n    final_color := is_bull ? x2_norm_bull_color : x2_norm_bear_color\\\\n\\\\nbarcolor(final_color)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// INFO TABLE\\\\n// ─────────────────────────────────────────────\\\\nstring mode_short = noise_mode == noise_mode_low ? \\\\\\\"Low\\\\\\\" : noise_mode == noise_mode_high ? \\\\\\\"High\\\\\\\" : noise_mode == noise_mode_band ? \\\\\\\"Band \\\\\\\" + str.tostring(band_lo) + \\\\\\\"-\\\\\\\" + str.tostring(band_hi) : noise_mode == noise_mode_topn ? \\\\\\\"Top \\\\\\\" + str.tostring(top_n) : \\\\\\\"\\\\\\\"\\\\nstring basis_short = filter_basis == basis_abs_delta ? \\\\\\\"|Δ|\\\\\\\" : filter_basis == basis_volume ? \\\\\\\"Vol\\\\\\\" : \\\\\\\"Δ%\\\\\\\"\\\\nstring lvl_txt = (noise_mode == noise_mode_low or noise_mode == noise_mode_high) and thr_method == thr_percentile ? \\\\\\\" x\\\\\\\" + str.tostring(noise_level) : (noise_mode == noise_mode_low or noise_mode == noise_mode_high) ? \\\\\\\" fixed\\\\\\\" : \\\\\\\"\\\\\\\"\\\\n\\\\nstring filter_txt = noise_mode == noise_mode_off ? \\\\\\\"\\\\\\\" : \\\\\\\" | Filter: \\\\\\\" + mode_short + \\\\\\\" \\\\\\\" + basis_short + lvl_txt\\\\nfilter_txt += dir_mode == dir_both ? \\\\\\\"\\\\\\\" : (dir_mode == dir_buy ? \\\\\\\" | Buy only\\\\\\\" : \\\\\\\" | Sell only\\\\\\\")\\\\nfilter_txt += use_imbalance ? \\\\\\\" | Imb \\\\\\\" + str.tostring(imbalance_ratio) + \\\\\\\":1\\\\\\\" : \\\\\\\"\\\\\\\"\\\\nfilter_txt += (highlight_mode and (noise_mode != noise_mode_off or dir_mode != dir_both or use_imbalance)) ? \\\\\\\" | Fade\\\\\\\" : \\\\\\\"\\\\\\\"\\\\ninfo_text_6 = sess_name + \\\\\\\" Delta Profile\\\\\\\" + filter_txt\\\\n\\\\nvar table ticktestarray = table.new(position.bottom_right, 1, 20, bgcolor=info_table_color, frame_width=2, frame_color=color.black)\\\\n\\\\nif show_tpo_info\\\\n    table.clear(ticktestarray, 0, 0, 0, 19)\\\\n    table.cell(ticktestarray, 0, 0, text=info_text_6, text_color=info_table_text_color, text_size=info_table_txt_size, bgcolor=color.rgb(90, 90, 90))\\\\nelse\\\\n    table.clear(ticktestarray, 0, 0, 0, 19)\\\\n\\\",\\\"on\\\":true,\\\"inputs\\\":{\\\"Delta Text Size\\\":\\\"auto\\\",\\\"Filter Mode\\\":\\\"Remove Low Rows\\\",\\\"Noise Filter Strength\\\":20,\\\"Show POC Line?\\\":false,\\\"Filter Basis\\\":\\\"Total Volume\\\",\\\"Always Keep POC Row\\\":false,\\\"Enable Imbalance Ratio Filter\\\":true},\\\"tfs\\\":[\\\"30m\\\"]},{\\\"id\\\":\\\"lwmrzql\\\",\\\"name\\\":\\\"V2\\\",\\\"code\\\":\\\"// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/\\\\n// © TraderGze - Delta Profile Multi-Session\\\\n// (Derived from \\\\\\\"Smart Volume Profile Multi-Session\\\\\\\" — the volume-profile\\\\n// box drawing has been REPLACED by delta (buy-sell) box drawing, in the\\\\n// SAME right-facing orientation/position the volume boxes used, so it\\\\n// still works across every session mode: 4H / 12H / 3D.)\\\\n\\\\n//@version=6\\\\nindicator(\\\\\\\"Smart Delta Profile High Vol\\\\\\\", overlay=true, max_labels_count=500, max_boxes_count=500, max_lines_count=500, max_bars_back=1000)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// SESSION TIMEFRAME SETTINGS\\\\n//   Auto mode:  5m chart → 4 Hour Profile | 15m chart → 12 Hour Profile | 45m chart → 3 Day Profile\\\\n//   Or force a specific session length manually.\\\\n// ─────────────────────────────────────────────\\\\nsess_mode = input.string(\\\\\\\"Auto (by chart TF)\\\\\\\", title=\\\\\\\"Delta Profile Session Length\\\\\\\", group=\\\\\\\"Profile Session\\\\\\\", options=[\\\\\\\"Auto (by chart TF)\\\\\\\", \\\\\\\"4 Hour\\\\\\\", \\\\\\\"12 Hour\\\\\\\", \\\\\\\"3 Day\\\\\\\"], tooltip=\\\\\\\"Auto: 5m→4H, 15m→12H, 45m→3D. Any other chart TF defaults to 4H.\\\\\\\")\\\\n\\\\n// resolve the session length in milliseconds\\\\nint chart_tf_min = timeframe.in_seconds() / 60\\\\nstring sess_name = \\\\\\\"\\\\\\\"\\\\nint sess_len_ms  = 0\\\\nif sess_mode == \\\\\\\"4 Hour\\\\\\\"\\\\n    sess_len_ms := 14400000\\\\n    sess_name   := \\\\\\\"4Hr\\\\\\\"\\\\nelse if sess_mode == \\\\\\\"12 Hour\\\\\\\"\\\\n    sess_len_ms := 43200000\\\\n    sess_name   := \\\\\\\"12Hr\\\\\\\"\\\\nelse if sess_mode == \\\\\\\"3 Day\\\\\\\"\\\\n    sess_len_ms := 259200000\\\\n    sess_name   := \\\\\\\"3D\\\\\\\"\\\\nelse\\\\n    // Auto\\\\n    if chart_tf_min == 15\\\\n        sess_len_ms := 43200000\\\\n        sess_name   := \\\\\\\"12Hr\\\\\\\"\\\\n    else if chart_tf_min == 45\\\\n        sess_len_ms := 259200000\\\\n        sess_name   := \\\\\\\"3D\\\\\\\"\\\\n    else\\\\n        sess_len_ms := 14400000\\\\n        sess_name   := \\\\\\\"4Hr\\\\\\\"\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// X2 VOLUME SETTINGS\\\\n// ─────────────────────────────────────────────\\\\nx2_period   = input.int(20, title=\\\\\\\"Volume EMA Period\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_strength = input.float(2, title=\\\\\\\"Volume Strength Multiplier\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\", minval=0, tooltip=\\\\\\\"2 = 200% of average volume. Candles above this threshold are highlighted.\\\\\\\")\\\\n\\\\nx2_out_bull_color  = input.color(color.lime, title=\\\\\\\"Outside VA — Bull Candle Color\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_out_bear_color  = input.color(color.red,  title=\\\\\\\"Outside VA — Bear Candle Color\\\\\\\", group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_in_bull_color   = input.color(color.gray, title=\\\\\\\"Inside VA — Bull Candle Color\\\\\\\",  group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_in_bear_color   = input.color(color.gray, title=\\\\\\\"Inside VA — Bear Candle Color\\\\\\\",  group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_norm_bull_color = input.color(color.gray, title=\\\\\\\"Normal — Bull Candle Color\\\\\\\",     group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\nx2_norm_bear_color = input.color(color.gray, title=\\\\\\\"Normal — Bear Candle Color\\\\\\\",     group=\\\\\\\"X2 Volume Highlighter\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// DELTA PROFILE SETTINGS\\\\n// ─────────────────────────────────────────────\\\\ndelta_method_1   = \\\\\\\"Bar Polarity\\\\\\\"\\\\ndelta_method_2   = \\\\\\\"Bar Buying/Selling Pressure\\\\\\\"\\\\ndelta_method     = input.string(delta_method_1, title=\\\\\\\"Delta Polarity Method\\\\\\\", options=[delta_method_1, delta_method_2], group=\\\\\\\"Delta Profile\\\\\\\", tooltip=\\\\\\\"Bar Polarity: up if close>open.\\\\\\\\nBar Buying/Selling Pressure: up if (close-low) > (high-close).\\\\\\\")\\\\ndelta_box_size   = input.float(0.5, minval=0.1, maxval=10.0, step=0.1, title=\\\\\\\"Delta Box Size\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\", tooltip=\\\\\\\"Width multiplier. Smaller values merge more rows into fewer boxes.\\\\\\\")\\\\npoc_box_color    = input.color(color.rgb(255, 200, 0), title=\\\\\\\"POC (Highest Volume Row) Box Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_buy_color  = input.color(color.new(#2962FF, 15), title=\\\\\\\"Delta Buy-Dominant Color\\\\\\\",  group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_sell_color = input.color(color.new(#FF1744, 15), title=\\\\\\\"Delta Sell-Dominant Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_show_text  = input.bool(true, title=\\\\\\\"Show Delta Value Text?\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\ndelta_text_size  = input.string(size.tiny, title=\\\\\\\"Delta Text Size\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\", options=[size.auto, size.tiny, size.small, size.normal])\\\\nshow_poc_line    = input.bool(true, title=\\\\\\\"Show POC Line?\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\npoc_line_color   = input.color(color.rgb(255, 0, 0, 100), title=\\\\\\\"POC Line Color\\\\\\\", group=\\\\\\\"Delta Profile\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// NOISE FILTER SETTINGS\\\\n//   Option 1: Remove Low Delta Rows  -> keep the strongest-|delta| nodes\\\\n//   Option 2: Remove High Delta Rows -> keep the weakest-|delta| nodes\\\\n// ─────────────────────────────────────────────\\\\nnoise_mode_off  = \\\\\\\"Off\\\\\\\"\\\\nnoise_mode_low  = \\\\\\\"Remove Low Delta Rows\\\\\\\"\\\\nnoise_mode_high = \\\\\\\"Remove High Delta Rows\\\\\\\"\\\\nnoise_mode = input.string(noise_mode_off, title=\\\\\\\"Filter Mode\\\\\\\", options=[noise_mode_off, noise_mode_low, noise_mode_high], group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"Ranks rows by the SIZE of their delta |buy - sell|, regardless of direction.\\\\\\\\n\\\\\\\\nRemove Low Delta Rows: hides rows with small |delta| so only the strongest buy/sell imbalance nodes remain.\\\\\\\\n\\\\\\\\nRemove High Delta Rows: hides rows with large |delta| so only the low-delta (balanced) nodes remain.\\\\\\\")\\\\nnoise_level = input.int(5, minval=1, maxval=10, title=\\\\\\\"Noise Filter Strength\\\\\\\", group=\\\\\\\"Noise Filter\\\\\\\",\\\\n     tooltip=\\\\\\\"1 = minimal filtering (show most rows), 10 = aggressive filtering (show only the highest-|delta| nodes in Low mode / only the low-|delta| nodes in High mode). Raise to cut noise, lower to see more detail.\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// TICK SIZE CONFIGURATION\\\\n// ─────────────────────────────────────────────\\\\nauto_tick_size_b  = input.bool(true, title=\\\\\\\"Auto Tick Size?\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\nint tick_bars_back = input.int(96, minval=1, title=\\\\\\\"Avg Tick Size - Bars Back\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\ntarget_session_ht = input.float(20, minval=1, title=\\\\\\\"Average Target Session Height for Tick Size\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\", tooltip=\\\\\\\"Approx. number of rows per session. LOWER = fewer rows = fewer boxes = MORE past sessions visible.\\\\\\\")\\\\nman_tick_size     = input.int(100, minval=1, title=\\\\\\\"Manual Tick Size\\\\\\\", group=\\\\\\\"Tick Size\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// INFO TABLE\\\\n// ─────────────────────────────────────────────\\\\nshow_tpo_info         = input.bool(true, title=\\\\\\\"Show Info Text?\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\ninfo_table_txt_size   = input.string(size.small, title=\\\\\\\"Info Text Size\\\\\\\", group=\\\\\\\"Info Table\\\\\\\", options=[size.auto, size.tiny, size.small, size.normal, size.large, size.huge])\\\\ninfo_table_text_color = input.color(color.rgb(255, 255, 255), title=\\\\\\\"Info Box Letter Color\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\ninfo_table_color      = input.color(color.rgb(255, 255, 255), title=\\\\\\\"Info Box Background Color\\\\\\\", group=\\\\\\\"Info Table\\\\\\\")\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// GLOBAL CALCULATIONS (v6 consistency requirement)\\\\n// ─────────────────────────────────────────────\\\\navg_bar_ht_global = ta.sma(high, tick_bars_back) - ta.sma(low, tick_bars_back)\\\\nvol_ema_global    = ta.ema(volume, x2_period)\\\\n\\\\n// SESSION DETECTION — generic, epoch-anchored blocks (UTC)\\\\nsess_block  = math.floor(time / sess_len_ms)\\\\nsess_change = sess_block != sess_block[1]\\\\nsess_start_global = nz(ta.barssince(sess_change))\\\\n\\\\nbool is_in_session = true\\\\nint  sess_start    = sess_start_global\\\\n\\\\nif syminfo.type == \\\\\\\"economic\\\\\\\"\\\\n    is_in_session := false\\\\n\\\\nsess_start_bar = int(bar_index - sess_start)\\\\n\\\\n// PERFORMANCE GATE — is this the FINAL bar of its session?\\\\nsess_block_close = math.floor(time_close / sess_len_ms)\\\\nbool is_sess_last_bar = sess_block_close != sess_block\\\\nbool do_full_calc = barstate.islast or is_sess_last_bar\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// HELPER FUNCTIONS\\\\n// ─────────────────────────────────────────────\\\\n// A bar contributes its FULL volume to a row if its range [low, high]\\\\n// overlaps the half-open row bucket [row_low, row_low + tick_size).\\\\nfn_volume_per_tick(row_low, row_top_excl, bars_back) =>\\\\n    float row_volume = 0.0\\\\n    for i = 0 to bars_back\\\\n        if high[i] >= row_low and low[i] \\u003c row_top_excl\\\\n            row_volume := row_volume + volume[i]\\\\n    row_volume\\\\n\\\\n// Same \\\\\\\"touch\\\\\\\" test as fn_volume_per_tick, but splits the contributed\\\\n// volume into a BUY (bull) portion using the chosen polarity method.\\\\nfn_bull_volume_per_tick(row_low, row_top_excl, bars_back, use_pressure_method) =>\\\\n    float bull_volume = 0.0\\\\n    for i = 0 to bars_back\\\\n        if high[i] >= row_low and low[i] \\u003c row_top_excl\\\\n            bool bar_is_bull = use_pressure_method ? (close[i] - low[i]) > (high[i] - close[i]) : close[i] > open[i]\\\\n            if bar_is_bull\\\\n                bull_volume := bull_volume + volume[i]\\\\n    bull_volume\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// VISUAL OBJECT ARRAYS\\\\n// ─────────────────────────────────────────────\\\\nvar deltaBoxIDs      = array.new_box(0)\\\\nvar last_deltaBoxIDs = array.new_box(0)\\\\nvar pocLineID         = line(na)\\\\nvar lastPocLineIDs    = array.new_line(0)\\\\n\\\\nTPO_price      = array.new_float(0)\\\\nTPO_length     = array.new_float(0)   // total volume per row (still needed to find POC + scale boxes)\\\\nTPO_delta_bull = array.new_float(0)   // bull (buy-side) volume per row, parallel to TPO_length/TPO_price\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// TICK SIZE CALCULATION (na-safe on first bars: falls back to bar range)\\\\n// ─────────────────────────────────────────────\\\\nfloat tick_size = syminfo.mintick\\\\n\\\\ntick_size := if auto_tick_size_b and sess_start == 0\\\\n    float bar_ht = na(avg_bar_ht_global) ? (high - low) : avg_bar_ht_global\\\\n    float auto_tick = math.round_to_mintick(bar_ht / target_session_ht)\\\\n    if auto_tick == 0 or na(auto_tick)\\\\n        auto_tick := syminfo.mintick\\\\n    auto_tick\\\\nelse if sess_start == 0 and not auto_tick_size_b\\\\n    man_tick_size * syminfo.mintick\\\\nelse\\\\n    tick_size[sess_start]\\\\n\\\\nhalf_tick = math.round_to_mintick(tick_size * 0.5)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// SESSION HIGH/LOW — incremental (no per-bar loop over the session)\\\\n// ─────────────────────────────────────────────\\\\nvar float p_sess_hi = na\\\\nvar float p_sess_lo = na\\\\nif sess_start == 0\\\\n    p_sess_hi := na\\\\n    p_sess_lo := na\\\\nfloat highest_high = na(p_sess_hi) ? high : math.max(p_sess_hi, high)\\\\nfloat lowest_low   = na(p_sess_lo) ? low  : math.min(p_sess_lo, low)\\\\nif barstate.isconfirmed\\\\n    p_sess_hi := highest_high\\\\n    p_sess_lo := lowest_low\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// PROFILE RANGE — grid anchored at the actual session low\\\\n// ─────────────────────────────────────────────\\\\nfloat TPO_min  = lowest_low\\\\nint   TPO_rows = math.max(0, int(math.ceil((highest_high - TPO_min) / tick_size)) - 1)\\\\nfloat TPO_mid  = math.round_to_mintick((lowest_low + highest_high) / 2)\\\\nTPO_POC = float(na)\\\\n\\\\nvar float curr_TPO_POC = na\\\\nvar float prev_TPO_POC = na\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// MAIN DELTA PROFILE CALCULATION + DRAWING\\\\n// ─────────────────────────────────────────────\\\\nif is_in_session\\\\n\\\\n    // ── session rollover housekeeping (cheap, every session start) ──\\\\n    if sess_start == 0\\\\n        if not na(curr_TPO_POC)\\\\n            prev_TPO_POC := curr_TPO_POC\\\\n        array.concat(last_deltaBoxIDs, deltaBoxIDs)\\\\n        array.clear(deltaBoxIDs)\\\\n        if not na(pocLineID)\\\\n            array.push(lastPocLineIDs, pocLineID)\\\\n        while array.size(lastPocLineIDs) > 490\\\\n            line.delete(array.shift(lastPocLineIDs))\\\\n        pocLineID := line(na)\\\\n\\\\n    // ── heavy work only when we actually need to draw ──\\\\n    if do_full_calc\\\\n\\\\n        // live session gets fully redrawn on every update\\\\n        if array.size(deltaBoxIDs) > 0\\\\n            for i = 0 to array.size(deltaBoxIDs) - 1\\\\n                box.delete(array.shift(deltaBoxIDs))\\\\n            array.clear(deltaBoxIDs)\\\\n        if not na(pocLineID)\\\\n            line.delete(pocLineID)\\\\n            pocLineID := line(na)\\\\n\\\\n        // Build the volume + bull-volume histogram in the SAME pass.\\\\n        if TPO_rows \\u003c= 2000\\\\n            for i = 0 to TPO_rows\\\\n                row_low        = TPO_min + i * tick_size\\\\n                row_top_excl   = row_low + tick_size\\\\n                row_volume     = fn_volume_per_tick(row_low, row_top_excl, sess_start)\\\\n                row_bull_vol   = fn_bull_volume_per_tick(row_low, row_top_excl, sess_start, delta_method == delta_method_2)\\\\n                array.push(TPO_length,     row_volume)\\\\n                array.push(TPO_price,      row_low)\\\\n                array.push(TPO_delta_bull, row_bull_vol)\\\\n\\\\n        if array.size(TPO_length) > 0 and array.size(TPO_price) > 0\\\\n            max_vol = array.max(TPO_length)\\\\n\\\\n            // POC: among rows tied at max volume, take the one closest to session mid.\\\\n            int POC_index = array.indexof(TPO_length, max_vol)\\\\n            if POC_index != array.lastindexof(TPO_length, max_vol)\\\\n                float best_dist = na\\\\n                for i = 0 to array.size(TPO_length) - 1\\\\n                    if array.get(TPO_length, i) == max_vol\\\\n                        d = math.abs(array.get(TPO_price, i) + half_tick - TPO_mid)\\\\n                        if na(best_dist) or d \\u003c best_dist\\\\n                            best_dist := d\\\\n                            POC_index := i\\\\n            TPO_POC := array.get(TPO_price, POC_index)\\\\n            curr_TPO_POC := TPO_POC\\\\n\\\\n            // ── NOISE FILTER CUT-OFF (percentile of traded rows' |delta|) ──\\\\n            // |delta| = |buy - sell| = |2 * bull_vol - total_vol|\\\\n            // Level 1 -> ~9% of rows filtered, Level 10 -> ~90% filtered.\\\\n            float noise_cut = na\\\\n            if noise_mode != noise_mode_off\\\\n                traded_abs_deltas = array.new_float(0)\\\\n                for i = 0 to array.size(TPO_length) - 1\\\\n                    float v = array.get(TPO_length, i)\\\\n                    if v > 0\\\\n                        array.push(traded_abs_deltas, math.abs(2 * array.get(TPO_delta_bull, i) - v))\\\\n                if array.size(traded_abs_deltas) > 0\\\\n                    float pct = noise_level * 9.0\\\\n                    noise_cut := noise_mode == noise_mode_low ? array.percentile_nearest_rank(traded_abs_deltas, pct) : array.percentile_nearest_rank(traded_abs_deltas, 100 - pct)\\\\n\\\\n            color last_box_color = na\\\\n            bool  prev_row_drawn = false   // prevents merging across empty rows\\\\n\\\\n            for i = 0 to TPO_rows\\\\n                row_low     = array.get(TPO_price, i)\\\\n                // clamp the very top row to the actual session high\\\\n                row_top     = i == TPO_rows ? math.max(math.min(row_low + tick_size, highest_high), row_low + syminfo.mintick) : row_low + tick_size\\\\n                row_volume  = array.get(TPO_length, i)\\\\n\\\\n                // Rows where price NEVER traded are skipped completely.\\\\n                if row_volume == 0\\\\n                    prev_row_drawn := false\\\\n                    continue\\\\n\\\\n                left_side = sess_start_bar\\\\n                bool is_poc = i == POC_index\\\\n\\\\n                if is_poc and show_poc_line\\\\n                    line.delete(pocLineID)\\\\n                    pocLineID := line.new(left_side, row_low + half_tick, bar_index + 1, row_low + half_tick, color=poc_line_color)\\\\n\\\\n                // ── DELTA VALUE FOR THIS ROW ──\\\\n                row_bull_vol = array.get(TPO_delta_bull, i)\\\\n                row_sell_vol = row_volume - row_bull_vol\\\\n                row_delta    = row_bull_vol - row_sell_vol   // net buy(+)/sell(-) volume for this row\\\\n\\\\n                // ── NOISE FILTER: skip boxes by |delta| (POC line above stays) ──\\\\n                bool noise_hide = false\\\\n                if not na(noise_cut)\\\\n                    noise_hide := noise_mode == noise_mode_low ? math.abs(row_delta) \\u003c noise_cut : math.abs(row_delta) > noise_cut\\\\n                if noise_hide\\\\n                    prev_row_drawn := false\\\\n                    continue\\\\n\\\\n                box_color = is_poc ? poc_box_color : (row_delta >= 0 ? delta_buy_color : delta_sell_color)\\\\n\\\\n                // left = session start, right grows with |delta|.\\\\n                adjusted_right_side = sess_start_bar + math.round(math.abs(row_delta) / (vol_ema_global == 0 ? 1 : vol_ema_global) * delta_box_size * 10)\\\\n\\\\n                bool merged = false\\\\n                if prev_row_drawn and array.size(deltaBoxIDs) > 0\\\\n                    last_box_ID    = array.get(deltaBoxIDs, array.size(deltaBoxIDs) - 1)\\\\n                    last_box_right = box.get_right(last_box_ID)\\\\n                    if adjusted_right_side == last_box_right and not is_poc and box.get_bottom(last_box_ID) != TPO_POC and last_box_color == box_color\\\\n                        box.set_top(last_box_ID, row_top)\\\\n                        merged := true\\\\n\\\\n                if not merged\\\\n                    int total_boxes = array.size(deltaBoxIDs) + array.size(last_deltaBoxIDs)\\\\n                    if total_boxes > 499 and array.size(last_deltaBoxIDs) > 0\\\\n                        box.delete(array.shift(last_deltaBoxIDs))\\\\n                    total_boxes := array.size(deltaBoxIDs) + array.size(last_deltaBoxIDs)\\\\n                    if total_boxes > 499 and array.size(deltaBoxIDs) > 0\\\\n                        box.delete(array.shift(deltaBoxIDs))\\\\n                    delta_txt = delta_show_text ? str.tostring(row_delta, format.volume) : ''\\\\n                    delta_box = box.new(left=left_side, top=row_top, right=adjusted_right_side, bottom=row_low, bgcolor=color.new(box_color, 0), border_color=na,\\\\n                                         text=delta_txt, text_color=chart.fg_color, text_size=delta_text_size, text_halign=text.align_right)\\\\n                    array.push(deltaBoxIDs, delta_box)\\\\n\\\\n                last_box_color := box_color\\\\n                prev_row_drawn := true\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// X2 VOLUME CANDLE COLORING\\\\n// ─────────────────────────────────────────────\\\\neffective_POC = not na(curr_TPO_POC) ? curr_TPO_POC : prev_TPO_POC\\\\n\\\\nbool is_heavy = volume > vol_ema_global * x2_strength\\\\nbool is_bull  = close > open\\\\n\\\\nbool is_outside_POC = not na(effective_POC) and (close > effective_POC + tick_size or close \\u003c effective_POC - tick_size)\\\\n\\\\ncolor final_color = na\\\\nif is_heavy\\\\n    final_color := is_outside_POC ? (is_bull ? x2_out_bull_color : x2_out_bear_color) : (is_bull ? x2_in_bull_color : x2_in_bear_color)\\\\nelse\\\\n    final_color := is_bull ? x2_norm_bull_color : x2_norm_bear_color\\\\n\\\\nbarcolor(final_color)\\\\n\\\\n// ─────────────────────────────────────────────\\\\n// INFO TABLE\\\\n// ─────────────────────────────────────────────\\\\nfilter_txt  = noise_mode == noise_mode_off ? \\\\\\\"\\\\\\\" : \\\\\\\" | Filter: \\\\\\\" + (noise_mode == noise_mode_low ? \\\\\\\"Low-Delta\\\\\\\" : \\\\\\\"High-Delta\\\\\\\") + \\\\\\\" x\\\\\\\" + str.tostring(noise_level)\\\\ninfo_text_6 = sess_name + \\\\\\\" Delta Profile\\\\\\\" + filter_txt\\\\n\\\\nvar table ticktestarray = table.new(position.bottom_right, 1, 20, bgcolor=info_table_color, frame_width=2, frame_color=color.black)\\\\n\\\\nif show_tpo_info\\\\n    table.clear(ticktestarray, 0, 0, 0, 19)\\\\n    table.cell(ticktestarray, 0, 0, text=info_text_6, text_color=info_table_text_color, text_size=info_table_txt_size, bgcolor=color.rgb(90, 90, 90))\\\\nelse\\\\n    table.clear(ticktestarray, 0, 0, 0, 19)\\\\n\\\\n\\\",\\\"on\\\":true,\\\"inputs\\\":{\\\"Show POC Line?\\\":false,\\\"Noise Filter Strength\\\":10,\\\"Auto Tick Size?\\\":true,\\\"Filter Mode\\\":\\\"Remove Low Delta Rows\\\"},\\\"tfs\\\":[\\\"5m\\\"]}]\",\"tk.lib\":\"[]\"}}</script></head><body>\n<div id=\"app\">\n <div class=\"brand\"><img class=\"logo\" alt=\"TraderGze\" src=\"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAjAAAABJCAYAAAAjQxxPAAA/kklEQVR42u19eXwkV3X1ObeqJY2k7lZLamnGNrYxBoMJOI7ZIZg4ITgQgtniQPKxBPJBApglkBCysBtMWAKx4WNzcEhYDCFsgTiEsDiEHQyxjTHGeOzxzGhttVoaSd1V93x/VLXU0rTWkcYzdp3fr2xNd9f23n33nXffXYAMGTJkyJAhQ4bjDLyTvxtb3lEAPOvyDBkyZMiQIcOxSlzCrBkyZMiQIUOGO/dkf2d6F6LFypIvlR8m8PmA7knwq7XK6F8AMCTWGGXdnyFDhgwZMmQE5o6ELRGX/kKxGDzZDb9P8Nch/FRQjuQwyPOmJ0e+k/4eyLaUMmTIkCFDhuN24j/WCFWQPpelf3Od3y+Sl0Jp8Gn5Uvh9GC8nWDLiJbmg9MCcdT4SQAjpkvzg4L3S3zvu3D5AGTJkyJAhw10aXHHYDhAfrkNWAix3yF1GvnpKw7+UL5U/VewfVrE0dFVxYOjXV16/0Df0t4X+YeX7yrOFUvnD+dLgb91J+6qVANoGSFqTKAYt52bELkOGDBkyHNMI1pjUiPZ+Ik3/keZkuVVfEms5f9EnJV8afGxXd+/TOzu7H9/VuauxsDC3F8u3epqTrBeLxb6O7uLfGvAhALtkumh6cuwVC3Ozv0iv9biO7q5cfW5ubGF+9mtdHT0fcsMYwccTvKiju2eqPjf77TvZhK2VbbrJ32e+QRkyZMiQ4bhYsbf7rGUSOyeHPftz/QsLYRQFZYS4B2ONV6vjP2ghFKuFKLPNv5ufxc0Pe3sH7m1h8FQHzjfiYZLqJMN0dv1fAF934QOzU6M3AphPyMnw4wi9HeS9IP+7nPnfTExM1ABYvm/otwG92MzOk/s3p6dOPhf4fqN5v+Hh4Z65uj4u6ExE8w+s1WoTWOZHc1z2o/KloYcS+EsJoaR6EFiHQ1fVJkffsaJfm3939PYNvSEw3k9SLCEg4HC+dnp65DtrkNgMGTJkyJDhmCIwyUTYP/QQAk+EdG+IZwsom7GraXaBBAkfCsi3VSoj17ZYVFZeN17txt3l8u5crMe589EgnkSgQvEXDlxcmxr9fKlUysfIPU7ir5H+eIDDgm6G459J2wPiuYDfGDkuPFQduwaA9fbvfhIVP4/gb5CEJAGgpA+S9p+INYFQnM7ZN/oWdA8ZfyT3F01PjV16nBMYA+D5vqE/CAL7cPLaAEnEsX+1NjX6a+0ITLlc7l1o8LsM7N7QEk9x92fVpsauSMlpnA2TDBkyZMhwrCFcSTq6Bwf3MMaHCJwh4YuCvgDauKTb6Bo3C0dixY8U8Oex9LR8aeh9iPzSWm38xlXu0dG7e3cxmkd3DtH9EgsL740GHyqz3YDfBvAvGow+NleZvL15UqVSqQL4CICP9AwNDYcLeqSIJ4F8Cag8gfd0hPiz6bGxmd6BoQsY4/mUP4Y0KIGnE7vM7DkAnqMADjHKL+grpN4QO24i8WAAl94p2CjhkiJpkY2QxOyqrMdMgE9JipC0FwEYaQvZ0MiQIUOGDMcLgTEAcRDhd0Gc4fDH1qbGv4gz0TEwMtC50NHRqbn4BFKNmcroxbt29V8RdoUvAPgiBPasQn/5fYiCj0eMG6HxPhBPdelhNJ3Iee/OUWXC+h2oAqqB+jKEy0z1G6pT1cpKawKWtps0Ozo6AuATAD5RLA6f2pD3HaqOXbOrMPCAfKn8Fjp+jUYk2yByADm0+PdIaloRAgAdND4mku5JqCDgcT2l4fvOVkauO86tMK196ottqdX9e6IoMsECLp2TtrkyJ94MGTJkyHBcEBgCiHt7ewdBvljCJ2pT41cVSsN/pwN6VAPYZfNRCUABiuN8/9DnAvP3TI2Pvqp39+532AL+Uq7nM/A/DYRZSCZi3qAbBOwVNELxAKXrjMF3zeqVycnJ6RWkBVjuS9PqULr4fbU6csuiaSfM3V1yk3CT5CfSbBeAoHU7pIW4YPF6kgieBgJGgvI/AvBSZP4eGTJkyJAhw3FHYBR09DwBwN0pf2Khr/zHJF+8bEpnk03wQo/tifm+oa+yrr+eroy8pFgceldMPFq0qhG/CFXfX3lx5Xa8dk2LhmFjNYq8Ddnx6uTBTwD4RH9//4l1t9Ok+N4UzwNwAckuLEVLrXiDRX+QGEAo8awWgpM5rmbIkCFDhgzHCYFJGIF0NqHPhkHXWBwvvICQA4pbLBhMfiaS7CDxmy79HMD3qtXRmwG8d9nVX7uMcLRCLcSEmyQNvoKQaHJy8nYAtwO4ulQ67cpYM78M8N5ITDFrbYcEkuacfG9GXjJkyJAhQ4bjj8A4AJjrA1EnD2hh4WlmPCP1Bc0tJw8MADXc9R9meB+i8OvppB+sIADNLaDVrCvLsuhuEa0EJQCgKJoPGWzsXJIG19WFXfbZ2UwWsNSWzCKPMmTIkCHDcUFgAADVJBwZhdLQk0AYtIxcCIAJ2gvydd0d+PjIyEjrvL/RSa+16KIGBgby7m5p1NFWSUzz/iJtI8nYmuHVEeiXHzgwOoc7hwPv9rAYMrNCZciQIUOGYxq24m/29ZXPEnH/1PrStG6ISWKVG9SIz69NjlyekpfNpKxvXi+1ypzSle8bvKgeB5+MmLsPtpYG/zBMT++riRol18wqK4CU9JXpkP+GLANthgwZMmTIcFxhZR4Yd7czSBWx3E/FJJ8H8dKZmYkb0vPiLVgs1LtnzyAXosfTDz1PREOOD+c7gx/XlpxqVyM96147JT0Ngf8k6VysXrOJkM+Tuhxj4zPIrC8ZMmTIkCHDcUtgBAAKdBuTdP1dKaEgSbjjnbWp0X/HUnZWAWCxXD6r0ehQcZf/7MCBA4dWEI9WB10VB4bO8/n41RA6nfiXHOL3Vqrj1ZkqMIzhnpkSTiV1LwNmxPjW2sTELwDUN0OQAKDT4o/X3f4vaQ/EUkK7JpwkJX1z2vRvredlyJAhQ4YMGY4/AuMAWKuMfrO3uPsZRv8giDwAyP06RXNvbZnsF51nPeJzAjZ+e2Zet+VLg/+NqONttdr+qRaS04R5jD2A/4upcUV1qjoFAD2lofsZeOGc9BQTTiTQK6AOD0YKpaGb5fp8rXryO4HvR9iYb4tNTEzU8n3lywj9wyonkMQ3kNZOwp3H+rIpIjYxYcr3JVnrtHQ+JQXZ0MiQIUOGDMcLgVmcwGaqBz+R7xueh/sbLbD7OfC5mZmZcSw53zYn/RC7wtd0x/tfOT8/8GAENlCt7Z8AgHK53Fuv8yEIVOrK2RdGRkYO1aZGPwogHhgYyPeUBn/XxCcBeEyS+E7fI/AzAecR7AZxN5J3g/HcnuK+781W8VVsrDaPALC70z55qK4XGXlOmok3SJ6Z5vDrcozfiztXFeotwER4G9Ijy4ZGhvWEB5nvWIYMGY4hAtMkAGFtauRzxeIJt0nRV6llDrUBgLh3YODe5sFbcajBQxz8BWkHAFi+r/weAMX5Bk6n4ZfJIHdoQR8F8PT02sFCFP5uEOADNEIugHr6dGXso8Xi4Nkiz4JhFwRKaoAMA/pFAL6KjeVqEYBwZGRktrdU/inAX1n2e8IlXDZZmdyHzPflWENwjJFKbYAw2x30XHckceAdMG5sm9tvrX9vVxsdawskPwZlGbjjdDB3YFyu177Hmn7z40yGl+m+cA2Bsu5u3TgzjwqgPiw5yca9/bvPNPd/otnZkEAQSCNvaUtVASRB7hGNTyuWhn9UrYxcAiDId9tH5+YaN8WwV5J4NIBXFErlx7rwZJrtgvRDAf9N8EWQBPKJ+f7Bi2qT4+9qWfltZEC8W9LTm6SLZOCub8xMjX0QWdK6YxHHY/6ZO5IAp1bFoyrHBKC+vvJZURTsn5k5OHaUxtJOt7O1ELPteJfj0Tp1R8qy7eAzcMX1tYPE9Vht3zulDIdrNfbsbNAFiwOS880X6u3ffSblHwHtLLlPACimGW9TAVFrdl1DUpsoBvjmfHEgrlUn3po6+34NwNcKhfL5CPkiwv4g5XqxhCtqU6PvLPSVnwjyJACg+Ff5/IlfrNVu/9kGLCcOgDOVsW/kS+WvGO3XJJmkmknvQOIYnBGYYwPNfgh7+4efaa5HOOAEY8B9E/3ENkppvUzM7VZOAUETFAu4JVD3e6rVvVPtn+PcsDjwk3PlCmkeQSIQQtu0amHTsR4gAUUxEJhCBfp5bXz8phbCd7QsiQbA+/tPOrGh+mcsF/8AwJNXafttk41TTjmla2pm7uGSApKxtElLgdItUdLdrd5hGK3XMT6zK57D2NgcDo+oPOLtsZ6+ofsb/UQzzUtBeNQHFZP3kWCQAtEqtcmRHwBotJPlU045pataXXiwM94Vu8+HQRBqB1bfBCQpiN0aRnQ767+YrVSuQ2sB2u2R5WUBJKssjoIVC+IjnROiNfRbkC8NPgbCPQkebSKT+DZCJBgBMJIdMfGLmfvd53P42teiFe9OACoWTy4BC2cjkIEQEluFWgsEb7euS/+hpkUkGfNwIHZ37hLDW2YmD17ffMZwLYVO1gR2OLGY21Ym/zOSZ0nukCKQhuWmx3YOoCZIZuHfFvrKh6anxt6dkiefnh77dwD/USwOPhu0l9HsTMF/u9Bf/gmA2wieJHmDtDKCxh8B+LNNKNs4kF7r0IMBdAuIPfTrtklY7wRwppPjSnE66iuFQqFQkPufMgjuE2hlDc87glUZpPiQcoc+AWAlgTEA3jtw7eke22dI65GjsUjYt1HrtP4dWCq2EafzfYPfMtq/BIw+lhZG3Yh/2JFOCNizZ0/37PzCm412CoRTevuH/3BmcuSDO3R/AlClduiRAL8I0aQtPzogwOiIXLMWcrIQcQ6loREJ+036nuRfy+Vww0Ti3L8VIkMAKpfLvQuR3gUG58o9WmehuDMzllonVQvhfm13d/nRhw6NHWwny5XpQ+cCvBJgITCTtDNbB6mdHoEpnSzC0Xzf0A8JfT7K4ZOHxsYObgOJaY2URW/vnsEgaJwM8O4e2GPgKiIJ5NgtoIfSQrJGRkAhTt+cG3wfUhBoknBxbWrkcyuenwBUKpV6Y/BNtOD+uoOmnZVbF5Tv3XXttd+eA/a3IzCy+d8C9H6I3Ttts9Jh/1CrLDtgbrTQ3a8EcOF6BCZ9mSKA+WUTveTDZJCY4cjhTQzsWABBvqSvb/e/TU0d3Nui8ONqdfyD+fzg18X4983CV0t6FKB60tkMJUnUcwsDA1dOT0x8b6NWmKmp8avzpaHrjTwHQh/i4AEAbsCd0/+FG/wMADAw4KzH1pp2lwlxPfqlBKanC3OFvnoFUqQk9P2OjISKAQUAq6wzWnXQeRgSUrrAyR3F1XWBDH5TwG9GCp9eHBh6fXVi9Ms7LNME4LNzjVeTwR+kjvFG19t7SsPfnq2MXLtT95dj2IwmHJYSYasN2AOgJ5X1eyUMnhfKMdtw3tTTV/5AzOgz85XKbVuxCsRxbEJQslRJ3sE6IbU+oXfXLrdDh1Zt5RJohYT6HM1n5pAZHyPxMWFDL+gpDvzxbHXiq1uUJS6NX6BQ2n2+FF9AxOc5bDeJvAGAcYU4sHVsbYqtLp5DApHfazWdG8c9AWwhAOVtUnscNTNMy1xsEHNhMhbavprkg7Sg+4563uUynHYSNXS4cK/yrmE4GwECpI6Wzq63EA9tSm0QBnmhwYX88skCBBDWauM/q1UmXuPSpSRDgLtaCZXRSojttemKZr3tgWZ9Jqd4NZC46oA6vYXgZDhGsAf7mHZagMMzMm/0CNocW72OJdFYq0dkrSB6R3NZJUkOKQZ5rhxfKBSGL8RShOBOTIKeLw09VORFWtoyFo0Fwj9QKJzUv1P3J62+3e3XPCS5pFiSk+wheVZg9vcdyn0nXyq/sbtc3r3Z98rlcjHA+rE1whjNmfk6snxHmAYSWYZiGO8dMLiypzj8qC3I0qK1rKc49OuFvvKnIP+cmT2PxnuymRIk6evm4Uj631v/xgaPlnMiSE7D7GpzabKbsfhO3KJe2o6j9d6+zoTdwLGzS9HkX/WNEBgDwLnI7iFg2ImfLZrmhLISk9vBTZhXBcBcqoB4yWylci2WRzIoMXUiHB4e7jHHl919dsXEYJJimp2f79v9+9iYf4OnprJ/lOsgkwXRg1MC5LjLh1EfO5gvlXICdmGppAS3cKy2UNrsESSWYeSABd/iYPMdPLT4nFIEoAOmdxQK5dOxcb+fTZGXvr7dpwB4F2FdLfcwSHFAe7CC+ut3zhwWa43xvdX2a9VdTcWuxQmM2G20V4UNfj/fV35Gi75Yt22jKFptK3Gn5WKtg90S12ARq72bHwVZXvKVJMuBxR/LDwyc0fLdhmS0v7+/kC8N/X1g+CLNnggiXCQnS21P7FR0zcbyZ2kHj83qKFrD4jV+sVrU1B0ox8t3jdaKQpKZ/SmhSTo/CQD5/NCDQP2ygHlAdcIsbbe12LIj2SCclvCcWnX8X9He/4QAonrdThDjy0h2rWg8B+CSQsJfkT/hhM/X9u+fwNq+LA6A1erYNYVS+UrALqL83sXiKb2pY2aGY4RZVyqV6UJp6MeQzpSwsLbi0lLYWzoQSYUAu1YOUEBzAGoQ8lokzCuLVS5eT4RCkXVIOYI/i+N4dlULCxsCArVbu6T2vp1ct7aO4ZjGPU5cBOAibJ8/SvoOZ3bEGH8byQe0MScHkpzAH+f7y9+pTY5dgW3eSgpS7592ppkjfTkt7berRY81yUwM8gQCH+gtlXfPVMbehiOLYOGy/YqjZH4nCcXO+fkw2sIj205JctrIWEbIIQeDYUR6LICfboBopAR78FcbsrcZ+UBJaG5xtlhmlralt78LLL3mqhc2M49BT28e7kxjblgsY4A50rvkW+ndo6DfVpFj+HK9FrZphgBA1N1XPsug34Pwump15Jb0108nrQvSLgC7AH8nwD8C2L1Gw3HRikY+Nl8aOlirjH6zDfEQgKBSOXBrb9/QPwfkK1oS0AGkETTJAfJMHKo/FMDnUwGN1xNwEy6PET+D4Mmemx3C4Y6ZGZavxo6qfRuAGvPxq8JQ74ktWAjludWtCTkAjcXvYgsWAuFcEO9sw47eJgYfIbzPPKhLC8HhBCYnoMHm3zGjOHDvAIPxmZmZsdUmLLkHRMDDSbP+yeFfh7PTkkkrTldn2oJKMlgSQSBZ3aA+CL8D8kFYnldCAH4DAwP5NMP0dsg2AXi+b+xCkk9aQV5W9A1B4eKBgYFvT0xMbLePWbv3iAB/F8QbIYUbelfSCeUhuwfgdLAf1DkQB0nkSQbphNp8zzCNqswF5CW9pWHMVEbegnVSOZiZ4Ct1Gwn6dYK/j7J6Ghm1Xh9xk23UdD/1xUiRAFBsgYTbZ2YOTm2SfEnQZSb8r6Rcixxv9BornYWX2KJZAFdBxBMIPKDl+cUkbuzpGB5+H5Kiwau1kwHwQn//g2K3jxh5UgtxaUkxQCMToi2oCnkF4jiIgOAsgCqEAVFdACImvNa43NqZ/F9wkV0UDgm81eA1ABIRUvpmm7ZZWqANDDxXrkFJ4WFrDK54v404UROSLCS9Hoq1OEaPAryCsF9He38xTyfinLvmAPxLVydG1uhPtpMxSR8X8F+WuJbsdEh6IhNiIw7UQ8P1rfcLVxO4APhjCIcU4z8BoLd3dxmIH5swSErCraZdrwHmvurmryJ4Ntr7phCAmzEv1yMQx+9dd9SQV0j6QwBL++qubwi6CuCU5LU67PrWTlkDDiCYmhq7tlAs/yMDu8gbuC+AG3Hn20LSBj9bRwke9VICAoC5uYn9SDziN43Eyz+n5ZMLQfDa2uTBn+zAoELoHWWZOpe1nTRP2YdmquNf2anGGhgYuKwe29vN7LlKtpACSYRwYkG6zzTwnW0gMAbAi8Xh80S9o81Y4fLfykme0IjtH3p37/6dmYMHJ7AzTr1pSChmI/rb5iYn9h/BtcLucnkwiHGqu36F4iMAPIHGVsdFSyy/gEF/01Mc+O5sdeIra72buxPLia2TCFy4plYZf9cxqifakaEYgb+rOj7+s516kM7i8D910j9C2kObTtqSSOD+fQt++hTwozUs9uruHtwD5ztpPCkdC+GS3k+tR64b5Pg2DP8Rwn68sBBP9PSgVq/Xw+7u7vqBIFD/oa5cHI8ZAARB4HHcGwTBTExS7m5J+TyRRsVxbxCGs9HExMQ8lkKnW10i2smF0uCTHUFP/9BvBAGeDuDs5WlN0GJdZAAC7rrKxEuq1cFv1HB9fQ2Z8DYyIVDvmqmM/c+xIMPtTFlxT9/Q/UH9LqSfINCflkp7XhZZfRdim3A4jXZ3Ud+tTu6dBvDp7u7Bb4cdvJTGJylZwnDljRJmrEunpxc7Ue1NW7DZysh1vaXhDwfES1IzrgHeiOt83+zsyMgWBmOUECP7EqEXgXgYgH/NbC3HHLayN23JnGFdaGPslryjZUUWb2GQrEEKfRBLKQbS1S9DR9SLw3NMbBeCiYmJWrF/6AsAn7ssfQLRCwX9W1i9t7W8oFgsyfzvSBvQyq0jqQ6yo0WxNX3UHsIFfy2AP8HORpKpIwq65pb8pbTJPhWAKA3bPQjgWwDeXSwOnyf5iwC7oGWfzpAkwuwxC14LnPkNJIp/cyRRyLW0ydG2/q6XdbXtOR7HHek8sRPPawvVkVs6+oc/BumhLTLrBDrcsF6Uq8IOPotmD0ktL0vkhTQpvsnE9xqjj1emFiPKAADNaKxqtQoAmATmll96co3bTq5F+rSOrtoOHWlI8vmgv//Ekxqov5rCH5I0HJ5nwJFsvwRy7SN0aS7wdyepAkY2olsPW7CYW0eLfrsjctos3jM8zPpyJjpsv15D4XYnPk3x1RGit9cmJr7d0zP0+DAMT3BGXwPxw/RCuUOHxg8Uwv5LHOGDSJ4IKG55YSbbP4CAi4ulwZOqlZ7XAnsXViEgyX5TEL9Hkf0eyN3JaoiPCnL6TO/AnmfNTBy4YQMTEgGot7//PlDweBMHBD8n3Uo7p4UxZ9tIx5YFaSt9sUb2VLY67233YDuccAmi2UIqmzsRjt5MUDbEZCdsKamUFImY2Q7rEgAU0PEa0u7XspXbjNxpkPYswB9K2kUt3weSYpLPL5QGvzpdGb9yZ5UcHUtRjNriey5bbFWrI/+FM8/87+KB8dcI+IsWuTQle6sPLxbHHl+t4l+wyvb1qg6xRNRcpB1Bm6xMuraT+ktBGLZaGXamFxWPANb6LibAGYfjay1a+vp2nxLTn5M60rRsUdHg+uKuDnvh6OjozauMVa0xnrnJvsAalpfNfL8RQhEDiHt7d5ctFz8l8sYLzexMYZnfz6KuI2gOTUnxe+i8vDo9dlNzIYT1s06v1UZ+BO/UauQ4ItkNVzZO8eDQIwU82uCPBdgjYoGx1wHEs7OjI319u7tI1ARdt+ytyG4QA8mfDJbTeP3Eoa8DLEusdw+qdGgcB1oaceWLsDY+fmOhr/xRki9NSaWD9mCL43/tLZWfO1MZ+8Y6isAAxObhky2w10uLaQRjCnM46aQu7Ns3hywS6c5mwTl6bMvs8KwRRCjH8EknnbRrYWEhcHeGYejuTjM7fHnkTiDxm2j+vdpvAaBYLDZGR6t3E/AKrlglkaiJweQRKgYC8N6+8l+AfOEKy4tImhzvm54a+RhOOukzhUMLDyTtoS0kJklWAPt/xeLgTdXq+A92iMTwCIuOrrZ3H+D66+tV4FWFvnIHaC9rrqlSK0wgw4sBfHod8nS4LIrhNrQFVxD9nVx8GeJ4YHh4+CBGAAwvyeuqJ7TIcbvvmn+nkVqo13ECZM9InJtbzQcaN+PYWuM8oi4MyHu0yKiTNHf/CuL5/zM6WptI57h4g4sjHcN6bbGQcqFQfrQsfj1gD0xTG7f6/STvmVpjYvhnjfbG6cnx77TMixup8bayPVoIZqRNXGO9ax9RCYlwJTuk288iNR4/XZ24ure//CRTYqpatB55HMqwjxY02XEMICeGF5PocPnNcl4D4nYjOyQtUPxXmA9JthvUVKjZE08/HZM33YSFlawaLaFzIj8B+QuApqlaDvLeBnyiUBj4nXQ7ak1LjMBr3NXMZ3MFiE/GDfsB9u1bOMaFNsMxTF4SyU9y+6+4dwDytdMzC89M9pxNjbqnv3FtbHFmbDqBKjGnB1DiCDo6XnMFuAeBU1u2a2OSlOOGmcrBG49ArgMA8a6BgRPM8VKA1lIaJKnkLv8y852vQRWGffvmvG/wz436MhLP6mTsJjlVSjJ758DAwGMnJiZmdsZSwJ0Yu/GikveFi2Wd55rZA5qTZBLhgtOLxaFTqtXF1f16yt8kAcQ5hb7yW0EGzfIQm0zFztTu5LLE39A8/lS1OvFf2zx+lgr3eu6dh+p+iCUC9Y00t6/RHr7YKqI5wV0MdAaI8kqS6I69HZ1xOzK+OJET/tDUcrMYHi3XNN1eOV1bJC/RBt9dPT09Q5bL/xYR94JsTa/PdPAyNfs5AA+Smyf5kAB5FH+tVpv46TbL+uK8mB8cvCcivkzAM9OagU0i0SQuS4sN9+sBXDYzNfZ+YDFL+GaJQjuZoMxeXOgbfhyojjS5tWuDsWp0KP2tSWxAcUDjFKLcO2u1daOK1yQwAoA0Q+5eAITYD6DXLKgvLRiDaQvi0Sjy5l6795bKD5Pkcj6RVDeMZ0g6w6VbINxTpg8Zw1MSk7fBHVMj40Pfypf0A4phZ07vGDs8hbRcmDWgQaJjqTMVk9zjQfCJQv/whdOTI99ZS4GY5r/h7LiV4KlwXDk9PfYf2SR+54OCIEjF/qgRUoahJLc2nXB3mN19O7qEbXqW4uFmWDIg/dOpwt6Kvw8BxKVSqRjFwd/RWG5d2YI0uPab+H+r+/ZNpvcIZ6bGr873D/05hbe0KElLcqnwEXUP3gzgBVgRhbIdXU7uWMkLBxBMT09P5otDH1ESJbM40dG4R66HArh5DYWrw4gHcA+YvbR1j2JL0hGkMykJl7oA/NeRTppxDAVBm0mLeMhStDq3TUPx8LZamiAlN+FjI6tHIKlYLPa5eLqWfEI8jSL73+npkR835XkzVq2ws/fxgD6wmqsKW1j+YbM6CYR6PYC/wfqRsRslLgDg+fwJAwjjlyLSs2k8IUn+rdaQ/6afC901LepixvMfqCUkDttvAbULaE3xWJLHzcjuUuMFCQ/r8M8BOCIC03rZEEBE6CSAXWQwtXj/YC6SOvtzAU5uvk3QYbd7Xa+g4v8L8fdAdqW5iOdEzhG4Vh6/VbQ9lJ4NcpcZzwd4vgDMN3R2vlj+SK069qFWk3jgmlXAxsomkBQTPFWuTxaL5ZdVq92fT31qhOV7mGG1Wq0USuX/odlpoj8UwJfT73d0XzfDXRpqJrjYQSzltyBDd/+65fgpbM3XJx0z54Sx730nAz51WQqDJLqqAeJ11alFq8Oigq5Njr6jtzh4VhAEz0xJD9NznMDzi8Wha6rV0fdj5+s1bTtHtUC3pT25PHw8zezablZnUh1nVbnYJsFI+4fb4igdhtSKnCyL68ijsCRoTloxydDlV4dB/AGsXhpFC2a9Oai3DcX/BoAtWdfl3kUztWzJbIbwmqFtJt6trlkcAPr6hp4QI3q1gWcrSZzTHF9LdbpIgxC568swvGZmcuxbh+mIreqx9h9L21vQybHF1B3hKg+d7Bm6BkSMhrlo0e26o6OjMd/ALkGFxZvPizS9AxY8GPIvu/Qxi/VVBPwNCKfG4lVhCJPHvxDtfET2Vx4oIPxNIO9Ds0cDOi9fHLRadfzypvDkcj7aiO2G1Mtcy0mwYhKhhEfk85NfqdVQb2Gaiw5G3YODexRhD5M40zOxtG+dIcMdbS1bLcvlRvbqYwBBEl3g344W/GlzlYn9W1yJG4A4X9r7W6A9s02yOkJygY8q9JXvJbJDkBvMBXVQmhNwcjoBctmkRJqbv7lYHPxetTr+Qxw/NcgSh+WI1XaxVHJ0rXri6lltuf3yo2gbrgP3oIumZmY5tiEXOyXLzd8ZwBDCTW7+N5MTk9NryUqQy5VQxwBaHNnTJ78ZS9sqmyPLXKx7ZpskMEii7FE7wn5YtNz0lsqPIOz5sfwCmvWsSMy3RGCTOO/vBuAbp4q7rsLevfPbQFw2Iq/bKctibFta2KyeiffMMzt4YPx+gn48NjY23xTksbHQC31xjwu7E4a4+5QY8ccInk3peS4/0NMZ/letoYeHjseT+g2jLpSzi7IKiNOVi4dqk2NXFPqHfpXgL0mqA+gA7Z2F/sHd05PjbwJgExMTtXzf0HUEHtJG4ANIkx7g6zPV2nRrZ+3q7z+xA8HD3PlkxHgAiXuk4/Ix+cHBe9XGx2/EnbOYY4ZjhZysl3G17Wp3/XOXJReRz8LxsYDRa6fnKvu3KNMGIC6Vhu4XA38LUS3+CK3KvdPI31s0Gy/+ly0V8A47zyDFRusX/d3FYvG3qknc6vEQ+Zf4Oxi6rd18RVVWnwcprL5C3S7FHyaaH7u2ZwqJh1eZszcqy1s6tyWB7Aykf5frlbOViZ+vZ0kMFzjtpkkAebRGZhGnY6sRh1JH+rxbkk3nYbsFmxmDDiAeGBjIRx68SsCLSexS4qXbWtx2ceHirhqlt9A73z01vW8SU8uutV0kfqfJCwDmYou6tovAGAAvHRg/IwYeQOGNSLZbOgA0SqX5XISwy8AhAIgYn2TAaYI9Ybpy8AvFvvJ7D9X1+gA8lcZi6qV2avrau0lC0m8C+Ee57pkEWCe1iUj2wu2V2LPn73DgwKFkgOrGJsE+rAHJ+9LxD/lS+SsCvwBhxKinSHiEwFPMyOZ6Qq4aqR95bJ3Z/JphB1fthHBQ0O1JOgGuDM1MlKtwEondWJHpU0AF0t4VlsQkxTpoyfeYNOpGMv7MdGXyOyuU4GYVJ4Dhnhh6N8n7aI3Ksy01ZdZaQR62WG7mh/G48w0AXojt94fZCfKS8gP8XqqzmltqlvbU6BaUvAOoSFjgYcki13BIpix14tbyi6mL5PYkmTMU2jqbQLdCOpg4dC+TYwEwSnWBJ5PYg8Oy1moE0i0iw+WWFjTLdkQCRgT8t7n+q6sr+OnIyOjsOrIsAKhWR/blS0O3kDylaZ1noucfjiXn3U2REZnNYikZntawKnGVwWRbkLOm1SXX2z/0240YL0/zlK0sh+BI/L6CpBBl/I8m/H1q1Ux1xDKdsZ3jYGUTzEGsgqKEmNhwSQ8lkYN0pamGRXQSGLFwzYzAmyIwqTlOZ9OCHnk83N/ff+Lk5OTtADBv1hM68gJOAsDAd13vNleD4jIAuIFGO0vuaFGGahnAAQEvlYZ+KYYe0ULeE6d8YhYLC2m44bkW+E+m1kiHJRIF0p4g6QnJYtAWKb2kBsFcLF2BKHjz3U4u3Xz99YuZBzPry6oCy/j4e3Tx6O8Mxs1JpZWc1Cm9YHpq7NOrKFBDkizyfgH0nwDLWErxTcivnq6MPbllMK/M9eGr9Jtvsb/jfF/8XDJ4hKQGkmii1RTJetsiK8MuF516ExKD5+X7hr5Vmxr9J2xDkr8dLHkRAmjk+4cfDNfj0q2x5iRCwG8yb3xzHYXb+nkaWRN/KUD0vHl0oVO+sqSF1hTtZXlf0tpd7kEQRGPbRAbZZpKOYtcFh6rj16zSXwGAKF8aegiAq1qsIU4yiIV/m5kafU4qUzEOz/2xbIspzSm3EVlOfBilG0A+skmsEiLD++ZLg79Zq4z/Gza+jSQAiNC4ypznG4MeUguChUDsTPtJUEB6HcidAfklSQmdZQIZbqKtg5Rkxf39u8+MpDdB+h0Y0eI/14wuigEGqQvM1RHxhkOT4//Rok+ONKR5taf09hZGvTBgx39EUb3TaL452UssXHWaugDIZVGkQ7OVsW0jMGmiLF0r6X9FPDdS+AeFUvkfpytjr4S6jKi7oFPy+RP6q9VbJwrF8rQCe2dPafj7kH9I8j/C8gKPXE6OWI6oJ5NWbklClEYWuiEIHADyA9feQ24BpLFU0bfdn23xj2Fr5VGSOUlXzFRGnw1A119/IKMoGXacSblpAasnSXQANjs1+uN8qfw/RvsdyT21VDjA8/N95d+vTY1dgeXhke2sJ01lv+WQ6d7i0AUk3pSOm9x6q8xNmI9XjlMmpm+8padU+uFspXLdkZq7yW0No261lDVKpeH7xvIPgcy3tEeSZ0T66HS1OrXa87ephdT8vDo1ObUXAOaPE1m2UHNrTJAOgLXK6HfzpfLnjPa0VBebJBjwlN5S+fIVObt0hLK86N8i8SpJz1vRiwWAl/aUSrfOVir/m85xjrX9cZJSJski/fb1GqWrtOenHdIrQXSj3c7A+lZPBxD19/cXIgV/Esv/lOSgtOj83xrybCADuG4X/P8Vervetm8pf9l2RDttzroMyMQbJiu37zvSC27HGLDVTXTjP5iujNzfOu2XBHycFrw0Xyr/VZcaJYDdBO+mzvovASDMLjayaPDLonm/BdCtqzD25nL1NIoP5Coryv44TgowRvYwwZ4scH+6lao1zHCtJClIClb5/5uujD5rjXfNkGG7h3mrouQa445y+2a6vG452EHyPfm+8v/BUgKu1lVb82DLtVZ+tpFxH+cHTjjDDJeR3NVOUUE4CGk03QrYzDEK4XYsT1LZDMfeYwjfgz17urF2Ffsl8wVitTfAyFYQj5XHWkTFVrRdkyjGPcWhX3foX0G79woiSpfvbSD84FrPmyZyY5vZvvW+4Yr+3Oix8rnXa4PNZpddwcbDYB39aQAiOL+3QgeLxoKBnyoODJ+3gpw0ZTncoiwLAHIWfF/SbVyeldiNdmqg3FU9xeFHpVaO1vxia7WbtTxXuyMHIAgQF0F1tBn668nyYshzvr/8rEjhd0l7k4DBdLto2TYsk/h1Sf5G77Kzp6fG37AvyV+Wa/ldcASHraPL2uWBgbt1pufmjvDetgUZ5noWmGUPXB0ZuQXAC/KlQRH2ygi6B4B5o5UY2QsBfK3Qk/vs9Mz8/5iFjww78VYIN8F4cluP9sQp5lQBQ6nzV9BGMTG1u05S/qsEF1KfuI2QEDHxont1bWrsdTjCTH8ZMmxyHb+RySIGoJnqyLvyfeXnk3bqUvVYCcAukpcX+8qP95jv6OiIr01ql2zLamsxxQDi6A00ntDi3+HpCJw08Dlk44dRFHS2sXQctuqUxDQvCyUPGkFuPgd/MoG3tUwuTafeXy3Ox5dUgRdtzFQUtG3PIAgb2Hz5idUy2Hb09g0+xMg/AvRU0DpXRGPFZhbK/Y3zlQO3btF6tCxC8rgQZzY2lL2W0mfd9VLS7oaloowCOCT3z+dLQ5cD/GKO+asnJ2+aPkJZdgBWqRy4Nd9ffrWAy1sWDqYkB9Eeoz6dL5U/ac6Lq/mOA2nm9Y3IxtryGOsQAkZthv56/lDqLZUfbuDrAf5amyy6LXMgDkn6b8Evnpka//oqMnR0l2bpe5h54w58DmyUwLSm+mUt5CvzDQ2Y2dPlHgkSiQvypd2/tW/fvi8W+8tvl/QQkr8raB+ltVagOQLF9UzPIfCLGGikORe0gYmhmUr6vSl5IbZeXydDhq2M842ELzZXg3Ok/TmgD2O546AAhDB7KuGPrXtwQ6E0uBeyHwr4MUAJMibOcMn/pYA5v66WVA5eK709AXi+VH6tgU9ZUecIyfjhpVPVkc8cuYn4zEsLpbFfI+23W51gkwkGf1woDf/3dGXk49hYXbOVLRjUUT+lVDqBc5hjlzq5YPVYEsNG19zMzIEqlhw5Fye9PXv2dNVq6jGLC+xQEY2gT9TDQZ0n8RyS+STb7jLyEpEM3ePrvXPu0+vpoTZh1E0nlsKu/v4Tk/lem/YBSomkQEpxnAMpkrEk61LnYYu7BavHNIs7orAjijg7M3NgYrP3lHLr1axxAJyeHvt5sVj+G1GXY5nvlgRwl5EvkPSChle/k+8rXyPHLyzQL6TgECBKsCQvH4z0KGTHjyqV/betN4Zqk2P/kO8rP8gseL7kTQdcQ5JYpEjac5x6amGmfq2K5a9YgGui2MYD+W1mQZS0KeUeB2bm81yIO+JcbsHqTi7zBaQkC3K5BczjNADdrdamNUhpC3kZep5BryU53GJxCdoY6ozU9+l4b8wQvcXyU9K5LUr8LGIH6QR6XTafxABSTWeplZseTcvQ8ronFOgTvV3hNQeSgJnVKn6v/Jvu2NO7e3c5mp/vBunNSt2blGUHwC51sWl3mLd6JPdgF7o4l2wwiaRAutwDAMyH4eTY2NhiZu+NOB0lA3lsbKZeHP6LTvfzQA41BzXkbyyVSv9T6S9+Pj9R/bLRHg3hlHVM6NgIIYnMGnTfDMtrJvaqZ5aXFvldBRMToRf6Enu3DleUxxlvaCdLO/sakgWHKY3Uv3KD4yqYroxcWegbug+Nr1ESAdFUaolvF9lj5DlAcI6AJ7GZu2rZSys2Y+AxPwLg97H63rgBiAuFoUcLeIWwvAgeSZN0Ra06eDEwEhxhIxK4vh7ghD+JPToD5D2XrExJyUtAb8kPDFxTm5j46SYsGgkZIHopXumM5nII6YwZKkh0Si6eLvYNjTg0SzKXaGtFBGx2PupliDLAAUUowtQBMmRz12x5ojBPB0Qo+HUKck+aOTg2hnUcTduEUVvql/kbIYKvE6xryd+oRXBWyvCKTMPNTNMCQbPFfwF0xivlXzmFEWLI4XnrwDXF4ilPr1b3Tq0yWWmLFpjmuUG1Ovah3v7y/QLYy1p8EQ0tfopm9iAAD0rom9BUNc1gaxIiA0SqvxnAq7B+pmOauv9CPncyjY9dsRUjSWmgBx9G8GGSEJgaEMadcR1JqQ7BgBjOUKHLPMghbBcKTzYQKdAgweImLDgqlUrFWLqIZsMrnOXbjFEB0ENkvNLgIVoi0YnFTYukPbnurdspRgdkEvfNzDTOA7DWoqfNFgfebQvxWI4dHUkw2Ra2J9O2jdFYMli4CTDGiJBDmA5IemIrCWIApfkIH0cSybhhArNIYhaqI7d0FQdfBfL9Sh1mSZ4dxeFLcdNNrwn6hi4V9AAk1pX1TOlcZ6WBeK5RDbuCUYD5xTRF61iM0toUzy4UTnrN9PS+SWTVpu8aPM3jWBauiNhhqp926p502Qq5JAxCsJlxtauTbz1U15CRf5Kmh2kNn2wqf2H1UOU1dNWy8Rb39/efFLleR1hnC6FIomTkt6gRvAK4vr5N48Yqlf23dZfKLwrFK0H0Lk1qikmejNguQ7l8AcbGVksbjxixwsOb1ECc0EyLixWdIEt+0GLeX7Fqauk2ybU02bZGdSSJz92/pVDPrI3vv3ED1qK1EtnlCJ6GtKzsBtXhZtXnit8ka3bJG1HHoa42VoNWcttm+ZOzNc45zBKDevDmOOeDBjyjuQ7Fkp9DM8st1pBlJUnhbCP3FQCrVvdODQwM/FE9Di6n8THpTOAriEzrv3Mg97Sb+rlMWtq3KVdfgK96WhzHASxcVutvnb7r2AYBOJIdmLXMJ4MAB7mhTZGtSTTbfJOkM/D7rCe0WFtYxj8I6X1IKk67ANHwwmJx6LSpqdHPSvhU0/loqy8ymRKYvr6OKUJ712kjXxw8RCDh5wD+sVDAHDLcpSjM4fpIILhzFrigvXNpyECbGFMaGRmZ7a0Er4hdfyn4L9Jq7sSSY+nK8vNtD66eSIsA0N/fX2h4+AGaPaSFJAlAIPkCgefPzBwcwzaEOLdamQ5Vxq4C9LZUL3iLVcJh9uvFCH+21v0CmK3VfocfckiuNkfi1yJfcU5rtd80pwgDCAcIf2XA/PktyS/X9d1Y3OpZ9Zmltfpx+w4tZlUnuLDOY0dtF9ts+GZkeWbm4NhMZfSZIl4mYJZkuGRfOcy5ffVnX5JlbUDGODExsd/U9TS4/lLQ3iSfxrIxRCx3KTiSNm07c+uw3D7LZMLTsGRupj138iDh7OrSFkiS2oyhnT7idu2+WQIDAIyj4K/h/q10CykmbcANLwdAAz+jtf1fNox0b24/2wtyS/VNGoT9kl5njkfXKqMv2LfksJVZX+4KCJdNQs1jR0MMlawSteyeksfwaJPjigdw4NDM1OjFOca/KtdfQ9iXkHIGKaFpWgdWy6WhtRQoANUVPp3EY9KtqsWwVgHzBC+aroxdhe3PUJ1slQ2OXhJL/5a+S9zSiLHAPy+Udp+/2uo0hjf70lccqym7jbZ7y+KHljwbCeBWl18M1yOrlbFLKpWbq5ttFy5fXG3kmXf6WNdadpgsA97iA7NhqxsA1iZH3yH54yC9G/Jr01m82cbtZLn1cJNym19c31qZnhq9GIE/Gu7vgDSySEa5LBHfdvTHYX27zmKJyUbV4j19nWOnSYxLEBYW1kigyGgNGcaxIMvhFpSRzcwcHCsMDLzInV8iWEzMc3paoVx++1T3yJcK1aEbQdwLGwqTVLxWQTKBU2yveIK0+uZ+UFfQ9cHa9NjPWwZRFnV0F0IcMzIC6cq5uYxOA0l2Bu4emZktt3FrK+H6i9tDacLINxSLQx+BdK5TjxFwOsgyoALBXoAhloesNv0hDq0yoXhf3/Bvx9DrV4x7kgYp/ka1MvY+tEYibSPPAyDchAUMBC93j+5L2qloXeSQAdzfXiiUb5qeHrupzfhlSnw2tdLa6JJS8kiOWwCNifhSxPj9c5OT+9pM7JvBrtTidEenbzCAkPuutXzbCEsdOZOsuek2W6cFcX2TC8FmO3FmavxrAL7W399/UiPO/SboDwR5XwC7AfUL6CHYlSRwXLyBkYTTFzY7HJsEJXVkf1mhUL4M8Acp4IUQ7inyRAJdJDu3vY1JuFa/bhiGUSPGbAt52wQP3n6ZSGxiHqJz9XvIvcvC8FiQ4UW5WCmFW9kDS1ZUExPf6y2V30TaJZAio/V55BdgL96mEv7TyHu1eNqzvcLWhIBrCTxy2TcT4WLuBQpjLWc3y4YHch0E9CGEfnkqsEeibO4sUDsj8Go/HhiIrB4fbp7fwQynO8IjAGDG/IcF4UI5B0nVHbBAhjrDr69QrNvXznFwtRA/G0S3U3XAQgNr3rAfbOGeTTOpAUC1OnozgJsB/MPAwEC+YTasiGV37GYQl5I8YUtru0BgyOCbKycRACoWi6UY+n0CPYDGJHaSaEjMAfFeAH+DnY3YcwCcmThwQ75v4MUAL5FwAogIgNG9AeAUBHgKgDevWOHBAnzfI/8rEcOABghGEOIlxxbFSZkFOYhdBHdL6iXYQGqVEhAQbDhwgFBVQGzCQTdOMcb1ceQ/OnSoawpYtNxuOQhgYmJiNl8qXx7Lz6GzBipoOtuuMVWxrZ7cetVfCov+Jt1GXDM7OjrdRk84AASo/3Psuds8rbJtid/IXG18/NYtWrIXHXgnEzJ4eXKc3tldrpZy0p4oxp6AGKTQKSh0KAIsMBfqIb60ZbKc3nc6WdD+HMDHe3t7B9jRfQ+Psduo+0sKGLDL3csmM1F1grlFW0lrX6zSBw6H0QgpBpkT7btt2kqpTMzk80MvcfpZwGGBKa3bmFgxDrfqi8ZVPnXILBDoxESn+8hqMhFa8KXI/VJA/RBmSHZsSB7ZNmpQm/odpWRnRe5iCCoi0WW0/9wOhkcALJfL3XMR32Xgs5OX1hemK6OPzxcH/9ACe5+L1xO4XxsH3LSui99swHsFvrFJpiQc7Jgq3WsCP60BQKFQ/mOG9m5JjSQ5nWZAvzRE8E+Vysh1K97jrrpdZAC8UBp6GsmPpA5rIGlyfWF6avRxKwYCAWhgYCBfj+3LNHvg8pwXvHC6MnIltlLRNcN2odXcfcTXKhaH7g6oEAfBgiSzKG54YF0dbFQqlcptR/GdVCwOnRYZuy2IFzwOOknGoXtuIYjH5yYm9h/pTQYGBvILCwudZuZpfho1/z89PV0D0NiA4s+2nrdflo92Soujna02w1FGuMXzBABjY2MzhULh5bKuPWY83x3n9vXtPkXSzXKfoOHf4Ti1JfqASzZhSE4ngm+KUQVgOTER6bKUvOQARGaYSa2LOUmfE/xvZyrjVx/pKinDnZbIrbYq20nFvBP3XOksyE2cc9jnqUXnMMwe2SpvK+/E1Z5lg+3cbmXamolVadK/2gZICndQVoij27bt7rVy4agtyLJvU7+3WhmORJY3e994nXu2laEjaHdtUj/d0fANEs+jHc27oVD/8AiFw6anpyd7hrqexYb+3Yy/DI9ONot/GClsIPb9JC4hgze0hLE1HfJyBH7mHh1QwBmSZZcqJv5z6z0i46kBSCF+U63Q8zrs3TuPtWvEZLjr4mjLw9FYUW5EMd7RZGvTemOzBGwdZaY2k9HRaNM7+h5YT8Fjc07Nx4ss78Q4PZJn26x/0PEC3cF9tqUV62YnjHB2dHRE0jtAwo0XVCqVKslxkjG86z3u+nnq0AYmnug5l1cD4s8VcpDAyekzV+pBo+k01ujt332mOV7usf99rTL+Kuzdu4Alk2BGXjJk2JxCWCui4GgTzZ18liONyMmQIcNxgHAbrhEDMEXBFx1+AMBZSHKRTgN4mJWCD6OqGyUVBebg+h8JN5E82AhwWuB4tMAAzYSxbNZ7RGDSxSA6EfvfY3kJ8gyrr7KPVPETWeHLDBkyZMhwFyAwAoCZmYNj+b7yDRR2I8kvfCNoz/Hq3MNJniBoBlIoYhfJ0yTcyxxvTLNjRyQDxbhtrlKaACZU7C9fAOEJMfXUmdpifZeMvBydxTqzNsiQIUOGDHd2ArO48ifwIxhfCAByXmdJ5oa7Jd+xiCRPx6OAJF2Ulsr0BBIo6DLgpoVisdjn4lsIv3pmcuyT2Ll4+AwZMmTIkCHDXZjAAEnRjSkwTbK1VMmzWYU2+dHyzGKGpFiNSf7tmerYvwIIxNz7CdzN1LgA2xtOmiFDhgwZMmTICMwKBkP/DsV6b6n8cCI+CATtIg5sOelJHS+EtwKIisXBc2DBU2L3V01PTf0YWVbdOwKZxStDhgwZMhzT2C5nTQFArSv3NQEHCD6OQe4mbKCCKUkTcHUY+lW7+vtPlNmHXf79mamxv8X2FZW7K2FZtIVTqyZx6pjoiHF4dIZINbJmzJAhQ4YMdwUCk+DAI5L6FdJp1fGO612qYPVMiEkhOUGEv3tiYqIWIHwOyTMgvQZLDrsZgdk4dWlutwXpAQJdq/5+D4CkLkjzHAKgfN1S7hkyZMiQIcOdgsCkW0WfiAl8muTjisXZ+7rhqRJnsJSSvpnETkhqGoWQ/2S6Mv7p3oGBe5v4co/18trU+OeRbR1tpRNqEqYFTAGYkBRRbNYyOWxbaH5+Vw7CCKQFARUpOd+XigJm5DFDhgwZMhyT4HZfa2BgoLfhwXcJ5aqVsXsUCuXHIOBnyaVVvSQIqBL6Kt1eEsc2wzD6Asm7RYH/yqHx8WaBqYzAbAqndxYK1bupI2fWiOvz8jDnQXVm5uDYav3V3T2427q8L4hzc5KHYRjkJicP/hxAPWvPDBkyZMhwVyAwQGo1KRYHf0XGrwP81HRl9BnFYvkpMj5NwAFAVQg3xgr/91D1wA96i+Unm+E9gEVR6I89NDZ2DY5+3YUMGTJkyJAhw10cAQDk+8rPKPbvVr6v/NHmF8XBE87u6xt6cW+p/IjuvvJZhVL508XSsPJ9Q/+eHxg4o4UEZTgyUrry2M7fZ8iQIUOGDMfEZLcTMABBb1/5ksDspZKuAPyLgr2XYFFQhUCvpLrEl85UR9/fcl62bZQhQ4YMGTJkuEMIzOIWUL449DKY/tJo/ZJ/1YG/hmQET5EF35+ZPHh9Rl4yZMiQIUOGDMcSOTIAyPcPP7hYGnp3d3Hw7Da/M2TbFhkyZMiQIUOGY5DItCJISUuIzN8lQ4YMGTJkyHAMo2llySwtGTJkyJAhQ4YMGTJkyJAhQ4a7Hv4/mUlutf8b9PAAAAAASUVORK5CYII=\"></div>\n <header class=\"top\">\n  <select id=\"symSel\" aria-label=\"Symbol\"></select>\n  <div class=\"px\"><b id=\"px\">-</b><span id=\"chg\">-</span></div>\n  <span class=\"badge\" id=\"src\">Simulated</span>\n </header>\n <section class=\"view on\" id=\"v-chart\">\n  <div class=\"menu\" id=\"menu\">\n   <button data-m=\"draw\" id=\"mDraw\">Draw</button>\n   <button data-m=\"time\" id=\"mTime\">1h</button>\n   <button data-m=\"style\" id=\"mStyle\">Style</button>\n   <button id=\"lockBtn\" aria-pressed=\"false\">Unlocked</button>\n  </div>\n  <div class=\"strip\" id=\"favs\" hidden=\"\"></div>\n  <div class=\"panel\" id=\"panel\" hidden=\"\">\n   <div data-p=\"draw\" hidden=\"\"><div class=\"grid\" id=\"tools\"></div><div class=\"props\" id=\"props\"></div></div>\n   <div data-p=\"time\" hidden=\"\"><div class=\"grid\" id=\"tfs\"></div><div class=\"strip\" id=\"tgl\"></div></div>\n   <div data-p=\"style\" hidden=\"\" id=\"stylePane\"></div>\n   <div hidden=\"\" id=\"deltaPane\"></div>\n   \n  </div>\n  <div class=\"stage\"><canvas id=\"cv\"></canvas><button id=\"fold\" aria-label=\"Hide controls\" title=\"Hide controls\">▲</button><button id=\"autoBtn\" hidden=\"\">Auto</button><button id=\"indChip\" hidden=\"\">Indicators</button><div id=\"sbar\" hidden=\"\"><button id=\"sbEdit\">Edit</button><button id=\"sbDel\">Delete</button></div></div>\n </section>\n <section class=\"view\" id=\"v-watch\"><div class=\"scroll\"><div id=\"wl\"></div><div id=\"wlAdd\"><h2>Add a market</h2><div class=\"form\"><input id=\"cuIn\" placeholder=\"e.g. ETHUSDT (Binance) or xyz:MSFT / HYPE (Hyperliquid)\" aria-label=\"Market\"><button class=\"btn\" id=\"cuAdd\">Add</button></div><p style=\"color:var(--mute);font-size:12px\">Binance pairs end in USDT (ETHUSDT); anything else is looked up on Hyperliquid (xyz:MSFT, HYPE). Prices are real only when live data is reachable.</p></div></div></section>\n <section class=\"view\" id=\"v-script\"><div class=\"scroll\" id=\"indw\"></div><input type=\"file\" id=\"impFile\" accept=\".pine,.txt,.ps,text/plain\" hidden=\"\"></section>\n <section class=\"view\" id=\"v-alerts\"><div class=\"scroll\" id=\"alw\"></div>\n  <details id=\"bk\"><summary>Save and backup</summary>\n   <p>Settings, drawings, favourites, alerts and scripts are kept in your browser. To keep them inside a file instead:</p>\n   <div class=\"form\"><button class=\"btn\" id=\"bkPage\">Download page with my settings</button><button class=\"btn ghost\" id=\"bkExp\">Export settings file</button><button class=\"btn ghost\" id=\"bkImp\">Import settings file</button><input type=\"file\" id=\"bkFile\" accept=\".json,application/json\" hidden=\"\"></div>\n   <p>The first one saves a copy of this page with everything built in. Open that copy on any browser or device and it restores your setup.</p></details></section>\n <nav class=\"tabs\"><button data-go=\"chart\" class=\"on\">Chart</button><button data-go=\"watch\">Watchlist</button><button data-go=\"script\">Indicators</button><button data-go=\"alerts\">Trade</button></nav>\n</div>\n<div id=\"toast\" role=\"status\"></div>\n<script>\n/* capture pristine page source (for \"save page with my settings\") and apply embedded settings */\nconst ORIG=document.documentElement.outerHTML;\n(function(){try{const el=document.getElementById('tk-embed');if(!el)return;const d=JSON.parse(el.textContent);\n if(d&&d.data&&localStorage.getItem('tk.embedTs')!==String(d.ts)){for(const k in d.data)localStorage.setItem(k,d.data[k]);localStorage.setItem('tk.embedTs',String(d.ts))}}catch(e){}})();\nfunction tkSnapshot(){const o={};try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.indexOf('tk.')===0&&k!=='tk.embedTs')o[k]=localStorage.getItem(k)}}catch(e){}return{app:'tickline',ts:Date.now(),data:o}}\n/* PineX part 1: lexer + indentation-aware parser -> AST */\nconst PXP=(()=>{\nconst TYPES=new Set(['int','float','bool','string','color','line','label','box','table','linefill','array','matrix','map','series','simple','const']);\nconst OPS2=[':=','==','!=','<=','>=','=>','+=','-=','*=','/=','%='];\nfunction err(ln,m){throw new Error('Line '+ln+': '+m)}\nfunction lexLine(s,ln){\n const T=[];let i=0;const n=s.length;\n while(i<n){const ch=s[i];\n  if(ch===' '||ch==='\\t'){i++;continue}\n  const rest=s.slice(i,i+64);let m;\n  if((m=/^(\\d+\\.?\\d*|\\.\\d+)(e[+-]?\\d+)?/i.exec(rest))){T.push({t:'num',v:parseFloat(m[0])});i+=m[0].length;continue}\n  if(ch==='\"'||ch===\"'\"){let j=i+1,v='';while(j<n&&s[j]!==ch){if(s[j]==='\\\\'&&j+1<n){j++;v+=s[j]==='n'?'\\n':s[j]==='t'?'\\t':s[j]}else v+=s[j];j++}T.push({t:'str',v});i=j+1;continue}\n  if(ch==='#'&&(m=/^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})/.exec(rest))){T.push({t:'str',v:'#'+m[1],color:1});i+=m[0].length;continue}\n  if((m=/^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(rest))){T.push({t:'id',v:m[0]});i+=m[0].length;continue}\n  const two=s.substr(i,2);if(OPS2.includes(two)){T.push({t:'op',v:two});i+=2;continue}\n  if('()[],?:+-*/%<>='.includes(ch)){T.push({t:'op',v:ch});i++;continue}\n  err(ln,'unexpected character \"'+ch+'\"')}\n return T}\nfunction stripComment(s){let q=null;for(let i=0;i<s.length;i++){const c=s[i];if(q){if(c==='\\\\')i++;else if(c===q)q=null}else if(c==='\"'||c===\"'\")q=c;else if(c==='/'&&s[i+1]==='/')return s.slice(0,i)}return s}\nfunction logicalLines(src){\n const raw=src.replace(/\\r/g,'').split('\\n'),out=[];let buf='',ln0=0,indent=0,depth=0;\n for(let k=0;k<raw.length;k++){\n  const line=stripComment(raw[k]);\n  if(!buf){if(!line.trim())continue;ln0=k+1;indent=0;for(const c of line){if(c===' ')indent++;else if(c==='\\t')indent+=4;else break}}\n  buf+=' '+line;\n  let q=null;for(let i=0;i<line.length;i++){const c=line[i];if(q){if(c==='\\\\')i++;else if(c===q)q=null}else if(c==='\"'||c===\"'\")q=c;else if(c==='('||c==='[')depth++;else if(c===')'||c===']')depth--}\n  if(depth>0&&k<raw.length-1)continue;\n  depth=0;out.push({ln:ln0,indent,toks:lexLine(buf.trim(),ln0)});buf=''}\n return out}\nfunction parse(src){\n const L=logicalLines(src);let pos=0;\n function exprFrom(toks,ln){\n  let p=0;\n  const pk=()=>toks[p],isOp=v=>toks[p]&&toks[p].t==='op'&&toks[p].v===v,isId=v=>toks[p]&&toks[p].t==='id'&&toks[p].v===v;\n  const ex=v=>{if(!isOp(v))err(ln,'expected \"'+v+'\"'+(toks[p]?' but found \"'+toks[p].v+'\"':' at end of line'));p++};\n  function tern(){const c=orr();if(isOp('?')){p++;const a=tern();ex(':');const b=tern();return{t:'tern',c,a,b}}return c}\n  const orr=()=>{let a=andd();while(isId('or')){p++;a={t:'bin',op:'||',a,b:andd()}}return a};\n  const andd=()=>{let a=eq();while(isId('and')){p++;a={t:'bin',op:'&&',a,b:eq()}}return a};\n  const eq=()=>{let a=cmp();while(isOp('==')||isOp('!=')){const op=toks[p++].v;a={t:'bin',op,a,b:cmp()}}return a};\n  const cmp=()=>{let a=add();while(isOp('<')||isOp('>')||isOp('<=')||isOp('>=')){const op=toks[p++].v;a={t:'bin',op,a,b:add()}}return a};\n  const add=()=>{let a=mul();while(isOp('+')||isOp('-')){const op=toks[p++].v;a={t:'bin',op,a,b:mul()}}return a};\n  const mul=()=>{let a=un();while(isOp('*')||isOp('/')||isOp('%')){const op=toks[p++].v;a={t:'bin',op,a,b:un()}}return a};\n  function un(){if(isOp('-')){p++;return{t:'un',op:'-',e:un()}}if(isOp('+')){p++;return un()}if(isId('not')){p++;return{t:'un',op:'!',e:un()}}return post()}\n  function post(){let e=prim();while(isOp('[')){p++;const i=tern();ex(']');e={t:'idx',e,i}}return e}\n  function prim(){\n   const t=toks[p++];if(!t)err(ln,'unexpected end of line');\n   if(t.t==='num')return{t:'num',v:t.v};\n   if(t.t==='str')return{t:'str',v:t.v};\n   if(t.t==='op'&&t.v==='('){const e=tern();ex(')');return e}\n   if(t.t==='op'&&t.v==='['){const items=[];while(!isOp(']')){items.push(tern());if(isOp(','))p++;else break}ex(']');return{t:'arr',items}}\n   if(t.t==='id'){\n    if(t.v==='true'||t.v==='false')return{t:'bool',v:t.v==='true'};\n    if(t.v==='na'&&!isOp('('))return{t:'na'};\n    if(isOp('(')){p++;const args=[];\n     while(!isOp(')')){let name=null;if(toks[p]&&toks[p].t==='id'&&toks[p+1]&&toks[p+1].t==='op'&&toks[p+1].v==='='){name=toks[p].v;p+=2}args.push({name,e:tern()});if(isOp(','))p++;else break}\n     ex(')');return{t:'call',f:t.v,args}}\n    return{t:'id',n:t.v}}\n   err(ln,'unexpected \"'+t.v+'\"')}\n  const e=tern();if(p<toks.length)err(ln,'unexpected \"'+toks[p].v+'\"');return e}\n function block(indent){\n  const out=[];\n  while(pos<L.length){const l=L[pos];\n   if(l.indent<indent)break;\n   if(l.indent>indent)err(l.ln,'unexpected indentation');\n   out.push(stmt())}\n  return out}\n function body(parentIndent,ln){\n  if(pos>=L.length||L[pos].indent<=parentIndent)err(ln,'expected an indented block');\n  return block(L[pos].indent)}\n function ifNode(toks,ln,indent,isExpr){\n  const cond=exprFrom(toks.slice(1),ln),then=body(indent,ln);let els=null;\n  if(pos<L.length&&L[pos].indent===indent&&L[pos].toks[0].t==='id'&&L[pos].toks[0].v==='else'){\n   const nl=L[pos++],nt=nl.toks;\n   if(nt[1]&&nt[1].t==='id'&&nt[1].v==='if'){els=[ifNode(nt.slice(1),nl.ln,indent,isExpr)]}\n   else els=body(indent,nl.ln)}\n  return{t:'if',cond,then,else:els,expr:isExpr,ln}}\n function splitCommas(toks){const out=[];let d=0,cur=[];for(const t of toks){if(t.t==='op'&&(t.v==='('||t.v==='['))d++;if(t.t==='op'&&(t.v===')'||t.v===']'))d--;if(d===0&&t.t==='op'&&t.v===','){out.push(cur);cur=[]}else cur.push(t)}if(cur.length)out.push(cur);return out}\n function stmt(){\n  const l=L[pos++],toks=l.toks,ln=l.ln,t0=toks[0];\n  if(t0.t==='id'){\n   if(t0.v==='if')return ifNode(toks,ln,l.indent,false);\n   if(t0.v==='for'){\n    if(toks[1]&&toks[1].t==='id'&&toks[2]&&toks[2].t==='op'&&toks[2].v==='='){\n     const ti=toks.findIndex((x,i)=>i>2&&x.t==='id'&&x.v==='to');if(ti<0)err(ln,'for loop needs \"to\"');\n     const bi=toks.findIndex((x,i)=>i>ti&&x.t==='id'&&x.v==='by');\n     return{t:'for',v:toks[1].v,from:exprFrom(toks.slice(3,ti),ln),to:exprFrom(toks.slice(ti+1,bi<0?toks.length:bi),ln),by:bi<0?null:exprFrom(toks.slice(bi+1),ln),body:body(l.indent,ln),ln}}\n    const ii=toks.findIndex((x,i)=>i>0&&x.t==='id'&&x.v==='in');if(ii>0){const names=toks.slice(1,ii).filter(x=>x.t==='id').map(x=>x.v);return{t:'forin',names,e:exprFrom(toks.slice(ii+1),ln),body:body(l.indent,ln),ln}}\n    err(ln,'unsupported for loop')}\n   if(t0.v==='while')return{t:'while',cond:exprFrom(toks.slice(1),ln),body:body(l.indent,ln),ln};\n   if(t0.v==='break')return{t:'break'};\n   if(t0.v==='continue')return{t:'continue'};\n   if(t0.v==='switch')err(ln,'\"switch\" isn\\'t supported yet. Use if / else if.');\n   if(t0.v==='import'||t0.v==='export')return{t:'nop'};\n   if(toks[1]&&toks[1].t==='op'&&toks[1].v==='('){\n    const ai=toks.findIndex(x=>x.t==='op'&&x.v==='=>');\n    if(ai>0){\n     let d=0,ci=-1;for(let i=1;i<toks.length;i++){if(toks[i].t==='op'&&toks[i].v==='(')d++;if(toks[i].t==='op'&&toks[i].v===')'){d--;if(d===0){ci=i;break}}}\n     if(ci>0&&ci+1===ai){\n      const params=splitCommas(toks.slice(2,ci)).map(p=>{const eq=p.findIndex(x=>x.t==='op'&&x.v==='=');const q=eq<0?p:p.slice(0,eq);return q[q.length-1].v});\n      let bodyN;if(ai+1<toks.length)bodyN=[{t:'expr',e:exprFrom(toks.slice(ai+1),ln),ln}];else bodyN=body(l.indent,ln);\n      return{t:'fn',name:t0.v,params,body:bodyN,ln}}}}}\n  if(t0.t==='op'&&t0.v==='['){\n   const ci=toks.findIndex(x=>x.t==='op'&&x.v===']');\n   if(ci>0&&toks[ci+1]&&toks[ci+1].v==='='){const names=toks.slice(1,ci).filter(x=>x.t==='id').map(x=>x.v);return{t:'tuple',names,e:exprFrom(toks.slice(ci+2),ln),ln}}}\n  let i=0,isVar=false,vtype=null;\n  if(toks[i].t==='id'&&(toks[i].v==='var'||toks[i].v==='varip')){isVar=true;i++}\n  while(toks[i]&&toks[i].t==='id'&&TYPES.has(toks[i].v)&&toks[i+1]&&(toks[i+1].t==='id'||(toks[i+1].t==='op'&&toks[i+1].v==='<'))){\n   vtype=toks[i].v;i++;\n   if(toks[i]&&toks[i].t==='op'&&toks[i].v==='<'){let d=0;while(toks[i]){if(toks[i].v==='<')d++;if(toks[i].v==='>'){d--;if(d===0){i++;break}}i++}}}\n  if(toks[i]&&toks[i].t==='id'&&toks[i+1]&&toks[i+1].t==='op'&&['=',':=','+=','-=','*=','/=','%='].includes(toks[i+1].v)){\n   const name=toks[i].v,op=toks[i+1].v,rhs=toks.slice(i+2);\n   let e;\n   if(rhs[0]&&rhs[0].t==='id'&&rhs[0].v==='if'&&rhs.length>1){e={t:'ifexpr',node:ifNode(rhs,ln,l.indent,true)}}\n   else e=exprFrom(rhs,ln);\n   if(op==='='||isVar||vtype)return{t:'decl',name,isVar,vtype,op,e,ln};\n   return{t:'assign',name,op,e,ln}}\n  if(isVar||vtype)err(ln,'cannot read this declaration');\n  return{t:'expr',e:exprFrom(toks,ln),ln}}\n const prog=block(L.length?L[0].indent:0);\n if(pos<L.length)err(L[pos].ln,'unexpected indentation');\n return prog}\nreturn{parse}})();\n/* PineX part 2: AST -> JavaScript source */\nconst PXG=(()=>{\nconst BUILTIN=new Set(['open','high','low','close','volume','time','time_close','bar_index','hl2','hlc3','ohlc4','hlcc4','last_bar_index']);\nfunction gen(ast){\n let site=0,tmp=0,fnNames=new Set(),globals=new Set(),scopes=[],intVars=new Set(),curLn=0;\n const q=s=>JSON.stringify(s);\n function err(m){throw new Error('Line '+curLn+': '+m)}\n // collect hoisted names\n ast.forEach(s=>{if(s.t==='decl')globals.add(s.name);if(s.t==='tuple')s.names.forEach(n=>globals.add(n));if(s.t==='fn')fnNames.add(s.name)});\n const known=n=>globals.has(n)||scopes.some(sc=>sc.has(n));\n function resolve(n){\n  if(n.includes('.'))return '$K['+q(n)+']';\n  if(known(n))return 'v_'+n;\n  if(BUILTIN.has(n))return n==='bar_index'?'bar':n==='last_bar_index'?'($N-1)':'$b.'+n+'[bar]';\n  err('Undeclared identifier \"'+n+'\"')}\n function args(a){return a.map(x=>ex(x.e))}\n function named(a){const n=a.filter(x=>x.name);return n.length?'{'+n.map(x=>q(x.name)+':'+ex(x.e)).join(',')+'}':'{}'}\n function pos(a){return '['+a.filter(x=>!x.name).map(x=>ex(x.e)).join(',')+']'}\n function ex(n){\n  switch(n.t){\n   case 'num':return String(n.v);\n   case 'str':return q(n.v);\n   case 'bool':return n.v?'true':'false';\n   case 'na':return 'NaN';\n   case 'id':return resolve(n.n);\n   case 'un':return '('+n.op+ex(n.e)+')';\n   case 'bin':{const op=n.op==='=='?'===':n.op==='!='?'!==':n.op;return '('+ex(n.a)+op+ex(n.b)+')'}\n   case 'tern':return '('+ex(n.c)+'?'+ex(n.a)+':'+ex(n.b)+')';\n   case 'arr':return '['+n.items.map(ex).join(',')+']';\n   case 'ifexpr':return '(()=>{'+ifGen(n.node,true)+'return NaN})()';\n   case 'idx':{\n    const e=n.e,i=ex(n.i);\n    if(e.t==='id'&&BUILTIN.has(e.n)&&!known(e.n)){if(e.n==='bar_index')return '(bar-('+i+'))';return '$bh($b.'+e.n+',bar,'+i+')'}\n    if(e.t==='id'&&globals.has(e.n)&&!scopes.some(sc=>sc.has(e.n)))return '$hv(h_'+e.n+',bar,'+i+',v_'+e.n+')';\n    return '$hx('+(site++)+','+ex(e)+','+i+')'}\n   case 'call':return call(n)}\n  err('cannot compile expression')}\n function call(n){\n  const f=n.f;\n  if(fnNames.has(f))return 'f_'+f+'('+args(n.args).join(',')+')';\n  if(f.startsWith('ta.'))return '$T('+q(f)+','+(site++)+',['+args(n.args).join(',')+'])';\n  return '$C('+q(f)+','+pos(n.args)+','+named(n.args)+','+(site++)+')'}\n function declare(name){if(scopes.length)scopes[scopes.length-1].add(name)}\n function cast(vt,code,name){if(vt==='int'||(!vt&&intVars.has(name)))return '$int('+code+')';return code}\n function block(stmts,top){return stmts.map(s=>st(s,top)).join('')}\n function blockValue(stmts){\n  if(!stmts.length)return 'return NaN;';\n  const last=stmts[stmts.length-1];let out=block(stmts.slice(0,-1),false);\n  curLn=last.ln||curLn;\n  if(last.t==='expr')return out+'$ln='+curLn+';return '+ex(last.e)+';';\n  if(last.t==='if'){return out+ifGen(last,true)+'return NaN;'}\n  out+=st(last,false);\n  if(last.t==='decl'||last.t==='assign')out+='return v_'+last.name+';';\n  else out+='return NaN;';\n  return out}\n function ifGen(n,asExpr){\n  curLn=n.ln;\n  const f=b=>asExpr?blockValue(b):block(b,false);\n  scopes.push(new Set());const c='$ln='+n.ln+';';const cond=ex(n.cond);\n  scopes.pop();\n  scopes.push(new Set());let t=f(n.then);scopes.pop();\n  let out=c+'if('+cond+'){'+t+'}';\n  if(n.else){\n   if(n.else.length===1&&n.else[0].t==='if')out+='else{'+ifGen(n.else[0],asExpr)+'}';\n   else{scopes.push(new Set());out+='else{'+f(n.else)+'}';scopes.pop()}}\n  return out}\n function st(s,top){\n  if(s.ln)curLn=s.ln;\n  const ln=s.ln?'$ln='+s.ln+';':'';\n  switch(s.t){\n   case 'nop':return '';\n   case 'decl':{\n    if(s.vtype==='int')intVars.add(s.name);\n    const code=cast(s.vtype,ex(s.e),s.name);\n    if(top){\n     if(s.isVar)return ln+'if(bar===0){v_'+s.name+'='+code+'}';\n     return ln+'v_'+s.name+'='+code+';'}\n    declare(s.name);\n    const body='let v_'+s.name+'='+(s.op==='='?code:'v_'+s.name)+';';\n    return ln+body}\n   case 'assign':{\n    if(!known(s.name))err('Undeclared identifier \"'+s.name+'\"');\n    const code=cast(null,ex(s.e),s.name),op=s.op;\n    return ln+'v_'+s.name+(op===':='?'=':op)+code+';'}\n   case 'tuple':{\n    const names=s.names.map(n=>'v_'+n).join(',');\n    if(top)return ln+'['+names+']='+ex(s.e)+';';\n    s.names.forEach(declare);return ln+'let ['+names+']='+ex(s.e)+';'}\n   case 'expr':return ln+ex(s.e)+';';\n   case 'if':return ifGen(s,false);\n   case 'for':{\n    const k=tmp++;scopes.push(new Set([s.v]));\n    const from=ex(s.from),to=ex(s.to),by=s.by?ex(s.by):'1';\n    const b=block(s.body,false);scopes.pop();\n    return ln+'for(let v_'+s.v+'='+from+',$e'+k+'='+to+',$s'+k+'=(v_'+s.v+'<=$e'+k+'?1:-1)*Math.abs('+by+');$s'+k+'>0?v_'+s.v+'<=$e'+k+':v_'+s.v+'>=$e'+k+';v_'+s.v+'+=$s'+k+'){'+b+'}'}\n   case 'forin':{\n    scopes.push(new Set(s.names));const b=block(s.body,false);scopes.pop();\n    return ln+'for(const v_'+s.names[s.names.length-1]+' of '+ex(s.e)+'){'+b+'}'}\n   case 'while':{\n    scopes.push(new Set());const b=block(s.body,false);scopes.pop();const k=tmp++;\n    return ln+'for(let $w'+k+'=0;'+ex(s.cond)+';){if(++$w'+k+'>200000)throw new Error(\"loop ran too long\");'+b+'}'}\n   case 'break':return 'break;';\n   case 'continue':return 'continue;';\n   case 'fn':return '';\n  }\n  err('unsupported statement')}\n // function declarations (hoisted)\n let fns='';\n ast.forEach(s=>{if(s.t==='fn'){\n  curLn=s.ln;scopes.push(new Set(s.params));\n  fns+='function f_'+s.name+'('+s.params.map(p=>'v_'+p).join(',')+'){'+blockValue(s.body)+'}\\n';\n  scopes.pop()}});\n const topBody=ast.filter(s=>s.t!=='fn').map(s=>st(s,true)).join('\\n');\n const names=[...globals];\n return '\"use strict\";\\nlet $ln=0,bar=0;\\n'+(names.length?'let '+names.map(n=>'v_'+n).join(',')+';\\nconst '+names.map(n=>'h_'+n+'=[]').join(',')+';\\n':'')+fns+\n  'for(bar=0;bar<$N;bar++){\\n$rt.bar=bar;\\n'+topBody+'\\n'+names.map(n=>'h_'+n+'[bar]=v_'+n+';').join('')+'\\n}\\nreturn 0;'}\nreturn{gen}})();\n/* PineX part 3a: colors, constants and stateful ta.* functions */\nconst PXT=(()=>{\nconst NAMED={aqua:'#00BCD4',black:'#363A45',blue:'#2962FF',fuchsia:'#E040FB',gray:'#787B86',green:'#089981',lime:'#00E676',maroon:'#801922',navy:'#1848CC',olive:'#808000',orange:'#FF9800',purple:'#9C27B0',red:'#F23645',silver:'#B2B5BE',teal:'#00897B',white:'#FFFFFF',yellow:'#FDD835'};\nfunction parseCol(c){\n if(typeof c!=='string')return null;\n if(c[0]==='#'){let h=c.slice(1);if(h.length===3)h=h.replace(/./g,'$&$&');return{r:parseInt(h.slice(0,2),16),g:parseInt(h.slice(2,4),16),b:parseInt(h.slice(4,6),16),a:h.length>=8?parseInt(h.slice(6,8),16)/255:1}}\n const m=/rgba?\\(([^)]+)\\)/.exec(c);if(!m)return null;const q=m[1].split(',').map(Number);return{r:q[0],g:q[1],b:q[2],a:q.length>3?q[3]:1}}\nfunction rgba(c,t){const p=parseCol(c);if(!p)return NaN;return 'rgba('+p.r+','+p.g+','+p.b+','+(+(p.a*(1-(t||0)/100)).toFixed(3))+')'}\nfunction toHex(c){const p=parseCol(c);if(!p)return '#888888';const h=n=>('0'+Math.round(n).toString(16)).slice(-2);return '#'+h(p.r)+h(p.g)+h(p.b)}\nconst NSPAT=/^(shape|location|size|display|format|plot|hline|line|extend|xloc|yloc|position|text|label|scale|barmerge|order|currency|alert|adjustment|session|dayofweek|math|font|banner)\\./;\nfunction makeK(env,rt,b,N){\n const base={'math.pi':Math.PI,'math.e':Math.E,'syminfo.mintick':env.mintick,'syminfo.type':env.symType||'crypto','syminfo.ticker':env.ticker||'','syminfo.tickerid':env.ticker||'','timeframe.period':env.tfLabel||'','chart.fg_color':env.fg,'chart.bg_color':env.bg,'format.volume':'volume','format.price':'price','format.mintick':'mintick','format.percent':'percent'};\n for(const k in NAMED)base['color.'+k]=NAMED[k];\n const dyn={'barstate.islast':()=>rt.bar===N-1,'barstate.isconfirmed':()=>rt.bar<N-1,'barstate.ishistory':()=>rt.bar<N-1,'barstate.isrealtime':()=>rt.bar===N-1,'barstate.isfirst':()=>rt.bar===0,'barstate.islastconfirmedhistory':()=>rt.bar===N-2,'barstate.isnew':()=>true,\n  'ta.tr':()=>{const i=rt.bar;return i===0?b.high[0]-b.low[0]:Math.max(b.high[i]-b.low[i],Math.abs(b.high[i]-b.close[i-1]),Math.abs(b.low[i]-b.close[i-1]))}};\n return new Proxy(base,{get(t,p){\n  if(typeof p!=='string')return undefined;\n  if(p in dyn)return dyn[p]();\n  if(p in t)return t[p];\n  if(NSPAT.test(p))return p.slice(p.indexOf('.')+1);\n  throw new Error('Unknown name \"'+p+'\"')}})}\nfunction mkTA(rt,b,N){\n const isn=v=>v!==v||v===undefined||v===null;\n const win=(st,v,len)=>{(st.buf||(st.buf=[])).push(v);if(st.buf.length>len)st.buf.shift();return st.buf.length>=len};\n function sma(st,v,len){if(!win(st,v,len))return NaN;let s=0;for(let i=0;i<st.buf.length;i++){if(st.buf[i]!==st.buf[i])return NaN;s+=st.buf[i]}return s/len}\n function ema(st,v,len){const a=2/(len+1);if(v!==v){st.v=NaN;return NaN}st.v=isn(st.v)?v:a*v+(1-a)*st.v;return st.v}\n function rma(st,v,len){\n  if(isn(st.v)){const m=sma(st,v,len);st.v=m;return m}\n  if(v!==v){st.v=NaN;return NaN}\n  st.v=(v+(len-1)*st.v)/len;return st.v}\n const sub=(st,k)=>st[k]||(st[k]={});\n const T={\n  'ta.sma':(st,a)=>sma(st,a[0],a[1]),\n  'ta.ema':(st,a)=>ema(st,a[0],a[1]),\n  'ta.rma':(st,a)=>rma(st,a[0],a[1]),\n  'ta.wma':(st,a)=>{if(!win(st,a[0],a[1]))return NaN;let t=0,d=0;st.buf.forEach((v,i)=>{t+=v*(i+1);d+=i+1});return t/d},\n  'ta.stdev':(st,a)=>{if(!win(st,a[0],a[1]))return NaN;const m=st.buf.reduce((x,y)=>x+y,0)/a[1];return Math.sqrt(st.buf.reduce((x,y)=>x+(y-m)*(y-m),0)/a[1])},\n  'ta.highest':(st,a)=>{const v=a.length>1?a[0]:b.high[rt.bar],l=a.length>1?a[1]:a[0];if(!win(st,v,l))return NaN;return Math.max(...st.buf)},\n  'ta.lowest':(st,a)=>{const v=a.length>1?a[0]:b.low[rt.bar],l=a.length>1?a[1]:a[0];if(!win(st,v,l))return NaN;return Math.min(...st.buf)},\n  'ta.change':(st,a)=>{const l=a.length>1?a[1]:1;(st.buf||(st.buf=[])).push(a[0]);const r=st.buf.length>l?a[0]-st.buf[st.buf.length-1-l]:NaN;if(st.buf.length>l+1)st.buf.shift();return r},\n  'ta.mom':(st,a)=>T['ta.change'](st,a),\n  'ta.cum':(st,a)=>{st.v=(st.v||0)+(a[0]===a[0]?a[0]:0);return st.v},\n  'ta.crossover':(st,a)=>{const r=st.pa!==undefined&&a[0]>a[1]&&st.pa<=st.pb;st.pa=a[0];st.pb=a[1];return r},\n  'ta.crossunder':(st,a)=>{const r=st.pa!==undefined&&a[0]<a[1]&&st.pa>=st.pb;st.pa=a[0];st.pb=a[1];return r},\n  'ta.barssince':(st,a)=>{if(a[0])st.last=rt.bar;return st.last===undefined?NaN:rt.bar-st.last},\n  'ta.valuewhen':(st,a)=>{const l=st.l||(st.l=[]);if(a[0])l.push(a[1]);const k=l.length-1-(a[2]||0);return k>=0?l[k]:NaN},\n  'ta.tr':()=>{const i=rt.bar;return i===0?b.high[0]-b.low[0]:Math.max(b.high[i]-b.low[i],Math.abs(b.high[i]-b.close[i-1]),Math.abs(b.low[i]-b.close[i-1]))},\n  'ta.atr':(st,a)=>rma(st,T['ta.tr'](),a[0]),\n  'ta.rsi':(st,a)=>{const l=a[1];if(st.p===undefined){st.p=a[0];return NaN}const ch=a[0]-st.p;st.p=a[0];\n   const u=rma(sub(st,'u'),Math.max(ch,0),l),d=rma(sub(st,'d'),Math.max(-ch,0),l);return d===0?100:100-100/(1+u/d)},\n  'ta.vwap':(st)=>{const i=rt.bar,day=Math.floor(b.time[i]/864e5);if(st.day!==day){st.day=day;st.pv=0;st.vv=0}const p=b.hlc3[i];st.pv+=p*b.volume[i];st.vv+=b.volume[i];return st.vv?st.pv/st.vv:NaN},\n  'ta.macd':(st,a)=>{const f=ema(sub(st,'f'),a[0],a[1]),s=ema(sub(st,'s'),a[0],a[2]),m=f-s,sg=ema(sub(st,'g'),m,a[3]);return[m,sg,m-sg]},\n  'ta.bb':(st,a)=>{const l=a[1],bs=sma(sub(st,'m'),a[0],l),sd=T['ta.stdev'](sub(st,'d'),[a[0],l]);return[bs,bs+a[2]*sd,bs-a[2]*sd]}\n };\n return T}\nreturn{rgba,toHex,makeK,mkTA,NAMED}})();\n/* PineX part 3b: runtime + PineX.run */\nconst PineX=(()=>{\nconst cache=new Map();\nconst isn=v=>v!==v||v===undefined||v===null;\nfunction compile(src){\n if(cache.has(src))return cache.get(src);\n const ast=PXP.parse(src),js=PXG.gen(ast);\n const fn=new Function('$rt','$b','$N','$K','$C','$T','$bh','$hv','$hx','$int',js);\n if(cache.size>8)cache.clear();cache.set(src,fn);return fn}\nfunction run(src,bars,ctx){\n ctx=ctx||{};const N=bars.length,ov=ctx.inputs||{};\n const b={open:bars.map(x=>x.o),high:bars.map(x=>x.h),low:bars.map(x=>x.l),close:bars.map(x=>x.c),volume:bars.map(x=>x.v),time:bars.map(x=>x.t)};\n b.hl2=bars.map(x=>(x.h+x.l)/2);b.hlc3=bars.map(x=>(x.h+x.l+x.c)/3);b.ohlc4=bars.map(x=>(x.o+x.h+x.l+x.c)/4);b.hlcc4=bars.map(x=>(x.h+x.l+2*x.c)/4);\n const tfMs=N>1?bars[1].t-bars[0].t:3600e3;b.time_close=bars.map(x=>x.t+tfMs);\n const mt=ctx.mintick||0.01;\n const rt={bar:0};\n const out={title:'Script',overlay:false,plots:[],shapes:[],hlines:[],alerts:[],pane:true,boxes:[],lines:[],labels:[],tables:[],barcolor:null,inputs:[]};\n const env={mintick:mt,tfLabel:ctx.tfLabel,ticker:ctx.ticker,fg:ctx.fg||'#d9dfe7',bg:ctx.bg||'#0d1014'};\n const K=PXT.makeK(env,rt,b,N),TA=PXT.mkTA(rt,b,N);\n const states={},plotMap={},hxs={};\n const $T=(name,site,a)=>{const f=TA[name];if(!f)throw new Error('Unsupported function '+name);return f(states[site]||(states[site]={}),a)};\n const $bh=(arr,bar,i)=>{const v=arr[bar-i];return v===undefined?NaN:v};\n const $hv=(h,bar,i,cur)=>{if(i===0)return cur;const v=h[bar-i];return v===undefined?NaN:v};\n const $hx=(site,val,i)=>{const h=hxs[site]||(hxs[site]=[]);h[rt.bar]=val;const v=h[rt.bar-i];return v===undefined?NaN:v};\n const $int=v=>v!==v?v:Math.trunc(v);\n const rnd=(v,d)=>{const m=Math.pow(10,d||0);return Math.round(v*m)/m};\n const rtm=v=>Math.round(v/mt)*mt;\n const nz=(v,r)=>isn(v)?(r===undefined?0:r):v;\n const ca=(v,def)=>v===undefined?def:v;\n let boxN=0;\n const keep=(list,o,max)=>{list.push(o);return o};\n const seen={};\n function inp(kind,pos,nm,site){\n  const title=nm.title||pos[1]||('input'+site);const key=title;\n  const def=pos[0];\n  if(!seen[key]){seen[key]=1;out.inputs.push({key,title:String(title),kind,def,group:nm.group||'',options:nm.options,min:nm.minval,max:nm.maxval,step:nm.step,tip:nm.tooltip||''})}\n  let v=ov[key];if(v===undefined)return def;\n  if(kind==='int')v=Math.trunc(+v);else if(kind==='float')v=+v;else if(kind==='bool')v=!!v;\n  if((kind==='int'||kind==='float')&&v===v){if(nm.minval!==undefined&&v<nm.minval)v=nm.minval;if(nm.maxval!==undefined&&v>nm.maxval)v=nm.maxval}\n  return v}\n const MATH={abs:Math.abs,max:Math.max,min:Math.min,sqrt:Math.sqrt,log:Math.log,log10:Math.log10,pow:Math.pow,exp:Math.exp,floor:Math.floor,ceil:Math.ceil,sign:Math.sign,sin:Math.sin,cos:Math.cos,tan:Math.tan,round:(v,d)=>d?rnd(v,d):Math.round(v),avg:(...a)=>a.reduce((x,y)=>x+y,0)/a.length,sum:(...a)=>a.reduce((x,y)=>x+y,0),round_to_mintick:rtm,todegrees:v=>v*180/Math.PI,toradians:v=>v*Math.PI/180,random:()=>Math.random()};\n const fmtStr=(v,f)=>{if(typeof v==='string')return v;if(isn(v))return 'NaN';if(f==='volume'){const a=Math.abs(v),s=v<0?'-':'';if(a>=1e9)return s+rnd(a/1e9,2)+'B';if(a>=1e6)return s+rnd(a/1e6,2)+'M';if(a>=1e3)return s+rnd(a/1e3,2)+'K';return s+rnd(a,2)}\n  if(f==='mintick'||f==='price'){const d=Math.max(0,Math.round(-Math.log10(mt)));return v.toFixed(d)}\n  if(typeof f==='string'&&/^#/.test(f)){const d=(f.split('.')[1]||'').length;return v.toFixed(d)}\n  return String(+v.toFixed(10))};\n const A=a=>{if(!Array.isArray(a))throw new Error('Expected an array');return a};\n const pct=(a,p)=>{const s=A(a).filter(x=>x===x).sort((x,y)=>x-y);if(!s.length)return NaN;const r=Math.max(1,Math.ceil(p/100*s.length));return s[r-1]};\n const AR={\n  new_float:(n,v)=>new Array(n||0).fill(ca(v,NaN)),new_int:(n,v)=>new Array(n||0).fill(ca(v,0)),new_bool:(n,v)=>new Array(n||0).fill(!!v),new_string:(n,v)=>new Array(n||0).fill(ca(v,'')),\n  new_box:(n,v)=>new Array(n||0).fill(ca(v,null)),new_line:(n,v)=>new Array(n||0).fill(ca(v,null)),new_label:(n,v)=>new Array(n||0).fill(ca(v,null)),new_color:(n,v)=>new Array(n||0).fill(ca(v,null)),\n  size:a=>A(a).length,get:(a,i)=>{A(a);if(i<0||i>=a.length)throw new Error('array.get index '+i+' out of bounds (size '+a.length+')');return a[i]},\n  set:(a,i,v)=>{A(a)[i]=v;return NaN},push:(a,v)=>{A(a).push(v);return NaN},pop:a=>A(a).pop(),shift:a=>A(a).shift(),unshift:(a,v)=>{A(a).unshift(v);return NaN},\n  clear:a=>{A(a).length=0;return NaN},insert:(a,i,v)=>{A(a).splice(i,0,v);return NaN},remove:(a,i)=>A(a).splice(i,1)[0],\n  first:a=>A(a)[0],last:a=>A(a)[A(a).length-1],\n  max:a=>{const f=A(a).filter(x=>x===x);return f.length?Math.max(...f):NaN},min:a=>{const f=A(a).filter(x=>x===x);return f.length?Math.min(...f):NaN},\n  sum:a=>A(a).reduce((x,y)=>x+(y===y?y:0),0),avg:a=>{const f=A(a).filter(x=>x===x);return f.length?f.reduce((x,y)=>x+y,0)/f.length:NaN},\n  indexof:(a,v)=>A(a).indexOf(v),lastindexof:(a,v)=>A(a).lastIndexOf(v),includes:(a,v)=>A(a).includes(v),\n  concat:(a,c)=>{A(a).push(...A(c));return a},copy:a=>A(a).slice(),slice:(a,s,e)=>A(a).slice(s,e),reverse:a=>{A(a).reverse();return NaN},sort:(a,o)=>{A(a).sort((x,y)=>o==='descending'?y-x:x-y);return NaN},\n  percentile_nearest_rank:pct,median:a=>pct(a,50)};\n const mkTmpl=(kind,o)=>Object.assign({k:kind,deleted:false},o);\n const BX={new:(p,n)=>{const o=mkTmpl('box',{left:ca(n.left,p[0]),top:ca(n.top,p[1]),right:ca(n.right,p[2]),bottom:ca(n.bottom,p[3]),border_color:ca(n.border_color,p[4]),border_width:ca(n.border_width,1),bgcolor:n.bgcolor,text:n.text||'',text_color:n.text_color,text_size:n.text_size,text_halign:n.text_halign,xloc:n.xloc});out.boxes.push(o);return o},\n  delete:o=>{if(o)o.deleted=true;return NaN}};\n for(const f of['left','top','right','bottom'])BX['get_'+f]=o=>o?o[f]:NaN;\n for(const f of['left','top','right','bottom','bgcolor','border_color','text','text_color','border_width'])BX['set_'+f]=(o,v)=>{if(o)o[f]=v;return NaN};\n const LN={new:(p,n)=>{const o=mkTmpl('line',{x1:ca(n.x1,p[0]),y1:ca(n.y1,p[1]),x2:ca(n.x2,p[2]),y2:ca(n.y2,p[3]),color:n.color,width:ca(n.width,1),style:n.style,extend:n.extend});out.lines.push(o);return o},\n  delete:o=>{if(o)o.deleted=true;return NaN}};\n for(const f of['x1','y1','x2','y2'])LN['get_'+f]=o=>o?o[f]:NaN;\n for(const f of['x1','y1','x2','y2','color','width'])LN['set_'+f]=(o,v)=>{if(o)o[f]=v;return NaN};\n const LB={new:(p,n)=>{const o=mkTmpl('label',{x:ca(n.x,p[0]),y:ca(n.y,p[1]),text:ca(n.text,p[2]),color:n.color,textcolor:n.textcolor,style:n.style,size:n.size});out.labels.push(o);return o},delete:o=>{if(o)o.deleted=true;return NaN}};\n for(const f of['x','y','text','color','textcolor'])LB['set_'+f]=(o,v)=>{if(o)o[f]=v;return NaN};\n const TB={new:(p,n)=>{const o=mkTmpl('table',{pos:ca(n.position,p[0]),cols:ca(n.columns,p[1]),rows:ca(n.rows,p[2]),bgcolor:n.bgcolor,frame_color:n.frame_color,frame_width:n.frame_width,cells:{}});out.tables.push(o);return o},\n  cell:(p,n)=>{const t=p[0];if(!t)return NaN;t.cells[p[1]+','+p[2]]={col:p[1],row:p[2],text:ca(n.text,p[3]),text_color:n.text_color,bgcolor:n.bgcolor,text_size:n.text_size,text_halign:n.text_halign};return NaN},\n  clear:p=>{const t=p[0];if(!t)return NaN;if(p.length<5){t.cells={};return NaN}for(let c=p[1];c<=p[3];c++)for(let r=p[2];r<=p[4];r++)delete t.cells[c+','+r];return NaN},\n  delete:p=>{if(p[0])p[0].deleted=true;return NaN}};\n function plotAt(site,nm,kind,pos){let p=plotMap[site];if(!p){p={data:new Array(N).fill(NaN),colors:new Array(N).fill(null),name:String(nm.title||(pos&&typeof pos[1]==='string'?pos[1]:'plot')),width:nm.linewidth||1,style:String(nm.style||''),kind};plotMap[site]=p;out.plots.push(p)}return p}\n function $C(name,pos,nm,site){\n  const i=name.indexOf('.'),ns=i<0?'':name.slice(0,i),fn=i<0?name:name.slice(i+1);\n  switch(ns){\n   case 'array':{const f=AR[fn];if(!f)throw new Error('Unsupported function '+name);return f(...pos)}\n   case 'math':{const f=MATH[fn];if(!f)throw new Error('Unsupported function '+name);return f(...pos)}\n   case 'box':{if(fn==='new')return BX.new(pos,nm);const f=BX[fn];if(!f)throw new Error('Unsupported function '+name);return f(...pos)}\n   case 'line':{if(fn==='new')return LN.new(pos,nm);const f=LN[fn];if(!f)throw new Error('Unsupported function '+name);return f(...pos)}\n   case 'label':{if(fn==='new')return LB.new(pos,nm);const f=LB[fn];if(!f)throw new Error('Unsupported function '+name);return f(...pos)}\n   case 'table':{if(fn==='new')return TB.new(pos,nm);const f=TB[fn];if(!f)throw new Error('Unsupported function '+name);return TB[fn](pos,nm)}\n   case 'input':{\n    if(fn==='color'||fn==='string'||fn==='int'||fn==='float'||fn==='bool'||fn==='source'||fn==='timeframe'||fn==='symbol'){\n     const o=Object.assign({},nm);if(nm.defval!==undefined)pos=[nm.defval,...pos.slice(1)];return inp(fn==='color'?'color':fn,pos,o,site)}\n    return pos[0]}\n   case 'str':{\n    if(fn==='tostring')return fmtStr(pos[0],pos[1]);\n    if(fn==='tonumber')return parseFloat(pos[0]);\n    if(fn==='length')return String(pos[0]).length;\n    if(fn==='contains')return String(pos[0]).includes(pos[1]);\n    if(fn==='upper')return String(pos[0]).toUpperCase();if(fn==='lower')return String(pos[0]).toLowerCase();\n    if(fn==='format'){return String(pos[0]).replace(/\\{(\\d+)[^}]*\\}/g,(m,k)=>fmtStr(pos[+k+1]))}\n    break}\n   case 'color':{\n    if(fn==='new')return PXT.rgba(pos[0],pos[1]);\n    if(fn==='rgb')return PXT.rgba('rgb('+pos[0]+','+pos[1]+','+pos[2]+')',pos[3]||0);\n    if(fn==='from_gradient'){const[v,lo,hi,c1,c2]=pos;const t=Math.max(0,Math.min(1,(v-lo)/((hi-lo)||1))),a=PXT.rgba(c1,0).match(/[\\d.]+/g).map(Number),d=PXT.rgba(c2,0).match(/[\\d.]+/g).map(Number);return 'rgba('+a.slice(0,3).map((x,j)=>Math.round(x+(d[j]-x)*t)).join(',')+','+(a[3]+(d[3]-a[3])*t).toFixed(3)+')'}\n    break}\n   case 'timeframe':{\n    if(fn==='in_seconds')return ctx.tfSec||tfMs/1000;\n    if(fn==='change')return false;break}\n   case 'syminfo':break;\n   case 'log':return NaN;\n   case 'runtime':return NaN;\n   case '':{\n    switch(fn){\n     case 'nz':return nz(pos[0],pos[1]);\n     case 'na':return isn(pos[0]);\n     case 'fixnan':return pos[0];\n     case 'int':return $int(pos[0]);case 'float':return pos[0]===undefined?NaN:+pos[0];case 'bool':return !!pos[0];case 'string':return pos[0];case 'color':return pos[0];\n     case 'box':case 'line':case 'label':case 'table':return null;\n     case 'indicator':out.title=String(nm.title||pos[0]||'Script');out.overlay=!!nm.overlay;out.pane=!out.overlay;return NaN;\n     case 'plot':{const p=plotAt(site,nm,'plot',pos);const bar=rt.bar;p.data[bar]=pos[0];if(nm.color!==undefined||pos[2]!==undefined)p.colors[bar]=nm.color!==undefined?nm.color:pos[2];if(!p.color0)p.color0=p.colors[bar];return NaN}\n     case 'plotshape':case 'plotchar':case 'plotarrow':{if(pos[0]||nm.series){out.shapes.push({bar:rt.bar,style:String(nm.style||'triangleup'),loc:String(nm.location||'abovebar'),color:nm.color||'#089981',text:String(nm.text||''),title:String(nm.title||'')})}return NaN}\n     case 'hline':{if(!plotMap['h'+site]){plotMap['h'+site]=1;out.hlines.push({y:pos[0],color:nm.color||'#787B86'})}return NaN}\n     case 'alertcondition':{const a=plotMap['a'+site]||(plotMap['a'+site]={title:String(nm.title||pos[1]||'Alert'),cond:new Array(N).fill(0)});if(a.cond&&!a.added){a.added=1;out.alerts.push(a)}a.cond[rt.bar]=pos[0]?1:0;return NaN}\n     case 'barcolor':{if(!out.barcolor)out.barcolor=new Array(N).fill(null);if(!isn(pos[0])&&pos[0])out.barcolor[rt.bar]=pos[0];return NaN}\n     case 'bgcolor':case 'fill':case 'strategy':case 'alert':return NaN;\n     case 'max':return Math.max(...pos);case 'min':return Math.min(...pos);\n    }}\n  }\n  throw new Error('Unsupported function '+name+'()')}\n const fn=compile(src);\n try{fn(rt,b,N,K,$C,$T,$bh,$hv,$hx,$int)}\n catch(e){const m=(e&&e.message)||String(e);throw e._px?e:new Error(m)}\n out.plots.forEach(p=>{p.color=p.colors.some(c=>c!==null&&c!==p.color0)?p.colors.map(c=>c||p.color0||'#2962FF'):(p.color0||'#2962FF');delete p.colors});\n {const G={};out.shapes.forEach(s=>{const k=[s.style,s.loc,s.color,s.text,s.title].join('|');(G[k]||(G[k]={style:s.style,loc:s.loc,color:s.color,text:s.text,title:s.title,cond:new Array(N).fill(0)})).cond[s.bar]=1});out.shapes=Object.values(G)}\n return out}\nreturn{run}})();\nconst Pine=(()=>{\nconst COL={red:'#f23645',green:'#26a69a',blue:'#2962ff',orange:'#ff9800',yellow:'#fdd835',aqua:'#00bcd4',teal:'#089981',purple:'#9c27b0',lime:'#00e676',fuchsia:'#e040fb',white:'#ffffff',black:'#000000',gray:'#787b86',silver:'#b2b5be',maroon:'#880e4f',navy:'#311b92',olive:'#808000'};\nconst NS=new Set(['shape','location','size','display','format','plot','hline','line','extend','xloc','position','text','label','scale','barmerge','order']);\nconst isA=Array.isArray;\nfunction rgba(c,t){c=String(c);let r,g,b,a=1;if(c[0]==='#'){const h=c.length===4?c.slice(1).replace(/./g,'$&$&'):c.slice(1,7);r=parseInt(h.slice(0,2),16);g=parseInt(h.slice(2,4),16);b=parseInt(h.slice(4,6),16)}else{const m=/rgba?\\(([^)]+)\\)/.exec(c);if(!m)return c;const q=m[1].split(',').map(Number);r=q[0];g=q[1];b=q[2];if(q.length>3)a=q[3]}return 'rgba('+r+','+g+','+b+','+(+(a*(1-(t||0)/100)).toFixed(3))+')'}\nfunction tokenize(s){const T=[];let i=0;const n=s.length;\n while(i<n){const ch=s[i];\n  if(ch===' '||ch==='\\t'||ch==='\\r'){i++;continue}\n  let m;const rest=s.slice(i);\n  if((m=/^(\\d+\\.?\\d*|\\.\\d+)(e[+-]?\\d+)?/i.exec(rest))){T.push({t:'n',v:parseFloat(m[0])});i+=m[0].length;continue}\n  if(ch==='\"'||ch===\"'\"){let j=i+1,v='';while(j<n&&s[j]!==ch)v+=s[j++];T.push({t:'s',v});i=j+1;continue}\n  if((m=/^[A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(rest))){const w=m[0];i+=w.length;\n   if(w==='and'||w==='or'||w==='not')T.push({t:'o',v:w});else if(w==='true'||w==='false')T.push({t:'b',v:w==='true'});else T.push({t:'i',v:w});continue}\n  const two=s.substr(i,2);if([':=','<=','>=','==','!=','=>'].includes(two)){T.push({t:'o',v:two});i+=2;continue}\n  if('()[],?:+-*/%<>='.includes(ch)){T.push({t:'o',v:ch});i++;continue}\n  throw new Error('unexpected character \"'+ch+'\"')}\n return T}\nfunction parse(T){let p=0;const nx=()=>T[p++];const isOp=v=>T[p]&&T[p].t==='o'&&T[p].v===v;\n const ex=v=>{if(!isOp(v))throw new Error('expected \"'+v+'\"');p++};\n function tern(){const c=orr();if(isOp('?')){p++;const a=tern();ex(':');const b=tern();return{k:'tern',c,a,b}}return c}\n function bl(next,ops){return function(){let a=next();while(ops.some(isOp)){const op=nx().v;a={k:'bin',op,a,b:next()}}return a}}\n function un(){if(isOp('-')){p++;return{k:'un',op:'-',e:un()}}if(isOp('+')){p++;return un()}if(isOp('not')){p++;return{k:'un',op:'not',e:un()}}return post()}\n function post(){let e=prim();while(isOp('[')){p++;const i=tern();ex(']');e={k:'idx',e,i}}return e}\n function prim(){const t=nx();if(!t)throw new Error('unexpected end of line');\n  if(t.t==='n'||t.t==='s')return{k:'v',v:t.v};if(t.t==='b')return{k:'v',v:t.v?1:0};\n  if(t.t==='i'){if(isOp('(')){p++;const args=[],named={};\n    while(!isOp(')')){if(T[p]&&T[p].t==='i'&&T[p+1]&&T[p+1].t==='o'&&T[p+1].v==='='){const k=nx().v;p++;named[k]=tern()}else args.push(tern());if(isOp(','))p++;else break}\n    ex(')');return{k:'call',f:t.v,args,named}}return{k:'id',n:t.v}}\n  if(t.t==='o'&&t.v==='('){const e=tern();ex(')');return e}\n  throw new Error('unexpected \"'+t.v+'\"')}\n const mul=bl(un,['*','/','%']),add=bl(mul,['+','-']),cmp=bl(add,['<','>','<=','>=']),eq=bl(cmp,['==','!=']),andd=bl(eq,['and']);\n var orr=bl(andd,['or']);\n const e=tern();if(p<T.length)throw new Error('unexpected \"'+T[p].v+'\"');return e}\n\nfunction run(src,bars){\n const N=bars.length;\n const out={title:'Script',overlay:false,plots:[],shapes:[],hlines:[],alerts:[],pane:true};\n const S={open:bars.map(b=>b.o),high:bars.map(b=>b.h),low:bars.map(b=>b.l),close:bars.map(b=>b.c),volume:bars.map(b=>b.v),time:bars.map(b=>b.t),bar_index:bars.map((_,i)=>i)};\n S.hl2=bars.map(b=>(b.h+b.l)/2);S.hlc3=bars.map(b=>(b.h+b.l+b.c)/3);S.ohlc4=bars.map(b=>(b.o+b.h+b.l+b.c)/4);\n const vars=Object.create(null);\n const nan=()=>new Array(N).fill(NaN);\n const A=v=>isA(v)?v:new Array(N).fill(v);\n const sc=v=>isA(v)?v[N-1]:v;\n const m1=(a,f)=>isA(a)?a.map(f):f(a);\n function zip(a,b,f){if(!isA(a)&&!isA(b))return f(a,b);const x=A(a),y=A(b),o=new Array(N);for(let i=0;i<N;i++)o[i]=f(x[i],y[i]);return o}\n const OPS={'+':(a,b)=>a+b,'-':(a,b)=>a-b,'*':(a,b)=>a*b,'/':(a,b)=>b===0?NaN:a/b,'%':(a,b)=>b===0?NaN:a%b,\n  '<':(a,b)=>a<b?1:0,'>':(a,b)=>a>b?1:0,'<=':(a,b)=>a<=b?1:0,'>=':(a,b)=>a>=b?1:0,'==':(a,b)=>a===b?1:0,'!=':(a,b)=>a!==b?1:0,\n  'and':(a,b)=>(a&&b)?1:0,'or':(a,b)=>(a||b)?1:0};\n function trS(){return bars.map((b,i)=>i===0?b.h-b.l:Math.max(b.h-b.l,Math.abs(b.h-bars[i-1].c),Math.abs(b.l-bars[i-1].c)))}\n function ma(s,l,k){s=A(s);const o=nan();let st=0;while(st<N&&s[st]!==s[st])st++;if(st+l>N||l<1)return o;let sum=0;for(let j=st;j<st+l;j++)sum+=s[j];let p=sum/l;o[st+l-1]=p;for(let i=st+l;i<N;i++){const v=s[i];if(v===v)p=v*k+p*(1-k);o[i]=p}return o}\n function roll(s,l,f){s=A(s);const o=nan();for(let i=l-1;i<N;i++){const w=[];let ok=1;for(let j=i-l+1;j<=i;j++){if(s[j]!==s[j]){ok=0;break}w.push(s[j])}if(ok)o[i]=f(w)}return o}\n const ta={\n  sma:(s,l)=>roll(s,l,w=>w.reduce((a,b)=>a+b,0)/l),\n  ema:(s,l)=>ma(s,l,2/(l+1)),rma:(s,l)=>ma(s,l,1/l),\n  wma:(s,l)=>roll(s,l,w=>{let t=0,d=0;w.forEach((v,i)=>{t+=v*(i+1);d+=i+1});return t/d}),\n  stdev:(s,l)=>roll(s,l,w=>{const m=w.reduce((a,b)=>a+b,0)/l;return Math.sqrt(w.reduce((a,b)=>a+(b-m)*(b-m),0)/l)}),\n  highest:(s,l)=>roll(s,l,w=>Math.max(...w)),lowest:(s,l)=>roll(s,l,w=>Math.min(...w)),\n  rsi:(s,l)=>{s=A(s);const up=nan(),dn=nan();for(let i=1;i<N;i++){up[i]=Math.max(s[i]-s[i-1],0);dn[i]=Math.max(s[i-1]-s[i],0)}const ru=ma(up,l,1/l),rd=ma(dn,l,1/l);return ru.map((u,i)=>rd[i]===0?100:100-100/(1+u/rd[i]))},\n  change:(s,l)=>{s=A(s);return s.map((v,i)=>i-l<0?NaN:v-s[i-l])},\n  cum:s=>{s=A(s);let t=0;return s.map(v=>(t+=(v===v?v:0)))},\n  cross:(a,b,up)=>{const x=A(a),y=A(b);return x.map((v,i)=>i&&(up?(v>y[i]&&x[i-1]<=y[i-1]):(v<y[i]&&x[i-1]>=y[i-1]))?1:0)},\n  vwap:()=>{const o=nan();let day=-1,pv=0,vv=0;for(let i=0;i<N;i++){const d=Math.floor(bars[i].t/864e5);if(d!==day){day=d;pv=0;vv=0}pv+=S.hlc3[i]*bars[i].v;vv+=bars[i].v;o[i]=vv?pv/vv:NaN}return o}\n };\n const sh=(a,k)=>{if(!isA(a))return a;return a.map((_,i)=>i-k<0?NaN:a[i-k])};\n const mf=f=>a=>zip(a[0],a[1],f);\n const F={\n  'indicator':(a,nm)=>{out.title=nm.title||a[0]||'Script';out.overlay=!!nm.overlay;out.pane=!out.overlay;return NaN},\n  'strategy':(a,nm)=>F.indicator(a,nm),\n  'input':a=>a[0],'input.int':a=>a[0],'input.float':a=>a[0],'input.bool':a=>a[0],'input.string':a=>a[0],'input.source':a=>a[0],'input.color':a=>a[0],'input.timeframe':a=>a[0],\n  'plot':(a,nm)=>{out.plots.push({data:A(a[0]),name:String(nm.title||a[1]||'plot'),color:nm.color!==undefined?nm.color:(a[2]!==undefined?a[2]:COL.blue),width:nm.linewidth||a[3]||1,style:String(nm.style||'')});return NaN},\n  'plotshape':(a,nm)=>{out.shapes.push({cond:A(a[0]),style:String(nm.style||'triangleup'),loc:String(nm.location||'abovebar'),color:nm.color||COL.green,text:String(nm.text||''),title:String(nm.title||'')});return NaN},\n  'hline':(a,nm)=>{out.hlines.push({y:a[0],color:nm.color||COL.gray});return NaN},\n  'alertcondition':(a,nm)=>{out.alerts.push({title:String(nm.title||a[1]||'Alert'),cond:A(a[0])});return NaN},\n  'bgcolor':()=>NaN,'fill':()=>NaN,\n  'na':a=>a.length?m1(a[0],v=>v!==v?1:0):NaN,\n  'nz':a=>zip(a[0],a[1]===undefined?0:a[1],(v,d)=>v!==v?d:v),\n  'color.new':a=>zip(a[0],a[1]||0,(c,t)=>rgba(c,t)),\n  'color.rgb':a=>rgba('rgb('+a[0]+','+a[1]+','+a[2]+')',a[3]||0),\n  'math.abs':a=>m1(a[0],Math.abs),'math.sqrt':a=>m1(a[0],Math.sqrt),'math.log':a=>m1(a[0],Math.log),'math.round':a=>m1(a[0],Math.round),'math.floor':a=>m1(a[0],Math.floor),'math.ceil':a=>m1(a[0],Math.ceil),'math.sign':a=>m1(a[0],Math.sign),\n  'math.max':mf(Math.max),'math.min':mf(Math.min),'math.pow':mf(Math.pow),'math.avg':mf((x,y)=>(x+y)/2),\n  'ta.sma':a=>ta.sma(a[0],sc(a[1])),'ta.ema':a=>ta.ema(a[0],sc(a[1])),'ta.rma':a=>ta.rma(a[0],sc(a[1])),'ta.wma':a=>ta.wma(a[0],sc(a[1])),\n  'ta.rsi':a=>ta.rsi(a[0],sc(a[1])),'ta.stdev':a=>ta.stdev(a[0],sc(a[1])),'ta.cum':a=>ta.cum(a[0]),\n  'ta.highest':a=>a.length>1?ta.highest(a[0],sc(a[1])):ta.highest(S.high,sc(a[0])),\n  'ta.lowest':a=>a.length>1?ta.lowest(a[0],sc(a[1])):ta.lowest(S.low,sc(a[0])),\n  'ta.change':a=>ta.change(a[0],a.length>1?sc(a[1]):1),\n  'ta.crossover':a=>ta.cross(a[0],a[1],true),'ta.crossunder':a=>ta.cross(a[0],a[1],false),\n  'ta.tr':()=>trS(),'ta.atr':a=>ma(trS(),sc(a[0]),1/sc(a[0])),'ta.vwap':()=>ta.vwap(),\n  'ta.macd':a=>{const f=ta.ema(a[0],sc(a[1])),s=ta.ema(a[0],sc(a[2])),m=f.map((v,i)=>v-s[i]);const sg=ta.ema(m,sc(a[3]));return{tuple:[m,sg,m.map((v,i)=>v-sg[i])]}},\n  'ta.bb':a=>{const l=sc(a[1]),k=sc(a[2]),b=ta.sma(a[0],l),d=ta.stdev(a[0],l);return{tuple:[b,b.map((v,i)=>v+k*d[i]),b.map((v,i)=>v-k*d[i])]}}\n };\n function look(n){\n  if(n in vars)return vars[n];if(n in S)return S[n];\n  if(n.startsWith('color.')&&COL[n.slice(6)])return COL[n.slice(6)];\n  if(n==='na')return NaN;if(n==='math.pi')return Math.PI;if(n==='ta.tr')return trS();\n  const ns=n.split('.')[0];if(n.includes('.')&&NS.has(ns))return n.slice(ns.length+1);\n  throw new Error('unknown name \"'+n+'\"')}\n function ev(n){\n  switch(n.k){\n   case 'v':return n.v;\n   case 'id':return look(n.n);\n   case 'un':{const a=ev(n.e);return n.op==='-'?m1(a,v=>-v):m1(a,v=>v?0:1)}\n   case 'bin':{const a=ev(n.a),b=ev(n.b);return zip(a,b,OPS[n.op])}\n   case 'tern':{const c=ev(n.c),a=ev(n.a),b=ev(n.b);if(!isA(c)&&!isA(a)&&!isA(b))return c?a:b;const C=A(c),x=A(a),y=A(b);return C.map((v,i)=>v?x[i]:y[i])}\n   case 'idx':return sh(ev(n.e),sc(ev(n.i)));\n   case 'call':{const fn=F[n.f];if(!fn)throw new Error('\"'+n.f+'\" isn\\'t supported in this editor yet');const a=n.args.map(ev);const nm={};for(const k in n.named)nm[k]=ev(n.named[k]);return fn(a,nm)}\n  }\n }\n function exec(st){\n  if(/^(import|export)\\b/.test(st))return;\n  if(/^(if|for|while|switch|else|type|method)\\b/.test(st)||st.includes('=>'))throw new Error('if/for blocks and functions aren\\'t supported yet. Use cond ? a : b or the ta.* helpers.');\n  let m=/^\\[([^\\]]+)\\]\\s*=\\s*(.+)$/.exec(st);\n  if(m){const names=m[1].split(',').map(s=>s.trim());const v=ev(parse(tokenize(m[2])));if(!v||!v.tuple)throw new Error('right side must return several series');names.forEach((n,i)=>{vars[n]=v.tuple[i]});return}\n  m=/^(?:(?:var|varip)\\s+)?(?:(?:int|float|bool|string|color)\\s+)?([A-Za-z_]\\w*)\\s*(:=|=)(?!=)\\s*(.+)$/.exec(st);\n  if(m){vars[m[1]]=ev(parse(tokenize(m[3])));return}\n  ev(parse(tokenize(st)))\n }\n const lines=src.split('\\n');let buf='',ln0=0,depth=0;\n for(let li=0;li<lines.length;li++){\n  let L=lines[li];const ci=L.indexOf('//');if(ci>=0)L=L.slice(0,ci);\n  if(!buf){if(!L.trim())continue;ln0=li+1}\n  buf+=' '+L;depth+=(L.match(/[(\\[]/g)||[]).length-(L.match(/[)\\]]/g)||[]).length;\n  if(depth>0&&li<lines.length-1)continue;\n  depth=0;const st=buf.trim();buf='';\n  try{exec(st)}catch(e){throw new Error('Line '+ln0+': '+e.message)}\n }\n return out}\nreturn{run,COL,rgba}})();\nconst PRESETS=[\n{name:'EMA cross with long/short signals',code:`//@version=6\nindicator(\"EMA Cross\", overlay=true)\nfastLen = input.int(9, \"Fast\")\nslowLen = input.int(21, \"Slow\")\nfast = ta.ema(close, fastLen)\nslow = ta.ema(close, slowLen)\nup = ta.crossover(fast, slow)\ndn = ta.crossunder(fast, slow)\nplot(fast, \"Fast\", color=color.aqua, linewidth=2)\nplot(slow, \"Slow\", color=color.orange, linewidth=2)\nplotshape(up, title=\"Long\", style=shape.triangleup, location=location.belowbar, color=color.lime, text=\"L\")\nplotshape(dn, title=\"Short\", style=shape.triangledown, location=location.abovebar, color=color.red, text=\"S\")\nalertcondition(up, \"Long signal\")\nalertcondition(dn, \"Short signal\")\n`},\n{name:'RSI with 70/30 levels',code:`//@version=6\nindicator(\"RSI\", overlay=false)\nlen = input.int(14, \"Length\")\nr = ta.rsi(close, len)\nplot(r, \"RSI\", color=color.orange, linewidth=2)\nhline(70, color=color.red)\nhline(30, color=color.green)\nhline(50, color=color.gray)\n`},\n{name:'Bollinger Bands',code:`//@version=6\nindicator(\"Bollinger Bands\", overlay=true)\n[basis, upper, lower] = ta.bb(close, 20, 2)\nplot(basis, \"Basis\", color=color.orange)\nplot(upper, \"Upper\", color=color.new(color.aqua, 20))\nplot(lower, \"Lower\", color=color.new(color.aqua, 20))\n`},\n{name:'MACD histogram',code:`//@version=6\nindicator(\"MACD\", overlay=false)\n[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(h, \"Hist\", style=plot.style_histogram, color=h >= 0 ? color.new(color.green, 30) : color.new(color.red, 30))\nplot(m, \"MACD\", color=color.aqua)\nplot(s, \"Signal\", color=color.orange)\n`},\n{name:'Range breakout long/short',code:`//@version=6\nindicator(\"Breakout\", overlay=true)\nn = input.int(20, \"Lookback\")\nhi = ta.highest(high, n)[1]\nlo = ta.lowest(low, n)[1]\nlongSig = close > hi\nshortSig = close < lo\nplot(hi, \"Upper\", color=color.new(color.green, 40))\nplot(lo, \"Lower\", color=color.new(color.red, 40))\nplotshape(longSig, style=shape.labelup, location=location.belowbar, color=color.green, text=\"Long\")\nplotshape(shortSig, style=shape.labeldown, location=location.abovebar, color=color.red, text=\"Short\")\nalertcondition(longSig, \"Breakout long\")\nalertcondition(shortSig, \"Breakout short\")\n`}\n];\nconst DSP_SRC=\"// This source code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/\\n// \\u00a9 TraderGze - Delta Profile Multi-Session\\n// (Derived from \\\"Smart Volume Profile Multi-Session\\\" \\u2014 the volume-profile\\n// box drawing has been REPLACED by delta (buy-sell) box drawing, in the\\n// SAME right-facing orientation/position the volume boxes used, so it\\n// still works across every session mode: 4H / 12H / 3D.)\\n\\n//@version=6\\nindicator(\\\"Smart Delta Profile High Vol\\\", overlay=true, max_labels_count=500, max_boxes_count=500, max_lines_count=500, max_bars_back=1000)\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// SESSION TIMEFRAME SETTINGS\\n//   Auto mode:  5m chart \\u2192 4 Hour Profile | 15m chart \\u2192 12 Hour Profile | 45m chart \\u2192 3 Day Profile\\n//   Or force a specific session length manually.\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nsess_mode = input.string(\\\"Auto (by chart TF)\\\", title=\\\"Delta Profile Session Length\\\", group=\\\"Profile Session\\\", options=[\\\"Auto (by chart TF)\\\", \\\"4 Hour\\\", \\\"12 Hour\\\", \\\"3 Day\\\"], tooltip=\\\"Auto: 5m\\u21924H, 15m\\u219212H, 45m\\u21923D. Any other chart TF defaults to 4H.\\\")\\n\\n// resolve the session length in milliseconds\\nint chart_tf_min = timeframe.in_seconds() / 60\\nstring sess_name = \\\"\\\"\\nint sess_len_ms  = 0\\nif sess_mode == \\\"4 Hour\\\"\\n    sess_len_ms := 14400000\\n    sess_name   := \\\"4Hr\\\"\\nelse if sess_mode == \\\"12 Hour\\\"\\n    sess_len_ms := 43200000\\n    sess_name   := \\\"12Hr\\\"\\nelse if sess_mode == \\\"3 Day\\\"\\n    sess_len_ms := 259200000\\n    sess_name   := \\\"3D\\\"\\nelse\\n    // Auto\\n    if chart_tf_min == 15\\n        sess_len_ms := 43200000\\n        sess_name   := \\\"12Hr\\\"\\n    else if chart_tf_min == 45\\n        sess_len_ms := 259200000\\n        sess_name   := \\\"3D\\\"\\n    else\\n        sess_len_ms := 14400000\\n        sess_name   := \\\"4Hr\\\"\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// X2 VOLUME SETTINGS\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nx2_period   = input.int(20, title=\\\"Volume EMA Period\\\", group=\\\"X2 Volume Highlighter\\\")\\nx2_strength = input.float(2, title=\\\"Volume Strength Multiplier\\\", group=\\\"X2 Volume Highlighter\\\", minval=0, tooltip=\\\"2 = 200% of average volume. Candles above this threshold are highlighted.\\\")\\n\\nx2_out_bull_color  = input.color(color.lime, title=\\\"Outside VA \\u2014 Bull Candle Color\\\", group=\\\"X2 Volume Highlighter\\\")\\nx2_out_bear_color  = input.color(color.red,  title=\\\"Outside VA \\u2014 Bear Candle Color\\\", group=\\\"X2 Volume Highlighter\\\")\\nx2_in_bull_color   = input.color(color.gray, title=\\\"Inside VA \\u2014 Bull Candle Color\\\",  group=\\\"X2 Volume Highlighter\\\")\\nx2_in_bear_color   = input.color(color.gray, title=\\\"Inside VA \\u2014 Bear Candle Color\\\",  group=\\\"X2 Volume Highlighter\\\")\\nx2_norm_bull_color = input.color(color.gray, title=\\\"Normal \\u2014 Bull Candle Color\\\",     group=\\\"X2 Volume Highlighter\\\")\\nx2_norm_bear_color = input.color(color.gray, title=\\\"Normal \\u2014 Bear Candle Color\\\",     group=\\\"X2 Volume Highlighter\\\")\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// DELTA PROFILE SETTINGS\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\ndelta_method_1   = \\\"Bar Polarity\\\"\\ndelta_method_2   = \\\"Bar Buying/Selling Pressure\\\"\\ndelta_method     = input.string(delta_method_1, title=\\\"Delta Polarity Method\\\", options=[delta_method_1, delta_method_2], group=\\\"Delta Profile\\\", tooltip=\\\"Bar Polarity: up if close>open.\\\\nBar Buying/Selling Pressure: up if (close-low) > (high-close).\\\")\\ndelta_box_size   = input.float(0.5, minval=0.1, maxval=10.0, step=0.1, title=\\\"Delta Box Size\\\", group=\\\"Delta Profile\\\", tooltip=\\\"Width multiplier. Smaller values merge more rows into fewer boxes.\\\")\\npoc_box_color    = input.color(color.rgb(255, 200, 0), title=\\\"POC (Highest Volume Row) Box Color\\\", group=\\\"Delta Profile\\\")\\ndelta_buy_color  = input.color(color.new(#2962FF, 15), title=\\\"Delta Buy-Dominant Color\\\",  group=\\\"Delta Profile\\\")\\ndelta_sell_color = input.color(color.new(#FF1744, 15), title=\\\"Delta Sell-Dominant Color\\\", group=\\\"Delta Profile\\\")\\ndelta_show_text  = input.bool(true, title=\\\"Show Delta Value Text?\\\", group=\\\"Delta Profile\\\")\\ndelta_text_size  = input.string(size.tiny, title=\\\"Delta Text Size\\\", group=\\\"Delta Profile\\\", options=[size.auto, size.tiny, size.small, size.normal])\\nshow_poc_line    = input.bool(true, title=\\\"Show POC Line?\\\", group=\\\"Delta Profile\\\")\\npoc_line_color   = input.color(color.rgb(255, 0, 0, 100), title=\\\"POC Line Color\\\", group=\\\"Delta Profile\\\")\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// NOISE FILTER SETTINGS\\n//   Option 1: Remove Low Delta Rows  -> keep the strongest-|delta| nodes\\n//   Option 2: Remove High Delta Rows -> keep the weakest-|delta| nodes\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nnoise_mode_off  = \\\"Off\\\"\\nnoise_mode_low  = \\\"Remove Low Delta Rows\\\"\\nnoise_mode_high = \\\"Remove High Delta Rows\\\"\\nnoise_mode = input.string(noise_mode_off, title=\\\"Filter Mode\\\", options=[noise_mode_off, noise_mode_low, noise_mode_high], group=\\\"Noise Filter\\\",\\n     tooltip=\\\"Ranks rows by the SIZE of their delta |buy - sell|, regardless of direction.\\\\n\\\\nRemove Low Delta Rows: hides rows with small |delta| so only the strongest buy/sell imbalance nodes remain.\\\\n\\\\nRemove High Delta Rows: hides rows with large |delta| so only the low-delta (balanced) nodes remain.\\\")\\nnoise_level = input.int(5, minval=1, maxval=10, title=\\\"Noise Filter Strength\\\", group=\\\"Noise Filter\\\",\\n     tooltip=\\\"1 = minimal filtering (show most rows), 10 = aggressive filtering (show only the highest-|delta| nodes in Low mode / only the low-|delta| nodes in High mode). Raise to cut noise, lower to see more detail.\\\")\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// TICK SIZE CONFIGURATION\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nauto_tick_size_b  = input.bool(true, title=\\\"Auto Tick Size?\\\", group=\\\"Tick Size\\\")\\nint tick_bars_back = input.int(96, minval=1, title=\\\"Avg Tick Size - Bars Back\\\", group=\\\"Tick Size\\\")\\ntarget_session_ht = input.float(20, minval=1, title=\\\"Average Target Session Height for Tick Size\\\", group=\\\"Tick Size\\\", tooltip=\\\"Approx. number of rows per session. LOWER = fewer rows = fewer boxes = MORE past sessions visible.\\\")\\nman_tick_size     = input.int(100, minval=1, title=\\\"Manual Tick Size\\\", group=\\\"Tick Size\\\")\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// INFO TABLE\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nshow_tpo_info         = input.bool(true, title=\\\"Show Info Text?\\\", group=\\\"Info Table\\\")\\ninfo_table_txt_size   = input.string(size.small, title=\\\"Info Text Size\\\", group=\\\"Info Table\\\", options=[size.auto, size.tiny, size.small, size.normal, size.large, size.huge])\\ninfo_table_text_color = input.color(color.rgb(255, 255, 255), title=\\\"Info Box Letter Color\\\", group=\\\"Info Table\\\")\\ninfo_table_color      = input.color(color.rgb(255, 255, 255), title=\\\"Info Box Background Color\\\", group=\\\"Info Table\\\")\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// GLOBAL CALCULATIONS (v6 consistency requirement)\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\navg_bar_ht_global = ta.sma(high, tick_bars_back) - ta.sma(low, tick_bars_back)\\nvol_ema_global    = ta.ema(volume, x2_period)\\n\\n// SESSION DETECTION \\u2014 generic, epoch-anchored blocks (UTC)\\nsess_block  = math.floor(time / sess_len_ms)\\nsess_change = sess_block != sess_block[1]\\nsess_start_global = nz(ta.barssince(sess_change))\\n\\nbool is_in_session = true\\nint  sess_start    = sess_start_global\\n\\nif syminfo.type == \\\"economic\\\"\\n    is_in_session := false\\n\\nsess_start_bar = int(bar_index - sess_start)\\n\\n// PERFORMANCE GATE \\u2014 is this the FINAL bar of its session?\\nsess_block_close = math.floor(time_close / sess_len_ms)\\nbool is_sess_last_bar = sess_block_close != sess_block\\nbool do_full_calc = barstate.islast or is_sess_last_bar\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// HELPER FUNCTIONS\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// A bar contributes its FULL volume to a row if its range [low, high]\\n// overlaps the half-open row bucket [row_low, row_low + tick_size).\\nfn_volume_per_tick(row_low, row_top_excl, bars_back) =>\\n    float row_volume = 0.0\\n    for i = 0 to bars_back\\n        if high[i] >= row_low and low[i] < row_top_excl\\n            row_volume := row_volume + volume[i]\\n    row_volume\\n\\n// Same \\\"touch\\\" test as fn_volume_per_tick, but splits the contributed\\n// volume into a BUY (bull) portion using the chosen polarity method.\\nfn_bull_volume_per_tick(row_low, row_top_excl, bars_back, use_pressure_method) =>\\n    float bull_volume = 0.0\\n    for i = 0 to bars_back\\n        if high[i] >= row_low and low[i] < row_top_excl\\n            bool bar_is_bull = use_pressure_method ? (close[i] - low[i]) > (high[i] - close[i]) : close[i] > open[i]\\n            if bar_is_bull\\n                bull_volume := bull_volume + volume[i]\\n    bull_volume\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// VISUAL OBJECT ARRAYS\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nvar deltaBoxIDs      = array.new_box(0)\\nvar last_deltaBoxIDs = array.new_box(0)\\nvar pocLineID         = line(na)\\nvar lastPocLineIDs    = array.new_line(0)\\n\\nTPO_price      = array.new_float(0)\\nTPO_length     = array.new_float(0)   // total volume per row (still needed to find POC + scale boxes)\\nTPO_delta_bull = array.new_float(0)   // bull (buy-side) volume per row, parallel to TPO_length/TPO_price\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// TICK SIZE CALCULATION (na-safe on first bars: falls back to bar range)\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nfloat tick_size = syminfo.mintick\\n\\ntick_size := if auto_tick_size_b and sess_start == 0\\n    float bar_ht = na(avg_bar_ht_global) ? (high - low) : avg_bar_ht_global\\n    float auto_tick = math.round_to_mintick(bar_ht / target_session_ht)\\n    if auto_tick == 0 or na(auto_tick)\\n        auto_tick := syminfo.mintick\\n    auto_tick\\nelse if sess_start == 0 and not auto_tick_size_b\\n    man_tick_size * syminfo.mintick\\nelse\\n    tick_size[sess_start]\\n\\nhalf_tick = math.round_to_mintick(tick_size * 0.5)\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// SESSION HIGH/LOW \\u2014 incremental (no per-bar loop over the session)\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nvar float p_sess_hi = na\\nvar float p_sess_lo = na\\nif sess_start == 0\\n    p_sess_hi := na\\n    p_sess_lo := na\\nfloat highest_high = na(p_sess_hi) ? high : math.max(p_sess_hi, high)\\nfloat lowest_low   = na(p_sess_lo) ? low  : math.min(p_sess_lo, low)\\nif barstate.isconfirmed\\n    p_sess_hi := highest_high\\n    p_sess_lo := lowest_low\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// PROFILE RANGE \\u2014 grid anchored at the actual session low\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nfloat TPO_min  = lowest_low\\nint   TPO_rows = math.max(0, int(math.ceil((highest_high - TPO_min) / tick_size)) - 1)\\nfloat TPO_mid  = math.round_to_mintick((lowest_low + highest_high) / 2)\\nTPO_POC = float(na)\\n\\nvar float curr_TPO_POC = na\\nvar float prev_TPO_POC = na\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// MAIN DELTA PROFILE CALCULATION + DRAWING\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nif is_in_session\\n\\n    // \\u2500\\u2500 session rollover housekeeping (cheap, every session start) \\u2500\\u2500\\n    if sess_start == 0\\n        if not na(curr_TPO_POC)\\n            prev_TPO_POC := curr_TPO_POC\\n        array.concat(last_deltaBoxIDs, deltaBoxIDs)\\n        array.clear(deltaBoxIDs)\\n        if not na(pocLineID)\\n            array.push(lastPocLineIDs, pocLineID)\\n        while array.size(lastPocLineIDs) > 490\\n            line.delete(array.shift(lastPocLineIDs))\\n        pocLineID := line(na)\\n\\n    // \\u2500\\u2500 heavy work only when we actually need to draw \\u2500\\u2500\\n    if do_full_calc\\n\\n        // live session gets fully redrawn on every update\\n        if array.size(deltaBoxIDs) > 0\\n            for i = 0 to array.size(deltaBoxIDs) - 1\\n                box.delete(array.shift(deltaBoxIDs))\\n            array.clear(deltaBoxIDs)\\n        if not na(pocLineID)\\n            line.delete(pocLineID)\\n            pocLineID := line(na)\\n\\n        // Build the volume + bull-volume histogram in the SAME pass.\\n        if TPO_rows <= 2000\\n            for i = 0 to TPO_rows\\n                row_low        = TPO_min + i * tick_size\\n                row_top_excl   = row_low + tick_size\\n                row_volume     = fn_volume_per_tick(row_low, row_top_excl, sess_start)\\n                row_bull_vol   = fn_bull_volume_per_tick(row_low, row_top_excl, sess_start, delta_method == delta_method_2)\\n                array.push(TPO_length,     row_volume)\\n                array.push(TPO_price,      row_low)\\n                array.push(TPO_delta_bull, row_bull_vol)\\n\\n        if array.size(TPO_length) > 0 and array.size(TPO_price) > 0\\n            max_vol = array.max(TPO_length)\\n\\n            // POC: among rows tied at max volume, take the one closest to session mid.\\n            int POC_index = array.indexof(TPO_length, max_vol)\\n            if POC_index != array.lastindexof(TPO_length, max_vol)\\n                float best_dist = na\\n                for i = 0 to array.size(TPO_length) - 1\\n                    if array.get(TPO_length, i) == max_vol\\n                        d = math.abs(array.get(TPO_price, i) + half_tick - TPO_mid)\\n                        if na(best_dist) or d < best_dist\\n                            best_dist := d\\n                            POC_index := i\\n            TPO_POC := array.get(TPO_price, POC_index)\\n            curr_TPO_POC := TPO_POC\\n\\n            // \\u2500\\u2500 NOISE FILTER CUT-OFF (percentile of traded rows' |delta|) \\u2500\\u2500\\n            // |delta| = |buy - sell| = |2 * bull_vol - total_vol|\\n            // Level 1 -> ~9% of rows filtered, Level 10 -> ~90% filtered.\\n            float noise_cut = na\\n            if noise_mode != noise_mode_off\\n                traded_abs_deltas = array.new_float(0)\\n                for i = 0 to array.size(TPO_length) - 1\\n                    float v = array.get(TPO_length, i)\\n                    if v > 0\\n                        array.push(traded_abs_deltas, math.abs(2 * array.get(TPO_delta_bull, i) - v))\\n                if array.size(traded_abs_deltas) > 0\\n                    float pct = noise_level * 9.0\\n                    noise_cut := noise_mode == noise_mode_low ? array.percentile_nearest_rank(traded_abs_deltas, pct) : array.percentile_nearest_rank(traded_abs_deltas, 100 - pct)\\n\\n            color last_box_color = na\\n            bool  prev_row_drawn = false   // prevents merging across empty rows\\n\\n            for i = 0 to TPO_rows\\n                row_low     = array.get(TPO_price, i)\\n                // clamp the very top row to the actual session high\\n                row_top     = i == TPO_rows ? math.max(math.min(row_low + tick_size, highest_high), row_low + syminfo.mintick) : row_low + tick_size\\n                row_volume  = array.get(TPO_length, i)\\n\\n                // Rows where price NEVER traded are skipped completely.\\n                if row_volume == 0\\n                    prev_row_drawn := false\\n                    continue\\n\\n                left_side = sess_start_bar\\n                bool is_poc = i == POC_index\\n\\n                if is_poc and show_poc_line\\n                    line.delete(pocLineID)\\n                    pocLineID := line.new(left_side, row_low + half_tick, bar_index + 1, row_low + half_tick, color=poc_line_color)\\n\\n                // \\u2500\\u2500 DELTA VALUE FOR THIS ROW \\u2500\\u2500\\n                row_bull_vol = array.get(TPO_delta_bull, i)\\n                row_sell_vol = row_volume - row_bull_vol\\n                row_delta    = row_bull_vol - row_sell_vol   // net buy(+)/sell(-) volume for this row\\n\\n                // \\u2500\\u2500 NOISE FILTER: skip boxes by |delta| (POC line above stays) \\u2500\\u2500\\n                bool noise_hide = false\\n                if not na(noise_cut)\\n                    noise_hide := noise_mode == noise_mode_low ? math.abs(row_delta) < noise_cut : math.abs(row_delta) > noise_cut\\n                if noise_hide\\n                    prev_row_drawn := false\\n                    continue\\n\\n                box_color = is_poc ? poc_box_color : (row_delta >= 0 ? delta_buy_color : delta_sell_color)\\n\\n                // left = session start, right grows with |delta|.\\n                adjusted_right_side = sess_start_bar + math.round(math.abs(row_delta) / (vol_ema_global == 0 ? 1 : vol_ema_global) * delta_box_size * 10)\\n\\n                bool merged = false\\n                if prev_row_drawn and array.size(deltaBoxIDs) > 0\\n                    last_box_ID    = array.get(deltaBoxIDs, array.size(deltaBoxIDs) - 1)\\n                    last_box_right = box.get_right(last_box_ID)\\n                    if adjusted_right_side == last_box_right and not is_poc and box.get_bottom(last_box_ID) != TPO_POC and last_box_color == box_color\\n                        box.set_top(last_box_ID, row_top)\\n                        merged := true\\n\\n                if not merged\\n                    int total_boxes = array.size(deltaBoxIDs) + array.size(last_deltaBoxIDs)\\n                    if total_boxes > 499 and array.size(last_deltaBoxIDs) > 0\\n                        box.delete(array.shift(last_deltaBoxIDs))\\n                    total_boxes := array.size(deltaBoxIDs) + array.size(last_deltaBoxIDs)\\n                    if total_boxes > 499 and array.size(deltaBoxIDs) > 0\\n                        box.delete(array.shift(deltaBoxIDs))\\n                    delta_txt = delta_show_text ? str.tostring(row_delta, format.volume) : ''\\n                    delta_box = box.new(left=left_side, top=row_top, right=adjusted_right_side, bottom=row_low, bgcolor=color.new(box_color, 0), border_color=na,\\n                                         text=delta_txt, text_color=chart.fg_color, text_size=delta_text_size, text_halign=text.align_right)\\n                    array.push(deltaBoxIDs, delta_box)\\n\\n                last_box_color := box_color\\n                prev_row_drawn := true\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// X2 VOLUME CANDLE COLORING\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\neffective_POC = not na(curr_TPO_POC) ? curr_TPO_POC : prev_TPO_POC\\n\\nbool is_heavy = volume > vol_ema_global * x2_strength\\nbool is_bull  = close > open\\n\\nbool is_outside_POC = not na(effective_POC) and (close > effective_POC + tick_size or close < effective_POC - tick_size)\\n\\ncolor final_color = na\\nif is_heavy\\n    final_color := is_outside_POC ? (is_bull ? x2_out_bull_color : x2_out_bear_color) : (is_bull ? x2_in_bull_color : x2_in_bear_color)\\nelse\\n    final_color := is_bull ? x2_norm_bull_color : x2_norm_bear_color\\n\\nbarcolor(final_color)\\n\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\n// INFO TABLE\\n// \\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\u2500\\nfilter_txt  = noise_mode == noise_mode_off ? \\\"\\\" : \\\" | Filter: \\\" + (noise_mode == noise_mode_low ? \\\"Low-Delta\\\" : \\\"High-Delta\\\") + \\\" x\\\" + str.tostring(noise_level)\\ninfo_text_6 = sess_name + \\\" Delta Profile\\\" + filter_txt\\n\\nvar table ticktestarray = table.new(position.bottom_right, 1, 20, bgcolor=info_table_color, frame_width=2, frame_color=color.black)\\n\\nif show_tpo_info\\n    table.clear(ticktestarray, 0, 0, 0, 19)\\n    table.cell(ticktestarray, 0, 0, text=info_text_6, text_color=info_table_text_color, text_size=info_table_txt_size, bgcolor=color.rgb(90, 90, 90))\\nelse\\n    table.clear(ticktestarray, 0, 0, 0, 19)\";\nconst HOST=window.name==='tkhost';\n'use strict';\nconst $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];\nconst store={get(k,d){try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v)}catch(e){return d}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}};\nconst SYMS=[['BTCUSDT','BTC/USDT',67000,'bn','Crypto'],['MT5:GOLD','XAUUSD247 (ThinkMarkets)',4000,'srv','Commodities'],['ETHUSDT','ETH/USDT',3350,'bn','Crypto'],['SOLUSDT','SOL/USDT',172,'bn','Crypto'],['BNBUSDT','BNB/USDT',590,'bn','Crypto'],['XRPUSDT','XRP/USDT',0.52,'bn','Crypto'],['DOGEUSDT','DOGE/USDT',0.155,'bn','Crypto'],\n['xyz:NVDA','NVDA',180,'hl','Stocks'],['xyz:TSLA','TSLA',420,'hl','Stocks'],['xyz:AAPL','AAPL',230,'hl','Stocks'],['xyz:SILVER','Silver',48,'hl','Commodities'],['xyz:CL','Crude oil',62,'hl','Commodities'],['xyz:XYZ100','XYZ100 index',25000,'hl','Indices']];\nconst custom=(()=>{try{return JSON.parse(localStorage.getItem('tk.custom')||'[]')}catch(e){return[]}})();custom.forEach(c=>{if(!SYMS.some(x=>x[0]===c[0]))SYMS.push(c)});\nconst TFS=HOST?[['1m',60e3],['5m',300e3],['15m',900e3],['30m',1800e3],['1h',3600e3],['4h',14400e3],['8h',28800e3],['1d',86400e3],['3d',259200e3],['1w',604800e3],['1M',2629800e3]]:[['5m',300e3],['15m',900e3],['30m',1800e3],['1h',3600e3],['4h',14400e3],['8h',28800e3],['1d',86400e3],['3d',259200e3],['1w',604800e3],['1M',2629800e3]];\nconst HIST={};\nconst MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],p2=n=>String(n).padStart(2,'0');\nconst S={sym:'BTCUSDT',tf:'1h',off:6,bw:6,yz:1,yo:0,vol:true,tpo:false,tpoDay:0,ind:null,code:'',tab:'chart',lock:false,theme:'auto'};\nlet TF=3600e3,C=[],BASE={},LIVE=false,LTF=null,tpoD=null,dirty=true;\nfunction fmtP(p){const a=Math.abs(p);const d=a>=1000?2:a>=100?2:a>=10?3:a>=1?4:5;return p.toFixed(d)}\nfunction fmtV(v){return v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?(v/1e3).toFixed(1)+'k':v.toFixed(0)}\nfunction fmtT(t,long){const d=new Date(t),hm=p2(d.getHours())+':'+p2(d.getMinutes()),dm=d.getDate()+' '+MON[d.getMonth()];return TF>=2e9?MON[d.getUTCMonth()]+' '+d.getUTCFullYear():TF>=864e5?dm+(TF>=2592e5?' '+d.getFullYear():''):(long?dm+' '+hm:hm)}\nfunction rng(seed){let s=seed>>>0;return()=>{s=(s+0x6D2B79F5)>>>0;let t=s;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}\nfunction gauss(r){return Math.sqrt(-2*Math.log(r()||1e-9))*Math.cos(2*Math.PI*r())}\nfunction hash(s){let h=7;for(const c of s)h=(h*31+c.charCodeAt(0))>>>0;return h}\nfunction genBase(id,start){\n const r=rng(hash(id)),N=30*288,now=Math.floor(Date.now()/300e3)*300e3,out=[],H=[];\n const vb=start>1000?40:start>100?400:start>1?9000:900000;\n let p=start*(0.9+r()*0.2),vol=0.001;\n const t0=Math.floor((now-(N-1)*300e3)/3600e3)*3600e3-3600e3,NH=1095*24;\n for(let i=0;i<NH;i++){const t=t0-(NH-1-i)*3600e3,o=p,ret=gauss(r)*0.0032+0.00003*Math.sin(i/900)-0.0004*Math.log(p/start),c=o*Math.exp(ret);p=c;\n  H.push({t,o,h:Math.max(o,c)*(1+Math.abs(gauss(r))*0.0016),l:Math.min(o,c)*(1-Math.abs(gauss(r))*0.0016),c,v:vb*12*(0.5+r()*1.5)})}\n HIST[id]=H;\n for(let i=0;i<N;i++){\n  const t=now-(N-1-i)*300e3,hr=new Date(t).getUTCHours();\n  vol=Math.max(0.0005,Math.min(0.0028,vol*0.985+0.000012+Math.abs(gauss(r))*0.00012));\n  const sess=1+0.4*Math.sin((hr-8)/24*2*Math.PI),o=p,ret=gauss(r)*vol*sess+0.00004*Math.sin(i/260);\n  const c=o*Math.exp(ret);p=c;\n  out.push({t,o,h:Math.max(o,c)*(1+Math.abs(gauss(r))*vol*0.5),l:Math.min(o,c)*(1-Math.abs(gauss(r))*vol*0.5),c,v:vb*(0.5+r()*1.5)*(1+Math.abs(ret)/vol)});\n }\n return out}\nfunction bucket(t,ms){\n if(ms>2e9){const d=new Date(t);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)}\n if(ms===604800e3)return Math.floor((t-4*864e5)/ms)*ms+4*864e5;\n return Math.floor(t/ms)*ms}\nfunction nextClose(t){if(TF>2e9){const d=new Date(t);return Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)}return t+TF}\nfunction aggTf(base,ms,id){\n if(ms===300e3)return base.slice();\n if(ms>=3600e3&&id&&HIST[id])base=HIST[id].concat(base);\n const out=[];let cur=null;\n for(const b of base){const k=bucket(b.t,ms);\n  if(cur&&cur.t===k){cur.h=Math.max(cur.h,b.h);cur.l=Math.min(cur.l,b.l);cur.c=b.c;cur.v+=b.v}\n  else{cur={t:k,o:b.o,h:b.h,l:b.l,c:b.c,v:b.v};out.push(cur)}}\n return out}\nfunction niceStep(r,c){const raw=r/c,m=Math.pow(10,Math.floor(Math.log10(raw))),f=raw/m;return(f<1.5?1:f<3.5?2:f<7.5?5:10)*m}\n/* TPO / Market Profile for one UTC session, 30-minute letters */\nfunction computeTPO(base,dayOff){\n if(!base||!base.length)return null;\n const DAY=864e5,day=Math.floor(base[base.length-1].t/DAY)-dayOff,bars=[];\n for(let i=base.length-1;i>=0;i--){const d=Math.floor(base[i].t/DAY);if(d===day)bars.push(base[i]);else if(d<day)break}\n bars.reverse();if(!bars.length)return null;\n let hi=-1e99,lo=1e99;bars.forEach(b=>{hi=Math.max(hi,b.h);lo=Math.min(lo,b.l)});\n const tick=niceStep(hi-lo||hi*0.01,48),k0=Math.floor(lo/tick),k1=Math.floor(hi/tick),m=k1-k0+1,rows=Array.from({length:m},()=>[]);\n let ibHi=-1e99,ibLo=1e99;\n for(const b of bars){const per=Math.floor((b.t-day*DAY)/1800e3);\n  if(b.t<day*DAY+3600e3){ibHi=Math.max(ibHi,b.h);ibLo=Math.min(ibLo,b.l)}\n  for(let k=Math.floor(b.l/tick);k<=Math.floor(b.h/tick);k++){const row=rows[k-k0];if(row&&!row.includes(per))row.push(per)}}\n const cnt=rows.map(r=>r.length),mid=(hi+lo)/2;\n let poc=0;cnt.forEach((c,i)=>{const pi=Math.abs((k0+i+0.5)*tick-mid),bi=Math.abs((k0+poc+0.5)*tick-mid);if(c>cnt[poc]||(c===cnt[poc]&&pi<bi))poc=i});\n const total=cnt.reduce((a,b)=>a+b,0);let a=poc,b=poc,sum=cnt[poc];\n while(sum<total*0.7){const u=(cnt[b+1]||0)+(cnt[b+2]||0),d=(cnt[a-1]||0)+(cnt[a-2]||0);if(!u&&!d)break;if(u>=d){b=Math.min(m-1,b+2);sum+=u}else{a=Math.max(0,a-2);sum+=d}}\n return{day,k0,tick,rows,poc:k0+poc,vah:(k0+b+1)*tick,val:(k0+a)*tick,ibHi,ibLo,hi,lo,open:bars[0].o,close:bars[bars.length-1].c,pocP:(k0+poc+0.5)*tick}}\nfunction refreshTPO(){tpoD=computeTPO(BASE[S.sym],S.tpoDay);const l=$('#tpoLbl');if(l)l.textContent=tpoD?(S.tpoDay?new Date(tpoD.day*864e5).getUTCDate()+' '+MON[new Date(tpoD.day*864e5).getUTCMonth()]+' UTC':'Today UTC'):'no data'}\nconst cv=$('#cv'),g=cv.getContext('2d');\nconst STYLE=Object.assign({up:'',dn:'',bUp:'',bDn:'',wUp:'',wDn:'',bodyA:1,borderA:1,wickA:1,hGrid:false,vGrid:false},(()=>{try{return JSON.parse(localStorage.getItem('tk.style')||'{}')}catch(e){return{}}})());\nlet QA=null,W=0,H=0,dpr=1,L={},V={},K={},drawings=[],sel=null,pend=null,cross=null,alerts=store.get('tk.alerts',[]);\nconst LET='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwx';\nfunction resize(){const r=cv.parentElement.getBoundingClientRect();if(!r.width)return;dpr=window.devicePixelRatio||1;W=r.width;H=r.height;cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);dirty=true}\nconst nB=()=>C.length;\nconst X=i=>L.R-(nB()-1-i+S.off)*S.bw-S.bw/2;\nconst I=x=>nB()-1+S.off-(L.R-x-S.bw/2)/S.bw;\nfunction idxT(t){const n=C.length;if(t<=C[0].t)return(t-C[0].t)/TF;if(t>=C[n-1].t)return n-1+(t-C[n-1].t)/TF;let lo=0,hi=n-1;while(hi-lo>1){const m=(lo+hi)>>1;if(C[m].t<=t)lo=m;else hi=m}return lo+(t-C[lo].t)/(C[hi].t-C[lo].t)}\nfunction tOf(x){const i=I(x),n=C.length;if(i<=0)return C[0].t+i*TF;if(i>=n-1)return C[n-1].t+(i-(n-1))*TF;const lo=Math.floor(i);return C[lo].t+(i-lo)*(C[lo+1].t-C[lo].t)}\nconst Y=p=>L.pT+(V.mx-p)/(V.mx-V.mn)*(L.pB-L.pT);\nconst Pp=y=>V.mx-(y-L.pT)/(L.pB-L.pT)*(V.mx-V.mn);\nfunction readColors(){const s=getComputedStyle(document.documentElement);['bg','panel','line','fg','mute','up','dn','acc','grid'].forEach(k=>K[k]=s.getPropertyValue('--'+k).trim());\n const st=STYLE;K.cu=st.up||K.up;K.cd=st.dn||K.dn;K.bu=st.bUp||K.cu;K.bd=st.bDn||K.cd;K.wu=st.wUp||K.cu;K.wd=st.wDn||K.cd}\nconst ca=(c,a)=>a>=1?c:Pine.rgba(c,(1-a)*100);\nfunction layout(){\n g.font=F10;const lp=C.length?C[C.length-1].c:0,AX=Math.max(36,Math.min(64,Math.ceil(g.measureText(fmtP(lp)).width)+10)),BX=18;\n const tw=S.tpo?Math.min(168,Math.floor(W*0.34)):0,mainH=H-BX,np=S.panes?S.panes.length:0,pane=np>0;\n const ph=pane?Math.floor(mainH*Math.min(0.52,0.28*np)):0,priceH=mainH-ph-(pane?6:0);\n L={AX,BX,tw,R:W-AX-tw,priceH,paneTop:priceH+6,paneH:ph,mainH,pT:8,pB:priceH-(S.vol?priceH*0.17:10)}}\nfunction range(){\n const lo=Math.max(0,Math.floor(I(0))),hi=Math.min(nB()-1,Math.ceil(I(L.R)));let mn=1e99,mx=-1e99,vm=0;\n for(let i=lo;i<=hi;i++){const c=C[i];if(c.l<mn)mn=c.l;if(c.h>mx)mx=c.h;if(c.v>vm)vm=c.v}\n if(mn>mx){mn=0;mx=1}const pad=(mx-mn)*0.08||mx*0.01;let a=mn-pad,b=mx+pad;\n if(S.yz!==1||S.yo!==0){const sp0=b-a,c0=(a+b)/2;S.yz=Math.max(0.15,Math.min(8,S.yz));const lim=(S.yz/2+0.5)*0.85;S.yo=Math.max(-lim,Math.min(lim,S.yo));const sp1=sp0*S.yz,c1=c0+S.yo*sp0;a=c1-sp1/2;b=c1+sp1/2}\n V={lo,hi,mn:a,mx:b,vm:vm||1}}\nfunction line(a,b){g.beginPath();g.moveTo(a.x,a.y);g.lineTo(b.x,b.y);g.stroke()}\nfunction tag(txt,x,y,bg,fg){const w=g.measureText(txt).width+8;g.fillStyle=bg;g.fillRect(x,y-8,w,16);g.fillStyle=fg;g.textBaseline='middle';g.textAlign='left';g.fillText(txt,x+4,y)}\nconst F10='10px \"IBM Plex Mono\",ui-monospace,monospace',F11='11px \"IBM Plex Mono\",ui-monospace,monospace';\nfunction plotSeries(pl,yf){\n const lo=Math.max(0,V.lo-1),hi=Math.min(nB()-1,V.hi+1),col=pl.color,arr=Array.isArray(col);g.lineWidth=pl.width||1;g.setLineDash([]);\n if(pl.style.includes('histogram')){const y0=yf(0);for(let i=lo;i<=hi;i++){const v=pl.data[i];if(v!==v)continue;g.fillStyle=arr?col[i]:col;const y=yf(v);g.fillRect(X(i)-S.bw*0.35,Math.min(y0,y),Math.max(1,S.bw*0.7),Math.abs(y-y0)||1)}return}\n if(pl.style.includes('circles')||pl.style.includes('cross')){for(let i=lo;i<=hi;i++){const v=pl.data[i];if(v!==v)continue;g.fillStyle=arr?col[i]:col;g.beginPath();g.arc(X(i),yf(v),2,0,7);g.fill()}return}\n if(!arr){g.strokeStyle=col;g.beginPath();let pen=false;for(let i=lo;i<=hi;i++){const v=pl.data[i];if(v!==v){pen=false;continue}pen?g.lineTo(X(i),yf(v)):g.moveTo(X(i),yf(v));pen=true}g.stroke();return}\n for(let i=Math.max(1,lo);i<=hi;i++){const a=pl.data[i-1],b=pl.data[i];if(a!==a||b!==b)continue;g.strokeStyle=col[i];line({x:X(i-1),y:yf(a)},{x:X(i),y:yf(b)})}}\nfunction timeTicks(){\n const out=[];\n if(TF>=2592e5){const k=Math.max(1,Math.ceil(110/S.bw));for(let i=V.lo;i<=V.hi;i++)if(i%k===0)out.push([i,fmtT(C[i].t)]);return out}\n const iv=[3e5,9e5,18e5,36e5,72e5,144e5,216e5,432e5,864e5,1728e5,6048e5].find(v=>v>=TF&&v/TF*S.bw>=64)||6048e5;\n for(let i=V.lo;i<=V.hi;i++){if(C[i].t%iv===0){const d=new Date(C[i].t);out.push([i,TF>=864e5||iv>=864e5||(d.getHours()===0&&d.getMinutes()===0)?d.getDate()+' '+MON[d.getMonth()]:p2(d.getHours())+':'+p2(d.getMinutes())])}}\n return out}\nfunction drawGrid(){\n const st=niceStep(V.mx-V.mn,L.priceH/55);g.strokeStyle=K.grid;g.lineWidth=1;g.setLineDash([]);\n if(STYLE.hGrid)for(let p=Math.ceil(V.mn/st)*st;p<V.mx;p+=st){const y=Math.round(Y(p))+.5;line({x:0,y},{x:L.R+L.tw,y})}\n if(STYLE.vGrid)timeTicks().forEach(t=>{const x=Math.round(X(t[0]))+.5;line({x,y:0},{x,y:L.mainH})})}\nfunction drawAxes(){\n g.font=F10;g.fillStyle=K.bg;g.fillRect(L.R+L.tw,0,L.AX,L.priceH);g.fillRect(0,L.mainH,W,L.BX);\n g.strokeStyle=K.line;line({x:L.R+L.tw+.5,y:0},{x:L.R+L.tw+.5,y:L.mainH});line({x:0,y:L.mainH+.5},{x:W,y:L.mainH+.5});\n g.fillStyle=K.mute;g.textBaseline='middle';g.textAlign='left';\n const st=niceStep(V.mx-V.mn,L.priceH/55),ax=L.R+L.tw+6;\n const dec=st>=1?0:Math.min(7,Math.ceil(-Math.log10(st)-1e-9));\n for(let p=Math.ceil(V.mn/st)*st;p<V.mx;p+=st){const y=Y(p);if(y>10&&y<L.priceH-6)g.fillText(p.toFixed(dec),ax,y)}\n g.textAlign='center';let lx=-99;timeTicks().forEach(t=>{const x=X(t[0]);if(x>14&&x<L.R-10&&x-lx>g.measureText(t[1]).width+14){g.fillText(t[1],x,L.mainH+10);lx=x}});\n {const n=new Date();g.fillStyle=K.fg;g.fillText(p2(n.getHours())+':'+p2(n.getMinutes())+':'+p2(n.getSeconds()),L.R+L.tw+L.AX/2,L.mainH+10)}\n const last=C[nB()-1],ly=Y(last.c),lc=last.c>=last.o?K.cu:K.cd;g.textAlign='left';const lyc=Math.max(10,Math.min(L.priceH-10,ly));tag(fmtP(last.c),ax-6,lyc,lc,'#fff');\n const rem=Math.max(0,nextClose(last.t)-Date.now()),sec=Math.floor(rem/1000),dd=Math.floor(sec/86400),tm=dd?dd+'d '+Math.floor(sec%86400/3600)+'h':p2(Math.floor(sec/3600))+':'+p2(Math.floor(sec%3600/60))+':'+p2(sec%60);\n tag(tm,ax-6,Math.min(L.priceH-8,lyc+17),K.panel,K.fg);g.font=F11}\nfunction drawCandlesFar(xc){\n const cols=new Map();\n for(let i=V.lo;i<=V.hi;i++){const c=C[i],x=Math.round(X(i)),o=(S.ind&&S.ind.barcolor&&S.ind.barcolor[i])||(xc&&xc[i]),e=cols.get(x);\n  if(!e)cols.set(x,{h:c.h,l:c.l,o:c.o,c:c.c,ov:o});else{if(c.h>e.h)e.h=c.h;if(c.l<e.l)e.l=c.l;e.c=c.c;if(o)e.ov=o}}\n g.lineWidth=1;g.setLineDash([]);\n cols.forEach((e,x)=>{g.strokeStyle=ca(e.ov||(e.c>=e.o?K.wu:K.wd),Math.max(.6,STYLE.wickA));g.beginPath();g.moveTo(x+.5,Y(e.h));g.lineTo(x+.5,Y(e.l));g.stroke()})}\nfunction drawCandles(){\n const bw=S.bw,body=Math.max(1,Math.floor(bw*0.68));\n if(S.vol){g.globalAlpha=.3;const st=bw<1?Math.ceil(1/bw):1;for(let i=V.lo;i<=V.hi;i+=st){const c=C[i],h=c.v/V.vm*L.priceH*0.14;g.fillStyle=c.c>=c.o?K.cu:K.cd;g.fillRect(Math.round(X(i)-body/2),L.priceH-2-h,body,h)}g.globalAlpha=1}\n g.lineWidth=1;g.setLineDash([]);const xc=x2cols();\n if(bw<1.6)drawCandlesFar(xc);else for(let i=V.lo;i<=V.hi;i++){const c=C[i],up=c.c>=c.o,x=Math.round(X(i)),y1=Y(Math.max(c.o,c.c)),y2=Y(Math.min(c.o,c.c)),bh=Math.max(1,y2-y1),ov=(S.ind&&S.ind.barcolor&&S.ind.barcolor[i])||(xc&&xc[i]);\n  g.strokeStyle=ca(ov||(up?K.wu:K.wd),STYLE.wickA);g.beginPath();g.moveTo(x+.5,Y(c.h));g.lineTo(x+.5,Y(c.l));g.stroke();\n  if(bw>=3){g.fillStyle=ca(ov||(up?K.cu:K.cd),STYLE.bodyA);g.fillRect(x-body/2,y1,body,bh);\n   if(bw>=5){g.strokeStyle=ca(ov||(up?K.bu:K.bd),STYLE.borderA);g.strokeRect(x-body/2+.5,y1+.5,body-1,Math.max(0,bh-1))}}}\n const last=C[nB()-1],y=Math.round(Y(last.c))+.5;g.strokeStyle=last.c>=last.o?K.cu:K.cd;g.setLineDash([3,3]);line({x:0,y},{x:L.R+L.tw,y});g.setLineDash([])}\nfunction drawShapes(ind){\n for(const sp of ind.shapes){\n  for(let i=V.lo;i<=V.hi;i++){if(!sp.cond[i])continue;const c=C[i],below=sp.loc==='belowbar',x=X(i),y=below?Y(c.l)+10:Y(c.h)-10,col=Array.isArray(sp.color)?sp.color[i]:sp.color,up=sp.style.includes('up')||(below&&!sp.style.includes('down'));\n   g.fillStyle=col;\n   if(sp.style.includes('label')){const w=Math.max(22,g.measureText(sp.text).width+10),yy=below?y+8:y-8;g.fillRect(x-w/2,yy-(below?0:18),w,18);g.fillStyle='#fff';g.textAlign='center';g.textBaseline='middle';g.fillText(sp.text,x,yy+(below?9:-9))}\n   else if(sp.style.includes('circle')||sp.style.includes('xcross')||sp.style.includes('diamond')){g.beginPath();g.arc(x,y,4,0,7);g.fill()}\n   else{g.beginPath();if(up){g.moveTo(x,y-5);g.lineTo(x-5,y+4);g.lineTo(x+5,y+4)}else{g.moveTo(x,y+5);g.lineTo(x-5,y-4);g.lineTo(x+5,y-4)}g.fill();\n    if(sp.text&&S.bw>=6){g.textAlign='center';g.textBaseline='middle';g.fillText(sp.text,x,below?y+16:y-16)}}}}}\nfunction drawPineObjs(ind){\n if(!ind.boxes)return;\n const xs=v=>X(v),ok=v=>v===v&&v!==null&&v!==undefined;\n for(const b of ind.boxes){if(b.deleted||!ok(b.top)||!ok(b.bottom))continue;\n  const x1=xs(b.left),x2=xs(b.right);if(Math.max(x1,x2)<0||Math.min(x1,x2)>L.R)continue;\n  const y1=Y(b.top),y2=Y(b.bottom),w=x2-x1,h=y2-y1;\n  if(b.bgcolor&&typeof b.bgcolor==='string'){g.fillStyle=b.bgcolor;g.fillRect(Math.min(x1,x2),Math.min(y1,y2),Math.abs(w),Math.abs(h))}\n  if(b.border_color&&typeof b.border_color==='string'){g.strokeStyle=b.border_color;g.lineWidth=b.border_width||1;g.setLineDash([]);g.strokeRect(Math.min(x1,x2),Math.min(y1,y2),Math.abs(w),Math.abs(h))}\n  if(b.text&&Math.abs(h)>=8){g.fillStyle=b.text_color||K.fg;g.textBaseline='middle';g.textAlign='right';g.font=(Math.min(11,Math.abs(h)-1))+'px \"IBM Plex Mono\",monospace';g.fillText(b.text,Math.max(x1,x2)-3,(y1+y2)/2);g.font='11px \"IBM Plex Mono\",ui-monospace,monospace'}}\n g.setLineDash([]);\n for(const l of ind.lines){if(l.deleted||!ok(l.y1)||!ok(l.y2))continue;g.strokeStyle=l.color||K.fg;g.lineWidth=l.width||1;\n  let a={x:xs(l.x1),y:Y(l.y1)},b2={x:xs(l.x2),y:Y(l.y2)};if(l.extend&&/right|both/.test(l.extend)&&b2.x!==a.x){const k=(b2.y-a.y)/(b2.x-a.x);b2={x:L.R,y:a.y+k*(L.R-a.x)}}line(a,b2)}\n g.textBaseline='middle';g.textAlign='center';\n for(const t of ind.labels){if(t.deleted||!ok(t.y))continue;g.fillStyle=t.textcolor||K.fg;g.fillText(String(t.text),xs(t.x),Y(t.y))}}\nfunction drawPineTables(ind){\n if(!ind||!ind.tables)return;const sz={tiny:9,small:11,normal:13,large:16,huge:20,auto:11};\n for(const t of ind.tables){if(t.deleted)continue;const cells=Object.values(t.cells);if(!cells.length)continue;\n  const rows=cells.filter(c=>c.text!==''&&c.text!==undefined);if(!rows.length)continue;\n  const fs=Math.min(...rows.map(c=>sz[c.text_size]||11)),lh=fs+6;let w=0;rows.forEach(c=>{g.font=fs+'px \"IBM Plex Mono\",monospace';w=Math.max(w,g.measureText(c.text).width+12)});\n  const hgt=rows.length*lh,pos=String(t.pos||'');const x0=/left/.test(pos)?6:L.R-w-6,y0=/top/.test(pos)?6:/middle/.test(pos)?(L.priceH-hgt)/2:L.priceH-hgt-6;\n  rows.sort((a,b)=>a.row-b.row||a.col-b.col).forEach((c,i)=>{g.fillStyle=c.bgcolor||t.bgcolor||K.panel;g.fillRect(x0,y0+i*lh,w,lh);g.fillStyle=c.text_color||K.fg;g.textAlign='left';g.textBaseline='middle';g.fillText(c.text,x0+6,y0+i*lh+lh/2)});\n  if(t.frame_color&&t.frame_width){g.strokeStyle=t.frame_color;g.lineWidth=1;g.strokeRect(x0,y0,w,hgt)}}\n g.font='11px \"IBM Plex Mono\",ui-monospace,monospace'}\nfunction drawPane(){if(!S.panes||!S.panes.length||!L.paneH)return;const n=S.panes.length,h=Math.floor(L.paneH/n);S.panes.forEach((ind,k)=>drawOnePane(ind,L.paneTop+k*h,h))}\nfunction drawOnePane(ind,top,h){\n g.save();g.beginPath();g.rect(0,top,L.R+L.tw,h);g.clip();g.strokeStyle=K.line;g.strokeRect(.5,top+.5,L.R+L.tw-1,h-1);\n let mn=1e99,mx=-1e99;const lo=V.lo,hi=V.hi;\n for(const pl of ind.plots)for(let i=lo;i<=hi;i++){const v=pl.data[i];if(v===v){mn=Math.min(mn,v);mx=Math.max(mx,v)}if(pl.style.includes('histogram')){mn=Math.min(mn,0);mx=Math.max(mx,0)}}\n ind.hlines.forEach(l=>{mn=Math.min(mn,l.y);mx=Math.max(mx,l.y)});if(mn>mx){mn=0;mx=1}const pd=(mx-mn)*0.1||1;mn-=pd;mx+=pd;\n const yf=v=>top+4+(mx-v)/(mx-mn)*(h-8);\n g.setLineDash([4,4]);ind.hlines.forEach(l=>{g.strokeStyle=l.color;line({x:0,y:yf(l.y)},{x:L.R+L.tw,y:yf(l.y)})});g.setLineDash([]);\n ind.plots.forEach(pl=>plotSeries(pl,yf));\n g.restore();\n g.fillStyle=K.bg;g.fillRect(L.R+L.tw+1,top,L.AX,h);g.fillStyle=K.mute;g.textAlign='left';g.textBaseline='middle';g.font=F10;\n g.fillText(fmtP(mx-pd),L.R+L.tw+4,top+10);g.fillText(fmtP(mn+pd),L.R+L.tw+4,top+h-10);g.font=F11;\n g.textAlign='left';g.fillText(ind.title,6,top+10)}\nfunction drawTPO(){\n const T=tpoD;if(!S.tpo||!L.tw)return;const x0=L.R,w=L.tw;\n g.fillStyle=K.panel;g.fillRect(x0,0,w,L.priceH);g.strokeStyle=K.line;line({x:x0+.5,y:0},{x:x0+.5,y:L.priceH});\n if(!T)return;\n g.save();g.beginPath();g.rect(0,0,x0+w,L.priceH);g.clip();\n const mc=Math.max(...T.rows.map(r=>r.length)),lw=Math.min(9,(w-12)/mc),vaTop=T.vah,vaBot=T.val;\n g.textBaseline='middle';g.textAlign='left';\n T.rows.forEach((row,r)=>{const kp=(T.k0+r)*T.tick,yT=Y(kp+T.tick),yB=Y(kp),h=yB-yT;if(yB<0||yT>L.priceH)return;\n  const inVA=kp>=vaBot-1e-9&&kp+T.tick<=vaTop+1e-9,isPoc=T.k0+r===T.poc;\n  if(isPoc){g.fillStyle=K.acc;g.globalAlpha=.28;g.fillRect(x0+2,yT,w-4,h);g.globalAlpha=1}else if(inVA){g.fillStyle=K.acc;g.globalAlpha=.09;g.fillRect(x0+2,yT,w-4,h);g.globalAlpha=1}\n  row.forEach((per,j)=>{const x=x0+6+j*lw,ib=per<2;g.fillStyle=ib?K.acc:K.fg;g.globalAlpha=ib?1:.78;\n   if(h>=7&&lw>=5){g.font=(isPoc?'500 ':'400 ')+Math.min(10,h-1)+'px \"IBM Plex Mono\",monospace';g.fillText(LET[per%LET.length],x,yT+h/2)}else g.fillRect(x,yT+0.5,Math.max(1,lw-1),Math.max(1,h-1));g.globalAlpha=1})});\n g.font='11px \"IBM Plex Mono\",ui-monospace,monospace';\n const lv=(p,txt,col,dash)=>{const y=Math.round(Y(p))+.5;g.strokeStyle=col;g.setLineDash(dash);line({x:0,y},{x:x0,y});g.setLineDash([]);g.fillStyle=col;g.textAlign='right';g.fillText(txt,x0-4,y-7)};\n lv(T.pocP,'POC '+fmtP(T.pocP),K.acc,[]);lv(T.vah,'VAH',K.mute,[5,4]);lv(T.val,'VAL',K.mute,[5,4]);\n if(T.ibHi>0){g.globalAlpha=.6;lv(T.ibHi,'IBH',K.up,[2,4]);lv(T.ibLo,'IBL',K.dn,[2,4]);g.globalAlpha=1}\n g.restore()}\nfunction drawAlerts(){\n g.font='11px \"IBM Plex Mono\",ui-monospace,monospace';\n for(const a of alerts){if(a.sym!==S.sym||!a.on)continue;const y=Math.round(Y(a.price))+.5;if(y<0||y>L.priceH)continue;g.strokeStyle=K.acc;g.setLineDash([2,3]);line({x:0,y},{x:L.R+L.tw,y});g.setLineDash([]);g.fillStyle=K.acc;g.textAlign='left';g.fillText('Alert '+(a.dir==='above'?'>':'<')+' '+fmtP(a.price),6,y-7)}}\nconst btnX=()=>L.R+L.tw-14;\nfunction drawQA(){\n g.font=F10;const bx=btnX();\n for(const a of alerts){if(a.sym!==S.sym||!a.on)continue;const y=Y(a.price);if(y<10||y>L.priceH-8)continue;\n  g.fillStyle=K.acc;g.beginPath();g.arc(bx,y,10,0,7);g.fill();g.strokeStyle=K.bg;g.lineWidth=2;g.beginPath();g.moveTo(bx-4,y-4);g.lineTo(bx+4,y+4);g.moveTo(bx+4,y-4);g.lineTo(bx-4,y+4);g.stroke()}\n if(QA){const y=Y(QA.price);if(y>8&&y<L.priceH-6){g.strokeStyle=K.acc;g.lineWidth=1;g.setLineDash([5,4]);line({x:0,y},{x:L.R+L.tw,y});g.setLineDash([]);\n  g.textAlign='left';tag(fmtP(QA.price),L.R+L.tw,y,K.acc,'#111');\n  g.fillStyle=K.acc;g.beginPath();g.arc(bx,y,11,0,7);g.fill();g.strokeStyle='#111';g.lineWidth=2.2;g.beginPath();g.moveTo(bx-5,y);g.lineTo(bx+5,y);g.moveTo(bx,y-5);g.lineTo(bx,y+5);g.stroke()}}g.font=F11}\nfunction drawCross(){\n if(!cross)return;const x=cross.x,y=cross.y;if(x<0||x>L.R+L.tw||y<0||y>L.mainH)return;\n g.strokeStyle=K.mute;g.setLineDash([4,4]);line({x,y:0},{x,y:L.mainH});line({x:0,y},{x:L.R+L.tw,y});g.setLineDash([]);\n g.font=F10;\n if(y<L.priceH)tag(fmtP(Pp(y)),L.R+L.tw,y,K.fg,K.bg);\n const i=Math.max(0,Math.min(nB()-1,Math.round(I(x))));g.textAlign='left';const lab=fmtT(C[i].t,true),w=g.measureText(lab).width+10;tag(lab,Math.max(0,Math.min(W-w,x-w/2)),L.mainH+9,K.fg,K.bg);g.font=F11}\nfunction drawReadout(){\n const i=cross?Math.max(0,Math.min(nB()-1,Math.round(I(cross.x)))):nB()-1,c=C[i];if(!c)return;\n g.font='11px \"IBM Plex Mono\",ui-monospace,monospace';g.textAlign='left';g.textBaseline='top';\n const col=c.c>=c.o?K.up:K.dn,items=[['O',c.o],['H',c.h],['L',c.l],['C',c.c]];let x=8;\n items.forEach(it=>{g.fillStyle=K.mute;g.fillText(it[0],x,6);x+=g.measureText(it[0]).width+3;g.fillStyle=col;const s=fmtP(it[1]);g.fillText(s,x,6);x+=g.measureText(s).width+8});\n g.fillStyle=K.mute;g.fillText(fmtT(c.t,true)+'   Vol '+fmtV(c.v),8,20);\n const ind=S.ind;let y=34;\n if(ind&&!ind.err)(ind.all||ind.plots).slice(0,4).forEach(pl=>{const v=pl.data[i];if(v!==v)return;g.fillStyle=Array.isArray(pl.color)?K.fg:pl.color;g.fillText(pl.name+' '+fmtP(v),8,y);y+=13})}\nfunction draw(){\n if(!W||!C.length)return;readColors();layout();range();\n g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,W,H);g.fillStyle=K.bg;g.fillRect(0,0,W,H);\n g.font='11px \"IBM Plex Mono\",ui-monospace,monospace';\n g.save();g.beginPath();g.rect(0,0,L.R+L.tw,L.priceH);g.clip();\n drawGrid();drawDelta();drawCandles();\n if(S.ind&&!S.ind.err){g.save();g.beginPath();g.rect(0,0,L.R,L.priceH);g.clip();if(S.ind.overlay)S.ind.plots.forEach(pl=>plotSeries(pl,Y));drawShapes(S.ind);drawPineObjs(S.ind);g.restore()}\n drawAlerts();\n g.save();g.beginPath();g.rect(0,0,L.R,L.priceH);g.clip();drawDrawings();g.restore();\n g.restore();\n if(S.ind&&!S.ind.err){g.save();g.beginPath();g.rect(0,0,L.R+L.tw,L.priceH);g.clip();drawPineTables(S.ind);g.restore()}\n drawTPO();drawPane();drawAxes();drawQA();drawCross();drawReadout();syncAuto()}\nfunction loop(){if(dirty&&$('#v-chart').classList.contains('on')){dirty=false;try{draw();maybeOlder()}catch(e){console.error(e)}}requestAnimationFrame(loop)}\n/* Delta Profile (multi-session) + X2 volume highlighter. Native port of the user's Pine script. */\nconst DELTA=Object.assign({on:false,sess:'Auto',method:'polarity',box:0.5,poc:'#ffc800',buy:'#2962ff',sell:'#ff1744',text:true,pocLine:true,pocLineC:'#ff3b30',noise:'off',level:5,rows:20,x2:false,period:20,mult:2,outBull:'#00e676',outBear:'#f23645',norm:'#787b86'},(()=>{try{return JSON.parse(localStorage.getItem('tk.delta')||'{}')}catch(e){return{}}})());\nconst saveDelta=()=>{store.set('tk.delta',DELTA);dirty=true};\nlet DC={key:'',sess:[],col:null,len:0};\nfunction sessLen(){const m=DELTA.sess;if(m==='4H')return 144e5;if(m==='12H')return 432e5;if(m==='3D')return 2592e5;return TF===900e3?432e5:TF===3600e3?2592e5:144e5}\nconst sessName=l=>l===144e5?'4Hr':l===432e5?'12Hr':'3D';\nfunction emaArr(v,p){const o=new Array(v.length),k=2/(p+1);let e=0,s=0;for(let i=0;i<v.length;i++){if(i<p){s+=v[i];e=s/(i+1)}else e=v[i]*k+e*(1-k);o[i]=e}return o}\nfunction computeDelta(){\n const n=C.length;if(!n)return DC;\n const len=sessLen(),l=C[n-1],key=[S.sym,S.tf,n,l.t,l.c,l.v,len,DELTA.method,DELTA.box,DELTA.noise,DELTA.level,DELTA.rows,DELTA.period,DELTA.mult,DELTA.x2,DELTA.on].join('|');\n if(DC.key===key)return DC;\n const ema=emaArr(C.map(c=>c.v),DELTA.period),sess=[];\n let i0=0;\n for(let i=1;i<=n;i++){\n  if(i===n||Math.floor(C[i].t/len)!==Math.floor(C[i0].t/len)){\n   let hi=-1e99,lo=1e99;for(let j=i0;j<i;j++){hi=Math.max(hi,C[j].h);lo=Math.min(lo,C[j].l)}\n   let sh=0,sl=0,cnt=0;for(let j=Math.max(0,i0-95);j<=i0;j++){sh+=C[j].h;sl+=C[j].l;cnt++}\n   let tick=(sh-sl)/cnt/DELTA.rows;if(!(tick>0))tick=(hi-lo)/DELTA.rows||hi*1e-4;tick=+tick.toPrecision(2);\n   let R=Math.max(1,Math.ceil((hi-lo)/tick));if(R>400){tick=(hi-lo)/400;R=400}\n   const rows=[];\n   for(let r=0;r<R;r++){const rl=lo+r*tick,rt=rl+tick;let tot=0,bull=0;\n    for(let j=i0;j<i;j++){const c=C[j];if(c.h>=rl&&c.l<rt){tot+=c.v;if(DELTA.method==='pressure'?(c.c-c.l)>(c.h-c.c):c.c>c.o)bull+=c.v}}\n    rows.push({rl,rt,tot,delta:2*bull-tot})}\n   let poc=0,mx=-1;const mid=(hi+lo)/2;\n   rows.forEach((r,k)=>{if(r.tot>mx||(r.tot===mx&&Math.abs(r.rl+tick/2-mid)<Math.abs(rows[poc].rl+tick/2-mid))){mx=r.tot;poc=k}});\n   let cut=null;\n   if(DELTA.noise!=='off'){const ab=rows.filter(r=>r.tot>0).map(r=>Math.abs(r.delta)).sort((a,b)=>a-b);\n    if(ab.length){const p=DELTA.noise==='low'?DELTA.level*9:100-DELTA.level*9;cut=ab[Math.max(1,Math.ceil(p/100*ab.length))-1]}}\n   const boxes=[],ev=ema[i-1]||1;let prev=null;\n   rows.forEach((r,k)=>{\n    if(r.tot===0){prev=null;return}\n    const isPoc=k===poc;\n    if(cut!==null&&(DELTA.noise==='low'?Math.abs(r.delta)<cut:Math.abs(r.delta)>cut)){prev=null;return}\n    const col=isPoc?DELTA.poc:(r.delta>=0?DELTA.buy:DELTA.sell),right=Math.round(Math.abs(r.delta)/ev*DELTA.box*10);\n    if(prev&&prev.right===right&&prev.col===col&&!isPoc&&!prev.isPoc){prev.top=r.rt;return}\n    prev={bottom:r.rl,top:r.rt,right,col,isPoc,txt:(r.delta<0?'-':'')+fmtV(Math.abs(r.delta))};boxes.push(prev)});\n   sess.push({i0,i1:i-1,tick,poc:rows[poc].rl,boxes});\n   i0=i}}\n let col=null;\n if(DELTA.x2){col=new Array(n);let si=0;\n  for(let i=0;i<n;i++){while(si<sess.length-1&&i>sess[si].i1)si++;const s=sess[si],own=i===s.i1,pp=own?s.poc:(si>0?sess[si-1].poc:null),c=C[i];\n   const heavy=c.v>ema[i]*DELTA.mult,bull=c.c>c.o,out=pp!==null&&(c.c>pp+s.tick||c.c<pp-s.tick);\n   col[i]=heavy&&out?(bull?DELTA.outBull:DELTA.outBear):DELTA.norm}}\n DC={key,sess,col,len};return DC}\nfunction x2cols(){return DELTA.x2?computeDelta().col:null}\nfunction drawDelta(){\n if(!DELTA.on||!C.length)return;const D=computeDelta();\n g.font='10px \"IBM Plex Mono\",ui-monospace,monospace';g.textBaseline='middle';\n for(const s of D.sess){if(s.i1<V.lo-1||s.i0>V.hi+1)continue;\n  const x0=X(s.i0);\n  for(const b of s.boxes){const x1=Math.max(x0+3,X(s.i0+b.right)),yt=Y(b.top),yb=Y(b.bottom),h=yb-yt;\n   g.fillStyle=b.col;g.fillRect(x0,yt,x1-x0,Math.max(1,h-0.5));\n   if(DELTA.text&&h>=9&&x1-x0>26){g.fillStyle='#fff';g.textAlign='right';g.fillText(b.txt,x1-3,yt+h/2)}}\n  if(DELTA.pocLine){const y=Math.round(Y(s.poc+s.tick/2))+.5;g.strokeStyle=DELTA.pocLineC;g.globalAlpha=.7;g.setLineDash([]);line({x:x0,y},{x:X(Math.min(C.length-1,s.i1)+1),y});g.globalAlpha=1}}\n const lab=sessName(D.len)+' Delta Profile'+(DELTA.noise==='off'?'':' | Filter: '+(DELTA.noise==='low'?'Low':'High')+'-Delta x'+DELTA.level);\n g.font='11px \"IBM Plex Mono\",ui-monospace,monospace';g.textAlign='right';const w=g.measureText(lab).width+12;\n g.fillStyle=K.panel;g.fillRect(L.R-w-6,L.priceH-26,w,18);g.fillStyle=K.fg;g.fillText(lab,L.R-12,L.priceH-17)}\nconst TOOLS=[['select','Select'],['cross','Crosshair'],['trend','Trend'],['ray','Ray'],['hline','H-Line'],['vline','V-Line'],['rect','Box'],['fib','Fib'],['brush','Brush'],['text','Text'],['ruler','Ruler'],['long','Long'],['short','Short']];\nconst SWATCH=['#e8a838','#26b585','#e5534b','#4aa3ff','#c77dff','#d9dfe7'];\nconst FIB=[0,0.236,0.382,0.5,0.618,0.786,1,1.618];\nlet tool='select',curColor='#e8a838',curW=2,undo=[],G=null,uid=1;\nconst sp=p=>({x:X(idxT(p.t)),y:Y(p.p)});\nfunction pushU(){undo.push(JSON.stringify(drawings));if(undo.length>40)undo.shift()}\nfunction saveD(){store.set('tk.d.'+S.sym,drawings)}\nfunction loadD(){drawings=store.get('tk.d.'+S.sym,[]);sel=null;pend=null;undo=[]}\nfunction posGeo(d){const e=sp(d.pts[0]),x1=e.x+d.n*S.bw;return{x0:e.x,x1,yE:e.y,yS:Y(d.stop),yT:Y(d.tp)}}\nfunction pct(d,pr){return(d.type==='long'?(pr-d.pts[0].p):(d.pts[0].p-pr))/d.pts[0].p*100}\nfunction ext(a,b){const dx=b.x-a.x;if(Math.abs(dx)<1e-6)return b;const k=(b.y-a.y)/dx,x=dx>0?L.R+20:-20;return{x,y:a.y+k*(x-a.x)}}\nfunction dSeg(px,py,a,b){const dx=b.x-a.x,dy=b.y-a.y,l=dx*dx+dy*dy;let t=l?((px-a.x)*dx+(py-a.y)*dy)/l:0;t=Math.max(0,Math.min(1,t));return Math.hypot(px-(a.x+t*dx),py-(a.y+t*dy))}\nfunction mk(type,pt){\n const d={id:uid++,type,c:curColor,w:curW,pts:[{t:pt.t,p:pt.p},{t:pt.t,p:pt.p}]};\n if(type==='text')d.text=($('#txtIn')&&$('#txtIn').value)||'Note';\n if(type==='long'||type==='short'){const r=(V.mx-V.mn)*0.06,s=type==='long'?1:-1;d.stop=pt.p-s*r;d.tp=pt.p+s*2*r;d.n=Math.round((V.hi-V.lo)*0.3)+6;d.c=type==='long'?'#26b585':'#e5534b'}\n return d}\nfunction handlesOf(d){\n const H=[],P=d.pts.map(sp),two=['trend','ray','rect','fib','ruler'];\n if(two.includes(d.type))P.forEach((q,i)=>H.push({x:q.x,y:q.y,set:(t,p)=>{d.pts[i].t=t;d.pts[i].p=p}}));\n else if(d.type==='hline')H.push({x:L.R-30,y:P[0].y,set:(t,p)=>{d.pts[0].p=p}});\n else if(d.type==='vline')H.push({x:P[0].x,y:30,set:t=>{d.pts[0].t=t}});\n else if(d.type==='text')H.push({x:P[0].x,y:P[0].y,set:(t,p)=>{d.pts[0].t=t;d.pts[0].p=p}});\n else if(d.type==='long'||d.type==='short'){const q=posGeo(d),mx=(q.x0+q.x1)/2;\n  H.push({x:mx,y:q.yT,set:(t,p)=>{d.tp=p}},{x:mx,y:q.yS,set:(t,p)=>{d.stop=p}},\n   {x:q.x1,y:q.yE,set:t=>{d.n=Math.max(2,Math.round((t-d.pts[0].t)/TF))}},\n   {x:q.x0,y:q.yE,set:(t,p)=>{const dp=p-d.pts[0].p;d.stop+=dp;d.tp+=dp;d.pts[0].t=t;d.pts[0].p=p}})}\n return H}\nfunction hitD(d,x,y){\n const P=d.pts.map(sp),tol=11;\n switch(d.type){\n  case 'trend':case 'ruler':return dSeg(x,y,P[0],P[1])<tol||(d.type==='ruler'&&inBox(x,y,P[0],P[1]));\n  case 'ray':return dSeg(x,y,P[0],ext(P[0],P[1]))<tol;\n  case 'hline':return Math.abs(y-P[0].y)<tol;\n  case 'vline':return Math.abs(x-P[0].x)<tol;\n  case 'rect':return inBox(x,y,P[0],P[1]);\n  case 'fib':{const x1=Math.min(P[0].x,P[1].x);return x>=x1-tol&&FIB.some(l=>Math.abs(y-Y(d.pts[0].p+(d.pts[1].p-d.pts[0].p)*l))<tol)}\n  case 'brush':for(let i=1;i<P.length;i++)if(dSeg(x,y,P[i-1],P[i])<tol)return true;return false;\n  case 'text':return Math.abs(x-P[0].x-30)<46&&Math.abs(y-P[0].y)<14;\n  case 'long':case 'short':{const q=posGeo(d);return x>=q.x0-4&&x<=q.x1+4&&y>=Math.min(q.yS,q.yT)&&y<=Math.max(q.yS,q.yT)}}\n return false}\nfunction inBox(x,y,a,b){return x>=Math.min(a.x,b.x)-4&&x<=Math.max(a.x,b.x)+4&&y>=Math.min(a.y,b.y)-4&&y<=Math.max(a.y,b.y)+4}\nfunction drawOne(d,isSel){\n const P=d.pts.map(sp);g.strokeStyle=d.c;g.fillStyle=d.c;g.lineWidth=d.w;g.setLineDash([]);g.textBaseline='middle';g.textAlign='left';\n g.font='11px \"IBM Plex Mono\",ui-monospace,monospace';\n switch(d.type){\n  case 'trend':line(P[0],P[1]);break;\n  case 'ray':line(P[0],ext(P[0],P[1]));break;\n  case 'hline':{line({x:0,y:P[0].y},{x:L.R+L.tw,y:P[0].y});g.fillText(fmtP(d.pts[0].p),6,P[0].y-8);break}\n  case 'vline':line({x:P[0].x,y:0},{x:P[0].x,y:L.priceH});break;\n  case 'rect':{g.globalAlpha=.15;g.fillRect(P[0].x,P[0].y,P[1].x-P[0].x,P[1].y-P[0].y);g.globalAlpha=1;g.strokeRect(P[0].x,P[0].y,P[1].x-P[0].x,P[1].y-P[0].y);break}\n  case 'fib':{const x1=Math.min(P[0].x,P[1].x);g.lineWidth=Math.max(1,d.w-1);FIB.forEach((l,i)=>{const p=d.pts[0].p+(d.pts[1].p-d.pts[0].p)*l,y=Y(p);g.globalAlpha=l===0||l===1?1:.7;line({x:x1,y},{x:L.R,y});g.globalAlpha=1;g.fillText(l+'  '+fmtP(p),x1+4,y-7)});g.setLineDash([3,4]);g.globalAlpha=.5;line(P[0],P[1]);g.globalAlpha=1;break}\n  case 'brush':{g.lineJoin='round';g.beginPath();P.forEach((q,i)=>i?g.lineTo(q.x,q.y):g.moveTo(q.x,q.y));g.stroke();break}\n  case 'text':{g.font='500 13px \"IBM Plex Sans\",system-ui,sans-serif';g.fillText(d.text,P[0].x+6,P[0].y);g.beginPath();g.arc(P[0].x,P[0].y,3,0,7);g.fill();break}\n  case 'ruler':{const up=d.pts[1].p>=d.pts[0].p,col=up?K.up:K.dn;g.strokeStyle=col;g.fillStyle=col;g.globalAlpha=.14;g.fillRect(P[0].x,P[0].y,P[1].x-P[0].x,P[1].y-P[0].y);g.globalAlpha=1;g.lineWidth=1;line(P[0],P[1]);\n   const dp=d.pts[1].p-d.pts[0].p,bars=Math.round((d.pts[1].t-d.pts[0].t)/TF),txt=(dp>=0?'+':'')+fmtP(dp)+' ('+(dp/d.pts[0].p*100).toFixed(2)+'%)  '+bars+' bars';\n   const mx=(P[0].x+P[1].x)/2,my=(P[0].y+P[1].y)/2;g.font='11px \"IBM Plex Mono\",monospace';const w=g.measureText(txt).width+12;g.fillStyle=col;g.fillRect(mx-w/2,my-10,w,20);g.fillStyle='#fff';g.textAlign='center';g.fillText(txt,mx,my);break}\n  case 'long':case 'short':{const q=posGeo(d),w=q.x1-q.x0,tpPct=pct(d,d.tp),stPct=pct(d,d.stop),rr=Math.abs(tpPct/(stPct||1e-9));\n   g.globalAlpha=.2;g.fillStyle=K.up;g.fillRect(q.x0,Math.min(q.yE,q.yT),w,Math.abs(q.yT-q.yE));g.fillStyle=K.dn;g.fillRect(q.x0,Math.min(q.yE,q.yS),w,Math.abs(q.yS-q.yE));g.globalAlpha=1;\n   g.lineWidth=1;g.strokeStyle=d.c;line({x:q.x0,y:q.yE},{x:q.x1,y:q.yE});g.strokeStyle=K.up;line({x:q.x0,y:q.yT},{x:q.x1,y:q.yT});g.strokeStyle=K.dn;line({x:q.x0,y:q.yS},{x:q.x1,y:q.yS});\n   g.textAlign='left';const cx=q.x0+6;g.fillStyle=K.up;g.fillText('Target '+(tpPct>=0?'+':'')+tpPct.toFixed(2)+'%  '+fmtP(d.tp),cx,q.yT+(d.type==='long'?-9:9));\n   g.fillStyle=K.dn;g.fillText('Stop '+(stPct>=0?'+':'')+stPct.toFixed(2)+'%  '+fmtP(d.stop),cx,q.yS+(d.type==='long'?9:-9));\n   g.fillStyle=d.c;g.fillText((d.type==='long'?'LONG ':'SHORT ')+fmtP(d.pts[0].p)+'  R:R '+rr.toFixed(2),cx,q.yE+(d.type==='long'?-9:9));break}\n }\n if(isSel){g.setLineDash([]);handlesOf(d).forEach(h=>{g.fillStyle=K.bg;g.strokeStyle=d.c;g.lineWidth=2;g.beginPath();g.arc(h.x,h.y,6,0,7);g.fill();g.stroke()})}}\nfunction drawDrawings(){drawings.forEach(d=>drawOne(d,d===sel));if(pend)drawOne(pend,true)}\nfunction finish(d){drawings.push(d);sel=d;pend=null;setTool('select');saveD();syncProps();dirty=true}\nfunction setTool(t){if(S.lock&&t!=='select'&&t!=='cross'){toast('Unlock to draw');return}tool=t;if(t!=='select'&&t!=='cross'){sel=null}pend=null;$$('#tools button[data-tool]').forEach(b=>b.classList.toggle('on',b.dataset.tool===t));syncProps();dirty=true}\nfunction pos(e){const r=cv.getBoundingClientRect();return{x:e.clientX-r.left,y:e.clientY-r.top}}\nfunction ptOf(q){return{t:tOf(q.x),p:Pp(q.y)}}\nconst ptrs=new Map(),BWMIN=0.25;let lastAxTap=0;\ncv.addEventListener('pointerdown',e=>{\n cv.setPointerCapture(e.pointerId);const q=pos(e);ptrs.set(e.pointerId,q);\n if(ptrs.size===2){const [a,b]=[...ptrs.values()];G={mode:'pinch',d0:Math.hypot(a.x-b.x,a.y-b.y),bw0:S.bw,cx:(a.x+b.x)/2};G.i0=I(G.cx);return}\n const bx=btnX(),al=alerts.find(a=>a.sym===S.sym&&a.on&&Math.hypot(q.x-bx,q.y-Y(a.price))<18);\n if(al){alerts=alerts.filter(x=>x!==al);store.set('tk.alerts',alerts);toast('Alert removed');dirty=true;G={mode:'none'};return}\n if(QA&&Math.hypot(q.x-bx,q.y-Y(QA.price))<20){addQuickAlert(QA.price);QA=null;dirty=true;G={mode:'none'};return}\n if(q.x>L.R+L.tw){G=q.y<L.mainH?{mode:'yax',y0:q.y,yz0:S.yz,moved:false,q0:q}:{mode:'none'};dirty=true;return}\n if(q.y>L.mainH){const cx=S.off<=12?L.R-1:L.R/2;G={mode:'xax',x0:q.x,bw0:S.bw,cx,i0:I(cx),moved:false};return}\n if(tool==='cross'){G={mode:'cross'};cross=q;dirty=true;return}\n if(tool==='select'){\n  if(sel&&(!S.lock||sel.draft||sel.live)){const h=handlesOf(sel).find(h=>Math.hypot(h.x-q.x,h.y-q.y)<18);if(h){pushU();G={mode:'handle',h};return}}\n  const hit=[...drawings].reverse().find(d=>(!S.lock||d.draft||d.live)&&hitD(d,q.x,q.y));   // order boxes stay draggable when drawings are locked\n  if(hit){sel=hit;pushU();G={mode:'move',q0:q,orig:JSON.parse(JSON.stringify(hit))};syncProps();dirty=true;return}\n  if(sel){sel=null;syncProps()}G={mode:'pan',x:q.x,y:q.y,off:S.off,yo:S.yo,q0:q,moved:false};dirty=true;return}\n const pt=ptOf(q);\n if(pend){pend.pts[1]=pt;finish(pend);G={mode:'none'};return}\n const d=mk(tool,pt);\n if(['hline','vline','text','long','short'].includes(tool)){pushU();finish(d);G={mode:'none'};return}\n if(tool==='brush'){d.pts=[pt];pend=d;G={mode:'brush'};return}\n pend=d;G={mode:'draw',q0:q,moved:false};dirty=true});\ncv.addEventListener('pointermove',e=>{\n const q=pos(e);if(ptrs.has(e.pointerId))ptrs.set(e.pointerId,q);\n if(!G||!ptrs.size){if(e.pointerType==='mouse'){cross=q;if(pend)pend.pts[1]=ptOf(q);dirty=true}return}\n if(G.mode==='pinch'&&ptrs.size>=2){const [a,b]=[...ptrs.values()],d=Math.hypot(a.x-b.x,a.y-b.y);S.bw=Math.max(BWMIN,Math.min(40,G.bw0*d/(G.d0||1)));S.off=G.i0-(nB()-1)+(L.R-G.cx-S.bw/2)/S.bw;clampOff();dirty=true;return}\n if(G.mode==='yax'){const dy=q.y-G.y0;if(G.moved||Math.abs(dy)>5){G.moved=true;S.yz=Math.max(0.15,Math.min(8,G.yz0*Math.exp(dy/(L.priceH*0.5))))}}\n else if(G.mode==='xax'){const dx=q.x-G.x0;if(G.moved||Math.abs(dx)>5){G.moved=true;S.bw=Math.max(BWMIN,Math.min(40,G.bw0*Math.exp(dx/150)));S.off=G.i0-(nB()-1)+(L.R-G.cx-S.bw/2)/S.bw;clampOff()}}\n else if(G.mode==='pan'){if(Math.abs(q.x-G.q0.x)>6||Math.abs(q.y-G.q0.y)>6)G.moved=true;S.off=G.off-(q.x-G.x)/S.bw;if(S.yz!==1||S.yo!==0)S.yo=G.yo+(q.y-G.y)/Math.max(50,L.pB-L.pT)*S.yz;clampOff()}\n else if(G.mode==='cross'){cross=q}\n else if(G.mode==='handle'){const p=ptOf(q);G.h.set(p.t,p.p)}\n else if(G.mode==='move'){const a=ptOf(G.q0),b=ptOf(q),dt=b.t-a.t,dp=b.p-a.p;sel.pts.forEach((p,i)=>{p.t=G.orig.pts[i].t+dt;p.p=G.orig.pts[i].p+dp});if(sel.tp!==undefined){sel.tp=G.orig.tp+dp;sel.stop=G.orig.stop+dp}}\n else if(G.mode==='draw'){pend.pts[1]=ptOf(q);if(Math.hypot(q.x-G.q0.x,q.y-G.q0.y)>10)G.moved=true}\n else if(G.mode==='brush'){pend.pts.push(ptOf(q))}\n dirty=true});\nfunction endPtr(e){\n ptrs.delete(e.pointerId);\n if(G&&G.mode==='pan'&&!G.moved&&ptrs.size===0&&QA){QA=null;dirty=true}\n if(G&&G.mode==='yax'&&!G.moved&&ptrs.size===0){const now=Date.now();\n  if(now-lastAxTap<350){S.yz=1;S.yo=0;QA=null;toast('Price scale: auto')}\n  else if(G.q0.y<L.priceH){if(QA&&Math.abs(Y(QA.price)-G.q0.y)<10)QA=null;else QA={price:Pp(G.q0.y)}}\n  lastAxTap=now;dirty=true}\n if(G&&G.mode==='draw'&&G.moved&&pend)finish(pend);\n else if(G&&G.mode==='brush'&&pend){if(pend.pts.length>2)finish(pend);else pend=null}\n else if(G&&(G.mode==='handle'||G.mode==='move'))saveD();\n if(ptrs.size===0)G=null;else if(G&&G.mode==='pinch'){G={mode:'none'}}\n if(!ptrs.size&&e.pointerType!=='mouse'&&G===null&&tool!=='cross')cross=null;dirty=true}\ncv.addEventListener('pointerup',endPtr);cv.addEventListener('pointercancel',endPtr);\ncv.addEventListener('pointerleave',e=>{if(e.pointerType==='mouse'&&!ptrs.size){cross=null;dirty=true}});\ncv.addEventListener('wheel',e=>{e.preventDefault();const q=pos(e),i0=I(S.off<=12?L.R-1:q.x),ax0=S.off<=12?L.R-1:q.x;\n if(q.x>L.R+L.tw){S.yz=Math.max(0.15,Math.min(8,S.yz*(e.deltaY<0?0.9:1.1)));dirty=true;return}\n S.bw=Math.max(BWMIN,Math.min(40,S.bw*(e.deltaY<0?1.1:0.91)));S.off=i0-(nB()-1)+(L.R-ax0-S.bw/2)/S.bw;clampOff();dirty=true},{passive:false});\nfunction clampOff(){S.off=Math.max(-(nB()-8),Math.min(Math.max(60,Math.floor(L.R/S.bw*0.5)),S.off))}\nfunction resetScale(){S.yz=1;S.yo=0;dirty=true}\nfunction syncAuto(){const b=$('#autoBtn');if(b)b.hidden=S.yz===1&&S.yo===0}\nwindow.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA')return;if(e.key==='Escape'){setTool('select')}if((e.key==='Delete'||e.key==='Backspace')&&sel)delSel()});\nfunction setLock(v){S.lock=v;store.set('tk.lock',v);if(v){sel=null;pend=null;if(tool!=='select'&&tool!=='cross')tool='select';G=null}syncProps();if(window.syncMenu)syncMenu();dirty=true;toast(v?'Drawings locked. They cannot be moved.':'Drawings unlocked')}\nfunction delSel(){if(!sel)return;pushU();drawings=drawings.filter(d=>d!==sel);sel=null;saveD();syncProps();dirty=true}\nfunction syncProps(){syncProps0();syncSbar();if(window.syncMenu)syncMenu()}\nfunction syncProps0(){\n const p=$('#props');if(!p)return;const cur=sel||pend,col=cur?cur.c:curColor,w=cur?cur.w:curW;\n const showTxt=tool==='text'||(sel&&sel.type==='text');\n p.innerHTML=SWATCH.map(c=>`<button class=\"sw${c===col?' on':''}\" data-c=\"${c}\" style=\"background:${c}\" aria-label=\"Color ${c}\"></button>`).join('')+\n `<input type=\"color\" id=\"colIn\" value=\"${col}\" aria-label=\"Custom color\">`+\n [1,2,3].map(n=>`<button data-w=\"${n}\" class=\"${n===w?'on':''}\" style=\"${n===w?'background:var(--acc);color:var(--acc-ink)':''}\">${n}px</button>`).join('')+\n (showTxt?`<input type=\"text\" id=\"txtIn\" value=\"${sel&&sel.type==='text'?sel.text.replace(/\"/g,'&quot;'):($('#txtVal')||{}).value||'Note'}\" aria-label=\"Label text\">`:'')+\n `<button data-act=\"undo\">Undo</button><button data-act=\"del\" class=\"del\">Delete</button><button data-act=\"clear\" class=\"del\">Clear all</button>`}\n$('#props').addEventListener('click',e=>{\n const b=e.target.closest('button');if(!b)return;\n const apply=f=>{if(sel){pushU();f(sel);saveD()}else f(null)};\n if(b.dataset.c){curColor=b.dataset.c;apply(d=>{if(d)d.c=b.dataset.c});syncProps();dirty=true}\n else if(b.dataset.w){curW=+b.dataset.w;apply(d=>{if(d)d.w=curW});syncProps();dirty=true}\n else if(b.dataset.act==='del')delSel();\n else if(b.dataset.act==='undo'){if(undo.length){drawings=JSON.parse(undo.pop());sel=null;saveD();syncProps();dirty=true}}\n else if(b.dataset.act==='clear'){if(drawings.length){pushU();drawings=[];sel=null;saveD();syncProps();dirty=true;toast('Cleared. Undo restores them.')}}});\n$('#props').addEventListener('input',e=>{\n if(e.target.id==='colIn'){curColor=e.target.value;if(sel){sel.c=curColor;saveD()}dirty=true}\n if(e.target.id==='txtIn'&&sel&&sel.type==='text'){sel.text=e.target.value||'Note';saveD();dirty=true}});\nfunction syncSbar(){const b=$('#sbar');if(b)b.hidden=!(sel&&!S.lock&&!sel.draft&&!sel.live)}\n/* Indicators: many Pine scripts on the chart, library, per-indicator settings */\nlet INDS=[],openId=null,selIds=new Set(),indMsg={};\nconst iuid=()=>Math.random().toString(36).slice(2,9);\nconst titleOf=c=>{const m=/indicator\\(\\s*(?:title\\s*=\\s*)?[\"']([^\"']+)/.exec(c);return m?m[1]:'Script'};\nconst BUILTIN=()=>[{name:'Smart Delta Profile High Vol (TraderGze)',code:DSP_SRC,inputs:{}}].concat(PRESETS.map(p=>({name:p.name,code:p.code,inputs:{}})));\nconst getLib=()=>store.get('tk.lib',[]);\nfunction saveInds(){store.set('tk.inds',INDS.map(i=>({id:i.id,name:i.name,code:i.code,on:i.on,inputs:i.inputs,tfs:i.tfs||[]})))}\nfunction loadInds(){\n let a=store.get('tk.inds',null);\n if(!a){a=[];const old=store.get('tk.code','');if(old&&store.get('tk.run',0)&&old.trim()&&old!==PRESETS[0].code)a.push({id:iuid(),name:titleOf(old),code:old,on:true,inputs:{}})}\n INDS=a.map(x=>({id:x.id||iuid(),name:x.name||titleOf(x.code),code:x.code,on:x.on!==false,inputs:x.inputs||{},tfs:x.tfs||[],res:null,err:null,key:'',cost:0,at:0}))}\nconst tfOk=i=>!i.tfs||!i.tfs.length||i.tfs.includes(S.tf);\nfunction runInd(ind){\n const t0=performance.now(),sig=TF+':'+S.sym;\n try{const px=C.length?C[C.length-1].c:1,mt=Math.pow(10,-Math.max(0,3-Math.floor(Math.log10(Math.max(1e-9,px)))));\n  const r=PineX.run(ind.code,C,{inputs:ind.inputs,mintick:mt,tfSec:TF/1000,tfLabel:S.tf,ticker:S.sym,fg:'#d9dfe7',bg:'#0d1014'});\n  ind.res=r;ind.err=null;ind.resSig=sig;ind.name=ind.name||r.title}\n catch(e){ind.err=e.message||String(e);if(ind.resSig!==sig)ind.res=null}\n ind.cost=performance.now()-t0;ind.at=Date.now();ind.key=ind.code.length+':'+sig+':'+JSON.stringify(ind.inputs)+':'+(C.length?C[0].t:0)}\nfunction runAll(force){\n if(C.length){const sig=TF+':'+S.sym;\n  for(const ind of INDS){if(!ind.on||!tfOk(ind))continue;\n   const key=ind.code.length+':'+sig+':'+JSON.stringify(ind.inputs)+':'+(C[0].t);\n   if(!force&&key===ind.key&&ind.cost>60&&Date.now()-ind.at<4000)continue;\n   runInd(ind)}}\n mergeInds()}\nconst runScript=runAll;\nfunction mergeInds(){\n const act=INDS.filter(i=>i.on&&i.res&&tfOk(i));S.panes=[];\n if(!act.length){S.ind=null;return}\n const M={err:null,overlay:true,plots:[],all:[],shapes:[],hlines:[],alerts:[],boxes:[],lines:[],labels:[],tables:[],barcolor:null,title:'',inputs:[]};\n for(const i of act){const r=i.res;\n  if(r.overlay)M.plots.push(...r.plots);else if(r.plots.length)S.panes.push(r);\n  M.all.push(...r.plots);M.shapes.push(...r.shapes);M.alerts.push(...r.alerts);M.boxes.push(...r.boxes);M.lines.push(...r.lines);M.labels.push(...r.labels);M.tables.push(...r.tables);\n  if(r.barcolor)M.barcolor=r.barcolor}\n S.ind=M}\nfunction addInd(name,code,inputs,open,tfs){\n const ind={id:iuid(),name:name||titleOf(code),code,on:true,inputs:Object.assign({},inputs||{}),tfs:(tfs||[]).slice(),res:null,err:null,key:'',cost:0,at:0};\n INDS.push(ind);runInd(ind);mergeInds();saveInds();if(open)openId=ind.id;dirty=true;renderInd();return ind}\nconst E=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\"/g,'&quot;');\nfunction statusOf(i){const t=i.tfs&&i.tfs.length?'<span title=\"Shown on these timeframes\">'+i.tfs.join(' ')+(tfOk(i)?'':' (not now)')+'</span> ':'';return t+(i.err?'<span class=\"bad\" title=\"'+E(i.err)+'\">error</span>':i.res?(i.res.overlay?'overlay':'pane'):'')}\nfunction inputsHtml(ind){\n const r=ind.res;if(!r||!r.inputs||!r.inputs.length)return '<p class=\"mut\">This script has no settings.</p>';\n let h='',grp=null;\n r.inputs.forEach((d,n)=>{\n  if(d.group!==grp){grp=d.group;h+='<h3>'+E(grp||'General')+'</h3>'}\n  const v=ind.inputs[d.key]!==undefined?ind.inputs[d.key]:d.def;let ctl;\n  if(d.kind==='bool')ctl='<input type=\"checkbox\" data-k=\"'+n+'\"'+(v?' checked':'')+'>';\n  else if(d.kind==='color')ctl='<input type=\"color\" data-k=\"'+n+'\" value=\"'+PXT.toHex(v)+'\">';\n  else if(d.options)ctl='<select data-k=\"'+n+'\">'+d.options.map(o=>'<option'+(o===v?' selected':'')+'>'+E(o)+'</option>').join('')+'</select>';\n  else ctl='<input type=\"number\" data-k=\"'+n+'\" value=\"'+v+'\"'+(d.min!==undefined?' min=\"'+d.min+'\"':'')+(d.max!==undefined?' max=\"'+d.max+'\"':'')+' step=\"'+(d.step||(d.kind==='int'?1:'any'))+'\">';\n  h+='<label class=\"irow\"><span>'+E(d.title)+'</span>'+ctl+'</label>'});\n return h+'<div class=\"form\"><button class=\"btn ghost\" data-a=\"reset\">Reset to defaults</button></div>'}\nfunction msgOf(ind){\n if(ind.err)return '<div class=\"err\">'+E(ind.err)+(/nsupported/.test(ind.err)?' (Not supported yet: switch, maps, user-defined types, strategy.*.)':'')+'</div>';\n if(!ind.res)return '';const r=ind.res,n=r.alerts.map(a=>a.title).join(', ');\n return '<div class=\"mut\">Running \"'+E(r.title)+'\" ('+(r.overlay?'on the price chart':'in its own pane')+'): '+r.plots.length+' plot'+(r.plots.length===1?'':'s')+(r.boxes.length?', '+r.boxes.filter(b=>!b.deleted).length+' boxes':'')+(n?'. Alert conditions: '+E(n):'')+'</div>'}\nfunction renderInd(){\n const w=$('#indw');if(!w)return;const top=w.scrollTop,lib=getLib(),bi=BUILTIN();\n let h='<h2>Add indicator</h2><div class=\"form\"><select id=\"libSel\" aria-label=\"Library\"><option value=\"\">Choose from library</option><optgroup label=\"Built-in\">'+bi.map((b,i)=>'<option value=\"b'+i+'\">'+E(b.name)+'</option>').join('')+'</optgroup>'+(lib.length?'<optgroup label=\"My library\">'+lib.map((b,i)=>'<option value=\"u'+i+'\">'+E(b.name)+'</option>').join('')+'</optgroup>':'')+'</select><button class=\"btn\" data-a=\"addlib\">Add</button></div>'+\n '<div class=\"form\"><button class=\"btn ghost\" data-a=\"import\">Import file</button><button class=\"btn ghost\" data-a=\"new\">New script</button></div>';\n h+='<h2>On chart ('+INDS.length+')</h2>';\n if(!INDS.length)h+='<p class=\"mut\">No indicators yet. Add one above.</p>';\n else{h+='<div class=\"form\"><button class=\"btn ghost\" data-a=\"selall\">'+(selIds.size===INDS.length?'Select none':'Select all')+'</button><button class=\"btn ghost del\" data-a=\"rmsel\"'+(selIds.size?'':' disabled')+'>Remove selected ('+selIds.size+')</button><button class=\"btn ghost del\" data-a=\"rmall\">Remove all</button></div>';\n  for(const i of INDS)h+='<div class=\"irowc'+(i.on?'':' off')+'\" data-id=\"'+i.id+'\"><input type=\"checkbox\" data-a=\"sel\"'+(selIds.has(i.id)?' checked':'')+' aria-label=\"Select\"><button class=\"nm\" data-a=\"open\">'+E(i.name)+'</button><span class=\"st\">'+statusOf(i)+'</span><button data-a=\"eye\" aria-pressed=\"'+i.on+'\">'+(i.on?'Shown':'Hidden')+'</button><button class=\"del\" data-a=\"rm\" aria-label=\"Remove\">&times;</button></div>'+(openId===i.id?editorHtml(i):'')}\n if(lib.length){h+='<h2>My library</h2>';lib.forEach((b,k)=>{h+='<div class=\"irowc\"><span class=\"nm2\">'+E(b.name)+'</span><button data-a=\"libadd\" data-k=\"'+k+'\">Add</button><button class=\"del\" data-a=\"libdel\" data-k=\"'+k+'\">Delete</button></div>'})}\n w.innerHTML=h;w.scrollTop=top;\n const chip=$('#indChip');if(chip){chip.hidden=!INDS.length;chip.textContent='Indicators '+INDS.length}}\nfunction editorHtml(i){\n return '<div class=\"ed\" data-id=\"'+i.id+'\"><label class=\"irow\"><span>Name</span><input type=\"text\" data-a=\"name\" value=\"'+E(i.name)+'\"></label>'+\n '<div class=\"tfrow\"><span>Show on timeframes</span><div class=\"grid\">'+TFS.map(t=>'<button data-a=\"tf\" data-v=\"'+t[0]+'\"'+(i.tfs&&i.tfs.includes(t[0])?' class=\"on\"':'')+'>'+t[0]+'</button>').join('')+'</div><div class=\"mut\">'+(i.tfs&&i.tfs.length?'Only on the selected timeframes.':'All timeframes (none selected).')+'</div></div>'+\n '<details open><summary>Settings</summary><div class=\"ins\">'+inputsHtml(i)+'</div></details>'+\n '<details><summary>Code</summary><textarea class=\"code\" spellcheck=\"false\" autocapitalize=\"off\" autocorrect=\"off\" aria-label=\"Pine script\">'+E(i.code)+'</textarea>'+\n '<div class=\"form\"><button class=\"btn\" data-a=\"apply\">Apply code</button><button class=\"btn ghost\" data-a=\"copy\">Copy</button></div></details>'+\n '<div class=\"msg\">'+msgOf(i)+'</div>'+\n '<div class=\"form\"><button class=\"btn\" data-a=\"savelib\">Save to library</button><button class=\"btn ghost\" data-a=\"close\">Close</button></div></div>'}\nfunction refreshMsg(id){const ed=document.querySelector('.ed[data-id=\"'+id+'\"] .msg'),i=INDS.find(x=>x.id===id);if(ed&&i)ed.innerHTML=msgOf(i);const row=document.querySelector('.irowc[data-id=\"'+id+'\"] .st');if(row&&i)row.innerHTML=statusOf(i)}\nfunction afterChange(i){runInd(i);mergeInds();saveInds();dirty=true;refreshMsg(i.id)}\nconst wI=$('#indw');\nwI.addEventListener('click',e=>{\n const b=e.target.closest('[data-a]');if(!b)return;const a=b.dataset.a,row=b.closest('[data-id]'),id=row&&row.dataset.id,ind=id&&INDS.find(x=>x.id===id);\n if(b.tagName==='INPUT'&&a!=='sel')return;\n switch(a){\n  case 'import':$('#impFile').click();break;\n  case 'new':addInd('New script','//@version=6\\nindicator(\"My indicator\", overlay=true)\\nplot(ta.sma(close, 20), \"SMA 20\", color.orange)\\n',{},true);break;\n  case 'addlib':{const v=$('#libSel').value;if(!v){toast('Choose an indicator first');break}const it=(v[0]==='b'?BUILTIN():getLib())[+v.slice(1)];addInd(it.name,it.code,it.inputs,false,it.tfs);toast('Added '+it.name);break}\n  case 'libadd':{const it=getLib()[+b.dataset.k];addInd(it.name,it.code,it.inputs,false,it.tfs);break}\n  case 'libdel':{const l=getLib();l.splice(+b.dataset.k,1);store.set('tk.lib',l);renderInd();break}\n  case 'sel':b.checked?selIds.add(id):selIds.delete(id);renderInd();break;\n  case 'selall':selIds=selIds.size===INDS.length?new Set():new Set(INDS.map(x=>x.id));renderInd();break;\n  case 'rmsel':INDS=INDS.filter(x=>!selIds.has(x.id));if(selIds.has(openId))openId=null;toast('Removed '+selIds.size);selIds=new Set();mergeInds();saveInds();dirty=true;renderInd();break;\n  case 'rmall':if(!INDS.length)break;INDS=[];openId=null;selIds=new Set();mergeInds();saveInds();dirty=true;renderInd();toast('All indicators removed');break;\n  case 'rm':INDS=INDS.filter(x=>x.id!==id);selIds.delete(id);if(openId===id)openId=null;mergeInds();saveInds();dirty=true;renderInd();break;\n  case 'eye':ind.on=!ind.on;if(ind.on&&!ind.res)runInd(ind);mergeInds();saveInds();dirty=true;renderInd();break;\n  case 'open':openId=openId===id?null:id;if(openId&&!ind.res&&!ind.err)runInd(ind);renderInd();break;\n  case 'tf':{const e2=b.closest('.ed'),i2=INDS.find(x=>x.id===e2.dataset.id),v=b.dataset.v;i2.tfs=i2.tfs||[];const k=i2.tfs.indexOf(v);k>=0?i2.tfs.splice(k,1):i2.tfs.push(v);i2.tfs.sort((a,c)=>TFS.findIndex(t=>t[0]===a)-TFS.findIndex(t=>t[0]===c));if(tfOk(i2)&&!i2.res)runInd(i2);mergeInds();saveInds();dirty=true;renderInd();break}\n  case 'close':openId=null;renderInd();break;\n  case 'reset':{const e2=b.closest('.ed'),i2=INDS.find(x=>x.id===e2.dataset.id);i2.inputs={};afterChange(i2);const box=e2.querySelector('.ins');box.innerHTML=inputsHtml(i2);break}\n  case 'apply':{const e2=b.closest('.ed'),i2=INDS.find(x=>x.id===e2.dataset.id);i2.code=e2.querySelector('textarea.code').value;i2.res=null;afterChange(i2);e2.querySelector('.ins').innerHTML=inputsHtml(i2);toast(i2.err?'Script has errors':'Applied');break}\n  case 'copy':{const t=b.closest('.ed').querySelector('textarea.code');const fb=()=>{t.focus();t.select();toast('Selected. Use your phone\\'s Copy.')};try{navigator.clipboard.writeText(t.value).then(()=>toast('Pine code copied'),fb)}catch(x){fb()}break}\n  case 'savelib':{const e2=b.closest('.ed'),i2=INDS.find(x=>x.id===e2.dataset.id),l=getLib(),k=l.findIndex(x=>x.name===i2.name),it={name:i2.name,code:i2.code,inputs:Object.assign({},i2.inputs),tfs:(i2.tfs||[]).slice()};if(k>=0)l[k]=it;else l.push(it);store.set('tk.lib',l);toast('Saved \"'+i2.name+'\" with its settings to your library');renderInd();break}\n }});\nwI.addEventListener('change',e=>{\n const el=e.target,ed=el.closest('.ed');if(!ed)return;const i=INDS.find(x=>x.id===ed.dataset.id);if(!i)return;\n if(el.dataset.a==='name'){i.name=el.value.trim()||i.name;saveInds();const nm=document.querySelector('.irowc[data-id=\"'+i.id+'\"] .nm');if(nm)nm.textContent=i.name;return}\n if(el.dataset.k===undefined||!i.res)return;\n const d=i.res.inputs[+el.dataset.k];if(!d)return;\n let v=el.type==='checkbox'?el.checked:el.value;if(el.type==='number'){if(el.value==='')return;v=+el.value;if(d.min!==undefined&&v<d.min)v=d.min;if(d.max!==undefined&&v>d.max)v=d.max;el.value=v}\n i.inputs[d.key]=v;afterChange(i)});\n$('#impFile').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();\n r.onload=()=>{const t=String(r.result),ind=addInd(f.name.replace(/\\.[^.]+$/,'')&&titleOf(t)!=='Script'?titleOf(t):f.name.replace(/\\.[^.]+$/,''),t,{},true);toast('Imported '+f.name+(ind.err?' (has errors, see below)':''))};\n r.onerror=()=>toast('Could not read that file');r.readAsText(f);e.target.value=''});\n$('#indChip').addEventListener('click',()=>go('script'));\nlet toastT=0;\nfunction toast(m){const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(toastT);toastT=setTimeout(()=>t.classList.remove('on'),3200)}\nconst symName=id=>(SYMS.find(s=>s[0]===id)||[id,id])[1];\nfunction rebuild(){\n if(isLive()&&LTF)C=LTF.slice(-6000);else C=aggTf(BASE[S.sym],TF,LS[S.sym]?null:S.sym).slice(-3000);\n runScript();refreshTPO();dirty=true}\nfunction updHeader(){\n const B=BASE[S.sym],last=C.length?C[C.length-1]:null;if(!last)return;\n const ref=B.length>288?B[B.length-289].c:B[0].c,ch=(B[B.length-1].c/ref-1)*100;\n $('#px').textContent=fmtP(B[B.length-1].c);const c=$('#chg');c.textContent=(ch>=0?'+':'')+ch.toFixed(2)+'% 24h';c.style.color=ch>=0?'var(--up)':'var(--dn)';\n $('#px').style.color=ch>=0?'var(--up)':'var(--dn)'}\nfunction renderWatch(){\n const any=Object.keys(LS).length,cats=[...new Set(SYMS.map(s=>s[4]))];\n $('#wl').innerHTML=cats.map(cat=>'<h2>'+cat+'</h2>'+SYMS.filter(s=>s[4]===cat).map(s=>{const B=BASE[s[0]],last=B[B.length-1].c,ref=B.length>288?B[B.length-289].c:B[0].c,ch=(last/ref-1)*100,up=ch>=0;\n  const tail=B.slice(-96),mn=Math.min(...tail.map(b=>b.c)),mx=Math.max(...tail.map(b=>b.c)),pts=tail.map((b,i)=>(i/95*70).toFixed(1)+','+(22-(b.c-mn)/((mx-mn)||1)*20).toFixed(1)).join(' ');\n  return `<div class=\"row\" data-s=\"${s[0]}\"><b>${s[1]}${any&&!LS[s[0]]?' <span style=\"font-weight:400;color:var(--mute);font-size:11px\">sim</span>':''}</b><svg viewBox=\"0 0 70 24\" aria-hidden=\"true\"><polyline points=\"${pts}\" fill=\"none\" stroke=\"${up?'var(--up)':'var(--dn)'}\" stroke-width=\"1.5\"/></svg><span class=\"m\"><span style=\"color:${up?'var(--up)':'var(--dn)'}\">${fmtP(last)}</span><br><span style=\"color:var(--mute)\">${up?'+':''}${ch.toFixed(2)}%</span></span></div>`}).join('')).join('')}\nasync function addMarket(){\n let v=$('#cuIn').value.trim();if(!v){toast('Type a market first');return}\n const bn=/^[a-z0-9]{2,15}usdt$/i.test(v);if(bn)v=v.toUpperCase();\n if(SYMS.some(x=>x[0]===v)){toast('Already in the list');return}\n const ent=[v,bn?v.replace(/USDT$/,'/USDT'):v,100,bn?'bn':'hl','Custom'];\n try{const k=await klx(v,'5m',300);if(!k||!k.length)throw new Error('no data');ent[2]=k[k.length-1].c;BASE[v]=k;LS[v]=true}\n catch(e){toast('Not found on '+(bn?'Binance':'Hyperliquid')+': '+v);return}\n SYMS.push(ent);store.set('tk.custom',SYMS.filter(x=>x[4]==='Custom'));buildSel();renderWatch();$('#cuIn').value='';toast('Added '+ent[1])}\n$('#cuAdd').addEventListener('click',addMarket);$('#cuIn').addEventListener('keydown',e=>{if(e.key==='Enter')addMarket()});\n$('#wl').addEventListener('click',e=>{\n const r=e.target.closest('.row');if(r)setSym(r.dataset.s,true)});\nfunction renderAlerts(){\n const cur=BASE[S.sym]?BASE[S.sym][BASE[S.sym].length-1].c:0;\n $('#alw').innerHTML=`<h2>New price alert</h2><div class=\"form\"><select id=\"alSym\">${SYMS.map(s=>`<option value=\"${s[0]}\"${s[0]===S.sym?' selected':''}>${s[1]}</option>`).join('')}</select><select id=\"alDir\"><option value=\"above\">Crosses above</option><option value=\"below\">Crosses below</option></select><input id=\"alPx\" inputmode=\"decimal\" value=\"${fmtP(cur)}\" aria-label=\"Price\"><button class=\"btn\" id=\"alAdd\">Add alert</button></div>\n <h2>Your alerts</h2>`+(alerts.length?alerts.map(a=>`<div class=\"al${a.on?'':' off'}\"><div class=\"t\"><b>${symName(a.sym)}</b> ${a.dir==='above'?'above':'below'} <span style=\"font-family:var(--mono)\">${fmtP(a.price)}</span>${a.on?'':' (triggered)'}</div><button data-i=\"${a.id}\" data-a=\"${a.on?'off':'on'}\">${a.on?'Pause':'Re-arm'}</button><button data-i=\"${a.id}\" data-a=\"del\">Delete</button></div>`).join(''):'<p style=\"color:var(--mute)\">No alerts yet. Alerts fire in this page while it is open.</p>')}\n$('#alw').addEventListener('click',e=>{\n const b=e.target.closest('button');if(!b)return;\n if(b.id==='alAdd'){const sym=$('#alSym').value,dir=$('#alDir').value,price=parseFloat($('#alPx').value.replace(',','.')),B=BASE[sym],cur=B[B.length-1].c;\n  if(!(price>0)){toast('Enter a price above zero.');return}\n  if(dir==='above'&&cur>=price||dir==='below'&&cur<=price){toast('Price is already '+(dir==='above'?'above':'below')+' that level.');return}\n  alerts.push({id:Date.now(),sym,dir,price,on:true});store.set('tk.alerts',alerts);renderAlerts();dirty=true;return}\n const a=alerts.find(x=>x.id==b.dataset.i);if(!a)return;\n if(b.dataset.a==='del')alerts=alerts.filter(x=>x!==a);else a.on=b.dataset.a==='on';\n store.set('tk.alerts',alerts);renderAlerts();dirty=true});\nfunction checkAlerts(){\n let hit=false;\n for(const a of alerts){if(!a.on)continue;const B=BASE[a.sym],cur=B[B.length-1].c;\n  if(a.dir==='above'&&cur>=a.price||a.dir==='below'&&cur<=a.price){a.on=false;hit=true;toast(symName(a.sym)+' crossed '+a.dir+' '+fmtP(a.price));try{navigator.vibrate&&navigator.vibrate(200)}catch(e){}}}\n if(hit){store.set('tk.alerts',alerts);if(S.tab==='alerts')renderAlerts()}}\n/* data: simulated ticks, optional live Binance / Hyperliquid */\nconst LS={};\nconst isLive=()=>!!LS[S.sym];\nconst srcOf=id=>(SYMS.find(s=>s[0]===id)||[])[3];\nfunction afterTick(){rebuild();updHeader();checkAlerts();if(S.tab==='watch')renderWatch()}\nfunction simTick(){\n const now=Date.now();\n for(const s of SYMS){if(LS[s[0]])continue;const B=BASE[s[0]];let b=B[B.length-1];\n  if(now>=b.t+300e3){b={t:Math.floor(now/300e3)*300e3,o:b.c,h:b.c,l:b.c,c:b.c,v:0};B.push(b);if(B.length>9000)B.shift()}\n  b.c*=Math.exp(gauss(Math.random)*0.00042);b.h=Math.max(b.h,b.c);b.l=Math.min(b.l,b.c);b.v+=Math.random()*(s[2]>1000?0.4:s[2]>100?4:s[2]>1?90:9000)}\n afterTick()}\nlet LASTERR='';\nasync function fj(url,opt){\n const ctl=new AbortController(),to=setTimeout(()=>ctl.abort(),5000);\n try{const r=await fetch(url,Object.assign({signal:ctl.signal},opt||{}));if(!r.ok)throw new Error('http '+r.status);return await r.json()}finally{clearTimeout(to)}}\nconst IVMS=Object.fromEntries(TFS);\nconst HR={};let hrId=0;\nfunction hostReq(sym,iv,lim,before){return new Promise((res,rej)=>{const id=++hrId;HR[id]={res,rej};parent.postMessage({tk:1,type:'klines',id,sym,iv,lim,before:before||0},'*');setTimeout(()=>{if(HR[id]){delete HR[id];rej(new Error('timeout'))}},25000)})}\nlet hostSrc='';\nlet hostTick=0;\nfunction hostAfter(){clearTimeout(hostTick);hostTick=setTimeout(afterTick,350)}\nfunction hostPrice(p,vol){if(!LTF||!LTF.length||!(p>0))return;const step=TF,l=LTF[LTF.length-1],nd=new Date(),bucket=S.tf==='1M'?Date.UTC(nd.getUTCFullYear(),nd.getUTCMonth(),1):Math.floor(Date.now()/step)*step;\n if(bucket>l.t&&TF<2e9)LTF.push({t:bucket,o:l.c,h:Math.max(l.c,p),l:Math.min(l.c,p),c:p,v:vol||0});else{l.c=p;l.h=Math.max(l.h,p);l.l=Math.min(l.l,p);l.v+=vol||0}\n const B=BASE[S.sym];if(B&&B.length){const b=B[B.length-1];b.c=p;b.h=Math.max(b.h,p);b.l=Math.min(b.l,p)}hostAfter()}\nwindow.addEventListener('message',e=>{const m=e.data;if(!HOST||!m||!m.tk)return;\n if(m.type==='klines'){const h=HR[m.id];if(!h)return;delete HR[m.id];m.error?h.rej(new Error(m.error)):h.res(m.candles);if(m.src)hostSrc=m.src;return}\n if(m.type==='sym'){const id=m.sym.k+':'+m.sym.label;if(!SYMS.some(s=>s[0]===id)){SYMS.push([id,m.sym.label,m.start||100,'host','Terminal']);}\n  if(!BASE[id])BASE[id]=genBase(id,m.start||100);\n  if(m.tf&&m.tf!==S.tf){const t=TFS.find(x=>x[0]===m.tf);if(t){S.tf=m.tf;TF=t[1];$$('#tfs button[data-tf]').forEach(b=>b.classList.toggle('on',b.dataset.tf===m.tf));$('#mTime').textContent=m.tf;renderFavs()}}\n  LS[id]=false;buildSel();setSym(id);return}\n if(m.type==='candle'&&LTF&&m.candle){merge(LTF,[m.candle]);const B=BASE[S.sym];if(S.tf==='5m'&&B)merge(B,[m.candle]);hostAfter();return}\n if(m.type==='price'){hostPrice(m.price,m.vol);return}\n if(m.type==='theme'){S.theme=m.theme;applyTheme();return}});\nasync function klx(sym,iv,lim,endMs){\n if(HOST)return hostReq(sym,iv,lim,endMs);\n if(srcOf(sym)==='srv'){const j=await fj('/api/term/klines?sym='+encodeURIComponent(sym.split(':')[1])+'&iv='+iv+'&lim='+lim+(endMs?'&before='+endMs:''),{credentials:'same-origin'});if(!j.candles||!j.candles.length)throw new Error('no broker candles yet: update the EA to v1.11 and keep MT5 running');return j.candles}\n if(srcOf(sym)==='hl'){const end=Date.now(),j=await fj('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'candleSnapshot',req:{coin:sym,interval:iv,startTime:(endMs?endMs-1:end)-lim*IVMS[iv],endTime:endMs?endMs-1:end}})});return j.map(k=>({t:k.t,o:+k.o,h:+k.h,l:+k.l,c:+k.c,v:+k.v}))}\n const q='/api/v3/klines?symbol='+sym+'&interval='+iv+'&limit='+lim+(endMs?'&endTime='+(endMs-1):'');let j,er;for(const h of ['https://api.binance.com','https://data-api.binance.vision','https://api-gcp.binance.com','https://api1.binance.com']){try{j=await fj(h+q);break}catch(e){er=h.replace('https://','')+': '+(e&&e.message||e)}}if(!j){LASTERR=er;throw new Error(er)}return j.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4],v:+k[5]}))}\nconst OLD={busy:false,done:{}};\nfunction maybeOlder(){\n if(!LTF||!LTF.length||OLD.busy||!isLive()||!C.length)return;\n const key=S.sym+'|'+S.tf;if(OLD.done[key]||LTF.length>=6000||I(0)>25)return;\n OLD.busy=true;const sym=S.sym,tf=S.tf,first=LTF[0].t;\n klx(sym,tf,1000,first).then(a=>{\n  if(sym!==S.sym||tf!==S.tf||!LTF)return;\n  const m=new Map();LTF.forEach(k=>m.set(k.t,k));let added=0;a.forEach(k=>{if(!m.has(k.t))added++;m.set(k.t,k)});\n  if(!added){OLD.done[key]=1;toast('No older candles available from this source');return}\n  LTF=[...m.values()].sort((x,y)=>x.t-y.t);rebuild();dirty=true}).catch(e=>{OLD.done[key]=1;toast('No older data: '+(e&&e.message||e))}).finally(()=>{OLD.busy=false})}\nfunction merge(arr,rows){for(const k of rows){const l=arr[arr.length-1];if(l&&l.t===k.t)arr[arr.length-1]=k;else if(!l||k.t>l.t)arr.push(k)}}\nasync function loadLive(){\n const sym=S.sym,tf=S.tf;\n if(HOST&&!/^(crypto|stock|fx):/.test(sym))return false;\n try{const [a,b]=HOST?await(async()=>{const a=await klx(sym,tf,1000);let b;try{b=tf==='5m'?a:await klx(sym,'5m',1000)}catch(e){b=a}return[a,b]})():await Promise.all([klx(sym,tf,1000),klx(sym,'5m',1000)]);if(!a.length||!b.length)throw new Error('empty');\n  BASE[sym]=b;LS[sym]=true;if(sym===S.sym&&tf===S.tf)LTF=a;setBadge();rebuild();updHeader();return true}\n catch(e){LASTERR=LASTERR||String(e&&e.message||e);if(!LS[sym]){setBadge()}return false}}\nasync function loadAllLive(){\n for(const s of SYMS){if(LS[s[0]]||s[0]===S.sym)continue;try{const b=await klx(s[0],'5m',1000);if(b.length){BASE[s[0]]=b;LS[s[0]]=true}}catch(e){}}\n if(S.tab==='watch')renderWatch()}\nasync function pollLive(){\n if(HOST||!isLive())return;\n try{const [a,b]=await Promise.all([klx(S.sym,S.tf,3),klx(S.sym,'5m',3)]);if(LTF)merge(LTF,a);merge(BASE[S.sym],b)}catch(e){}\n afterTick()}\nfunction setBadge(){const b=$('#src'),l=isLive();if(HOST)parent.postMessage({tk:1,type:'badge',live:l},'*');b.textContent=l?(srcOf(S.sym)==='hl'?'Hyperliquid live':srcOf(S.sym)==='srv'?'MT5 live':'Binance live'):'Simulated data';b.classList.toggle('live',l);b.title=l?'Real market data':'Live data could not be reached from this page, so prices are simulated.'}\nfunction addQuickAlert(price){\n const B=BASE[S.sym],cur=B[B.length-1].c;price=parseFloat(fmtP(price));\n if(Math.abs(price-cur)/cur<1e-5){toast('Pick a level away from the current price');return}\n const dir=price>cur?'above':'below';alerts.push({id:Date.now(),sym:S.sym,dir,price,on:true});store.set('tk.alerts',alerts);dirty=true;toast('Alert set: '+symName(S.sym)+' '+dir+' '+fmtP(price))}\n/* UI wiring */\nfunction setSym(id,toChart){\n S.sym=id;$('#symSel').value=id;S.off=6;S.yz=1;S.yo=0;loadD();syncProps();\n LTF=null;setBadge();if(!LS[id]||true)loadLive().then(ok=>{if(!ok)rebuild()});rebuild();\n updHeader();store.set('tk.sym',id);if(toChart)go('chart');if(S.tab==='alerts')renderAlerts()}\nfunction setTf(id){\n const t=TFS.find(x=>x[0]===id);S.tf=id;TF=t[1];S.off=6;S.yz=1;S.yo=0;\n $$('#tfs button[data-tf]').forEach(b=>b.classList.toggle('on',b.dataset.tf===id));\n LTF=null;if(isLive())loadLive().then(ok=>{if(!ok)rebuild()});rebuild();if(HOST)parent.postMessage({tk:1,type:'tf',tf:id},'*');store.set('tk.tf',id);$('#mTime').textContent=id;renderFavs();closePanel()}\nfunction go(tab){\n S.tab=tab;$$('.view').forEach(v=>v.classList.toggle('on',v.id==='v-'+tab));$$('.tabs button').forEach(b=>b.classList.toggle('on',b.dataset.go===tab));\n if(tab==='watch')renderWatch();if(tab==='alerts')renderAlerts();if(tab==='script')renderInd();if(tab==='chart'){requestAnimationFrame(()=>{resize();dirty=true})}}\n$('.tabs').addEventListener('click',e=>{const b=e.target.closest('button');if(b)go(b.dataset.go)});\nfunction buildSel(){const cats=[...new Set(SYMS.map(s=>s[4]))];$('#symSel').innerHTML=cats.map(c=>`<optgroup label=\"${c}\">`+SYMS.filter(s=>s[4]===c).map(s=>`<option value=\"${s[0]}\">${s[1]}</option>`).join('')+'</optgroup>').join('');$('#symSel').value=S.sym}\nbuildSel();\n$('#symSel').addEventListener('change',e=>setSym(e.target.value));\nlet panelName=null;\nfunction openPanel(n){panelName=panelName===n?null:n;$('#panel').hidden=!panelName;$$('#panel [data-p]').forEach(p=>p.hidden=p.dataset.p!==panelName);if(panelName==='style')buildStyle();syncMenu();setTimeout(()=>{resize();dirty=true},30)}\nfunction closePanel(){if(panelName)openPanel(panelName)}\nwindow.syncMenu=function(){\n renderFavs();\n const t=TOOLS.find(x=>x[0]===tool),drawing=tool!=='select'&&tool!=='cross';\n $('#mDraw').textContent=drawing||tool==='cross'?t[1]:'Draw';$('#mDraw').classList.toggle('on',panelName==='draw'||drawing||tool==='cross');\n $('#mTime').classList.toggle('on',panelName==='time');$('#mStyle').classList.toggle('on',panelName==='style');\n const lb=$('#lockBtn');lb.textContent=S.lock?'Locked':'Lock';lb.classList.toggle('on',S.lock);lb.setAttribute('aria-pressed',S.lock)};\n$('#menu').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.id==='lockBtn'){setLock(!S.lock);return}openPanel(b.dataset.m)});\n$('#tfs').innerHTML=TFS.map(t=>`<button data-tf=\"${t[0]}\">${t[0]}</button>`).join('');\n$('#tgl').innerHTML='<button data-t=\"vol\" class=\"on\">Volume</button><button data-t=\"tpo\">TPO</button><button data-t=\"prev\" hidden>&lsaquo; Day</button><span class=\"lbl\" id=\"tpoLbl\" hidden></span><button data-t=\"next\" hidden>Day &rsaquo;</button>';\n$('#tfs').addEventListener('click',e=>{const b=e.target.closest('button');if(b)setTf(b.dataset.tf)});\n$('#tgl').addEventListener('click',e=>{\n const b=e.target.closest('button');if(!b)return;const t=b.dataset.t;\n if(t==='vol'){S.vol=!S.vol;b.classList.toggle('on',S.vol)}\n if(t==='tpo'){S.tpo=!S.tpo;b.classList.toggle('on',S.tpo);$$('#tgl [data-t=prev],#tgl [data-t=next],#tpoLbl').forEach(x=>x.hidden=!S.tpo);refreshTPO()}\n if(t==='prev'){S.tpoDay=Math.min(28,S.tpoDay+1);refreshTPO()}\n if(t==='next'){S.tpoDay=Math.max(0,S.tpoDay-1);refreshTPO()}\n dirty=true});\n$('#tools').innerHTML=TOOLS.map(t=>`<button data-tool=\"${t[0]}\" class=\"${t[0]==='long'?'lg':t[0]==='short'?'sh':''}${t[0]==='select'?' on':''}\">${t[1]}</button>`).join('');\n$('#tools').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const n=b.dataset.tool;setTool(n==='cross'&&tool==='cross'?'select':n);if(!S.lock&&n!=='select')closePanel()});\n$('#sbEdit').addEventListener('click',()=>{if(panelName!=='draw')openPanel('draw')});\n$('#sbDel').addEventListener('click',delSel);\n/* favourites: long-press a timeframe or tool to pin it */\nlet FAV=store.get('tk.fav',[]);\nconst favKey=b=>b.dataset.tf?'tf:'+b.dataset.tf:b.dataset.tool?'tool:'+b.dataset.tool:null;\nfunction renderFavs(){\n const bar=$('#favs');bar.hidden=!FAV.length;\n bar.innerHTML=FAV.map(k=>{const p=k.split(':'),v=p[1],lab=p[0]==='tf'?v:(TOOLS.find(x=>x[0]===v)||[0,v])[1],on=p[0]==='tf'?S.tf===v:tool===v;return `<button data-fav=\"${k}\" class=\"${on?'on':''}${v==='long'?' lg':v==='short'?' sh':''}\">${lab}</button>`}).join('');\n $$('#tfs button,#tools button').forEach(b=>b.classList.toggle('fav',FAV.includes(favKey(b))))}\nfunction toggleFav(k){const i=FAV.indexOf(k);if(i>=0){FAV.splice(i,1);toast('Removed from favourites')}else{FAV.push(k);toast('Added to favourites')}store.set('tk.fav',FAV);renderFavs();setTimeout(()=>{resize();dirty=true},30)}\nfunction longPress(root){\n let t=0,fired=false;\n root.addEventListener('pointerdown',e=>{const b=e.target.closest('button');if(!b)return;fired=false;clearTimeout(t);t=setTimeout(()=>{const k=b.dataset.fav||favKey(b);if(!k)return;fired=true;toggleFav(k);try{navigator.vibrate&&navigator.vibrate(30)}catch(_){}},500)});\n ['pointerup','pointerleave','pointercancel'].forEach(ev=>root.addEventListener(ev,()=>clearTimeout(t)));\n root.addEventListener('click',e=>{if(fired){e.stopPropagation();e.preventDefault();fired=false}},true);\n root.addEventListener('contextmenu',e=>e.preventDefault())}\n['#tfs','#tools','#favs'].forEach(s=>longPress($(s)));\n$('#favs').addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const p=b.dataset.fav.split(':');if(p[0]==='tf')setTf(p[1]);else setTool(tool===p[1]&&p[1]!=='select'?'select':p[1])});\n/* delta profile panel */\nfunction buildDelta(){\n const sel=(k,l,opts)=>`<label>${l}<select data-ds=\"${k}\">${opts.map(o=>`<option value=\"${o[0]}\"${DELTA[k]===o[0]?' selected':''}>${o[1]}</option>`).join('')}</select></label>`;\n const rng=(k,l,mn,mx,st)=>`<div class=\"srow\"><label for=\"d_${k}\">${l}</label><input type=\"range\" id=\"d_${k}\" data-dr=\"${k}\" min=\"${mn}\" max=\"${mx}\" step=\"${st}\" value=\"${DELTA[k]}\"><span>${DELTA[k]}</span></div>`;\n const tg=(k,l)=>`<button data-dt=\"${k}\" class=\"${DELTA[k]?'on':''}\">${l}</button>`;\n $('#deltaPane').innerHTML='<div class=\"strip\">'+tg('on','Delta profile')+tg('x2','Volume highlighter')+tg('text','Box text')+tg('pocLine','POC line')+'</div>'+\n '<div class=\"dsel\">'+sel('sess','Session length',[['Auto','Auto (by timeframe)'],['4H','4 Hour'],['12H','12 Hour'],['3D','3 Day']])+sel('method','Delta polarity',[['polarity','Bar polarity'],['pressure','Buying/selling pressure']])+sel('noise','Noise filter',[['off','Off'],['low','Remove low delta rows'],['high','Remove high delta rows']])+'</div>'+\n rng('level','Noise strength',1,10,1)+rng('box','Box size',0.1,10,0.1)+rng('rows','Rows per session',5,60,1)+rng('period','Volume EMA period',5,50,1)+rng('mult','Volume strength',0.5,5,0.1)+\n '<div class=\"cgrid\">'+[['buy','Buy delta'],['sell','Sell delta'],['poc','POC row'],['outBull','Heavy bull'],['outBear','Heavy bear'],['norm','Normal candle']].map(c=>`<label>${c[1]}<input type=\"color\" data-dc=\"${c[0]}\" value=\"${DELTA[c[0]]}\"></label>`).join('')+'</div>'}\n$('#deltaPane').addEventListener('click',e=>{const b=e.target.closest('button[data-dt]');if(!b)return;DELTA[b.dataset.dt]=!DELTA[b.dataset.dt];b.classList.toggle('on',DELTA[b.dataset.dt]);saveDelta();syncMenu()});\n$('#deltaPane').addEventListener('change',e=>{const t=e.target;if(t.dataset.ds){DELTA[t.dataset.ds]=t.value;saveDelta()}});\n$('#deltaPane').addEventListener('input',e=>{const t=e.target;\n if(t.dataset.dr){DELTA[t.dataset.dr]=+t.value;t.nextElementSibling.textContent=t.value;saveDelta()}\n if(t.dataset.dc){DELTA[t.dataset.dc]=t.value;saveDelta()}});\n/* theme + candle style */\nfunction applyTheme(){const r=document.documentElement;if(S.theme==='auto')r.removeAttribute('data-theme');else r.setAttribute('data-theme',S.theme);store.set('tk.theme',S.theme);dirty=true}\nconst SCOL=[['up','Up body'],['dn','Down body'],['bUp','Up border'],['bDn','Down border'],['wUp','Up wick'],['wDn','Down wick']],SALP=[['bodyA','Body opacity'],['borderA','Border opacity'],['wickA','Wick opacity']];\nfunction sdef(k){readColors();return k==='up'?K.up:k==='dn'?K.dn:k[1]==='U'||k==='up'?K.cu:K.cd}\nfunction saveStyle(){store.set('tk.style',STYLE);dirty=true}\nfunction buildStyle(){\n $('#stylePane').innerHTML='<div class=\"srow\"><label>Theme</label></div><div class=\"strip\" id=\"thBtns\">'+['auto','dark','light'].map(t=>`<button data-th=\"${t}\" class=\"${S.theme===t?'on':''}\">${t[0].toUpperCase()+t.slice(1)}</button>`).join('')+'</div>'+\n '<div class=\"cgrid\">'+SCOL.map(c=>`<label>${c[1]}<input type=\"color\" data-k=\"${c[0]}\" value=\"${STYLE[c[0]]||sdef(c[0])}\"></label>`).join('')+'</div>'+\n SALP.map(c=>`<div class=\"srow\"><label for=\"s_${c[0]}\">${c[1]}</label><input type=\"range\" id=\"s_${c[0]}\" data-a=\"${c[0]}\" min=\"0\" max=\"1\" step=\"0.05\" value=\"${STYLE[c[0]]}\"><span>${Math.round(STYLE[c[0]]*100)}%</span></div>`).join('')+\n '<div class=\"strip\">'+[['hGrid','Horizontal grid'],['vGrid','Vertical grid']].map(c=>`<button data-g=\"${c[0]}\" class=\"${STYLE[c[0]]?'on':''}\">${c[1]}</button>`).join('')+'</div><div class=\"strip\"><button id=\"stReset\">Reset candle style</button></div>'}\n$('#stylePane').addEventListener('click',e=>{\n const b=e.target.closest('button');if(!b)return;\n if(b.dataset.th){S.theme=b.dataset.th;applyTheme();buildStyle()}\n if(b.dataset.g){STYLE[b.dataset.g]=!STYLE[b.dataset.g];saveStyle();buildStyle()}\n if(b.id==='stReset'){Object.assign(STYLE,{up:'',dn:'',bUp:'',bDn:'',wUp:'',wDn:'',bodyA:1,borderA:1,wickA:1,hGrid:false,vGrid:false});saveStyle();buildStyle()}});\n$('#stylePane').addEventListener('input',e=>{\n const t=e.target;if(t.dataset.k){STYLE[t.dataset.k]=t.value;saveStyle()}\n if(t.dataset.a){STYLE[t.dataset.a]=+t.value;t.nextElementSibling.textContent=Math.round(t.value*100)+'%';saveStyle()}});\n/* script tab */\n/* boot */\nfunction boot(){\n loadInds();DELTA.on=false;DELTA.x2=false;\n SYMS.forEach(s=>{BASE[s[0]]=genBase(s[0],s[2])});\n S.theme=store.get('tk.theme','auto');applyTheme();S.lock=store.get('tk.lock',false);\n S.sym=store.get('tk.sym','BTCUSDT');if(!SYMS.some(x=>x[0]===S.sym))S.sym='BTCUSDT';S.tf=store.get('tk.tf','1h');if(!TFS.some(t=>t[0]===S.tf))S.tf='1h';TF=TFS.find(t=>t[0]===S.tf)[1];\n $('#symSel').value=S.sym;$('#mTime').textContent=S.tf;$$('#tfs button[data-tf]').forEach(b=>b.classList.toggle('on',b.dataset.tf===S.tf));\n loadD();syncProps();setBadge();rebuild();updHeader();\n /* hide / show the controls so the chart gets the whole screen */\nlet FOLD=store.get('tk.fold',false);\nfunction applyFold(){document.body.classList.toggle('fold',FOLD);const b=$('#fold');if(b){b.setAttribute('aria-pressed',FOLD);b.title=FOLD?'Show controls':'Hide controls';b.innerHTML=FOLD?'&#9660;':'&#9650;'}\n if(HOST)parent.postMessage({tk:1,type:'focus',on:FOLD},'*');requestAnimationFrame(()=>{resize();dirty=true})}\n$('#fold').addEventListener('click',()=>{FOLD=!FOLD;store.set('tk.fold',FOLD);applyFold()});\n$('#autoBtn').addEventListener('click',()=>{resetScale();toast('Price scale: auto')});\napplyFold();\nnew ResizeObserver(resize).observe(cv.parentElement);resize();requestAnimationFrame(loop);\n setInterval(()=>{if(isLive())pollLive();simTick()},1500);setInterval(()=>{dirty=true},1000);\n loadLive().then(ok=>{if(ok){toast('Connected to live data');loadAllLive()}})}\n$('#src').addEventListener('click',async()=>{if(isLive()){toast('Live data is running');return}toast('Retrying live data...');LASTERR='';const ok=await loadLive();toast(ok?'Connected to live data':'Not connected: '+(LASTERR||'blocked or offline')+(location.protocol==='file:'?'':' (page: '+location.hostname+')'))});\nfunction dl(name,text,type){const b=new Blob([text],{type:type||'text/plain'}),u=URL.createObjectURL(b),x=document.createElement('a');x.href=u;x.download=name;document.body.appendChild(x);x.click();x.remove();setTimeout(()=>URL.revokeObjectURL(u),4000)}\n$('#bkExp').addEventListener('click',()=>{dl('tradergze-settings.json',JSON.stringify(tkSnapshot()),'application/json');toast('Settings file saved')});\n$('#bkPage').addEventListener('click',()=>{\n try{const snap=tkSnapshot();let src=ORIG.replace(new RegExp('<scr'+'ipt id=\"tk-'+'embed\"[^>]*>[^<]*<'+'/scr'+'ipt>'),'');\n  const tag='<scr'+'ipt id=\"tk-'+'embed\" type=\"application/json\">'+JSON.stringify(snap).replace(/</g,'\\\\u003c')+'<'+'/script>';\n  const k=src.indexOf('</head>');src=k>=0?src.slice(0,k)+tag+src.slice(k):tag+src;\n  if(!/^<!doctype/i.test(src))src='<!doctype html>\\n'+src;\n  dl('tradergze-mine.html',src,'text/html');toast('Saved a copy of the page with your settings')}catch(e){toast('Could not save: '+e.message)}});\n$('#bkImp').addEventListener('click',()=>$('#bkFile').click());\n$('#bkFile').addEventListener('change',e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();\n r.onload=()=>{try{const d=JSON.parse(r.result);if(!d||!d.data)throw 0;for(const k in d.data)localStorage.setItem(k,d.data[k]);toast('Settings imported, reloading');setTimeout(()=>location.reload(),700)}catch(x){toast('That is not a Tickline settings file')}};r.readAsText(f);e.target.value=''});\nboot();\nif(HOST){document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();parent.postMessage({tk:1,type:'cmdk'},'*')}});document.body.classList.add('host');parent.postMessage({tk:1,type:'ready'},'*')}\n</script>\n<script>/* TraderGze Trade Terminal: your own MT5 trades from this chart (needs the TraderGze EA v1.11 in MT5).\n * - Chart symbol -> broker symbol: BTCUSDT -> BTC (your BTCUSD), XAUUSD247 -> GOLD (your XAUUSD247).\n * - A Long / Short box on the chart is the order: drag its entry, stop and target; the Trade tab sends it.\n * - Open positions and pending orders are drawn as boxes too: drag their stop / target (or a pending entry) and let go\n *   to change them in MT5.\n * - Prices: every level is sent as seen on this chart plus the chart price at that moment; the EA moves all levels by\n *   the difference to your broker's price, so a small BTCUSDT / BTCUSD difference does not matter. */\n(function () {\n  'use strict';\n  const MAP = { BTCUSDT: 'BTC', 'MT5:GOLD': 'GOLD' };\n  const NAME = { BTC: 'BTCUSD', GOLD: 'XAUUSD247' };\n  const T = { risk: store.get('tt.risk', 1), be: store.get('tt.be', 0.2), pr: store.get('tt.pr', 1), pp: store.get('tt.pp', 50), kind: 'auto' };\n  let ST = null, busy = false, built = false;\n  const tk = () => MAP[S.sym];\n  const bars = () => (LTF && LTF.length ? LTF : BASE[S.sym] || []);\n  const last = () => { const b = bars(); return b.length ? b[b.length - 1].c : 0; };\n  const lastT = () => { const b = bars(); return b.length ? b[b.length - 1].t : Date.now(); };\n  const brokerSym = () => (ST && ST.quotes && ST.quotes[tk()] ? ST.quotes[tk()].symbol : NAME[tk()]);\n  const mid = () => { const q = ST && ST.quotes && ST.quotes[tk()]; return q && q.bid > 0 ? (q.bid + q.ask) / 2 : 0; };\n  // chart level = broker level + off\n  const off = () => { const m = mid(), l = last(); return m && l && Math.abs(l - m) / l < 0.02 ? l - m : 0; };\n  const E = (s) => String(s == null ? '' : s).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]));\n  const num = (x) => (x == null || !isFinite(x) ? '—' : fmtP(+x));\n  const money = (x) => (x == null ? '—' : (x >= 0 ? '+' : '') + (+x).toFixed(2));\n  async function call(path, body) {\n    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' } : { credentials: 'same-origin' });\n    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status); return j;\n  }\n\n  // ---------------------------------------------------------------- no price alerts any more: the axis \"+\" drafts a limit order\n  alerts = []; store.set('tk.alerts', []);\n  checkAlerts = function () {};\n  addQuickAlert = function (price) {\n    if (!tk()) { toast('Trading works on BTC/USDT and XAUUSD247'); return; }\n    const cur = last(); price = parseFloat(fmtP(price));\n    if (!cur || Math.abs(price - cur) / cur < 1e-5) { toast('Pick a level away from the current price'); return; }\n    const d = orderBox(price < cur ? 'long' : 'short', price);\n    drawings.push(d); sel = d; saveD(); dirty = true; T.kind = 'limit';\n    toast((price < cur ? 'BUY' : 'SELL') + ' limit at ' + fmtP(price) + ': drag stop / target / entry, then Send');\n  };\n\n  // ---------------------------------------------------------------- the order box on the chart\n  // a new box: stop 1.5x the average candle range away (at least 0.15% of the price), target 2R, a few candles back so its labels show\n  function orderBox(type, price) {\n    const b = bars().slice(-14), rng = b.length ? b.reduce((s, x) => s + (x.h - x.l), 0) / b.length : 0, r = Math.max(rng * 1.5, price * 0.0015), s = type === 'long' ? 1 : -1;\n    const d = mk(type, { t: lastT() - 6 * TF, p: price }); d.stop = price - s * r; d.tp = price + s * 2 * r; d.n = 10; d.draft = true; return d;\n  }\n  const isBox = (d) => d && (d.type === 'long' || d.type === 'short');\n  const draft = () => (isBox(sel) && !sel.live ? sel : drawings.slice().reverse().find((d) => isBox(d) && !d.live) || null);\n  function newDraft(type) {\n    if (!tk()) { toast('Trading works on BTC/USDT and XAUUSD247'); return; }\n    const d = orderBox(type, last());\n    drawings.push(d); sel = d; saveD(); dirty = true; T.kind = 'market';\n    go('chart'); toast('Drag stop / target on the chart, then Send');\n  }\n  // live boxes = your MT5 positions and pending orders on this symbol (not saved with your drawings)\n  function syncBoxes() {\n    if (G && G.mode && G.mode !== 'none') return;            // never while you drag\n    const keepSel = sel && sel.live ? sel.live.ticket : null, o = off(), sym = brokerSym();\n    drawings = drawings.filter((d) => !d.live);\n    if (!ST || !tk()) { dirty = true; return; }\n    const add = (x, kind, long, entry, slv, tpv, t) => {\n      const e = entry + o, risk = Math.abs(entry - (slv || entry)) || entry * 0.002;\n      const d = { id: uid++, type: long ? 'long' : 'short', c: long ? '#26b585' : '#e5534b', w: 2, pts: [{ t, p: e }, { t, p: e }], n: 14,\n        stop: slv ? slv + o : e - (long ? 1 : -1) * risk, tp: tpv ? tpv + o : e + (long ? 1 : -1) * risk * 2 };\n      d.live = { kind, ticket: x.ticket, entry: d.pts[0].p, stop: d.stop, tp: d.tp, hasSl: !!slv, hasTp: !!tpv, owner: x.owner };\n      drawings.push(d); if (keepSel === x.ticket) sel = d;\n    };\n    for (const p of ST.positions || []) if (p.symbol === sym) add(p, 'pos', p.side === 'buy', p.price, p.sl, p.tp, p.time ? p.time * 1000 : lastT());\n    for (const x of ST.orders || []) if (x.symbol === sym) add(x, 'ord', /^buy/.test(x.type), x.price, x.sl, x.tp, x.time ? x.time * 1000 : lastT());\n    dirty = true;\n  }\n  // saving drawings: live boxes are not saved; a live box you dragged is sent to MT5 as a change\n  const saveOrig = saveD;\n  saveD = function () {\n    const live = drawings.filter((d) => d.live);\n    drawings = drawings.filter((d) => !d.live); saveOrig(); drawings = drawings.concat(live);\n    for (const d of live) liveEdit(d);\n  };\n  const moved = (a, b) => Math.abs(a - b) > Math.abs(b) * 1e-6;\n  async function liveEdit(d) {\n    const L = d.live, ch = {};\n    if (moved(d.stop, L.stop)) ch.sl = d.stop;\n    if (moved(d.tp, L.tp)) ch.tp = d.tp;\n    if (L.kind === 'ord' && moved(d.pts[0].p, L.entry)) ch.entry = d.pts[0].p;\n    if (L.kind === 'pos' && moved(d.pts[0].p, L.entry)) { toast('The entry of an open trade cannot move'); setTimeout(syncBoxes, 50); }\n    if (!Object.keys(ch).length) return;\n    const txt = Object.entries(ch).map(([k, v]) => ({ sl: 'SL', tp: 'TP', entry: 'entry' }[k]) + ' ' + fmtP(v)).join(', ');\n    if (!confirm('Change ' + (L.kind === 'pos' ? 'position' : 'pending order') + ' #' + L.ticket + ' in MT5: ' + txt + '?')) { syncBoxes(); return; }\n    Object.assign(L, { stop: d.stop, tp: d.tp, entry: d.pts[0].p });\n    try { const r = await call('/api/term/modify', Object.assign({ ticket: L.ticket, ref: last() }, ch)); toast(r.message || 'Sent'); } catch (e) { toast('Not sent: ' + e.message); }\n  }\n\n  // ---------------------------------------------------------------- the Trade tab\n  function skeleton() {\n    $('#alw').innerHTML = '<div id=\"ttConn\"></div>' +\n      '<h2>New order</h2><div id=\"ttTicket\"></div>' +\n      '<h2>Open positions</h2><div id=\"ttPos\"></div>' +\n      '<h2>Pending orders</h2><div id=\"ttOrd\"></div>' +\n      '<h2>Log</h2><div id=\"ttLog\"></div>';\n    const tkEl = $('#ttTicket');\n    tkEl.innerHTML =\n      '<div class=\"form tt-row\"><button class=\"btn tt-long\" data-tt=\"newlong\">+ Long box</button><button class=\"btn tt-short\" data-tt=\"newshort\">+ Short box</button></div>' +\n      '<div id=\"ttDraft\" class=\"tt-mut\"></div>' +\n      '<div class=\"tt-grid\">' +\n      '<label>Type<select id=\"ttKind\"><option value=\"auto\">Auto (market if at price)</option><option value=\"market\">Market now</option><option value=\"limit\">Limit / stop at entry</option></select></label>' +\n      '<label>Entry<input id=\"ttEntry\" inputmode=\"decimal\"></label><label>Stop loss<input id=\"ttSl\" inputmode=\"decimal\"></label><label>Take profit<input id=\"ttTp\" inputmode=\"decimal\"></label>' +\n      '</div>' +\n      '<div class=\"srow\"><label for=\"ttRisk\">Risk</label><input type=\"range\" id=\"ttRisk\" min=\"0.1\" max=\"10\" step=\"0.1\"><span id=\"ttRiskV\"></span></div>' +\n      '<div class=\"tt-row\" id=\"ttRiskQ\">' + [0.5, 1, 2, 3, 5].map((v) => '<button data-rq=\"' + v + '\">' + v + '%</button>').join('') + '</div>' +\n      '<div class=\"srow\"><label for=\"ttBe\">SL to BE at</label><input type=\"range\" id=\"ttBe\" min=\"0\" max=\"3\" step=\"0.1\"><span id=\"ttBeV\"></span></div>' +\n      '<div class=\"srow\"><label for=\"ttPr\">Part profit at</label><input type=\"range\" id=\"ttPr\" min=\"0\" max=\"5\" step=\"0.1\"><span id=\"ttPrV\"></span></div>' +\n      '<div class=\"srow\"><label for=\"ttPp\">Part size</label><input type=\"range\" id=\"ttPp\" min=\"10\" max=\"90\" step=\"5\"><span id=\"ttPpV\"></span></div>' +\n      '<div id=\"ttSum\" class=\"tt-sum\"></div>' +\n      '<div class=\"form\"><button class=\"btn\" id=\"ttSend\">Send to MT5</button></div>';\n    $('#ttRisk').value = T.risk; $('#ttBe').value = T.be; $('#ttPr').value = T.pr; $('#ttPp').value = T.pp; $('#ttKind').value = T.kind;\n    const setV = () => { T.risk = +$('#ttRisk').value; T.be = +$('#ttBe').value; T.pr = +$('#ttPr').value; T.pp = +$('#ttPp').value; T.kind = $('#ttKind').value;\n      store.set('tt.risk', T.risk); store.set('tt.be', T.be); store.set('tt.pr', T.pr); store.set('tt.pp', T.pp); summary(); };\n    ['#ttRisk', '#ttBe', '#ttPr', '#ttPp', '#ttKind'].forEach((s) => $(s).addEventListener('input', setV));\n    // typing a level moves the box on the chart\n    [['#ttEntry', 'entry'], ['#ttSl', 'stop'], ['#ttTp', 'tp']].forEach(([s, k]) => $(s).addEventListener('change', () => {\n      const d = draft(), v = parseFloat($(s).value); if (!d || !(v > 0)) return;\n      if (k === 'entry') { const dp = v - d.pts[0].p; d.pts[0].p = v; d.pts[1].p = v; d.stop += dp; d.tp += dp; } else d[k] = v;\n      saveD(); dirty = true; fillTicket(true);\n    }));\n    $('#alw').addEventListener('click', onClick);\n    built = true;\n  }\n  function kindOf(d) {\n    if (T.kind === 'market') return 'market';\n    if (T.kind === 'limit') return 'limit';\n    return Math.abs(d.pts[0].p - last()) / last() < 0.0005 ? 'market' : 'limit';\n  }\n  function fillTicket(force) {\n    const d = draft(), f = document.activeElement;\n    $('#ttDraft').innerHTML = !tk() ? '<span class=\"tt-warn\">This chart (' + E(symName(S.sym)) + ') cannot be traded. Switch to BTC/USDT or XAUUSD247.</span>'\n      : d ? (d.type === 'long' ? '🟢 LONG' : '🔴 SHORT') + ' box on ' + E(symName(S.sym)) + ' → MT5 ' + E(brokerSym()) + ' · tap a box on the chart to choose it'\n      : 'No order box yet: tap <b>+ Long box</b> / <b>+ Short box</b>, use the <b>+</b> on the price axis for a limit order, or draw a Long / Short with the Draw menu.';\n    for (const [s, v] of [['#ttEntry', d && d.pts[0].p], ['#ttSl', d && d.stop], ['#ttTp', d && d.tp]]) if (force || f !== $(s)) $(s).value = d ? fmtP(v) : '';\n    summary();\n  }\n  function summary() {\n    $('#ttRiskV').textContent = T.risk + '%'; $('#ttBeV').textContent = T.be ? '+' + T.be + 'R' : 'off'; $('#ttPrV').textContent = T.pr ? '+' + T.pr + 'R' : 'off'; $('#ttPpV').textContent = T.pp + '%';\n    const d = draft(), bal = ST && ST.account ? ST.account.balance : null, cur = ST && ST.account ? ST.account.currency : '';\n    if (!d) { $('#ttSum').innerHTML = ''; return; }\n    const k = kindOf(d), e = k === 'market' ? last() : d.pts[0].p, r = Math.abs(e - d.stop), rr = r ? Math.abs(d.tp - e) / r : 0, long = d.type === 'long';\n    const kname = k === 'market' ? (long ? 'BUY market' : 'SELL market') : long ? (e < last() ? 'BUY LIMIT' : 'BUY STOP') : e > last() ? 'SELL LIMIT' : 'SELL STOP';\n    const bad = long ? d.stop >= e : d.stop <= e;\n    $('#ttSum').innerHTML = '<b>' + kname + '</b> ' + E(brokerSym()) + ' at ' + fmtP(e) + ' · SL ' + fmtP(d.stop) + ' · TP ' + fmtP(d.tp) + ' · <b>R:R ' + rr.toFixed(2) + '</b><br>' +\n      'Risk ' + T.risk + '%' + (bal ? ' ≈ ' + (bal * T.risk / 100).toFixed(2) + ' ' + E(cur) : '') + ' · SL to entry at ' + (T.be ? '+' + T.be + 'R' : 'off') + ' · ' + (T.pr && T.pp ? T.pp + '% closed at +' + T.pr + 'R' : 'no part profit') +\n      (bad ? '<br><span class=\"tt-warn\">The stop is on the wrong side of the entry.</span>' : '') +\n      (!ST || !ST.connected ? '<br><span class=\"tt-warn\">MT5 is not connected: the order waits up to 3 minutes for the EA.</span>' : '') +\n      (!isLive() ? '<br><span class=\"tt-warn\">The chart shows simulated prices: sending is blocked until live data is back.</span>' : '');\n  }\n  async function send() {\n    const d = isBox(sel) && !sel.live ? sel : draft(); if (!d || !tk()) { toast('Place a Long or Short box first'); return; }\n    // never trade from simulated prices: the chart must show real live data\n    if (!isLive()) { toast('The chart shows simulated prices (no live data): no order sent. Tap the data badge to retry.'); return; }\n    if (busy) return;\n    const k = kindOf(d), e = k === 'market' ? last() : d.pts[0].p, long = d.type === 'long';\n    const msg = (long ? 'BUY' : 'SELL') + (k === 'limit' ? ' limit/stop at ' + fmtP(e) : ' at market') + ' ' + brokerSym() + '\\nSL ' + fmtP(d.stop) + ' · TP ' + fmtP(d.tp) + '\\nRisk ' + T.risk + '% · SL to entry at ' + (T.be ? '+' + T.be + 'R' : 'off') + ' · ' + (T.pr && T.pp ? T.pp + '% profit at +' + T.pr + 'R' : 'no part profit') + '\\n\\nSend to MT5?';\n    if (!confirm(msg)) return;\n    busy = true;\n    try {\n      const r = await call('/api/term/order', { ticker: tk(), side: d.type, kind: k, entry: k === 'limit' ? d.pts[0].p : undefined, sl: d.stop, tp: d.tp, ref: last(), risk: T.risk, be: T.be, pr: T.pr, pp: T.pp });\n      toast(r.message || (r.ok ? 'Sent' : 'Not sent'));\n      if (r.ok) { drawings = drawings.filter((x) => x !== d); if (sel === d) sel = null; saveD(); dirty = true; setTimeout(poll, 2500); }\n    } catch (err) { toast('Not sent: ' + err.message); }\n    busy = false;\n  }\n  async function onClick(e) {\n    const b = e.target.closest('button'); if (!b) return;\n    if (b.dataset.tt === 'newlong') return newDraft('long');\n    if (b.dataset.tt === 'newshort') return newDraft('short');\n    if (b.dataset.rq) { T.risk = +b.dataset.rq; $('#ttRisk').value = T.risk; store.set('tt.risk', T.risk); summary(); return; }\n    if (b.id === 'ttSend') return send();\n    if (b.dataset.close && confirm('Close position #' + b.dataset.close + ' at market?')) { const r = await call('/api/term/close', { ticket: b.dataset.close }).catch((x) => ({ message: x.message })); toast(r.message); return; }\n    if (b.dataset.cancel && confirm('Cancel pending order #' + b.dataset.cancel + '?')) { const r = await call('/api/term/cancel', { ticket: b.dataset.cancel }).catch((x) => ({ message: x.message })); toast(r.message); return; }\n    if (b.dataset.show) { const s = Object.keys(MAP).find((k) => NAME[MAP[k]] === b.dataset.show || (ST.quotes[MAP[k]] && ST.quotes[MAP[k]].symbol === b.dataset.show)); if (s) { setSym(s, true); setTimeout(syncBoxes, 600); } return; }\n  }\n  function lists() {\n    const s = ST || {}, a = s.account;\n    $('#ttConn').innerHTML = s.connected\n      ? '<div class=\"tt-ok\">● MT5 connected' + (a ? ' · ' + E(a.server) + ' #' + E(a.login) + ' · balance ' + (+a.balance).toFixed(2) + ' · equity ' + (+a.equity).toFixed(2) + ' ' + E(a.currency) : '') + (s.ea !== '1.11' ? '<br><span class=\"tt-warn\">Update the EA to v1.11 to trade from here.</span>' : '') + '</div>'\n      : '<div class=\"tt-warn\">● MT5 not connected' + (s.lastSeen ? ' (last seen ' + new Date(s.lastSeen * 1000).toLocaleTimeString() + ')' : '') + '. Keep MT5 running with the TraderGze EA v1.11.</div>';\n    const pos = s.positions || [], ord = s.orders || [];\n    $('#ttPos').innerHTML = pos.length ? pos.map((p) => '<div class=\"al\"><div class=\"t\"><b>' + (p.side === 'buy' ? '🟢 BUY' : '🔴 SELL') + ' ' + E(p.symbol) + '</b> ' + p.volume + ' @ ' + num(p.price) +\n      '<br><span class=\"tt-mut\">SL ' + num(p.sl || null) + ' · TP ' + num(p.tp || null) + ' · ' + E(p.owner) + ' · #' + E(p.ticket) + '</span></div><span class=\"' + (p.profit >= 0 ? 'tt-up' : 'tt-dn') + '\">' + money(p.profit) + '</span>' +\n      '<button data-show=\"' + E(p.symbol) + '\">Chart</button><button data-close=\"' + E(p.ticket) + '\" class=\"del\">Close</button></div>').join('') : '<p class=\"tt-mut\">No open positions.</p>';\n    $('#ttOrd').innerHTML = ord.length ? ord.map((o) => '<div class=\"al\"><div class=\"t\"><b>' + E(o.type.toUpperCase()) + ' ' + E(o.symbol) + '</b> ' + o.volume + ' @ ' + num(o.price) +\n      '<br><span class=\"tt-mut\">SL ' + num(o.sl || null) + ' · TP ' + num(o.tp || null) + ' · ' + E(o.owner) + ' · #' + E(o.ticket) + '</span></div><button data-show=\"' + E(o.symbol) + '\">Chart</button><button data-cancel=\"' + E(o.ticket) + '\" class=\"del\">Cancel</button></div>').join('') : '<p class=\"tt-mut\">No pending orders.</p>';\n    const L = (s.log || []).slice(0, 25);\n    $('#ttLog').innerHTML = L.length ? L.map((x) => '<div class=\"tt-log\"><span class=\"tt-mut\">' + new Date(x.t * 1000).toLocaleString() + '</span> ' + (x.ok ? '✅' : '⚠️') + ' <b>' + E(x.type) + '</b> ' + E(x.who || '') + ' ' + E(x.ticker || '') + ' ' + E(x.side || '') + (x.ticket && x.ticket !== '0' ? ' #' + E(x.ticket) : '') + '<br>' + E(x.message || '') + '</div>').join('') : '<p class=\"tt-mut\">Nothing sent yet.</p>';\n  }\n  renderAlerts = function () { if (!built) skeleton(); fillTicket(); lists(); };\n\n  // ---------------------------------------------------------------- the compact order bar on the chart (about 1/10 of the screen)\n  // shows for the order box you work on (tap + on the price axis, + Long / + Short, or tap a box), or for a live position /\n  // order you tap. Drag the box on the chart: its top / bottom edge is the target / stop, its left edge moves a limit entry.\n  const BE_STEPS = [0, 0.2, 0.5, 1], PART_STEPS = [[0, 0], [1, 50], [2, 50], [1, 30]];\n  const bar = document.createElement('div'); bar.id = 'ttBar'; bar.hidden = true;\n  (document.querySelector('.stage') || document.body).appendChild(bar);\n  function barHtml() {\n    const d = isBox(sel) ? sel : null;\n    if (!tk() || S.tab !== 'chart' || !d) return '';\n    if (d.live) {\n      const L = d.live, x = (L.kind === 'pos' ? ST.positions : ST.orders || []).find((y) => y.ticket === L.ticket) || {};\n      return '<div class=\"tb1\"><b>' + (d.type === 'long' ? '🟢 BUY' : '🔴 SELL') + (L.kind === 'ord' ? ' ' + E((x.type || '').toUpperCase()) : '') + '</b> #' + E(L.ticket) + ' · ' + (x.volume || '') + ' lot' +\n        (L.kind === 'pos' ? ' · <span class=\"' + (x.profit >= 0 ? 'tt-up' : 'tt-dn') + '\">' + money(x.profit) + '</span>' : '') + '</div>' +\n        '<div class=\"tb2\"><span class=\"tt-mut\">drag SL / TP' + (L.kind === 'ord' ? ' / entry' : '') + ' on the chart</span><button data-tb=\"' + (L.kind === 'pos' ? 'close' : 'cancel') + '\" class=\"tbx\">' + (L.kind === 'pos' ? 'Close' : 'Cancel') + '</button><button data-tb=\"hide\">✕</button></div>';\n    }\n    const k = kindOf(d), e = k === 'market' ? last() : d.pts[0].p, r = Math.abs(e - d.stop), rr = r ? Math.abs(d.tp - e) / r : 0, long = d.type === 'long';\n    const kname = k === 'market' ? 'MKT' : long ? (e < last() ? 'BUY LMT' : 'BUY STP') : e > last() ? 'SELL LMT' : 'SELL STP';\n    const pi = PART_STEPS.findIndex((p) => p[0] === T.pr && p[1] === T.pp);\n    return '<div class=\"tb1\"><button data-tb=\"side\" class=\"' + (long ? 'tbl' : 'tbs') + '\">' + (long ? 'BUY' : 'SELL') + '</button><button data-tb=\"kind\">' + kname + '</button><button data-tb=\"x\" class=\"tbc\">Cancel</button><span>' + fmtP(e) + ' · R:R <b>' + rr.toFixed(1) + '</b></span></div>' +\n      '<div class=\"tb2\"><button data-tb=\"r-\">−</button><b>' + T.risk + '%</b><button data-tb=\"r+\">+</button><button data-tb=\"be\">BE ' + (T.be ? T.be + 'R' : 'off') + '</button><button data-tb=\"part\">' + (T.pr && T.pp ? T.pp + '%@' + T.pr + 'R' : 'no part') + '</button><button data-tb=\"send\" class=\"tbgo\">Send</button></div>';\n  }\n  let barLast = '';\n  function drawBar() { const h = barHtml(); bar.hidden = !h; if (h !== barLast) { bar.innerHTML = h; barLast = h; } }\n  bar.addEventListener('pointerdown', (e) => e.stopPropagation());\n  bar.addEventListener('click', async (e) => {\n    const b = e.target.closest('button'); if (!b) return; const a = b.dataset.tb, d = isBox(sel) ? sel : null; if (!d) return;\n    if (a === 'side') { const long = d.type === 'long', ent = d.pts[0].p; d.type = long ? 'short' : 'long'; d.c = long ? '#e5534b' : '#26b585'; d.stop = 2 * ent - d.stop; d.tp = 2 * ent - d.tp; saveD(); }\n    else if (a === 'kind') { T.kind = kindOf(d) === 'market' ? 'limit' : 'market'; if (T.kind === 'market') { const dp = last() - d.pts[0].p; d.pts[0].p += dp; d.pts[1].p += dp; d.stop += dp; d.tp += dp; saveD(); } }\n    else if (a === 'r-' || a === 'r+') { T.risk = Math.min(10, Math.max(0.5, +(T.risk + (a === 'r+' ? 0.5 : -0.5)).toFixed(1))); store.set('tt.risk', T.risk); }\n    else if (a === 'be') { T.be = BE_STEPS[(BE_STEPS.indexOf(T.be) + 1) % BE_STEPS.length]; store.set('tt.be', T.be); }\n    else if (a === 'part') { const i = !T.pr || !T.pp ? 0 : Math.max(0, PART_STEPS.findIndex((p) => p[0] === T.pr && p[1] === T.pp)), n = PART_STEPS[(i + 1) % PART_STEPS.length]; T.pr = n[0]; T.pp = n[1]; store.set('tt.pr', T.pr); store.set('tt.pp', T.pp); }\n    else if (a === 'x') { drawings = drawings.filter((x) => x !== d); sel = null; saveD(); }\n    else if (a === 'hide') sel = null;\n    else if (a === 'send') { await send(); }\n    else if (a === 'close' && confirm('Close position #' + d.live.ticket + ' at market?')) toast((await call('/api/term/close', { ticket: d.live.ticket }).catch((x) => ({ message: x.message }))).message);\n    else if (a === 'cancel' && confirm('Cancel order #' + d.live.ticket + '?')) toast((await call('/api/term/cancel', { ticket: d.live.ticket }).catch((x) => ({ message: x.message }))).message);\n    dirty = true; drawBar();\n  });\n  setInterval(drawBar, 300);\n\n  // ---------------------------------------------------------------- refresh: every 3 s\n  async function poll() {\n    try { ST = await call('/api/term/state'); } catch (e) { ST = ST || null; }\n    syncBoxes();\n    if (S.tab === 'alerts') { if (!built) skeleton(); fillTicket(); lists(); }\n  }\n  setInterval(poll, 3000); setInterval(() => { if (S.tab === 'alerts' && built) fillTicket(); }, 700);\n  poll();\n\n  const css = document.createElement('style');\n  css.textContent = '.tt-row{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.tt-row button{flex:1}.tt-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:8px 0}' +\n    '.tt-grid label{display:flex;flex-direction:column;font-size:12px;color:var(--mute);gap:3px}.tt-grid input,.tt-grid select{width:100%}.tt-sum{font-size:13px;margin:8px 0;line-height:1.5}' +\n    '.tt-mut{color:var(--mute);font-size:12px}.tt-warn{color:var(--dn);font-size:12px}.tt-ok{color:var(--up);font-size:13px;margin-bottom:6px}.tt-up{color:var(--up);font-family:var(--mono)}.tt-dn{color:var(--dn);font-family:var(--mono)}' +\n    '.tt-long{background:#26b585!important;color:#fff!important}.tt-short{background:#e5534b!important;color:#fff!important}.tt-log{font-size:12px;padding:6px 0;border-bottom:1px solid var(--line, #333)}#ttDraft{font-size:12px;margin:4px 0}' +\n    '#ttBar{position:absolute;left:6px;right:6px;bottom:6px;z-index:30;max-height:11vh;background:var(--panel,#161b22);border:1px solid var(--line,#30363d);border-radius:10px;padding:4px 6px;box-shadow:0 4px 18px rgba(0,0,0,.45);font-size:12px;display:flex;flex-direction:column;gap:3px}' +\n    '#ttBar[hidden]{display:none}#ttBar .tb1,#ttBar .tb2{display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden}#ttBar .tb1 span{flex:1;overflow:hidden;text-overflow:ellipsis}' +\n    '#ttBar button{padding:3px 8px;min-height:26px;font-size:12px;border-radius:6px;border:1px solid var(--line,#30363d);background:var(--panel-2,#21262d);color:inherit}#ttBar .tbl{background:#26b585;color:#fff;border:0}#ttBar .tbs{background:#e5534b;color:#fff;border:0}' +\n    '#ttBar .tbgo{margin-left:auto;background:var(--acc,#e8a838);color:var(--acc-ink,#111);border:0;font-weight:700;padding:3px 14px}#ttBar .tbx{margin-left:auto;color:var(--dn,#e5534b)}#ttBar .tb1 span{flex:0 1 auto!important;min-width:0}#ttBar .tbc{color:var(--dn,#e5534b);border-color:var(--dn,#e5534b);padding:3px 7px!important}#ttBar .tbsp{display:none}body:has(#ttBar:not([hidden])) #toast{bottom:auto!important;top:96px!important}#ttBar b{font-weight:700}';\n  document.head.appendChild(css);\n})();\n</script>\n</body></html>";
/** The terminal page: packed into this file by build.js (TERMINAL_HTML), or read from src/terminal.html while developing. */
function terminalHtml() { if (typeof TERMINAL_HTML !== "undefined") return TERMINAL_HTML; if (!TERM_HTML) TERM_HTML = fs.readFileSync(path.join(__dirname, "..", "src", "terminal.html"), "utf8").replace("<!--TRADE-->", () => "<script>" + fs.readFileSync(path.join(__dirname, "..", "src", "terminal-trade.js"), "utf8") + "</script>"); return TERM_HTML; }
/** Everything the terminal shows: MT5 account, open positions (agents' and yours), pending orders, broker prices, the log. */
function termState() {
  const now = Math.floor(Date.now() / 1000), last = kvGet("deployLastPoll", 0), pos = kvGet("deployPositions", []);
  return { connected: !!last && now - last < 30, lastSeen: last, ea: kvGet("deployEaVersion", null), account: kvGet("deployAccount", null), settings: DP.settings(),
    positions: pos.map((x) => Object.assign({}, x, { owner: x.agent === 99999 ? "you" : x.agent ? labName(x.agent) : "agent" })), orders: kvGet("deployOrders", []).map((x) => Object.assign({}, x, { owner: x.agent === 99999 ? "you" : labName(x.agent) })),
    quotes: kvGet("deployQuotes", {}), barsAt: kvGet("deployBarsAt", 0),
    log: kvGet("deployLog", []).slice(-40).reverse().map((x) => Object.assign({}, x, { who: labName(x.agent) })), history: kvGet("deployTrades", []).filter((x) => x.closed).slice(-40).reverse().map((x) => Object.assign({}, x, { who: labName(x.agent) })) };
}
/** Your broker's XAUUSD247 candles (sent by the EA); 8h / 3d / 1w / 1M are built from 1h and 1d. */
function termKlines(sym, iv, lim, before) {
  const SEC = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "8h": 28800, "1d": 86400, "3d": 259200, "1w": 604800, "1M": 2629800 };
  if (!SEC[iv] || !/^[A-Z]+$/.test(sym)) return { candles: [] };
  const src = { "8h": "1h", "3d": "1d", "1w": "1d", "1M": "1d" }[iv] || iv, end = before ? Math.floor(before / 1000) : 2e9;
  const rowsOf = (n) => db.prepare("SELECT t, o, h, l, c, v FROM candles WHERE ticker = ? AND iv = ? AND t < ? ORDER BY t DESC LIMIT ?").all("MT5:" + sym, src, end, n).reverse();
  let bars = rowsOf(src === iv ? lim : lim * (iv === "8h" ? 8 : iv === "3d" ? 3 : iv === "1w" ? 7 : 31));
  if (src !== iv) {
    const key = (t) => { if (iv === "1M") { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; } if (iv === "1w") return Math.floor((t - 345600) / 604800) * 604800 + 345600; return Math.floor(t / SEC[iv]) * SEC[iv]; };
    const out = []; for (const b of bars) { const k = key(b.t), o = out[out.length - 1]; if (o && o.t === k) { o.h = Math.max(o.h, b.h); o.l = Math.min(o.l, b.l); o.c = b.c; o.v += b.v; } else out.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); }
    bars = out.slice(-lim);
  }
  return { candles: bars.map((b) => ({ t: b.t * 1000, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })), src: "ThinkMarkets via MT5" };
}
function teamPasses(g, lm) {
  if (!BL.isTeamPass(lm)) return false;
  const p = ED.proof(liveTrades(g.id).map((r) => r.R)), cap = liveCapital(g.id), bt = g.teamBt;
  // route A: 100+ trades, 75%+ win -> PF 1.5+, 65%+ win at 95% confidence; backtest 70%+ win
  // route B: 150+ trades, 60%+ win -> PF 1.8+, 52%+ win at 95% confidence; backtest 55%+ win (fewer but bigger wins)
  const A = lm.trades >= 100 && lm.winRate >= 0.75, need = A ? { pf: 1.5, sure: 0.65, btWin: 0.7 } : { pf: 1.8, sure: 0.52, btWin: 0.55 };
  return p.profitFactor >= need.pf && cap.roi > 0 && p.sureWinRate >= need.sure && !!bt && bt.trades >= 30 && bt.winRate >= need.btWin && bt.profitFactor >= 1.5;
}
function ghostTrade(g, k, style, best, plan, reason, t) {
  db.prepare("INSERT OR IGNORE INTO ghost_trades(id, agent, ticker, style, side, t, reason, status, data) VALUES(?, ?, ?, ?, ?, ?, ?, 'open', ?)").run(`${g.id}:${k}:${style}:${t}`, g.id, k, style, best.side, t, reason.replace(/\s*\(.*$/, ""), JSON.stringify({ plan, mgmt: g.mgmt, why: reason }));
}
/** What the filters did: per team and reason, the ghost trades' results (negative = the filter saved money). */
function ghostReport(id) { return db.prepare("SELECT reason, COUNT(*) n, ROUND(SUM(R), 2) R, SUM(R > 0.02) wins FROM ghost_trades WHERE agent = ? AND status = 'closed' GROUP BY reason").all(id); }
/** Smart Captain: how each team did per timeframe and market phase (its last 3000 live paper trades). */
function trustMap() {
  const out = {};
  for (const r of db.prepare("SELECT agent, style, R, data FROM lab_trades WHERE status = 'closed' AND shadow = 0 ORDER BY tc DESC LIMIT 3000").all()) {
    if (lab.kinds[r.agent] !== "team") continue; const o = JSON.parse(r.data); if (!o.regime) continue;
    const x = (out[`${r.agent}|${r.style}|${o.regime}`] = out[`${r.agent}|${r.style}|${o.regime}`] || { n: 0, w: 0, R: 0 }); x.n++; x.R += r.R; if (r.R > 0.02) x.w++;
  }
  return out;
}
function labLive() {
  const agents = labAgents(); if (!agents.length) return;
  // settle ghost trades (same simulation as real ones, costs included)
  for (const gt of db.prepare("SELECT * FROM ghost_trades WHERE status = 'open'").all()) {
    const fine = fineFor(gt.style)[gt.ticker]; if (!fine || !fine.length) continue; const d = JSON.parse(gt.data), r = BL.simulate(fine, gt.t, d.plan, d.mgmt || {}, BL.HORIZON[gt.style] || 86400);
    if (!r.open) db.prepare("UPDATE ghost_trades SET status = 'closed', R = ?, tc = ? WHERE id = ?").run(+(r.R - ED.costR(gt.ticker, LN.PIP[gt.ticker], d.plan)).toFixed(3), r.tc, gt.id);
  }
  db.prepare("DELETE FROM ghost_trades WHERE t < ?").run(Math.floor(Date.now() / 1000) - 60 * 86400);
  lab.kinds = Object.fromEntries(agents.map((a) => [a.id, a.kind])); lab.teamPool = Object.fromEntries(agents.filter((a) => a.kind === "team").map((a) => [a.id, a.pool || "rule"]));
  const follow = new Set(kvGet("labFollow", [])), lessons = kvGet("labLessons", {}), now = Math.floor(Date.now() / 1000);
  lab.trust = trustMap(); lab.oppsNew = {};
  let changed = false;
  for (const row of db.prepare("SELECT * FROM lab_trades WHERE status = 'open'").all()) {
    const g = agents.find((a) => a.id === row.agent), o = JSON.parse(row.data), fine = fineFor(row.style)[row.ticker];
    if (!g) { db.prepare("UPDATE lab_trades SET status = 'closed', R = 0, tc = ? WHERE id = ?").run(now, row.id); continue; }
    if (!fine || !fine.length) continue;
    const r = BL.simulate(fine, row.t, o.plan, o.mgmt || g.mgmt, BL.HORIZON[row.style] || 86400);
    const seen = o.seen || 0; o.seen = r.events.length;
    if (follow.has(g.id) && !row.shadow) for (const e of r.events.slice(seen)) if (e.kind === "partial" || e.kind === "added" || e.kind === "breakeven") alertSend(`🤖 ${labName(g.id)} · ${e.kind === "added" ? "➕ added" : e.kind === "breakeven" ? "🛡 SL moved to entry on" : g.mgmt.beAt != null ? `➖ booked ${Math.round(g.mgmt.partialPct * 100)}% profit on` : "➖ took half profit on"} ${row.side.toUpperCase()} ${LN.ticker(row.ticker).name} at ${fmtP(e.px)}${e.kind === "partial" && g.mgmt.breakeven && g.mgmt.beAt == null ? " · SL moved to entry" : ""}`);
    if (r.open) { db.prepare("UPDATE lab_trades SET data = ? WHERE id = ?").run(JSON.stringify(o), row.id); continue; }
    if (o.costR) r.R = +(r.R - o.costR).toFixed(3);                                    // real costs: spread + slippage + commission
    if (g.kind === "team" && o.news && !row.shadow) { g.newsStat = g.newsStat || { n: 0, R: 0 }; g.newsStat.n++; g.newsStat.R = +(g.newsStat.R + r.R).toFixed(2); }
    o.pnl = row.shadow ? 0 : +((o.equity || BL.START) * (r.R * (o.riskPct || 1)) / 100).toFixed(2);
    db.prepare("UPDATE lab_trades SET status = 'closed', R = ?, tc = ?, data = ? WHERE id = ?").run(r.R, r.tc, JSON.stringify(o), row.id);
    if (!row.shadow) { g.cash = +Math.max(0, (g.cash != null ? g.cash : BL.START) + o.pnl).toFixed(2); if (g.cash < 25) g.busted = true; }
    if (follow.has(g.id) && !row.shadow) alertSend(`🤖 ${labName(g.id)} · ${r.R > 0 ? "✅ WIN" : "❌ LOSS"} ${row.side.toUpperCase()} ${LN.ticker(row.ticker).name} · ${r.R > 0 ? "+" : ""}${r.R}R · ${o.pnl >= 0 ? "+" : ""}$${o.pnl} → capital $${g.cash}`);
    // every agent (rule and free): 3 live losses in a row -> learn from them, become more selective, trade in shadow until a win (so never 4 live losses in a row)
    g.state = g.state || { streak: 0, shadow: false };
    if (r.R > 0) { if (row.shadow) g.state.shadow = false; g.state.streak = 0; }
    else if (BL.isLoss(r.R)) {
      (lessons[g.id] = lessons[g.id] || []).push({ f: o.f, tc: r.tc, ticker: row.ticker, side: row.side, style: row.style }); lessons[g.id] = lessons[g.id].slice(-60);
      if (g.kind === "team" && !row.shadow && ++g.state.streak >= STREAK) {
        g.state.shadow = true; g.need = TM.TYPES[g.team].need + 1; g.capUntil = now + 86400;
        kvSet("labLog", kvGet("labLog", []).concat([{ t: now, agent: g.id, text: `${STREAK} losses in a row: the team trades in shadow (normal votes) until it wins one back, then needs ${g.need} votes until 5 more wins; at most ${TEAM_HOLD} trades a day for 24 h; its losing setups went to the shared pool.` }]).slice(-300));
      } else if (g.kind !== "council" && g.kind !== "team" && !row.shadow && ++g.state.streak >= STREAK) {
        g.state.shadow = true; g.bump = Math.min(0.03, (g.bump || 0) + 0.005);
        const xs = labSamples().filter((s) => s.style === g.style && g.tickers.includes(s.ticker)), step = Math.max(1, Math.ceil(xs.length / 12000)), tr = xs.filter((_, i) => i % step === 0).concat(lessons[g.id].filter((x) => x.f && x.f.length === 24).map((x) => ({ f: x.f, y: 0, w: 5 })));
        lab.models[g.id] = BL.fit(g, tr);
        kvSet("labLog", kvGet("labLog", []).concat([{ t: now, agent: g.id, text: `${STREAK} losses in a row: retrained with ${lessons[g.id].length} losing setups as lessons, now takes only its top ${+((1 - Math.min(0.998, g.q + g.bump)) * 100).toFixed(1)}% setups, shadow trading until a win.` }]).slice(-300));
        if (follow.has(g.id)) alertSend(`🧠 ${labName(g.id)} lost ${STREAK} in a row: retrained on its mistakes, became more selective, and pauses live alerts until it wins a shadow trade.`);
      }
    }
    if (g.kind === "team" && BL.isLoss(r.R) && !row.shadow) teamAfterLoss(g, o, now);
    // edge decay alarm: the last 30 trades clearly worse than before -> one more vote needed and an alert
    if (g.kind === "team" && !row.shadow && (!g.decayAt || now - g.decayAt > 3 * 86400) && ED.decayed(liveTrades(g.id).map((x) => x.R))) {
      g.decayAt = now; g.need = TM.TYPES[g.team].need + 1;
      kvSet("labLog", kvGet("labLog", []).concat([{ t: now, agent: g.id, text: "Edge decay: its last 30 trades lost money with a much lower win rate than before. It now needs one more vote; members are re-picked." }]).slice(-300));
      alertSend(`📉 EDGE FADING · ${labName(g.id)}: its last 30 paper trades lost money with a much lower win rate than before. It became stricter and its members are being re-picked.`);
    }
    if (g.kind === "team" && o.regime && !row.shadow && TM.learn(g, o.regime, r.R, now)) kvSet("labLog", kvGet("labLog", []).concat([{ t: now, agent: g.id, text: `${TM.REGIME_NAME[o.regime]} phase cost 3 of the last 5 trades: one more vote needed there for 24 h.` }]).slice(-300));
    if (g.kind === "team" && r.R > 0 && g.state.streak === 0 && g.need > TM.TYPES[g.team].need && (g.wins = (g.wins || 0) + 1) >= 5) { g.need--; g.wins = 0; }
    changed = true;
    if (g.kind === "free" && false) {            // teams only: free agents no longer go to review on their own
      const cap = liveCapital(g.id), ready = kvGet("labFreeReady", {});
      const lm = liveMetrics(g.id);
      // review gate: 100+ live trades, win rate 70%+ (break-evens not counted), never 4 losses in a row, profit
      if (cap.trades >= BL.FREE_TRADES && cap.roi > 0 && lm.winRate >= BL.FREE_WIN && lm.maxLossStreak <= BL.FREE_STREAK && !ready[g.id]) { ready[g.id] = now; kvSet("labFreeReady", ready); passSnapshot(g); alertSend(`💰 FREE AGENT READY FOR REVIEW · ${labName(g.id)}\n${cap.trades} live paper trades · ${Math.round(lm.winRate * 100)}% win (${lm.breakevens} break-even) · $500 → $${cap.equity} (${cap.roi > 0 ? "+" : ""}${Math.round(cap.roi * 100)}%, ${(cap.roiPerDay * 100).toFixed(2)}% a day) · worst drop ${Math.round(cap.maxDDPct * 100)}% · curve ${Math.round(cap.smooth * 100)}% straight\n${BL.describe(g)}\nIt trades on MT5 only after you /approve ${g.id} on @TraderGzeEdgebot.`); try { DP.send(`💰 READY FOR YOUR REVIEW · ${labName(g.id)} (free agent): $500 → $${cap.equity} in ${cap.trades} live paper trades. Review its data, then /approve ${g.id}`); } catch (e) {} }
    }
    if (g.kind === "team") {                    // teams only: only a team can pass Elite Live and go to your review
      const lm = liveMetrics(g.id), eliteLive = kvGet("labEliteLive", {});
      if (teamPasses(g, lm) && !eliteLive[g.id]) { eliteLive[g.id] = now; kvSet("labEliteLive", eliteLive); passSnapshot(g); const cap = liveCapital(g.id); alertSend(`🏆✅ TEAM PASSED THE CHALLENGE · ${labName(g.id)} · grade ${eliteLiveRating(g.id) || "—"}\n${lm.trades} live paper trades, ${Math.round(lm.winRate * 100)}% win, most losses in a row ${lm.maxLossStreak} · $500 → $${cap.equity}\n${TM.describe(g)}\nIt now waits for your review (app → Agents → Review). It trades on MT5 only after you freeze it and /approve ${g.id} on @TraderGzeEdgebot.`); try { DP.onEliteLive(g, lm, eliteLiveRating(g.id)); } catch (e) { log("deployer:", e.message); } }
    }
  }
  // new trades
  const today = Math.floor(now / 86400);
  // the council's voters: the 10 best rule agents of each timeframe (by their unseen-data test)
  const voters = Object.fromEntries(BL.STYLES.map((st) => [st, agents.filter((x) => x.kind === "rule" && x.style === st && lab.models[x.id] && x.bt && x.bt.trades >= 20).sort((x, y) => BL.fitness(y.bt) - BL.fitness(x.bt)).slice(0, 10)]));
  // the Council guards the agents on their way to Elite Live (Elite Edge, not yet Elite Live): their trade is skipped when
  // 2+ of the top agents of that timeframe vote the other way, or when it looks like 3+ recent losing setups of ANY agent
  const eliteE = kvGet("labElite", {}), eliteL = kvGet("labEliteLive", {}), bank = lossBank(agents, lessons);
  const guard = (g, style, k, P, i, side, f) => {
    const other = side === "long" ? "short" : "long", fo = LN.features3(P, i, other, style); let against = 0;
    if (fo) for (const v of voters[style]) { if (v.id === g.id || !v.tickers.includes(k)) continue; const Mv = lab.models[v.id]; if (BL.predict(Mv, BL.sel(v, fo)) >= Mv.cut) against++; }
    if (against >= 2) return `${against} top agents voted ${other}`;
    const n = bank.like(style, f); return n >= 3 ? `looks like ${n} recent losing setups` : null;
  };
  for (const g of agents) {
    const team = g.kind === "team", council = g.kind === "council" || team, M = lab.models[g.id]; if ((!M && !council) || g.busted || inReview(g.id)) continue;
    if (g.kind === "free") continue;                                  // free agents trade only as team members, never on their own
    // teams may hold one trade per market AND timeframe (a scalp team: up to 6 at once); other agents one per market
    const open = db.prepare("SELECT ticker, style FROM lab_trades WHERE agent = ? AND status = 'open'").all(g.id).map((r) => (team ? r.ticker + ":" + r.style : r.ticker));
    let todayN = db.prepare("SELECT COUNT(*) n FROM lab_trades WHERE agent = ? AND t >= ?").get(g.id, today * 86400).n;
    const cap = g.kind === "free" ? g.maxPerDay || 10 : team ? teamCap(g) : council ? 8 : BL.CAP[g.style] || 8;
    for (const style of team ? TM.stylesOf(g, BL.STYLES) : council ? BL.STYLES : [g.style]) for (const k of g.tickers) {
      if (todayN >= cap || open.includes(team ? k + ":" + style : k)) continue;
      const P = barsFor(k, style); if (!P || P.bars.length < 80) continue;
      const bar = LN.LAB_STYLES[style].bar, i = P.bars.length - 1, t = P.bars[i].t + bar;
      if (now - t > Math.max(bar, 600)) continue;                       // the bar is stale
      let best = null;
      if (team) {
        const d = teamCall(g, style, k, P, i, now, null, agents); if (d.side) best = { side: d.side, f: LN.features3(P, i, d.side, style), p: d.voters.length / 5, voters: d.voters, regime: d.regime, via: d.via, lead: d.lead };
      } else if (council) {
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
      if (best && !council && eliteE[g.id] && !eliteL[g.id]) { const why = guard(g, style, k, P, i, best.side, best.f); if (why) { lab.guarded = (lab.guarded || 0) + 1; kvSet("labLog", kvGet("labLog", []).concat([{ t: now, agent: g.id, text: `🏛 Council blocked a ${best.side} on ${k} (${BL.STYLE_NAME[style]}): ${why}.` }]).slice(-300)); continue; } }
      if (!best) continue;
      const pip = LN.PIP[k], c = P.bars[i].c, a = P.a[i];
      let plan, slPips, tpPips;
      const fg = g.kind === "free" ? g : team && g.pool === "free" ? (agents.byId || Object.fromEntries(agents.map((x) => [x.id, x])))[best.lead] : null;   // a Free Team uses its leading member's plan
      if (fg) { plan = BL.freePlan(fg, { side: best.side, c, a }); slPips = Math.round(Math.abs(plan.entry - plan.stop) / pip); tpPips = Math.round(Math.abs(plan.target - plan.entry) / pip); }
      else { const pl = LN.planPips(P, i, best.side, LN.LAB_STYLES[style].rules, k); plan = { side: best.side, entry: pl.entry, stop: pl.stop, target: pl.target }; slPips = pl.slPips; tpPips = pl.tpPips; }
      // the team's filters; a signal they stop becomes a ghost trade (tracked without risk, to learn if the filter helps)
      let riskMult = 1, lib = null;
      if (team) {
        const key = ED.key({ style, ticker: k, side: best.side, phase: best.regime, f: best.f, t }); lib = ED.judge((lab.library || {})[key]);
        const news = DP.newsNear ? DP.newsNear(now * 1000, 30) : null, nw = g.newsStat || { n: 0, R: 0 };
        const why = lib.verdict === "bad" ? `edge library: known losing setup (${lib.n} past trades, ${lib.avgR}R average)`
          : bank.like(style, best.f) >= 3 ? "looks like 3+ recent losing setups"
          : db.prepare("SELECT 1 FROM lab_trades WHERE agent = ? AND status = 'open' AND ticker = ? AND side != ? LIMIT 1").get(g.id, k, best.side) ? "would trade against its own open position (no self-hedging)"
          : news && nw.n >= 5 && nw.R < 0 ? `high-impact news (${news}); this team loses around news`
          // context: a 15m / 1h trade must not go clearly against the bigger trend (range teams fade moves on purpose)
          : (style === "scalp" || style === "h1") && g.team !== "range" && best.f[14] < -0.3 ? "against the bigger trend (context)" : null;
        const ok = `${k}|${style}|${best.side}`, op = (lab.oppsNew[ok] = lab.oppsNew[ok] || { ticker: k, style, side: best.side, phase: best.regime, teams: [], verdict: lib.verdict, score: lib.score, winRate: lib.winRate, n: lib.n || 0, t, taken: false, why: null });
        op.teams.push(g.id); if (why) op.why = why; else op.taken = true;
        if (why) { ghostTrade(g, k, style, best, plan, why, t); continue; }
        if (lib.verdict === "new") riskMult = 0.5;                                    // an unproven setup is tried at half risk
        best.news = !!news;
      }
      const shadow = g.state && g.state.shadow ? 1 : 0, id = `${g.id}:${k}:${style}:${t}`, equity = g.cash != null ? g.cash : BL.START;
      const o = { ticker: k, style, side: best.side, f: best.f, p: best.p, slPips, tpPips, plan, riskPct: +(g.riskPct * riskMult).toFixed(2), equity, costR: team ? ED.costR(k, pip, plan) : 0, lib: lib && lib.verdict, news: best.news, t, kind: g.kind, voters: best.voters, regime: best.regime, via: best.via, lead: best.lead, mgmt: fg && fg !== g ? Object.assign({}, fg.mgmt) : undefined };
      const inserted = db.prepare("INSERT OR IGNORE INTO lab_trades(id, agent, ticker, style, side, t, p, shadow, status, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)").run(id, g.id, k, style, best.side, t, best.p, shadow, JSON.stringify(o)).changes;
      if (!inserted) continue;
      open.push(team ? k + ":" + style : k); todayN++;
      if (follow.has(g.id) && !shadow) alertSend(labMsg(g, o, "") + `\n${council ? `Council vote: ${best.voters.length} of ${voters[style].length} top ${BL.STYLE_NAME[style]} agents agree (${best.voters.map((x) => "Agent " + x).join(", ")})` : `Confidence ${Math.round(best.p * 100)}%`}${g.mgmt.partial ? " · will take half profit halfway" : ""}${g.mgmt.add ? " · may add once on a pullback" : ""}`);
      changed = true;
    }
  }
  // the opportunity board: the strongest setups of this round (bars of the last 2 hours are kept)
  lab.opps = Object.values(lab.oppsNew).concat((lab.opps || []).filter((x) => now - x.t < 7200 && !lab.oppsNew[`${x.ticker}|${x.style}|${x.side}`])).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 30);
  if (changed) { kvSet("labAgents", agents); kvSet("labLessons", lessons); }
}
// ---------------------------------------------------------------- frozen strategies: what you approved is exactly what trades on MT5
// /approve takes a snapshot of the agent's model and settings (for the Council: its voters' models). Only the snapshot sends
// trades to MT5; the agent itself keeps learning in the lab. Approve again to replace the snapshot with the newer version.
const plainModel = (M) => ({ w: M.w.slice(), b: M.b, mu: M.mu.slice(), sd: M.sd.slice(), cut: M.cut });
const plainGenome = (g) => ({ id: g.id, kind: g.kind, style: g.style, tickers: g.tickers.slice(), mask: g.mask.slice(), riskPct: g.riskPct, minLike: g.minLike || 0, preset: g.preset, mgmt: Object.assign({}, g.mgmt) });
/** /approve: deploy the snapshot you froze earlier, or freeze the current version now. */
function approveSnapshot(id) {
  // an archived agent comes back with the same saved strategy (its live log continues)
  const arch = kvGet("labArchive", {}); if (arch[id] && arch[id].snap && !kvGet("labFrozen", {})[id]) { const f = kvGet("labFrozen", {}); f[id] = arch[id].snap; kvSet("labFrozen", f); delete arch[id]; kvSet("labArchive", arch); }
  const r = kvGet("labFrozen", {})[id] ? { ok: true, message: `🧊 Using its saved final version.` } : freezeAgent(id);
  if (!r.ok) return r;
  // live from now on: the paper trading logs go; the overview board keeps the paper performance
  db.prepare("DELETE FROM lab_trades WHERE agent = ?").run(id); kvSet("labFrozenTrades", kvGet("labFrozenTrades", []).filter((x) => x.agent !== id));
  const f = kvGet("labFrozen", {}); if (f[id]) { f[id].approvedAt = Math.floor(Date.now() / 1000); kvSet("labFrozen", f); }
  return r;
}
/** Archive button (only when not live): an agent you no longer use, kept with its saved strategy and live MT5 log. */
function archiveAgent(id) {
  const f = kvGet("labFrozen", {}), snap = f[id]; if (!snap) return { ok: false, message: `Agent ${id} is not frozen.` };
  const arch = kvGet("labArchive", {});
  if (DP.approved().includes(id)) return { ok: false, message: `Agent ${id} is live on MT5: /unapprove ${id} first.` };
  arch[id] = { at: Math.floor(Date.now() / 1000), frozenAt: snap.at, approvedAt: snap.approvedAt || null, kind: snap.kind, overview: snap.overview || {}, snap };
  kvSet("labArchive", arch); delete f[id]; kvSet("labFrozen", f);
  return { ok: true, message: `🗄 ${labName(id)} moved to the archive with its saved strategy and live MT5 log.` };
}
function deleteArchived(id) { const a = kvGet("labArchive", {}); if (!a[id]) return { ok: false, message: "not in the archive" }; delete a[id]; kvSet("labArchive", a); DP.forgetTrades(id); return { ok: true, message: `Archived agent ${id} deleted.` }; }
/** Paper results of each frozen snapshot since it was frozen. */
function frozenStats() {
  const f = kvGet("labFrozen", {}), trades = kvGet("labFrozenTrades", []), appr = new Set(DP.approved());
  return Object.entries(f).map(([id, snap]) => { const xs = trades.filter((x) => x.agent === +id && x.done), m = BL.metrics(xs.map((x) => ({ R: x.R, tc: x.tc }))); return { id: +id, at: snap.at, kind: snap.kind, onMT5: appr.has(+id), open: trades.filter((x) => x.agent === +id && !x.done).length, trades: m.trades, winRate: m.winRate, R: m.totalR, dd: m.maxDD }; });
}
function freezeAgent(id) {
  const agents = labAgents(), g = agents.find((a) => a.id === id);
  if (!g) return { ok: false, message: `Agent ${id} no longer exists in the lab.` };
  if (g.kind === "team") {
    const ps = kvGet("labPassSnap", {})[id], ts = ps && ps.teamSnap ? ps.teamSnap : teamSnapshot(g, agents);
    const snap = { at: Math.floor(Date.now() / 1000), kind: "team", self: ts.self, teamSnap: ts, members: [],
      overview: { name: labName(id), describe: TM.describe(g), style: "all", tickers: g.tickers, live: (() => { const m = liveMetrics(id); delete m.curve; return m; })(), capital: (() => { const c = liveCapital(id); delete c.curve; return c; })(), bt: null, rules: [] } };
    const frozen = kvGet("labFrozen", {}); frozen[id] = snap; kvSet("labFrozen", frozen); kvSet("labAgents", agents.filter((a) => a.id !== id));
    return { ok: true, message: `🧊 Frozen: ${labName(id)} (${TM.TYPES[g.team].name}) with its ${Object.keys(ts.models).length} member models, exactly as it passed. /approve ${id} on @TraderGzeEdgebot sends it to live MT5 trading.` };
  }
  let members;
  if (g.kind === "council") members = agents.filter((x) => x.kind === "rule" && lab.models[x.id] && x.bt && x.bt.trades >= 20).sort((x, y) => BL.fitness(y.bt) - BL.fitness(x.bt)).reduce((acc, x) => ((acc[x.style] = acc[x.style] || []).length < 10 && acc[x.style].push(x), acc), {});
  else if (!lab.models[id]) return { ok: false, message: `Agent ${id} has no trained model yet (wait for the next evolution, ≤ 30 min) and try again.` };
  const ps = kvGet("labPassSnap", {})[id], self = ps ? ps.genome : plainGenome(g);
  const snap = { at: Math.floor(Date.now() / 1000), kind: g.kind, self, members: g.kind === "council" ? Object.values(members).flat().map((x) => ({ genome: plainGenome(x), model: plainModel(lab.models[x.id]) })) : [{ genome: self, model: ps ? ps.model : plainModel(lab.models[id]) }],
    // the overview board keeps its paper performance after the paper logs are gone
    overview: { name: labName(id), describe: BL.describe(g), style: g.style, tickers: g.tickers, live: (() => { const m = liveMetrics(id); delete m.curve; return m; })(), capital: (() => { const c = liveCapital(id); delete c.curve; return c; })(), bt: g.bt ? Object.assign({}, g.bt, { curve: undefined }) : null, rules: g.rules || [] } };
  const frozen = kvGet("labFrozen", {}); frozen[id] = snap; kvSet("labFrozen", frozen);
  kvSet("labAgents", agents.filter((a) => a.id !== id));            // final version: out of the lab, no more evolution or paper trading
  return { ok: true, message: `🧊 Frozen: ${labName(id)}, the exact version that passed${ps ? "" : ` (${new Date(snap.at * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC)`}. It no longer evolves or paper trades. /approve ${id} on @TraderGzeEdgebot sends it to live MT5 trading.` };
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
    tr.done = true; tr.R = +(r.R - ED.costR(tr.ticker, LN.PIP[tr.ticker], tr.plan)).toFixed(3); tr.tc = r.tc;
    // edge decay alarm on MT5: a live team whose last 30 trades clearly got worse is paused for your review
    const mine = trades.filter((x) => x.agent === tr.agent && x.done).map((x) => x.R), dec = kvGet("deployDecay", {});
    if (DP.approved().includes(tr.agent) && ED.decayed(mine) && (!dec[tr.agent] || Date.now() / 1000 - dec[tr.agent] > 7 * 86400)) {
      dec[tr.agent] = Math.floor(Date.now() / 1000); kvSet("deployDecay", dec); kvSet("deployApproved", DP.approved().filter((x) => x !== tr.agent));
      const msg = `📉⏸ EDGE FADING on MT5 · ${labName(tr.agent)} was paused: its last 30 trades lost money with a much lower win rate than before. Its saved strategy is kept; /approve ${tr.agent} to switch it back on.`;
      alertSend(msg); try { DP.send(msg); } catch (e) {}
    }
    if (tr.mt5 && r.events.length && r.events[r.events.length - 1].kind === "time") { try { DP.onClose({ id: tr.agent }, tr.id, "time limit"); } catch (e) { log("deployer:", e.message); } }
  }
  for (const [ids, snap] of Object.entries(frozen)) {
    const id = +ids, live = approved.has(id); if (!live) continue;       // frozen but not approved: waits, no paper trading
    const mine = trades.filter((x) => x.agent === id), open = mine.filter((x) => !x.done).map((x) => x.ticker), cap = snap.kind === "team" ? Infinity : snap.kind === "council" ? 8 : snap.kind === "free" ? snap.self.maxPerDay || 10 : BL.CAP[snap.self.style] || 8;
    let todayN = mine.filter((x) => x.t >= today * 86400).length;
    const styles = snap.kind === "team" ? TM.stylesOf(snap.self, BL.STYLES) : snap.kind === "council" ? BL.STYLES : [snap.self.style];
    for (const style of styles) for (const k of snap.self.tickers) {
      if (todayN >= cap || open.includes(k)) continue;
      const P = barsFor(k, style); if (!P || P.bars.length < 80) continue;
      const bar = LN.LAB_STYLES[style].bar, i = P.bars.length - 1, t = P.bars[i].t + bar;
      if (now - t > Math.max(bar, 600)) continue;
      const id2 = `frozen:${id}:${k}:${style}:${t}`; if (mine.some((x) => x.id === id2)) continue;
      let side = null;
      let lead = null;
      if (snap.kind === "team") { const d = teamCall(snap.self, style, k, P, i, now, snap.teamSnap); side = d.side || null; if (d.side && snap.self.pool === "free") lead = snap.teamSnap.models[d.lead]; }
      else if (snap.kind === "council") {
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
      if (lead) { plan = BL.freePlan(lead.genome, { side, c, a }); slPips = Math.round(Math.abs(plan.entry - plan.stop) / pip); tpPips = Math.round(Math.abs(plan.target - plan.entry) / pip); }
      else if (snap.kind === "free") { plan = BL.freePlan(snap.self, { side, c, a }); slPips = Math.round(Math.abs(plan.entry - plan.stop) / pip); tpPips = Math.round(Math.abs(plan.target - plan.entry) / pip); }
      else { const pl = LN.planPips(P, i, side, LN.LAB_STYLES[style].rules, k); plan = { side, entry: pl.entry, stop: pl.stop, target: pl.target }; slPips = pl.slPips; tpPips = pl.tpPips; }
      const o = { ticker: k, style, side, slPips, tpPips, plan };
      let sent = false;
      if (live) { try { sent = !!DP.onOpen({ id, mgmt: snap.self.mgmt }, o, id2, eliteLiveRating(id)); } catch (e) { log("deployer:", e.message); } }
      trades.push({ id: id2, agent: id, ticker: k, style, side, t, plan, mgmt: lead ? lead.genome.mgmt : snap.self.mgmt, done: false, mt5: sent }); open.push(k); todayN++;
    }
  }
  kvSet("labFrozenTrades", trades.slice(-2000));
}
// ---------------------------------------------------------------- review: agents that passed, for a human to freeze, approve or send back
/** The review board: passed agents waiting for you, frozen final versions (live on MT5 or waiting for /approve), the archive. */
function reviewList() {
  const v = labView(), el = kvGet("labEliteLive", {}), fr = kvGet("labFreeReady", {}), frozen = kvGet("labFrozen", {}), appr = new Set(DP.approved()), notes = kvGet("labNotes", {});
  const review = v.agents.filter((a) => inReview(a.id)).map((a) => ({ id: a.id, name: a.name, kind: a.kind, style: a.style, tickers: a.tickers, describe: a.describe, rating: a.rating,
    passed: el[a.id] ? "Elite Live" : `Free agent: ${BL.FREE_TRADES}+ live trades, ${Math.round(BL.FREE_WIN * 100)}%+ win, never ${BL.FREE_STREAK + 1} losses in a row`, passedAt: el[a.id] || fr[a.id] || null, riskPct: a.riskPct, live: a.live, capital: a.capital, bt: a.bt, btCap: a.btCap, notes: notes[a.id] || [] }));
  const frozenL = Object.entries(frozen).map(([id, f]) => ({ id: +id, kind: f.kind, frozenAt: f.at, approvedAt: f.approvedAt || null, onMT5: appr.has(+id), overview: f.overview || { name: labName(+id) }, plan: DP.plan(+id), tz: DP.settings().tz, live: DP.liveStats(+id), trades: DP.liveTrades(+id).slice(-50).reverse() }));
  const archive = Object.entries(kvGet("labArchive", {})).map(([id, x]) => ({ id: +id, at: x.at, frozenAt: x.frozenAt, approvedAt: x.approvedAt, kind: x.kind, overview: x.overview, live: DP.liveStats(+id), trades: DP.liveTrades(+id).slice(-50).reverse() }));
  return { review, frozen: frozenL, archive };
}
function reviewAction(id, action, comment) {
  if (action === "archive") return archiveAgent(id);
  if (action === "delete") return deleteArchived(id);
  if (action === "plan") return DP.setPlan(id, comment && comment.days ? comment : null);
  const agents = labAgents(), g = agents.find((a) => a.id === id); if (!g) return { ok: false, message: "This agent is not in the lab (already frozen or gone)." };
  if (action === "freeze") return freezeAgent(id);
  if (action === "challenge") {
    const ch = kvGet("labChallenge", {}), el = kvGet("labEliteLive", {}), fr = kvGet("labFreeReady", {}), ps = kvGet("labPassSnap", {}), now = Math.floor(Date.now() / 1000);
    ch[id] = now; delete el[id]; delete fr[id]; delete ps[id]; kvSet("labChallenge", ch); kvSet("labEliteLive", el); kvSet("labFreeReady", fr); kvSet("labPassSnap", ps);
    const text = String(comment || "").trim().slice(0, 500), notes = kvGet("labNotes", {});
    if (text) { (notes[id] = notes[id] || []).push({ t: now, text }); kvSet("labNotes", notes); }
    // back to $500 and a fresh live record; a little more selective so it comes back stronger
    g.cash = BL.START; g.busted = false; g.state = { streak: 0, shadow: false }; g.bump = Math.min(0.03, (g.bump || 0) + 0.005); kvSet("labAgents", agents);
    kvSet("labLog", kvGet("labLog", []).concat([{ t: now, agent: id, text: `New challenge from the human reviewer${text ? `: "${text}"` : ""}. Back to $500, fresh live record, more selective; it must pass again.` }]).slice(-300));
    return { ok: true, message: `Agent ${id} starts a new challenge: $500, fresh live record, back in the lab learning and paper trading.${text ? " Your note is saved on the agent." : ""}` };
  }
  return { ok: false, message: "unknown action" };
}
/** The edge report of a team: what its edge is, where it works, backtest vs live, what its filters did. */
function teamReport(g, ctx) {
  const rows = liveTrades(g.id).map((r) => ({ R: r.R, t: r.t, o: JSON.parse(r.data) }));
  const by = (f, names) => { const m = {}; for (const x of rows) { const k = f(x); if (!k) continue; const y = (m[k] = m[k] || { n: 0, w: 0, R: 0 }); y.n++; y.R += x.R; if (x.R > 0.02) y.w++; } return Object.entries(m).map(([k, y]) => ({ name: (names && names[k]) || k, n: y.n, winRate: y.w / y.n, R: +y.R.toFixed(2) })).sort((a, b) => b.R - a.R); };
  const rules = {}; for (const m of Object.values(g.members || {}).flat()) for (const r of ((ctx.byId[m.id] || {}).rules || [])) rules[r.rule] = (rules[r.rule] || 0) + 1;
  return { live: ED.proof(rows.map((x) => x.R)), bt: g.teamBt || null, phases: by((x) => x.o.regime, TM.REGIME_NAME), sessions: by((x) => ED.session(x.t), ED.SESSION_NAME), markets: by((x) => x.o.ticker), timeframes: by((x) => x.o.style, BL.STYLE_NAME),
    rules: Object.entries(rules).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([r]) => r), ghosts: ghostReport(g.id), news: g.newsStat || null };
}
function labRow(g, ctx) {
  const live = ctx.live[g.id], cap = liveCapital(g.id);
  return { id: g.id, name: labName(g.id), kind: g.kind || "rule", gen: g.gen, parent: g.parent, style: g.style, tickers: g.tickers, riskPct: g.riskPct, describe: BL.describe(g), rules: g.rules || [],
    bt: g.bt ? Object.assign({}, g.bt, { curve: undefined }) : null, curve: g.bt ? g.bt.curve : [], btCap: g.btCap ? Object.assign({}, g.btCap, { curve: undefined }) : null, btCapCurve: g.btCap ? g.btCap.curve : [],
    live: Object.assign({}, live, { curve: undefined }), capital: Object.assign({}, cap, { curve: undefined }), capCurve: cap.curve, shadow: !!(g.state && g.state.shadow), busted: !!g.busted || cap.busted,
    mt5: ctx.mt5.has(g.id), frozen: !!ctx.frozen[g.id], frozenAt: (ctx.frozen[g.id] || {}).at || null, elite: !!ctx.elite[g.id], eliteLive: !!ctx.eliteLive[g.id], rating: ctx.eliteLive[g.id] ? ctx.rateL[g.id] : ctx.elite[g.id] ? ctx.rateE[g.id] : null,
    report: g.kind === "team" ? teamReport(g, ctx) : null,
    team: g.kind === "team" ? { type: g.team, pool: g.pool || "rule", name: TM.TYPES[g.team].name, styles: TM.TYPES[g.team].styles || null, need: g.state && g.state.shadow ? TM.TYPES[g.team].need : Math.min(TM.TYPES[g.team].need + 1, Math.max(TM.TYPES[g.team].need, g.need || 0)), capped: !!(g.capUntil && g.capUntil > Date.now() / 1000), blocked: Object.entries(g.block || {}).filter(([, t]) => t > Date.now() / 1000).map(([r]) => TM.REGIME_NAME[r]),
      members: Object.fromEntries(Object.entries(g.members || {}).map(([st, ms]) => [st, ms.map((m) => ({ id: m.id, name: labName(m.id), role: m.role }))])) } : null,
    status: inReview(g.id) ? "review" : g.kind === "team" ? (ctx.eliteLive[g.id] ? "eliteLive" : "team") : g.kind === "council" ? (ctx.eliteLive[g.id] ? "eliteLive" : "council") : g.kind === "free" ? (cap.busted ? "busted" : "free") : ctx.eliteLive[g.id] ? "eliteLive" : ctx.elite[g.id] ? "elite" : ctx.edges[g.id] ? "edge" : g.bt ? "learning" : "new", following: ctx.follow.has(g.id),
    fitness: g.kind === "council" || g.kind === "team" ? 1000 + (live.trades ? BL.fitness(live, 10) : 0) : g.kind === "free" ? (cap.trades >= 5 ? BL.freeFitness(cap, cap.trades, live) * 2 : 0) + BL.freeFitness(g.btCap, g.bt ? g.bt.trades : 0, g.bt) : (g.bt ? BL.fitness(g.bt) : -9) + (ctx.eliteLive[g.id] ? 100 : ctx.elite[g.id] ? 50 : 0) };
}
function labView() {
  const agents = labAgents(); lab.kinds = Object.fromEntries(agents.map((a) => [a.id, a.kind])); lab.teamPool = Object.fromEntries(agents.filter((a) => a.kind === "team").map((a) => [a.id, a.pool || "rule"]));
  const ctx = { byId: Object.fromEntries(agents.map((a) => [a.id, a])), follow: new Set(kvGet("labFollow", [])), edges: kvGet("labEdges", {}), elite: kvGet("labElite", {}), eliteLive: kvGet("labEliteLive", {}), mt5: new Set(kvGet("deployApproved", [])), frozen: kvGet("labFrozen", {}), live: Object.fromEntries(agents.map((g) => [g.id, liveMetrics(g.id)])) };
  ctx.rateE = BL.rate(agents.filter((g) => ctx.elite[g.id] && g.bt).map((g) => ({ id: g.id, R: g.bt.totalR }))); ctx.rateL = BL.rate(agents.filter((g) => ctx.eliteLive[g.id]).map((g) => ({ id: g.id, R: ctx.live[g.id].totalR })));
  const rows = agents.map((g) => labRow(g, ctx)).sort((a, b) => b.fitness - a.fitness || (b.bt ? b.bt.totalR : 0) - (a.bt ? a.bt.totalR : 0));
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0), R = rows.filter((r) => r.kind !== "free" && r.kind !== "team"), F = rows.filter((r) => r.kind === "free"), TR = rows.filter((r) => r.kind === "team" && r.team.pool !== "free"), TF = rows.filter((r) => r.kind === "team" && r.team.pool === "free");
  const stats = (xs) => ({ n: xs.length, capital: +sum(xs, (x) => x.capital.equity).toFixed(2), start: xs.length * BL.START, trading: xs.filter((x) => x.bt && x.bt.trades > 0).length, liveTrades: sum(xs, (x) => x.capital.trades), busted: xs.filter((x) => x.busted).length,
    styles: Object.fromEntries(BL.STYLES.map((s) => [s, xs.filter((x) => x.style === s).length])), best: xs.slice().sort((a, b) => b.capital.equity - a.capital.equity)[0] || null });
  return { at: lab.at ? Math.floor(lab.at / 1000) : null, gen: kvGet("labGen", 0), size: agents.length, history: kvGet("labHistory", []).slice(-300), trading: agents.filter((a) => a.bt && a.bt.trades > 0).length, goals: BL.GOALS, streak: STREAK, start: BL.START,
    pools: { rule: stats(R), free: stats(F), ruleTeams: stats(TR), freeTeams: stats(TF) }, opps: lab.opps || [], library: lab.libStats || null, challenge: { trades: 100, winRate: 0.75, maxLossStreak: 3, profitFactor: 1.5, sureWinRate: 0.65, bt: { trades: 30, winRate: 0.7, profitFactor: 1.5 } }, agents: rows, shared: { pool: lab.poolSize || {}, hints: (() => { const h = kvGet("labHints", {}); return { rule: (h.rule || []).map((v, j) => ({ name: LN.FEATURES3[j], v })).sort((a, b) => b.v - a.v).slice(0, 6), free: (h.free || []).map((v, j) => ({ name: LN.FEATURES3[j], v })).sort((a, b) => b.v - a.v).slice(0, 6) }; })(), caps: BL.CAP }, log: kvGet("labLog", []).slice(-40).reverse(), running: lab.running };
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
  const MAGIC_BASE = 7700000;                                   // the EA's MagicBase input (magic = MagicBase + agent number; 99999 = your own trades)
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
  /**
   * Per-agent trading plan (your days and up to 3 time windows, in your time zone), on top of the global schedule.
   * plan = { days: [0..6], windows: [{ from: "08:00", to: "11:00" }] }; no plan = the global schedule only.
   */
  const plans = () => kvGet("deployPlans", {});
  D.plan = (id) => plans()[id] || null;
  D.setPlan = (id, p) => {
    const all = plans();
    if (!p) { delete all[id]; kvSet("deployPlans", all); return { ok: true, message: `Agent ${id}: plan removed, it follows the global schedule.` }; }
    const days = [...new Set((p.days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort(), ok = (x) => /^\d{1,2}:\d\d$/.test(x) && toMin(x) <= 1440;
    const windows = (p.windows || []).filter((w) => w && ok(w.from) && ok(w.to) && w.from !== w.to).slice(0, 3).map((w) => ({ from: w.from.padStart(5, "0"), to: w.to.padStart(5, "0") }));
    if (!days.length) return { ok: false, message: "Pick at least one day." };
    if (!windows.length) return { ok: false, message: "Add at least one time window like 08:00-11:00." };
    all[id] = { days, windows, at: Math.floor(Date.now() / 1000) }; kvSet("deployPlans", all);
    return { ok: true, message: `Agent ${id} trades on MT5 only ${planText(all[id])} (${settings().tz}).` };
  };
  const planText = (p) => `${p.days.map((d) => DAY[d]).join(", ")} · ${p.windows.map((w) => w.from + "-" + w.to).join(", ")}`;
  D.planText = planText;
  const inWin = (min, w) => { const a = toMin(w.from), b = toMin(w.to); return a <= b ? min >= a && min < b : min >= a || min < b; };
  D.allowedNow = (at = Date.now(), agentId = null) => {
    const s = settings(); let ln; try { ln = localNow(s.tz, at); } catch (e) { ln = localNow("UTC", at); }
    const p = agentId != null ? plans()[agentId] : null;
    if (p && !p.days.includes(ln.day)) return { ok: false, why: `${DAY[ln.day]} is not in agent ${agentId}'s trading plan` };
    if (p && !p.windows.some((w) => inWin(ln.min, w))) return { ok: false, why: `outside agent ${agentId}'s trading hours ${p.windows.map((w) => w.from + "-" + w.to).join(", ")} ${s.tz}` };
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
  const passed = (id) => !!kvGet("labEliteLive", {})[id] || !!kvGet("labFreeReady", {})[id] || !!kvGet("labFrozen", {})[id] || !!kvGet("labArchive", {})[id];   // passed, frozen by you, or archived (saved strategy)
  D.eligible = (agentId) => passed(agentId) && approved().includes(+agentId);
  /** Called when an agent passes Elite Live: ask for a human review instead of trading. */
  D.onEliteLive = (g, lm, rating) => send(`🏆✅ READY FOR YOUR REVIEW · Agent ${g.id}${rating ? ` (${rating})` : ""}\nPassed Elite Live: ${lm.trades} live paper trades, ${Math.round(lm.winRate * 100)}% win, PF ${isFinite(lm.profitFactor) ? lm.profitFactor.toFixed(2) : "∞"}, ${lm.totalR > 0 ? "+" : ""}${lm.totalR}R, worst drawdown ${lm.maxDD}R.\nIt will NOT trade on MT5 until you approve it.\n1. Download its data: app → Settings → Download data → Elite agents / Elite trades\n2. Review it\n3. If you are happy: /approve ${g.id}`);
  function push(type, id, data) {
    db.prepare("INSERT INTO deploy_signals(id, type, data, t) VALUES(?, ?, ?, ?)").run(id, type, JSON.stringify(data), Math.floor(Date.now() / 1000));
  }
  // ---------------------------------------------------------------- your own trades from the Trade Terminal (EA v1.11)
  // levels are prices as on the terminal chart; ref = the chart price when sent (the EA moves every level by the
  // difference to your broker's price). No schedule / approval: you place them yourself.
  const MANUAL = 99999, num = (v) => (Number.isFinite(+v) ? +v : 0);
  D.MANUAL = MANUAL;
  D.eaVersion = () => kvGet("deployEaVersion", null);
  const kv = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${k}=${v}`).join(";");
  D.manualOrder = (o) => {
    if (!["BTC", "GOLD"].includes(o.ticker)) return { ok: false, message: "Only BTC and XAUUSD247 can be traded from the terminal." };
    if (!["long", "short"].includes(o.side)) return { ok: false, message: "Pick buy or sell." };
    const risk = num(o.risk), sl = num(o.sl), tp = num(o.tp), entry = num(o.entry), ref = num(o.ref), kind = o.kind === "limit" ? "limit" : "market";
    if (!(risk > 0 && risk <= 20)) return { ok: false, message: "Risk must be between 0.1% and 20% of the balance." };
    if (!(sl > 0)) return { ok: false, message: "Set a stop loss (it sets the lot size)." };
    const e = kind === "limit" ? entry : ref, s = o.side === "long" ? 1 : -1;
    if (!(e > 0)) return { ok: false, message: "No entry price." };
    if (s * (e - sl) <= 0) return { ok: false, message: "The stop loss is on the wrong side of the entry." };
    if (tp && s * (tp - e) <= 0) return { ok: false, message: "The take profit is on the wrong side of the entry." };
    const be = Math.max(0, num(o.be)), pr = Math.max(0, num(o.pr)), pp = Math.min(95, Math.max(0, num(o.pp)));
    const id = `manual:${Date.now()}`;
    push("order", id, { agent: MANUAL, ticker: o.ticker, side: o.side, x: kv({ kind, entry: kind === "limit" ? entry : undefined, sl, tp: tp || undefined, ref, risk, be: be || undefined, pr: pp ? pr || undefined : undefined, pp: pr ? pp || undefined : undefined }) });
    return { ok: true, message: `${o.side === "long" ? "BUY" : "SELL"} ${kind === "limit" ? "limit " : ""}sent to MT5 (it answers within a few seconds).` };
  };
  D.manualModify = (o) => { if (!/^\d+$/.test(String(o.ticket))) return { ok: false, message: "bad ticket" }; push("modify", `modify:${Date.now()}`, { agent: MANUAL, x: kv({ ticket: o.ticket, entry: num(o.entry) || undefined, sl: num(o.sl) || undefined, tp: num(o.tp) || undefined, ref: num(o.ref) || undefined }) }); return { ok: true, message: "Change sent to MT5." }; };
  D.manualCancel = (o) => { if (!/^\d+$/.test(String(o.ticket))) return { ok: false, message: "bad ticket" }; push("cancel", `cancel:${Date.now()}`, { agent: MANUAL, x: kv({ ticket: o.ticket }) }); return { ok: true, message: "Cancel sent to MT5." }; };
  D.manualClose = (o) => { if (!/^\d+$/.test(String(o.ticket))) return { ok: false, message: "bad ticket" }; push("closeticket", `closeticket:${Date.now()}`, { agent: MANUAL, x: kv({ ticket: o.ticket }) }); return { ok: true, message: "Close sent to MT5." }; };
  /** An eligible agent opened a live paper trade: send the same trade to MT5. */
  D.onOpen = (g, o, tradeId, rating) => {
    if (!D.eligible(g.id)) return false;
    const s = settings(), pip = LN.PIP[o.ticker], allow = D.allowedNow(Date.now(), g.id);
    // your MT5 account never hedges itself: an opposite trade to one another agent holds on the same market is skipped
    const opp = kvGet("deployTrades", []).find((x) => !x.closed && x.ticker === o.ticker && x.side !== o.side && x.agent !== g.id);
    if (opp && allow.ok) { allow.ok = false; allow.why = `opposite to the open ${opp.side} of ${labName(opp.agent)} on this market`; }
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
    for (const r of rows) { const d = JSON.parse(r.data); lines.push(["SIG", r.seq, r.id, r.type, d.ticker || "", d.side || "", d.slPips || 0, d.tpPips || 0, d.pip || 0, d.partial ? 1 : 0, d.breakeven ? 1 : 0, d.add ? 1 : 0, r.t, d.agent || 0, d.openSeq || 0, d.ref || 0, String(d.x || "").replace(/[|\n]/g, "")].join("|")); }
    text(res, 200, lines.join("\n") + "\n");
  }
  /** Lines from the EA: ACC|login|server|balance|equity|currency|name, POS|ticket|symbol|side|volume|price|sl|tp|profit|comment, RES|seq|ok|ticket|price|volume|message */
  /**
   * Live MT5 trade log per agent, built from what the EA already reports (no EA change): a fill opens a record, every report
   * updates its floating profit, and when the ticket is gone from the open positions it is closed with its last profit.
   */
  function trackLive(pos, results) {
    const T = kvGet("deployTrades", []), now = Math.floor(Date.now() / 1000), open = new Map(pos.map((p) => [String(p.ticket), p]));
    for (const r of results) {
      if (!r.ok || !r.ticket) continue; const sig = db.prepare("SELECT * FROM deploy_signals WHERE seq = ?").get(r.seq); if (!sig || (sig.type !== "open" && sig.type !== "order")) continue;
      const d = JSON.parse(sig.data); if (!T.some((x) => x.ticket === String(r.ticket))) T.push({ ticket: String(r.ticket), agent: d.agent, ticker: d.ticker, side: d.side, t: now, price: r.price, volume: r.volume, profit: 0, closed: false });
    }
    // a pending limit order is not closed: its ticket becomes the position's ticket once it fills
    const pending = new Set(kvGet("deployOrders", []).map((o) => String(o.ticket)));
    for (const x of T) if (!x.closed) { const p = open.get(x.ticket); if (p) { x.profit = p.profit; x.last = now; x.filled = true; } else if (pending.has(x.ticket)) x.pending = true; else if (now - x.t > 30) { x.closed = true; x.tc = now; x.cancelled = !!x.pending && !x.filled; } }
    kvSet("deployTrades", T.slice(-5000));
  }
  D.liveTrades = (id) => kvGet("deployTrades", []).filter((x) => x.agent === +id);
  D.liveStats = (id) => { const xs = D.liveTrades(id), c = xs.filter((x) => x.closed), w = c.filter((x) => x.profit > 0); let run = 0, worst = 0; for (const x of c) { run = x.profit < 0 ? run + 1 : x.profit > 0 ? 0 : run; worst = Math.max(worst, run); }
    return { trades: c.length, open: xs.length - c.length, wins: w.length, winRate: c.length ? w.length / c.length : null, profit: +c.reduce((s, x) => s + x.profit, 0).toFixed(2), floating: +xs.filter((x) => !x.closed).reduce((s, x) => s + x.profit, 0).toFixed(2), maxLossStreak: worst }; };
  D.forgetTrades = (id) => kvSet("deployTrades", kvGet("deployTrades", []).filter((x) => x.agent !== +id));
  function report(res, body) {
    const acc = {}, pos = [], results = [], px = {}, orders = [], quotes = {}; let v111 = false;
    for (const l of String(body).split(/\r?\n/)) {
      const p = l.split("|");
      if (p[0] === "ACC") Object.assign(acc, { login: p[1], server: p[2], balance: +p[3], equity: +p[4], currency: p[5], name: p[6] || "", at: Math.floor(Date.now() / 1000) });
      if (p[0] === "POS") pos.push({ ticket: p[1], symbol: p[2], side: p[3], volume: +p[4], price: +p[5], sl: +p[6], tp: +p[7], profit: +p[8], comment: p[9] || "" });
      if (p[0] === "PX") px[p[1]] = { time: +p[2], magic: +p[3], id: p[4] };
      if (p[0] === "ORD") orders.push({ ticket: p[1], symbol: p[2], type: p[3], volume: +p[4], price: +p[5], sl: +p[6], tp: +p[7], time: +p[8], magic: +p[9] });
      if (p[0] === "QT") quotes[p[1]] = { symbol: p[2], bid: +p[3], ask: +p[4], digits: +p[5], at: Math.floor(Date.now() / 1000) };
      if (p[0] === "RES") results.push({ seq: +p[1], ok: p[2] === "1", ticket: p[3], price: +p[4], volume: +p[5], message: p.slice(6).join("|") });
    }
    if (acc.login) { const prev = kvGet("deployAccount", null); kvSet("deployAccount", acc); if (!prev || prev.login !== acc.login) send(`🔗 MT5 connected: account ${acc.login} on ${acc.server}${acc.name ? ` (${acc.name})` : ""} · balance ${acc.balance} ${acc.currency}`); }
    v111 = Object.keys(quotes).length > 0;
    for (const x of pos) if (px[x.ticket]) Object.assign(x, { time: px[x.ticket].time, magic: px[x.ticket].magic, agent: px[x.ticket].magic - MAGIC_BASE });
    kvSet("deployPositions", pos); kvSet("deployLastPoll", Math.floor(Date.now() / 1000));
    if (v111) { kvSet("deployOrders", orders.map((o) => Object.assign(o, { agent: o.magic - MAGIC_BASE }))); kvSet("deployQuotes", quotes); kvSet("deployEaVersion", "1.11"); }
    trackLive(pos, results);
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
    // v1.11: your broker's XAUUSD247 candles for the Trade Terminal chart (BAR|GOLD|tf|time|o|h|l|c|v)
    if (url.pathname === "/ea/bars" && req.method === "POST") { let b = ""; req.on("data", (c) => { b += c; if (b.length > 2e6) req.destroy(); }); req.on("end", () => { const ins = db.prepare("INSERT OR REPLACE INTO candles(ticker, iv, t, o, h, l, c, v) VALUES(?, ?, ?, ?, ?, ?, ?, ?)"); let n = 0; db.exec("BEGIN"); try { for (const l of b.split(/\r?\n/)) { const p = l.split("|"); if (p[0] !== "BAR" || p.length < 9 || !/^(1m|5m|15m|30m|1h|4h|1d)$/.test(p[2])) continue; ins.run("MT5:" + p[1], p[2], +p[3], +p[4], +p[5], +p[6], +p[7], +p[8]); n++; } db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); } kvSet("deployBarsAt", Math.floor(Date.now() / 1000)); text(res, 200, "OK " + n + "\n"); }); return true; }
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
      if (approved().includes(id)) return send(`Agent ${id} is already live on MT5.`);
      const fr = D.approveSnapshot ? D.approveSnapshot(id) : D.freeze ? D.freeze(id) : { ok: true, message: "" }; if (!fr.ok) return send("Not approved: " + fr.message);
      if (!approved().includes(id)) kvSet("deployApproved", approved().concat([id])); return send(`✅ Agent ${id} approved: its next trades go to MT5 (risk ${settings().risk}% each). /unapprove ${id} to stop.\n${fr.message}`); }
    if (cmd === "/freeze") { const id = parseInt(args[0]); if (!id) return send("Use /freeze <agent number>, e.g. /freeze 567"); const fr = D.freeze ? D.freeze(id) : { ok: false, message: "not available" }; return send(fr.ok ? fr.message : "Not frozen: " + fr.message); }
    if (cmd === "/unfreeze") { const id = parseInt(args[0]); if (approved().includes(id)) return send(`Agent ${id} is live on MT5: /unapprove ${id} first.`); if (D.unfreeze) D.unfreeze(id); return send(`Agent ${id}: frozen version deleted.`); }
    if (cmd === "/frozen") { const f = kvGet("labFrozen", {}), xs = Object.keys(f).map(Number); return send(xs.length ? "🧊 Frozen final versions (live MT5 results):\n" + xs.map((id) => { const L = D.liveStats(id); return `Agent ${id} · frozen ${new Date(f[id].at * 1000).toISOString().slice(0, 10)} · ${approved().includes(id) ? "💹 live on MT5" : "⏳ waiting for /approve " + id} · ${L.trades} closed${L.trades ? `, ${Math.round(L.winRate * 100)}% win, ${L.profit >= 0 ? "+" : ""}${L.profit}` : ""}${L.open ? ` · ${L.open} open (${L.floating >= 0 ? "+" : ""}${L.floating})` : ""}`; }).join("\n") : "Nothing frozen yet. /freeze <agent number>"); }
    if (cmd === "/unapprove") { const id = parseInt(args[0]); kvSet("deployApproved", approved().filter((x) => x !== id)); return send(`⏸ Agent ${id} paused: no new MT5 trades. Open trades keep their SL/TP (/closeall closes everything). Its saved strategy and live log stay; /approve ${id} any time to switch it back on.`); }
    if (cmd === "/approved") return send(approved().length ? "Approved for MT5: " + approved().map((x) => "Agent " + x).join(", ") : "No agent approved yet. /candidates");
    if (cmd === "/candidates") { const el = [...new Set(Object.keys(kvGet("labEliteLive", {})).concat(Object.keys(kvGet("labFreeReady", {}))))].map(Number); return send(el.length ? "Passed Elite Live:\n" + el.map((x) => `Agent ${x} ${approved().includes(x) ? "✅ approved" : "⏳ waiting for your review → /approve " + x}`).join("\n") + "\n\nData: app → Settings → Download data → Elite agents / Elite trades" : "No agent has passed Elite Live yet (it needs 100 live paper trades with 85%+ win, PF 2+, max 6R drawdown, never 3 losses in a row)."); }
    if (cmd === "/timezone") { const tz = args[0]; if (!tz) return send("Use /timezone <zone>, e.g. /timezone Europe/Berlin, /timezone Asia/Kolkata, or an offset like /timezone +2"); try { localNow(tz); } catch (e) { return send(`Unknown time zone "${tz}". Examples: Europe/London, Europe/Berlin, America/New_York, Asia/Dubai, Asia/Kolkata, or +2 / -5`); } setSettings({ tz }); return send(`Time zone set to ${tz}.\n` + scheduleText()); }
    if (cmd === "/days") { const want = (args.join(",").toUpperCase().match(/MON|TUE|WED|THU|FRI|SAT|SUN/g) || []).map((d) => DAY.indexOf(d)); if (!want.length) return send("Use /days MON,TUE,WED,THU,FRI (any of MON TUE WED THU FRI SAT SUN)"); setSettings({ days: [...new Set(want)].sort() }); return send(scheduleText()); }
    if (cmd === "/hours") { const m = String(args[0] || "").match(/^(\d{1,2}(?::\d\d)?)-(\d{1,2}(?::\d\d)?)$/); if (!m) return send("Use /hours 08:00-20:00 (your local time; 22:00-06:00 works overnight; 00:00-24:00 = all day)"); setSettings({ from: m[1].includes(":") ? m[1] : m[1] + ":00", to: m[2].includes(":") ? m[2] : m[2] + ":00" }); return send(scheduleText()); }
    if (cmd === "/news") { const on = args[0] !== "off", min = parseInt(args[1]) || settings().newsMin; setSettings({ newsBlock: on, newsMin: min }); return send(on ? `📰 News block on: no new MT5 trades from ${min} min before to ${min} min after a high-impact event (Forex Factory: USD and the markets you trade).` : "📰 News block off."); }
    if (cmd === "/schedule") return send(scheduleText() + (Object.keys(plans()).length ? "\n\nAgent plans:\n" + Object.entries(plans()).map(([id, p]) => `Agent ${id}: ${planText(p)}`).join("\n") : ""));
    if (cmd === "/plan") {
      const id = parseInt(args[0]); if (!id) return send("Use /plan <agent> MON,TUE,WED 08:00-11:00,14:30-17:00 (your time zone) · /plan <agent> off · /plan <agent> to see it");
      if (!args[1]) { const p = D.plan(id); return send(p ? `Agent ${id}: ${planText(p)} (${settings().tz})` : `Agent ${id} has no plan: it follows the global schedule.`); }
      if (/^off$/i.test(args[1])) return send(D.setPlan(id, null).message);
      const days = (args.slice(1).join(" ").toUpperCase().match(/MON|TUE|WED|THU|FRI|SAT|SUN/g) || []).map((d) => DAY.indexOf(d));
      const windows = (args.slice(1).join(" ").match(/\d{1,2}:\d\d-\d{1,2}:\d\d/g) || []).map((x) => { const [from, to] = x.split("-"); return { from, to }; });
      return send(D.setPlan(id, { days, windows }).message);
    }
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
DP.freeze = freezeAgent; DP.unfreeze = unfreezeAgent; DP.archive = archiveAgent; DP.approveSnapshot = approveSnapshot; DP.frozenStats = frozenStats;
function eliteLiveRating(id) {
  const el = kvGet("labEliteLive", {}); if (!el[id]) return null;
  // graded High / Medium / Low by the money made (live paper capital) among the teams that passed
  return BL.rate(Object.keys(el).map((a) => ({ id: +a, R: liveCapital(+a).equity })))[id] || null;
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
/** Once a week (Monday, at the digest hour): best teams, closest to passing, the edge library, edges that faded. */
function weeklySummary() {
  const week = new Date().toISOString().slice(0, 10);
  if (new Date().getUTCDay() !== 1 || new Date().getUTCHours() !== CFG.digestHourUtc || kvGet("weeklyDay") === week) return;
  kvSet("weeklyDay", week);
  const v = labView(), T = v.agents.filter((a) => a.kind === "team"), since = Date.now() / 1000 - 7 * 86400, lg = kvGet("labLog", []).filter((x) => x.t > since);
  const line = (a) => `${a.name} (${a.team.name}): $${a.capital.equity} · ${a.live.trades} trades${a.live.trades ? ` · ${Math.round(a.live.winRate * 100)}% win · ${a.live.totalR}R` : ""}`;
  const close = T.filter((a) => a.status !== "eliteLive").sort((x, y) => (y.live.winRate || 0) - (x.live.winRate || 0)).slice(0, 3);
  const L = v.library;
  alertSend(`📅 Weekly team summary\n\n🏆 Best teams:\n${T.slice().sort((a, b) => b.capital.equity - a.capital.equity).slice(0, 3).map(line).join("\n")}\n\n🎯 Closest to the challenge:\n${close.map((a) => line(a) + (a.live.trades < 100 ? ` · ${100 - a.live.trades} trades to go` : "")).join("\n")}\n\n📚 Edge library: ${L ? `${L.setups} setups known, ${L.good} with a proven edge, ${L.bad} known losers (from ${L.bt} backtest, ${L.human} human and ${L.paper} paper trades)` : "building"}\n📉 Edges that faded this week: ${lg.filter((x) => /Edge decay/.test(x.text)).map((x) => "Team " + x.agent).join(", ") || "none"}\n🔁 Members swapped after losses: ${lg.filter((x) => /swapped/.test(x.text)).length}`);
}
async function dailyDigest() {
  try { weeklySummary(); } catch (e) { log("weekly:", e.message); }
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
  // ---------------------------------------------------------------- Trade Terminal (the chart + your own MT5 trades)
  if (p === "/terminal") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(terminalHtml()); }
  if (p === "/api/term/state") return json(res, 200, termState());
  if (p === "/api/term/klines") return json(res, 200, termKlines(q("sym", "GOLD"), q("iv", "15m"), Math.min(1500, +q("lim", 1000)), +q("before", 0)));
  if (p.startsWith("/api/term/") && req.method === "POST") {
    let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e4) req.destroy(); });
    req.on("end", () => { try { const o = JSON.parse(b || "{}"), act = p.slice(10), fn = { order: DP.manualOrder, modify: DP.manualModify, cancel: DP.manualCancel, close: DP.manualClose }[act];
      if (!fn) return json(res, 404, { error: "unknown action" }); if (DP.eaVersion() !== "1.11") return json(res, 200, { ok: false, message: "Update the EA to v1.11 in MT5 first (deploy/TraderGzeDeployer.mq5)." });
      json(res, 200, fn(o)); } catch (e) { json(res, 400, { error: e.message }); } }); return;
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
  if (p === "/api/lab/review" && req.method === "GET") return json(res, 200, { board: reviewList(), schedule: DP.scheduleText ? DP.scheduleText() : "" });
  if (p === "/api/lab/review" && req.method === "POST") { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { const { id, action, comment } = JSON.parse(b || "{}"); json(res, 200, reviewAction(+id, action, comment)); } catch (e) { json(res, 400, { error: e.message }); } }); return; }
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
  setTimeout(() => every(10 * 60e3, refreshLab, "agent evolution"), 4 * 60e3);         // the teams' agents evolve every 10 minutes
  setTimeout(() => every(5 * 60e3, refreshWallets, "wallets"), 15000);
  setTimeout(() => every(30 * 60e3, refreshResearch, "research feeds"), 25000);
  openFollowStream();
  try { buildBoards(); } catch (e) { log("boards:", e.message); }
  setInterval(() => pollFollows().catch(() => {}), 120e3);
  setInterval(netflowCheck, 10 * 60e3);
  setInterval(dailyDigest, 5 * 60e3);
  setInterval(() => { const cut = Math.floor(Date.now() / 1000) - CFG.keepDays * 86400; db.prepare("DELETE FROM events WHERE time < ?").run(cut); db.prepare("DELETE FROM anomalies WHERE time < ?").run(cut); db.prepare("DELETE FROM candles WHERE iv = '1m' AND t < ?").run(Math.floor(Date.now() / 1000) - 7 * 86400); }, 6 * 3600e3);
  telegramLoop();
  DP.loop(); setInterval(DP.watch, 120e3);
  http.createServer(serve).listen(CFG.port, CFG.host, () => log(`TraderGze Intel server on http://${CFG.host}:${CFG.port}`));
  if (CFG.telegramChat) tgSend("🐻 TraderGze Intel server started. /status for details.");
}
if (require.main === module) start();
module.exports = { teamPasses, teamAfterLoss, passSnapshot, reviewList, reviewAction, lab, frozenStats, approveSnapshot, freezeAgent, frozenLive, DP, refreshLab, labLive, labView, labAgentView, buildBoards, refreshLearner, learn, orderAlert, handleFills, pollFollows, refreshResearch, refreshWallets, setWallet, flowBars, research, serve, addEvents, learnFromBtc, netflowCheck, db, CFG, onTelegram, cache, refreshDesk, refreshTraders, follow, kvGet };
