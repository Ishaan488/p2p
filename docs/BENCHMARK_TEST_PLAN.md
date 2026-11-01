# P2P Transfer Benchmark Test Plan

**Document Version:** 2.1.0  
**Status:** Approved  
**Author:** QA Engineering & Systems Testing Team

---

## 1. Overview and Test Taxonomy

This test plan partitions all benchmark and reliability requirements into four distinct execution categories:
1. **Category 1 (Automated Go Loopback & Desktop Suite):** Fully automated via `bench.exe`, validating desktop server memory, startup, crypto, and local protocol scaling.
2. **Category 2 (Automated Go Reference-Client over Wi-Fi):** Native `p2pbench_arm64` cross-compiled binary executed via ADB shell on Android, validating over-the-air protocol efficiency independent of WebView.
3. **Category 3 (Pending Real Android Capacitor Application Suite):** Tests executed from the actual Capacitor Android app (`com.example.app`), exercising Chromium WebView, WebCrypto SubtleCrypto, and Android Scoped Storage.
4. **Category 4 (Pending Extended & Competitor Validation Suite):** Controlled side-by-side competitor tests (LocalSend, Quick Share, KDE Connect) on identical hardware, multi-stream iperf3 baselines, 10 GB+ extreme large-file transfers, and multi-vendor OEM power management tests.

---

## 2. Test Execution Matrix

| Test Suite ID | Scenario | Client & Target | Automation Method | Metric Captured | Current Status |
|---|---|---|---|---|---|
| **AUTO-01** | Process Idle Resource Profile | Desktop `p2p.exe` | `bench idle -secs 60` | Working Set, Private Bytes, CPU % | **Verified** (15.6 MiB WS, 50.6 MiB Priv, 0.000% CPU) |
| **AUTO-02** | Cold Server Startup Readiness | Desktop `p2p.exe` | `bench startup -n 10` | Port bind & HTTP 200 ready | **Verified** (183 ms mean, 130–214 ms) |
| **AUTO-03** | Single-File Loopback Scaling | Go Client $\rightarrow$ `p2p.exe` | `bench single -sizes 1MiB..1GiB` | Loopback goodput, WS bounds | **Verified** (160.8 MiB/s @ 1 GiB, Peak WS 46 MiB) |
| **AUTO-04** | Small-File Batch (100 files) | Go Client $\rightarrow$ `p2p.exe` | `bench small -n 100 -fsize 100KiB` | Rate (files/s), per-file latency | **Verified** (41.0 files/s, median 84 ms) |
| **AUTO-05** | Concurrent Stream Scaling | Go Client $\rightarrow$ `p2p.exe` | `bench concurrent -n 1,2,5` | Aggregate vs per-stream goodput | **Verified** (183.9 MiB/s aggregate, ~38.5 MiB/s/stream) |
| **AUTO-06** | Interrupted Resume Durability & Crash Safety | Go Client $\rightarrow$ `p2p.exe` | `bench failure -reps 10` | Recovery, chunk identities, retransmissions, edge cases | **Verified (206/206 PASS across T1..T10 and E1..E10; 0 missing chunks, 0 retransmitted)** |
| **AUTO-07** | Automated Security Audit | Desktop `p2p.exe` | `bench security` | Traversal, replay, HMAC, lockout | **Verified** (33 PASS, 4 Findings/Artifacts) |
| **AUTO-08** | Single-Connection HTTP Baseline | `curl` $\rightarrow$ Go Server | `bench tcpbase -mb 25` | Raw HTTP goodput (curl) | **Preliminary** (4.82 MiB/s up, 1.26 MiB/s down, $n=3$) |
| **AUTO-09** | Go Client over Wi-Fi (Single) | Go Arm64 Client $\rightarrow$ PC | `bench wifi -mode single` | Over-the-air goodput | **Preliminary** (7.47–8.27 MiB/s, $n=2$ per size) |
| **AUTO-10** | Go Client over Wi-Fi (Small 25) | Go Arm64 Client $\rightarrow$ PC | `bench wifi -mode small -n 25` | Over-the-air small-batch rate | **Preliminary** (3.41 MiB/s, 34.9 files/s, $n=2$) |
| **PEND-01** | Real Android App Single Transfer | Capacitor App $\rightarrow$ PC | App UI / Appium Automation | WebCrypto Wi-Fi goodput | **Pending Test** |
| **PEND-02** | Real Android App Small Batch (100) | Capacitor App $\rightarrow$ PC | App UI / Appium Automation | WebCrypto batch rate (files/s) | **Pending Test** |
| **PEND-03** | Real Android App Small Batch (1k, 10k) | Capacitor App $\rightarrow$ PC | App UI / Appium Automation | High-volume batch scalability | **Pending Test** |
| **PEND-04** | Multi-Stream Network Baseline | PC $\longleftrightarrow$ Phone | `iperf3` (1, 2, 4 streams) | Physical radio throughput ceiling | **Pending Test** |
| **PEND-05** | Extreme Large File (10 GB, 30 GB) | Desktop `p2p.exe` | Automated disk stream | Memory bounds, finalization time | **Pending Test** |
| **PEND-06** | Side-by-Side Competitor Benchmarks | LocalSend, Quick Share, KDE | Controlled identical testbed | Throughput, RAM, and battery delta | **Pending Test** |
| **PEND-07** | User-Perceived Application Startup | Desktop GUI / Mobile App | Video frame analysis / ETW | Time to first interactive render | **Pending Test** |

---

## 3. Specifications for Pending Tests

### 3.1 PEND-01 & PEND-02: Real Android Capacitor Application Automation
- **Objective:** Measure actual over-the-air throughput and memory of the Capacitor hybrid mobile app (`com.example.app`) using JavaScript WebCrypto (`crypto.subtle`).
- **Prerequisites:** Physical Nothing CMF Phone 1 connected to same 5 GHz AP.
- **Harness:** Appium or Android Instrumentation test driving the WebView file input and clicking "Send".
- **Measurements to Record:**
  - Transfer duration from file selection to completion toast.
  - Process PSS, RSS, and Java/Native heap via `dumpsys meminfo`.
  - Battery consumption percentage delta via `dumpsys battery`.
  - Android foreground service notification responsiveness.

### 3.2 PEND-04: Multi-Stream iperf3 Radio Baseline
- **Objective:** Determine true physical Wi-Fi radio throughput independent of HTTP application framing.
- **Prerequisites:** Cross-compile `iperf3` for Android arm64 and deploy to `/data/local/tmp/iperf3`.
- **Test Matrix:**
  - 1 Stream Uplink & Downlink (TCP window size: auto, 512 KB, 2 MB).
  - 4 Parallel Streams Uplink & Downlink (`iperf3 -P 4`).
  - UDP 100 Mbps / 500 Mbps jitter and packet loss profile.

### 3.3 PEND-06: Controlled Side-by-Side Competitor Benchmarking
- **Objective:** Directly compare P2P Link against LocalSend v1.14.0 and Google Quick Share v1.0.2 under identical radio, hardware, and payload conditions.
- **Rules:**
  1. Identical PC (Lenovo IdeaPad 3) and identical phone (Nothing CMF Phone 1).
  2. Identical 5 GHz Wi-Fi 6 AP (Channel 116, RSSI -60 dBm).
  3. Identical payloads: 100 MB single file, 1 GB single file, 100 × 100 KB small files.
  4. 5 repeated trials per competitor, with isolated warm-up trial.
  5. Simultaneous background resource logging (Win32 PSAPI for desktop, `dumpsys meminfo` for Android).
