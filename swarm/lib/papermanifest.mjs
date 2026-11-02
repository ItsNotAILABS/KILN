/**
 * The paper manifest — `paper.json` at a repo's root — and its
 * validator. Deliberately a zero-import pure module: the details
 * layer (designation) and the papers registry (release snapshots)
 * both validate through here, and neither may import the other.
 *
 * The manifest is the paper's bibliographic record — the part other
 * systems will cite — so validation is strict and loud: unknown keys
 * are refused by name (a record cannot carry fields the schema
 * cannot explain), every failure is a ManifestError whose message
 * names the failing field (`paper.json: authors[0].orcid …`), and
 * the normalized result contains exactly the schema's fields.
 *
 * Schema (docs/PAPERS-WORKFLOW.md):
 *   title     required string, 1..512 chars
 *   authors   required array of 1..64 { name (required, 1..200),
 *             orcid? (ORCID iD shape), affiliation? (≤200) }
 *   abstract  required string, ≤ 20000 chars (may be empty: a draft
 *             may be designated before its abstract is final)
 *   license   required string, 1..200 — the author's declared
 *             license name or statement ("CC BY 4.0", "MIT",
 *             "All rights reserved"); KILN records it, never grants it
 *   keywords  required array of ≤32 strings, 1..64 chars each
 *             (may be empty); de-duplicated, order preserved
 *   language  optional BCP-47-shaped tag ("en", "pt-BR")
 */

export const MAX_MANIFEST_BYTES = 64 * 1024;

export class ManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManifestError";
    this.status = 400;
  }
}

const TOP_KEYS = ["title", "authors", "abstract", "license", "keywords", "language"];
const AUTHOR_KEYS = ["name", "orcid", "affiliation"];
const ORCID_RE = /^\d{4}-\d{4}-\d{4}-\d{3}[0-9X]$/;
const LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const MAX_TITLE = 512;
const MAX_AUTHORS = 64;
const MAX_NAME = 200;
const MAX_AFFILIATION = 200;
const MAX_ABSTRACT = 20000;
const MAX_LICENSE = 200;
const MAX_KEYWORDS = 32;
const MAX_KEYWORD = 64;

function fail(detail) {
  throw new ManifestError(`paper.json: ${detail}`);
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function reqString(obj, key, { min = 0, max, where = key } = {}) {
  const v = obj[key];
  if (typeof v !== "string") fail(`${where} is required and must be a string`);
  const t = v.trim();
  if (t.length < min) fail(`${where} must not be empty`);
  if (t.length > max) fail(`${where} is ${t.length} chars — at most ${max}`);
  return t;
}

function optString(obj, key, { max, where = key } = {}) {
  const v = obj[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") fail(`${where} must be a string`);
  const t = v.trim();
  if (t.length > max) fail(`${where} is ${t.length} chars — at most ${max}`);
  return t === "" ? undefined : t;
}

/**
 * Validate + normalize a parsed manifest. Returns the canonical
 * manifest object (schema fields only, strings trimmed). Throws
 * ManifestError naming the failing field.
 */
export function validateManifest(input) {
  if (!isPlainObject(input)) fail("the manifest must be a JSON object");
  for (const k of Object.keys(input)) {
    if (!TOP_KEYS.includes(k)) {
      fail(`unknown field "${k}" — the manifest schema is: ${TOP_KEYS.join(", ")}`);
    }
  }

  const title = reqString(input, "title", { min: 1, max: MAX_TITLE });

  if (!Array.isArray(input.authors)) fail("authors is required and must be an array");
  if (input.authors.length < 1) fail("authors must name at least one author");
  if (input.authors.length > MAX_AUTHORS) fail(`authors has ${input.authors.length} entries — at most ${MAX_AUTHORS}`);
  const authors = input.authors.map((a, i) => {
    const where = `authors[${i}]`;
    if (!isPlainObject(a)) fail(`${where} must be an object {name, orcid?, affiliation?}`);
    for (const k of Object.keys(a)) {
      if (!AUTHOR_KEYS.includes(k)) {
        fail(`${where}: unknown field "${k}" — an author is: ${AUTHOR_KEYS.join(", ")}`);
      }
    }
    const author = { name: reqString(a, "name", { min: 1, max: MAX_NAME, where: `${where}.name` }) };
    if (a.orcid !== undefined && a.orcid !== null) {
      if (typeof a.orcid !== "string" || !ORCID_RE.test(a.orcid.trim())) {
        fail(`${where}.orcid "${a.orcid}" is not a valid ORCID iD (expected 0000-0000-0000-000X)`);
      }
      author.orcid = a.orcid.trim();
    }
    const affiliation = optString(a, "affiliation", { max: MAX_AFFILIATION, where: `${where}.affiliation` });
    if (affiliation !== undefined) author.affiliation = affiliation;
    return author;
  });

  const abstract = reqString(input, "abstract", { min: 0, max: MAX_ABSTRACT });
  const license = reqString(input, "license", { min: 1, max: MAX_LICENSE });

  if (!Array.isArray(input.keywords)) fail("keywords is required and must be an array of strings");
  if (input.keywords.length > MAX_KEYWORDS) fail(`keywords has ${input.keywords.length} entries — at most ${MAX_KEYWORDS}`);
  const keywords = [];
  for (let i = 0; i < input.keywords.length; i++) {
    const kw = input.keywords[i];
    if (typeof kw !== "string") fail(`keywords[${i}] must be a string`);
    const t = kw.trim();
    if (t.length < 1) fail(`keywords[${i}] must not be empty`);
    if (t.length > MAX_KEYWORD) fail(`keywords[${i}] is ${t.length} chars — at most ${MAX_KEYWORD}`);
    if (!keywords.includes(t)) keywords.push(t);
  }

  const manifest = { title, authors, abstract, license, keywords };
  if (input.language !== undefined && input.language !== null) {
    if (typeof input.language !== "string" || !LANGUAGE_RE.test(input.language.trim())) {
      fail(`language "${input.language}" is not a BCP-47-shaped tag (e.g. "en", "pt-BR")`);
    }
    manifest.language = input.language.trim();
  }
  return manifest;
}

/** Parse manifest text (bytes decoded as UTF-8) and validate it. */
export function parseManifest(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    fail(`not valid JSON (${e.message})`);
  }
  return validateManifest(obj);
}
