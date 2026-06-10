/**
 * Haptic Feedback Utility
 *
 * Provides haptic feedback for touch interactions. Delegates to the platform
 * adapter so the call sites do not need to feature-detect — the adapter
 * no-ops on platforms without haptics.
 */

import { platform } from '@platform';

export const impactLight = () => platform.haptics.impact('light');
export const impactMedium = () => platform.haptics.impact('medium');
export const impactHeavy = () => platform.haptics.impact('heavy');
export const notificationSuccess = () => platform.haptics.notification('success');
export const notificationWarning = () => platform.haptics.notification('warning');
export const notificationError = () => platform.haptics.notification('error');
export const selectionChanged = () => platform.haptics.selection();
export const vibrate = (durationMs: number) => platform.haptics.vibrate(durationMs);
