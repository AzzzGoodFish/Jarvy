/** How Jarvy is reached (A51). Listening only on this machine it serves plain HTTP, as browsers count `localhost` as
 * secure. Listening beyond it, it serves HTTPS with its own certificates on the same port, and plain HTTP from other
 * machines is redirected unless the owner allows it in Settings. */
export interface ConnectionInfo {
  /** Whether Jarvy listens beyond this machine and so serves HTTPS. */
  https: boolean;
  allowHttp: boolean;
  /** HTTPS addresses other devices may use. */
  addresses: string[];
  /** The root certificate's SHA-256, colon-separated hex; null without HTTPS. */
  fingerprint: string | null;
  /** Its SHA-1, as Windows' certificate window shows it; null without HTTPS. */
  fingerprintSha1: string | null;
}
