/**
 * Daily Notes functionality
 * 
 * Creates and opens daily notes based on user-configured format and folder.
 */

import { invoke } from '@tauri-apps/api/core';
import dayjs from 'dayjs';

export interface DailyNotesConfig {
  enabled: boolean;
  folder: string;
  dateFormat: string;
  template: string;
}

export const DEFAULT_DAILY_NOTES_CONFIG: DailyNotesConfig = {
  enabled: true,
  folder: 'Daily Notes',
  dateFormat: 'YYYY-MM-DD',
  template: `# {{date:MMMM D, YYYY}}

## Tasks
- [ ] 

## Notes

## Journal

`,
};

/**
 * Get the path for today's daily note
 */
export function getDailyNotePath(vaultPath: string, config: DailyNotesConfig): string {
  const filename = dayjs().format(config.dateFormat);
  return `${vaultPath}/${config.folder}/${filename}.md`;
}

/**
 * Get the path for a specific date's daily note
 */
export function getDailyNotePathForDate(vaultPath: string, config: DailyNotesConfig, date: Date): string {
  const filename = dayjs(date).format(config.dateFormat);
  return `${vaultPath}/${config.folder}/${filename}.md`;
}

/**
 * Interpolate template variables
 */
function interpolateTemplate(template: string, date: Date = new Date()): string {
  const d = dayjs(date);
  
  // Replace {{date:FORMAT}} patterns
  let result = template.replace(/\{\{date:([^}]+)\}\}/g, (_, format) => {
    return d.format(format);
  });
  
  // Replace simple {{date}} with default format
  result = result.replace(/\{\{date\}\}/g, d.format('YYYY-MM-DD'));
  
  // Replace {{time}} with current time
  result = result.replace(/\{\{time\}\}/g, d.format('HH:mm'));
  
  // Replace {{title}} with the date in a readable format
  result = result.replace(/\{\{title\}\}/g, d.format('MMMM D, YYYY'));
  
  return result;
}

/**
 * Create or open today's daily note
 * Returns the path to the note
 */
export async function openDailyNote(
  vaultPath: string,
  config: DailyNotesConfig
): Promise<{ path: string; isNew: boolean }> {
  const notePath = getDailyNotePath(vaultPath, config);
  const folderPath = `${vaultPath}/${config.folder}`;
  
  // Check if the note already exists
  try {
    await invoke<string>('read_file', { path: notePath, vaultPath });
    return { path: notePath, isNew: false };
  } catch {
    // Note doesn't exist, create it
  }
  
  // Ensure the folder exists
  try {
    await invoke('create_folder', { path: folderPath, vaultPath });
  } catch {
    // Folder may already exist, that's fine
  }
  
  // Create the note with the template content
  const content = interpolateTemplate(config.template);
  await invoke('create_file', { path: notePath, vaultPath });
  await invoke('write_file', { path: notePath, content, vaultPath });
  
  return { path: notePath, isNew: true };
}

/**
 * Get a list of all daily notes in the folder
 */
export async function listDailyNotes(
  vaultPath: string,
  config: DailyNotesConfig
): Promise<string[]> {
  const folderPath = `${vaultPath}/${config.folder}`;
  
  try {
    const files = await invoke<Array<{ name: string; path: string; isDirectory: boolean }>>('list_files', { path: folderPath });
    return files
      .filter(f => !f.isDirectory && f.name.endsWith('.md'))
      .map(f => f.path)
      .sort()
      .reverse(); // Most recent first
  } catch {
    return [];
  }
}

/**
 * Navigate to previous or next daily note
 */
export async function navigateDailyNote(
  vaultPath: string,
  config: DailyNotesConfig,
  currentPath: string,
  direction: 'prev' | 'next'
): Promise<string | null> {
  const allNotes = await listDailyNotes(vaultPath, config);
  const currentIndex = allNotes.indexOf(currentPath);
  
  if (currentIndex === -1) return null;
  
  const targetIndex = direction === 'prev' ? currentIndex + 1 : currentIndex - 1;
  
  if (targetIndex < 0 || targetIndex >= allNotes.length) return null;
  
  return allNotes[targetIndex];
}

/**
 * Load daily notes config from localStorage
 */
export function loadDailyNotesConfig(): DailyNotesConfig {
  try {
    const stored = localStorage.getItem('daily_notes_config');
    if (stored) {
      return { ...DEFAULT_DAILY_NOTES_CONFIG, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error('Failed to load daily notes config:', e);
  }
  return DEFAULT_DAILY_NOTES_CONFIG;
}

/**
 * Save daily notes config to localStorage
 */
export function saveDailyNotesConfig(config: DailyNotesConfig): void {
  try {
    localStorage.setItem('daily_notes_config', JSON.stringify(config));
  } catch (e) {
    console.error('Failed to save daily notes config:', e);
  }
}
