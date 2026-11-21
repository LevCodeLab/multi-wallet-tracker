/**
 * Closure-isolated RAM signing key store for optional sweep operations.
 * Private keys stay strictly inside lexical closure memory during the active tab session.
 */

export interface SessionKeyStoreApi {
  registerKey: (address: string, privateKey: `0x${string}`) => void;
  getKey: (address: string) => `0x${string}` | undefined;
  hasKey: (address: string) => boolean;
  clear: () => void;
}

export function createSessionKeyStore(): SessionKeyStoreApi {
  const keys = new Map<string, `0x${string}`>();

  return Object.freeze({
    registerKey(address: string, privateKey: `0x${string}`): void {
      if (address && privateKey && privateKey.startsWith("0x")) {
        keys.set(address.toLowerCase(), privateKey);
      }
    },
    getKey(address: string): `0x${string}` | undefined {
      return keys.get(address.toLowerCase());
    },
    hasKey(address: string): boolean {
      return keys.has(address.toLowerCase());
    },
    clear(): void {
      keys.clear();
    }
  });
}

export const sessionKeyStore = createSessionKeyStore();
