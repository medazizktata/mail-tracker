// In-memory stand-in for the KV binding, shared by the unit tests and the e2e tests.
/**
 * Minimal in-memory stand-in for the KV binding, including list() metadata.
 * `ops` counts calls by kind: the free plan meters reads and lists on wildly
 * different budgets (100,000/day vs 1,000/day), so which one a code path spends
 * is worth asserting on, not just whether it works.
 */
export function fakeKV() {
  const store = new Map();
  const ops = { get: 0, put: 0, delete: 0, list: 0 };
  return {
    store,
    ops,
    async get(name, type) {
      ops.get++;
      const hit = store.get(name);
      if (!hit) return null;
      return type === 'json' ? JSON.parse(hit.value) : hit.value;
    },
    async put(name, value, opts = {}) {
      ops.put++;
      store.set(name, { value, metadata: opts.metadata ?? null, ttl: opts.expirationTtl ?? null });
    },
    async delete(name) {
      ops.delete++;
      store.delete(name);
    },
    async list({ prefix = '', limit = 1000 } = {}) {
      ops.list++;
      const keys = [...store.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .slice(0, limit)
        .map(([name, entry]) => ({ name, metadata: entry.metadata ?? undefined }));
      return { keys, list_complete: true, cursor: null };
    },
  };
}
