/**
 * Repo-creation templates — the scaffold that lands IN a new repo's
 * initial commit (the architect's order, 2026-10-31: "when people make
 * repos… ask some template for like licenses and different things, and
 * they able to make their own as well").
 *
 *   POST /v1/repos accepts an optional `template`:
 *     {
 *       license: "MIT" | "Apache-2.0" | "GPL-3.0" | "BSD-3-Clause"
 *              | "none" | "<custom license text>",
 *       licenseText: "<custom license text>",     // unambiguous custom
 *       readme: true | false,                     // scaffold README.md
 *       gitignore: "node" | "python" | "none",    // preset .gitignore
 *       templateId: "tpl_…"                        // one of YOUR saved
 *                                                  // templates (below)
 *     }
 *   A saved user template supplies the defaults; every inline field
 *   present in the request overrides the saved value for that field.
 *   Files the template carries are never overwritten by the license /
 *   readme / gitignore scaffolds — scaffolding fills gaps only.
 *
 *   `license` typing (design call, flagged for overrule): the value is
 *   a built-in id, "none", or — when it is long (>60 chars) or contains
 *   a newline — the custom license text itself. A SHORT unknown string
 *   answers 400 rather than silently becoming a one-word LICENSE file,
 *   because "mit" or "Apach" is a typo, not a license. `licenseText`
 *   always wins when present.
 *
 * User templates are per-account records in <stateDir>/templates.json
 * (atomic write, same discipline as accounts/sites stores):
 *   { id, accountId, name, licenseId, licenseText, readme, gitignore,
 *     files: [{path, content}], createdAt, updatedAt }
 * Routes live in lib/httpapi.mjs under /v1/templates; ownership is
 * enforced there and here (every read/write takes the account id).
 *
 * Built-in license texts are data files in lib/licenses/ (Apache-2.0
 * and GPL-3.0 are the canonical full texts; MIT / BSD-3-Clause carry
 * [year]/[fullname] placeholders, filled with the creation year + the
 * repo owner when no explicit holder is named).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileAtomicSync } from "./state.mjs";
import { validRepoPath } from "./git.mjs";

export class TemplatesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "TemplatesError";
    this.status = status;
  }
}

// ---------------------------------------------------------------- built-ins

export const LICENSE_IDS = ["MIT", "Apache-2.0", "GPL-3.0", "BSD-3-Clause"];
export const GITIGNORE_PRESETS = ["node", "python"];

const licenseCache = new Map();

/**
 * The built-in license text for an id, with the copyright placeholders
 * filled: [year] → creation year, [fullname] → holder (default: the
 * repo owner). Apache's appendix line is filled the same way.
 * Returns null for "none". Throws TemplatesError(400) on unknown ids.
 */
export function licenseText(id, { year, holder } = {}) {
  if (id === "none") return null;
  if (!LICENSE_IDS.includes(id)) {
    throw new TemplatesError(400, `unknown license "${id}" — built-ins: ${LICENSE_IDS.join(", ")}, or "none", or pass licenseText for a custom license`);
  }
  if (!licenseCache.has(id)) {
    licenseCache.set(id, readFileSync(new URL(`./licenses/${id}.txt`, import.meta.url), "utf8"));
  }
  const y = String(year || new Date().getFullYear());
  const h = holder || "the repository owner";
  return licenseCache.get(id)
    .replaceAll("[year]", y)
    .replaceAll("[fullname]", h)
    .replaceAll("[yyyy]", y)
    .replaceAll("[name of copyright owner]", h);
}

const GITIGNORE_TEXTS = {
  node: [
    "# Node",
    "node_modules/",
    "dist/",
    "build/",
    "coverage/",
    "*.log",
    ".env",
    ".env.*",
    "!.env.example",
    ".DS_Store",
    "",
  ].join("\n"),
  python: [
    "# Python",
    "__pycache__/",
    "*.py[cod]",
    ".venv/",
    "venv/",
    "dist/",
    "build/",
    "*.egg-info/",
    ".env",
    ".env.*",
    "!.env.example",
    ".DS_Store",
    "",
  ].join("\n"),
};

export function gitignoreText(preset) {
  if (preset === "none" || preset === undefined || preset === null) return null;
  const text = GITIGNORE_TEXTS[preset];
  if (!text) {
    throw new TemplatesError(400, `unknown gitignore preset "${preset}" — presets: ${GITIGNORE_PRESETS.join(", ")}, or "none"`);
  }
  return text;
}

// ------------------------------------------------------- template resolution

const MAX_TEMPLATE_FILES = 50;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

/** Validate + normalize a files[] array (shared by resolve + store). */
function validateFiles(files, what = "files") {
  if (files === undefined || files === null) return [];
  if (!Array.isArray(files)) throw new TemplatesError(400, `${what} must be an array of {path, content}`);
  if (files.length > MAX_TEMPLATE_FILES) {
    throw new TemplatesError(400, `${what}: at most ${MAX_TEMPLATE_FILES} files per template`);
  }
  const seen = new Set();
  let total = 0;
  return files.map((f) => {
    if (!f || !validRepoPath(f.path)) {
      throw new TemplatesError(400, `${what}: invalid path "${f && f.path}" — clean relative paths only (no leading /, no .., no backslashes)`);
    }
    if (typeof f.content !== "string") {
      throw new TemplatesError(400, `${what}: content for "${f.path}" must be a string`);
    }
    if (Buffer.byteLength(f.content, "utf8") > MAX_FILE_BYTES) {
      throw new TemplatesError(400, `${what}: "${f.path}" exceeds ${MAX_FILE_BYTES} bytes`);
    }
    if (seen.has(f.path)) throw new TemplatesError(400, `${what}: duplicate path "${f.path}"`);
    seen.add(f.path);
    total += Buffer.byteLength(f.content, "utf8");
    if (total > MAX_TOTAL_BYTES) {
      throw new TemplatesError(400, `${what}: total content exceeds ${MAX_TOTAL_BYTES} bytes`);
    }
    return { path: f.path, content: f.content };
  });
}

/**
 * Normalize the license fields of a template spec / saved template into
 * { licenseId, licenseText } — at most one of them non-null.
 */
function normalizeLicense(input, what) {
  let licenseId = null;
  let customText = null;
  if (input.licenseText !== undefined && input.licenseText !== null && input.licenseText !== "") {
    if (typeof input.licenseText !== "string" || input.licenseText.length > 64 * 1024) {
      throw new TemplatesError(400, `${what}: licenseText must be a string of at most 64KB`);
    }
    customText = input.licenseText;
  }
  if (input.license !== undefined && input.license !== null && input.license !== "") {
    if (typeof input.license !== "string") {
      throw new TemplatesError(400, `${what}: license must be a string`);
    }
    if (LICENSE_IDS.includes(input.license)) {
      licenseId = input.license;
    } else if (input.license === "none") {
      licenseId = "none";
    } else if (input.license.length > 60 || input.license.includes("\n")) {
      // A long / multi-line string in `license` IS the custom text.
      if (!customText) customText = input.license;
    } else {
      throw new TemplatesError(400, `${what}: unknown license "${input.license}" — built-ins: ${LICENSE_IDS.join(", ")}, or "none"; for a custom license pass licenseText`);
    }
  }
  if (input.licenseId !== undefined && input.licenseId !== null) {
    if (![...LICENSE_IDS, "none"].includes(input.licenseId)) {
      throw new TemplatesError(400, `${what}: unknown licenseId "${input.licenseId}"`);
    }
    licenseId = input.licenseId;
  }
  return { licenseId, licenseText: customText };
}

/**
 * Resolve a repo-creation template into the initial commit's files.
 *
 *   resolveTemplateFiles({ owner, repo, description, spec, saved })
 *
 * `saved` is the caller's already-fetched user template (or null);
 * `spec` is the request's inline template object (or null/undefined).
 * Inline fields override saved values per-field. The saved template's
 * files are the base; scaffolds (LICENSE, README.md, .gitignore) only
 * ever FILL paths that are not already present.
 * Returns { files: [{path, content}], template: {licenseId, readme, gitignore, savedTemplateId} }.
 */
export function resolveTemplateFiles({ owner, repo, description, spec, saved } = {}) {
  const s = spec || {};
  const base = saved || {};
  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;

  // Files: the saved template's files, verbatim (already validated at
  // save time; re-validated here so a hand-edited store can't smuggle
  // a bad path into a commit).
  const files = validateFiles(base.files, "template files");
  const present = new Set(files.map((f) => f.path));
  const fill = (path, content) => {
    if (content === null || content === undefined || present.has(path)) return;
    files.push({ path, content });
    present.add(path);
  };

  // License: if the inline spec mentions a license at all, it decides
  // the license wholesale; otherwise the saved template's decides.
  const specLic = has(s, "license") || has(s, "licenseText");
  const lic = specLic
    ? normalizeLicense({ license: s.license, licenseText: s.licenseText }, "template")
    : normalizeLicense({ licenseId: base.licenseId, licenseText: base.licenseText }, "template");
  if (lic.licenseText) fill("LICENSE", lic.licenseText);
  else if (lic.licenseId) fill("LICENSE", licenseText(lic.licenseId, { holder: owner }));

  // README: inline flag wins; saved flag otherwise; default off.
  const readme = has(s, "readme") ? !!s.readme : !!base.readme;
  if (readme) {
    const body = description && String(description).trim()
      ? `# ${repo}\n\n${String(description).trim()}\n`
      : `# ${repo}\n`;
    fill("README.md", body);
  }

  // .gitignore: inline preset wins over saved.
  const preset = has(s, "gitignore") ? s.gitignore : base.gitignore;
  if (preset !== undefined && preset !== null && preset !== "") {
    fill(".gitignore", gitignoreText(preset));
  }

  if (files.length > MAX_TEMPLATE_FILES + 3) {
    throw new TemplatesError(400, `template resolves to ${files.length} files — at most ${MAX_TEMPLATE_FILES + 3}`);
  }
  return {
    files,
    template: {
      licenseId: lic.licenseText ? "custom" : lic.licenseId,
      readme,
      gitignore: preset || null,
      savedTemplateId: saved ? saved.id : null,
    },
  };
}

// ---------------------------------------------------------------- user store

function templatesPath(dir) {
  return join(dir, "templates.json");
}

function loadStore(dir) {
  const p = templatesPath(dir);
  if (!existsSync(p)) return { templates: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { templates: s.templates || {} };
  } catch {
    return { templates: {} };
  }
}

function saveStore(dir, store) {
  writeFileAtomicSync(templatesPath(dir), JSON.stringify(store, null, 2) + "\n");
}

/** The shape that may leave the daemon (files included — they are the owner's own content). */
export function templatePublic(t) {
  return {
    id: t.id,
    name: t.name,
    licenseId: t.licenseId,
    licenseText: t.licenseText,
    readme: t.readme,
    gitignore: t.gitignore,
    files: t.files.map((f) => ({ path: f.path, content: f.content })),
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function newTemplateId() {
  return `tpl_${randomBytes(6).toString("hex")}`;
}

/** Validate a create body into stored fields. */
function validateTemplateBody(body, what = "template") {
  const b = body || {};
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120) {
    throw new TemplatesError(400, `${what}: name is required (max 120 chars)`);
  }
  const lic = normalizeLicense(b, what);
  if (b.gitignore !== undefined && b.gitignore !== null && b.gitignore !== "") {
    gitignoreText(b.gitignore); // throws on an unknown preset
  }
  return {
    name: b.name.trim(),
    licenseId: lic.licenseId,
    licenseText: lic.licenseText,
    readme: !!b.readme,
    gitignore: b.gitignore || null,
    files: validateFiles(b.files, `${what} files`),
  };
}

export function createTemplate(dir, accountId, body) {
  const fields = validateTemplateBody(body);
  const store = loadStore(dir);
  const nameLc = fields.name.toLowerCase();
  for (const t of Object.values(store.templates)) {
    if (t.accountId === accountId && t.name.toLowerCase() === nameLc) {
      throw new TemplatesError(409, `you already have a template named "${fields.name}"`);
    }
  }
  const now = new Date().toISOString();
  const t = { id: newTemplateId(), accountId, ...fields, createdAt: now, updatedAt: now };
  store.templates[t.id] = t;
  saveStore(dir, store);
  return templatePublic(t);
}

export function listTemplates(dir, accountId) {
  return Object.values(loadStore(dir).templates)
    .filter((t) => t.accountId === accountId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(templatePublic);
}

/** One of the account's templates, or null — another account's is indistinguishable from missing. */
export function getTemplate(dir, accountId, id) {
  const t = loadStore(dir).templates[id];
  return t && t.accountId === accountId ? t : null;
}

export function getTemplatePublic(dir, accountId, id) {
  const t = getTemplate(dir, accountId, id);
  if (!t) throw new TemplatesError(404, `no such template: ${id}`);
  return templatePublic(t);
}

export function deleteTemplate(dir, accountId, id) {
  const store = loadStore(dir);
  const t = store.templates[id];
  if (!t || t.accountId !== accountId) {
    throw new TemplatesError(404, `no such template: ${id}`);
  }
  delete store.templates[id];
  saveStore(dir, store);
  return { ok: true, id };
}
