export const config = {
  upstreamRemote: "upstream",
  originRemote: "origin",
  baseBranch: "master",
  ledger: new URL("./ledger.json", import.meta.url),
  patchDir: new URL("../../patches/merged/", import.meta.url),
  stateDir: new URL("../../fork-sync-state/", import.meta.url),
  appliedState: new URL("../../fork-sync-state/applied.json", import.meta.url),
  validationCommands: [["node", ["--test", ".docs/scripts/upstream/test/*.js"]]],
  forkOwned: [".docs/**", "open-sse/utils/**", "src/lib/db/migrations/**"],
  hotFiles: ["open-sse/handlers/chatCore.js", "open-sse/executors/opencode.js"],
};
