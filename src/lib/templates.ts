/**
 * Templates functionality
 * 
 * Allows users to create notes from templates and insert template content.
 */

import { invoke } from '@tauri-apps/api/core';
import dayjs from 'dayjs';

export interface TemplatesConfig {
  folder: string;
}

export const DEFAULT_TEMPLATES_CONFIG: TemplatesConfig = {
  folder: 'Templates',
};

export interface TemplateInfo {
  name: string;
  path: string;
}

/**
 * Interpolate template variables in content
 * 
 * Supported variables:
 * - {{title}} - Prompted or provided title
 * - {{date}} - Current date (YYYY-MM-DD)
 * - {{date:FORMAT}} - Current date with custom format
 * - {{time}} - Current time (HH:mm)
 * - {{time:FORMAT}} - Current time with custom format
 */
export function interpolateTemplateVariables(
  content: string,
  variables: Record<string, string> = {}
): string {
  const now = dayjs();
  let result = content;
  
  // Replace {{date:FORMAT}} patterns
  result = result.replace(/\{\{date:([^}]+)\}\}/g, (_, format) => {
    return now.format(format);
  });
  
  // Replace simple {{date}} with default format
  result = result.replace(/\{\{date\}\}/g, now.format('YYYY-MM-DD'));
  
  // Replace {{time:FORMAT}} patterns
  result = result.replace(/\{\{time:([^}]+)\}\}/g, (_, format) => {
    return now.format(format);
  });
  
  // Replace simple {{time}} with default format
  result = result.replace(/\{\{time\}\}/g, now.format('HH:mm'));
  
  // Replace custom variables (like {{title}})
  for (const [key, value] of Object.entries(variables)) {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(pattern, value);
  }
  
  return result;
}

/**
 * Get list of available templates
 */
export async function listTemplates(
  vaultPath: string,
  config: TemplatesConfig
): Promise<TemplateInfo[]> {
  const folderPath = `${vaultPath}/${config.folder}`;
  
  try {
    const files = await invoke<Array<{ name: string; path: string; isDirectory: boolean }>>('list_files', { path: folderPath });
    return files
      .filter(f => !f.isDirectory && f.name.endsWith('.md'))
      .map(f => ({
        name: f.name.replace(/\.md$/, ''),
        path: f.path,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * Read a template's content
 */
export async function readTemplate(templatePath: string, vaultPath?: string): Promise<string> {
  return await invoke<string>('read_file', { path: templatePath, vaultPath });
}

/**
 * Create a new note from a template
 */
export async function createNoteFromTemplate(
  vaultPath: string,
  templatePath: string,
  targetFolder: string,
  noteName: string,
  variables: Record<string, string> = {}
): Promise<string> {
  // Read template content
  const templateContent = await readTemplate(templatePath, vaultPath);
  
  // Add title to variables
  variables.title = noteName;
  
  // Interpolate variables
  const content = interpolateTemplateVariables(templateContent, variables);
  
  // Ensure target folder exists
  const targetFolderPath = `${vaultPath}/${targetFolder}`;
  try {
    await invoke('create_folder', { path: targetFolderPath, vaultPath });
  } catch {
    // Folder may already exist
  }
  
  // Create the note
  const notePath = `${targetFolderPath}/${noteName}.md`;
  await invoke('create_file', { path: notePath, vaultPath });
  await invoke('write_file', { path: notePath, content, vaultPath });
  
  return notePath;
}

/**
 * Insert template content at cursor position (returns the interpolated content)
 */
export async function getTemplateContent(
  templatePath: string,
  variables: Record<string, string> = {},
  vaultPath?: string
): Promise<string> {
  const templateContent = await readTemplate(templatePath, vaultPath);
  return interpolateTemplateVariables(templateContent, variables);
}

/**
 * Ensure the templates folder exists with a sample template
 */
export async function ensureTemplatesFolder(
  vaultPath: string,
  config: TemplatesConfig
): Promise<void> {
  const folderPath = `${vaultPath}/${config.folder}`;
  
  try {
    await invoke('create_folder', { path: folderPath, vaultPath });
  } catch {
    // Folder may already exist
  }
  
  // Check if there are any templates
  const templates = await listTemplates(vaultPath, config);
  
  if (templates.length === 0) {
    // Create a sample template
    const samplePath = `${folderPath}/Note.md`;
    const sampleContent = `# {{title}}

Created: {{date}}

## Notes

`;
    
    try {
      await invoke('create_file', { path: samplePath, vaultPath });
      await invoke('write_file', { path: samplePath, content: sampleContent, vaultPath });
    } catch {
      // Template may already exist
    }
  }
}

/**
 * Load templates config from localStorage
 */
export function loadTemplatesConfig(): TemplatesConfig {
  try {
    const stored = localStorage.getItem('templates_config');
    if (stored) {
      return { ...DEFAULT_TEMPLATES_CONFIG, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error('Failed to load templates config:', e);
  }
  return DEFAULT_TEMPLATES_CONFIG;
}

/**
 * Save templates config to localStorage
 */
export function saveTemplatesConfig(config: TemplatesConfig): void {
  try {
    localStorage.setItem('templates_config', JSON.stringify(config));
  } catch (e) {
    console.error('Failed to save templates config:', e);
  }
}
