# P2P File Transfer — Competitive Performance Benchmark Report

**Project:** P2P Cross-Device File Transfer  
**Primary comparison:** LocalSend, Google Quick Share, KDE Connect  
**Initial platform focus:** Windows + Android  
**Benchmark objective:** Measure whether the application is measurably faster, lighter, more reliable and easier to use than competing solutions.

---

## 1. Benchmarking rules

Before comparing any numbers, keep these conditions consistent:

1. Use the same Windows PC and Android phone for every application.
2. Use the same Wi-Fi router, frequency band, distance and network configuration.
3. Test both Windows → Android and Android → Windows.
4. Use the same files, file sizes and file counts.
5. Run each test at least five times; record median and p95 where applicable.
6. Record application versions, OS versions, hardware and network conditions.
7. Separate cold-start and warm-start measurements.
8. Test both foreground and background operation.
9. Record failures and incomplete transfers, not just successful runs.
10. Compare against the same version of each competitor throughout a test cycle.

**Important:** Competitor reference values below are published or reported observations, not universal performance guarantees. `Not publicly established` means you must measure that competitor yourself.

---

## 2. Performance and resource consumption

| ID | Metric | How to measure | Competitor reference | Your target | Your current value |
|---|---|---|---|---|---|
| P-01 | Desktop idle RAM | Average RAM after 5 minutes idle | Not publicly established | ≤150 MB | |
| P-02 | Desktop active RAM | RAM during an ongoing large-file transfer | Not publicly established | ≤250 MB | |
| P-03 | Android idle RAM | Average RAM after 5 minutes idle | Not publicly established | ≤100 MB | |
| P-04 | Android active RAM | RAM during a large-file transfer | Not publicly established | ≤200 MB | |
| P-05 | Desktop idle CPU | Average CPU usage over 5 minutes | Not publicly established | ≤1% | |
| P-06 | Android idle CPU | Average CPU usage over 5 minutes | Not publicly established | As close to 0% as practical | |
| P-07 | Desktop startup time | Cold launch to usable interface | Not publicly established | ≤3 seconds | |
| P-08 | Android startup time | Cold launch to usable interface | Not publicly established | ≤3 seconds | |
| P-09 | Discovery CPU overhead | CPU consumed during device discovery | Not publicly established | Minimal; no continuous high CPU usage | |
| P-10 | Idle network traffic | Bytes transferred over 5 minutes while idle | Not publicly established | No unnecessary continuous traffic | |
| P-11 | Memory growth with file size | Compare RAM while transferring 100 MB, 1 GB and 10 GB | Not publicly established | RAM must not grow proportionally with file size | |
| P-12 | Battery consumption | Android battery drain during a 30-minute idle and transfer test | Not publicly established | Lower than measured competitors under identical conditions | |

**Interpretation:** A low RAM number alone does not prove that an application is lightweight. Measure CPU, background network traffic, battery usage and startup time too.

---

## 3. File transfer throughput and speed

Published reference observations:

- LocalSend: approximately 16–51 MB/s across reported tests.
- Quick Share: approximately 27.8–66.7 MB/s in reported tests; a separate Wi-Fi Direct result reported 100 MB/s.
- KDE Connect: one reported 30 GB transfer achieved approximately 6.25 MB/s.

These are not directly comparable because the test conditions differ. Your own controlled tests must establish the real comparison.

| ID | Metric | How to measure | Competitor reference | Your target | Your current value |
|---|---|---|---|---|---|
| T-01 | Single-file throughput | Average MB/s for a 1 GB file | LocalSend: reported 16–51 MB/s; Quick Share: reported 27.8–66.7 MB/s | ≥85% of measured TCP network baseline | |
| T-02 | Large-file throughput | Average MB/s for a 10 GB file | Same reference ranges; not a controlled comparison | ≥85% of measured TCP network baseline | |
| T-03 | Very large-file throughput | Average MB/s for a 30 GB file | No reliable universal baseline | Maintain stable throughput without excessive degradation | |
| T-04 | Windows → Android speed | Average MB/s | Quick Share: reported 27.8 MB/s and 66.7 MB/s in different tests | Match or exceed the best competitor on the same device pair | |
| T-05 | Android → Windows speed | Average MB/s | LocalSend and Quick Share have reported results; conditions vary | Match or exceed the best competitor on the same device pair | |
| T-06 | Transfer speed stability | Standard deviation or coefficient of variation | Not publicly established | ≤15% variation under stable network conditions | |
| T-07 | Small-file transfer speed | Time to transfer 1,000 files of 100 KB each | Not publicly established | Beat the best measured competitor | |
| T-08 | Mixed-file transfer speed | Time to transfer 1,000 files of mixed sizes | Not publicly established | Beat the best measured competitor | |
| T-09 | Folder transfer throughput | Total folder size divided by elapsed time | Not publicly established | ≥85% of measured TCP baseline for suitable workloads | |
| T-10 | Transfer setup latency | Time from accepting transfer to first byte | Not publicly established | ≤1 second on a healthy LAN, where practical | |
| T-11 | Transfer completion overhead | Time from last byte sent to verified completion | Not publicly established | ≤2 seconds for ordinary large-file transfers | |
| T-12 | Concurrent transfer throughput | Aggregate MB/s with 2, 3 and 5 simultaneous transfers | Not publicly established | Maintain ≥80% of single-transfer aggregate throughput where hardware permits | |

**Measurement note:** Use `iperf3` to establish the network's actual TCP throughput. Do not compare your application against theoretical Wi-Fi speeds. A 1 Gbps Wi-Fi link does not guarantee 125 MB/s application throughput.

---

## 4. Transfer reliability and recovery

This is one of the most important areas where your application could establish a meaningful advantage.

| ID | Metric | How to measure | Competitor reference | Your target | Your current value |
|---|---|---|---|---|---|
| R-01 | Successful transfer rate | Successful transfers / total attempts | Not publicly established | ≥99% in controlled healthy-network tests | |
| R-02 | File integrity success | Percentage of completed files passing hash verification | LocalSend supports checksums; comparable rates unpublished | 100% of completed transfers verified | |
| R-03 | Interrupted transfer recovery | Disconnect network during transfer and reconnect | LocalSend resume behaviour must be tested on current release | Automatically recover without restarting from zero | |
| R-04 | Resume efficiency | Bytes retransmitted after interruption | Not publicly established | Retransmit only unverified/incomplete chunks | |
| R-05 | App restart recovery | Restart sender or receiver during transfer | Not publicly established | Recover valid persisted transfer state | |
| R-06 | Network reconnection time | Time from network restoration to resumed transfer | Not publicly established | ≤10 seconds where network discovery permits | |
| R-07 | Duplicate transfer prevention | Check whether recovery creates duplicate files | Not publicly established | Zero unintended duplicate outputs | |
| R-08 | Corruption detection | Modify or corrupt a test chunk | LocalSend supports checksum verification | Detect every deliberately introduced corruption | |
| R-09 | Large-file completion rate | Successful completion of 10 GB and 30 GB test files | Not publicly established | ≥99% across repeated controlled tests | |
| R-10 | Multiple-file failure handling | Interrupt one file in a batch | Not publicly established | Recover failed files without corrupting completed files | |
| R-11 | Queue recovery | Restart application with pending transfers | Not publicly established | Restore valid queue and transfer status | |
| R-12 | Long-duration stability | Run continuous transfers for 1 hour | Not publicly established | No crash, deadlock or unhandled transfer failure | |

---

## 5. Android background performance

This deserves its own test category. A transfer application that only works while its screen is open has a significant practical limitation.

| ID | Metric | How to measure | Competitor reference | Your target | Your current value |
|---|---|---|---|---|---|
| A-01 | Background transfer success | Complete a 5 GB transfer while using another app | LocalSend has had reported background-transfer issues; its current release includes background-transfer improvements | 100% in the defined test suite | |
| A-02 | Screen-off transfer success | Turn off screen during a 5 GB transfer | Must be tested on current releases | 100% in the defined test suite | |
| A-03 | Background duration | Run a transfer for 30 minutes in background | Not publicly established | Complete without interruption | |
| A-04 | Background battery drain | Measure battery percentage consumed during transfer | Not publicly established | Lower than measured competitors | |
| A-05 | Background memory stability | Track RAM throughout the transfer | Not publicly established | No uncontrolled memory growth | |
| A-06 | Notification responsiveness | Measure delay in progress/completion notifications | Not publicly established | ≤2 seconds for important status updates, where OS permits | |
| A-07 | App lifecycle recovery | Minimize, reopen and switch apps during transfer | Not publicly established | Transfer state remains consistent | |
| A-08 | Battery optimization resilience | Test with Android battery restrictions enabled | Behaviour varies by Android vendor and OS | Clearly handle supported background execution restrictions | |

---

## 6. Device discovery and connectivity

| ID | Metric | How to measure | Competitor reference | Your target | Your current value |
|---|---|---|---|---|---|
| C-01 | Device discovery latency | Time from opening app to discovering another device | Not publicly established | ≤3 seconds on a healthy LAN | |
| C-02 | Discovery success rate | Successful discovery attempts / total attempts | Not publicly established | ≥99% in supported network configurations | |
| C-03 | Reconnection latency | Time to rediscover a device after temporary disconnection | Not publicly established | ≤5 seconds after connectivity returns, where practical | |
| C-04 | Network-change recovery | Switch Wi-Fi network or change IP address | Not publicly established | Automatically rediscover devices | |
| C-05 | Hotspot compatibility | Test Android hotspot and Windows hotspot | Not publicly established | Reliable discovery and transfer on supported hotspot configurations | |
| C-06 | Firewall handling | Test with Windows firewall enabled | Quick Share documents network troubleshooting; LocalSend provides troubleshooting support | Clear diagnosis and actionable recovery guidance | |
| C-07 | Client-isolation detection | Test on guest Wi-Fi/client-isolated networks | Network restrictions can prevent device-to-device sharing | Explain the limitation instead of silently failing | |
| C-08 | Simultaneous device discovery | Discover 5, 10 and 20 devices | Not publicly established | No significant discovery degradation | |
| C-09 | Manual connection reliability | Connect using IP and port | Not publicly established | Reliable fallback when automatic discovery fails | |
| C-10 | IPv4/IPv6 compatibility | Test supported network configurations | LocalSend documents IPv6 support | Reliable operation across supported IP configurations | |

---

## 7. Usability and workflow efficiency

These metrics measure how quickly a real user can complete common tasks.

| ID | Metric | How to measure | Competitor reference | Your target | Your current value |
|---|---|---|---|---|---|
| U-01 | First-time pairing time | Start app to successful first pairing | Not publicly established | ≤15 seconds | |
| U-02 | Repeat-send interaction count | Number of actions to send to a trusted device | Not publicly established | ≤2–3 user actions | |
| U-03 | Send initiation time | Time from selecting a file to starting transfer | Not publicly established | ≤5 seconds | |
| U-04 | Failed-transfer recovery actions | Number of actions needed to retry/recover | Not publicly established | Minimal; automatic recovery where possible | |
| U-05 | Explorer integration | Test sending through Windows Explorer | Quick Share and LocalSend have Windows integration capabilities | Native, reliable send workflow | |
| U-06 | Android Share Sheet integration | Send files from other Android applications | LocalSend supports Android sharing | Reliable native share workflow | |
| U-07 | Drag-and-drop workflow | Drop files into desktop application | Must be tested on current releases | Immediate, predictable transfer workflow | |
| U-08 | User-visible error clarity | Evaluate whether users can understand and resolve failures | Not publicly established | Every common failure has a useful explanation and next step | |
| U-09 | Transfer progress accuracy | Compare displayed progress with actual bytes transferred | Not publicly established | Progress reflects actual transfer state | |
| U-10 | Transfer history accuracy | Compare history with actual transfer events | Not publicly established | No missing or incorrect completed/failed records | |

---

## 8. Security and privacy

| ID | Metric | How to measure | Competitor reference | Your target | Your current value |
|---|---|---|---|---|---|
| S-01 | Encryption in transit | Inspect protocol and verify encrypted transport | LocalSend supports encrypted transfers; compare current implementations | Modern authenticated encryption for all transfer data | |
| S-02 | Device authentication | Attempt connection from an untrusted device | Competitors provide device-approval/security mechanisms; test current behaviour | No unauthorized transfer acceptance | |
| S-03 | Pairing security | Review key exchange and device identity design | Not comparable through a single public metric | Documented, reviewed secure pairing protocol | |
| S-04 | Replay protection | Attempt replay of captured requests | Not publicly established | Reject replayed authentication/transfer requests | |
| S-05 | File path safety | Test path traversal and malicious filenames | Not publicly established | Zero successful unsafe path writes in security tests | |
| S-06 | Integrity verification | Modify data in transit or stored chunks | LocalSend supports checksums | Detect all deliberately introduced corruption | |
| S-07 | Credential/key storage | Inspect local storage and OS secure-storage usage | Not publicly established | No plaintext sensitive credentials or private keys | |
| S-08 | Security test findings | Run dependency scans, static analysis and security testing | No directly comparable public score | Zero unresolved critical/high-severity findings at release | |
| S-09 | Data privacy | Inspect outbound network requests | Local-first competitors generally support local transfer | No unnecessary external transmission | |
| S-10 | Device revocation | Revoke a previously trusted device and attempt reconnection | Must be tested on current releases | Revoked devices cannot reconnect without re-pairing | |

---

## 9. Scalability and stress testing

| ID | Metric | How to measure | Competitor reference | Your target | Your current value |
|---|---|---|---|---|---|
| SC-01 | Simultaneous connected devices | Test 5, 10 and 20 devices | Not publicly established | Support 20 devices without major degradation | |
| SC-02 | Simultaneous transfers | Test 2, 5 and 10 transfers | Not publicly established | Support at least 5 concurrent transfers reliably | |
| SC-03 | Large queue handling | Queue 100 files | Not publicly established | No UI freeze or lost queue entries | |
| SC-04 | Many-small-files handling | Transfer 10,000 small files | Not publicly established | Complete without crashes or uncontrolled memory growth | |
| SC-05 | Long-duration operation | Run application continuously for 8 hours | Not publicly established | No memory leak or progressive performance degradation | |
| SC-06 | Memory leak detection | Compare memory after repeated transfer cycles | Not publicly established | No sustained unexplained memory growth | |
| SC-07 | Failure under load | Stress CPU, memory and network while transferring | Not publicly established | Graceful degradation, no silent corruption | |

---

## 10. Standard benchmark test scenarios

Run the same scenarios on your application and each competitor.

| Test ID | Scenario | Test payload | Repetitions | Result to record |
|---|---|---|---|---|
| B-01 | Small single file | 10 MB | 5 | Time, speed, success |
| B-02 | Medium single file | 100 MB | 5 | Time, speed, success |
| B-03 | Large single file | 1 GB | 5 | Time, speed, RAM, CPU |
| B-04 | Very large single file | 10 GB | 5 | Time, speed, RAM, CPU |
| B-05 | Extreme large file | 30 GB | 3 | Completion, stability, RAM |
| B-06 | Many small files | 1,000 × 100 KB | 5 | Total time, failures |
| B-07 | Many mixed files | 1,000 files, mixed sizes | 5 | Total time, failures |
| B-08 | Folder transfer | 5 GB folder | 5 | Time, structure preservation |
| B-09 | Interrupted transfer | 10 GB; disconnect at 50% | 5 | Recovery time, retransmitted bytes |
| B-10 | Background transfer | 5 GB; switch apps and lock screen | 5 | Completion, time, battery |
| B-11 | Network switching | Transfer while changing networks | 5 | Recovery time, success |
| B-12 | Concurrent transfers | 5 simultaneous 1 GB transfers | 3 | Aggregate throughput, RAM, CPU |
| B-13 | Long-duration test | Continuous transfers for 1 hour | 3 | Stability, memory growth |
| B-14 | Cold-start discovery | Restart both devices and discover | 5 | Discovery latency |
| B-15 | Repeated transfer cycles | 50 consecutive transfers | 3 | Failure rate, memory growth |

---

## 11. Benchmark environment record

Complete this before each benchmark session.

| Parameter | Value |
|---|---|
| Windows PC model | |
| CPU | |
| RAM | |
| Storage type | |
| Windows version | |
| Android phone model | |
| Android version | |
| Android RAM | |
| Router model | |
| Wi-Fi band | |
| Wi-Fi standard | |
| Approximate distance from router | |
| Network topology | |
| Internet connection enabled? | |
| Application version | |
| Competitor versions | |
| Test date | |
| Background apps/processes | |

---

## 12. Final competitive scorecard

Use this table after completing the tests.

| Category | Your result | Best measured competitor | Difference | Status |
|---|---|---|---|---|
| Idle RAM | | | | |
| Active RAM | | | | |
| Idle CPU | | | | |
| Startup time | | | | |
| Discovery latency | | | | |
| Single-file throughput | | | | |
| Large-file throughput | | | | |
| Small-file workload | | | | |
| Transfer success rate | | | | |
| Resume efficiency | | | | |
| Android background reliability | | | | |
| Battery consumption | | | | |
| Network recovery | | | | |
| First-time pairing | | | | |
| Concurrent transfers | | | | |
| Long-duration stability | | | | |
| Security test findings | | | | |

### Status definitions

- **Better:** Your result is measurably better than the best competitor under identical conditions.
- **Competitive:** Your result is within 5% of the best competitor, or equivalent for a non-numeric requirement.
- **Needs improvement:** Your result is worse than the best competitor.
- **Not tested:** Insufficient evidence.
- **Not applicable:** The metric does not apply to that platform or test.

---

## 13. Final product success criteria

Do not declare the product better merely because it meets its own targets.

A credible competitive claim should require:

1. Lower idle resource consumption than the best measured competitor.
2. Transfer throughput comparable to or better than the best measured competitor.
3. Reliable completion of large-file transfers.
4. Verified recovery from interruptions without retransmitting completed chunks.
5. Consistent Android background transfer performance across multiple device vendors.
6. Reliable discovery and reconnection across supported network conditions.
7. No unresolved critical or high-severity security findings.
8. Better or equivalent workflow efficiency for the primary Windows–Android use case.

**Final decision:** The product should be considered technically competitive only when repeated, controlled tests demonstrate an advantage in multiple important categories without a major regression in the others.

**Remember:** These are proposed engineering targets, not industry standards or guaranteed competitor-beating thresholds. Update them as you collect real measurements.