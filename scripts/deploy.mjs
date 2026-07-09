#!/usr/bin/env node
/**
 * Deploy an environment: build the SPA, regenerate the account-local wrangler
 * config from .forma/<env>.json (created by `npm run setup`), and deploy.
 *
 *   npm run deploy:demo
 *   npm run deploy:prod
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const API_DIR = path.join(ROOT, "apps", "api");

const envName = process.argv[2] ?? "demo";
const statePath = path.join(ROOT, ".forma", `${envName}.json`);
if (!fs.existsSync(statePath)) {
  console.error(`\n✖ No .forma/${envName}.json — run \`npm run setup${envName === "production" ? " -- production" : ""}\` first.\n`);
  process.exit(1);
}
const configPath = path.join(API_DIR, `.wrangler.${envName}.jsonc`);
if (!fs.existsSync(configPath)) {
  console.error(`\n✖ Missing ${configPath} — re-run setup to regenerate it.\n`);
  process.exit(1);
}

console.log(`\n▶ Building web app`);
execSync("npm run build -w apps/web", { cwd: ROOT, stdio: "inherit" });

console.log(`\n▶ Deploying ${envName}`);
execFileSync("npx", ["wrangler", "deploy", "--config", configPath], {
  cwd: API_DIR,
  stdio: "inherit",
});

const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
console.log(
  `\n✔ Deployed. ${state.domain ? `https://${state.domain}` : "See the workers.dev URL above."}\n`,
);
