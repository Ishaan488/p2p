# P2P Transfer Engineering Performance Roadmap

**Target Milestones:** v1.1.0 – v2.0.0  
**Author:** Performance Engineering & Network Systems Architecture Group  
**Notice:** All throughput figures, latency reductions, and efficiency numbers in this document are **engineering targets and hypotheses** based on initial profiling, not established benchmark outcomes. They must be validated empirically after implementation.

---

## 1. Overview and Engineering Priorities

The benchmark audit and physical measurements isolated the exact system bottlenecks constraining the application:
1. **Protocol Framing:** Per-file HTTP round-trip overhead on small-file batches (3 HTTP requests per file).
2. **Network Layer:** Institutional Wi-Fi AP downlink throttling and client isolation.
3. **Cryptographic & Client Runtime:** WebCrypto in Chromium WebView vs native hardware AES instructions.
4. **Filesystem Subsystem:** Sequential file allocation and post-transfer background hashing.

This roadmap details prioritized technical solutions to achieve maximum throughput and resource efficiency.

---

## 2. Priority 1 — Small-File Batch Streaming Pipeline (`/upload_batch`)

### Problem Analysis
Under the current architecture, every individual file requires three distinct HTTP requests:
1. `POST /upload_init` (layout validation and `.meta.json` allocation)
2. `POST /upload` (ciphertext transfer)
3. `POST /upload_complete` (integrity check and atomic file rename)

For a batch of 1,000 small files, this incurs **3,000 HTTP roundtrips**, capping small-file throughput at ~40–47 files/sec over loopback and ~35 files/sec over Wi-Fi, despite small overall byte volume.

### Proposed Architecture
Implement an authenticated streaming batch protocol endpoint:
- **Endpoint:** `POST /upload_batch`
- **Protocol:** Single persistent HTTP/2 or chunked HTTP/1.1 stream using lightweight length-prefixed framing (Binary Multiplex Envelope):
  ```
  [4-byte file_id][4-byte path_len][UTF-8 relative_path][8-byte size][12-byte nonce][AES-GCM ciphertext][16-byte tag]
  ```
- **Engineering Target / Hypothesis:** Eliminate 3,000 HTTP round-trips down to **1 single continuous stream**. Proposed throughput target: **>300 files/sec** (requires validation).

---

## 3. Priority 2 — Autonomous Wi-Fi Direct and SoftAP Auto-Negotiation

### Problem Analysis
On corporate, university, and public Wi-Fi networks (such as the measured SRMIST 802.11ax network), wireless access points enforce client-to-client isolation, packet inspection, and severe asymmetric rate limiting:
- Android $\rightarrow$ PC Uplink: **4.82 – 8.68 MiB/s** (observed via Go reference client)
- PC $\rightarrow$ Android Downlink: **0.39 – 2.13 MiB/s** with intermittent 30-second packet drops.

### Proposed Architecture
1. **Diagnostic Heuristic:** The mobile app executes a 2-second pre-transfer network probe measuring RTT and packet loss.
2. **Dynamic Fallback:** If downlink speed is $< 3$ MB/s or client isolation is detected:
   - On Android: Automatically activate Android Wi-Fi Direct (`WifiP2pManager`) or Local-Only Hotspot (`WifiManager.startLocalOnlyHotspot`).
   - Exchange credentials via local QR code or Bluetooth Low Energy (BLE).
   - Establish direct 80 MHz Wi-Fi 6 peer-to-peer connection.
- **Engineering Target / Hypothesis:** Bypass infrastructure AP constraints and achieve direct peer-to-peer PHY rates targeting **40–80 MB/s** over direct radio links (requires physical validation across multiple phone vendors).

---

## 4. Priority 3 — Native Android Cryptographic Engine (Bypass WebView JS)

### Problem Analysis
The mobile client currently executes cryptographic primitives (AES-256-GCM chunk seal/open, HMAC-SHA256, and SHA-256 hashing) inside the Chromium WebView environment via WebCrypto SubtleCrypto. While hardware-accelerated for large single buffers, passing high-frequency ArrayBuffers across the Capacitor JavaScript-to-Java bridge generates significant GC churn and CPU context switches (~120 MB PSS baseline).

### Proposed Architecture
Develop a custom Capacitor C++ / JNI native plugin:
- Utilize Android's native Conscrypt / BoringSSL engine with direct ARMv8-A Cryptographic Extensions (`ARMv8 NEON crypto` instructions `AESE`, `AESD`, `PMULL`).
- Perform direct zero-copy file reads from Android scoped storage into native memory buffers, encrypting directly into the network socket.
- **Engineering Target / Hypothesis:** Target a 40% reduction in mobile CPU utilization during high-speed transfers and eliminate WebView heap pressure (requires validation).

---

## 5. Priority 4 — Pipelined Concurrent Hashing and Extent Pre-Allocation

### Problem Analysis
Currently, after all chunks are uploaded, `p2p.exe` triggers an asynchronous SHA-256 read across the whole file on disk to populate the integrity cache. For large files, reading from disk immediately after writing incurs an unnecessary I/O cycle. Furthermore, writing chunks non-sequentially into a sparse file causes NTFS fragmentation.

### Proposed Architecture
1. **Pipelined Merkle Hash:** Update chunk protocol to include per-chunk SHA-256 hashes inside the authenticated chunk header. Compute running Merkle root during streaming, eliminating the post-transfer disk read entirely.
2. **Sparse Extent Pre-allocation:** Use Win32 `SetFileInformationByHandle` with `FileAllocationInfo` (`posix_fallocate` equivalent) at `/upload_init` to pre-allocate contiguous disk clusters, preventing NTFS filesystem fragmentation.
- **Engineering Target / Hypothesis:** Target large-file finalization time under **10 ms** (requires validation).

---

## 6. Priority 5 — Non-Blocking Metadata Commit Pipeline (Memory-Mapped Journaling)

### Problem Analysis
To guarantee strict crash consistency under process termination, `saveMeta()` serializes manifest disk writes via `metaMu`. On local loopback TCP, memory-to-memory throughput exceeds 350 MiB/s, causing the ~0.3 ms per-chunk metadata disk transaction to introduce a measured ~12% throughput serialization overhead across 4 parallel workers. While physical Wi-Fi goodput is unaffected (because the ~0.3 ms metadata write is completely hidden behind 30–120 ms over-the-air radio latency), high-bandwidth local transfers would benefit from non-blocking persistence.

### Proposed Architecture
1. **Memory-Mapped Chunk Bitmap (`mmap`):** Map the fixed-length chunk bitmap directly into memory backed by the `.meta.json` or `.journal` file.
2. **Lock-Free Chunk Logging (Write-Ahead Ring Buffer):** Replace per-chunk JSON rewriting and atomic renames with sequential append-only binary log entries `[chunk_index, timestamp]`.
3. **Decoupled Asynchronous Sync:** Maintain crash-consistency without holding `metaMu` across filesystem rename transactions during active chunk streaming.
- **Engineering Target / Hypothesis:** Eliminate the 12% loopback serialization overhead and achieve full 4-worker loopback saturation (>350 MiB/s) while preserving 100% crash recovery guarantees (requires validation).

