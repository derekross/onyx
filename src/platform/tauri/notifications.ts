import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import type { Notifications } from '../types';

export const notifications: Notifications = {
  async isPermissionGranted() {
    return isPermissionGranted();
  },
  async requestPermission() {
    const result = await requestPermission();
    return result === 'granted';
  },
  async send(title, body) {
    sendNotification({ title, body });
  },
};
