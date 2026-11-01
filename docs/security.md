# Security Architecture & Cryptographic Model

P2P Link is engineered with a local-first, zero-trust cryptographic model designed to provide confidentiality, integrity, mutual authentication, and replay protection over untrusted local Wi-Fi networks.

---

## 1. Cryptographic Primitives

P2P Link uses standard, hardware-accelerated cryptographic primitives:

- **Symmetric Encryption & AEAD**: AES-256-GCM and ChaCha20-Poly1305 authenticated encryption with 128-bit authentication tags.
- **Key Derivation**: HKDF-SHA256 (`hkdf32`) with application-specific context strings to derive independent session encryption and MAC keys.
- **Message Authentication**: HMAC-SHA256 for device pairing challenge-response handshakes and request signing.
- **Hashing**: SHA-256 for whole-file integrity verification and truncated 128-bit SHA-256 digests for per-chunk recovery verification.

---

## 2. Threat Model & Security Defenses

### 2.1 Confidentiality & Network Eavesdropping
- **Threat**: Attackers on the same local Wi-Fi network (or rogue access points) sniffing packets via promiscuous mode or Wireshark.
- **Defense**: All chunk payloads, metadata manifests, and clipboard contents are sealed with authenticated encryption before transmission. Eavesdroppers see only random ciphertexts.

### 2.2 Ciphertext Tampering & Bit-Flipping
- **Threat**: Malicious intermediaries flipping bits in transit to inject corrupted data into written files.
- **Defense**: AEAD authentication tags verify every chunk. Any altered bit causes immediate authentication failure (`s.open()` returns an error), rejecting the chunk with HTTP 400.

### 2.3 Chunk Substitution & Cross-Transfer Replay
- **Threat**: An attacker capturing an encrypted chunk from one transfer (e.g. `fileA`) and injecting it into another transfer (`fileB`), or swapping chunk positions.
- **Defense**: Every chunk is encrypted with Additional Authenticated Data (AAD) bound to the Transfer ID and chunk offset:
  $$\text{AAD} = \text{chunkAAD}(\text{TransferID}, \text{chunkIndex})$$
  A chunk sealed for index 3 cannot be decrypted or accepted at index 4 or under a different transfer ID.

### 2.4 Replay Attacks & Request Forgery
- **Threat**: Re-sending previously recorded HTTP requests to replay transfers or commands.
- **Defense**: All HTTP requests require an ephemeral cryptographic nonce, timestamp, and HMAC signature (`?mac=...`). Used nonces are tracked in memory; replayed requests are rejected with HTTP 401.

### 2.5 Path Traversal & File Overwrite Defenses
- **Threat**: Malicious clients sending filenames containing `../`, absolute paths (`/etc/passwd`, `C:\Windows\System32`), or reserved device names (`CON`, `PRN`, `AUX`, `NUL`).
- **Defense**: Filenames are strictly sanitized using `sanitizeFilename()` and `filepath.Base()`. Destination paths are verified with `filepath.Rel()`. Collision resolution ensures existing files are never overwritten; duplicate names are safely renamed to `filename (1).ext`.

### 2.6 Pairing & Access Control
- **Threat**: Rogue devices on the local network initiating unauthorized file transfers.
- **Defense**: Unknown devices require explicit user approval on the desktop prompt. Transferred files are written to isolated temporary files until the user accepts and finalization verifies full receipt.

---

## 3. Auditing & Verification

For detailed automated test results, boundary fuzzing logs, and 37-probe security regression matrix, see the internal audit paper in [`docs/audit/SECURITY_TEST_REPORT.md`](audit/SECURITY_TEST_REPORT.md).

