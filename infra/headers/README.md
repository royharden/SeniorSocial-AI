# Security-header evidence

`security-policy.json` is the machine-readable WP-033 expectation for the web
application. The executable checks in `tests/security/WP-033/headers.test.ts`
compare it with the actual Next configuration and CSP proxy.

HSTS is deliberately conditional. Production and other TLS-terminated lanes
must set `ENABLE_HSTS=true`; plain HTTP development lanes must not emit it.
The remaining headers apply to every path, and the CSP is placed on both the
forwarded request and the response with a per-request nonce.
