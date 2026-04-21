# Adapters

Pluggable memory backend reference implementations for bias/correction hooks.

**Status: Reference only — implementations exist but are NOT yet wired into the hooks.** The core hooks currently perform inline jsonl writes. These adapters show the interface contract for future refactoring. See roadmap in main `README.md`.

## Implementations

### `simple-jsonl.js` (default reference)

Appends records to local `.jsonl` files under `$AI_AUDIT_DIR` (default `~/.ai-audit/`). This mirrors what the core hooks do inline. Behavior for reference:

```js
const adapter = require('./adapters/simple-jsonl');
adapter.appendBias(record, 'queue');       // writes to bias-queue.jsonl
adapter.appendCorrection(record, 'log');   // writes to corrections.jsonl
adapter.appendSkip(record, 'bias');         // writes to bias-skipped.jsonl
const pending = adapter.loadQueue('bias'); // returns array of queued records
adapter.promoteToLog(record, 'bias');      // moves queue → main log after review
```

### `shared-memory.js` (advanced example)

Writes to a multi-AI shared memory structure with:
- Domain-based organization (`domains/<category>/`)
- Hierarchical index files (`_index.md`, auto-created)
- Journal-style daily logs

This is an author-specific pattern for running multiple AI tools against a shared persistent memory. Not required for using sycophancy-hooks.

## Interface (sync, not async)

```js
module.exports = {
  appendBias(record, type = 'queue') { /* type: 'queue' | 'log' */ },
  appendCorrection(record, type = 'queue') { /* same */ },
  appendSkip(record, kind) { /* kind: 'bias' | 'correction' */ },
  loadQueue(kind) { /* returns array */ },
  promoteToLog(record, kind) { /* moves queue → log */ }
};
```

All operations are synchronous. Cross-platform: macOS, Linux, and Windows all supported (locking uses a `.lock` sentinel file via `O_EXCL`, not POSIX `fcntl`).

## Contributing a new adapter

Implement the interface above, add a file under `adapters/`, and update this README. Examples of useful backends: Redis, SQLite, Postgres, S3, Notion API. See main `README.md` → Contributing.
