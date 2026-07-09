#!/usr/bin/env node
/**
 * Self-service provisioning: creates every Cloudflare resource an environment
 * needs on YOUR account, applies D1 migrations, and pushes secrets. Run once
 * per environment:
 *
 *   npm run setup            # provisions the "demo" environment
 *   npm run setup -- production
 *
 * Prerequisites: `npx wrangler login` (or CLOUDFLARE_API_TOKEN), and
 * ANTHROPIC_API_KEY in .env.
 *
 * Everything account-specific lands in .forma/<env>.json (gitignored), so the
 * repo itself stays account-agnostic.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const API_DIR = path.join(ROOT, "apps", "api");
const STATE_DIR = path.join(ROOT, ".forma");

const envName = process.argv[2] ?? "demo";
if (!["demo", "production"].includes(envName)) {
  fail(`Unknown environment "${envName}" — use "demo" or "production".`);
}
const suffix = envName === "production" ? "" : "-demo";
const names = {
  worker: `forma${suffix}`,
  d1: `forma-db${suffix}`,
  vectorize: `forma-chunks${suffix}`,
  r2: `forma-pdfs${suffix}`,
  kv: `forma-rl${suffix}`,
};

const dotenv = loadDotenv(path.join(ROOT, ".env"));
const statePath = path.join(STATE_DIR, `${envName}.json`);
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {};

console.log(`\n▶ Provisioning Forma "${envName}" environment (${names.worker})\n`);

// --- 0. auth check -----------------------------------------------------------
try {
  wrangler(["whoami"]);
} catch {
  fail("wrangler is not authenticated. Run `npx wrangler login` first (or set CLOUDFLARE_API_TOKEN).");
}

// --- 1. D1 -------------------------------------------------------------------
if (!state.d1Id) {
  console.log(`• creating D1 database ${names.d1}`);
  const out = wrangler(["d1", "create", names.d1]).toString();
  const m = out.match(/"database_id":\s*"([0-9a-f-]+)"/) ?? out.match(/database_id\s*=\s*"([0-9a-f-]+)"/);
  if (!m) {
    // Already exists? Look it up.
    const list = JSON.parse(wrangler(["d1", "list", "--json"]).toString());
    const found = list.find((d) => d.name === names.d1);
    if (!found) fail(`could not determine database_id for ${names.d1}:\n${out}`);
    state.d1Id = found.uuid;
  } else {
    state.d1Id = m[1];
  }
  saveState();
} else {
  console.log(`• D1 ${names.d1} already provisioned (${state.d1Id})`);
}

// --- 2. Vectorize (bge-m3 = 1024 dims, cosine) + metadata indexes -------------
if (!state.vectorize) {
  console.log(`• creating Vectorize index ${names.vectorize} (1024-dim, cosine)`);
  tryWrangler(["vectorize", "create", names.vectorize, "--dimensions=1024", "--metric=cosine"], /already exists/i);
  for (const prop of ["document_id", "state", "license_type"]) {
    tryWrangler(
      ["vectorize", "create-metadata-index", names.vectorize, `--property-name=${prop}`, "--type=string"],
      /already exists/i,
    );
  }
  state.vectorize = names.vectorize;
  saveState();
} else {
  console.log(`• Vectorize ${names.vectorize} already provisioned`);
}

// --- 3. R2 -------------------------------------------------------------------
if (!state.r2) {
  console.log(`• creating R2 bucket ${names.r2}`);
  tryWrangler(["r2", "bucket", "create", names.r2], /already (exists|owned)/i);
  state.r2 = names.r2;
  saveState();
} else {
  console.log(`• R2 ${names.r2} already provisioned`);
}

// --- 4. KV -------------------------------------------------------------------
if (!state.kvId) {
  console.log(`• creating KV namespace ${names.kv}`);
  const out = wrangler(["kv", "namespace", "create", names.kv]).toString();
  const m = out.match(/id\s*[:=]\s*"([0-9a-f]{32})"/) ?? out.match(/"id":\s*"([0-9a-f]{32})"/);
  if (!m) fail(`could not parse KV namespace id:\n${out}`);
  state.kvId = m[1];
  saveState();
} else {
  console.log(`• KV ${names.kv} already provisioned (${state.kvId})`);
}

// --- 5. generate deploy config + apply migrations ------------------------------
state.names = names;
state.domain = dotenv[envName === "production" ? "DEPLOY_DOMAIN_PROD" : "DEPLOY_DOMAIN_DEMO"] ?? state.domain ?? null;
saveState();
const configPath = writeDeployConfig(envName, state);

console.log("• applying D1 migrations (remote)");
wrangler(["d1", "migrations", "apply", names.d1, "--remote", "--config", configPath], { stdio: "inherit" });

// --- 6. secrets ----------------------------------------------------------------
if (!dotenv.ANTHROPIC_API_KEY) {
  fail("ANTHROPIC_API_KEY missing from .env — copy .env.example to .env and fill it in.");
}
if (!state.ingestToken) {
  state.ingestToken = randomBytes(32).toString("hex");
  saveState();
}
console.log("• pushing secrets (ANTHROPIC_API_KEY, INGEST_TOKEN)");
putSecret("ANTHROPIC_API_KEY", dotenv.ANTHROPIC_API_KEY, configPath);
putSecret("INGEST_TOKEN", state.ingestToken, configPath);
if (envName === "production") {
  const code = dotenv.ACCESS_CODE ?? state.accessCode;
  if (code) {
    state.accessCode = code;
    saveState();
    putSecret("ACCESS_CODE", code, configPath);
    console.log("• ACCESS_CODE gate enabled for production");
  } else {
    console.log("• no ACCESS_CODE in .env — production will be open (rate-limited only)");
  }
}

console.log(`\n✔ ${envName} provisioned. Next: npm run deploy:${envName === "production" ? "prod" : "demo"}\n`);

// --- helpers -------------------------------------------------------------------
function wrangler(args, opts = {}) {
  return execFileSync("npx", ["wrangler", ...args], { cwd: API_DIR, stdio: opts.stdio ?? "pipe" });
}
function tryWrangler(args, okPattern) {
  try {
    wrangler(args);
  } catch (e) {
    const msg = String(e.stdout ?? "") + String(e.stderr ?? "") + String(e.message ?? "");
    if (!okPattern.test(msg)) throw e;
  }
}
function putSecret(name, value, configPath) {
  execFileSync("npx", ["wrangler", "secret", "put", name, "--config", configPath], {
    cwd: API_DIR,
    input: value,
  });
}
function loadDotenv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
function saveState() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}
function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

/**
 * Generates apps/api/.wrangler.<env>.jsonc from the committed dev config +
 * this account's resource IDs + optional custom domain. Gitignored.
 */
function writeDeployConfig(envName, state) {
  const config = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: state.names.worker,
    main: "src/index.ts",
    compatibility_date: "2026-06-01",
    assets: {
      directory: "../web/dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*"],
    },
    ai: { binding: "AI" },
    d1_databases: [
      {
        binding: "DB",
        database_name: state.names.d1,
        database_id: state.d1Id,
        migrations_dir: "migrations",
      },
    ],
    vectorize: [{ binding: "VECTORS", index_name: state.names.vectorize }],
    r2_buckets: [{ binding: "PDFS", bucket_name: state.names.r2 }],
    kv_namespaces: [{ binding: "RL", id: state.kvId }],
    vars: { ENVIRONMENT: envName },
    observability: { enabled: true },
    ...(state.domain
      ? { routes: [{ pattern: state.domain, custom_domain: true }] }
      : { workers_dev: true }),
  };
  const file = path.join(API_DIR, `.wrangler.${envName}.jsonc`);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  return file;
}
