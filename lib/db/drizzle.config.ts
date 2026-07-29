import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // drizzle-kit treats `schema` as a glob pattern, and glob syntax uses "\" as
  // an escape character — so a Windows path from path.join() never matches and
  // fails with "No schema files found". Normalise separators to "/", which is
  // valid on every platform.
  schema: path.join(__dirname, "./src/schema/index.ts").replace(/\\/g, "/"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
