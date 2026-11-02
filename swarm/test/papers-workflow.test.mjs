/**
 * KILN Papers workflow (docs/PAPERS-WORKFLOW.md): manifest validation,
 * designation gating, the release hook (IDs, snapshots, immutability),
 * read API + resolver, the visibility law, and citation generation.
 * Real HTTP API on an ephemeral port, real bare repos, real git — no
 * mocks. Unit blocks pin the validator + citation formats exactly;
 * the HTTP matrix proves the doors for account, agent, and operator
 * principals (the same doors a first-class agent's own account uses).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeStateDir } from "./helpers.mjs";
import { startApiServer } from "../lib/httpapi.mjs";
import { loadApiToken } from "../lib/state.mjs";
import { validateManifest, parseManifest } from "../lib/papermanifest.mjs";
import { buildCitations } from "../lib/papers.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const GOOD = {
  title: "On Testing Papers",
  authors: [{ name: "Alice A.", affiliation: "KILN Test Lab" }],
  abstract: "We test the papers workflow end to end.",
  license: "CC BY 4.0",
  keywords: ["testing", "papers"],
  language: "en",
};

describe("paper.json manifest validation", () => {
  it("accepts a full manifest and normalizes it (keyword dedupe, language kept)", () => {
    const m = validateManifest({ ...GOOD, keywords: ["a", "b", "a"] });
    assert.equal(m.title, GOOD.title);
    assert.deepEqual(m.keywords, ["a", "b"]);
    assert.equal(m.language, "en");
    assert.equal(m.authors[0].affiliation, "KILN Test Lab");
  });

  it("accepts a minimal manifest (abstract may be empty, orcid optional incl. X check digit)", () => {
    const m = validateManifest({
      title: "T", authors: [{ name: "A", orcid: "0000-0002-1825-0097" }, { name: "B", orcid: "0000-0002-1825-009X" }],
      abstract: "", license: "MIT", keywords: [],
    });
    assert.equal(m.abstract, "");
    assert.equal(m.language, undefined);
  });

  it("refuses by field name: every failure names the failing field", () => {
    const cases = [
      [{ ...GOOD, title: "" }, /title/],
      [{ ...GOOD, title: undefined }, /title/],
      [{ authors: GOOD.authors, abstract: "a", license: "L", keywords: [] }, /title/],
      [{ ...GOOD, authors: [] }, /authors/],
      [{ ...GOOD, authors: [{}] }, /authors\[0\]\.name/],
      [{ ...GOOD, authors: [{ name: "A", orcid: "0000-0002-1825" }] }, /orcid/],
      [{ ...GOOD, authors: [{ name: "A", orcid: "orcid.org/0000-0002-1825-0097" }] }, /orcid/],
      [{ ...GOOD, abstract: "x".repeat(20001) }, /abstract/],
      [{ ...GOOD, license: "" }, /license/],
      [{ ...GOOD, keywords: "testing" }, /keywords/],
      [{ ...GOOD, keywords: ["ok", ""] }, /keywords\[1\]/],
      [{ ...GOOD, language: "english" }, /language/],
      [{ ...GOOD, doi: "10.0000/fake" }, /unknown field "doi"/],
      [{ ...GOOD, authors: [{ name: "A", email: "a@x.io" }] }, /unknown field "email"/],
      ["not an object", /must be a JSON object/],
      [[], /must be a JSON object/],
    ];
    for (const [input, pattern] of cases) {
      assert.throws(() => validateManifest(input), (e) => e.status === 400 && pattern.test(e.message),
        `expected a 400 naming ${pattern} for ${JSON.stringify(input).slice(0, 60)}`);
    }
  });

  it("parseManifest refuses non-JSON and non-object JSON", () => {
    assert.throws(() => parseManifest("{nope"), /not valid JSON/);
    assert.throws(() => parseManifest("[1,2]"), /must be a JSON object/);
    assert.deepEqual(parseManifest(JSON.stringify(GOOD)).title, GOOD.title);
  });
});

describe("citation generation", () => {
  it("pins the plain-text and BibTeX formats exactly", () => {
    const c = buildCitations(
      { title: "Deep & Wide {Nets}", authors: [{ name: "Alice A." }, { name: "Bob B." }], abstract: "", license: "MIT", keywords: [] },
      { owner: "alice", slug: "paper1", n: 2, releasedAt: "2026-11-01T12:00:00.000Z" },
    );
    assert.equal(c.text,
      "Alice A., Bob B. (2026). Deep & Wide {Nets}. KILN Papers, version 2. https://kiln.pocketnova.app/doi/alice/paper1/v/2");
    assert.equal(c.bibtex, [
      "@misc{kiln_alice_paper1_v2,",
      "  author = {Alice A. and Bob B.},",
      "  title = {Deep & Wide \\{Nets\\}},",
      "  year = {2026},",
      "  publisher = {KILN Papers},",
      "  version = {2},",
      "  note = {KILN ID kiln:alice/paper1.v2},",
      "  url = {https://kiln.pocketnova.app/doi/alice/paper1/v/2}",
      "}",
    ].join("\n"));
  });

  it("prefers a registered DOI in the text citation when one exists (never in v1 data)", () => {
    const c = buildCitations(GOOD, { owner: "a", slug: "s", n: 1, releasedAt: "2026-01-01T00:00:00.000Z", doi: "10.5281/example.1" });
    assert.match(c.text, /https:\/\/doi\.org\/10\.5281\/example\.1$/);
    assert.match(c.bibtex, /doi = \{10\.5281\/example\.1\}/);
  });
});

describe("KILN Papers: designation → release → registry → resolver", () => {
  let api;
  after(() => { try { api?.server?.close(); } catch { /* already closed */ } });

  it("runs the papers matrix", async () => {
    const dir = makeStateDir();
    process.env.KILN_SWARM_API_PORT = "0";
    try {
      api = await startApiServer(dir, { apiPort: 0 });
    } finally {
      delete process.env.KILN_SWARM_API_PORT;
    }
    const base = api.url;
    const op = loadApiToken(dir);
    const call = async (method, path, body, bearer) => {
      const res = await fetch(base + path, {
        method,
        redirect: "manual",
        headers: {
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data = {};
      try { data = JSON.parse(text || "{}"); } catch { /* raw bodies */ }
      return { status: res.status, text, data, headers: res.headers };
    };
    const put = async (owner, repo, path, content, bearer) => {
      const cur = await call("GET", `/v1/repos/${owner}/${repo}/contents?path=${encodeURIComponent(path)}`, null, bearer);
      const sha = cur.status === 200 ? cur.data.sha : undefined;
      const r = await call("PUT", `/v1/repos/${owner}/${repo}/contents`,
        { path, content, message: `papers test: ${path}`, ...(sha ? { sha } : {}) }, bearer);
      assert.equal(r.status, 201, `PUT ${path}: ${r.text.slice(0, 200)}`);
      return r;
    };
    const year = String(new Date().getFullYear());

    // ---- principals: alice (owner), bob (other account), alice's agents
    const pw = "password-long-1";
    assert.equal((await call("POST", "/v1/accounts", { email: "alice@x.io", name: "Alice", owner: "alice", password: pw })).status, 201);
    assert.equal((await call("POST", "/v1/accounts", { email: "bob@x.io", name: "Bob", owner: "bob", password: pw })).status, 201);
    const alice = (await call("POST", "/v1/accounts/login", { email: "alice@x.io", password: pw })).data.sessionToken;
    const bob = (await call("POST", "/v1/accounts/login", { email: "bob@x.io", password: pw })).data.sessionToken;
    const full = await call("POST", "/v1/accounts/me/agents", { name: "alice-scribe", scopes: ["forge", "project-details"] }, alice);
    assert.equal(full.status, 201, full.text);
    const agent = full.data.token;
    const forgeOnly = (await call("POST", "/v1/accounts/me/agents", { name: "alice-forge", scopes: ["forge"] }, alice)).data.token;
    assert.ok(alice && bob && agent && forgeOnly);

    const details = (repo, bearer) => call("GET", `/v1/repos/alice/${repo}/details`, null, bearer);
    const patch = (repo, body, bearer) => call("PATCH", `/v1/repos/alice/${repo}/details`, body, bearer);

    // ---- the paper repo + its first content
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "paper1" }, alice)).status, 201);
    await put("alice", "paper1", "paper.md", "# On Testing Papers\n\nv1 body\n", alice);

    // default: not designated
    let d = await details("paper1", alice);
    assert.deepEqual(d.data.paper, { enabled: false });

    // ---- designation gates: non-owner 403, anonymous 401, agent without project-details 403
    assert.equal((await patch("paper1", { paper: { enabled: true } }, bob)).status, 403);
    assert.equal((await patch("paper1", { paper: { enabled: true } })).status, 401);
    assert.equal((await patch("paper1", { paper: { enabled: true } }, forgeOnly)).status, 403);

    // ---- enabling without a paper.json: 400 naming the manifest
    let r = await patch("paper1", { paper: { enabled: true } }, alice);
    assert.equal(r.status, 400, r.text);
    assert.match(r.data.error, /paper\.json/);

    // ---- invalid manifests: 400 naming the failing field, designation stays off
    const invalids = [
      [{ ...GOOD, title: "" }, /title/],
      [{ ...GOOD, authors: [{ orcid: "0000-0002-1825-0097" }] }, /authors\[0\]\.name/],
      [{ ...GOOD, authors: [{ name: "A", orcid: "1234" }] }, /orcid/],
      [{ ...GOOD, doi: "10.0000/fake" }, /unknown field "doi"/],
      [{ ...GOOD, keywords: "nope" }, /keywords/],
    ];
    for (const [manifest, pattern] of invalids) {
      await put("alice", "paper1", "paper.json", JSON.stringify(manifest), alice);
      const rr = await patch("paper1", { paper: { enabled: true } }, alice);
      assert.equal(rr.status, 400, `expected 400 for ${pattern}: ${rr.text.slice(0, 160)}`);
      assert.match(rr.data.error, pattern);
      assert.deepEqual((await details("paper1", alice)).data.paper, { enabled: false });
    }
    await put("alice", "paper1", "paper.json", "{broken json", alice);
    r = await patch("paper1", { paper: { enabled: true } }, alice);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /not valid JSON/);

    // ---- valid manifest: designation lands, sibling settings untouched
    await put("alice", "paper1", "paper.json", JSON.stringify(GOOD, null, 2), alice);
    r = await patch("paper1", { paper: { enabled: true } }, alice);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.data.details.paper, { enabled: true });
    assert.deepEqual(r.data.details.pages, { enabled: false, branch: "", path: "" });

    // designated but never released: no record yet
    assert.equal((await call("GET", "/v1/papers/alice/paper1", null, alice)).status, 404);
    assert.equal((await call("GET", "/doi/alice/paper1", null, op)).status, 404);

    // ---- release 1: IDs assigned, snapshot complete, citations generated
    const rel1 = await call("POST", "/v1/repos/alice/paper1/releases", { tag: "v0.9" }, alice);
    assert.equal(rel1.status, 201, rel1.text);
    assert.deepEqual(rel1.data.paperVersion, { n: 1, id: "kiln:alice/paper1.v1", conceptId: "kiln:alice/paper1" });
    assert.equal(rel1.data.paperError, null);

    const concept = await call("GET", "/v1/papers/alice/paper1", null, alice);
    assert.equal(concept.status, 200, concept.text);
    assert.equal(concept.data.id, "kiln:alice/paper1");
    assert.equal(concept.data.doi, null);
    assert.equal(concept.data.resolver, "https://kiln.pocketnova.app/doi/alice/paper1");
    assert.equal(concept.data.pagesUrl, null);
    assert.equal(concept.data.versionCount, 1);
    assert.equal(concept.data.manifest.title, GOOD.title);
    assert.equal(concept.data.versions[0].tag, "v0.9");
    assert.equal(concept.data.versions[0].releasedBy, "account:alice");
    assert.equal(concept.data.versions[0].doi, null);

    const v1 = await call("GET", "/v1/papers/alice/paper1/v/1", null, alice);
    assert.equal(v1.status, 200);
    assert.equal(v1.data.id, "kiln:alice/paper1.v1");
    assert.equal(v1.data.conceptId, "kiln:alice/paper1");
    const files = Object.fromEntries(v1.data.files.map((f) => [f.path, f]));
    assert.equal(files["paper.md"].sha256, sha256("# On Testing Papers\n\nv1 body\n"));
    assert.equal(files["paper.md"].size, "# On Testing Papers\n\nv1 body\n".length);
    assert.ok(files["paper.json"], "manifest file itself is in the snapshot");
    assert.equal(v1.data.citations.text,
      `Alice A. (${year}). On Testing Papers. KILN Papers, version 1. https://kiln.pocketnova.app/doi/alice/paper1/v/1`);
    assert.match(v1.data.citations.bibtex, /@misc\{kiln_alice_paper1_v1,/);
    assert.equal(v1.data.resolver, "https://kiln.pocketnova.app/doi/alice/paper1/v/1");

    // ---- release 2 after edits: sequence continues, v1 snapshot is immutable
    await put("alice", "paper1", "paper.md", "# On Testing Papers\n\nv2 body, revised\n", alice);
    await put("alice", "paper1", "paper.json", JSON.stringify({ ...GOOD, title: "On Testing Papers, Revised" }, null, 2), alice);
    const rel2 = await call("POST", "/v1/repos/alice/paper1/releases", { tag: "v1.0" }, alice);
    assert.equal(rel2.status, 201, rel2.text);
    assert.deepEqual(rel2.data.paperVersion, { n: 2, id: "kiln:alice/paper1.v2", conceptId: "kiln:alice/paper1" });

    const v1After = await call("GET", "/v1/papers/alice/paper1/v/1", null, alice);
    assert.equal(v1After.data.manifest.title, "On Testing Papers", "v1 manifest snapshot is frozen");
    assert.equal(v1After.data.files.find((f) => f.path === "paper.md").sha256,
      sha256("# On Testing Papers\n\nv1 body\n"), "v1 file snapshot is frozen");
    assert.equal(v1After.data.commit, v1.data.commit);
    const v2 = await call("GET", "/v1/papers/alice/paper1/v/2", null, alice);
    assert.equal(v2.data.manifest.title, "On Testing Papers, Revised");
    assert.notEqual(v2.data.commit, v1.data.commit);
    const concept2 = await call("GET", "/v1/papers/alice/paper1", null, alice);
    assert.equal(concept2.data.title, "On Testing Papers, Revised");
    assert.equal(concept2.data.versionCount, 2);
    assert.equal((await call("GET", "/v1/papers/alice/paper1/v/3", null, alice)).status, 404);

    // ---- manifest broken AFTER designation: the release is refused whole
    await put("alice", "paper1", "paper.json", JSON.stringify({ ...GOOD, license: "" }), alice);
    const refused = await call("POST", "/v1/repos/alice/paper1/releases", { tag: "v1.1" }, alice);
    assert.equal(refused.status, 400, refused.text);
    assert.match(refused.data.error, /license/);
    const rels = await call("GET", "/v1/repos/alice/paper1/releases", null, alice);
    assert.ok(!rels.data.releases.some((x) => x.tag === "v1.1"), "no forge release was created for the refused paper release");
    assert.equal((await call("GET", "/v1/papers/alice/paper1", null, alice)).data.versionCount, 2);
    await put("alice", "paper1", "paper.json", JSON.stringify({ ...GOOD, title: "On Testing Papers, Revised" }, null, 2), alice);

    // ---- a release on a NON-designated repo registers nothing
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "plain" }, alice)).status, 201);
    await put("alice", "plain", "paper.md", "not a paper\n", alice);
    const plainRel = await call("POST", "/v1/repos/alice/plain/releases", { tag: "v1" }, alice);
    assert.equal(plainRel.status, 201, plainRel.text);
    assert.ok(!("paperVersion" in plainRel.data), "no paper fields on a non-designated release");
    assert.equal((await call("GET", "/v1/papers/alice/plain", null, alice)).status, 404);

    // ---- visibility law on the records (paper1 is private)
    assert.equal((await call("GET", "/v1/papers/alice/paper1")).status, 401);
    assert.equal((await call("GET", "/v1/papers/alice/paper1", null, bob)).status, 403);
    assert.equal((await call("GET", "/v1/papers/alice/paper1/v/1")).status, 401);
    assert.equal((await call("GET", "/doi/alice/paper1")).status, 401);
    assert.equal((await call("GET", "/doi/alice/paper1", null, bob)).status, 403);
    const anonList = await call("GET", "/v1/papers");
    assert.equal(anonList.status, 200);
    assert.deepEqual(anonList.data.papers, [], "anonymous list shows no private papers");
    const bobList = await call("GET", "/v1/papers", null, bob);
    assert.deepEqual(bobList.data.papers, [], "another account's list shows no private papers");
    const opList = await call("GET", "/v1/papers", null, op);
    assert.deepEqual(opList.data.papers.map((p) => p.id), ["kiln:alice/paper1"]);
    const opFiltered = await call("GET", "/v1/papers?owner=alice", null, op);
    assert.equal(opFiltered.data.papers.length, 1);
    assert.deepEqual((await call("GET", "/v1/papers?owner=bob", null, op)).data.papers, []);
    assert.deepEqual((await call("GET", "/v1/papers?owner=alice")).data.papers, [], "?owner= narrows, never widens");

    // ---- resolver while private (owner/operator): no pages → the API record
    let rr = await call("GET", "/doi/alice/paper1", null, alice);
    assert.equal(rr.status, 302);
    assert.equal(rr.headers.get("location"), "/v1/papers/alice/paper1");
    rr = await call("GET", "/doi/alice/paper1/v/2", null, op);
    assert.equal(rr.status, 302);
    assert.equal(rr.headers.get("location"), "/v1/papers/alice/paper1/v/2");
    assert.equal((await call("GET", "/doi/alice/paper1/v/9", null, op)).status, 404);
    assert.equal((await call("GET", "/doi/alice/ghost", null, op)).status, 404);

    // ---- flip public: anonymous reads + resolves
    const flip = await patch("paper1", { visibility: "public" }, alice);
    assert.equal(flip.status, 200, flip.text);
    assert.equal((await call("GET", "/v1/papers/alice/paper1")).status, 200);
    assert.equal((await call("GET", "/v1/papers/alice/paper1/v/1")).status, 200);
    assert.equal((await call("GET", "/v1/papers/alice/paper1", null, bob)).status, 200);
    assert.deepEqual((await call("GET", "/v1/papers")).data.papers.map((p) => p.id), ["kiln:alice/paper1"]);
    rr = await call("GET", "/doi/alice/paper1");
    assert.equal(rr.status, 302);
    assert.equal(rr.headers.get("location"), "/v1/papers/alice/paper1");

    // ---- pages-designated paper: the resolver prefers the Pages URL
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "sitepaper" }, alice)).status, 201);
    await put("alice", "sitepaper", "site/index.html", "<h1>a sited paper</h1>\n", alice);
    await put("alice", "sitepaper", "paper.json", JSON.stringify({ ...GOOD, title: "A Sited Paper" }), alice);
    assert.equal((await patch("sitepaper", { pages: { enabled: true, path: "site" } }, alice)).status, 200);
    assert.equal((await patch("sitepaper", { paper: { enabled: true } }, alice)).status, 200);
    const siteRel = await call("POST", "/v1/repos/alice/sitepaper/releases", { tag: "v1" }, alice);
    assert.equal(siteRel.status, 201, siteRel.text);
    assert.equal(siteRel.data.paperVersion.id, "kiln:alice/sitepaper.v1");
    const siteConcept = await call("GET", "/v1/papers/alice/sitepaper", null, alice);
    assert.equal(siteConcept.data.pagesUrl, "/pages/alice/sitepaper/");
    rr = await call("GET", "/doi/alice/sitepaper", null, alice);
    assert.equal(rr.status, 302);
    assert.equal(rr.headers.get("location"), "/pages/alice/sitepaper/");

    // ---- the agent door: alice's agent runs the whole flow in her namespace
    assert.equal((await call("POST", "/v1/repos", { owner: "alice", repo: "agentpaper" }, agent)).status, 201);
    await put("alice", "agentpaper", "paper.md", "written by the agent\n", agent);
    await put("alice", "agentpaper", "paper.json", JSON.stringify({ ...GOOD, title: "An Agent Paper", authors: [{ name: "alice-scribe" }] }), agent);
    assert.equal((await patch("agentpaper", { paper: { enabled: true } }, agent)).status, 200);
    const agRel = await call("POST", "/v1/repos/alice/agentpaper/releases", { tag: "v1" }, agent);
    assert.equal(agRel.status, 201, agRel.text);
    assert.equal(agRel.data.paperVersion.id, "kiln:alice/agentpaper.v1");
    const agConcept = await call("GET", "/v1/papers/alice/agentpaper", null, agent);
    assert.equal(agConcept.status, 200);
    assert.equal(agConcept.data.versions[0].releasedBy, "agent:alice/alice-scribe");
    // and the agent cannot designate or release outside its namespace
    assert.equal((await call("POST", "/v1/repos", { owner: "bob", repo: "stolen" }, agent)).status, 403);

    // ---- repo deletion forgets the paper's records
    assert.equal((await call("DELETE", "/v1/repos/alice/agentpaper", { confirm: "agentpaper" }, alice)).status, 200);
    assert.equal((await call("GET", "/v1/papers/alice/agentpaper", null, op)).status, 404);
    const finalList = await call("GET", "/v1/papers", null, op);
    assert.deepEqual(finalList.data.papers.map((p) => p.id).sort(), ["kiln:alice/paper1", "kiln:alice/sitepaper"]);
  });
});
