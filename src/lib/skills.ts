/**
 * Skills library integration
 * 
 * Provides access to:
 * 1. Curated skills from onyx-skills repo (recommended)
 * 2. Full skills.sh ecosystem (browse library)
 */

import { platform } from '@platform';

// Skills.sh API types
export interface SkillsShSkill {
  id: string;
  name: string;
  installs: number;
  topSource: string; // Format: "owner/repo"
}

export interface SkillsShResponse {
  skills: SkillsShSkill[];
  hasMore: boolean;
}

// Extended skill info for UI
export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  dependencies?: string[];
  files: string[];
  isCustom?: boolean;
  // skills.sh specific fields
  source?: 'onyx' | 'skillssh';
  installs?: number;
  topSource?: string; // "owner/repo"
}

export interface SkillState {
  enabled: boolean;
  installed: boolean;
  downloading: boolean;
}

// Cache for skills.sh data
interface SkillsShCache {
  data: SkillsShSkill[];
  timestamp: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let skillsShCache: SkillsShCache | null = null;

/**
 * Fetch skills leaderboard from skills.sh API
 * Uses Tauri backend to bypass CORS restrictions
 * Returns cached data if available and not expired
 */
export async function fetchSkillsShLeaderboard(forceRefresh = false): Promise<SkillsShSkill[]> {
  // Check cache
  if (!forceRefresh && skillsShCache && Date.now() - skillsShCache.timestamp < CACHE_TTL_MS) {
    return skillsShCache.data;
  }

  try {
    // Use platform adapter (Tauri backend on native, fetch on web) to bypass CORS
    const responseText = await platform.skills.fetchSkillsSh();
    const data: SkillsShResponse = JSON.parse(responseText);
    
    // Update cache
    skillsShCache = {
      data: data.skills,
      timestamp: Date.now(),
    };

    return data.skills;
  } catch (err) {
    console.error('Failed to fetch skills.sh leaderboard:', err);
    // Return cached data if available, even if expired
    if (skillsShCache) {
      return skillsShCache.data;
    }
    throw err;
  }
}

/**
 * Search/filter skills.sh skills
 */
export function searchSkillsSh(skills: SkillsShSkill[], query: string): SkillsShSkill[] {
  if (!query.trim()) {
    return skills;
  }

  const lowerQuery = query.toLowerCase();
  return skills.filter(skill => 
    skill.id.toLowerCase().includes(lowerQuery) ||
    skill.name.toLowerCase().includes(lowerQuery) ||
    skill.topSource.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Sort skills by different criteria
 */
export type SkillsSortOption = 'popular' | 'name' | 'source';

export function sortSkillsSh(skills: SkillsShSkill[], sortBy: SkillsSortOption): SkillsShSkill[] {
  const sorted = [...skills];
  switch (sortBy) {
    case 'popular':
      return sorted.sort((a, b) => b.installs - a.installs);
    case 'name':
      return sorted.sort((a, b) => a.name.localeCompare(b.name));
    case 'source':
      return sorted.sort((a, b) => a.topSource.localeCompare(b.topSource));
    default:
      return sorted;
  }
}

/**
 * Format install count for display (e.g., 27165 -> "27.2K")
 */
export function formatInstallCount(count: number): string {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}

/**
 * Get GitHub raw URL for a skill file
 * skills.sh skills are stored at: https://raw.githubusercontent.com/{owner}/{repo}/main/skills/{skill-id}/SKILL.md
 */
export function getSkillFileUrl(topSource: string, skillId: string, fileName: string): string {
  const [owner, repo] = topSource.split('/');
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/skills/${skillId}/${fileName}`;
}

/**
 * Get GitHub URL for viewing a skill on GitHub
 */
export function getSkillGitHubUrl(topSource: string, skillId: string): string {
  const [owner, repo] = topSource.split('/');
  return `https://github.com/${owner}/${repo}/tree/main/skills/${skillId}`;
}

/**
 * Download and install a skill from skills.sh
 * Uses Tauri backend to bypass CORS restrictions
 */
export async function installSkillFromSkillsSh(skill: SkillsShSkill): Promise<void> {
  const skillUrl = getSkillFileUrl(skill.topSource, skill.id, 'SKILL.md');
  
  try {
    // Download SKILL.md (CORS-bypassed on native)
    const content = await platform.skills.fetchSkillFile(skillUrl);

    // Save the skill file
    await platform.skills.saveFile(skill.id, 'SKILL.md', content);
  } catch (err) {
    console.error(`Failed to install skill ${skill.id}:`, err);
    throw err;
  }
}

/**
 * Check if a skill is installed
 */
export async function isSkillInstalled(skillId: string): Promise<boolean> {
  try {
    return await platform.skills.isInstalled(skillId);
  } catch {
    return false;
  }
}

/**
 * Delete an installed skill
 */
export async function deleteSkill(skillId: string): Promise<void> {
  await platform.skills.remove(skillId);
}

/**
 * Get list of all installed skill IDs
 */
export async function getInstalledSkillIds(): Promise<string[]> {
  return await platform.skills.listInstalled();
}

/**
 * Read a skill file content
 */
export async function readSkillFile(skillId: string, fileName: string): Promise<string> {
  return await platform.skills.readFile(skillId, fileName);
}

/**
 * Parse skill name from SKILL.md content
 */
export function parseSkillName(content: string, fallbackId: string): string {
  // Try to find a # heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }
  
  // Try to find a title: metadata
  const titleMatch = content.match(/^title:\s*(.+)$/mi);
  if (titleMatch) {
    return titleMatch[1].trim();
  }
  
  // Use ID as fallback, converting kebab-case to Title Case
  return fallbackId
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Parse skill description from SKILL.md content
 */
export function parseSkillDescription(content: string): string {
  // Try to find a description: metadata
  const descMatch = content.match(/^description:\s*(.+)$/mi);
  if (descMatch) {
    return descMatch[1].trim();
  }
  
  // Try to find the first paragraph after the heading
  const lines = content.split('\n');
  let foundHeading = false;
  for (const line of lines) {
    if (line.startsWith('#')) {
      foundHeading = true;
      continue;
    }
    if (foundHeading && line.trim() && !line.startsWith('#') && !line.startsWith('-') && !line.startsWith('*')) {
      return line.trim().slice(0, 150);
    }
  }
  
  return 'A skill for AI agents';
}

/**
 * Clear the skills.sh cache
 */
export function clearSkillsShCache(): void {
  skillsShCache = null;
}

/**
 * Get unique sources (owners) from skills list for filtering
 */
export function getUniqueSources(skills: SkillsShSkill[]): string[] {
  const sources = new Set<string>();
  for (const skill of skills) {
    const [owner] = skill.topSource.split('/');
    sources.add(owner);
  }
  return Array.from(sources).sort();
}

/**
 * Filter skills by source/owner
 */
export function filterBySource(skills: SkillsShSkill[], source: string): SkillsShSkill[] {
  if (!source || source === 'all') {
    return skills;
  }
  return skills.filter(skill => skill.topSource.startsWith(source + '/'));
}
