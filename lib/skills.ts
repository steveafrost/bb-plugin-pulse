/**
 * Picks the skills an "Action with agent" thread should load for a Pulse item,
 * from rules in the plugin settings. Only skills installed on this machine are
 * suggested; the thread is told to read each SKILL.md.
 *
 * Rule format, one per line: `skill-name | why | regex` (case-insensitive,
 * matched against the item's title, detail, url, id and people). A regex of `*`
 * matches every actionable (non-fyi) item. Order is priority; at most 4 apply.
 */
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PulseItem } from "../types";

export interface SkillRef { name: string; path: string; why: string }
export interface SkillRule { name: string; why: string; match: (item: PulseItem, text: string) => boolean }

const ROOTS = [".agents/skills", ".pi/agent/skills", ".claude/skills", ".codex/skills"].map((d) => path.join(homedir(), d));
const MAX = 4;

export function parseSkillRules(text: string, warn: (msg: string) => void = () => {}): SkillRule[] {
  const rules: SkillRule[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [name, why, pattern] = line.split("|").map((s) => s.trim());
    if (!name || !pattern || !/^[\w.-]+$/.test(name)) { warn(`skill rule ignored: ${line.slice(0, 80)}`); continue; }
    if (pattern === "*") { rules.push({ name, why: why ?? "", match: (i) => i.kind !== "fyi" }); continue; }
    try {
      const re = new RegExp(pattern, "i");
      rules.push({ name, why: why ?? "", match: (_i, t) => re.test(t) });
    } catch {
      warn(`skill rule has a bad regex: ${line.slice(0, 80)}`);
    }
  }
  return rules;
}

/**
 * Snapshots run skillsFor for every open item and refetch on every store write, so a run that
 * writes ten items would stat each skill in four roots dozens of times. Installed skills change
 * rarely; a minute-old answer is fine.
 */
const LOCATE_TTL_MS = 60_000;
const located = new Map<string, { at: number; path: string | null }>();
function locate(name: string): string | null {
  const hit = located.get(name);
  if (hit && Date.now() - hit.at < LOCATE_TTL_MS) return hit.path;
  let found: string | null = null;
  for (const root of ROOTS) {
    const p = path.join(root, name, "SKILL.md");
    if (fs.existsSync(p)) { found = p; break; }
  }
  located.set(name, { at: Date.now(), path: found });
  return found;
}

export function skillsFor(item: PulseItem, rules: SkillRule[]): SkillRef[] {
  const text = [item.title, item.detail, item.url, item.id, ...(item.people ?? [])].filter(Boolean).join(" ");
  const out: SkillRef[] = [];
  for (const rule of rules) {
    if (out.length >= MAX) break;
    if (out.some((s) => s.name === rule.name) || !rule.match(item, text)) continue;
    const p = locate(rule.name);
    if (p) out.push({ name: rule.name, path: p, why: rule.why });
  }
  return out;
}
