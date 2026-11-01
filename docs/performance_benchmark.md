# P2P File Transfer — Performance Benchmark & Validation Report

**Project:** P2P Cross-Device File Transfer  
**Primary comparison:** LocalSend, Google Quick Share, KDE Connect  
**Initial platform focus:** Windows + Android  
**Benchmark objective:** Establish scientifically defensible, empirical baseline measurements for the application.  
**Audited & Reconciled:** 2026-10-31 (v2.1 Critical Review & Empirical Audit Release)

---

## 1. Benchmarking rules and measurement principles

Before comparing any numbers, keep these conditions consistent:

1. **Strict Non-Conflation:** Never compare or conflate local loopback (`127.0.0.1`), OS page cache, or memory writes with over-the-air physical Wi-Fi throughput.
2. **Explicit Client Attribution:** Distinguish between the native Go reference client (`p2pbench_arm64` via ADB) and the actual Capacitor Android application (`com.example.app`).
3. **Identical Testbed:** Physical tests executed on:
   - **Desktop:** Lenovo IdeaPad 3 15ITL6, Intel Core i5-1155G7, 16 GB DDR4, Intel 512GB NVMe SSD, Windows 11 Build 26300 (`10.3.232.1`).
   - **Mobile:** Nothing A059 (CMF Phone 1), Dimensity 7300, 8 GB RAM, Android 15 / Nothing OS 3.0 (`10.3.231.49`).
   - **Radio:** SRMIST Enterprise Wi-Fi AP, 5 GHz (UNII-2C, Channel 116, 5580 MHz, 802.11ax Wi-Fi 6, RSSI -60 dBm).
4. **Statistical Rigour:** Isolate warm-up trials. Report median, min, max, and CoV where $n \ge 3$. Omit $p_{95}$ when $n < 5$.
5. **No Speculative Superiority:** Mark competitor comparisons as **Not Tested Directly** until controlled side-by-side tests are performed under identical hardware and RF conditions.

---

## 2. Performance and resource consumption

| ID | Metric | How to measure | Competitor public reference | Proposed target | Current empirical value | Status / Classification |
|---|---|---|---|---|---|---|
| P-01 | Desktop idle RAM | Win32 PSAPI after 5 min idle | LocalSend: ~90 MB reported | ≤150 MB | **15.6 MiB Working Set (50.6 MiB Private Bytes)** | **Verified measurement** |
| P-02 | Desktop active RAM | Win32 PSAPI during 1 GiB transfer | LocalSend: ~180 MB reported | ≤250 MB | **46.0 MiB Peak Working Set (79.2 MiB Private Bytes)** | **Verified measurement** |
| P-03 | Android idle RAM | `dumpsys meminfo` (Capacitor baseline) | LocalSend: ~120 MB reported | ≤100 MB | **120.4 MB PSS / 206.4 MB RSS** *(Capacitor WebView runtime)* | **Verified measurement** |
| P-04 | Android active RAM | `dumpsys meminfo` during transfer | LocalSend: ~220 MB reported | ≤200 MB | **139.5 MB PSS (279.9 MB RSS)** | **Verified measurement** |
| P-05 | Desktop idle CPU | Process CPU over 5 min idle | LocalSend: ~0.1–0.3% reported | ≤1% | **0.000% of single core (0.0000% of host)** | **Verified measurement** |
| P-06 | Android idle CPU | CPU over 5 min idle | Not publicly established | As close to 0% as practical | **0.0%** | **Verified measurement** |
| P-07 | Desktop server readiness | Cold launch to HTTP port ready | Not publicly established | ≤3 seconds | **183 ms mean (130–214 ms across 10 cold starts)** | **Verified (Server HTTP only)** |
| P-07b | Desktop UI interactive startup | Cold launch to interactive GUI | LocalSend: ~2.1 s reported | ≤3 seconds | *Pending measurement via frame capture / ETW* | **Pending test** |
| P-08 | Android app cold launch | Cold launch to interactive UI | LocalSend: ~1.4 s reported | ≤3 seconds | **0.82 seconds median (727–1,154 ms)** | **Preliminary measurement** |
| P-09 | Discovery CPU overhead | CPU during UDP/HTTP discovery | Not publicly established | Minimal; no continuous CPU load | **<0.1% CPU (<0.01 ms per probe response)** | **Verified measurement** |
| P-10 | Idle network traffic | Bytes transferred while idle | Not publicly established | No unnecessary continuous traffic | **0 bytes (event-driven, 0 idle keepalive flood)** | **Verified measurement** |
| P-11 | Memory growth with file size | Working Set across 1 MiB..1 GiB | Not publicly established | RAM must not grow proportionally with file size | **Preliminary bounded streaming: 20.9 MiB WS (1 MiB) vs 36.1 MiB (100 MiB) vs 46.0 MiB (1 GiB)** | **Preliminary (10GB pending)** |
| P-12 | Battery consumption | Android battery drain during 30 min | LocalSend: ~1.8–2.5% / 30 min | Lower than measured competitors | **~1.2% / 30 min (Active 5 GHz transfer on CMF Phone 1)** | **Preliminary measurement** |

---

## 3. File transfer throughput and speed

| ID | Metric | How to measure | Competitor public reference | Proposed target | Current empirical value | Status / Classification |
|---|---|---|---|---|---|---|
| T-00 | Raw HTTP Baseline (Wi-Fi) | 25 MiB single-stream `curl` | Link PHY: 432 Mbps (54 MB/s) | Network baseline | **Uplink: 4.82 MiB/s mean ($n=3$); Downlink: 1.26 MiB/s mean ($n=3$)** | **Preliminary (curl only)** |
| T-01 | Wi-Fi throughput (Phone $\rightarrow$ PC) | Go reference client via ADB | LocalSend: 16–51 MB/s reported; Quick Share: 27.8–66.7 MB/s | ≥85% of network baseline | **10 MiB: 7.47 MiB/s mean ($n=2$); 25 MiB: 8.27 MiB/s mean ($n=2$)** | **Preliminary (Go Client)** |
| T-01b | Real Android App Wi-Fi speed | Capacitor App $\rightarrow$ PC | Same reference ranges | ≥85% of network baseline | *Pending physical automation of Capacitor client* | **Pending test** |
| T-02 | Loopback TCP single file | Go client $\rightarrow$ `p2p.exe` (1 GiB) | LocalSend: ~120–150 MB/s | High crypto efficiency | **160.8 MiB/s mean (140.2–172.7 MiB/s, CoV 11.1%, $n=3$)** | **Verified measurement** |
| T-03 | Very large file (10 GB, 30 GB) | Multi-gigabyte single file | No universal public baseline | Stable throughput | *Pending physical disk run for 10 GB and 30 GB* | **Pending test** |
| T-04 | Windows $\rightarrow$ Android speed | PC $\rightarrow$ Mobile over Wi-Fi | Quick Share: 27.8 / 66.7 MB/s reported | Match network capability | **1.26 MiB/s mean (0.39–2.13 MiB/s; constrained by AP isolation)** | **Preliminary (curl baseline)** |
| T-05 | Transfer speed stability | CoV on repeated Wi-Fi runs | Not publicly established | ≤15% variation | **7.0% CoV on 25 MiB Wi-Fi transfers ($n=2$)** | **Preliminary ($n=2$)** |
| T-06 | Small files (Loopback) | 100 files × 100 KiB (4 workers) | Not publicly established | High batch efficiency | **41.0 files/s median (2.44 s, 4.0 MiB/s; p50: 84 ms, p95: 114 ms)** | **Verified measurement** |
| T-07 | Mixed files (Loopback) | 100 files (4 KiB–4 MiB) | Not publicly established | High batch efficiency | **33.8 files/s median (2.96 s, 35.9 MiB/s; p50: 81 ms, p95: 300 ms)** | **Verified measurement** |
| T-08 | Small files (Wi-Fi) | 25 files × 100 KiB via Go client | Not publicly established | Match network capability | **34.9 files/s median (0.72 s, 3.41 MiB/s, $n=2$)** | **Preliminary (25 files)** |
| T-08b | Small files (Real Android App) | 100, 1k, 10k files via App | Not publicly established | Beat measured competitors | *Pending physical automation of Capacitor client* | **Pending test** |
| T-09 | Setup latency | First request to first byte | Not publicly established | ≤1 second | **1.02 ms (Loopback) / ~88 ms (Wi-Fi round-trip)** | **Verified measurement** |
| T-10 | Completion overhead | Last byte sent to verified 200 | Not publicly established | ≤2 seconds | **21.9 ms (Atomic move & bitmap check)** | **Verified measurement** |
| T-11 | Concurrent streams (Loopback) | 1, 2, 5 streams (64 MiB each) | Not publicly established | Linear scaling | **Aggregate: 141.3 (1s) $\rightarrow$ 182.7 (2s) $\rightarrow$ 183.9 MiB/s (5s); ~38.5 MiB/s/stream** | **Verified measurement** |

---

## 4. Transfer reliability and fault recovery

| ID | Metric | How to measure | Competitor public reference | Proposed target | Current empirical value | Status / Classification |
|---|---|---|---|---|---|---|
| R-01 | Controlled transfer success | Successes / attempts | Not publicly established | ≥99% | **100% across all completed test runs (Wilson 95% CI: [0.701, 1.000])** | **Verified measurement** |
| R-02 | File integrity verification | SHA-256 match on received files | LocalSend supports checksums | 100% verified | **100% (SHA-256 matched on all completed transfers)** | **Verified measurement** |
| R-03 | Interrupted client recovery | Client socket abort at 25, 50, 75% | LocalSend resume varies | Resume without zero restart | **100% recovered; 0 redundant chunks retransmitted** | **Verified measurement** |
| R-04 | Server crash recovery | Server SIGKILL at 25, 50, 75% | Not publicly established | Recover valid state | **100% recovered; 0 lost acknowledged chunks, 0 redundant chunks retransmitted (206/206 tests PASS across T1..T10 and E1..E10)** | **Verified measurement** |
| R-05 | Network reconnection time | Re-handshake after drop | Not publicly established | ≤10 seconds | **1.4 seconds** | **Verified measurement** |
| R-06 | Duplicate file prevention | Check output filenames | Not publicly established | 0 unintended duplicates | **0 duplicate files (clean indexing for distinct uploads)** | **Verified measurement** |
| R-07 | Corruption detection | Bit-flipped chunk ciphertext | LocalSend supports checksums | 100% detected | **100% detected (AES-GCM tag failure returns HTTP 400)** | **Verified measurement** |
| R-08 | 10 GB+ completion rate | Continuous large transfer | Not publicly established | ≥99% | *Pending execution of 10 GB file transfer* | **Pending test** |
| R-09 | Long-duration stability | Continuous cycling for 1 hour | Not publicly established | 0 crashes or leaks | **0 crashes, 0 deadlocks across continuous stress testing** | **Verified measurement** |

---

## 5. Security and adversarial testing

| ID | Metric | Test method | Target | Current empirical value | Status / Classification |
|---|---|---|---|---|---|
| S-01 | Encryption in transit | Inspect protocol frames | Modern authenticated cipher | **AES-256-GCM on all chunk payloads and metadata; TLS optional via `-tls`** | **Verified measurement** |
| S-02 | Device authentication | Probe from unpaired device | Reject unauthorized calls | **100% rejected with HTTP 401 across all 10 endpoints** | **Verified measurement** |
| S-03 | Pairing security | HMAC-SHA256 QR secret | Secure key exchange | **HMAC-SHA256 verified pairing secret; brute-force locked at attempt 4** | **Verified measurement** |
| S-04 | Replay protection | Replay captured valid request | Reject duplicate nonces | **100% rejected (1st request: 200, replayed request: 401)** | **Verified measurement** |
| S-05 | Path traversal defense | 14 directory escape patterns | 0 escapes outside `received/` | **100% safe (all 14 patterns contained inside `received/`; 0 escapes)** | **Verified measurement** |
| S-06 | Integrity verification | Bit-flipped ciphertext | Reject invalid chunks | **100% rejected with HTTP 400 (AES-GCM authentication tag check)** | **Verified measurement** |
| S-07 | Credential storage at rest | Inspect `state.json` on disk | OS keystore / encrypted | **Finding SEC-01: Stored in plaintext base64; DPAPI/Keystore migration planned** | **Architectural Finding** |
| S-08 | DoS / Slowloris defense | Incomplete HTTP header trickle | Server timeout $\le 30$ s | **Finding SEC-02: Connection open after 35s; `ReadHeaderTimeout` required** | **Architectural Finding** |
| S-09 | Data privacy | Outbound network monitoring | Zero cloud telemetry | **100% local traffic (0 cloud analytical or telemetry calls)** | **Verified measurement** |
| S-10 | Device revocation | Revoke device via `/unpair` | Reject subsequent calls | **100% immediate revocation (subsequent calls return HTTP 401)** | **Verified measurement** |

---

## 6. Honest Competitive Scorecard

> [!NOTE]
> Competitor values below are published observations from external sources under varying hardware and radio conditions. Controlled side-by-side benchmarking under identical conditions is **Pending** (PEND-06).

| Evaluation Category | P2P Link (Empirical) | Competitor Public Reference | Direct Test Status | Current Verdict |
|---|---|---|---|---|
| **Desktop Idle RAM** | **15.6 MiB Working Set** | LocalSend: ~90 MB reported | Not Tested Directly | **Preliminary Lead (Go vs Flutter)** |
| **Active Transfer RAM** | **46.0 MiB Peak WS (1 GB)** | LocalSend: ~180 MB reported | Not Tested Directly | **Preliminary Lead (Bounded streaming)** |
| **Desktop Server Readiness** | **183 ms (Cold Port Bind)** | LocalSend: ~2.1 s reported | Not Tested Directly | **Preliminary Lead (CLI engine)** |
| **Discovery Latency** | **5.45 ms (UDP packet)** | LocalSend: ~400–1200 ms reported | Not Tested Directly | **Preliminary Lead (LAN broadcast)** |
| **Physical Wi-Fi Speed** | **5.26–8.68 MiB/s (Go Client)** | LocalSend: 16–51 MB/s reported | Not Tested Directly | **Not Proven (Different network conditions)** |
| **Small-File Throughput** | **41.0 files/s (Loopback, 100 files)** | LocalSend: ~14 s reported for 1k | Not Tested Directly | **Not Proven (Loopback vs Wi-Fi)** |
| **Interrupted Resume** | **0 redundant chunks (Abort & Process Kill, 206/206 PASS across T1..T10 and E1..E10)** | LocalSend: Reported inconsistent | Not Tested Directly | **Verified Robust (Crash-consistent generation & state-machine finalization)** |
| **Android Background Transfer** | **Maintained with Foreground Service** | LocalSend: Background kills reported | Not Tested Directly | **Competitive with FGS active** |
| **Credential Storage at Rest** | **Plaintext base64 in `state.json`** | LocalSend: Encrypted storage | Not Tested Directly | **Needs Improvement (Finding SEC-01)** |
