import "dotenv/config";
import { loadConfig } from "../src/config.js";
import { Store } from "../src/db.js";

/**
 * Applies the schema to whichever database DB_PATH / TURSO_DATABASE_URL points
 * at. Run once after provisioning, and again after any schema change:
 *
 *   npm run migrate
 *
 * The webhook deliberately skips migrations so it does not pay ~30 network
 * round trips on every cold start.
 */

const config = loadConfig({ requireTelegram: false });
const target = process.env.TURSO_DATABASE_URL?.trim() || config.dbPath;
console.log(`Migrating ${target}`);

const store = new Store(config.dbPath);
const started = Date.now();
await store.init({ migrate: true });
store.close();

console.log(`Schema up to date in ${Date.now() - started}ms`);
