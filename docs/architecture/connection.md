# Connection

[Index](../index.md) · [Code layout](layout.md) · [Storage](storage.md) · [ADR A51](../decisions.md)

How browsers reach Jarvy. `--host` decides it.

## On this machine only

The default host is `127.0.0.1`. Jarvy serves plain HTTP, and makes no certificate. Browsers count `localhost` and `127.0.0.1` as secure contexts, so nothing is lost.

## Beyond this machine

With any other host (`0.0.0.0`, `::`, a LAN address), Jarvy serves HTTPS with its own certificates, on the same port as plain HTTP.

- **Certificates** (`infra/tls/`, in the data directory's `tls/`):
  - A root (ECDSA P-256, ten years, a CA that may only sign server certificates) is made the first time.
  - A server certificate signed by it (397 days) covers this machine's name and `<name>.local`, `localhost`, `127.0.0.1`, `::1`, the host given, and the addresses of its network interfaces. Interfaces of containers, VMs and proxy tunnels are left out, and so is the 198.18.0.0/15 range such tunnels use.
  - At each start the server certificate is signed again when it ends within 30 days or a name or address is missing, so a device that trusts the root never needs to trust anything new.
  - Certificates are written with Node's crypto (`x509.ts`, a small DER writer) and checked against the root before they are used. Private keys are written 0600.
- **One port** (`api/server.ts`): a TCP listener reads each connection's first byte. A TLS handshake (`0x16`) goes to an HTTPS server, anything else to an HTTP server. Both share the Hono request handler. Over HTTPS the session cookie is `Secure` and has a name of its own, because a plain-HTTP page may not overwrite a Secure cookie of the same name, and signing in over HTTP after HTTPS would keep failing.
- **Plain HTTP**:
  - A request from this machine is served, whether it comes from a loopback address or one of the machine's own addresses (a tool here that uses the LAN address).
  - A request from another machine gets a 308 to the same host, path and query over HTTPS, unless the owner allows plain HTTP.
  - That choice is the `allow_http` setting (Settings → General → LAN access, "Allow HTTP access", `PUT /api/connection {allowHttp}`). It applies to the next request, with no restart.
- **The root for devices**: `GET /api/connection/root.crt` serves it as DER (`application/x-x509-ca-cert`) without login, because a public certificate is not a secret. `GET /api/connection` gives the HTTPS addresses, the root's SHA-256 fingerprint and the setting.
- **The interface**:
  - Settings → General → LAN access appears only when Jarvy serves HTTPS. It lists the addresses with a copy button, the certificate with a download and its fingerprint, install steps for Mac, Windows, iPhone and iPad, and Android, and the "Allow HTTP access" switch.
  - Whenever the page is not a secure context (`window.isSecureContext` is false), a warning sits above everything, the login page included, and links to the same page over HTTPS. A reverse proxy that adds TLS gives a secure context, so it shows no warning.
- **The command line**: `jarvy on` and `jarvy run` print the HTTPS addresses. They add a warning when plain HTTP is allowed.
