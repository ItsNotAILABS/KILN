# Deploying the octopus engine as a KILN compute app

Same door the house's other services use (`ComputeClient.deployApp`,
lib/compute-client.mjs) — the engine becomes a daemon-supervised app
in its own repo, exactly like `auro/minutely-macro`:

1. Create the forge repo and seed it with this directory's files
   (`octopus.py`, `server.py`, `README.md`, tests) via the contents
   API, e.g. owner `auro`, repo `octopus-engine`.
2. Deploy:
   ```js
   const app = await kiln.deployApp({
     name: "octopus-engine",
     repo: "http://127.0.0.1:18787/git/auro/octopus-engine",
     command: "python3", args: ["server.py"], port: 8911,
     memoryMB: 256,
   });
   ```
   `server.py` binds 127.0.0.1:$PORT (the worker supplies PORT).
3. Call it: `POST http://127.0.0.1:8911/v1/scan` with
   `{quotes, min_net_bps}`; `GET /health` for readiness.

Notes:
- The app child runs with cwd = the repo checkout, which is the
  fingerprint the worker's stale-listener sweep uses — the orphan
  fix in lib/portowner.mjs covers this app unchanged.
- Activation is a deploy decision for the daemon's owners, like
  every compute app; this directory landing in the repo changes
  nothing live by itself.
