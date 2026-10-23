import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE review_discussions (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      anchor_json TEXT NOT NULL,
      original_message_id TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, id)
    )
  `;
  yield* sql`
    CREATE TABLE review_discussion_messages (
      thread_id TEXT NOT NULL,
      id TEXT NOT NULL,
      discussion_id TEXT NOT NULL,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivery TEXT NOT NULL,
      delivery_error TEXT,
      prompt TEXT NOT NULL,
      command_id TEXT NOT NULL,
      native_message_id TEXT NOT NULL,
      PRIMARY KEY (thread_id, id),
      FOREIGN KEY (thread_id, discussion_id) REFERENCES review_discussions(thread_id, id)
    )
  `;
  yield* sql`CREATE INDEX review_discussion_messages_discussion
    ON review_discussion_messages(thread_id, discussion_id)`;
});
