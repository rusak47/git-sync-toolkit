import { access } from "node:fs/promises";

const list = (name, fallback = []) => {
  try { return process.env[name] ? JSON.parse(process.env[name]) : fallback; }
  catch { throw new Error(`${name} must contain a JSON array`); }
};
const defaultValidation = [["node", ["--test", new URL("./test/*.js", import.meta.url).pathname]]];

export const config = {
  upstreamRemote: process.env.SYNC_UPSTREAM_REMOTE || "upstream",
  originRemote: process.env.SYNC_ORIGIN_REMOTE || "origin",
  baseBranch: process.env.SYNC_BASE_BRANCH || "master",
  ledger: new URL("./ledger.json", import.meta.url),
  patchDir: new URL("../../patches/merged/", import.meta.url),
  stateDir: new URL("../../fork-sync-state/", import.meta.url),
  appliedState: new URL("../../fork-sync-state/applied.json", import.meta.url),
  cleanupProgress: new URL("../../fork-sync-state/cleanup-progress.json", import.meta.url),
  validationCommands: list("SYNC_VALIDATION_COMMANDS", defaultValidation),
  forkOwned: list("SYNC_FORK_OWNED", []),
  hotFiles: list("SYNC_HOT_FILES", []),
};

try {
  await access(new URL("./config.local.js", import.meta.url));
  const local = await import("./config.local.js");
  Object.assign(config, local.config || local.default || {});
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
