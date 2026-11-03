/**
 * Local HTTP API for the swarm daemon — so anything built in the forge
 * (a model service, a protocol daemon, an AI agent) can use the swarm
 * as a feature, not just the CLI.
 *
 *  - Binds 127.0.0.1 ONLY. Never 0.0.0.0.
 *  - Bearer token from <stateDir>/api.token (0600). Compared with
 *    timingSafeEqual. GET /health is the only unauthenticated route.
 *  - Port: config.apiPort, KILN_SWARM_API_PORT wins, 0 = ephemeral.
 *
 * Routes:
 *   GET  /health
 *   POST /jobs                      {name, plan{steps[]}, mind?, node?, repo?} -> {id}
 *   GET  /jobs                      -> {jobs:[...]}
 *   GET  /jobs/:id                  -> {job} | 404
 *   POST /nodes                     {name, caps, ttlSec, repo?, mind?, policy?} -> {id,name}
 *   GET  /nodes                     -> {nodes:[...]}
 *   POST /nodes/:id/stop            -> {ok:true}
 *   GET  /nodes/:id/logs?tail=N&stream=stdout|stderr -> {stream, log}
 *   POST /receipts/verify           {node?} -> {results:[...]}
 * Compute — serverless functions, parallel map, app hosting:
 *   POST /v1/compute/invoke         {name?, code, args?, timeoutMs?, waitMs?}
 *                                     waitMs omitted -> 201 {invocationId, jobId, status}
 *                                     waitMs set     -> 200 full result (blocks)
 *   GET  /v1/compute/invocations/:id -> {invocationId, status, ok?, result?, error?, logs?}
 *   POST /v1/compute/map            {name?, code, items[], timeoutMs?} -> {mapId, invocationIds}
 *   GET  /v1/compute/map/:mapId      -> {mapId, counts, results[]}
 *   POST /v1/compute/apps           {name, repo, command, args?, env?, port?, public?} -> {appId, name}
 *   GET  /v1/compute/apps           -> {apps:[...]} (each with previewUrl + preview)
 *   GET  /v1/compute/apps/:id       -> {app, previewUrl, preview}
 *   POST /v1/compute/apps/:id/preview   -> enable public preview (503 when no relay configured)
 *   DELETE /v1/compute/apps/:id/preview -> disable public preview
 *   GET  /v1/compute/apps/:id/logs?tail=N -> {appId, log}
 *   DELETE /v1/compute/apps/:id     -> {ok:true}
 * Git hosting (KILN-native repos, served via git http-backend CGI):
 *   POST /git/:owner/:repo            create repo (operator only; the repo
 *                                     is born with an initial commit on
 *                                     main, authored by the creator)
 *   POST /v1/repos                    canonical repo create under /v1:
 *                                     {owner, repo, description?,
 *                                     visibility?, template?} -> 201.
 *                                     Owners create under their own
 *                                     namespace (session or forge-scoped
 *                                     agent); the operator anywhere.
 *                                     template {license, licenseText?,
 *                                     readme?, gitignore?, templateId?}
 *                                     scaffolds the initial commit
 *                                     (lib/templates.mjs).
 *   /v1/templates                     per-account saved creation
 *                                     templates: POST create, GET list,
 *                                     GET /:id, DELETE /:id — always the
 *                                     CALLER's account's templates
 *                                     (session or forge-scoped agent;
 *                                     the operator has no account and
 *                                     gets a 403 saying so).
 *   DELETE /v1/repos/:owner/:repo     delete repo outright (the owner's
 *                                     account session or the operator;
 *                                     agent tokens can NEVER delete)
 *   GET  /git                         list repos (auth required; account
 *                                     principals see only their namespace)
 *   GET  /git/:owner/:repo/info/refs?service=...   (auth required)
 *   POST /git/:owner/:repo/git-upload-pack          (auth required — clone/fetch)
 *   POST /git/:owner/:repo/git-receive-pack         (auth required — push,
 *                                     operator token only)
 *   Reads are principal-gated by the architect's rule (2026-10-28): only
 *   our accounts see the forge. CI status/latest/log under /git/.../ci/
 *   are gated the same way — a CI log can carry code.
 *   Exception (architect's order, 2026-10-29): a repo whose stored
 *   visibility is "public" (owner's choice, details PATCH) reads like
 *   public GitHub — list, clone/fetch, details and forge GETs are open
 *   to anyone including anonymous readers. Writes never open up.
 * Promotion (KILN-native repos -> GitHub, Git Data API rebuild):
 *   POST /v1/promote                {repo:"owner/repo", github?:"owner/repo",
 *                                    branch?, rebase?, force?} -> receipt
 * Per-repo memory (auth required; memory lives on refs/kiln/memory):
 *   POST /git/:owner/:repo/memory/episodes   {content, title?, tags?, …} -> {event}
 *   POST /git/:owner/:repo/memory/facts      {subject, predicate, object, sourceEpisodes[]} -> {fact}
 *   POST /git/:owner/:repo/memory/supersede  {fact, reason?}
 *   POST /git/:owner/:repo/memory/links      {from, to, relation}
 *   POST /git/:owner/:repo/memory/core       {label, value, description?}
 *   GET  /git/:owner/:repo/memory/core|facts|recall|context|stats
 *   POST /git/:owner/:repo/memory/verify     -> {ok, events, commits}
 *   GET  /memory/recall?q=…                  cross-repo recall (phase 6):
 *                                    fused hits with per-repo provenance;
 *                                    unverifiable chains excluded + named
 * Sites (first-class sites: frontend repo + backend repo + artifact + app):
 *   POST /v1/sites                  {name, frontend:"o/r", backend:"o/r",
 *                                    artifact?, computeApp?} -> {ok, site}
 *                                    (also writes linkage core blocks into
 *                                    both repos' KILN Memory on create)
 *   GET  /v1/sites                  -> {sites:[...]} (registry records)
 *   GET  /v1/sites/:id              -> aggregated live status (repo HEADs,
 *                                    compute app status, memory linkage)
 *   DELETE /v1/sites/:id            -> {ok:true, id} (registry entry only)
 * Workspaces (first-class grouping: member repos + linked sites, one owner):
 *   POST /v1/workspaces             {owner, slug, name, description?,
 *                                    repos?:["o/r",…], siteIds?:["site_…"]}
 *                                    -> 201 {ok, workspace} (also writes a
 *                                    `workspace` core block into each member
 *                                    repo's KILN Memory)
 *   GET  /v1/workspaces?owner=      -> {workspaces:[...]} (registry records)
 *   GET  /v1/workspaces/:id         -> aggregated live status (member repo
 *                                    HEADs + branches, linked sites, memory
 *                                    linkage)
 *   PATCH /v1/workspaces/:id        {name?, description?, addRepos?,
 *                                    removeRepos?, linkSites?, unlinkSites?,
 *                                    setParent?:"<id>"|null}
 *                                    -> {ok, workspace} (setParent present =
 *                                    reparent; cycles refused with 400)
 *   DELETE /v1/workspaces/:id       {confirm:"<slug>"} -> {ok:true, id}
 *                                    (guarded; registry entry only;
 *                                    children reparent to its parent)
 *   GET  /v1/workspaces?tree=1      -> {workspaces:[roots with nested
 *                                    children]} (see GET list above)
 * Project details (live per-repo facts + editable metadata):
 *   GET  /v1/repos/:owner/:repo/details -> project details object
 *   PATCH /v1/repos/:owner/:repo/details {description?, topics?,
 *                                    visibility?: "public"|"private",
 *                                    pages?: {enabled?, branch?, path?}}
 *                                    -> {ok, details}   (owner/operator
 *                                    only; visibility defaults "private";
 *                                    "public" opens READS to anyone)
 * KILN Pages (lib/pages.mjs — static serving of the repo's designated
 * pages source, live from the ref; a push IS the republish):
 *   GET|HEAD /pages/:owner/:repo/[...path] -> the file at path under
 *                                    the details' pages {branch, path}
 *                                    (index.html at directory paths,
 *                                    301 to the slash form, real 404s;
 *                                    visibility law unchanged: public
 *                                    repo → anyone, private → owner/
 *                                    operator only)
 * KILN Papers (lib/papers.mjs + lib/papermanifest.mjs — the forge as
 * its own Zenodo/arXiv; model in swarm/docs/PAPERS-WORKFLOW.md):
 *   designation rides the details PATCH: paper?: {enabled?} — enabling
 *                                    requires a valid paper.json at
 *                                    the repo root on the default
 *                                    branch's tip at that moment
 *   a forge RELEASE on a designated repo snapshots {manifest, tag,
 *                                    commit, files+sha256} into the
 *                                    papers registry and assigns the
 *                                    next version ID (the manifest at
 *                                    the release commit is validated
 *                                    BEFORE the release is created —
 *                                    invalid = 400, no release)
 *   GET  /v1/papers(?owner=)        -> {papers:[concept,...]} (per-
 *                                    principal visibility filtering)
 *   GET  /v1/papers/:owner/:slug    -> concept record (manifest of the
 *                                    latest version + all versions)
 *   GET  /v1/papers/:owner/:slug/v/:n -> one version record (snapshot
 *                                    + generated citations; doi: null
 *                                    until a real prefix exists)
 *   GET  /doi/:owner/:slug[/v/:n]   -> 302 to the paper's KILN Pages
 *                                    URL when pages-designated, else
 *                                    its /v1/papers record URL
 *                                    (visibility law identical to the
 *                                    record reads: public → anyone,
 *                                    private → owner/operator)
 * Forge (the GitHub-shaped repo surface, lib/forge.mjs; operator = root,
 * account/agent principals walled to their own namespace, agents need
 * the "forge" scope; every write authenticated, audited, rate-limited):
 *   GET  /v1/repos/:owner/:repo/branches · POST (create) · DELETE /:name
 *   GET  /v1/repos/:owner/:repo/tree?ref&path
 *   GET  /v1/repos/:owner/:repo/contents?path&ref (&raw=1 = raw bytes)
 *   PUT  /v1/repos/:owner/:repo/contents {path, content, encoding?,
 *        message, branch?, sha?} -> a REAL git commit by the principal
 *   DELETE /v1/repos/:owner/:repo/contents {path, message, branch?, sha?}
 *   GET  /v1/repos/:owner/:repo/commits(?ref&limit&path) · /commits/:sha
 *   GET  /v1/repos/:owner/:repo/compare?base&head (ahead/behind, files,
 *        capped patch)
 *   POST /v1/repos/:owner/:repo/pulls {title, body?, head, base}
 *   GET  /v1/repos/:owner/:repo/pulls(?state) · GET/PATCH /pulls/:n
 *   POST /v1/repos/:owner/:repo/pulls/:n/comments {body}
 *   POST /v1/repos/:owner/:repo/pulls/:n/reviews {state, body?}
 *   POST /v1/repos/:owner/:repo/pulls/:n/merge {method?, message?,
 *        deleteBranch?}   (fast-forward or merge-commit; conflicts ->
 *        409; deleteBranch:true also deletes the head branch after the
 *        merge, default off; CI enqueued on the base branch after
 *        merge, best-effort like pushes)
 *   GET  /v1/repos/:owner/:repo/tags
 *   POST /v1/repos/:owner/:repo/releases {tag, name?, notes?, target?}
 *   GET  /v1/repos/:owner/:repo/releases · GET/PATCH/DELETE /releases/:tag
 * Packages (lib/packages.mjs; immutable versions, blobs on disk):
 *   GET  /v1/packages(?owner) · GET /v1/packages/:owner/:name
 *   GET  /v1/packages/:owner/:name/:version
 *   GET  /v1/packages/:owner/:name/:version/:filename (raw download)
 *   PUT  /v1/packages/:owner/:name/:version/:filename (raw bytes publish;
 *        same version+file with different bytes -> 409)
 * Accounts + agent identities (lib/accounts.mjs). Principals resolve
 * operator -> account session -> agent token; account/agent principals
 * are owner-scoped (see the guard after the auth gate):
 *   POST /v1/accounts               {email, name, owner, password}
 *                                   -> 201 {ok, account}   (public bootstrap)
 *   POST /v1/accounts/login         {email, password}
 *                                   -> {ok, account, sessionToken, expiresAt}
 *   Wallet sign-in (public bootstrap, like login — the wallet IS the
 *   credential; a second door to the SAME account + session shape):
 *   POST /v1/accounts/wallet/challenge {address, publicKey?}
 *                                   -> 201 {ok, challengeId, message,
 *                                   expiresAt}  (short-TTL, single-use;
 *                                   sign message with the wallet's
 *                                   ed25519 key; names no account)
 *   POST /v1/accounts/wallet/verify {challengeId, address, signature,
 *                                    publicKey?}
 *                                   -> {ok, account, sessionToken,
 *                                   expiresAt, wallet}  (session is for
 *                                   the account the wallet is LINKED
 *                                   to — request account claims are
 *                                   ignored; bad sig 403, replay/
 *                                   unknown challenge 404, expired
 *                                   410, unlinked 403 with reason
 *                                   "wallet_not_linked")
 *   OAuth sign-in (public bootstrap, like login — Google + X doors
 *   to the SAME account; provider layer lib/oauth.mjs, resolution in
 *   lib/accounts.mjs; config = daemon env KILN_OAUTH_GOOGLE_CLIENT_ID
 *   / _SECRET, KILN_OAUTH_X_CLIENT_ID / _SECRET, optional
 *   KILN_OAUTH_REDIRECT_BASE):
 *   GET  /v1/accounts/oauth/:provider/start?return=<app-relative>
 *                                   -> 302 provider authorization URL
 *                                   (state hashed, 10-min, single-use,
 *                                   PKCE S256) | 503 {error:
 *                                   "provider_not_configured",
 *                                   provider} when unconfigured
 *   GET  /v1/accounts/oauth/:provider/callback?code&state
 *                                   -> 302 <return>#oauth_handoff=<code>
 *                                   (matched) or #oauth_pending=<token>
 *                                   (new identity); state unknown/
 *                                   replayed 400, expired 410
 *   POST /v1/accounts/oauth/complete {pendingToken, owner, name}
 *                                   -> {ok, account, sessionToken,
 *                                   expiresAt} (exactly wallet verify;
 *                                   owner taken 409 keeps pending alive)
 *   POST /v1/accounts/oauth/handoff {code}
 *                                   -> {ok, account, sessionToken,
 *                                   expiresAt} (consumed on any
 *                                   attempt; unknown 404, expired 410)
 *   GET  /v1/accounts/me            -> {ok, account, principal,
 *                                   sponsor, sponsoredAgents, wallets,
 *                                   hasWalletBackup}
 *   POST /v1/accounts/me/agents     {name, scopes?}  (session only)
 *                                   -> 201 {ok, agent, token}  (token shown once)
 *   GET  /v1/accounts/me/agents     -> {agents:[...]}  (session only)
 *   DELETE /v1/accounts/me/agents/:id -> {ok, agent}   (session only, revoke)
 *   Agent accounts + invite links (lib/accounts.mjs createAgentAccount
 *   + lib/agentinvites.mjs; sponsor link = visibility, never control):
 *   POST /v1/accounts/me/agent-accounts {owner, name, modelLabel?,
 *                                   scopes?, sponsorOwner?}
 *                                   -> 201 {ok, account, agent, token}
 *                                   (session sponsors itself; an agent
 *                                   account's own token sponsors a
 *                                   sub-agent; the operator names
 *                                   sponsorOwner; first token shown once)
 *   GET  /v1/accounts/me/agent-accounts (?sponsorOwner= for operator)
 *                                   -> {accounts:[...]}  (sponsored list)
 *   DELETE /v1/accounts/me/agent-accounts/:id
 *                                   -> {ok, account}  (sever the sponsor
 *                                   link of child account :id — either
 *                                   side may sever; the child keeps its
 *                                   account, namespace, and repos;
 *                                   a non-party caller gets 404)
 *   POST /v1/accounts/me/agent-invites {label?, sponsorOwner?}
 *                                   -> 201 {ok, invite, token,
 *                                   tokenShownOnce, delivery}  (same
 *                                   sponsor rules; token shown once)
 *   GET  /v1/accounts/me/agent-invites -> {invites:[...]}
 *   DELETE /v1/accounts/me/agent-invites/:id -> {ok, invite}
 *   POST /v1/agent-invites/:token/redeem {owner, name, modelLabel?}
 *                                   -> 201 {ok, account, agent, token,
 *                                   tokenShownOnce, invite}
 *                                   (PUBLIC bootstrap — the link is
 *                                   the credential; consumed/revoked/
 *                                   unknown 404, expired 410, owner
 *                                   claimed/reserved 409; a failed
 *                                   creation does not consume it)
 *   Wallet identity binding (lib/accounts.mjs; session only to write,
 *   session/agent to list; GET /v1/accounts/me also carries the list):
 *   POST /v1/accounts/me/wallets/challenge {address}
 *                                   -> 201 {challengeId, message, expiresAt}
 *                                   (short-TTL, single-use; sign message
 *                                   with the wallet's ed25519 key)
 *   POST /v1/accounts/me/wallets    {address, kind: "local"|"phantom",
 *                                    publicKey, challengeId, signature}
 *                                   -> 201 {ok, wallet}  (bad sig 403,
 *                                   replay/unknown challenge 404, expired
 *                                   410, address on another account 409)
 *   GET  /v1/accounts/me/wallets    -> {wallets:[{address, kind,
 *                                    publicKey, createdAt, hasBackup}]}
 *   DELETE /v1/accounts/me/wallets/:address -> {ok, wallet}
 *   PUT  /v1/accounts/me/wallet-backup {blob, kdf} -> {ok, updatedAt}
 *   GET  /v1/accounts/me/wallet-backup -> {backup: {blob, kdf,
 *                                    updatedAt} | null}   (session only;
 *                                    blob is opaque client ciphertext —
 *                                    never logged, never audited)
 *   Encrypted email binding (lib/accounts.mjs + lib/emailcrypto.mjs):
 *   PUT  /v1/accounts/me/email      {email} -> {ok, account}  (session
 *                                    only; the address rests ONLY as
 *                                    AES-256-GCM ciphertext + HMAC tag
 *                                    + masked form; signup stores its
 *                                    address through the same path and
 *                                    /v1/accounts/me reports the masked
 *                                    form + emailBound once bound)
 *   Workspace invites by email (lib/invites.mjs; owner/admin only):
 *   POST /v1/workspaces/:id/invites {email, role} -> 201 {ok, invite,
 *                                    token, tokenShownOnce, delivery}
 *                                    (the plaintext token is shown
 *                                    ONCE — there is no mail sender
 *                                    guarantee; an invite email is
 *                                    also enqueued via the mailer)
 *   GET  /v1/workspaces/:id/invites -> {invites:[...]}  (masked)
 *   DELETE /v1/workspaces/:id/invites/:inviteId -> {ok, invite}
 *   POST /v1/invites/:token/accept  -> {ok, workspace, member,
 *                                    account, invite}   (session only;
 *                                    consumed/revoked 404, expired
 *                                    410, different bound email 409)
 *   GET  /v1/invites/mine           -> {invites:[{id, workspaceId,
 *                                    workspaceSlug, workspaceName,
 *                                    role, status:"pending",
 *                                    createdAt, expiresAt}]}
 *                                    (session only; the PENDING invites
 *                                    addressed to the account's bound
 *                                    email, matched by HMAC tag — no
 *                                    address in any form is returned;
 *                                    no bound email -> empty list)
 *   Mail (lib/mailer.mjs; operator only):
 *   GET  /v1/mail/outbox            -> {ok, transport, counts, mail}
 *                                    (masked recipients; queued means
 *                                    UNSENT until a provider accepts)
 *   POST /v1/mail/send              -> drain the outbox through the
 *                                    env-configured transport
 * Discovery (bearer-gated like every /v1 route):
 *   GET  /v1/capabilities           -> {version, abilities, openapi, docs}
 *   GET  /v1/openapi.json           -> OpenAPI 3.1 document (lib/openapi.mjs)
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  listNodeIds, loadNode, saveNode, resolveNode, pidAlive,
  heartbeatAgeMs, nodeDir, loadApiToken,
} from "./state.mjs";
import { appendEvent, replay, newJobId } from "./queue.mjs";
import { createNode } from "./nodes.mjs";
import { parseCaps, capsToNames, nowSec } from "./grant.mjs";
import { verifyReceipts } from "./receipts.mjs";
import { loadKeypair } from "./keys.mjs";
import { loadKeyFile } from "./state.mjs";
import { createRepo, deleteRepo, listRepos, repoExists, repoPath, serveGitHttp, validRepoName } from "./git.mjs";
import { promoteRepo } from "./promote.mjs";
import { buildContextIndex, loadIndex, pruneContextCas, queryContextIndex } from "./context-index.mjs";
import { appendContextReceipt, verifyContextReceipts } from "./context-receipts.mjs";
import { boundContextRequest, contextLimits } from "./context-policy.mjs";
import { recordContextMetric, loadContextMetrics, contextMetricsSummary } from "./context-metrics.mjs";
import {
  remember, assertFact, supersedeFact, linkMemories, setCore,
  proposeMemory, resolveProposal,
  loadMemory, factsAt, recall, recallCrossRepo, buildContext, memoryStats, verifyMemory, agentAwareness,
} from "./memory.mjs";
import { memorySigningPubkey, signatureSummary } from "./memory-signing.mjs";
import {
  snapshotRefs, loadRepoConfig, enqueueCiJob, readResult, readLatest, readLog,
  forgetRepoCiResults,
} from "./ci.mjs";
import {
  ComputeError, submitInvocation, getInvocation, waitInvocation,
  submitMap, getMap, deployApp, listApps, appStatus, appLogs, undeployApp,
  getCapacity,
} from "./compute.mjs";
import {
  withPreview, enablePreview, disablePreview, teardownPreview,
  startPreviewReconciler,
} from "./preview.mjs";
import {
  SitesError, createSite, listSites, deleteSite, siteStatus,
} from "./sites.mjs";
import {
  WorkspacesError, createWorkspace, listWorkspaces, workspaceTree,
  updateWorkspace, deleteWorkspace, workspaceStatus, resolveWorkspace,
  workspaceRoleFor, listWorkspacesForAccount,
} from "./workspaces.mjs";
import {
  RepoDetailsError, repoDetails, updateRepoDetails, repoVisibility, repoPaper,
} from "./repodetails.mjs";
import { PagesError, planPage } from "./pages.mjs";
import {
  PapersError, listPaperRecords, getPaperRecord, conceptView, getVersionView,
  planPaperRelease, recordPaperRelease, planDoiRedirect, forgetPaperRecords,
} from "./papers.mjs";
import {
  ForgeError, actorOf, appendAudit, listBranches, createBranch, deleteBranch,
  readTree, readContents, writeFile, listCommits, getCommit, compareRefs,
  listTags, listReleases, createRelease, updateRelease, deleteRelease,
  createPull, listPulls, getPull, updatePull, commentPull, reviewPull, mergePull,
  listBranchProtection, getBranchProtection, setBranchProtection, deleteBranchProtection,
  forgetRepo,
} from "./forge.mjs";
import {
  PackagesError, publishPackage, listPackages, getPackage, getPackageVersion,
  readPackageFile, PACKAGE_MAX_BYTES,
} from "./packages.mjs";
import {
  AccountsError, accountPublic, agentPublic, createAccount, login,
  createAgent, listAgents, revokeAgent, resolveAccountToken,
  issueWalletChallenge, linkWallet, listWallets, unlinkWallet,
  putWalletBackup, getWalletBackup,
  issueWalletSignInChallenge, verifyWalletSignIn,
  startOAuth, handleOAuthCallback, completeOAuth, redeemOAuthHandoff,
  PROVIDER_NOT_CONFIGURED,
  bindAccountEmail, getEmailBinding,
  createAgentAccount, listSponsoredAgentAccounts, sponsorOf, accountByOwner,
  accountPublicById, severSponsorLink,
} from "./accounts.mjs";
import {
  InvitesError, createInvite, listInvites, listMyInvites, revokeInvite,
  acceptInvite, inviteBinding,
} from "./invites.mjs";
import {
  AgentInvitesError, createAgentInvite, listAgentInvites, revokeAgentInvite,
  redeemAgentInvite,
} from "./agentinvites.mjs";
import {
  MailerError, enqueueMail, listOutbox, outboxCounts, drainOutbox,
  transportConfigFromEnv,
} from "./mailer.mjs";
import {
  TemplatesError, resolveTemplateFiles, getTemplate,
  createTemplate, listTemplates, getTemplatePublic, deleteTemplate,
} from "./templates.mjs";
import { buildCapabilities, buildOpenApiDocument } from "./openapi.mjs";

// 4MB: the forge contents API carries base64-encoded files (1MB raw
// file ≈ 1.4MB encoded) plus PR/release prose in one JSON body.
const MAX_BODY = 4 * 1024 * 1024;

/**
 * Enqueue a welcome (introduction) email for an account against its
 * stored encrypted binding. Mail is a side effect of identity acts:
 * a failure is logged (never with an address or a token) and never
 * allowed to break the act itself — the outbox is inspectable and
 * the drain is retryable, exactly like CI on a push.
 */
function enqueueWelcomeMail(dir, account, context = {}) {
  try {
    const binding = getEmailBinding(dir, account.id);
    if (!binding) return;
    enqueueMail(dir, {
      kind: "introduction",
      to: binding,
      context: { owner: account.owner, ...context },
    });
  } catch (e) {
    console.error(`mail: welcome enqueue failed for ${account.owner}: ${e.message}`);
  }
}

function contextIndexDir(dir) {
  const p = join(dir, "context-indexes");
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function resolveContextNode(dir, raw) {
  const id = resolveNode(dir, String(raw));
  const node = loadNode(dir, id);
  if (!node.workdir || !existsSync(node.workdir)) throw new Error("node has no available workdir");
  if (!existsSync(join(node.workdir, ".git"))) throw new Error("node workdir is not a Git checkout");
  return { id, node };
}

function contextNodeRepoIdentity(repoRef) {
  const value = String(repoRef || "");
  let m = value.match(/\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/?$/);
  if (m) return { owner: m[1], repo: m[2] };
  m = value.match(/\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

function nodeStatus(dir, cfg, node) {
  const alive = pidAlive(node.workerPid);
  const fresh = heartbeatAgeMs(dir, node.id) < (cfg.heartbeatTimeoutMs || 30000);
  if (alive && fresh) return existsSync(join(nodeDir(dir, node.id), "job.json")) ? "working" : "idle";
  if (alive) return "stale";
  return "dead";
}

function nodeView(dir, cfg, node) {
  return {
    id: node.id,
    name: node.name,
    status: nodeStatus(dir, cfg, node),
    workerPid: node.workerPid,
    caps: node.grant.capabilities,
    capNames: capsToNames(node.grant.capabilities),
    expiresAt: node.grant.expiresAt,
    expired: node.grant.expiresAt <= nowSec(),
    parent: node.grant.parent,
    mind: node.mind,
    repo: node.repo,
    heartbeatAgeMs: Math.round(heartbeatAgeMs(dir, node.id)),
    restarts: node.restarts,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch { reject(new Error("invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

/** Raw-body reader for package publishes — bytes, not JSON, with a hard cap. */
function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > cap) { reject(new Error(`body too large (>${cap} bytes)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Write rate sanity for the forge surface: a fixed window per principal.
 * 120 writes/minute is far above any honest agent flow and far below
 * anything that could hammer the git plumbing. Reads are not limited.
 */
const writeWindows = new Map();
function writeRateLimited(principal) {
  const key = principal.kind === "operator" ? "operator"
    : principal.kind === "agent" ? `agt:${principal.agent.id}`
    : `sess:${principal.account.id}`;
  const now = Date.now();
  const w = writeWindows.get(key);
  if (!w || now - w.start >= 60000) {
    writeWindows.set(key, { start: now, count: 1 });
    return 0;
  }
  w.count += 1;
  if (w.count > 120) return Math.ceil((w.start + 60000 - now) / 1000);
  return 0;
}

/** 302 with a relative Location (OAuth start/callback hand-offs). */
function sendRedirect(res, location) {
  res.writeHead(302, { location, "content-length": 0 });
  res.end();
}

function send(res, code, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
  });
  res.end(body);
}

/** Preview subsystem log line (daemon.log). Never carries the relay token. */
function plog(...a) {
  console.log(`[preview ${new Date().toISOString()}]`, ...a);
}

/**
 * 401 challenge for the auth gate. RFC 7235: a 401 MUST carry
 * WWW-Authenticate, otherwise clients (notably git, which relies on the
 * 401 -> retry-with-credentials flow for userinfo URLs like
 * http://oauth2:<token>@host/...) never retry and the push dies with a
 * confusing transport error instead of authenticating.
 */
function unauthorized(res) {
  return send(
    res,
    401,
    { error: "unauthorized: valid token required (Bearer header or Basic password)" },
    { "www-authenticate": 'Basic realm="kiln-swarm", Bearer realm="kiln-swarm"' }
  );
}

/**
 * Bearer <token>, or HTTP Basic where the password is the token — that's how
 * `git` sends credentials embedded in a URL (http://oauth2:<token>@host/...).
 */
function checkAuth(req, token) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const p = auth.slice(7);
    return p.length === token.length && timingSafeEqual(Buffer.from(p), Buffer.from(token));
  }
  if (auth.startsWith("Basic ")) {
    let decoded;
    try { decoded = Buffer.from(auth.slice(6), "base64").toString("utf8"); }
    catch { return false; }
    const i = decoded.indexOf(":");
    const pass = i >= 0 ? decoded.slice(i + 1) : decoded;
    return pass.length > 0 && pass.length === token.length &&
      timingSafeEqual(Buffer.from(pass), Buffer.from(token));
  }
  return false;
}

export function startApiServer(dir, cfg) {
  const token = loadApiToken(dir);
  let apiPort = 0; // filled in once listening; used for clone URLs
  // Public-preview sidecar reconciler: one ssh/pipe bundle for all public
  // apps, respawned on drop. No-op until cfg.preview is set.
  const previews = startPreviewReconciler(dir, cfg, plog);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, version: 2, service: "kiln-swarm", contextFabric: "v2" });
      }

      // ---- git hosting: read routes are HELD for the auth gate below ----
      // (architect's rule, 2026-10-28: only our accounts see the forge —
      // repo list, clone/fetch and CI reads all require a principal).
      let gitList = false;
      if (req.method === "GET" && path === "/git") gitList = true;
      // CI status, GitHub commit-status style — gated like clone/fetch.
      // ci/log/:sha serves the run's retained FULL log as text/plain
      // (the status doc's logTail is only the last 120 lines).
      let ciRoute = null;
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/ci\/(status|latest|log)(?:\/([0-9a-f]{4,40}))?$/);
        if (req.method === "GET" && m) {
          ciRoute = { owner: m[1], repo: m[2], which: m[3], sha: m[4] || null };
        }
      }
      // gitReceive is set for receive-pack; served after the auth gate below.
      // NOTE: only paths WITH a trailing smart-http segment are intercepted
      // here; bare /git/:owner/:repo (repo create) falls through to auth.
      let gitReceive = null;
      let gitRead = null;
      let memoryRoute = null;
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/);
        // CI paths also match this shape — they are held as ciRoute above
        // and must not fall into the smart-http kind check (404) here.
        if (m && m[3] && !ciRoute) {
          const owner = m[1], repo = m[2], rest = m[3] || "";
          // Memory routes live under /git/:owner/:repo/memory/* but are
          // NOT git protocol — hold them for the auth gate below.
          if (rest === "/memory" || rest.startsWith("/memory/")) {
            memoryRoute = { owner, repo, rest };
          } else {
          const kind =
            req.method === "GET" && rest === "/info/refs" ? "smart"
            : req.method === "POST" && rest === "/git-upload-pack" ? "smart"
            : req.method === "POST" && rest === "/git-receive-pack" ? "receive"
            : null;
          if (!kind) return send(res, 404, { error: "not found" });
          if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
            return send(res, 404, { error: "no such repo" });
          }
          if (kind === "receive") {
            gitReceive = { owner, repo };
          } else {
            gitRead = { owner, repo };
          }
          }
        }
      }

      // ---- auth (everything below here) ----
      // Principal resolution, in order: the operator token (root,
      // unchanged), then an account session (kiln_sess_…), then an
      // agent token (kiln_agt_…) owned by an account. Signup + login
      // are public bootstrap routes — they authenticate by password.
      let principal = null;
      if (checkAuth(req, token)) {
        principal = { kind: "operator" };
      } else {
        const authz = req.headers.authorization || "";
        if (authz.startsWith("Bearer ")) {
          const resolved = resolveAccountToken(dir, authz.slice(7));
          if (resolved) {
            principal = resolved.kind === "agent"
              ? { kind: "agent", account: resolved.account, agent: resolved.agent }
              : { kind: "session", account: resolved.account };
          }
        }
      }
      const isBootstrap = req.method === "POST" &&
        (path === "/v1/accounts" || path === "/v1/accounts/login" ||
         path === "/v1/accounts/wallet/challenge" || path === "/v1/accounts/wallet/verify");

      // ---- accounts: public bootstrap (signup + login) ----
      if (req.method === "POST" && path === "/v1/accounts") {
        const b = await readBody(req);
        try {
          // An unclaimed namespace that already carries forge content
          // belongs to the operator's world: only an operator-signed
          // signup may claim it (e.g. the architect claiming his own).
          if (!principal || principal.kind !== "operator") {
            const hasContent =
              listRepos(dir).some((r) => r.owner === b.owner) ||
              listWorkspaces(dir, { owner: b.owner }).length > 0;
            if (hasContent) {
              throw new AccountsError(409,
                `the owner namespace "${b.owner}" already has forge content and is reserved — pick another owner, or have the operator claim it for you`);
            }
          }
          const account = createAccount(dir, {
            email: b.email, name: b.name, owner: b.owner, password: b.password,
          });
          // The introduction email: signup binds the address through
          // the encrypted path, and a fresh binding gets a welcome.
          enqueueWelcomeMail(dir, account);
          return send(res, 201, { ok: true, account });
        } catch (e) {
          if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (req.method === "POST" && path === "/v1/accounts/login") {
        const b = await readBody(req);
        try {
          const r = login(dir, { email: b.email, password: b.password });
          return send(res, 200, {
            ok: true, account: r.account, sessionToken: r.sessionToken, expiresAt: r.expiresAt,
          });
        } catch (e) {
          if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }

      // ---- accounts: wallet sign-in (public bootstrap, like login) ----
      // The wallet signature IS the credential, so these routes run
      // before the principal gate exactly like login. Errors carrying
      // a machine-readable reason (wallet_not_linked) surface it as
      // {reason, code} alongside {error}; every other error keeps the
      // plain {error} shape.
      const sendAccountsError = (res2, e) => e.reason
        ? send(res2, e.status, { error: e.message, reason: e.reason, code: e.code })
        : send(res2, e.status, { error: e.message });
      if (req.method === "POST" && path === "/v1/accounts/wallet/challenge") {
        const b = await readBody(req);
        try {
          const c = issueWalletSignInChallenge(dir, b.address);
          return send(res, 201, { ok: true, ...c });
        } catch (e) {
          if (e instanceof AccountsError) return sendAccountsError(res, e);
          throw e;
        }
      }
      if (req.method === "POST" && path === "/v1/accounts/wallet/verify") {
        const b = await readBody(req);
        try {
          // NOTE: b.account / b.owner / b.accountId are never read —
          // the session is for the wallet's linked account, only.
          const r = verifyWalletSignIn(dir, {
            address: b.address, publicKey: b.publicKey,
            challengeId: b.challengeId, signature: b.signature,
          });
          return send(res, 200, {
            ok: true, account: r.account, sessionToken: r.sessionToken,
            expiresAt: r.expiresAt, wallet: r.wallet,
          });
        } catch (e) {
          if (e instanceof AccountsError) return sendAccountsError(res, e);
          throw e;
        }
      }

      // ---- accounts: OAuth sign-in (public bootstrap, like login) ----
      // Google + X are doors to the SAME account model (lib/accounts
      // .mjs OAuth section + lib/oauth.mjs provider layer). Start and
      // callback are GET redirects by OAuth's nature; complete and
      // handoff are POSTs. No session token ever travels in a URL:
      // the callback hands the app a one-time handoff CODE (or a
      // pending sign-up token) in the URL fragment, and only the
      // POST redemption returns the session, in a JSON body.
      if (path.startsWith("/v1/accounts/oauth/")) {
        const seg = path.split("/").filter(Boolean); // [v1, accounts, oauth, ...]
        const sendOAuthError = (e) => {
          if (e.reason === PROVIDER_NOT_CONFIGURED) {
            return send(res, 503, { error: PROVIDER_NOT_CONFIGURED, provider: e.provider || seg[3] || null });
          }
          return send(res, e.status, { error: e.message });
        };
        if (req.method === "POST" && path === "/v1/accounts/oauth/complete") {
          const b = await readBody(req);
          try {
            // Reserved-namespace rule, exactly like public signup —
            // checked BEFORE the pending record is touched, so a
            // 409 here also leaves the pending sign-up alive.
            if (typeof b.owner === "string" && !accountByOwner(dir, b.owner)) {
              const hasContent =
                listRepos(dir).some((r) => r.owner === b.owner) ||
                listWorkspaces(dir, { owner: b.owner }).length > 0;
              if (hasContent) {
                throw new AccountsError(409,
                  `the owner namespace "${b.owner}" already has forge content and is reserved — pick another owner`);
              }
            }
            const r = completeOAuth(dir, {
              pendingToken: b.pendingToken, owner: b.owner, name: b.name,
            });
            if (r.account.emailBound) enqueueWelcomeMail(dir, r.account);
            // Shape AND status mirror wallet verify exactly (200).
            return send(res, 200, {
              ok: true, account: r.account, sessionToken: r.sessionToken, expiresAt: r.expiresAt,
            });
          } catch (e) {
            if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "POST" && path === "/v1/accounts/oauth/handoff") {
          const b = await readBody(req);
          try {
            const r = redeemOAuthHandoff(dir, { code: b.code });
            return send(res, 200, {
              ok: true, account: r.account, sessionToken: r.sessionToken, expiresAt: r.expiresAt,
            });
          } catch (e) {
            if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        const provider = seg[3];
        const action = seg[4];
        if (req.method === "GET" && seg.length === 5 && action === "start") {
          try {
            const r = startOAuth(dir, provider, {
              returnPath: url.searchParams.get("return") || undefined,
            });
            return sendRedirect(res, r.authorizationUrl);
          } catch (e) {
            if (e instanceof AccountsError) return sendOAuthError(e);
            throw e;
          }
        }
        if (req.method === "GET" && seg.length === 5 && action === "callback") {
          const providerError = url.searchParams.get("error");
          if (providerError) {
            return send(res, 400, { error: "the OAuth provider returned an error — sign-in was not completed" });
          }
          try {
            const r = await handleOAuthCallback(dir, provider, {
              code: url.searchParams.get("code") || undefined,
              state: url.searchParams.get("state") || undefined,
            });
            if (r.kind === "handoff") {
              return sendRedirect(res, `${r.returnPath}#oauth_handoff=${encodeURIComponent(r.handoffCode)}`);
            }
            return sendRedirect(res, `${r.returnPath}#oauth_pending=${encodeURIComponent(r.pendingToken)}`);
          } catch (e) {
            if (e instanceof AccountsError) return sendOAuthError(e);
            throw e;
          }
        }
        return send(res, 404, { error: "not found" });
      }

      // ---- agent invite redemption (public bootstrap, like login) ----
      // POST /v1/agent-invites/:token/redeem {owner, name, modelLabel?}
      // UNAUTHENTICATED by design: the link IS the bootstrap
      // credential. The redeemer picks its own owner handle + display
      // name; the response carries the new agent account and its
      // first agent token exactly once. Consumed/revoked/unknown →
      // 404, expired → 410 (workspace-invite semantics). A namespace
      // that already carries forge content is reserved, exactly like
      // public signup; an owner already claimed by an account is the
      // lib's 409. A failed creation does NOT consume the invite.
      {
        const rm = path.match(/^\/v1\/agent-invites\/([A-Za-z0-9_-]+)\/redeem$/);
        if (rm) {
          if (req.method !== "POST") return send(res, 404, { error: "not found" });
          const b = await readBody(req);
          try {
            if (typeof b.owner === "string" && !accountByOwner(dir, b.owner)) {
              const hasContent =
                listRepos(dir).some((r) => r.owner === b.owner) ||
                listWorkspaces(dir, { owner: b.owner }).length > 0;
              if (hasContent) {
                throw new AccountsError(409,
                  `the owner namespace "${b.owner}" already has forge content and is reserved — pick another owner`);
              }
            }
            const r = redeemAgentInvite(dir, decodeURIComponent(rm[1]), {
              owner: b.owner, name: b.name, modelLabel: b.modelLabel,
            });
            return send(res, 201, {
              ok: true, account: r.account, agent: r.agent, token: r.token,
              tokenShownOnce: true, invite: r.invite,
            });
          } catch (e) {
            if (e instanceof AgentInvitesError || e instanceof AccountsError) {
              return send(res, e.status, { error: e.message });
            }
            throw e;
          }
        }
      }
      if (path === "/v1/agent-invites" || path.startsWith("/v1/agent-invites/")) {
        return send(res, 404, { error: "not found" });
      }

      if (!principal) {
        // GitHub-style public reads (architect's order, 2026-10-29):
        // a repo whose stored visibility is exactly "public" (owner's
        // choice via the details PATCH) is readable by ANYONE — repo
        // list, clone/fetch, details and forge GETs — like public
        // GitHub. Everything else still demands a principal, and no
        // write is ever public. The anonymous principal minted here is
        // fenced to exactly those reads by the handlers + scope guard
        // below (and answers 401 everywhere else, as unauthenticated
        // requests always have).
        const pubMatch =
          (req.method === "GET" &&
            path.match(/^\/v1\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/details$/)) ||
          (req.method === "GET" &&
            path.match(/^\/v1\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(branches|tree|contents|commits|compare|pulls|tags|releases)(\/.*)?$/)) ||
          ((req.method === "GET" || req.method === "HEAD") &&
            path.match(/^\/pages\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/));
        // KILN Papers reads ride the same rule: the list is minted for
        // anyone (the handler filters to public records for anonymous
        // principals); a single paper's record + its resolver are
        // minted only when the paper's repo is public.
        const papersListReq = req.method === "GET" && path === "/v1/papers";
        const papersMatch = req.method === "GET"
          ? path.match(/^\/v1\/papers\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/v\/(\d+))?$/)
          : null;
        const doiMatch = req.method === "GET"
          ? path.match(/^\/doi\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/v\/(\d+))?$/)
          : null;
        if (gitList || gitRead || papersListReq ||
            (pubMatch && repoVisibility(dir, pubMatch[1], pubMatch[2]) === "public") ||
            (papersMatch && repoVisibility(dir, papersMatch[1], papersMatch[2]) === "public") ||
            (doiMatch && repoVisibility(dir, doiMatch[1], doiMatch[2]) === "public")) {
          principal = { kind: "anonymous" };
        } else {
          return unauthorized(res);
        }
      }
      // Git pushes stay operator-only in this slice: account and agent
      // tokens are API principals, not git credentials (yet).
      if (gitReceive && principal.kind !== "operator") {
        return unauthorized(res);
      }

      // ---- git reads: held above, served now that a principal exists ----
      // Operator reads everything. Account/agent principals read only
      // their own owner namespace — "only our accounts see it", with the
      // account boundary as the wall (403, self-describing, otherwise).
      const gitScopeDenied = (owner) =>
        principal.kind !== "operator" && principal.account?.owner !== owner;
      const gitScopeError = (owner) => ({
        error: `account principals may read only their own namespace ("${principal.account?.owner}") — "${owner}" is not yours`,
      });
      if (gitList) {
        const all = listRepos(dir);
        return send(res, 200, {
          repos: principal.kind === "operator"
            ? all
            : all.filter((r) =>
                r.owner === principal.account?.owner ||
                repoVisibility(dir, r.owner, r.repo) === "public"),
        });
      }
      if (ciRoute) {
        const { owner, repo, which, sha } = ciRoute;
        if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
          return send(res, 404, { error: "no such repo" });
        }
        if (gitScopeDenied(owner)) return send(res, 403, gitScopeError(owner));
        if (which === "log") {
          const text = sha ? readLog(dir, owner, repo, sha) : null;
          if (text === null) return send(res, 404, { error: "no CI log" });
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
          return;
        }
        const doc = which === "status"
          ? (sha ? readResult(dir, owner, repo, sha) : null)
          : readLatest(dir, owner, repo, url.searchParams.get("branch") || undefined);
        if (!doc) return send(res, 404, { error: "no CI result" });
        return send(res, 200, doc);
      }
      if (gitRead) {
        // Public repos clone/fetch for anyone, exactly like public
        // GitHub; private repos keep the accounts-only wall
        // byte-identically (anonymous 401 below, non-owner account 403).
        const isPublic = repoVisibility(dir, gitRead.owner, gitRead.repo) === "public";
        if (principal.kind === "anonymous") {
          if (!isPublic) return unauthorized(res);
        } else if (gitScopeDenied(gitRead.owner) && !isPublic) {
          return send(res, 403, gitScopeError(gitRead.owner));
        }
        await serveGitHttp(dir, req, res);
        return;
      }

      // ---- accounts: self routes ----
      if (req.method === "GET" && path === "/v1/accounts/me") {
        if (principal.kind === "operator") {
          return send(res, 403, { error: "the operator token is not an account — /v1/accounts/me is for account sessions and agent tokens" });
        }
        return send(res, 200, {
          ok: true,
          account: accountPublic(principal.account),
          principal: principal.kind === "agent"
            ? { kind: "agent", agent: agentPublic(principal.agent) }
            : { kind: "session" },
          // The sponsor link, readable by BOTH sides (ORGS-DESIGN §4:
          // visibility, never control): an agent account sees its
          // sponsor here; any account sees the agent accounts it
          // sponsors (the child's public shape — never its private
          // anything).
          sponsor: sponsorOf(dir, principal.account),
          sponsoredAgents: listSponsoredAgentAccounts(dir, principal.account.id),
          // The restore surface: a fresh browser signs in and renders
          // "wallet 0x… is linked to this account — restore" from this
          // list (hasBackup says the encrypted backup exists) instead
          // of offering to generate a brand-new wallet.
          wallets: listWallets(dir, principal.account.id),
          hasWalletBackup: !!getWalletBackup(dir, principal.account.id),
        });
      }

      // ---- account email binding: PUT /v1/accounts/me/email ----
      // An identity act like agent management: the account's SESSION
      // only. The address is stored exclusively as an encrypted
      // binding (lib/emailcrypto.mjs); the response carries the
      // masked account shape — the full address never comes back.
      if (path === "/v1/accounts/me/email") {
        if (principal.kind === "operator") {
          return send(res, 403, { error: "the operator token is not an account — email binds to accounts; sign in with the account" });
        }
        if (principal.kind === "anonymous") return unauthorized(res);
        if (req.method !== "PUT") return send(res, 404, { error: "not found" });
        if (principal.kind !== "session") {
          return send(res, 403, { error: "your account email is managed by the account owner — sign in with the account (a session), not an agent token" });
        }
        try {
          const b = await readBody(req);
          const r = bindAccountEmail(dir, principal.account.id, b.email);
          if (r.bindingChanged) enqueueWelcomeMail(dir, principal.account);
          return send(res, 200, { ok: true, account: r.account });
        } catch (e) {
          if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (path === "/v1/accounts/me/agents" || path.startsWith("/v1/accounts/me/agents/")) {
        if (principal.kind !== "session") {
          return send(res, 403, { error: "agent identities are managed by the account owner — sign in with the account (a session), not an agent token or the operator token" });
        }
        try {
          if (req.method === "POST" && path === "/v1/accounts/me/agents") {
            const b = await readBody(req);
            const r = createAgent(dir, principal.account.id, { name: b.name, scopes: b.scopes });
            // The raw token is shown exactly once, in this response.
            return send(res, 201, { ok: true, agent: r.agent, token: r.token });
          }
          if (req.method === "GET" && path === "/v1/accounts/me/agents") {
            return send(res, 200, { agents: listAgents(dir, principal.account.id) });
          }
          const am = path.match(/^\/v1\/accounts\/me\/agents\/([A-Za-z0-9_.-]+)$/);
          if (req.method === "DELETE" && am) {
            const agent = revokeAgent(dir, principal.account.id, am[1]);
            return send(res, 200, { ok: true, agent });
          }
        } catch (e) {
          if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
          throw e;
        }
        return send(res, 404, { error: "not found" });
      }

      // ---- agent accounts + agent invite links (Lane C) ----
      // Sponsorship acts. Who may sponsor: an account SESSION (its own
      // account sponsors); an agent token whose OWNING account is
      // itself kind "agent" (a sub-agent of an agent — the token IS
      // that account's credential); the OPERATOR naming the sponsor
      // explicitly with sponsorOwner (the operator holds no account).
      // A human account's delegated agent token is refused, exactly
      // like agent management above: sponsorship is an owner act.
      if (path === "/v1/accounts/me/agent-accounts" ||
          path.startsWith("/v1/accounts/me/agent-accounts/") ||
          path === "/v1/accounts/me/agent-invites" ||
          path.startsWith("/v1/accounts/me/agent-invites/")) {
        if (principal.kind === "anonymous") return unauthorized(res);
        let body = null;
        if (req.method === "POST") body = await readBody(req);
        let sponsor = null;
        if (principal.kind === "session") {
          sponsor = principal.account;
        } else if (principal.kind === "agent" && principal.account.kind === "agent") {
          sponsor = principal.account;
        } else if (principal.kind === "agent") {
          return send(res, 403, { error: "agent accounts and invites are sponsored by the account owner — sign in with the account (a session), not an agent token" });
        } else if (principal.kind === "operator") {
          const ownerName = body?.sponsorOwner || url.searchParams.get("sponsorOwner");
          if (!ownerName) {
            return send(res, 400, { error: "the operator token holds no account — name the sponsoring account with sponsorOwner" });
          }
          sponsor = accountByOwner(dir, String(ownerName));
          if (!sponsor) return send(res, 404, { error: `no account with owner "${ownerName}"` });
        }
        try {
          // Sever a sponsor link: DELETE /v1/accounts/me/agent-accounts/:id
          // (:id = the CHILD account id). Either side may sever — the
          // sponsor (resolved above; the operator names it via
          // sponsorOwner) or the child itself (its session, or its own
          // agent token: principal.account IS the child). A caller who
          // is neither side gets 404, like a missing child. Severing
          // keeps the child's account, namespace, and repos — only
          // the visibility link goes (ORGS-DESIGN §4).
          const sam = path.match(/^\/v1\/accounts\/me\/agent-accounts\/([A-Za-z0-9_.-]+)$/);
          if (req.method === "DELETE" && sam) {
            const child = accountPublicById(dir, sam[1]);
            const isSponsorSide = !!child?.sponsor && child.sponsor.accountId === sponsor.id;
            const isChildSide = principal.kind !== "operator" && principal.account.id === sam[1];
            if (!child || !child.sponsor || (!isSponsorSide && !isChildSide)) {
              return send(res, 404, { error: "no sponsored agent account with that id among yours (or no sponsor link to sever)" });
            }
            const account = severSponsorLink(dir, sam[1]);
            return send(res, 200, { ok: true, account });
          }
          if (path === "/v1/accounts/me/agent-accounts") {
            if (req.method === "POST") {
              // Namespace-content reservation mirrors public signup:
              // a namespace carrying forge content but claimed by no
              // account is reserved — only an operator-driven create
              // may claim it.
              if (principal.kind !== "operator" && typeof body.owner === "string" &&
                  !accountByOwner(dir, body.owner)) {
                const hasContent =
                  listRepos(dir).some((r) => r.owner === body.owner) ||
                  listWorkspaces(dir, { owner: body.owner }).length > 0;
                if (hasContent) {
                  throw new AccountsError(409,
                    `the owner namespace "${body.owner}" already has forge content and is reserved — pick another owner, or have the operator claim it`);
                }
              }
              const account = createAgentAccount(dir, sponsor, {
                owner: body.owner, name: body.name, modelLabel: body.modelLabel,
              });
              // The account's first credential, shown exactly once:
              // a token record owned by the agent account itself, so
              // it resolves to the agent account as its own principal.
              const minted = createAgent(dir, account.id, {
                name: account.name, scopes: body.scopes,
              });
              return send(res, 201, { ok: true, account, agent: minted.agent, token: minted.token });
            }
            if (req.method === "GET") {
              return send(res, 200, { accounts: listSponsoredAgentAccounts(dir, sponsor.id) });
            }
          }
          if (path === "/v1/accounts/me/agent-invites") {
            if (req.method === "POST") {
              const r = createAgentInvite(dir, sponsor, { label: body.label });
              // The plaintext token is shown exactly once, in this
              // response; only its sha256 is stored. The sponsor
              // hands the link to the agent out of band — there is no
              // mail path (agent accounts have no email by design).
              return send(res, 201, {
                ok: true, invite: r.invite, token: r.token, tokenShownOnce: true,
                delivery: "hand this token to your agent out of band — the agent redeems it once at POST /v1/agent-invites/:token/redeem; it expires in 7 days",
              });
            }
            if (req.method === "GET") {
              return send(res, 200, { invites: listAgentInvites(dir, sponsor.id) });
            }
          }
          const aim = path.match(/^\/v1\/accounts\/me\/agent-invites\/([A-Za-z0-9_.-]+)$/);
          if (req.method === "DELETE" && aim) {
            const invite = revokeAgentInvite(dir, sponsor.id, aim[1]);
            return send(res, 200, { ok: true, invite });
          }
        } catch (e) {
          if (e instanceof AccountsError || e instanceof AgentInvitesError) {
            return send(res, e.status, { error: e.message });
          }
          throw e;
        }
        return send(res, 404, { error: "not found" });
      }

      // ---- account wallets: identity binding + encrypted backup ----
      // Linking/unlinking and the backup are identity acts: account
      // SESSION only (agent tokens cannot manage who the account IS,
      // same rule as agent management above) — with ONE extension
      // (Lane C): an agent token whose OWNING account is itself kind
      // "agent" IS that account's own credential (an agent account
      // has no human session behind it), so it may manage its OWN
      // wallets/backup. A human account's agent token stays refused.
      // Listing is a read of the caller's own restore surface, open
      // to session + agent. The operator token is not an account and
      // gets the /me answer.
      if (path === "/v1/accounts/me/wallets" || path.startsWith("/v1/accounts/me/wallets/") ||
          path === "/v1/accounts/me/wallets/challenge" ||
          path === "/v1/accounts/me/wallet-backup") {
        if (principal.kind === "operator") {
          return send(res, 403, { error: "the operator token is not an account — wallets bind to accounts; sign in with the account" });
        }
        if (principal.kind === "anonymous") return unauthorized(res);
        const isSelfAgent = principal.kind === "agent" && principal.account.kind === "agent";
        const needSession = () => send(res, 403, {
          error: "wallet linking and the wallet backup are managed by the account owner — sign in with the account (a session), not an agent token",
        });
        try {
          if (req.method === "POST" && path === "/v1/accounts/me/wallets/challenge") {
            if (principal.kind !== "session" && !isSelfAgent) return needSession();
            const b = await readBody(req);
            const c = issueWalletChallenge(dir, principal.account.id, b.address);
            return send(res, 201, { ok: true, ...c });
          }
          if (req.method === "POST" && path === "/v1/accounts/me/wallets") {
            if (principal.kind !== "session" && !isSelfAgent) return needSession();
            const b = await readBody(req);
            const wallet = linkWallet(dir, principal.account.id, {
              address: b.address, kind: b.kind, publicKey: b.publicKey,
              challengeId: b.challengeId, signature: b.signature,
            });
            return send(res, 201, { ok: true, wallet });
          }
          if (req.method === "GET" && path === "/v1/accounts/me/wallets") {
            return send(res, 200, { wallets: listWallets(dir, principal.account.id) });
          }
          const wm = path.match(/^\/v1\/accounts\/me\/wallets\/([A-Za-z0-9_.-]+)$/);
          if (req.method === "DELETE" && wm) {
            if (principal.kind !== "session" && !isSelfAgent) return needSession();
            const wallet = unlinkWallet(dir, principal.account.id, decodeURIComponent(wm[1]));
            return send(res, 200, { ok: true, wallet });
          }
          if (path === "/v1/accounts/me/wallet-backup") {
            if (principal.kind !== "session" && !isSelfAgent) return needSession();
            if (req.method === "PUT") {
              const b = await readBody(req);
              // The blob is opaque client ciphertext — it is stored,
              // never logged, never audited, never echoed anywhere
              // but the owner's own GET below.
              const r = putWalletBackup(dir, principal.account.id, { blob: b.blob, kdf: b.kdf });
              return send(res, 200, { ok: true, ...r });
            }
            if (req.method === "GET") {
              return send(res, 200, { backup: getWalletBackup(dir, principal.account.id) });
            }
          }
        } catch (e) {
          if (e instanceof AccountsError) return send(res, e.status, { error: e.message });
          throw e;
        }
        return send(res, 404, { error: "not found" });
      }

      // ---- my workspace invites: GET /v1/invites/mine ----
      // The invitee's inbox: the pending invites addressed to the
      // session account's bound email, matched by HMAC tag inside
      // lib/invites.mjs. Session only, like acceptance — an invite
      // list belongs to the invited account, never to its agents or
      // to the operator. The response carries NO email field.
      if (path === "/v1/invites/mine") {
        if (req.method !== "GET") return send(res, 404, { error: "not found" });
        if (principal.kind === "anonymous") return unauthorized(res);
        if (principal.kind === "operator") {
          return send(res, 403, { error: "the operator token is not an account — pending invites are listed for the invited account's session" });
        }
        if (principal.kind !== "session") {
          return send(res, 403, { error: "pending invites are listed for the account owner — sign in with the account (a session), not an agent token" });
        }
        return send(res, 200, { invites: listMyInvites(dir, principal.account) });
      }

      // ---- workspace invite acceptance: POST /v1/invites/:token/accept ----
      // The token in the path IS the credential the invite issued;
      // accepting is the invited account's own act — session only.
      {
        const im = path.match(/^\/v1\/invites\/([A-Za-z0-9_.-]+)\/accept$/);
        if (im) {
          if (req.method !== "POST") return send(res, 404, { error: "not found" });
          if (principal.kind === "anonymous") return unauthorized(res);
          if (principal.kind === "operator") {
            return send(res, 403, { error: "the operator token is not an account — invites are accepted by the invited account's session" });
          }
          if (principal.kind !== "session") {
            return send(res, 403, { error: "invites are accepted by the account owner — sign in with the account (a session), not an agent token" });
          }
          try {
            const r = acceptInvite(dir, decodeURIComponent(im[1]), principal.account);
            enqueueWelcomeMail(dir, principal.account, { workspaceName: r.workspace.name });
            return send(res, 200, {
              ok: true, workspace: r.workspace, member: r.member,
              account: r.account, invite: r.invite,
            });
          } catch (e) {
            if (e instanceof InvitesError || e instanceof AccountsError || e instanceof WorkspacesError) {
              return send(res, e.status, { error: e.message });
            }
            throw e;
          }
        }
      }
      if (path === "/v1/invites" || path.startsWith("/v1/invites/")) {
        return send(res, 404, { error: "not found" });
      }

      // ---- repo delete: DELETE /v1/repos/:owner/:repo ----
      // Authorization is stricter than every other forge write, so the
      // matrix lives HERE, ahead of the generic scope guard (whose
      // allow-list governs surfaces, not this): the repo owner's
      // account session, or the operator. Agent tokens can NEVER
      // delete a repo — creation is operator-only by design and
      // deletion stays at least as strict. A non-owner session gets
      // 403; anonymous gets 401 (the auth gate answers unauthenticated
      // requests before this block — a DELETE never mints the
      // anonymous read principal — and the check below keeps that
      // true even if the gate's minting rules ever widen).
      {
        const m = path.match(/^\/v1\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "DELETE" && m) {
          const [, dOwner, dRepo] = m;
          if (principal.kind === "anonymous") return unauthorized(res);
          if (principal.kind === "agent") {
            return send(res, 403, { error: "agent tokens cannot delete repos — deletion requires the repo owner's account session or the operator token" });
          }
          if (principal.kind !== "operator" && principal.account?.owner !== dOwner) {
            return send(res, 403, { error: `account principals may delete only repos under their own owner namespace ("${principal.account?.owner}")` });
          }
          if (!validRepoName(dOwner) || !validRepoName(dRepo)) {
            return send(res, 400, { error: `invalid owner/repo name: ${dOwner}/${dRepo}` });
          }
          if (!repoExists(dir, dOwner, dRepo)) {
            return send(res, 404, { error: `no such repo: ${dOwner}/${dRepo}` });
          }
          const retry = writeRateLimited(principal);
          if (retry) return send(res, 429, { error: "forge write rate limit (120/min per principal) — slow down" }, { "retry-after": String(retry) });
          // Complete removal: forge registry records + stored CI
          // results go with the bare dir (which itself carries the
          // kiln.json details and the memory chain). Workspace/site
          // registries keep their member refs by the codebase's own
          // pattern — their status views render a missing repo as
          // exists:false, and membership is the owner's explicit edit.
          const removed = forgetRepo(dir, dOwner, dRepo);
          removed.paperVersions = forgetPaperRecords(dir, dOwner, dRepo);
          forgetRepoCiResults(dir, dOwner, dRepo);
          deleteRepo(dir, dOwner, dRepo);
          appendAudit(dir, actorOf(principal), "repo.delete", `${dOwner}/${dRepo}`, removed);
          return send(res, 200, { ok: true, owner: dOwner, repo: dRepo, deleted: true });
        }
      }

      // ---- account/agent scope guard ----
      // Non-operator principals may reach only: discovery, workspaces,
      // repo project-details, and their own account routes (handled
      // above). Everything else under the gate is operator-only. Agent
      // tokens additionally need the matching ability in their scopes.
      // Owner-level checks live in the route blocks themselves.
      if (principal.kind !== "operator") {
        // Anonymous principals exist only for public-repo reads (see
        // the auth gate): details GET and forge GETs of public repos.
        // Anything else they touch still answers 401, exactly as
        // unauthenticated requests always have.
        if (principal.kind === "anonymous") {
          const anonRead = (req.method === "GET" && (
            /^\/v1\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/details$/.test(path) ||
            /^\/v1\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(branches|tree|contents|commits|compare|pulls|tags|releases)(\/.*)?$/.test(path) ||
            path === "/v1/papers" ||
            /^\/v1\/papers\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/v\/[0-9]+)?$/.test(path) ||
            /^\/doi\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/v\/[0-9]+)?$/.test(path))) ||
            ((req.method === "GET" || req.method === "HEAD") &&
              /^\/pages\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/.*)?$/.test(path));
          if (!anonRead) return unauthorized(res);
        }
        const forgeRepoRoute = /^\/v1\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(branches|tree|contents|commits|compare|pulls|tags|releases)(\/.*)?$/.test(path);
        const packageRoute = path === "/v1/packages" || path.startsWith("/v1/packages/");
        const repoCreateRoute = req.method === "POST" && path === "/v1/repos";
        const templatesRoute = path === "/v1/templates" || path.startsWith("/v1/templates/");
        const pagesRoute = /^\/pages\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/.*)?$/.test(path);
        const papersRoute = path === "/v1/papers" || /^\/v1\/papers\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/v\/[0-9]+)?$/.test(path);
        const doiRoute = /^\/doi\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/v\/[0-9]+)?$/.test(path);
        const allowed =
          path === "/v1/capabilities" || path === "/v1/openapi.json" ||
          path === "/v1/workspaces" || path.startsWith("/v1/workspaces/") ||
          /^\/v1\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/details$/.test(path) ||
          forgeRepoRoute || packageRoute || repoCreateRoute || templatesRoute || pagesRoute ||
          papersRoute || doiRoute;
        if (!allowed) {
          return send(res, 403, { error: "this surface is operator-only — account and agent tokens cover workspaces, project details, the forge (branches/contents/pulls/releases/packages), repo creation + their creation templates, and their own account routes (see swarm/docs/ACCOUNTS.md)" });
        }
        if (principal.kind === "agent") {
          const ability = path.startsWith("/v1/workspaces") ? "workspaces"
            : (forgeRepoRoute || packageRoute || repoCreateRoute || templatesRoute || pagesRoute || papersRoute || doiRoute) ? "forge"
            : path.startsWith("/v1/repos/") ? "project-details" : null;
          if (ability && !principal.agent.scopes.includes(ability)) {
            return send(res, 403, { error: `this agent token lacks the "${ability}" scope` });
          }
        }
      }

      // Authenticated push path — the token was verified BEFORE the backend
      // runs, so an unauthenticated push never reaches git at all.
      if (gitReceive) {
        // CI: snapshot refs before the receive-pack so we can diff after and
        // enqueue verification for exactly the branches that moved. CI is
        // strictly best-effort — it must never break or slow the push.
        let refsBefore = null;
        try { refsBefore = snapshotRefs(dir, gitReceive.owner, gitReceive.repo); } catch {}
        await serveGitHttp(dir, req, res);
        try {
          const refsAfter = snapshotRefs(dir, gitReceive.owner, gitReceive.repo);
          const cfg = loadRepoConfig(dir);
          const key = `${gitReceive.owner}/${gitReceive.repo}`;
          if (refsBefore && cfg[key] && cfg[key].command) {
            for (const [ref, sha] of Object.entries(refsAfter)) {
              if (!ref.startsWith("refs/heads/")) continue;
              if (refsBefore[ref] !== sha) {
                enqueueCiJob(dir, { owner: gitReceive.owner, repo: gitReceive.repo, ref, sha });
              }
            }
          }
        } catch (e) { plog(`ci enqueue failed (non-fatal): ${e.message}`); }
        return;
      }

      // ---- cross-repo memory recall (phase 6; authenticated) ----
      // Read-time fan-out over every repo chain in the state dir;
      // unverifiable chains are excluded and named in the envelope.
      if (req.method === "GET" && path === "/memory/recall") {
        try {
          const r = recallCrossRepo(dir, url.searchParams.get("q") || "", {
            limit: parseInt(url.searchParams.get("limit") || "10", 10) || 10,
            kinds: (url.searchParams.get("kinds") || "").split(",").filter(Boolean),
            tags: (url.searchParams.get("tags") || "").split(",").filter(Boolean),
            asOf: url.searchParams.get("asOf") || undefined,
            since: url.searchParams.get("since") || undefined,
            until: url.searchParams.get("until") || undefined,
            includeSuperseded: url.searchParams.get("includeSuperseded") === "1",
          });
          return send(res, 200, r);
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      // ---- per-repo memory (authenticated; held from the git block above) ----
      if (memoryRoute) {
        const { owner, repo, rest } = memoryRoute;
        if (!validRepoName(owner) || !validRepoName(repo) || !repoExists(dir, owner, repo)) {
          return send(res, 404, { error: "no such repo" });
        }
        try {
          if (req.method === "POST" && rest === "/memory/episodes") {
            const b = await readBody(req);
            const r = remember(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, commit: r.commit });
          }
          if (req.method === "POST" && rest === "/memory/facts") {
            const b = await readBody(req);
            const r = assertFact(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, fact: r.event, commit: r.commit });
          }
          if (req.method === "POST" && rest === "/memory/supersede") {
            const b = await readBody(req);
            const r = supersedeFact(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, commit: r.commit });
          }
          if (req.method === "POST" && rest === "/memory/links") {
            const b = await readBody(req);
            const r = linkMemories(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, commit: r.commit });
          }
          if (req.method === "POST" && rest === "/memory/core") {
            const b = await readBody(req);
            const r = setCore(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, commit: r.commit });
          }
          if (req.method === "GET" && rest === "/memory/core") {
            return send(res, 200, { core: loadMemory(dir, owner, repo).core });
          }
          if (req.method === "GET" && rest === "/memory/facts") {
            const st = loadMemory(dir, owner, repo);
            const asOf = url.searchParams.get("asOf")
              ? Math.floor(Date.parse(url.searchParams.get("asOf")) / 1000)
              : Math.floor(Date.now() / 1000);
            const facts = factsAt(st, asOf, url.searchParams.get("includeSuperseded") === "1");
            return send(res, 200, { facts });
          }
          if (req.method === "GET" && rest === "/memory/recall") {
            const q = url.searchParams.get("q") || "";
            const r = recall(dir, owner, repo, q, {
              limit: parseInt(url.searchParams.get("limit") || "10", 10) || 10,
              kinds: (url.searchParams.get("kinds") || "").split(",").filter(Boolean),
              tags: (url.searchParams.get("tags") || "").split(",").filter(Boolean),
              asOf: url.searchParams.get("asOf") || undefined,
              includeSuperseded: url.searchParams.get("includeSuperseded") === "1",
            });
            return send(res, 200, r);
          }
          if (req.method === "GET" && rest === "/memory/context") {
            const pack = buildContext(dir, owner, repo, {
              query: url.searchParams.get("q") || undefined,
              budgetTokens: parseInt(url.searchParams.get("budget") || "4000", 10) || 4000,
              asOf: url.searchParams.get("asOf") || undefined,
            });
            return send(res, 200, pack);
          }
          if (req.method === "GET" && rest === "/memory/sit") {
            const brief = agentAwareness(dir, owner, repo, {
              query: url.searchParams.get("q") || undefined,
              budgetTokens: parseInt(url.searchParams.get("budget") || "1200", 10) || 1200,
              asOf: url.searchParams.get("asOf") || undefined,
            });
            return send(res, 200, brief);
          }
          if (req.method === "POST" && rest === "/memory/propose") {
            const b = await readBody(req);
            const r = proposeMemory(dir, owner, repo, b);
            return send(res, 201, { ok: true, event: r.event, proposal: r.event, commit: r.commit });
          }
          if (req.method === "GET" && rest === "/memory/proposals") {
            const st = loadMemory(dir, owner, repo);
            const want = url.searchParams.get("status");
            const proposals = want ? st.proposals.filter((x) => x.status === want) : st.proposals;
            return send(res, 200, { proposals });
          }
          if (req.method === "POST" && rest === "/memory/proposals/resolve") {
            const b = await readBody(req);
            const r = resolveProposal(dir, owner, repo, b);
            return send(res, 200, { ok: true, proposal: r.proposal, decision: r.decision, materialized: r.materialized, statusEvent: r.statusEvent, commit: r.commit });
          }
          if (req.method === "GET" && rest === "/memory/stats") {
            return send(res, 200, memoryStats(dir, owner, repo));
          }
          if (req.method === "POST" && rest === "/memory/verify") {
            return send(res, 200, verifyMemory(dir, owner, repo));
          }
          if (req.method === "GET" && rest === "/memory/pubkey") {
            // Phase 2 discovery: the state dir's memory signing key
            // (public half) + this repo's signature posture. Creates
            // the key on first use, like a first write would.
            const pub = memorySigningPubkey(dir, { create: true });
            const st = loadMemory(dir, owner, repo);
            return send(res, 200, { ...pub, repo: `${owner}/${repo}`, signatures: signatureSummary(st.events) });
          }
          return send(res, 404, { error: "not found" });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      // ---- git repo create ----
      {
        const m = path.match(/^\/git\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "POST" && m) {
          try {
            // The initial commit is authored by the creating principal
            // (in practice the operator — creation is operator-only
            // under the scope guard; the actor plumbing keeps the
            // authorship truthful if that ever widens).
            const actor = actorOf(principal);
            const r = createRepo(dir, m[1], m[2], { author: { name: actor.name, email: actor.email } });
            return send(res, 201, {
              ok: true,
              owner: r.owner,
              repo: r.repo,
              cloneUrl: `http://127.0.0.1:${apiPort}/git/${r.owner}/${r.repo}`,
              initialCommit: r.initialCommit,
            });
          } catch (e) {
            if (e.code === "EXISTS") return send(res, 409, { error: e.message });
            return send(res, 400, { error: e.message });
          }
        }
      }

      // ---- Context Fabric: authenticated, node-bound local repository cognition ----
      {
        const m = path.match(/^\/v1\/context\/nodes\/([A-Za-z0-9_.-]+)\/(index|query|sit|status)$/);
        if (m) {
          let bound;
          try { bound = resolveContextNode(dir, m[1]); }
          catch (e) { return send(res, 404, { error: e.message }); }
          const action = m[2];
          const idxDir = contextIndexDir(dir);

          if (req.method === "POST" && action === "index") {
            const b = await readBody(req);
            const index = buildContextIndex(bound.node.workdir, idxDir, {
              chunkLines: b.chunkLines,
              overlap: b.overlap,
            });
            const receipt = appendContextReceipt(dir, {
              operation: "api-index",
              node: bound.id,
              indexDigest: index.digest,
              revision: index.revision,
              worktreeDigest: index.worktreeDigest,
            });
            const metric = recordContextMetric(dir, {
              kind: "index",
              indexedBytes: index.stats.indexedBytes,
              reusedFiles: index.stats.reusedFiles,
              rebuiltFiles: index.stats.rebuiltFiles,
            });
            return send(res, 200, {
              node: bound.id,
              receipt,
              metric,
              index: {
                schema: index.schema,
                digest: index.digest,
                revision: index.revision,
                dirty: index.dirty,
                worktreeDigest: index.worktreeDigest,
                generatedAt: index.generatedAt,
                stats: index.stats,
                skipped: index.skipped,
              },
            });
          }

          if (req.method === "POST" && action === "query") {
            const b = await readBody(req);
            let request;
            try { request = boundContextRequest(b, "query"); }
            catch (e) { return send(res, 400, { error: e.message }); }
            const started = Date.now();
            let index = loadIndex(idxDir, bound.node.workdir);
            if (!index || request.refresh) {
              index = buildContextIndex(bound.node.workdir, idxDir, {
                chunkLines: b.chunkLines,
                overlap: b.overlap,
              });
            }
            const pack = queryContextIndex(index, request.query, request);
            const receipt = appendContextReceipt(dir, {
              operation: "api-query",
              node: bound.id,
              query: request.query,
              indexDigest: index.digest,
              packDigest: pack.digest,
              revision: pack.revision,
              worktreeDigest: pack.worktreeDigest,
              emittedBytes: pack.stats.emittedBytes,
              emittedChunks: pack.stats.emittedChunks,
              unchangedChunks: pack.stats.unchangedChunks,
            });
            const metric = recordContextMetric(dir, {
              kind: "query",
              packDigest: pack.digest,
              stats: pack.stats,
              reusedFiles: index.stats.reusedFiles,
              rebuiltFiles: index.stats.rebuiltFiles,
              latencyMs: Date.now() - started,
            });
            return send(res, 200, { node: bound.id, receipt, metric, pack });
          }

          if (req.method === "POST" && action === "sit") {
            const b = await readBody(req);
            let request;
            try { request = boundContextRequest(b, "sit"); }
            catch (e) { return send(res, 400, { error: e.message }); }
            const started = Date.now();
            let index = loadIndex(idxDir, bound.node.workdir);
            if (!index || request.refresh) {
              index = buildContextIndex(bound.node.workdir, idxDir, {
                chunkLines: b.chunkLines,
                overlap: b.overlap,
              });
            }
            const code = queryContextIndex(index, request.query, request);
            let memory = { available: false, reason: "node is not attached to a KILN-native repository" };
            const identity = contextNodeRepoIdentity(bound.node.repo);
            if (identity) {
              try {
                memory = {
                  available: true,
                  owner: identity.owner,
                  repo: identity.repo,
                  ...agentAwareness(dir, identity.owner, identity.repo, {
                    query: request.query,
                    budgetTokens: request.memoryTokens,
                  }),
                };
              } catch (e) {
                memory = { available: false, owner: identity.owner, repo: identity.repo, reason: e.message };
              }
            }
            const receipt = appendContextReceipt(dir, {
              operation: "api-sit",
              node: bound.id,
              query: request.query,
              indexDigest: index.digest,
              packDigest: code.digest,
              revision: code.revision,
              worktreeDigest: code.worktreeDigest,
              emittedBytes: code.stats.emittedBytes,
              emittedChunks: code.stats.emittedChunks,
              unchangedChunks: code.stats.unchangedChunks,
            });
            const metric = recordContextMetric(dir, {
              kind: "sit",
              packDigest: code.digest,
              stats: code.stats,
              reusedFiles: index.stats.reusedFiles,
              rebuiltFiles: index.stats.rebuiltFiles,
              latencyMs: Date.now() - started,
            });
            return send(res, 200, {
              node: bound.id,
              receipt,
              metric,
              sit: { schema: "kiln.context-sit.v1", code, memory },
            });
          }

          if (req.method === "GET" && action === "status") {
            const index = loadIndex(idxDir, bound.node.workdir);
            if (!index) return send(res, 404, { error: "context index not built" });
            return send(res, 200, {
              node: bound.id,
              index: {
                digest: index.digest,
                revision: index.revision,
                dirty: index.dirty,
                worktreeDigest: index.worktreeDigest,
                generatedAt: index.generatedAt,
                stats: index.stats,
              },
            });
          }

          return send(res, 405, { error: "method not allowed" });
        }
      }

      if (req.method === "POST" && path === "/v1/context/receipts/verify") {
        const result = verifyContextReceipts(dir);
        return send(res, result.ok ? 200 : 409, result);
      }

      if (req.method === "POST" && path === "/v1/context/gc") {
        return send(res, 200, { gc: pruneContextCas(contextIndexDir(dir)) });
      }

      if (req.method === "GET" && path === "/v1/context/metrics") {
        return send(res, 200, {
          metrics: contextMetricsSummary(loadContextMetrics(dir)),
          limits: contextLimits(),
        });
      }

      // ---- jobs ----
      if (req.method === "POST" && path === "/jobs") {
        const b = await readBody(req);
        if (!b.plan || !Array.isArray(b.plan.steps)) {
          return send(res, 400, { error: "plan.steps[] is required" });
        }
        const job = {
          id: newJobId(),
          name: String(b.name || `job-${Date.now()}`),
          plan: b.plan,
          mind: String(b.mind || "script"),
        };
        if (b.node) job.node = resolveNode(dir, String(b.node));
        if (b.repo) job.repo = String(b.repo);
        appendEvent(dir, "submit", { job });
        return send(res, 201, { id: job.id, name: job.name });
      }
      if (req.method === "GET" && path === "/jobs") {
        const jobs = [...replay(dir).values()].sort((a, b) => a.submittedAt - b.submittedAt);
        return send(res, 200, { jobs });
      }
      {
        const m = path.match(/^\/jobs\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          const job = replay(dir).get(m[1]);
          if (!job) return send(res, 404, { error: "no such job" });
          return send(res, 200, { job });
        }
      }

      // ---- nodes ----
      if (req.method === "POST" && path === "/nodes") {
        const b = await readBody(req);
        if (!b.name) return send(res, 400, { error: "name is required" });
        let caps;
        try { caps = parseCaps(b.caps ?? 15); } catch (e) { return send(res, 400, { error: e.message }); }
        const ttl = parseInt(b.ttlSec ?? 86400, 10);
        if (!(ttl > 0)) return send(res, 400, { error: "ttlSec must be positive seconds" });
        const node = await createNode(dir, {
          name: String(b.name),
          caps,
          expiresAt: nowSec() + ttl,
          repo: b.repo ? String(b.repo) : null,
          mind: String(b.mind || "script"),
          restartPolicy: String(b.policy || "on-failure"),
          maxRestarts: b.maxRestarts ? parseInt(b.maxRestarts, 10) : 3,
        });
        return send(res, 201, { id: node.id, name: node.name });
      }
      if (req.method === "GET" && path === "/nodes") {
        const nodes = listNodeIds(dir).map((id) => nodeView(dir, cfg, loadNode(dir, id)));
        return send(res, 200, { nodes });
      }
      {
        const m = path.match(/^\/nodes\/([A-Za-z0-9_.-]+)\/stop$/);
        if (req.method === "POST" && m) {
          let id;
          try { id = resolveNode(dir, m[1]); } catch { return send(res, 404, { error: "no such node" }); }
          const node = loadNode(dir, id);
          if (node.workerPid && pidAlive(node.workerPid)) {
            try { process.kill(node.workerPid, "SIGTERM"); } catch {}
            node.workerPid = null; node.lastExit = 0; saveNode(dir, node);
          }
          return send(res, 200, { ok: true });
        }
      }
      {
        const m = path.match(/^\/nodes\/([A-Za-z0-9_.-]+)\/logs$/);
        if (req.method === "GET" && m) {
          let id;
          try { id = resolveNode(dir, m[1]); } catch { return send(res, 404, { error: "no such node" }); }
          const stream = url.searchParams.get("stream") === "stderr" ? "stderr.log" : "stdout.log";
          const tail = Math.min(Math.max(parseInt(url.searchParams.get("tail") || "50", 10) || 50, 1), 2000);
          const p = join(nodeDir(dir, id), stream);
          const log = existsSync(p)
            ? readFileSync(p, "utf8").split("\n").slice(-tail).join("\n")
            : "";
          return send(res, 200, { stream: stream.replace(".log", ""), tail, log });
        }
      }

      // ---- receipts ----
      if (req.method === "POST" && path === "/receipts/verify") {
        const b = await readBody(req);
        let ids = listNodeIds(dir);
        if (b.node) {
          try { ids = [resolveNode(dir, String(b.node))]; }
          catch { return send(res, 404, { error: "no such node" }); }
        }
        const results = ids.map((id) => {
          const n = loadNode(dir, id);
          const kp = loadKeypair(loadKeyFile(dir, id));
          const v = verifyReceipts(dir, id, kp);
          return { node: id, name: n.name, ok: v.ok, count: v.count, error: v.error || null };
        });
        return send(res, 200, { results, allOk: results.every((r) => r.ok) });
      }

      // ---- promote: KILN repo -> GitHub (receipt semantics, never throws) ----
      if (req.method === "POST" && path === "/v1/promote") {
        const b = await readBody(req);
        const splitTarget = (s) => {
          if (typeof s !== "string") return null;
          const i = s.indexOf("/");
          if (i <= 0 || i === s.length - 1) return null;
          return [s.slice(0, i), s.slice(i + 1)];
        };
        const repoParts = splitTarget(b.repo);
        if (!repoParts) return send(res, 400, { error: "repo must be 'owner/repo'" });
        let githubOwner, githubRepo;
        if (b.github !== undefined) {
          const ghParts = splitTarget(b.github);
          if (!ghParts) return send(res, 400, { error: "github must be 'owner/repo'" });
          [githubOwner, githubRepo] = ghParts;
        }
        const receipt = await promoteRepo(dir, repoParts[0], repoParts[1], {
          githubOwner,
          githubRepo,
          branch: b.branch ? String(b.branch) : undefined,
          rebase: !!b.rebase,
          force: !!b.force,
          contextEvidence: b.contextEvidence,
        });
        const status = receipt.ok ? 200
          : receipt.error.stage === "repo_not_found" || receipt.error.stage === "github_repo_not_found" ? 404
          : receipt.error.stage === "no_target" || receipt.error.stage === "bad_target" || receipt.error.stage === "bad_evidence" ? 400
          : receipt.error.stage === "not_fast_forward" || receipt.error.stage === "rebase_needs_root" ? 409
          : receipt.error.stage === "no_github_credential" ? 412
          : receipt.error.stage.startsWith("github_") ? 502
          : 500;
        return send(res, status, receipt);
      }

      // ---- compute: serverless functions ----
      if (req.method === "POST" && path === "/v1/compute/invoke") {
        const b = await readBody(req);
        try {
          const { invocationId, jobId } = submitInvocation(dir, {
            name: b.name, code: b.code, args: b.args, timeoutMs: b.timeoutMs,
            memoryMB: b.memoryMB, network: b.network, retries: b.retries,
          });
          if (b.waitMs !== undefined) {
            const w = Number(b.waitMs);
            if (!Number.isFinite(w) || w < 1000 || w > 300000) {
              return send(res, 400, { error: "waitMs must be a number in 1000..300000" });
            }
            return send(res, 200, await waitInvocation(dir, invocationId, w));
          }
          return send(res, 201, { invocationId, jobId, status: "pending" });
        } catch (e) {
          if (e instanceof ComputeError && e.status === 429) {
            return send(res, 429, { error: e.message }, { "retry-after": "2" });
          }
          throw e;
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/invocations\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          return send(res, 200, getInvocation(dir, m[1]));
        }
      }

      // ---- compute: parallel map ----
      if (req.method === "POST" && path === "/v1/compute/map") {
        const b = await readBody(req);
        try {
          const r = submitMap(dir, {
            name: b.name, code: b.code, items: b.items, timeoutMs: b.timeoutMs,
            memoryMB: b.memoryMB, network: b.network, retries: b.retries,
          });
          return send(res, 201, { ...r, count: r.invocationIds.length });
        } catch (e) {
          if (e instanceof ComputeError && e.status === 429) {
            return send(res, 429, { error: e.message }, { "retry-after": "2" });
          }
          throw e;
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/map\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          return send(res, 200, getMap(dir, m[1]));
        }
      }

      // ---- compute: capacity (Little's-law scheduler telemetry) ----
      if (req.method === "GET" && path === "/v1/compute/capacity") {
        return send(res, 200, getCapacity());
      }

      // ---- compute: app hosting ----
      if (req.method === "POST" && path === "/v1/compute/apps") {
        const b = await readBody(req);
        const r = await deployApp(dir, {
          name: b.name, repo: b.repo, command: b.command,
          args: b.args, env: b.env, port: b.port, memoryMB: b.memoryMB,
        });
        if (b.public) {
          // Caffeine-style: public:true auto-enables preview on deploy.
          // Deploy still succeeds privately when the relay isn't configured.
          try {
            const pv = await enablePreview(dir, cfg, r.appId, plog);
            r.previewUrl = pv.previewUrl;
            r.preview = pv.preview;
          } catch (e) {
            r.previewUrl = null;
            r.preview = { enabled: false, url: null, relayPort: null, wanted: true, note: e.message };
          }
        }
        return send(res, 201, r);
      }
      if (req.method === "GET" && path === "/v1/compute/apps") {
        const apps = await listApps(dir);
        return send(res, 200, { apps: apps.map((a) => withPreview(dir, cfg, a)) });
      }
      {
        const m = path.match(/^\/v1\/compute\/apps\/([A-Za-z0-9_.-]+)\/preview$/);
        if (m && req.method === "POST") {
          return send(res, 200, await enablePreview(dir, cfg, m[1], plog));
        }
        if (m && req.method === "DELETE") {
          return send(res, 200, await disablePreview(dir, cfg, m[1], plog));
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/apps\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          return send(res, 200, withPreview(dir, cfg, await appStatus(dir, m[1])));
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/apps\/([A-Za-z0-9_.-]+)\/logs$/);
        if (req.method === "GET" && m) {
          const tail = url.searchParams.has("tail") ? parseInt(url.searchParams.get("tail"), 10) : 100;
          return send(res, 200, appLogs(dir, m[1], Number.isFinite(tail) ? tail : 100));
        }
      }
      {
        const m = path.match(/^\/v1\/compute\/apps\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "DELETE" && m) {
          await teardownPreview(dir, cfg, m[1], plog);
          return send(res, 200, undeployApp(dir, m[1]));
        }
      }

      // ---- sites: frontend repo + backend repo + artifact + compute app ----
      if (req.method === "POST" && path === "/v1/sites") {
        const b = await readBody(req);
        try {
          const site = createSite(dir, {
            name: b.name, frontend: b.frontend, backend: b.backend,
            artifact: b.artifact, computeApp: b.computeApp, actor: "api",
          });
          return send(res, 201, { ok: true, site });
        } catch (e) {
          if (e instanceof SitesError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (req.method === "GET" && path === "/v1/sites") {
        return send(res, 200, { sites: listSites(dir) });
      }
      {
        const m = path.match(/^\/v1\/sites\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          try {
            return send(res, 200, await siteStatus(dir, m[1]));
          } catch (e) {
            if (e instanceof SitesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "DELETE" && m) {
          try {
            return send(res, 200, deleteSite(dir, m[1]));
          } catch (e) {
            if (e instanceof SitesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
      }

      // ---- workspaces: member repos + linked sites under one owner ----
      if (req.method === "POST" && path === "/v1/workspaces") {
        const b = await readBody(req);
        // Owner scoping: account/agent principals create only under
        // their own namespace.
        if (principal.kind !== "operator" && b.owner !== principal.account.owner) {
          return send(res, 403, { error: `account principals may only create workspaces under their own owner namespace ("${principal.account.owner}")` });
        }
        try {
          const workspace = createWorkspace(dir, {
            owner: b.owner, slug: b.slug, name: b.name,
            description: b.description, repos: b.repos, siteIds: b.siteIds,
            parentId: b.parentId,
            actor: "api",
          });
          return send(res, 201, { ok: true, workspace });
        } catch (e) {
          if (e instanceof WorkspacesError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }
      if (req.method === "GET" && path === "/v1/workspaces") {
        // Owner scoping: account/agent principals see their own
        // workspaces PLUS any they belong to as members (the flat
        // list; the tree stays an owner-namespace forest).
        const owner = principal.kind === "operator"
          ? (url.searchParams.get("owner") || undefined)
          : principal.account.owner;
        if (url.searchParams.get("tree") === "1") {
          return send(res, 200, { workspaces: workspaceTree(dir, { owner }) });
        }
        if (principal.kind !== "operator") {
          return send(res, 200, { workspaces: listWorkspacesForAccount(dir, principal.account.owner) });
        }
        return send(res, 200, { workspaces: listWorkspaces(dir, { owner }) });
      }

      // ---- workspace invites: by email, owner/admin only ----
      {
        const m = path.match(/^\/v1\/workspaces\/([A-Za-z0-9_.-]+)\/invites(?:\/([A-Za-z0-9_.-]+))?$/);
        if (m) {
          try {
            const ws = resolveWorkspace(dir, m[1]);
            const role = principal.kind === "operator"
              ? "owner"
              : workspaceRoleFor(dir, ws.id, principal.account.owner);
            if (role !== "owner" && role !== "admin") {
              return send(res, 403, { error: "only the workspace owner or an admin member can manage invites" });
            }
            if (req.method === "POST" && !m[2]) {
              const b = await readBody(req);
              const r = createInvite(dir, ws, {
                email: b.email, role: b.role,
                createdBy: principal.kind === "operator" ? "operator" : principal.account.owner,
              });
              // The invite email goes out through the mailer (queued
              // honestly until a transport is configured); the token
              // below is ALSO the inviter's one out-of-band copy.
              try {
                const binding = inviteBinding(dir, r.invite.id);
                if (binding) {
                  enqueueMail(dir, {
                    kind: "workspace-invite",
                    to: binding,
                    context: {
                      workspaceName: ws.name,
                      inviter: principal.kind === "operator" ? "The workspace owner" : principal.account.owner,
                      role: r.invite.role,
                      expiresAt: r.invite.expiresAt,
                    },
                    secret: r.token,
                  });
                }
              } catch (e) {
                console.error(`mail: invite enqueue failed for workspace ${ws.id}: ${e.message}`);
              }
              // The plaintext token is shown exactly once, in this
              // response; only its sha256 is stored. There is no
              // sender guarantee: `delivery` says how it travels.
              return send(res, 201, {
                ok: true, invite: r.invite, token: r.token, tokenShownOnce: true,
                delivery: "an invite email is queued in the mail outbox (it sends when a transport is configured); you may also hand this token to the invitee out of band — it expires in 7 days and works once",
              });
            }
            if (req.method === "GET" && !m[2]) {
              return send(res, 200, { invites: listInvites(dir, ws.id) });
            }
            if (req.method === "DELETE" && m[2]) {
              const invite = revokeInvite(dir, ws.id, m[2]);
              return send(res, 200, { ok: true, invite });
            }
          } catch (e) {
            if (e instanceof WorkspacesError || e instanceof InvitesError) {
              return send(res, e.status, { error: e.message });
            }
            throw e;
          }
          return send(res, 404, { error: "not found" });
        }
      }
      {
        const m = path.match(/^\/v1\/workspaces\/([A-Za-z0-9_.-]+)$/);
        if (req.method === "GET" && m) {
          try {
            // Read access: the owner, or any account holding a
            // membership (admin/member) — membership is the point of
            // the invite door. Writes below stay owner-only.
            if (principal.kind !== "operator" &&
                !workspaceRoleFor(dir, m[1], principal.account.owner)) {
              return send(res, 403, { error: "this workspace belongs to another account" });
            }
            return send(res, 200, workspaceStatus(dir, m[1]));
          } catch (e) {
            if (e instanceof WorkspacesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "PATCH" && m) {
          const b = await readBody(req);
          try {
            if (principal.kind !== "operator" &&
                resolveWorkspace(dir, m[1]).owner !== principal.account.owner) {
              return send(res, 403, { error: "this workspace belongs to another account" });
            }
            const patch = {
              name: b.name, description: b.description,
              addRepos: b.addRepos, removeRepos: b.removeRepos,
              linkSites: b.linkSites, unlinkSites: b.unlinkSites,
            };
            // setParent is presence-sensitive in the lib (absent =
            // unchanged, null = clear) — only forward it when the body
            // actually carries the key.
            if (Object.prototype.hasOwnProperty.call(b, "setParent")) patch.setParent = b.setParent;
            const workspace = updateWorkspace(dir, m[1], patch, { actor: "api" });
            return send(res, 200, { ok: true, workspace });
          } catch (e) {
            if (e instanceof WorkspacesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "DELETE" && m) {
          const b = await readBody(req);
          try {
            if (principal.kind !== "operator" &&
                resolveWorkspace(dir, m[1]).owner !== principal.account.owner) {
              return send(res, 403, { error: "this workspace belongs to another account" });
            }
            return send(res, 200, deleteWorkspace(dir, m[1], { confirm: b.confirm }));
          } catch (e) {
            if (e instanceof WorkspacesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
      }

      // ---- repo create: POST /v1/repos (canonical, under /v1) ----
      // The POST /git/:owner/:repo route above stays (operator-only,
      // the CLI's door); this is the account-era door: an owner creates
      // under their own namespace with a session or a forge-scoped
      // agent token, the operator anywhere. The optional template
      // scaffolds the born-PR-ready initial commit — LICENSE / README /
      // .gitignore / a saved template's files land IN that commit
      // (lib/templates.mjs), not a follow-up.
      if (req.method === "POST" && path === "/v1/repos") {
        const b = await readBody(req);
        const actor = actorOf(principal);
        try {
          const { owner, repo } = b;
          if (principal.kind !== "operator" && owner !== principal.account?.owner) {
            return send(res, 403, { error: `account principals may create repos only under their own owner namespace ("${principal.account?.owner}")` });
          }
          if (!validRepoName(owner) || !validRepoName(repo)) {
            return send(res, 400, { error: `invalid owner/repo name: ${owner}/${repo}` });
          }
          if (b.description !== undefined && (typeof b.description !== "string" || b.description.length > 1024)) {
            return send(res, 400, { error: "description must be a string of at most 1024 characters" });
          }
          if (b.visibility !== undefined && !["private", "public"].includes(b.visibility)) {
            return send(res, 400, { error: 'visibility must be "private" or "public"' });
          }
          const retry = writeRateLimited(principal);
          if (retry) return send(res, 429, { error: "forge write rate limit (120/min per principal) — slow down" }, { "retry-after": String(retry) });
          let saved = null;
          const spec = b.template || null;
          if (spec && spec.templateId !== undefined && spec.templateId !== null) {
            if (principal.kind === "operator") {
              throw new TemplatesError(400, "templateId names one of your account's saved templates — the operator token has no account; pass the template inline instead");
            }
            saved = getTemplate(dir, principal.account.id, spec.templateId);
            if (!saved) throw new TemplatesError(404, `no such template: ${spec.templateId}`);
          }
          const { files, template } = resolveTemplateFiles({
            owner, repo, description: b.description, spec, saved,
          });
          const r = createRepo(dir, owner, repo, {
            author: { name: actor.name, email: actor.email },
            files,
          });
          if (b.description !== undefined || b.visibility !== undefined) {
            updateRepoDetails(dir, owner, repo, {
              description: b.description, visibility: b.visibility,
            });
          }
          appendAudit(dir, actor, "repo.create", `${owner}/${repo}`, { template, files: files.map((f) => f.path) });
          return send(res, 201, {
            ok: true, owner, repo,
            cloneUrl: `http://127.0.0.1:${apiPort}/git/${owner}/${repo}`,
            initialCommit: r.initialCommit,
            files: files.map((f) => f.path),
            template,
          });
        } catch (e) {
          if (e instanceof TemplatesError || e instanceof RepoDetailsError) {
            return send(res, e.status, { error: e.message });
          }
          if (e.code === "EXISTS") return send(res, 409, { error: e.message });
          return send(res, 400, { error: e.message });
        }
      }

      // ---- creation templates: the caller's own saved templates ----
      // Per-account records (lib/templates.mjs). Sessions and agents
      // manage their own account's; a template id from another account
      // is a 404, never a borrow. The operator token has no account —
      // a 403 says so rather than inventing an operator template book.
      if (path === "/v1/templates" || path.startsWith("/v1/templates/")) {
        if (principal.kind === "anonymous") return unauthorized(res);
        if (principal.kind === "operator") {
          return send(res, 403, { error: "creation templates belong to accounts — sign in with an account session (or use one of its agent tokens) to manage them" });
        }
        const accountId = principal.account.id;
        try {
          if (req.method === "POST" && path === "/v1/templates") {
            const b = await readBody(req);
            const retry = writeRateLimited(principal);
            if (retry) return send(res, 429, { error: "forge write rate limit (120/min per principal) — slow down" }, { "retry-after": String(retry) });
            return send(res, 201, { ok: true, template: createTemplate(dir, accountId, b) });
          }
          if (req.method === "GET" && path === "/v1/templates") {
            return send(res, 200, { templates: listTemplates(dir, accountId) });
          }
          const tm = path.match(/^\/v1\/templates\/([A-Za-z0-9_.-]+)$/);
          if (req.method === "GET" && tm) {
            return send(res, 200, { template: getTemplatePublic(dir, accountId, tm[1]) });
          }
          if (req.method === "DELETE" && tm) {
            const retry = writeRateLimited(principal);
            if (retry) return send(res, 429, { error: "forge write rate limit (120/min per principal) — slow down" }, { "retry-after": String(retry) });
            return send(res, 200, deleteTemplate(dir, accountId, tm[1]));
          }
        } catch (e) {
          if (e instanceof TemplatesError) return send(res, e.status, { error: e.message });
          throw e;
        }
        return send(res, 404, { error: "not found" });
      }

      // ---- project details: live per-repo facts + editable metadata ----
      {
        const m = path.match(/^\/v1\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/details$/);
        if (req.method === "GET" && m) {
          try {
            return send(res, 200, repoDetails(dir, m[1], m[2]));
          } catch (e) {
            if (e instanceof RepoDetailsError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
        if (req.method === "PATCH" && m) {
          const b = await readBody(req);
          // Owner scoping: describing a repo is a write on its namespace.
          if (principal.kind !== "operator" && m[1] !== principal.account.owner) {
            return send(res, 403, { error: "account principals may only describe repos under their own owner namespace" });
          }
          try {
            const details = updateRepoDetails(dir, m[1], m[2], {
              description: b.description, topics: b.topics,
              visibility: b.visibility, pages: b.pages, paper: b.paper,
            });
            return send(res, 200, { ok: true, details });
          } catch (e) {
            if (e instanceof RepoDetailsError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
      }

      // ---- KILN Pages: static serving from the designated ref ----
      // GET|HEAD /pages/:owner/:repo/[...path]. Read-only. The access
      // law is the forge law, byte-identically: a public repo serves
      // anyone (the anonymous principal was minted at the gate only
      // for public repos); a private repo serves its owner's
      // namespace + the operator, anonymous gets 401 and a non-owner
      // account 403 — a private site leaks exactly as much as a
      // private repo: nothing.
      {
        const pm = (req.method === "GET" || req.method === "HEAD")
          ? path.match(/^\/pages\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(\/.*)?$/)
          : null;
        if (pm) {
          const [, pOwner, pRepo, pRest] = pm;
          if (principal.kind !== "operator" && pOwner !== principal.account?.owner) {
            const publicRead = repoVisibility(dir, pOwner, pRepo) === "public";
            if (!publicRead) {
              if (principal.kind === "anonymous") return unauthorized(res);
              return send(res, 403, { error: `account principals may read pages only under their own namespace ("${principal.account?.owner}")` });
            }
          }
          try {
            const plan = planPage(dir, pOwner, pRepo, pRest || "", path);
            if (plan.status === 301) {
              res.writeHead(301, { location: plan.location });
              res.end();
              return;
            }
            res.writeHead(200, {
              "content-type": plan.contentType,
              "content-length": plan.buffer.length,
              "cache-control": "no-cache",
              "x-kiln-pages-sha": plan.commit,
              "x-kiln-pages-path": plan.servedPath,
            });
            res.end(req.method === "HEAD" ? undefined : plan.buffer);
            return;
          } catch (e) {
            if (e instanceof PagesError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
      }

      // ---- forge: branches / contents / commits / pulls / releases ----
      // The GitHub-shaped surface (lib/forge.mjs). Operator = root;
      // account/agent principals are walled to their own namespace,
      // exactly like git reads. The actor writes under its own identity.
      {
        const fm = path.match(/^\/v1\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(branches|tree|contents|commits|compare|pulls|tags|releases|protection)(\/.*)?$/);
        if (fm) {
          const [, fOwner, fRepo, kind, rest] = fm;
          const actor = actorOf(principal);
          try {
            if (principal.kind !== "operator" && fOwner !== principal.account?.owner) {
              // GitHub semantics: a public repo's forge GETs are open
              // to anyone (any account, any agent, anonymous). Writes
              // stay walled to the owner namespace, always — the flip
              // to "public" never loosens a single write.
              const publicRead = req.method === "GET" &&
                repoVisibility(dir, fOwner, fRepo) === "public";
              if (!publicRead) {
                if (principal.kind === "anonymous") return unauthorized(res);
                return send(res, 403, { error: `account principals may use the forge only under their own namespace ("${principal.account.owner}")` });
              }
            }
            if (req.method !== "GET") {
              const retry = writeRateLimited(principal);
              if (retry) return send(res, 429, { error: "forge write rate limit (120/min per principal) — slow down" }, { "retry-after": String(retry) });
            }
            const gd = () => {
              if (!validRepoName(fOwner) || !validRepoName(fRepo) || !repoExists(dir, fOwner, fRepo)) {
                throw new ForgeError(404, `no such repo: ${fOwner}/${fRepo}`);
              }
              return repoPath(dir, fOwner, fRepo);
            };
            if (kind === "branches") {
              if (req.method === "GET" && !rest) return send(res, 200, { branches: listBranches(gd()) });
              if (req.method === "POST" && !rest) {
                const b = await readBody(req);
                const br = createBranch(gd(), b.name, b.from);
                appendAudit(dir, actor, "branch.create", `${fOwner}/${fRepo}:${b.name}`, {});
                return send(res, 201, { ok: true, branch: br });
              }
              // The name arrives percent-encoded from the kit SDK/CLI
              // (encodeURIComponent turns "fix/x" into "fix%2Fx"), so the
              // pattern must admit "%" — without it every slash-named
              // branch delete fell through to the router's 404.
              const bm = (rest || "").match(/^\/([A-Za-z0-9._%/-]+)$/);
              if (req.method === "DELETE" && bm) {
                const branchName = decodeURIComponent(bm[1]);
                const r = deleteBranch(gd(), branchName);
                appendAudit(dir, actor, "branch.delete", `${fOwner}/${fRepo}:${branchName}`, {});
                return send(res, 200, r);
              }
            }
            if (kind === "tree" && req.method === "GET" && !rest) {
              return send(res, 200, readTree(gd(), url.searchParams.get("ref") || undefined, url.searchParams.get("path") || ""));
            }
            if (kind === "contents" && !rest) {
              if (req.method === "GET") {
                const c = readContents(gd(), url.searchParams.get("ref") || undefined, url.searchParams.get("path") || "");
                if (url.searchParams.get("raw") === "1") {
                  res.writeHead(200, { "content-type": "application/octet-stream", "content-length": c.buffer.length, "x-kiln-sha": c.sha });
                  res.end(c.buffer);
                  return;
                }
                return send(res, 200, { path: c.path, ref: c.ref, commit: c.commit, sha: c.sha, size: c.size, encoding: "base64", content: c.buffer.toString("base64") });
              }
              if (req.method === "PUT") {
                const b = await readBody(req);
                const r = writeFile(dir, fOwner, fRepo, actor, {
                  path: b.path, content: b.content, encoding: b.encoding, message: b.message, branch: b.branch, sha: b.sha,
                });
                return send(res, 201, { ok: true, ...r });
              }
              if (req.method === "DELETE") {
                const b = await readBody(req);
                const r = writeFile(dir, fOwner, fRepo, actor, {
                  path: b.path, message: b.message, branch: b.branch, sha: b.sha, deleteFile: true,
                });
                return send(res, 200, { ok: true, ...r });
              }
            }
            if (kind === "commits") {
              if (req.method === "GET" && !rest) {
                return send(res, 200, listCommits(gd(), {
                  ref: url.searchParams.get("ref") || undefined,
                  limit: url.searchParams.get("limit") || undefined,
                  path: url.searchParams.get("path") || undefined,
                }));
              }
              const cm = (rest || "").match(/^\/([0-9a-f]{4,64})$/);
              if (req.method === "GET" && cm) return send(res, 200, getCommit(gd(), cm[1]));
            }
            if (kind === "compare" && req.method === "GET" && !rest) {
              return send(res, 200, compareRefs(gd(), url.searchParams.get("base") || "", url.searchParams.get("head") || ""));
            }
            if (kind === "protection") {
              if (req.method === "GET" && !rest) {
                return send(res, 200, { protection: listBranchProtection(dir, fOwner, fRepo) });
              }
              // Branch names may contain slashes and arrive
              // percent-encoded, same as the branch-delete route.
              const pm2 = (rest || "").match(/^\/([A-Za-z0-9._%/-]+)$/);
              if (pm2) {
                const branchName = decodeURIComponent(pm2[1]);
                if (req.method === "GET") {
                  return send(res, 200, { branch: branchName, rule: getBranchProtection(dir, fOwner, fRepo, branchName) });
                }
                if (req.method === "PUT") {
                  const b = await readBody(req);
                  const rule = setBranchProtection(dir, fOwner, fRepo, actor, branchName, b);
                  return send(res, 200, { ok: true, branch: branchName, rule });
                }
                if (req.method === "DELETE") {
                  const r = deleteBranchProtection(dir, fOwner, fRepo, actor, branchName);
                  return send(res, 200, { ok: true, ...r });
                }
              }
            }
            if (kind === "tags" && req.method === "GET" && !rest) {
              return send(res, 200, { tags: listTags(gd()) });
            }
            if (kind === "releases") {
              if (req.method === "GET" && !rest) return send(res, 200, { releases: listReleases(dir, fOwner, fRepo) });
              if (req.method === "POST" && !rest) {
                const b = await readBody(req);
                // KILN Papers hook: on a paper-designated repo, the
                // manifest at the release commit is validated BEFORE
                // the release exists — an invalid manifest refuses
                // the release whole (400), so a paper version can
                // never be snapshotted from a broken record. After
                // creation, the release is snapshotted and the next
                // version ID assigned (lib/papers.mjs). A snapshot
                // failure after a validated plan is stated on the
                // response, never hidden.
                const paperPlan = repoPaper(dir, fOwner, fRepo).enabled
                  ? planPaperRelease(dir, fOwner, fRepo, { tag: b.tag, target: b.target })
                  : null;
                const rel = createRelease(dir, fOwner, fRepo, actor, { tag: b.tag, name: b.name, notes: b.notes, target: b.target });
                let paperVersion = null;
                let paperError = null;
                if (paperPlan) {
                  try {
                    const v = recordPaperRelease(dir, fOwner, fRepo, actor, rel, paperPlan.manifest);
                    paperVersion = { n: v.n, id: v.id, conceptId: `kiln:${fOwner}/${fRepo}` };
                  } catch (e) {
                    paperError = e.message;
                    appendAudit(dir, actor, "paper.release_failed", `${fOwner}/${fRepo}@${b.tag}`, { error: e.message });
                  }
                }
                return send(res, 201, { ok: true, release: rel, ...(paperPlan ? { paperVersion, paperError } : {}) });
              }
              const rm = (rest || "").match(/^\/([^/]+)$/);
              if (rm) {
                const tag = decodeURIComponent(rm[1]);
                if (req.method === "GET") {
                  const rel = listReleases(dir, fOwner, fRepo).find((r) => r.tag === tag);
                  if (!rel) return send(res, 404, { error: `no such release: ${tag}` });
                  return send(res, 200, { release: rel });
                }
                if (req.method === "PATCH") {
                  const b = await readBody(req);
                  return send(res, 200, { ok: true, release: updateRelease(dir, fOwner, fRepo, actor, tag, { name: b.name, notes: b.notes }) });
                }
                if (req.method === "DELETE") {
                  const b = await readBody(req).catch(() => ({}));
                  return send(res, 200, deleteRelease(dir, fOwner, fRepo, actor, tag, { deleteTag: !!b.deleteTag }));
                }
              }
            }
            if (kind === "pulls") {
              if (req.method === "GET" && !rest) {
                return send(res, 200, { pulls: listPulls(dir, fOwner, fRepo, { state: url.searchParams.get("state") || undefined }) });
              }
              if (req.method === "POST" && !rest) {
                const b = await readBody(req);
                const pull = createPull(dir, fOwner, fRepo, actor, { title: b.title, body: b.body, head: b.head, base: b.base });
                return send(res, 201, { ok: true, pull });
              }
              const pm = (rest || "").match(/^\/(\d+)(\/(comments|reviews|merge))?$/);
              if (pm) {
                const n = parseInt(pm[1], 10);
                const sub = pm[3];
                if (req.method === "GET" && !sub) return send(res, 200, { pull: getPull(dir, fOwner, fRepo, n) });
                if (req.method === "PATCH" && !sub) {
                  const b = await readBody(req);
                  return send(res, 200, { ok: true, pull: updatePull(dir, fOwner, fRepo, actor, n, { title: b.title, body: b.body, state: b.state }) });
                }
                if (req.method === "POST" && sub === "comments") {
                  const b = await readBody(req);
                  return send(res, 201, { ok: true, comment: commentPull(dir, fOwner, fRepo, actor, n, { body: b.body }) });
                }
                if (req.method === "POST" && sub === "reviews") {
                  const b = await readBody(req);
                  return send(res, 201, { ok: true, review: reviewPull(dir, fOwner, fRepo, actor, n, { state: b.state, body: b.body }) });
                }
                if (req.method === "POST" && sub === "merge") {
                  const b = await readBody(req);
                  const r = mergePull(dir, fOwner, fRepo, actor, n, { method: b.method, message: b.message, deleteBranch: b.deleteBranch === true });
                  return send(res, 200, { ok: true, ...r });
                }
              }
            }
          } catch (e) {
            if (e instanceof ForgeError || e instanceof PapersError) return send(res, e.status, { error: e.message });
            throw e;
          }
          return send(res, 404, { error: "not found" });
        }
      }

      // ---- packages: publish / list / resolve / download ----
      {
        const pm = path.match(/^\/v1\/packages(?:\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+)(?:\/([0-9][^/]*)(?:\/([^/]+))?)?)?)?$/);
        if (pm && (path === "/v1/packages" || path.startsWith("/v1/packages/"))) {
          const actor = actorOf(principal);
          const [, pOwner, pName, pVersion, pFile] = pm;
          try {
            if (req.method === "GET" && !pOwner) {
              const owner = principal.kind === "operator"
                ? (url.searchParams.get("owner") || undefined)
                : principal.account.owner;
              return send(res, 200, { packages: listPackages(dir, { owner }) });
            }
            if (pOwner) {
              if (principal.kind !== "operator" && pOwner !== principal.account.owner) {
                return send(res, 403, { error: `account principals may use packages only under their own namespace ("${principal.account.owner}")` });
              }
              if (req.method === "GET" && pOwner && !pName) {
                return send(res, 200, { packages: listPackages(dir, { owner: pOwner }) });
              }
              if (req.method === "GET" && pName && !pVersion) {
                return send(res, 200, { package: getPackage(dir, pOwner, pName) });
              }
              if (req.method === "GET" && pName && pVersion && !pFile) {
                return send(res, 200, getPackageVersion(dir, pOwner, decodeURIComponent(pName), decodeURIComponent(pVersion)));
              }
              if (req.method === "GET" && pName && pVersion && pFile) {
                const { buffer, file } = readPackageFile(dir, pOwner, decodeURIComponent(pName), decodeURIComponent(pVersion), decodeURIComponent(pFile));
                res.writeHead(200, {
                  "content-type": file.contentType,
                  "content-length": buffer.length,
                  "x-kiln-sha256": file.sha256,
                });
                res.end(buffer);
                return;
              }
              if (req.method === "PUT" && pName && pVersion && pFile) {
                const retry = writeRateLimited(principal);
                if (retry) return send(res, 429, { error: "forge write rate limit (120/min per principal) — slow down" }, { "retry-after": String(retry) });
                let buffer;
                try {
                  buffer = await readRawBody(req, PACKAGE_MAX_BYTES);
                } catch (e) {
                  return send(res, 413, { error: e.message });
                }
                const r = publishPackage(dir, actor, pOwner, decodeURIComponent(pName), decodeURIComponent(pVersion), decodeURIComponent(pFile), buffer, {
                  description: url.searchParams.get("description") || undefined,
                  repo: url.searchParams.get("repo") || undefined,
                  contentType: req.headers["content-type"] || undefined,
                });
                return send(res, r.idempotent ? 200 : 201, { ok: true, ...r });
              }
            }
          } catch (e) {
            if (e instanceof PackagesError) return send(res, e.status, { error: e.message });
            throw e;
          }
          return send(res, 404, { error: "not found" });
        }
      }

      // ---- mail outbox (operator only — the scope guard keeps
      // account/agent principals out: /v1/mail is on no allow-list) ----
      if (req.method === "GET" && path === "/v1/mail/outbox") {
        const cfg = transportConfigFromEnv(process.env);
        return send(res, 200, {
          ok: true,
          transport: cfg
            ? { configured: true, kind: cfg.kind }
            : { configured: false, kind: null },
          counts: outboxCounts(dir),
          mail: listOutbox(dir),
        });
      }
      if (req.method === "POST" && path === "/v1/mail/send") {
        try {
          const r = await drainOutbox(dir, {});
          return send(res, 200, { ok: true, ...r });
        } catch (e) {
          if (e instanceof MailerError) return send(res, e.status, { error: e.message });
          throw e;
        }
      }

      // ---- KILN Papers: registry reads + the identifier resolver ----
      // Read-only. The visibility law is the forge law, read LIVE from
      // the paper's repo on every request (never copied into the
      // registry): public → anyone incl. anonymous; private → the
      // owner's namespace + the operator (anonymous 401, other
      // accounts 403). The list filters by the same rule per record.
      {
        const pm = req.method === "GET"
          ? path.match(/^\/v1\/papers\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/v\/(\d+))?$/)
          : null;
        const dm = req.method === "GET"
          ? path.match(/^\/doi\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/v\/(\d+))?$/)
          : null;
        if ((req.method === "GET" && path === "/v1/papers") || pm || dm) {
          const gate = (o, s) => {
            if (principal.kind === "operator") return null;
            if (principal.account?.owner === o) return null;
            if (repoVisibility(dir, o, s) === "public") return null;
            return principal.kind === "anonymous" ? "anon" : "forbid";
          };
          try {
            if (!pm && !dm) {
              const ownerFilter = url.searchParams.get("owner") || undefined;
              const records = listPaperRecords(dir).filter((r) =>
                (!ownerFilter || r.owner === ownerFilter) && gate(r.owner, r.slug) === null);
              return send(res, 200, { papers: records.map((r) => conceptView(dir, r)) });
            }
            const [, o, s, nStr] = pm || dm;
            const g = gate(o, s);
            if (g === "anon") return unauthorized(res);
            if (g === "forbid") {
              return send(res, 403, { error: `paper ${o}/${s} is not public — its records are readable by its owner's namespace and the operator, exactly like its repo` });
            }
            const n = nStr !== undefined ? parseInt(nStr, 10) : undefined;
            if (dm) {
              const plan = planDoiRedirect(dir, o, s, n);
              res.writeHead(302, { location: plan.location });
              res.end();
              return;
            }
            const record = getPaperRecord(dir, o, s);
            if (!record) {
              return send(res, 404, { error: `no paper record for ${o}/${s} — papers are registered at their first release (see swarm/docs/PAPERS-WORKFLOW.md)` });
            }
            if (n !== undefined) {
              const v = getVersionView(dir, record, n);
              if (!v) return send(res, 404, { error: `paper ${o}/${s} has no version ${n} (it has ${record.versions.length})` });
              return send(res, 200, v);
            }
            return send(res, 200, conceptView(dir, record));
          } catch (e) {
            if (e instanceof PapersError) return send(res, e.status, { error: e.message });
            throw e;
          }
        }
      }

      // ---- discovery: capabilities + OpenAPI (bearer-gated, like /v1) ----
      if (req.method === "GET" && path === "/v1/capabilities") {
        return send(res, 200, buildCapabilities());
      }
      if (req.method === "GET" && path === "/v1/openapi.json") {
        return send(res, 200, buildOpenApiDocument());
      }

      return send(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof ComputeError) return send(res, e.status, { error: e.message });
      return send(res, 500, { error: e.message });
    }
  });

  const wanted = process.env.KILN_SWARM_API_PORT !== undefined
    ? parseInt(process.env.KILN_SWARM_API_PORT, 10)
    : (cfg.apiPort ?? 18787); // 0 = ephemeral; ?? keeps 0, || would eat it
  server.on("close", () => { try { previews.stop(); } catch {} });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    // 127.0.0.1 ONLY — the API never binds a public interface.
    server.listen(wanted, "127.0.0.1", () => {
      const port = server.address().port;
      apiPort = port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}
