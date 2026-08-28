/**
 * storage.js — closed-tab resume for the THORChain hop (Step 3.1).
 *
 * docs/BRIEF.md (Workstream A — Panel 2): "If the user closes the tab
 * mid-poll, the hop resumes on return: persist `{inboundTxid, stage}` in
 * `window.storage` keyed by txid. No server state."
 *
 * Implementation note: there is no standard `window.storage` browser API —
 * the brief uses it as the name for "client-side persistence". This module
 * uses the SAME adapter pattern as Teleporter.jsx (localStorage when
 * available, in-memory fallback otherwise) so it runs in a real browser, in
 * a sandboxed artifact, and under node --test.
 *
 * Entries are keyed by inboundTxid:
 *   `teleporter.thorchain.hop.{inboundTxid}` → {
 *     inboundTxid, stage, payload: { inboundTxid, sourceChain, destination,
 *     expectedAmountOut }, updatedAt
 *   }
 *
 * PURE MODULE (DI storage backend): no DOM, no wallet, no fetch.
 */

export const HOP_KEY_PREFIX = "teleporter.thorchain.hop.";

/** The in-memory fallback backend (shared across instances — mirrors the
 *  memStore pattern in Teleporter.jsx). */
const memStore = new Map();

/** Default backend: localStorage when available, in-memory fallback. */
function defaultBackend() {
  return {
    get(key) {
      try {
        if (typeof localStorage !== "undefined") {
          const v = localStorage.getItem(key);
          return v ? JSON.parse(v) : null;
        }
      } catch {
        /* fall through to memory */
      }
      return memStore.has(key) ? memStore.get(key) : null;
    },
    set(key, val) {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(key, JSON.stringify(val));
          return;
        }
      } catch {
        /* fall through to memory */
      }
      memStore.set(key, val);
    },
    del(key) {
      try {
        if (typeof localStorage !== "undefined") {
          localStorage.removeItem(key);
          return;
        }
      } catch {
        /* fall through to memory */
      }
      memStore.delete(key);
    },
  };
}

/** Create the THORChain hop storage handle. `backend` is injectable for
 *  tests ({ get, set, del }); defaults to localStorage + memory fallback. */
export function createThorchainStorage(backend) {
  const b = backend ?? defaultBackend();
  const keyFor = (inboundTxid) => `${HOP_KEY_PREFIX}${inboundTxid}`;

  return {
    /**
     * Persist (or update) a hop entry. `stage` is one of the THORChain
     * stages (observed/swapping/outbound_signed/done). `payload` is the
     * hook payload { inboundTxid, sourceChain, destination, expectedAmountOut }.
     */
    saveHop({ inboundTxid, stage, payload }) {
      if (!inboundTxid) throw new Error("saveHop: inboundTxid is required");
      const existing = this.loadHop(inboundTxid) || {};
      const entry = {
        inboundTxid,
        stage: stage ?? existing.stage ?? "observed",
        payload: payload ?? existing.payload ?? null,
        updatedAt: Date.now(),
      };
      b.set(keyFor(inboundTxid), entry);
      return entry;
    },

    /** Load a hop entry, or null. Malformed entries are dropped (and removed). */
    loadHop(inboundTxid) {
      if (!inboundTxid) return null;
      const raw = b.get(keyFor(inboundTxid));
      if (!raw || typeof raw !== "object") return null;
      if (typeof raw.inboundTxid !== "string" || raw.inboundTxid !== inboundTxid) {
        b.del(keyFor(inboundTxid));
        return null;
      }
      const stage = raw.stage ?? "observed";
      return {
        inboundTxid: raw.inboundTxid,
        stage,
        payload: raw.payload ?? null,
        updatedAt: raw.updatedAt ?? 0,
      };
    },

    /** All pending (non-done) hop entries, newest first. Used on mount to
     *  resume an interrupted hop. */
    listHops() {
      const out = [];
      for (const [key, val] of Object.entries(b.getAll?.() ?? {})) {
        if (!key.startsWith(HOP_KEY_PREFIX)) continue;
        const txid = key.slice(HOP_KEY_PREFIX.length);
        const entry = this.loadHop(txid);
        if (entry && entry.stage !== "done") out.push(entry);
      }
      // Newest first — the most recently-updated pending hop is the one the
      // user is most likely to be mid-journey on.
      return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    },

    /** Remove a hop entry (called when the journey completes or is dismissed). */
    removeHop(inboundTxid) {
      if (!inboundTxid) return;
      b.del(keyFor(inboundTxid));
    },
  };
}
