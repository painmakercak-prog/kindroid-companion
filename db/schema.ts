import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
export const profiles = sqliteTable("profiles", {
  userId: text("user_id").primaryKey(), config: text("config").notNull(),
  memory: text("memory").notNull().default(""), updatedAt: integer("updated_at").notNull(),
});
export const turns = sqliteTable("turns", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), userText: text("user_text").notNull(),
  assistantText: text("assistant_text").notNull().default(""), status: text("status").notNull().default("generating"),
  createdAt: integer("created_at").notNull(),
}, (t) => [index("idx_turns_user_created").on(t.userId, t.createdAt)]);
export const rateLimits = sqliteTable("rate_limits", {
  id: text("id").primaryKey(), count: integer("count").notNull(), expiresAt: integer("expires_at").notNull(),
});
