/**
 * Biometric Authentication Utility
 *
 * Wraps the platform adapter. Returns true on platforms without biometric
 * support (desktop relies on the OS keychain for nsec security).
 */

import { platform } from '@platform';

export async function isBiometricAvailable(): Promise<boolean> {
  const status = await platform.biometric.checkStatus();
  return status.isAvailable;
}

export async function authenticateWithBiometric(reason: string): Promise<boolean> {
  return platform.biometric.authenticate(reason);
}

export async function withBiometricAuth<T>(
  reason: string,
  callback: () => T | Promise<T>,
): Promise<T | null> {
  const ok = await authenticateWithBiometric(reason);
  if (!ok) return null;
  return await callback();
}
