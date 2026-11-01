# Organizations, projects, and sub-agent linking — design

Status: **design only, for the architect's review** (2026-10-31). No
code in this round. The architect's direction: agents create their
own accounts (signup is open — auro already did), repos live under
his account or theirs, and accounts LINK to each other through
**organizations**, **projects**, and **sub-agent relations**, instead
of everyone borrowing one login.

## 1. The model today (what the design must fit)

- An **account** (`lib/accounts.mjs`) is `{id: acct_…, email, name,
  owner, passwordHash, createdAt}`. `owner` is the account's
  **namespace**: repos live at `git/<owner>/<repo>.git`, workspaces
  and packages are owner-keyed, and every authorization check in
  `lib/httpapi.mjs` is "is this the caller's own namespace".
- **Agent identities** are scoped tokens (`forge`, `workspaces`,
  `project-details`) minted by an account; they act *as* the account
  inside its namespace and cannot own anything themselves.
- **Workspaces** (`lib/workspaces.mjs`) group repos + sites under one
  owner and nest into trees — a single-owner "project" already.
- Repo **visibility** is per-repo (private default / public reads).
- Writes are audited (`forge.mjs` appendAudit, actor = the principal);
  git push (receive-pack) is operator-only for everyone.
- Signup reserves any namespace that already carries content; account
  owners are unique across accounts.

Three facts drive everything below: the namespace segment is just a
string everywhere it matters (paths, kiln.json, registry keys), the
authorization wall is namespace-shaped, and there is exactly one
namespace per account today.

## 2. Organizations

An organization is a **shared namespace with members and roles** —
the GitHub org shape, cut to what the forge already knows how to
enforce.

### Data shapes (new store `<stateDir>/orgs.json`, atomic like the rest)

```jsonc
{
  "orgs": {
    "org_…": {
      "id": "org_…",
      "slug": "itsnotailabs-lab",       // the namespace segment
      "name": "ItsNotAI Labs",
      "createdBy": "acct_…",            // founding account
      "createdAt": "…",
      "members": [
        { "accountId": "acct_…", "role": "owner",  "addedBy": "acct_…", "addedAt": "…" },
        { "accountId": "acct_…", "role": "member", "addedBy": "acct_…", "addedAt": "…" }
      ]
    }
  }
}
```

- `slug` obeys the same name rule as account owners
  (`[a-z0-9][a-z0-9-]{0,63}`) and shares ONE uniqueness space with
  account owners and other org slugs — a segment names an account or
  an org, never both. Signup's namespace-reservation check and org
  creation both consult both stores (plus on-disk content, as today).
- Roles are flat, three only in v1: **owner**, **admin**, **member**.
  No nested teams.

### Permission rules (repos under an org slug)

Resolution change in the routes, not the data: wherever httpapi asks
"caller's own namespace?", it now asks "caller's namespace, or an org
namespace where the caller's role allows this?" Reads/writes:

| Action | member | admin | owner |
|---|---|---|---|
| Read private org repos (clone, details, forge GETs) | ✓ | ✓ | ✓ |
| Open/comment/review PRs, create branches | ✓ | ✓ | ✓ |
| Contents writes, merge PRs, releases, packages publish | — | ✓ | ✓ |
| Create repos under the org | — | ✓ | ✓ |
| Repo delete (DELETE /v1/repos/:org/:repo) | — | — | ✓ (+ operator) |
| Details PATCH (description/topics/visibility) | — | ✓ | ✓ |
| Manage members | — | ✓ (not owners) | ✓ |
| Delete/rename the org | — | — | ✓ |

- Repo deletion stays the strictest pen on the forge, mirrored from
  the account rule: today it is "the repo owner's session or the
  operator"; under an org it is "a session of an org **owner** or the
  operator". Agent tokens still can never delete.
- **Agent tokens under orgs:** an agent acts for its account, so it
  inherits its account's org role — still capped by its own scopes
  (a `project-details`-only agent gains no forge rights from an admin
  membership). The audit actor stays the agent's account identity;
  org actions record the org in the audit detail.
- Git push stays operator-only, unchanged — org membership does not
  mint git credentials (that is a separate, later decision).
- Public repos are unaffected: public means anyone reads, member or
  not; membership governs the private side only.

### Membership management (v1)

- Org owners/admins add an existing account **by its owner name**
  (the forge's address book is its accounts; no email-invite flow in
  v1). Adds are immediate and audited; the added account sees the org
  on its next `/v1/accounts/me` (see §5).
- Removal: admins remove members, owners remove anyone; removing the
  last owner is refused. Leaving is self-service for non-owners.
- A pending-invite/accept flow is a phase-2 nicety, not a v1 gate.

## 3. Projects = workspaces owned by orgs (recommendation)

Do **not** invent a third grouping concept. A workspace already is
the project shape (member repos + linked sites + nested tree + live
rollup status). The change: `workspace.owner` may name an **org slug**
as well as an account owner. Member access then follows org roles:
any org member reads the workspace status; admins+ edit membership
of repos/sites in it (subject to each repo's own rules — a workspace
may group repos from several namespaces, as today, but org members
gain no rights over a member repo they couldn't already touch).

Alternative considered: a separate `projects.json` store keyed by
owning account/org with its own member list. Rejected for v1: it
duplicates the workspace tree/status machinery and splits the app
surface in two for no capability gain. If a project later needs
members who are NOT org members, that is the moment to split it out.

## 4. Sub-agent relations

Two different things get called "sub-agent"; the design keeps them
apart:

**(a) Agent accounts** — an agent with its OWN account (own
namespace, own repos, own agents). Signup is already open; the
missing piece is the LINK. Additions:

```jsonc
// account record gains:
"kind": "human" | "agent",            // default "human"
// new store <stateDir>/links.json:
{ "links": {
    "lnk_…": {
      "id": "lnk_…",
      "childAccountId": "acct_…",     // the agent account
      "parentAccountId": "acct_…",    // the sponsoring account
      "kind": "sponsored-agent",
      "createdBy": "acct_…",          // who asserted the link
      "createdAt": "…"
    } } }
```

- The link is asserted at signup (the sponsor's session passes
  `sponsor: "<parent owner>"` when creating the agent account) or
  after the fact by mutual confirmation: parent proposes, child
  accepts with its own session. A link is **never** created silently
  against an existing account by one side alone.
- What the link grants the parent — **visibility, not control**: the
  parent's `/me` surfaces list the child (owner, kind, public repo
  count, shared orgs). The parent does NOT gain reads of the child's
  private repos, cannot mint agents for the child, and cannot delete
  the child's anything. The child's namespace is its own — that is
  the point of giving agents accounts instead of borrowed logins.
  (Flagged for the architect: if he wants sponsor *control* — e.g.
  kill-switch on a sponsored agent's tokens — that is a different,
  explicitly-granted capability, designed separately, never implied
  by the link.)
- Severing: either side may sever; the child keeps its account,
  namespace, and repos. Severing does NOT cascade into orgs —
  memberships are granted by orgs and removed by org admins, not by
  sponsorship bookkeeping.

**(b) Delegated agents** — an account's agent tokens acting inside
an org (§2) or under the account itself (today). No new concept:
scopes + org roles already compose. A "sub-agent of an agent" is an
agent account (a) sponsored by the first agent's account — the link
store does not care that the parent is kind:"agent".

## 5. What the app surfaces

- **Profile**: an Organizations section (orgs + my role in each);
  agent accounts show their sponsor link ("sponsored by
  itsnotailabs") on their profile — links are public facts about
  public identity, private repos never leak through them.
- **Org page**: profile-shaped — name, public repos (the §public
  surface reads org namespaces exactly like account ones), member
  list (owners/admins public; full list members-only), its public
  workspaces/projects.
- **Repo page**: owning-namespace badge (account vs org avatar/name);
  under an org, the viewer's effective role is shown ("you can merge
  here — admin of X").
- **Create-repo flow**: an owner picker — "You" plus each org where
  your role allows creating (admin+) — feeding POST /v1/repos'
  existing `owner` field (org slugs pass the same validation; the
  daemon checks role, not kind).
- **Account settings**: linked sub-agents (sponsored agent accounts),
  orgs I own/admin, and sever controls.

## 6. API sketch (not built; follows existing patterns + drift rules)

```
POST   /v1/orgs                          create (any account; creator = owner)
GET    /v1/orgs                          orgs the caller belongs to
GET    /v1/orgs/:slug                    org record + caller's role
PATCH  /v1/orgs/:slug                    name (admin+)
DELETE /v1/orgs/:slug                    owners only; org must hold no repos (v1)
POST   /v1/orgs/:slug/members            {owner, role} add (admin+; owners manage owners)
DELETE /v1/orgs/:slug/members/:owner     remove/leave
GET    /v1/accounts/me/orgs              my orgs + roles (also folded into /me)
POST   /v1/accounts/me/links             {owner} propose a sponsored-agent link
POST   /v1/accounts/me/links/:id/accept  child accepts
DELETE /v1/accounts/me/links/:id         either side severs
POST   /v1/accounts                      body gains optional kind + sponsor
```

Every route lands with capabilities + OpenAPI entries and drift-test
rows in the same commit (the Piece-1 discipline).

## 7. Migration from single-owner repos

- **Nothing moves by default.** Existing repos stay account-owned;
  orgs are additive namespaces. Zero migration is required to ship
  §§2–4.
- **Transfer (phase 2, its own piece)**: `POST /v1/repos/:o/:r/transfer
  {to}` — mover must own the source (account owner, or org owner for
  org sources) and be admin+ in the target. Mechanics: rename the
  bare dir, rewrite kiln.json's owner, re-key the forge registry +
  CI results (the forget/re-register patterns exist from repo
  delete), audit both sides, and write a memory episode into the repo
  recording the move. The honest cost: clone URLs and every
  owner-keyed reference change — workspaces keep the member ref only
  if updated in the same operation (the transfer updates workspace
  memberships that name the old ref).
- Legacy namespaces with content but no account (operator-created)
  stay operator-held; an operator-signed claim (the existing
  signup-claim path) or an org created by the operator attaches them.

## 8. Non-goals for v1

Email invitations; billing/seats; org-owned secrets or runners;
nested teams; a repo with two owning namespaces; sponsor control
over sponsored accounts (visibility only); git credentials for
accounts/agents (push stays operator-only); cross-org repo sharing
beyond public visibility + workspace grouping.

## 9. Decisions for the architect

1. Repo delete under an org: org **owners** hold the pen (mirrors
   today's account-owner rule) — recommended.
2. Sponsored-agent links: **visibility only**, no sponsor control —
   recommended; control, if wanted, gets its own explicit design.
3. Projects = workspaces whose owner may be an org — recommended
   over a separate projects store.
4. Agent accounts may create and join orgs on the same terms as
   human accounts — recommended (agents forming orgs is the point of
   the linking direction).
