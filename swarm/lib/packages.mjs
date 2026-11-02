/**
 * KILN Packages — a versioned package surface over the forge: an agent
 * publishes versioned files under its own owner namespace and any forge
 * principal in scope can list, resolve and download them. Packages are
 * how the agent kit itself ships (and how build artifacts move) without
 * an external registry.
 *
 * Honest scope: this is a publish/list/get store with immutable
 * versions — NOT an npm-protocol registry (no dependency resolution,
 * no tarball semantics beyond "the bytes you published"). Records live
 * in <stateDir>/packages.json (atomic writes, house pattern); blobs are
 * files under <stateDir>/package-blobs/<owner>/<name>/<version>/.
 * Immutability: re-publishing the same version+filename with the same
 * bytes is an idempotent no-op; different bytes answer 409 — a version
 * never silently changes under a consumer.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { writeFileAtomicSync } from "./state.mjs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { appendAudit } from "./forge.mjs";

export class PackagesError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "PackagesError";
    this.status = status;
  }
}

const PACKAGES_FILE = "packages.json";
const NAME_RE = /^[a-z0-9]([a-z0-9-._]{0,62}[a-z0-9])?$/;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const PACKAGE_MAX_BYTES = parseInt(process.env.KILN_PACKAGE_MAX_BYTES || "", 10) || 64 * 1024 * 1024;

function packagesPath(dir) { return join(dir, PACKAGES_FILE); }

function loadStore(dir) {
  const p = packagesPath(dir);
  if (!existsSync(p)) return { packages: {} };
  try {
    const s = JSON.parse(readFileSync(p, "utf8"));
    return { packages: s.packages || {} };
  } catch { return { packages: {} }; }
}

function saveStore(dir, store) {
  writeFileAtomicSync(packagesPath(dir), JSON.stringify(store, null, 2) + "\n");
}

function blobPath(dir, owner, name, version, filename) {
  return join(dir, "package-blobs", owner, name, version, filename);
}

function validName(name) { return typeof name === "string" && NAME_RE.test(name) && !name.includes(".."); }
function validVersion(v) { return typeof v === "string" && VERSION_RE.test(v); }
function validFile(f) { return typeof f === "string" && FILE_RE.test(f) && !f.includes(".."); }

function checkNames(owner, name, version, filename) {
  if (!/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/.test(owner || "")) throw new PackagesError(400, `invalid owner: ${owner}`);
  if (!validName(name)) throw new PackagesError(400, `invalid package name: ${name}`);
  if (version !== undefined && !validVersion(version)) throw new PackagesError(400, `invalid version (want semver, e.g. 1.2.3): ${version}`);
  if (filename !== undefined && !validFile(filename)) throw new PackagesError(400, `invalid filename: ${filename}`);
}

export function publishPackage(dir, actor, owner, name, version, filename, buffer, { description, repo, contentType } = {}) {
  checkNames(owner, name, version, filename);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new PackagesError(400, "an empty package file is not publishable");
  if (buffer.length > PACKAGE_MAX_BYTES) throw new PackagesError(413, `package file too large (${buffer.length} bytes > ${PACKAGE_MAX_BYTES})`);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const store = loadStore(dir);
  const k = `${owner}/${name}`;
  const pkg = store.packages[k] || {
    owner, name, description: description ?? null, repo: repo ?? null,
    createdBy: actor.label, createdAt: new Date().toISOString(), versions: {},
  };
  if (description !== undefined) pkg.description = description;
  if (repo !== undefined) pkg.repo = repo;
  const ver = pkg.versions[version] || { version, createdBy: actor.label, createdAt: new Date().toISOString(), files: {} };
  const existing = ver.files[filename];
  if (existing) {
    if (existing.sha256 !== sha256) {
      throw new PackagesError(409, `${name}@${version}/${filename} already published with different bytes (sha256 ${existing.sha256}) — versions are immutable; publish a new version`);
    }
    return { package: pkgView(pkg), version: ver, file: existing, idempotent: true };
  }
  const bp = blobPath(dir, owner, name, version, filename);
  mkdirSync(join(dir, "package-blobs", owner, name, version), { recursive: true });
  writeFileAtomicSync(bp, buffer);
  const file = { filename, sha256, size: buffer.length, contentType: contentType || "application/octet-stream", publishedBy: actor.label, publishedAt: new Date().toISOString() };
  ver.files[filename] = file;
  pkg.versions[version] = ver;
  pkg.updatedAt = new Date().toISOString();
  store.packages[k] = pkg;
  saveStore(dir, store);
  appendAudit(dir, actor, "package.publish", `${k}@${version}/${filename}`, { sha256, size: buffer.length });
  return { package: pkgView(pkg), version: ver, file, idempotent: false };
}

function pkgView(pkg) {
  const versions = Object.values(pkg.versions || {})
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((v) => ({ version: v.version, createdBy: v.createdBy, createdAt: v.createdAt, files: Object.values(v.files) }));
  return {
    owner: pkg.owner, name: pkg.name, description: pkg.description, repo: pkg.repo,
    createdBy: pkg.createdBy, createdAt: pkg.createdAt, updatedAt: pkg.updatedAt || null,
    versions, latest: versions.length ? versions[versions.length - 1].version : null,
  };
}

export function listPackages(dir, { owner } = {}) {
  const store = loadStore(dir);
  return Object.values(store.packages)
    .filter((p) => !owner || p.owner === owner)
    .map(pkgView)
    .sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
}

export function getPackage(dir, owner, name) {
  checkNames(owner, name);
  const store = loadStore(dir);
  const pkg = store.packages[`${owner}/${name}`];
  if (!pkg) throw new PackagesError(404, `no such package: ${owner}/${name}`);
  return pkgView(pkg);
}

export function getPackageVersion(dir, owner, name, version) {
  checkNames(owner, name, version);
  const store = loadStore(dir);
  const pkg = store.packages[`${owner}/${name}`];
  if (!pkg) throw new PackagesError(404, `no such package: ${owner}/${name}`);
  const ver = pkg.versions[version];
  if (!ver) throw new PackagesError(404, `no such version: ${name}@${version}`);
  return { package: `${owner}/${name}`, version: ver.version, createdBy: ver.createdBy, createdAt: ver.createdAt, files: Object.values(ver.files) };
}

export function readPackageFile(dir, owner, name, version, filename) {
  checkNames(owner, name, version, filename);
  const store = loadStore(dir);
  const pkg = store.packages[`${owner}/${name}`];
  const file = pkg?.versions?.[version]?.files?.[filename];
  if (!file) throw new PackagesError(404, `no such package file: ${owner}/${name}@${version}/${filename}`);
  const bp = blobPath(dir, owner, name, version, filename);
  if (!existsSync(bp)) throw new PackagesError(500, `package record exists but its blob is missing: ${owner}/${name}@${version}/${filename}`);
  const buffer = readFileSync(bp);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  if (sha256 !== file.sha256) throw new PackagesError(500, `package blob failed its sha256 check: ${owner}/${name}@${version}/${filename}`);
  return { buffer, file };
}
