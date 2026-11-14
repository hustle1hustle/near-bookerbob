// Where the economy's public events come from: the transactions of the watched contracts.
// Discovery uses FastNear's public tx indexer (it lists every tx that touched an account); the
// bytes of each event come from the transaction's receipts, from that indexer or from NEAR's
// public archival RPC (`EXPERIMENTAL_tx_status`). docs/anchor-format.md.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const INDEXER = process.env.FASTNEAR_TX || "https://tx.test.fastnear.com";
export const ARCHIVAL = process.env.NEAR_ARCHIVAL_RPC || "https://archival-rpc.testnet.fastnear.com";
export const RPC = process.env.NEAR_RPC || "https://rpc.testnet.fastnear.com";

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

async function post(url, body, tries = 12) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.status === 429 || r.status >= 500) throw new Error(`${url} ${r.status}`);
      // Block timestamps are u64 nanoseconds, past 2^53: keep their digits exact (as strings).
      const text = (await r.text()).replace(/"(block_timestamp|timestamp|timestamp_nanosec|tx_block_timestamp)":(\d{16,})/g, '"$1":"$2"');
      return JSON.parse(text);
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(Math.min(30000, 3000 * (i + 1)));
    }
  }
}

// Every tx hash that touched `account`, oldest first.
export async function accountTxs(account, indexer = INDEXER) {
  const out = new Map();
  let resume = null;
  for (;;) {
    const j = await post(`${indexer}/v0/account`, { account_id: account, ...(resume ? { resume_token: resume } : {}) });
    for (const t of j.account_txs || []) out.set(t.transaction_hash, t);
    if (!j.resume_token || !(j.account_txs || []).length) break;
    resume = j.resume_token;
  }
  return [...out.values()].sort((a, b) => a.tx_block_height - b.tx_block_height || a.tx_index - b.tx_index);
}

// Full transactions (receipts with logs) from the indexer, 20 per request.
export async function fetchTxs(hashes, cachePath) {
  const cache = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const todo = hashes.filter((h) => !cache[h]);
  for (let i = 0; i < todo.length; i += 20) {
    const j = await post(`${INDEXER}/v0/transactions`, { tx_hashes: todo.slice(i, i + 20) });
    for (const t of j.transactions || []) if (t) cache[t.transaction.hash] = slim(t);
    if (cachePath && i % 200 === 0) save(cachePath, cache);
    await sleep(Number(process.env.INDEXER_GAP_MS ?? 600));
  }
  if (cachePath) save(cachePath, cache);
  return cache;
}

function save(p, o) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(o));
}

// Keep what the format reads: per receipt, its id, executor, block, success and logs.
function slim(t) {
  const rs = [t.execution_outcome, ...(t.receipts || []).map((r) => r.execution_outcome)].filter(Boolean);
  return {
    hash: t.transaction.hash,
    signer: t.transaction.signer_id,
    receiver: t.transaction.receiver_id,
    receipts: rs.map((o) => ({
      id: o.id,
      executor: o.outcome.executor_id,
      height: o.block_height,
      ts: String(o.block_timestamp),
      ok: !("Failure" in (o.outcome.status || {})),
      logs: o.outcome.logs,
    })),
  };
}

// The same transaction from NEAR's public archival RPC, in the slim shape: the trust path of
// `make anchor-check --rpc` (the indexer is only a finder).
export async function rpcTx(hash, signer) {
  const j = await post(ARCHIVAL, { jsonrpc: "2.0", id: 1, method: "EXPERIMENTAL_tx_status", params: { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" } });
  if (!j.result) throw new Error(`rpc tx ${hash}: ${JSON.stringify(j.error).slice(0, 200)}`);
  const r = j.result;
  const heights = new Map();
  const blocks = [r.transaction_outcome, ...r.receipts_outcome];
  // The RPC gives block hashes, not heights: resolve each once.
  for (const o of blocks) if (!heights.has(o.block_hash)) heights.set(o.block_hash, await blockOf(o.block_hash));
  return {
    hash,
    signer,
    receiver: r.transaction.receiver_id,
    receipts: blocks.map((o) => ({
      id: o.id,
      executor: o.outcome.executor_id,
      height: heights.get(o.block_hash).height,
      ts: heights.get(o.block_hash).ts,
      ok: !("Failure" in (o.outcome.status || {})),
      logs: o.outcome.logs,
    })),
  };
}

const blockCache = new Map();
async function blockOf(hash) {
  if (blockCache.has(hash)) return blockCache.get(hash);
  await sleep(Number(process.env.TX_GAP_MS ?? 1500));
  const j = await post(ARCHIVAL, { jsonrpc: "2.0", id: 1, method: "block", params: { block_id: hash } });
  if (!j.result) throw new Error(`rpc block ${hash}: ${JSON.stringify(j.error).slice(0, 200)}`);
  const v = { height: j.result.header.height, ts: String(j.result.header.timestamp_nanosec) };
  blockCache.set(hash, v);
  return v;
}

// A view at the final block, or at `blockId` (a height) from the archival RPC: the state right
// after that block.
export async function view(account, method, args = {}, rpc = RPC, blockId = null) {
  const at = blockId == null ? { finality: "final" } : { block_id: blockId };
  const j = await post(blockId == null ? rpc : ARCHIVAL, {
    jsonrpc: "2.0",
    id: 1,
    method: "query",
    params: { request_type: "call_function", ...at, account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
  });
  if (!j.result) throw new Error(`view ${account}.${method}: ${JSON.stringify(j.error || j).slice(0, 200)}`);
  return JSON.parse(Buffer.from(j.result.result).toString());
}
