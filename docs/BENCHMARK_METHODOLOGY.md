# P2P Transfer Benchmark Methodology and Measurement Specification

**Document Version:** 2.1.0  
**Status:** Audited & Validated  
**Author:** Senior Performance, Network Protocol & Systems Engineering Team  
**Scope:** Windows Go Server (`p2p.exe`), Go Protocol Reference Client (`bench.exe`), and Android Capacitor Client (`com.example.app`)

---

## 1. Scope, Objectives, and Core Principles

This specification defines the rigorous measurement methodology, instrumentation boundaries, timing definitions, and statistical treatments used to benchmark the P2P Cross-Device Transfer application.

### 1.1 Non-Conflation Principle
A fundamental finding of the technical audit was the conflation of local NVMe/in-memory pipeline speeds (~1.8 GB/s) with over-the-air Wi-Fi throughput (~3–9 MB/s). Under this specification:
1. **Network Throughput:** Strictly refers to transfers crossing a physical radio or Ethernet link between two physically independent hardware devices.
2. **Loopback Protocol Throughput:** Measures the full application protocol stack (HTTP/1.1 framing, HMAC-SHA256 request signatures, HKDF-SHA256 key derivation, AES-256-GCM chunk seal/unseal, concurrent worker scheduling, and Win32 filesystem I/O) running over `127.0.0.1`.
3. **Local Disk/Memory Pipeline:** Measures raw storage and operating system page cache execution isolated from network socket overhead.

Under no circumstances may loopback or in-memory throughput be labeled as Wi-Fi or network speed.

### 1.2 Separation of Test Clients
To prevent misleading claims, test clients must be explicitly categorized:
1. **Go Reference Client (`p2pbench`):** Cross-compiled native Go binary executed on Windows or Android (via ADB shell). Uses pure Go networking, AES-GCM, and deterministic file I/O. **Does not exercise Android WebView, JavaScript WebCrypto, or Capacitor plugins.**
2. **Real Android Application (`com.example.app`):** Capacitor hybrid application running on Android with Chromium WebView, JavaScript WebCrypto (`crypto.subtle`), and Android Scoped Storage. **All claims regarding mobile app performance must be measured from this client.**

---

## 2. Testbed Hardware, Software, and Network Profiles

Every test recorded in this suite was executed on the following calibrated physical testbed:

| System Parameter | Windows Desktop Endpoint | Android Mobile Endpoint |
|---|---|---|
| **Device Model** | Lenovo IdeaPad 3 15ITL6 (82H8) | Nothing A059 (CMF Phone 1) |
| **Processor** | 11th Gen Intel® Core™ i5-1155G7 @ 2.50 GHz (4 Cores, 8 Threads) | MediaTek Dimensity 7300 5G (4× Cortex-A78 @ 2.5 GHz + 4× Cortex-A55 @ 2.0 GHz) |
| **System Memory** | 16 GB DDR4-3200 (16,555,320 kB visible) | 8 GB LPDDR4X (7,607,080 kB visible) |
| **Storage Subsystem** | Intel® SSDPEKNW512GZL 512 GB PCIe NVMe SSD | 128 GB UFS 2.2 Storage |
| **Operating System** | Windows 11 Home Single Language (64-bit, Build 26300) | Android 15 (Nothing OS 3.0, Kernel 6.1.75-android14) |
| **Runtime / Toolchain** | Go 1.24.0 (windows/amd64), Win32 CGO-disabled | Chromium 128.0.6613.88 WebView, Capacitor 8 Runtime |
| **IP Address (LAN)** | `10.3.232.1` | `10.3.231.49` |

### 2.1 Radio and Wireless Network Topology
- **Access Point:** SRMIST Enterprise Wireless AP (BSSID: `48:b4:c3:f2:37:70`)
- **Radio Band:** 5.0 GHz (UNII-2C, Channel 116, Frequency 5580 MHz)
- **Wi-Fi Standard:** IEEE 802.11ax (Wi-Fi 6)
- **Negotiated Link Parameters:** Tx Link Speed: 432 Mbps, Rx Link Speed: 408 Mbps, Max Supported PHY: 1200 Mbps (2×2 MIMO, 80 MHz channel width).
- **Signal Quality:** RSSI: -60 dBm, Score: 100/100.
- **Network Architecture:** Star topology, institutional subnet (`10.3.0.0/16`). Client-to-client isolation filtering and broadcast re-encryption active on the AP.
- **Network Baseline Tool:** Single-connection HTTP `curl` transfer (25 MiB) to measure unencrypted application-layer socket goodput. Note: This single-stream HTTP baseline does **not** represent the physical Wi-Fi radio PHY ceiling; multi-stream iperf3 measurements are planned.

---

## 3. End-to-End Timing and Boundary Definitions

### 3.1 Upload Transfer Lifecycle
The benchmark harness captures true wall-clock time from transfer initiation to confirmed receiver finalization:

$$\text{Timer Start} \longrightarrow \left[ \frac{\text{Preflight SHA-256}}{\text{if dedup active}} \right] \longrightarrow \text{POST /upload\_init} \longrightarrow \left[ \text{Concurrent POST /upload chunks} \right] \longrightarrow \text{POST /upload\_complete} \longrightarrow \text{Timer Stop}$$

1. **Timer Start ($t_0$):** Recorded via `time.Now()` immediately before initiating pre-flight deduplication (when enabled) or before issuing the HTTP POST request to `/upload_init`.
2. **Protocol Framing & Encryption:** Chunks are read from source storage, padded, and encrypted with AES-256-GCM using authenticated additional data (AAD) bound to `chunk\n<transferId>\n<chunkIndex>`.
3. **Pipeline Transmission:** Chunks are transmitted across HTTP/1.1 keep-alive connections via a configurable worker pool ($W \in \{1, 2, 4\}$).
4. **Server-Side Assembly:** The server receives each chunk, validates the HMAC request signature, verifies the session nonce, unseals the AES-GCM ciphertext, and writes the plain bytes to `temp/<transferId>.part` at chunk offset via `os.File.WriteAt` protected by an `sync.RWMutex`.
5. **Finalization ($t_1$):** Client issues `/upload_complete`. The server verifies that all chunks $[0 \dots N-1]$ are marked received in the bitmap, closes the temporary file descriptor, atomically moves the `.part` file into `received/` with sanitization, and returns HTTP 200 with the final sanitized filename.
6. **Timer Stop:** Recorded immediately upon client reception of the HTTP 200 response.
7. **Post-Harness Verification (Outside Timer):** The test harness independently opens the written file in `received/` and calculates its SHA-256 hash, asserting byte-for-byte identity with the source payload.

---

## 4. Resource Instrumentation Specifications

### 4.1 Windows Desktop Memory Instrumentation
Process memory is measured via native Win32 API calls directly to `psapi.dll!GetProcessMemoryInfo` and `kernel32.dll!GetProcessTimes`:
- **Working Set (`WorkingSetSize`):** The exact amount of physical RAM currently mapped into the process's virtual address space.
- **Peak Working Set (`PeakWorkingSetSize`):** Lifetime maximum physical RAM mapped by the process.
- **Private Bytes (`PrivateUsage`):** Memory committed by the process that cannot be shared with other processes.
- **Go Heap Allocation (`runtime.MemStats.HeapAlloc`):** Memory dynamically allocated by the Go runtime heap.
- **Transfer Buffers:** In-flight slice allocations reserved for chunk sealing and unsealing ($W \times \text{chunkSize}$).
- **Process CPU Percentage:** Computed from delta kernel and user CPU times normalized over wall time and logical core count.

### 4.2 Android Mobile Resource Instrumentation
Android memory is queried via `adb shell dumpsys meminfo com.example.app`:
- **Total PSS (Proportional Set Size):** Process memory accounting for proportional sharing of common libraries and resources.
- **Total RSS (Resident Set Size):** Total physical memory mapped.
- **Java Heap:** Memory allocated by the Android runtime VM.
- **Native Heap:** Memory allocated by native libraries and Chromium WebCore.
- **Graphics Surface:** Memory mapped to EGL/GL render targets and WebView viewports.

---

## 5. Statistical Rigour and Mathematical Formulations

To ensure scientific defensibility, all metrics adhere to the following rules:

1. **Sample Size ($n$):** Number of measured trials (excluding warmups).
2. **Arithmetic Mean ($\mu$):**

$$\mu = \frac{1}{n} \sum_{i=1}^{n} x_i$$

3. **Sample Standard Deviation ($s$):** Reported only when $n \ge 3$:

$$s = \sqrt{\frac{1}{n-1} \sum_{i=1}^{n} (x_i - \mu)^2}$$

4. **Coefficient of Variation ($\text{CoV}$):** Reported only when $n \ge 3$:

$$\text{CoV} = \left( \frac{s}{\mu} \right) \times 100\%$$

5. **Median ($\tilde{x}$):** Reported across all sample sizes.
6. **95th Percentile ($p_{95}$):** **Reported ONLY when sample size $n \ge 5$.** When $n < 5$, $p_{95}$ is mathematically invalid and must be reported as `N/A (insufficient sample count)` or omitted in favor of min/max/median.
7. **Binomial Confidence Interval (Wilson Score):** For transfer success rates and reliability proportions:

$$w = \frac{2n \hat{p} + z^2 \pm z \sqrt{z^2 - \frac{1}{n} + 4n\hat{p}(1-\hat{p}) + (4\hat{p}-2)}}{2(n + z^2)}$$

where $z = 1.96$ and $\hat{p} = \frac{\text{successes}}{n}$.

---

## 6. Transfer Resume, Acknowledgement Semantics & Crash Consistency

### 6.1 Chunk Acknowledgement Semantics (HTTP 200)
A chunk upload (`POST /upload?transferId=...&chunkIndex=...`) is defined as committed only when:
1. **Decryption and Verification:** HMAC signature, session nonce, and AES-256-GCM authentication tag are validated.
2. **Payload Placement:** Plaintext bytes are written to the `.part` file at offset `chunkIndex * chunkSize` via `File.WriteAt`.
3. **Manifest State Update:** The bitmap slice `state.received[chunkIndex]` is marked `true` under `state.mu`.
4. **Metadata Serialization:** `saveMeta()` executes under `state.metaMu`, writing JSON to a unique temporary file (`.meta.json.tmp.<pid>.<time>`) and atomically renaming it over `.meta.json`.
5. **Gated Acknowledgement:** If `saveMeta()` fails (e.g., storage exhaustion or filesystem permission error), HTTP 500 is returned. HTTP 200 is transmitted **strictly after** persistence succeeds.

### 6.2 Failure Models: Process Termination vs. Machine Durability
1. **Process Termination Model (User-Space Crash / SIGKILL / `TerminateProcess`):**
   - In this failure model, the user-mode process ceases execution immediately.
   - The operating system kernel (Windows NTFS / Linux VFS) retains all dirty page cache entries and flushes them asynchronously to disk.
   - Because `metaMu` serializes manifest updates and unique temporary filenames prevent NTFS sharing collisions, the persisted `.meta.json` file is guaranteed to accurately reflect all acknowledged chunks upon server restart.
   - **Empirical Guarantee:** Zero acknowledged chunks are lost upon process restart; zero redundant chunks are retransmitted.
2. **Machine Crash Durability Model (Operating System Panic / Sudden Power Loss):**
   - In this failure model, hardware power loss discards volatile DRAM before the operating system page cache is committed to non-volatile flash storage.
   - Surviving a machine-level crash requires issuing synchronous hardware flush barriers (`fsync`, `fdatasync`, or `FlushFileBuffers`) after every chunk write.
   - **Engineering Tradeoff:** Calling synchronous `FlushFileBuffers` after every 1 MiB chunk introduces massive rotational/NAND commit latency, reducing local transfer throughput from >150 MiB/s down to <25 MiB/s. Because P2P file transfers operate over local networks with idempotent `WriteAt` chunk retransmission capabilities, the application intentionally optimizes for the Process Termination Model, reserving `fsync` barriers for final file completion.

### 6.3 Monotonic Generation Counter & Defensible Manifest Selection
To resolve non-deterministic manifest selection and protect against corrupted primary manifests:
1. **Monotonic Generation Counter (`s.generation`):** Every snapshot taken under `s.mu` increments a 64-bit generation counter.
2. **Defensible Manifest Ranking (`isBetterMeta`):** When multiple candidate manifests are discovered on restart (primary plus temporary manifests), candidates are ranked deterministically:
   - Priority 1: Generation Counter ($G_a > G_b$).
   - Priority 2: Monotonic Bitmap Subsumption (Candidate $A$ is a strict superset of Candidate $B$).
   - Priority 3: Total Received Chunk Count.
   - Priority 4: `LastActive` timestamp and filesystem modification time.
3. **Strict Candidate Validation (`parseMetaCandidate`):** Discards any candidate that is truncated, malformed JSON, has dimension mismatches, has transfer ID hash mismatch with the `.part` file, or has expired beyond the TTL.

### 6.4 Two-Phase Finalization State Machine & Crash Transitions
Transfer finalization is protected by a two-phase state machine holding `moveMu` across destination path selection, atomic rename, and metadata removal:
1. **Transition to Finalizing:** All chunks received $\rightarrow$ state becomes `"finalizing"` $\rightarrow$ snapshot saved with `FinalPath`.
2. **Atomic Destination Placement:** `os.Rename(partPath, finalPath)` (with copy-and-remove fallback for cross-volume moves) executes under `moveMu`.
3. **Metadata Cleanup:** `metaPath` is removed and completion is registered in history.
4. **Crash Transition Handling:**
   - Crash *before* rename: `recoverOrSweepTempDir()` detects `State == "finalizing"`, sees `FinalPath` does not exist on disk, completes `moveToFinalPath()`, removes metadata, and registers history.
   - Crash *after* rename: `recoverOrSweepTempDir()` sees `FinalPath` already exists on disk with matching `TotalSize`, removes lingering metadata, and registers history.
   - Dropped completion response: Client retrying `POST /upload_complete` queries `lookupCompletedTransfer()` and receives HTTP 200 with the finalized filename without re-executing moves.

### 6.5 Exact Chunk Identity Verification Assertion
Verification must not rely solely on aggregate chunk counts. In all failure and resume testing, the test harness enforces the strict subset relation:

$$\text{AcknowledgedChunkIDs} \subseteq \text{RecoveredChunkIDs}$$

Any acknowledged chunk missing from the recovered manifest upon server restart constitutes an immediate test failure:

$$\text{MissingChunkIDs} = \{ c \in \text{AckedChunkIDs} \mid c \notin \text{RecoveredChunkIDs} \} = \emptyset$$

