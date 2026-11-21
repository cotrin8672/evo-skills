import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { loadSkillsFromDir, parseFrontmatter, type SkillFrontmatter } from "@earendil-works/pi-coding-agent";
import { digest, type Data, type Job, type Skill, type Store } from "./store.ts";

const inside = (base: string, path: string) => {
  const rel = relative(base, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
export const skillPath = (root: string, skill: Skill, revision: string) =>
  join(root, "skills", skill.id, "revisions", revision, skill.name, "SKILL.md");
export const visible = (skill: Skill, cwd: string) => skill.scope === "global" || inside(skill.scope, cwd);
const safeId = /^[a-f0-9]{64}$/;

async function copyTree(source: string, target: string, replacement?: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  let count = 0;
  const walk = async (prefix: string) => {
    for (const name of (await readdir(join(source, prefix))).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (name === ".git") throw new Error("A skill directory cannot contain a Git checkout.");
      const path = join(source, rel);
      const stat = await lstat(path);
      if (++count > 1_000 || stat.isSymbolicLink()) throw new Error("Too many entries or a symbolic link in the skill.");
      if (stat.isDirectory()) {
        hash.update(JSON.stringify(["directory", rel]));
        await mkdir(join(target, rel));
        await walk(rel);
      } else if (stat.isFile()) {
        if ((bytes += stat.size) > 16 * 1024 * 1024) throw new Error("Skill directory exceeds 16 MiB.");
        const content = rel === "SKILL.md" && replacement !== undefined ? Buffer.from(replacement) : await readFile(path);
        hash.update(JSON.stringify(["file", rel, stat.mode & 0o111, content.length])).update(content);
        await writeFile(join(target, rel), content, { flag: "wx", mode: 0o600 | (stat.mode & 0o111) });
      } else throw new Error("Skill directories must contain only ordinary files and directories.");
    }
  };
  await mkdir(target);
  await walk("");
  return hash.digest("hex");
}

export async function createRevision(root: string, skill: Skill, from: string, replacement?: string) {
  const revisions = dirname(dirname(dirname(skillPath(root, skill, "base"))));
  await mkdir(revisions, { recursive: true });
  const stage = await mkdtemp(join(revisions, ".pending-"));
  try {
    const hash = await copyTree(dirname(from), join(stage, skill.name), replacement);
    try {
      await rename(stage, join(revisions, hash));
    } catch (error) {
      if (!(await lstat(skillPath(root, skill, hash)).catch(() => undefined))?.isFile()) throw error;
    }
    return hash;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function register(store: Store, path: string, cwd: string, agentDir: string, discovered: readonly { name: string }[]) {
  const original = await realpath(path);
  const global = inside(join(agentDir, "skills"), original);
  if (basename(original) !== "SKILL.md" || inside(store.root, original) ||
      (!global && (!inside(cwd, original) || /(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/i.test(original))))
    throw new Error("Choose a user-owned SKILL.md under this project or the personal skills directory.");
  const initial = await lstat(original);
  if (!initial.isFile() || initial.size > 48 * 1024) throw new Error("Expected a regular SKILL.md no larger than 48 KiB.");
  const name = parseFrontmatter<SkillFrontmatter>(await readFile(original, "utf8")).frontmatter.name;
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || name === "evo-skills")
    throw new Error("Choose a skill with a valid, non-reserved name in its frontmatter.");
  if (discovered.some((item) => item.name === name))
    throw new Error(`Exclude the original skill from Pi discovery and reload first (skills entry: ${JSON.stringify(`-${original}`)}).`);
  const key = process.platform === "win32" ? original.toLowerCase() : original;
  const skill: Skill = { id: digest(key), name, original, scope: global ? "global" : cwd, active: "", checks: [] };
  skill.active = await createRevision(store.root, skill, original);
  const imported = skillPath(store.root, skill, skill.active);
  await validateFiles(imported, name, await readFile(imported, "utf8"));
  return store.update((data) => {
    const previous = data.skills[skill.id];
    if (previous) throw new Error("This skill is already tracked. Its active revision is not overwritten.");
    if (Object.values(data.skills).some((item) => item.id !== skill.id && item.name === name &&
      (item.scope === "global" || skill.scope === "global" || inside(item.scope, skill.scope) || inside(skill.scope, item.scope))))
      throw new Error("A managed skill with this name is already visible in this scope.");
    return (data.skills[skill.id] = skill);
  });
}

export function pins(data: Data, session: string, cwd: string, file?: string, parentFile?: string, fork = false) {
  const key = digest(session);
  const parent = parentFile && data.files[digest(resolve(parentFile))];
  const result = data.pins[key] ??= fork && parent && data.pins[parent]
    ? { ...data.pins[parent] }
    : Object.fromEntries(Object.values(data.skills).filter((skill) => visible(skill, cwd)).map((skill) => [skill.id, skill.active]));
  if (file) data.files[digest(resolve(file))] = key;
  return result;
}

export function adopt(data: Data, job: Job, revision: string) {
  const skill = data.skills[job.skill];
  if (!skill || skill.active !== job.base) { job.state = "stale"; return false; }
  skill.active = revision;
  job.state = "published";
  return true;
}

export async function rollback(store: Store, skill: Skill, revision: string) {
  if (!safeId.test(revision) || !(await lstat(skillPath(store.root, skill, revision)).catch(() => undefined))?.isFile())
    throw new Error("Unknown revision.");
  store.update((data) => {
    if (data.skills[skill.id]?.active !== skill.active) throw new Error("The active revision changed; retry rollback.");
    data.skills[skill.id].active = revision;
  });
}

export async function validateFiles(path: string, name: string, content: string) {
  if (Buffer.byteLength(content) > 48 * 1024 || content.includes("\0")) throw new Error("Invalid SKILL.md size or content.");
  const { frontmatter, body } = parseFrontmatter<SkillFrontmatter>(content);
  if (frontmatter.name !== name || typeof frontmatter.description !== "string" || !frontmatter.description.trim() || frontmatter.description.length > 1024 || !body.trim())
    throw new Error("Invalid skill name, description, or body.");
  const file = dirname(path);
  const links = body.matchAll(/(?:\]\(\s*<?([^)\s>]+)|^\s*\[[^\]]+\]:\s*<?([^\s>]+))/gm);
  for (const link of links) {
    const destination = link[1] ?? link[2];
    if (destination.startsWith("#") || /^https?:\/\//i.test(destination)) continue;
    const target = resolve(file, decodeURIComponent(destination.split("#", 1)[0]));
    if (/^[a-z]+:/i.test(destination) || !inside(file, target) || !inside(file, await realpath(target)))
      throw new Error(`Invalid or external skill reference: ${destination}`);
  }
  const loaded = loadSkillsFromDir({ dir: file, source: "evo-skills" });
  if (!loaded.skills.some((skill) => skill.name === name && resolve(skill.filePath) === resolve(path)) || loaded.diagnostics.length)
    throw new Error("Pi rejected the skill metadata.");
}
