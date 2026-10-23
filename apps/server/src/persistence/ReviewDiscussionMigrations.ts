import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ReviewDiscussions from "./ReviewDiscussionMigrations/001_ReviewDiscussions.ts";

const table = "review_discussion_migrations";
const run = Migrator.make({});

const assertFeatureHistory = Effect.fn("assertReviewDiscussionMigrationHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
  if (tables.length === 0) return false;
  const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM review_discussion_migrations
  `;
  if (history.length === 0) return false;
  const required = history.filter((row) => row.migration_id === 1);
  if (required.length !== 1 || required[0]?.name !== "ReviewDiscussions") {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: "Review discussion migration history would skip required 1_ReviewDiscussions.",
    });
  }
  return true;
});

// Adoption accepts only the original 67 schema; table existence alone cannot prove
// that running its DDL is unnecessary. Keep this independent of future migrations.
const legacyColumns = {
  review_discussions: [
    ["thread_id", "TEXT", 1, null, 1, 0],
    ["id", "TEXT", 1, null, 2, 0],
    ["anchor_json", "TEXT", 1, null, 0, 0],
    ["original_message_id", "TEXT", 1, null, 0, 0],
    ["resolved", "INTEGER", 1, "0", 0, 0],
    ["hidden", "INTEGER", 1, "0", 0, 0],
    ["created_at", "TEXT", 1, null, 0, 0],
    ["updated_at", "TEXT", 1, null, 0, 0],
  ],
  review_discussion_messages: [
    ["thread_id", "TEXT", 1, null, 1, 0],
    ["id", "TEXT", 1, null, 2, 0],
    ["discussion_id", "TEXT", 1, null, 0, 0],
    ["author", "TEXT", 1, null, 0, 0],
    ["text", "TEXT", 1, null, 0, 0],
    ["created_at", "TEXT", 1, null, 0, 0],
    ["delivery", "TEXT", 1, null, 0, 0],
    ["delivery_error", "TEXT", 0, null, 0, 0],
    ["prompt", "TEXT", 1, null, 0, 0],
    ["command_id", "TEXT", 1, null, 0, 0],
    ["native_message_id", "TEXT", 1, null, 0, 0],
  ],
};

const assertLegacySchema = Effect.fn("assertLegacyReviewDiscussionSchema")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [name, expectedColumns] of Object.entries(legacyColumns)) {
    const columns = yield* sql`
      SELECT name, type, "notnull", dflt_value, pk, hidden
      FROM pragma_table_xinfo(${name}) ORDER BY cid
    `.values;
    const foreignKeys = yield* sql`
      SELECT id, seq, "table", "from", "to", on_update, on_delete, match
      FROM pragma_foreign_key_list(${name}) ORDER BY id, seq
    `.values;
    const expectedForeignKeys =
      name === "review_discussions"
        ? []
        : [
            [
              0,
              0,
              "review_discussions",
              "thread_id",
              "thread_id",
              "NO ACTION",
              "NO ACTION",
              "NONE",
            ],
            [0, 1, "review_discussions", "discussion_id", "id", "NO ACTION", "NO ACTION", "NONE"],
          ];
    const indexes = yield* sql`
      SELECT name, "unique", origin, partial FROM pragma_index_list(${name}) ORDER BY name
    `.values;
    const primaryIndex = `sqlite_autoindex_${name}_1`;
    const expectedIndexes =
      name === "review_discussions"
        ? [[primaryIndex, 1, "pk", 0]]
        : [
            ["review_discussion_messages_discussion", 0, "c", 0],
            [primaryIndex, 1, "pk", 0],
          ];
    const primaryColumns = yield* sql`
      SELECT name, desc, coll FROM pragma_index_xinfo(${primaryIndex}) WHERE key = 1 ORDER BY seqno
    `.values;
    if (
      !NodeUtil.isDeepStrictEqual(columns, expectedColumns) ||
      !NodeUtil.isDeepStrictEqual(foreignKeys, expectedForeignKeys) ||
      !NodeUtil.isDeepStrictEqual(indexes, expectedIndexes) ||
      !NodeUtil.isDeepStrictEqual(primaryColumns, [
        ["thread_id", 0, "BINARY"],
        ["id", 0, "BINARY"],
      ])
    ) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `Cannot adopt legacy review discussion schema: unexpected ${name} definition.`,
      });
    }
  }
  const indexColumns = yield* sql`
    SELECT name, desc, coll FROM pragma_index_xinfo('review_discussion_messages_discussion')
    WHERE key = 1 ORDER BY seqno
  `.values;
  if (
    !NodeUtil.isDeepStrictEqual(indexColumns, [
      ["thread_id", 0, "BINARY"],
      ["discussion_id", 0, "BINARY"],
    ])
  ) {
    return yield* new Migrator.MigrationError({
      kind: "BadState",
      message: "Cannot adopt legacy review discussion schema: unexpected discussion index columns.",
    });
  }
});

// Called inside runMigrations' transaction, before its core history guard.
export const reconcileReviewDiscussionMigration = Effect.fn("reconcileReviewDiscussionMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const adopted = yield* assertFeatureHistory();
    const tables = yield* sql`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
    `;
    if (tables.length === 0) return;
    const legacy = yield* sql`
      SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 67 AND name = 'ReviewDiscussions'
    `;
    if (legacy.length === 0) return;
    yield* assertLegacySchema();
    if (!adopted) {
      yield* run({ table, loader: Migrator.fromRecord({}) });
      yield* sql`INSERT INTO review_discussion_migrations (migration_id, name, created_at)
        SELECT 1, name, created_at FROM effect_sql_migrations
        WHERE migration_id = 67 AND name = 'ReviewDiscussions'`;
    }
    if (!(yield* assertFeatureHistory())) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: "Legacy transfer did not establish required 1_ReviewDiscussions.",
      });
    }
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 67 AND name = 'ReviewDiscussions'`;
  },
);

export const runReviewDiscussionMigrations = Effect.fn("runReviewDiscussionMigrations")(
  function* () {
    yield* run({
      table,
      loader: Migrator.fromRecord({ "1_ReviewDiscussions": ReviewDiscussions }),
    });
  },
);
