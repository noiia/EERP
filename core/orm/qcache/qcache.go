// Package qcache is the ORM's optional Redis read cache for the generic CRUD
// read path (docs/adr/ADR-022-optional-redis-query-cache.md).
//
// Correctness comes from generation counters, not from knowing which cached
// entries a write touches: every entry's key embeds the current generation of
// its table and of the whole database, and every committed write INCRs its
// table's generation (or the database-wide one when the target can't be
// determined). A bumped generation makes every older entry unreachable; TTL
// then garbage-collects it. Writers never scan or delete keys.
//
// A nil *Cache is valid and disables everything — every method is a no-op —
// so the rest of the ORM calls it unconditionally. Redis errors fail open:
// reads fall through to Postgres, never error a request.
package qcache

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// allTables is the generation bumped for writes whose target table is unknown
// (DDL, CTE writes, TRUNCATE, ...) — it invalidates every entry of a database.
const allTables = "*"

// Cache is a Redis-backed query-result cache. The zero value is not usable;
// build one with New. A nil *Cache is a disabled cache.
type Cache struct {
	rdb *redis.Client
	ttl time.Duration
	// OnError, when set, is told about Redis failures (the cache itself only
	// ever fails open). Set it before first use.
	OnError func(error)
}

// New connects to redisURL (redis://[:password@]host:port/db) and pings it.
// ttl bounds how long an entry lives even if no write ever invalidates it
// (writes the ORM can't see — e.g. a psql session — are only caught by TTL);
// <= 0 defaults to 60s. Timeouts are deliberately short: the cache sits on
// the request path and a slow Redis must never be slower than Postgres.
func New(ctx context.Context, redisURL string, ttl time.Duration) (*Cache, error) {
	opts, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	opts.DialTimeout = 300 * time.Millisecond
	opts.ReadTimeout = 200 * time.Millisecond
	opts.WriteTimeout = 200 * time.Millisecond
	opts.MaxRetries = 0
	rdb := redis.NewClient(opts)
	pingCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := rdb.Ping(pingCtx).Err(); err != nil {
		_ = rdb.Close()
		return nil, err
	}
	if ttl <= 0 {
		ttl = 60 * time.Second
	}
	return &Cache{rdb: rdb, ttl: ttl}, nil
}

// Close releases the Redis connection pool.
func (c *Cache) Close() error {
	if c == nil {
		return nil
	}
	return c.rdb.Close()
}

// Lookup tries the entry for (database, table, sql, args) and decodes it into
// dst on a hit. It always returns the key a later Store must use: the key is
// derived from the generations read HERE, before the caller queries Postgres,
// so a write that commits in between bumps past it and the stored entry is
// born unreachable instead of stale. key == "" means "don't Store".
//
// Numbers decode as json.Number, so re-encoding a hit yields the same JSON the
// uncached value would (no float64 precision loss on numeric columns).
func (c *Cache) Lookup(ctx context.Context, database, table, sql string, args []any, dst any) (key string, hit bool) {
	if c == nil {
		return "", false
	}
	argsJSON, err := json.Marshal(args)
	if err != nil {
		return "", false // unhashable args: just don't cache this query
	}
	gens, err := c.rdb.MGet(ctx, genKey(database, table), genKey(database, allTables)).Result()
	if err != nil {
		c.fail(err)
		return "", false
	}
	sum := sha256.Sum256(append([]byte(sql+"\x00"), argsJSON...))
	key = "eerp:" + database + ":q:" + table + ":" + genOf(gens[0]) + ":" + genOf(gens[1]) + ":" + hex.EncodeToString(sum[:])

	raw, err := c.rdb.Get(ctx, key).Bytes()
	if err != nil {
		if !errors.Is(err, redis.Nil) {
			c.fail(err)
			return "", false
		}
		return key, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	if err := dec.Decode(dst); err != nil {
		return key, false // corrupt/old-shape entry: overwrite it
	}
	return key, true
}

// Store saves v under a key returned by Lookup.
func (c *Cache) Store(ctx context.Context, key string, v any) {
	if c == nil || key == "" {
		return
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return
	}
	if err := c.rdb.Set(ctx, key, raw, c.ttl).Err(); err != nil {
		c.fail(err)
	}
}

// Invalidate bumps the generation of each table in database (tables empty =
// the whole database). Call it only AFTER the write is committed — bumping
// earlier lets a concurrent reader re-cache the pre-write rows under the new
// generation.
func (c *Cache) Invalidate(ctx context.Context, database string, tables ...string) {
	if c == nil {
		return
	}
	if len(tables) == 0 {
		tables = []string{allTables}
	}
	// A cancelled request context must not skip the bump, or the entry stays
	// stale until TTL.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), time.Second)
	defer cancel()
	pipe := c.rdb.Pipeline()
	for _, t := range tables {
		pipe.Incr(ctx, genKey(database, t))
	}
	if _, err := pipe.Exec(ctx); err != nil {
		c.fail(err)
	}
}

func (c *Cache) fail(err error) {
	if c.OnError != nil {
		c.OnError(err)
	}
}

func genKey(database, table string) string {
	return "eerp:" + database + ":gen:" + table
}

func genOf(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return "0"
}

// WriteTarget classifies a SQL statement for invalidation: write is false for
// a plain read (SELECT/SHOW/EXPLAIN/transaction control); otherwise table is
// the written table, or "" when the target can't be determined and the whole
// database must be invalidated. Conservative by design — anything it doesn't
// recognise counts as a database-wide write.
//
// Known gap: a SELECT calling a function that writes (SELECT my_fn()) is seen
// as a read; the ORM never issues one, and TTL bounds the staleness if a
// module ever does.
func WriteTarget(sql string) (table string, write bool) {
	f := strings.Fields(strings.ToLower(sql))
	if len(f) == 0 {
		return "", false
	}
	switch f[0] {
	case "select", "show", "explain", "begin", "commit", "rollback",
		"savepoint", "release", "set", "reset", "listen", "unlisten", "notify":
		return "", false
	case "insert", "delete":
		// INSERT INTO t / DELETE FROM t
		if len(f) > 2 {
			return tableName(f[2]), true
		}
	case "update":
		if len(f) > 1 {
			t := f[1]
			if t == "only" && len(f) > 2 {
				t = f[2]
			}
			return tableName(t), true
		}
	case "with":
		for _, w := range f {
			if w == "insert" || w == "update" || w == "delete" || strings.HasPrefix(w, "(insert") ||
				strings.HasPrefix(w, "(update") || strings.HasPrefix(w, "(delete") {
				return "", true
			}
		}
		return "", false
	}
	return "", true
}

// tableName strips quoting, a schema prefix and anything glued after the
// identifier ("t(", "t,") from a raw token.
func tableName(tok string) string {
	if i := strings.IndexAny(tok, "(,;"); i >= 0 {
		tok = tok[:i]
	}
	if i := strings.LastIndexByte(tok, '.'); i >= 0 {
		tok = tok[i+1:]
	}
	return strings.Trim(tok, `"`)
}
