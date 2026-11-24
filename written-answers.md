# Written answers

## 1. Column Migration & Rollback

Why it fails: During a rolling deployment, old and new versions run at the same time. If you drop `display_name` too early, old instances crash because the column is missing. If you switch reads/writes to `full_name` before creating it, new instances crash. You also lose data and can't safely roll back once `display_name` is dropped.

Safe sequence:

1. Add `full_name` as nullable in the database.
2. Deploy code that writes to both `display_name` and `full_name`, while still reading from `display_name`.
3. Backfill existing `display_name` values into `full_name` in small batches.
4. Deploy code that reads from `full_name` (falling back to `display_name` if null) while keeping dual-writes on.
5. Once confident and no rollback is needed, stop writing to `display_name`.
6. In a later release, drop `display_name`.

## 2. Stale Cache After Revocation

Why a 5-second TTL doesn't fix it: It doesn't remove the race condition—it just shrinks the window where bad data is served. Even for 5 seconds, a revoked certificate could still look `ACTIVE` to callers, which is a security bug.

How to fix it:

* Version check (best): Give each certificate a monotonically increasing `version` number. When B revokes it, bump the version in the DB and write a `REVOKED` entry (or tombstone) with that new version to the cache. When A tries to write back to the cache, only let the write succeed if A's version is newer than what's already in the cache.
* Locking alternative: Use a per-certificate lock around cache updates/deletes so A's read-and-populate and B's revoke-and-invalidate can't interleave out of order.

## 3. Cascading Failure & Recovery

Chain of failure: Normally, 1,000 req/s at 20 ms takes about 20 workers. When B slows to 2 seconds, requests hit the 100 ms timeout and retry up to 3 times—turning 1,000 req/s into up to 4,000 calls against B and holding each request open longer. All 50 workers on A get tied up waiting on `/report`, starving every other endpoint on A.

How to fix `/report`:

* Isolate resources: Cap how many workers `/report` (or calls to B) can use at once so other endpoints still have free workers.
* Add a circuit breaker: If B times out or errors too often, trip the circuit breaker and fail fast without calling B until it recovers.
* Cut back retries: Drop aggressive retries when B is struggling (or use a tight retry budget) so you don't flood a slow service.

What `/report` should return when B is unhealthy: Return a fast degraded response—like a cached report if you have one (ideally marked stale), or a quick `503 Service Unavailable` with a `Retry-After` header (or `202 Accepted` if queued for async processing).
