import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

// Freeze the shipped 67 schema independently of future feature migrations.
const legacyDdl = [
  `CREATE TABLE review_discussions (
    thread_id TEXT NOT NULL, id TEXT NOT NULL, anchor_json TEXT NOT NULL,
    original_message_id TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, id)
  )`,
  `CREATE TABLE review_discussion_messages (
    thread_id TEXT NOT NULL, id TEXT NOT NULL, discussion_id TEXT NOT NULL,
    author TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL,
    delivery TEXT NOT NULL, delivery_error TEXT, prompt TEXT NOT NULL,
    command_id TEXT NOT NULL, native_message_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, id),
    FOREIGN KEY (thread_id, discussion_id) REFERENCES review_discussions(thread_id, id)
  )`,
  `CREATE INDEX review_discussion_messages_discussion
    ON review_discussion_messages(thread_id, discussion_id)`,
];

const seedLegacy = Effect.fn("test.seedLegacy")(function* (ddl = legacyDdl) {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 66 });
  for (const statement of ddl) yield* sql.unsafe(statement);
  yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
    VALUES (67, 'ReviewDiscussions', '2026-10-22 12:00:00')`;
});

const seedMessages = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const thread of ["thread-a", "thread-b"]) {
    yield* sql`INSERT INTO review_discussions VALUES
      (${thread}, 'discussion', '{}', 'message', 1, 0, 'created', 'updated')`;
    yield* sql`INSERT INTO review_discussion_messages VALUES
      (${thread}, 'message', 'discussion', 'user', 'keep this', 'created',
       'failed', 'retry later', 'prompt', 'command', 'native')`;
  }
});

const discussionData = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return [
    yield* sql`SELECT * FROM review_discussions ORDER BY thread_id, id`,
    yield* sql`SELECT * FROM review_discussion_messages ORDER BY thread_id, id`,
  ];
});

const schemaAndHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schema = yield* sql<{ readonly name: string }>`
    SELECT name, type, sql FROM sqlite_master ORDER BY name
  `;
  return {
    schema,
    core: yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
    feature: schema.some((row) => row.name === "review_discussion_migrations")
      ? yield* sql`SELECT * FROM review_discussion_migrations ORDER BY migration_id`
      : [],
  };
});

const featureHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT migration_id, name FROM review_discussion_migrations ORDER BY migration_id`;
});

const createFeatureHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE review_discussion_migrations (
    migration_id INTEGER PRIMARY KEY NOT NULL,
    created_at DATETIME NOT NULL DEFAULT current_timestamp,
    name VARCHAR(255) NOT NULL
  )`;
});

const memory = NodeSqliteClient.layer({ filename: ":memory:" });
const expectedFeatureHistory = [{ migration_id: 1, name: "ReviewDiscussions" }];

describe("review discussion migrations", () => {
  it.effect("migrates fresh databases without claiming a core migration number", () =>
    Effect.gen(function* () {
      assert.notInclude(
        migrationManifest.map(([, name]) => name),
        "ReviewDiscussions",
      );
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      assert.deepStrictEqual(yield* featureHistory, expectedFeatureHistory);
      yield* seedMessages;
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each([54, 66, 67, 100])("keeps explicit migration limit %s core-only", (limit) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: limit });
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name LIKE 'review_discussion%'`,
        [],
      );
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each([undefined, "WebhookDedupe"])(
    "upgrades through 66 with later history %s intact",
    (later) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 66 });
        if (later)
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (67, ${later})`;
        const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          before,
        );
        assert.deepStrictEqual(yield* featureHistory, expectedFeatureHistory);
        yield* seedMessages;
      }).pipe(Effect.provide(memory)),
  );

  it.effect("adopts populated legacy tables, survives reopen, and releases 67 for upstream", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discussion-migration-" });
      const filename = `${directory}/state.sqlite`;
      const before = yield* Effect.gen(function* () {
        yield* seedLegacy();
        yield* seedMessages;
        const data = yield* discussionData;
        const state = yield* schemaAndHistory;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* discussionData, data);
        assert.deepStrictEqual(yield* featureHistory, expectedFeatureHistory);
        const after = yield* schemaAndHistory;
        assert.deepStrictEqual(
          after.schema.filter((row) => row.name !== "review_discussion_migrations"),
          state.schema,
        );
        const sql = yield* SqlClient.SqlClient;
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          state.core.slice(0, -1),
        );
        assert.deepStrictEqual(yield* sql`SELECT created_at FROM review_discussion_migrations`, [
          { created_at: "2026-10-22 12:00:00" },
        ]);
        return data;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const state = yield* schemaAndHistory;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* schemaAndHistory, state);
        assert.deepStrictEqual(yield* discussionData, before);
        // Use the same real migrator and core ledger a future upstream entry will use.
        assert.deepStrictEqual(
          yield* Migrator.make({})({
            loader: Migrator.fromRecord({
              "67_FutureUpstream": sql`CREATE TABLE future_upstream (id INTEGER)`.pipe(
                Effect.asVoid,
              ),
            }),
          }),
          [[67, "FutureUpstream"]],
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* discussionData, before);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    ["column", "anchor_json TEXT NOT NULL", "anchor TEXT NOT NULL"],
    ["type", "anchor_json TEXT NOT NULL", "anchor_json BLOB NOT NULL"],
    ["nullability", "anchor_json TEXT NOT NULL", "anchor_json TEXT"],
    ["default", "DEFAULT 0", "DEFAULT 1"],
    ["primary key", "PRIMARY KEY (thread_id, id)", "PRIMARY KEY (id, thread_id)"],
    [
      "foreign key",
      "REFERENCES review_discussions(thread_id, id)",
      "REFERENCES review_discussions(id, thread_id)",
    ],
    [
      "index",
      "ON review_discussion_messages(thread_id, discussion_id)",
      "ON review_discussion_messages(discussion_id, thread_id)",
    ],
    [
      "partial index",
      "ON review_discussion_messages(thread_id, discussion_id)",
      "ON review_discussion_messages(thread_id, discussion_id) WHERE delivery = 'failed'",
    ],
  ] as const)(
    "rejects malformed legacy %s without changing history or schema",
    ([_label, from, to]) =>
      Effect.gen(function* () {
        yield* seedLegacy(legacyDdl.map((ddl) => ddl.replace(from, to)));
        const before = yield* schemaAndHistory;
        const result = yield* Effect.exit(runMigrations());
        assert.isTrue(Exit.isFailure(result));
        assert.include(String(result), "legacy review discussion schema");
        assert.deepStrictEqual(yield* schemaAndHistory, before);
      }).pipe(Effect.provide(memory)),
  );

  it.effect.each([
    [false, "missing"],
    [false, "wrong-name"],
    [true, "missing"],
    [true, "wrong-name"],
  ] as const)("rejects conflicting feature history (legacy=%s, identity=%s)", ([legacy, kind]) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (legacy) yield* seedLegacy();
      else yield* runMigrations({ toMigrationInclusive: 66 });
      yield* createFeatureHistory;
      yield* sql`INSERT INTO review_discussion_migrations (migration_id, name) VALUES
        (${kind === "missing" ? 2 : 1}, 'OtherMigration')`;
      const before = yield* schemaAndHistory;
      const result = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(result));
      assert.include(String(result), "1_ReviewDiscussions");
      assert.deepStrictEqual(yield* schemaAndHistory, before);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each(["review_discussion_messages", "review_discussion_messages_discussion"])(
    "rejects legacy history missing %s",
    (name) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacy();
        yield* sql.unsafe(
          name === "review_discussion_messages"
            ? "DROP TABLE review_discussion_messages"
            : "DROP INDEX review_discussion_messages_discussion",
        );
        const before = yield* schemaAndHistory;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(yield* schemaAndHistory, before);
      }).pipe(Effect.provide(memory)),
  );

  it.effect("preserves an existing valid feature ledger during legacy adoption", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacy();
      yield* seedMessages;
      yield* createFeatureHistory;
      yield* sql`INSERT INTO review_discussion_migrations (migration_id, name) VALUES
        (1, 'ReviewDiscussions'), (2, 'FutureFeatureMigration')`;
      const before = yield* schemaAndHistory;
      const data = yield* discussionData;
      assert.deepStrictEqual(yield* runMigrations(), []);
      const after = yield* schemaAndHistory;
      assert.deepStrictEqual(after.feature, before.feature);
      assert.deepStrictEqual(after.core, before.core.slice(0, -1));
      assert.deepStrictEqual(yield* discussionData, data);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("rolls adoption back when pending core migration execution fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacy();
      yield* seedMessages;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 66`;
      yield* sql`DROP TABLE orchestration_events`;
      const before = yield* schemaAndHistory;
      const data = yield* discussionData;
      const result = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(result));
      assert.include(String(result), "66_RepairClientSettlementTimestamps");
      assert.deepStrictEqual(yield* schemaAndHistory, before);
      assert.deepStrictEqual(yield* discussionData, data);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("rolls adoption back when core history is invalid", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacy();
      yield* seedMessages;
      yield* sql`UPDATE effect_sql_migrations SET name = 'WrongMigration' WHERE migration_id = 65`;
      const before = yield* schemaAndHistory;
      const data = yield* discussionData;
      const result = yield* Effect.exit(runMigrations());
      assert.isTrue(Exit.isFailure(result));
      assert.include(String(result), "65_CodexUsageNativeTurnIndex");
      assert.deepStrictEqual(yield* schemaAndHistory, before);
      assert.deepStrictEqual(yield* discussionData, data);
    }).pipe(Effect.provide(memory)),
  );

  it.effect.each(["transfer", "deletion"])("rolls back an injected %s failure", (stage) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedLegacy();
      yield* seedMessages;
      yield* createFeatureHistory;
      yield* sql.unsafe(
        stage === "transfer"
          ? `CREATE TRIGGER fail_transfer BEFORE INSERT ON review_discussion_migrations
           BEGIN SELECT RAISE(ABORT, 'injected transfer failure'); END`
          : `CREATE TRIGGER fail_deletion BEFORE DELETE ON effect_sql_migrations
           WHEN OLD.migration_id = 67 BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END`,
      );
      const before = yield* schemaAndHistory;
      const data = yield* discussionData;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* schemaAndHistory, before);
      assert.deepStrictEqual(yield* discussionData, data);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("rolls back core execution when feature DDL fails", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      yield* sql`CREATE TABLE review_discussions (unrecognized TEXT)`;
      const before = yield* schemaAndHistory;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* schemaAndHistory, before);
    }).pipe(Effect.provide(memory)),
  );
});
