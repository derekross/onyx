import type { Notifications } from '../types';

export const notifications: Notifications = {
  async isPermissionGranted() {
    if (!('Notification' in window)) return false;
    return Notification.permission === 'granted';
  },
  async requestPermission() {
    if (!('Notification' in window)) return false;
    const result = await Notification.requestPermission();
    return result === 'granted';
  },
  async send(title, body) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    new Notification(title, { body });
  },
};
