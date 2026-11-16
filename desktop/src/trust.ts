import type { Session } from "electron";
import { X509Certificate } from "node:crypto";

/** The window trusts only the Jarvy the person checked (A96): for its host, a certificate issued by the root they
 * accepted by its fingerprint; nothing else, whatever the system trusts. Other hosts (links opened in the window are
 * sent to the browser instead) keep Chromium's own check. */
export function pin(session: Session, server: string, ca: string | null): void {
  if (!ca) { session.setCertificateVerifyProc((_request, callback) => callback(-3)); return; }
  const host = new URL(server).hostname, root = new X509Certificate(ca);
  session.setCertificateVerifyProc((request, callback) => {
    if (request.hostname !== host) return callback(-3);
    callback(issued(request.certificate.data, root) ? 0 : -2);
  });
}

/** Whether a certificate (PEM) is the root itself or one it signed, and in date. */
export function issued(pem: string, root: X509Certificate): boolean {
  try {
    const cert = new X509Certificate(pem), now = Date.now();
    if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo)) return false;
    if (cert.fingerprint256 === root.fingerprint256) return true;
    return cert.checkIssued(root) && cert.verify(root.publicKey);
  } catch { return false; }
}
