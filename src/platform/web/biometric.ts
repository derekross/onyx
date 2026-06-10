import type { Biometric } from '../types';

export const biometric: Biometric = {
  async checkStatus() {
    if (!('PublicKeyCredential' in window)) {
      return { isAvailable: false, error: 'WebAuthn not available' };
    }
    try {
      const available = await (
        window.PublicKeyCredential as unknown as {
          isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean>;
        }
      ).isUserVerifyingPlatformAuthenticatorAvailable();
      return { isAvailable: available, biometryType: 'platform' };
    } catch {
      return { isAvailable: false };
    }
  },
  async authenticate(_reason) {
    // Real WebAuthn auth requires a credential id stored at enrollment time.
    // Phase 2 ships without biometric gating on web; callers should check
    // checkStatus().isAvailable first.
    return false;
  },
};
