import { invoke } from '@tauri-apps/api/core';
import type { Skills } from '../types';

export const skills: Skills = {
  isInstalled(skillId) {
    return invoke<boolean>('skill_is_installed', { skillId });
  },
  listInstalled() {
    return invoke<string[]>('skill_list_installed');
  },
  async saveFile(skillId, fileName, content) {
    await invoke<void>('skill_save_file', { skillId, fileName, content });
  },
  readFile(skillId, fileName) {
    return invoke<string>('skill_read_file', { skillId, fileName });
  },
  async remove(skillId) {
    await invoke<void>('skill_delete', { skillId });
  },
  importZip(zipPath) {
    return invoke<string>('skill_import_zip', { zipPath });
  },
  fetchSkillsSh(pages) {
    return invoke<string>('fetch_skills_sh', pages !== undefined ? { pages } : {});
  },
  fetchSkillFile(url) {
    return invoke<string>('fetch_skill_file', { url });
  },
};
