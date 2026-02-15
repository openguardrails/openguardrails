export type Dialect = "sqlite" | "mysql" | "postgresql";

export function getDialect(): Dialect {
  const explicit = process.env.DB_DIALECT;
  if (explicit === "sqlite" || explicit === "mysql" || explicit === "postgresql") {
    return explicit;
  }

  const url = process.env.DATABASE_URL || "";
  if (url.startsWith("mysql://") || url.startsWith("mysql2://")) return "mysql";
  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) return "postgresql";
  return "sqlite";
}
