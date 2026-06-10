import type { Skills } from '../types';
import { getDB } from './idb';

// Web skills live in IDB under store 'skills' (created lazily). Each skill is a
// directory-like blob: a record { files: { [filename]: string } }.

interface SkillRecord {
  files: Record<string, string>;
}

const STORE = 'settings';
const skillKey = (id: string) => `skill:${id}`;

async function loadSkill(id: string): Promise<SkillRecord | null> {
  const db = await getDB();
  return ((await db.get(STORE, skillKey(id))) as SkillRecord | undefined) ?? null;
}

async function saveSkill(id: string, rec: SkillRecord): Promise<void> {
  const db = await getDB();
  await db.put(STORE, rec, skillKey(id));
}

export const skills: Skills = {
  async isInstalled(skillId) {
    return (await loadSkill(skillId)) !== null;
  },
  async listInstalled() {
    const db = await getDB();
    const keys = (await db.getAllKeys(STORE)) as string[];
    return keys
      .filter((k) => typeof k === 'string' && k.startsWith('skill:'))
      .map((k) => k.slice('skill:'.length));
  },
  async saveFile(skillId, fileName, content) {
    const rec = (await loadSkill(skillId)) ?? { files: {} };
    rec.files[fileName] = content;
    await saveSkill(skillId, rec);
  },
  async readFile(skillId, fileName) {
    const rec = await loadSkill(skillId);
    if (!rec || !(fileName in rec.files)) {
      throw new Error(`Skill file not found: ${skillId}/${fileName}`);
    }
    return rec.files[fileName];
  },
  async remove(skillId) {
    const db = await getDB();
    await db.delete(STORE, skillKey(skillId));
  },
  async importZip(_zipPath) {
    throw new Error('Skill ZIP import on web not implemented yet');
  },
  async fetchSkillsSh(pages) {
    // Mirrors the Tauri backend: paginate the all-time leaderboard and remap
    // skillId -> id, source -> topSource for frontend compatibility.
    const pageCount = pages ?? 3;
    const allSkills: unknown[] = [];
    for (let page = 0; page < pageCount; page++) {
      const res = await fetch(`https://skills.sh/api/skills/all-time/${page}`);
      if (!res.ok) throw new Error(`skills.sh fetch failed: ${res.status}`);
      const data = (await res.json()) as {
        skills?: Array<Record<string, unknown>>;
        hasMore?: boolean;
      };
      for (const skill of data.skills ?? []) {
        allSkills.push({
          id: skill.skillId ?? skill.name ?? null,
          name: skill.name ?? null,
          installs: skill.installs ?? 0,
          topSource: skill.source ?? null,
        });
      }
      if (!data.hasMore) break;
    }
    return JSON.stringify({ skills: allSkills, hasMore: false });
  },
  async fetchSkillFile(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`skill file fetch failed: ${res.status}`);
    return res.text();
  },
};
