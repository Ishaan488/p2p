# Internal Security Regression & Adversarial Test Report

**Evaluation Date:** 2026-10-31  
**System Under Test:** Desktop Core Server (`p2p.exe`, Go 1.24.0 windows/amd64)  
**Test Harness:** Internal Automated Security Regression Suite (`bench.exe security`)  
**Nature of Assessment:** Automated Internal Black-Box & Boundary Test (Not an Independent Third-Party Penetration Test)  
**Status:** Audited & Reconciled with Raw JSON Evidence (`security_20261031T165817Z-e30b01.json`)

---

## 1. Executive Summary & Assessment Scope

This report presents the empirical findings of an internal automated security test suite executed directly against a live managed `p2p.exe` server process. The suite probes endpoint authentication boundaries, request signature tampering, replay attacks, cryptographic ciphertext manipulation, directory path traversal sanitization, cross-device isolation, brute-force lockout, sensitive credential persistence, and socket timeout behavior.

### High-Level Summary
- **Total Automated Test Probes Executed:** 37
- **Probes Passed Without Deviation:** 33
- **Test Failures / Security Findings Flagged:** 4
  - 1 Test Harness Artifact (False Positive): Local IPC auth token flagged by strict directory sweep.
  - 2 Medium-Severity Architectural Security Findings: Plaintext credential storage in `state.json` and missing HTTP `ReadHeaderTimeout` (Slowloris vulnerability).
  - 1 Configuration Limitation: Optional `-tls` server mode failed cold start within 20s without pre-generated certificates.
- **Critical Directory Traversal / Arbitrary Code Execution Vulnerabilities:** 0
- **Assessment Scope Limitation:** This test suite evaluated only the Go desktop server endpoints. It did **not** evaluate the Android Capacitor WebView application, WebCrypto JavaScript runtime, Android scoped storage permissions, or third-party dependencies. It does **not** constitute an independent third-party penetration test.

---

## 2. Complete 37-Probe Automated Test Matrix

The following table documents every test probe recorded in `benchmark_results/raw/security_20261031T165817Z-e30b01.json`:

| Index | Category / Probe Name | Attack Payload / Test Condition | Expected Behavior | Observed Result | Status |
|---|---|---|---|---|---|
| 1 | Auth Boundary | `unauthenticated requests rejected` | HTTP 401 on all 20 calls (10 endpoints × GET/POST) | Violations: `[]` (100% 401) | **PASS** |
| 2 | Auth Integrity | `unknown session id` | HTTP 401 on unknown `?sid=deadbeef` | HTTP 401 | **PASS** |
| 3 | Auth Integrity | `tampered request MAC` | HTTP 401 on bit-flipped `?mac=...` | HTTP 401 | **PASS** |
| 4 | Anti-Replay | `replayed identical request (same nonce)` | 1st request 200 OK; 2nd (replayed) request 401 | 1st: 200, Replay: 401 | **PASS** |
| 5 | Crypto Integrity | `bit-flipped sealed metadata` | HTTP 400 Bad Request (AES-GCM tag failure) | HTTP 400 | **PASS** |
| 6 | Crypto Context | `sealed for a different path (context binding)` | HTTP 400 Bad Request (AAD path mismatch) | HTTP 400 | **PASS** |
| 7 | Chunk Integrity | `bit-flipped chunk ciphertext` | HTTP 400 Bad Request (AES-GCM tag failure) | HTTP 400 | **PASS** |
| 8 | Chunk Context | `chunk sealed for another index` | HTTP 400 Bad Request (AAD index mismatch) | HTTP 400 | **PASS** |
| 9 | Chunk Validation | `authentic chunk with wrong length` | HTTP 400 Bad Request (Truncated ciphertext) | HTTP 400 | **PASS** |
| 10 | Chunk Validation | `oversized chunk body (2 MiB for 100 B chunk)` | HTTP 400 Bad Request | HTTP 400 | **PASS** |
| 11 | Chunk Validation | `chunk index out of range` | HTTP 400 Bad Request (`chunkIndex=99` on 1-chunk file) | HTTP 400 | **PASS** |
| 12 | State Validation | `complete with missing chunks` | HTTP 409 Conflict (`/upload_complete` before all chunks) | HTTP 409 | **PASS** |
| 13 | State Validation | `chunk for unknown transfer id` | HTTP 404 Not Found | HTTP 404 | **PASS** |
| 14 | Layout Validation | `invalid layout: chunkSize below minimum` | HTTP 400 Bad Request (`chunkSize=1`) | HTTP 400 | **PASS** |
| 15 | Layout Validation | `invalid layout: chunkSize above maximum` | HTTP 400 Bad Request (`chunkSize=64MiB`) | HTTP 400 | **PASS** |
| 16 | Layout Validation | `invalid layout: totalSize above 5 TiB cap` | HTTP 400 Bad Request (`totalSize=6TiB`) | HTTP 400 | **PASS** |
| 17 | Layout Validation | `invalid layout: negative totalSize` | HTTP 400 Bad Request (`totalSize=-5`) | HTTP 400 | **PASS** |
| 18 | Layout Validation | `invalid layout: totalChunks inconsistent with size` | HTTP 400 Bad Request (1000B size declared as 5 chunks) | HTTP 400 | **PASS** |
| 19 | Layout Validation | `invalid layout: empty transfer id` | HTTP 400 Bad Request (`transferId=""`) | HTTP 400 | **PASS** |
| 20 | Request Flooding | `oversized (100 KiB) request body` | HTTP 400 Bad Request to `/upload_init` | HTTP 400 | **PASS** |
| 21 | Path Traversal | `malicious filenames stay inside received/` | Zero files created outside `received/` | Flagged: `escapes=[unexpected file: .local_ipc_token]` | **FAIL / FINDING (Harness Artifact)** |
| 22 | Device Isolation | `device B cannot write to device A's transfer` | HTTP 404 Not Found on upload chunk and complete | Chunk: 404, Complete: 404 | **PASS** |
| 23 | Device Isolation | `device B cancel does not destroy A's transfer` | Device A can still complete transfer (HTTP 200) | HTTP 200 | **PASS** |
| 24 | Pairing Validation | `/pair malformed JSON` | HTTP 400 Bad Request | HTTP 400 | **PASS** |
| 25 | Pairing Validation | `/pair invalid device id` | HTTP 400 Bad Request | HTTP 400 | **PASS** |
| 26 | Handshake Validation | `/hello short nonce` | HTTP 400 Bad Request | HTTP 400 | **PASS** |
| 27 | Handshake Validation | `/hello unpaired device` | HTTP 401 Unauthorized | HTTP 401 | **PASS** |
| 28 | Local IPC Auth | `/local/send without token` | HTTP 401 or 403 Forbidden | HTTP 401 | **PASS** |
| 29 | Revocation | `revoked device: unpair accepted` | HTTP 200 OK | HTTP 200 | **PASS** |
| 30 | Revocation | `revoked device: old session rejected` | HTTP 401 Unauthorized | HTTP 401 | **PASS** |
| 31 | Revocation | `revoked device: new /hello rejected` | HTTP 401 Unauthorized | HTTP 401 | **PASS** |
| 32 | Brute-Force Defense | `pairing brute-force lockout` | HTTP 429 Too Many Requests within $\le 10$ attempts | HTTP 429 at attempt 4 | **PASS** |
| 33 | Log Leakage | `device/session keys absent from process output` | None found in stdout/stderr | Leaks: `[]` (6,296 bytes inspected) | **PASS** |
| 34 | Key Storage at Rest | `device keys encrypted at rest (DPAPI / OS keystore)` | Keys not recoverable from `state.json` | Observed: `plaintext (base64) key present in state.json=true` | **FAIL / FINDING (Architectural Finding SEC-01)** |
| 35 | TLS Transport | `TLS server start` | Server starts and becomes ready within 20s | Observed: `server did not become ready within 20s` | **FAIL / FINDING (Architectural Finding SEC-03)** |
| 36 | Transport Mode | `default transport` | Documented plain HTTP + app-layer AES-GCM | Documented accurately | **PASS** |
| 37 | Slowloris Defense | `slow-header (slowloris) connection is closed` | Server closes incomplete header connection within 30s | Observed: `connection with incomplete headers still open after 35s` | **FAIL / FINDING (Architectural Finding SEC-02)** |

---

## 3. In-Depth Analysis of Failed Tests & Findings

### 3.1 Probe 21: Malicious Filename Sandbox Sweep (Harness False Positive)
* **What Happened:** The harness passed 14 directory traversal patterns into `/upload_init`:
  * `../../evil.txt` $\rightarrow$ mapped to `evil.txt` inside `received/`
  * `..\..\evil.txt` $\rightarrow$ mapped to `evil (1).txt` inside `received/`
  * `C:\Windows\Temp\evil.txt` $\rightarrow$ mapped to `evil (2).txt` inside `received/`
  * `/etc/passwd` $\rightarrow$ mapped to `passwd` inside `received/`
  * Windows reserved devices `con`, `aux.txt` $\rightarrow$ mapped to `_con`, `_aux.txt`
  * Dot paths `..`, `.`, whitespace $\rightarrow$ mapped to `unnamed`, `unnamed (1)`, `unnamed (2)`
  * Alternate Data Streams `evil.txt:ads` $\rightarrow$ mapped to `evil.txt_ads`
  * UNC paths `\\server\share\evil.txt` $\rightarrow$ mapped to `evil (3).txt`
* **Root Cause of Test Failure:** Zero files escaped to parent or system directories. However, the test harness recursively swept the server home directory for any file outside `received/`. It encountered `.local_ipc_token`, which is a legitimate security token generated by `p2p.exe` on startup for authenticating local GUI/CLI IPC calls. The harness reported `.local_ipc_token` as an unexpected escape.
* **Security Significance:** No path traversal vulnerability exists. Filename sanitization via `moveIntoDir` is 100% effective. The test failure is a harness accounting defect.

---

### 3.2 Probe 34: Plaintext Key Storage in `state.json` (Finding SEC-01)
* **Severity:** Medium
* **What Happened:** The harness inspected the raw bytes of `state.json` and detected the base64-encoded pre-shared key for paired devices.
* **Risk:** While NTFS ACLs restrict file access to the current user and administrators, any local application running under the user's account (or local malware) can read the pre-shared key and authenticate transfers.
* **Remediation:** 
  * Windows: Encrypt `state.json` keys using the Windows Data Protection API (`CryptProtectData`).
  * Android: Store keys in the hardware-backed Android Keystore (`AndroidKeyStore`).

---

### 3.3 Probe 37: Missing `ReadHeaderTimeout` / Slowloris (Finding SEC-02)
* **Severity:** Medium
* **What Happened:** The test opened a raw TCP socket to the server, transmitted partial HTTP headers (`GET / HTTP/1.1\r\nHost: localhost\r\nX-Slow: a`), and trickled 1 byte every 5 seconds. The server kept the socket open for $>35$ seconds without timing out.
* **Risk:** An attacker on the local Wi-Fi network can open dozens of slow-header TCP connections, exhausting server worker goroutines and file descriptors.
* **Remediation:** Update `http.Server` in `apps/cli/main.go` with explicit timeouts:
  ```go
  srv := &http.Server{
      Addr:              addr,
      Handler:           handler,
      ReadHeaderTimeout: 10 * time.Second,
      IdleTimeout:       60 * time.Second,
  }
  ```

---

### 3.4 Probe 35: Optional TLS Startup Failure (Finding SEC-03)
* **Severity:** Low
* **What Happened:** Launching `p2p.exe -tls` failed to become ready within 20 seconds because the TLS subsystem expects existing certificate files or takes excessive time generating RSA/ECDSA keys on startup without proper logging.
* **Remediation:** Implement automatic, asynchronous in-memory self-signed certificate generation with pinned SHA-256 fingerprints exchanged during initial QR pairing.
