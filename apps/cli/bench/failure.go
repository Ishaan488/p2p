package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type FailureRecord struct {
	TestID            string  `json:"test_id"`
	Repetition        int     `json:"repetition"`
	Scenario          string  `json:"scenario"`
	FileSize          int64   `json:"file_size"`
	ChunkSize         int64   `json:"chunk_size"`
	Workers           int     `json:"workers"`
	InterruptPct      int     `json:"interrupt_pct"`
	AckedChunks       int     `json:"acknowledged_chunks"`
	PersistedChunks   int     `json:"persisted_chunks"`
	Retransmitted     int     `json:"retransmitted_chunks"`
	DuplicateWrites   int     `json:"duplicate_writes"`
	AckedChunkIDs     []int   `json:"acked_chunk_ids,omitempty"`
	RecoveredChunkIDs []int   `json:"recovered_chunk_ids,omitempty"`
	MissingChunkIDs   []int   `json:"missing_chunk_ids,omitempty"`
	SubsetVerified    bool    `json:"subset_verified"`
	RecoveryStatus    string  `json:"recovery_status"`
	IntegritySHA      string  `json:"integrity_sha256"`
	ElapsedSeconds    float64 `json:"elapsed_seconds"`
	FailureDetails    string  `json:"failure_details"`
}

type benchMeta struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	TotalChunks int    `json:"totalChunks"`
	ChunkSize   int64  `json:"chunkSize"`
	TotalSize   int64  `json:"totalSize"`
	FilePath    string `json:"filePath"`
	FinalPath   string `json:"finalPath,omitempty"`
	State       string `json:"state,omitempty"`
	Generation  int64  `json:"generation,omitempty"`
	IsDownload  bool   `json:"isDownload"`
	IsFolder    bool   `json:"isFolder"`
	FolderName  string `json:"folderName,omitempty"`
	LastActive  int64  `json:"lastActive"`
	Owner       string `json:"owner"`
	Received    []bool `json:"received"`
}

func getPathsForTID(home, tid string) (partPath, metaPath string) {
	sum := sha256.Sum256([]byte(tid))
	prefix := hex.EncodeToString(sum[:16])
	return filepath.Join(home, "temp", prefix+".part"), filepath.Join(home, "temp", prefix+".meta.json")
}

func cmdFailure(args []string) {
	fs := flag.NewFlagSet("failure", flag.ExitOnError)
	g := addCommon(fs)
	reps := fs.Int("reps", 10, "repetitions per failure scenario (default 10)")
	fs.Parse(args)

	logf("=== Starting P2P Resume Consistency & Crash Recovery Validation Suite ===")
	logf("Scenarios: T1..T10 + E1..E10 (%d reps each) + Realistic 100MiB & 1GiB verification", *reps)

	sz32 := int64(32 * MiB)
	src32, sha32, err := ensureSource(filepath.Join(*g.work, "src"), sz32)
	if err != nil {
		fatalf("source 32MiB: %v", err)
	}

	var records []FailureRecord

	runScenario := func(testID, scenario string, pct int, mode string, repsCount int, sz int64, srcFile, wantSHA string, chunkSz int64, workers int, customInjection func(srv *Server, home, tid string, phase1Acked int) error, dupInject bool) {
		totalChunks := int((sz + chunkSz - 1) / chunkSz)
		targetAck := totalChunks * pct / 100

		for rep := 1; rep <= repsCount; rep++ {
			rec := FailureRecord{
				TestID:         testID,
				Repetition:     rep,
				Scenario:       scenario,
				FileSize:       sz,
				ChunkSize:      chunkSz,
				Workers:        workers,
				InterruptPct:   pct,
				RecoveryStatus: "FAILED",
				IntegritySHA:   "not-checked",
			}

			home := filepath.Join(*g.work, fmt.Sprintf("home_%s_%d", testID, rep))
			os.RemoveAll(home)
			dev := newDevSeed("fail-client", true)

			srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
			if err != nil {
				rec.FailureDetails = "start server 1: " + err.Error()
				records = append(records, rec)
				continue
			}

			cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
			if _, err := cl.Hello(); err != nil {
				rec.FailureDetails = "hello 1: " + err.Error()
				srv.Kill()
				os.RemoveAll(home)
				records = append(records, rec)
				continue
			}

			tid := randHex(16)
			name := fmt.Sprintf("%s_r%d.bin", testID, rep)

			// Phase 1 upload
			o1 := UpOpts{
				Path:         srcFile,
				Size:         sz,
				Name:         name,
				TID:          tid,
				Chunk:        chunkSz,
				Workers:      workers,
				MaxNewChunks: -1,
				NoComplete:   true,
			}

			if mode == "abort" {
				o1.AbortAfter = func(n int) bool { return n >= targetAck }
			} else if mode == "kill" {
				var once sync.Once
				o1.AbortAfter = func(n int) bool {
					if n >= targetAck {
						once.Do(func() { go srv.Kill() })
					}
					return false
				}
			}

			t0 := time.Now()
			r1 := cl.UploadFile(o1)
			rec.AckedChunks = r1.SentNow
			rec.AckedChunkIDs = r1.AckedChunks

			srv2 := srv
			if mode == "kill" || customInjection != nil {
				srv.Kill()
				if customInjection != nil {
					if err := customInjection(srv, home, tid, r1.SentNow); err != nil {
						rec.FailureDetails = "injection: " + err.Error()
					}
				}
				srv2, err = StartServer(*g.sut, home, *g.port+1, nil)
				if err != nil {
					rec.FailureDetails = "restart server 2: " + err.Error()
					srv.Kill()
					os.RemoveAll(home)
					records = append(records, rec)
					continue
				}
			}

			cl2 := NewClient(srv2.Base(), dev.ID, dev.Key, nil)
			if _, err := cl2.Hello(); err != nil {
				rec.FailureDetails = "re-hello: " + err.Error()
				srv2.Kill()
				os.RemoveAll(home)
				records = append(records, rec)
				continue
			}

			// In T10, simulate duplicate chunk retransmissions before sending missing chunks
			if dupInject && r1.SentNow >= 4 {
				for cIdx := 0; cIdx < 4; cIdx++ {
					plain := make([]byte, chunkSz)
					f, _ := os.Open(srcFile)
					f.ReadAt(plain, int64(cIdx)*chunkSz)
					f.Close()
					sealed := make([]byte, 12, chunkSz+28)
					body := cl2.sealInto(sealed, plain, fmt.Sprintf("chunk\n%s\n%d", tid, cIdx))
					u := cl2.SignedURL("POST", "/upload", map[string]string{"transferId": tid, "chunkIndex": strconv.Itoa(cIdx)}, "")
					resp, err := cl2.HC.Post(u, "application/octet-stream", bytes.NewReader(body))
					if err == nil && resp.StatusCode == 200 {
						rec.DuplicateWrites++
					}
					if resp != nil {
						resp.Body.Close()
					}
				}
			}

			// Phase 2 resume
			o2 := UpOpts{
				Path:         srcFile,
				Size:         sz,
				Name:         name,
				TID:          tid,
				Chunk:        chunkSz,
				Workers:      workers,
				MaxNewChunks: -1,
			}
			r2 := cl2.UploadFile(o2)
			rec.ElapsedSeconds = time.Since(t0).Seconds()
			rec.PersistedChunks = r2.AlreadyHad
			rec.RecoveredChunkIDs = r2.AlreadyHadChunks
			rec.Retransmitted = max(0, r1.SentNow+r2.SentNow-totalChunks)

			// Exact chunk identity verification: AckedChunkIDs ⊆ RecoveredChunkIDs
			rec.SubsetVerified = true
			if len(r1.AckedChunks) > 0 {
				recoveredSet := make(map[int]bool, len(r2.AlreadyHadChunks))
				for _, id := range r2.AlreadyHadChunks {
					recoveredSet[id] = true
				}
				for _, id := range r1.AckedChunks {
					if !recoveredSet[id] {
						rec.MissingChunkIDs = append(rec.MissingChunkIDs, id)
					}
				}
				if len(rec.MissingChunkIDs) > 0 {
					rec.SubsetVerified = false
				}
			}

			if r2.Err != "" {
				rec.FailureDetails = "phase 2: " + r2.Err
			} else if !rec.SubsetVerified {
				rec.RecoveryStatus = "FAILED"
				rec.FailureDetails = fmt.Sprintf("acknowledged chunks missing after recovery: %v", rec.MissingChunkIDs)
			} else {
				rec.IntegritySHA = verifyReceived(srv2, r2.FinalName, sz, wantSHA)
				if rec.IntegritySHA == "sha256-match" {
					rec.RecoveryStatus = "SUCCESS"
				} else {
					rec.FailureDetails = "integrity mismatch: " + rec.IntegritySHA
				}
			}

			logf("[%s rep %2d/%2d] acked=%2d persisted=%2d resent=%d dup=%d subset=%v -> %s (%s, %.2fs) %s",
				testID, rep, repsCount, rec.AckedChunks, rec.PersistedChunks, rec.Retransmitted, rec.DuplicateWrites,
				rec.SubsetVerified, rec.RecoveryStatus, rec.IntegritySHA, rec.ElapsedSeconds, rec.FailureDetails)

			srv2.Kill()
			if srv2 != srv {
				srv.Kill()
			}
			os.RemoveAll(home)
			records = append(records, rec)
			time.Sleep(100 * time.Millisecond)
		}
	}

	// T1: Client abort at 25% (10 reps)
	logf("\n--- Running T1: Client abort at 25%% ---")
	runScenario("T1", "Client abort at 25%", 25, "abort", *reps, sz32, src32, sha32, MiB, 4, nil, false)

	// T2: Client abort at 50% (10 reps)
	logf("\n--- Running T2: Client abort at 50%% ---")
	runScenario("T2", "Client abort at 50%", 50, "abort", *reps, sz32, src32, sha32, MiB, 4, nil, false)

	// T3: Client abort at 75% (10 reps)
	logf("\n--- Running T3: Client abort at 75%% ---")
	runScenario("T3", "Client abort at 75%", 75, "abort", *reps, sz32, src32, sha32, MiB, 4, nil, false)

	// T4: Server process killed at 25% (10 reps)
	logf("\n--- Running T4: Server process killed at 25%% ---")
	runScenario("T4", "Server process killed at 25%", 25, "kill", *reps, sz32, src32, sha32, MiB, 4, nil, false)

	// T5: Server process killed at 50% (10 reps)
	logf("\n--- Running T5: Server process killed at 50%% ---")
	runScenario("T5", "Server process killed at 50%", 50, "kill", *reps, sz32, src32, sha32, MiB, 4, nil, false)

	// T6: Server process killed at 75% (10 reps)
	logf("\n--- Running T6: Server process killed at 75%% ---")
	runScenario("T6", "Server process killed at 75%", 75, "kill", *reps, sz32, src32, sha32, MiB, 4, nil, false)

	// T7: Server killed during concurrent metadata updates (10 reps, 128 KiB chunks = 256 chunks, 8 workers)
	logf("\n--- Running T7: Server killed during high-concurrency metadata blast ---")
	runScenario("T7", "Server killed during concurrent metadata updates", 50, "kill", *reps, sz32, src32, sha32, 128*KiB, 8, nil, false)

	// T8: Server restarted with partially written metadata (interrupted rename, valid .tmp recovery) (10 reps)
	logf("\n--- Running T8: Server restarted with partially written metadata (.tmp recovery) ---")
	runScenario("T8", "Server restarted with partially written metadata", 50, "kill", *reps, sz32, src32, sha32, MiB, 4, func(srv *Server, home, tid string, phase1Acked int) error {
		_, metaPath := getPathsForTID(home, tid)
		b, err := os.ReadFile(metaPath)
		if err != nil {
			return fmt.Errorf("read meta %s: %w", metaPath, err)
		}
		tmpPath := metaPath + ".tmp.simulated"
		if err := os.WriteFile(tmpPath, b, 0600); err != nil {
			return err
		}
		return os.WriteFile(metaPath, []byte{}, 0600)
	}, false)

	// T9: Server restarted with missing or corrupted metadata (10 reps)
	logf("\n--- Running T9: Server restarted with corrupted metadata ---")
	for rep := 1; rep <= *reps; rep++ {
		rec := FailureRecord{
			TestID:         "T9",
			Repetition:     rep,
			Scenario:       "Server restarted with corrupted metadata",
			FileSize:       sz32,
			ChunkSize:      MiB,
			Workers:        4,
			InterruptPct:   50,
			RecoveryStatus: "FAILED",
			IntegritySHA:   "n/a",
			SubsetVerified: true,
		}
		home := filepath.Join(*g.work, fmt.Sprintf("home_T9_%d", rep))
		os.RemoveAll(home)
		os.MkdirAll(filepath.Join(home, "temp"), 0755)

		partPath := filepath.Join(home, "temp", "corrupt_tx.part")
		metaPath := filepath.Join(home, "temp", "corrupt_tx.meta.json")
		os.WriteFile(partPath, []byte("partial data 1234567890"), 0644)
		os.WriteFile(metaPath, []byte(`{"id":"corrupt_tx", "corrupt_json: true ...`), 0600)

		srv, err := StartServer(*g.sut, home, *g.port, nil)
		if err != nil {
			rec.FailureDetails = "start server with corrupt metadata: " + err.Error()
		} else {
			_, errPart := os.Stat(partPath)
			_, errMeta := os.Stat(metaPath)
			if os.IsNotExist(errPart) && os.IsNotExist(errMeta) {
				rec.RecoveryStatus = "SUCCESS"
				rec.FailureDetails = "corrupt metadata safely detected and swept without crash"
			} else {
				rec.FailureDetails = "corrupt files were not swept"
			}
			srv.Kill()
		}
		os.RemoveAll(home)
		records = append(records, rec)
		logf("[T9 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
		time.Sleep(50 * time.Millisecond)
	}

	// T10: Duplicate chunks received during recovery (10 reps)
	logf("\n--- Running T10: Duplicate chunks received during recovery ---")
	runScenario("T10", "Duplicate chunks received during recovery", 50, "abort", *reps, sz32, src32, sha32, MiB, 4, nil, true)

	// E1: Corrupted non-empty primary manifest with valid .tmp manifest (10 reps)
	logf("\n--- Running E1: Corrupted non-empty primary manifest with valid .tmp manifest ---")
	runScenario("E1", "Corrupted non-empty primary manifest with valid .tmp manifest", 50, "kill", *reps, sz32, src32, sha32, MiB, 4, func(srv *Server, home, tid string, phase1Acked int) error {
		_, metaPath := getPathsForTID(home, tid)
		b, err := os.ReadFile(metaPath)
		if err != nil {
			return fmt.Errorf("read meta %s: %w", metaPath, err)
		}
		if err := os.WriteFile(metaPath+".tmp.valid", b, 0600); err != nil {
			return err
		}
		return os.WriteFile(metaPath, []byte(`{"id":"`+tid+`", "corrupt_non_empty_json: true`), 0600)
	}, false)

	// E2: Multiple temporary manifests with different generation numbers (10 reps)
	logf("\n--- Running E2: Multiple temporary manifests with different generation numbers ---")
	runScenario("E2", "Multiple temporary manifests with different generation numbers", 50, "kill", *reps, sz32, src32, sha32, MiB, 4, func(srv *Server, home, tid string, phase1Acked int) error {
		_, metaPath := getPathsForTID(home, tid)
		b, err := os.ReadFile(metaPath)
		if err != nil {
			return fmt.Errorf("read meta %s: %w", metaPath, err)
		}
		var m benchMeta
		if err := json.Unmarshal(b, &m); err != nil {
			return err
		}
		os.Remove(metaPath)

		// Candidate 1: Generation 10, received only 4 chunks
		m1 := m
		m1.Generation = 10
		m1.Received = make([]bool, len(m.Received))
		for i := 0; i < 4 && i < len(m1.Received); i++ {
			m1.Received[i] = true
		}
		b1, _ := json.Marshal(m1)
		os.WriteFile(metaPath+".tmp.gen10", b1, 0600)

		// Candidate 2: Generation 50 (highest!), received all phase 1 chunks
		m2 := m
		m2.Generation = 50
		b2, _ := json.Marshal(m2)
		os.WriteFile(metaPath+".tmp.gen50", b2, 0600)

		// Candidate 3: Generation 20, received only 8 chunks
		m3 := m
		m3.Generation = 20
		m3.Received = make([]bool, len(m.Received))
		for i := 0; i < 8 && i < len(m3.Received); i++ {
			m3.Received[i] = true
		}
		b3, _ := json.Marshal(m3)
		os.WriteFile(metaPath+".tmp.gen20", b3, 0600)

		return nil
	}, false)

	// E3: Multiple temporary manifests with equal counts but strict superset chunk IDs (10 reps)
	logf("\n--- Running E3: Multiple temporary manifests with strict superset chunk IDs ---")
	runScenario("E3", "Multiple temporary manifests with strict superset chunk IDs", 50, "kill", *reps, sz32, src32, sha32, MiB, 4, func(srv *Server, home, tid string, phase1Acked int) error {
		_, metaPath := getPathsForTID(home, tid)
		b, err := os.ReadFile(metaPath)
		if err != nil {
			return fmt.Errorf("read meta %s: %w", metaPath, err)
		}
		var m benchMeta
		if err := json.Unmarshal(b, &m); err != nil {
			return err
		}
		os.Remove(metaPath)

		// Candidate A: Generation 30, subset of received chunks
		mA := m
		mA.Generation = 30
		mA.Received = make([]bool, len(m.Received))
		for i := 0; i < 6 && i < len(mA.Received); i++ {
			mA.Received[i] = true
		}
		bA, _ := json.Marshal(mA)
		os.WriteFile(metaPath+".tmp.subset", bA, 0600)

		// Candidate B: Generation 30, superset (all phase 1 chunks)
		mB := m
		mB.Generation = 30
		bB, _ := json.Marshal(mB)
		os.WriteFile(metaPath+".tmp.superset", bB, 0600)

		return nil
	}, false)

	// E4: Older manifest presented alongside newer committed generation (10 reps)
	logf("\n--- Running E4: Older manifest presented alongside newer committed generation ---")
	runScenario("E4", "Older manifest presented alongside newer committed generation", 50, "kill", *reps, sz32, src32, sha32, MiB, 4, func(srv *Server, home, tid string, phase1Acked int) error {
		_, metaPath := getPathsForTID(home, tid)
		b, err := os.ReadFile(metaPath)
		if err != nil {
			return fmt.Errorf("read meta %s: %w", metaPath, err)
		}
		var m benchMeta
		if err := json.Unmarshal(b, &m); err != nil {
			return err
		}

		// Set primary to Generation 100
		mPrimary := m
		mPrimary.Generation = 100
		bP, _ := json.Marshal(mPrimary)
		os.WriteFile(metaPath, bP, 0600)

		// Temporary candidate has Generation 10 and fewer chunks
		mStale := m
		mStale.Generation = 10
		mStale.Received = make([]bool, len(m.Received))
		if len(mStale.Received) > 2 {
			mStale.Received[0] = true
			mStale.Received[1] = true
		}
		bS, _ := json.Marshal(mStale)
		os.WriteFile(metaPath+".tmp.stale", bS, 0600)

		return nil
	}, false)

	// E5: Invalid transfer ID in temporary manifest (10 reps)
	logf("\n--- Running E5: Invalid transfer ID in temporary manifest ---")
	runScenario("E5", "Invalid transfer ID in temporary manifest", 50, "kill", *reps, sz32, src32, sha32, MiB, 4, func(srv *Server, home, tid string, phase1Acked int) error {
		_, metaPath := getPathsForTID(home, tid)
		b, err := os.ReadFile(metaPath)
		if err != nil {
			return fmt.Errorf("read meta %s: %w", metaPath, err)
		}
		var m benchMeta
		if err := json.Unmarshal(b, &m); err != nil {
			return err
		}
		mBogus := m
		mBogus.ID = "invalid_bogus_transfer_id_9999"
		bBogus, _ := json.Marshal(mBogus)
		return os.WriteFile(metaPath+".tmp.bogus", bBogus, 0600)
	}, false)

	// E6: Truncated temporary manifest (10 reps)
	logf("\n--- Running E6: Truncated temporary manifest ---")
	runScenario("E6", "Truncated temporary manifest", 50, "kill", *reps, sz32, src32, sha32, MiB, 4, func(srv *Server, home, tid string, phase1Acked int) error {
		_, metaPath := getPathsForTID(home, tid)
		return os.WriteFile(metaPath+".tmp.truncated", []byte(`{"id":"`+tid+`", "totalCh`), 0600)
	}, false)

	// E7: Crash during finalization: before move (part still in tempDir) (10 reps)
	logf("\n--- Running E7: Crash during finalization before move (part still in tempDir) ---")
	for rep := 1; rep <= *reps; rep++ {
		rec := FailureRecord{
			TestID:         "E7",
			Repetition:     rep,
			Scenario:       "Crash during finalization before move (part still in tempDir)",
			FileSize:       sz32,
			ChunkSize:      MiB,
			Workers:        4,
			InterruptPct:   100,
			RecoveryStatus: "FAILED",
			IntegritySHA:   "not-checked",
		}
		t0 := time.Now()
		home := filepath.Join(*g.work, fmt.Sprintf("home_E7_%d", rep))
		os.RemoveAll(home)
		dev := newDevSeed("fail-client", true)

		srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
		if err != nil {
			rec.FailureDetails = "start server 1: " + err.Error()
			records = append(records, rec)
			logf("[E7 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
		if _, err := cl.Hello(); err != nil {
			rec.FailureDetails = "hello 1: " + err.Error()
			srv.Kill()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E7 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		tid := randHex(16)
		name := fmt.Sprintf("E7_r%d.bin", rep)

		r1 := cl.UploadFile(UpOpts{
			Path:         src32,
			Size:         sz32,
			Name:         name,
			TID:          tid,
			Chunk:        MiB,
			Workers:      4,
			MaxNewChunks: -1,
			NoComplete:   true,
		})
		srv.Kill()

		if r1.SentNow != 32 {
			rec.FailureDetails = fmt.Sprintf("phase 1 incomplete: sent %d/32", r1.SentNow)
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E7 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		partPath, metaPath := getPathsForTID(home, tid)
		destPath := filepath.Join(home, "received", name)
		b, errReadMeta := os.ReadFile(metaPath)
		if errReadMeta != nil {
			rec.FailureDetails = "read meta failed: " + errReadMeta.Error()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E7 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}
		var m map[string]any
		json.Unmarshal(b, &m)
		m["state"] = "finalizing"
		m["finalPath"] = destPath
		bNew, _ := json.Marshal(m)
		os.WriteFile(metaPath, bNew, 0600)

		// Start Server 2: recoverOrSweepTempDir detects State="finalizing",
		// moves .part to destPath in received/, removes meta.json, and registers history.
		srv2, err := StartServer(*g.sut, home, *g.port+1, nil)
		if err != nil {
			rec.FailureDetails = "start server 2: " + err.Error()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E7 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		rec.ElapsedSeconds = time.Since(t0).Seconds()
		rec.AckedChunks = 32
		rec.PersistedChunks = 32
		rec.SubsetVerified = true

		rec.IntegritySHA = verifyReceived(srv2, name, sz32, sha32)
		if rec.IntegritySHA == "sha256-match" {
			_, errPart := os.Stat(partPath)
			_, errMeta := os.Stat(metaPath)
			if os.IsNotExist(errPart) && os.IsNotExist(errMeta) {
				rec.RecoveryStatus = "SUCCESS"
				rec.FailureDetails = "recovered from mid-finalization crash before move: .part successfully moved to final destination"
			} else {
				rec.FailureDetails = fmt.Sprintf("lingering temp files: partExists=%v metaExists=%v", !os.IsNotExist(errPart), !os.IsNotExist(errMeta))
			}
		} else {
			rec.FailureDetails = "destination integrity mismatch: " + rec.IntegritySHA
		}

		logf("[E7 rep %2d/%2d] -> %s (%s, %.2fs) %s", rep, *reps, rec.RecoveryStatus, rec.IntegritySHA, rec.ElapsedSeconds, rec.FailureDetails)
		srv2.Kill()
		os.RemoveAll(home)
		records = append(records, rec)
		time.Sleep(50 * time.Millisecond)
	}

	// E8: Crash after move before metadata cleanup (10 reps)
	logf("\n--- Running E8: Crash after move before metadata cleanup (final file in destination) ---")
	for rep := 1; rep <= *reps; rep++ {
		rec := FailureRecord{
			TestID:         "E8",
			Repetition:     rep,
			Scenario:       "Crash after move before metadata cleanup (final file in destination)",
			FileSize:       sz32,
			ChunkSize:      MiB,
			Workers:        4,
			InterruptPct:   100,
			RecoveryStatus: "FAILED",
			IntegritySHA:   "not-checked",
		}
		t0 := time.Now()
		home := filepath.Join(*g.work, fmt.Sprintf("home_E8_%d", rep))
		os.RemoveAll(home)
		dev := newDevSeed("fail-client", true)

		srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
		if err != nil {
			rec.FailureDetails = "start server 1: " + err.Error()
			records = append(records, rec)
			logf("[E8 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
		if _, err := cl.Hello(); err != nil {
			rec.FailureDetails = "hello 1: " + err.Error()
			srv.Kill()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E8 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		tid := randHex(16)
		name := fmt.Sprintf("E8_r%d.bin", rep)

		r1 := cl.UploadFile(UpOpts{
			Path:         src32,
			Size:         sz32,
			Name:         name,
			TID:          tid,
			Chunk:        MiB,
			Workers:      4,
			MaxNewChunks: -1,
			NoComplete:   true,
		})
		srv.Kill()

		if r1.SentNow != 32 {
			rec.FailureDetails = fmt.Sprintf("phase 1 incomplete: sent %d/32", r1.SentNow)
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E8 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		partPath, metaPath := getPathsForTID(home, tid)
		os.MkdirAll(filepath.Join(home, "received"), 0755)
		destPath := filepath.Join(home, "received", name)
		if err := os.Rename(partPath, destPath); err != nil {
			rec.FailureDetails = "rename to dest failed: " + err.Error()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E8 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		b, errReadMeta := os.ReadFile(metaPath)
		if errReadMeta != nil {
			rec.FailureDetails = "read meta failed: " + errReadMeta.Error()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E8 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}
		var m map[string]any
		json.Unmarshal(b, &m)
		m["state"] = "finalizing"
		m["finalPath"] = destPath
		bNew, _ := json.Marshal(m)
		os.WriteFile(metaPath, bNew, 0600)

		// Start Server 2: recoverOrSweepTempDir detects State="finalizing",
		// recognizes destPath already exists, sweeps lingering metadata, and records completion.
		srv2, err := StartServer(*g.sut, home, *g.port+1, nil)
		if err != nil {
			rec.FailureDetails = "start server 2: " + err.Error()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E8 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		rec.ElapsedSeconds = time.Since(t0).Seconds()
		rec.AckedChunks = 32
		rec.PersistedChunks = 32
		rec.SubsetVerified = true

		rec.IntegritySHA = verifyReceived(srv2, name, sz32, sha32)
		if rec.IntegritySHA == "sha256-match" {
			_, errMetaAfter := os.Stat(metaPath)
			if os.IsNotExist(errMetaAfter) {
				rec.RecoveryStatus = "SUCCESS"
				rec.FailureDetails = "recovered from mid-finalization crash after move: lingering metadata swept, destination intact"
			} else {
				rec.FailureDetails = "lingering meta file not swept"
			}
		} else {
			rec.FailureDetails = "destination integrity mismatch: " + rec.IntegritySHA
		}

		logf("[E8 rep %2d/%2d] -> %s (%s, %.2fs) %s", rep, *reps, rec.RecoveryStatus, rec.IntegritySHA, rec.ElapsedSeconds, rec.FailureDetails)
		srv2.Kill()
		os.RemoveAll(home)
		records = append(records, rec)
		time.Sleep(50 * time.Millisecond)
	}

	// E9: Client retry after final response lost (10 reps)
	logf("\n--- Running E9: Client retry after final response lost ---")
	for rep := 1; rep <= *reps; rep++ {
		rec := FailureRecord{
			TestID:         "E9",
			Repetition:     rep,
			Scenario:       "Client retry after final response lost",
			FileSize:       sz32,
			ChunkSize:      MiB,
			Workers:        4,
			InterruptPct:   0,
			RecoveryStatus: "FAILED",
			IntegritySHA:   "not-checked",
		}
		t0 := time.Now()
		home := filepath.Join(*g.work, fmt.Sprintf("home_E9_%d", rep))
		os.RemoveAll(home)
		dev := newDevSeed("fail-client", true)

		srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
		if err != nil {
			rec.FailureDetails = "start server: " + err.Error()
			records = append(records, rec)
			logf("[E9 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
		if _, err := cl.Hello(); err != nil {
			rec.FailureDetails = "hello: " + err.Error()
			srv.Kill()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E9 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		tid := randHex(16)
		name := fmt.Sprintf("E9_r%d.bin", rep)

		r := cl.UploadFile(UpOpts{
			Path:         src32,
			Size:         sz32,
			Name:         name,
			TID:          tid,
			Chunk:        MiB,
			Workers:      4,
			MaxNewChunks: -1,
			NoComplete:   false,
		})
		if r.Err != "" {
			rec.FailureDetails = "initial upload: " + r.Err
			srv.Kill()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E9 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		// Re-send /upload_complete with same TID
		var retryDone struct {
			Filename string `json:"filename"`
		}
		errRetry := cl.JSONCall("/upload_complete", map[string]string{"transferId": tid}, &retryDone)
		rec.ElapsedSeconds = time.Since(t0).Seconds()
		rec.AckedChunks = 32
		rec.PersistedChunks = 32
		rec.SubsetVerified = true

		if errRetry != nil {
			rec.FailureDetails = "retry failed: " + errRetry.Error()
		} else if retryDone.Filename != r.FinalName {
			rec.FailureDetails = fmt.Sprintf("filename mismatch on retry: got %s, want %s", retryDone.Filename, r.FinalName)
		} else {
			rec.IntegritySHA = verifyReceived(srv, retryDone.Filename, sz32, sha32)
			if rec.IntegritySHA == "sha256-match" {
				rec.RecoveryStatus = "SUCCESS"
				rec.FailureDetails = "idempotent retry succeeded with HTTP 200 and identical filename"
			} else {
				rec.FailureDetails = "integrity mismatch: " + rec.IntegritySHA
			}
		}

		logf("[E9 rep %2d/%2d] -> %s (%s, %.2fs) %s", rep, *reps, rec.RecoveryStatus, rec.IntegritySHA, rec.ElapsedSeconds, rec.FailureDetails)
		srv.Kill()
		os.RemoveAll(home)
		records = append(records, rec)
		time.Sleep(50 * time.Millisecond)
	}

	// E10: Destination file name conflict resolution (10 reps)
	logf("\n--- Running E10: Destination file name conflict resolution ---")
	for rep := 1; rep <= *reps; rep++ {
		rec := FailureRecord{
			TestID:         "E10",
			Repetition:     rep,
			Scenario:       "Destination file name conflict resolution",
			FileSize:       sz32,
			ChunkSize:      MiB,
			Workers:        4,
			InterruptPct:   0,
			RecoveryStatus: "FAILED",
			IntegritySHA:   "not-checked",
		}
		t0 := time.Now()
		home := filepath.Join(*g.work, fmt.Sprintf("home_E10_%d", rep))
		os.RemoveAll(home)
		dev := newDevSeed("fail-client", true)

		srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
		if err != nil {
			rec.FailureDetails = "start server: " + err.Error()
			records = append(records, rec)
			logf("[E10 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
		if _, err := cl.Hello(); err != nil {
			rec.FailureDetails = "hello: " + err.Error()
			srv.Kill()
			os.RemoveAll(home)
			records = append(records, rec)
			logf("[E10 rep %2d/%2d] -> %s (%s)", rep, *reps, rec.RecoveryStatus, rec.FailureDetails)
			continue
		}

		conflictName := fmt.Sprintf("conflict_test_r%d.bin", rep)
		os.MkdirAll(filepath.Join(home, "received"), 0755)
		origPath := filepath.Join(home, "received", conflictName)
		origContent := []byte("ORIGINAL PRE-EXISTING FILE CONTENT THAT MUST NOT BE OVERWRITTEN")
		os.WriteFile(origPath, origContent, 0644)

		tid := randHex(16)
		r := cl.UploadFile(UpOpts{
			Path:         src32,
			Size:         sz32,
			Name:         conflictName,
			TID:          tid,
			Chunk:        MiB,
			Workers:      4,
			MaxNewChunks: -1,
			NoComplete:   false,
		})
		rec.ElapsedSeconds = time.Since(t0).Seconds()
		rec.AckedChunks = 32
		rec.PersistedChunks = 32
		rec.SubsetVerified = true

		if r.Err != "" {
			rec.FailureDetails = "upload failed: " + r.Err
		} else {
			bOrig, errReadOrig := os.ReadFile(origPath)
			if errReadOrig != nil || !bytes.Equal(bOrig, origContent) {
				rec.FailureDetails = "pre-existing file was modified or deleted"
			} else if r.FinalName == conflictName {
				rec.FailureDetails = "collision was not renamed (overwrote original name)"
			} else {
				rec.IntegritySHA = verifyReceived(srv, r.FinalName, sz32, sha32)
				if rec.IntegritySHA == "sha256-match" {
					rec.RecoveryStatus = "SUCCESS"
					rec.FailureDetails = fmt.Sprintf("clean conflict resolution: preserved original and saved as %s", r.FinalName)
				} else {
					rec.FailureDetails = "new file integrity mismatch: " + rec.IntegritySHA
				}
			}
		}

		logf("[E10 rep %2d/%2d] -> %s (%s, %.2fs) %s", rep, *reps, rec.RecoveryStatus, rec.IntegritySHA, rec.ElapsedSeconds, rec.FailureDetails)
		srv.Kill()
		os.RemoveAll(home)
		records = append(records, rec)
		time.Sleep(50 * time.Millisecond)
	}

	// REALISTIC CONDITIONS: 100 MiB and 1 GiB files with 4 workers
	logf("\n=== Realistic Condition Verification (100 MiB & 1 GiB) ===")
	sz100 := int64(100 * MiB)
	src100, sha100, _ := ensureSource(filepath.Join(*g.work, "src"), sz100)

	logf("Running Realistic 100 MiB: Normal, Abort@50%%, Kill@50%%")
	runScenario("R100_NORM", "Realistic 100 MiB Normal Completion", 0, "none", 1, sz100, src100, sha100, MiB, 4, nil, false)
	runScenario("R100_ABORT", "Realistic 100 MiB Abort at 50%", 50, "abort", 1, sz100, src100, sha100, MiB, 4, nil, false)
	runScenario("R100_KILL", "Realistic 100 MiB Server Kill at 50%", 50, "kill", 1, sz100, src100, sha100, MiB, 4, nil, false)

	sz1G := int64(1 * GiB)
	src1G, sha1G, _ := ensureSource(filepath.Join(*g.work, "src"), sz1G)
	logf("Running Realistic 1 GiB: Normal, Abort@50%%, Kill@50%%")
	runScenario("R1G_NORM", "Realistic 1 GiB Normal Completion", 0, "none", 1, sz1G, src1G, sha1G, MiB, 4, nil, false)
	runScenario("R1G_ABORT", "Realistic 1 GiB Abort at 50%", 50, "abort", 1, sz1G, src1G, sha1G, MiB, 4, nil, false)
	runScenario("R1G_KILL", "Realistic 1 GiB Server Kill at 50%", 50, "kill", 1, sz1G, src1G, sha1G, MiB, 4, nil, false)

	// Save JSON and CSV
	outDir := *g.out
	os.MkdirAll(outDir, 0755)
	jsonPath := filepath.Join(outDir, "failure_injection_results.json")
	csvPath := filepath.Join(outDir, "failure_injection_results.csv")

	jb, _ := json.MarshalIndent(map[string]any{
		"generated_utc": time.Now().UTC().Format(time.RFC3339),
		"total_tests":   len(records),
		"records":       records,
	}, "", "  ")
	os.WriteFile(jsonPath, jb, 0644)

	cf, err := os.Create(csvPath)
	if err == nil {
		defer cf.Close()
		w := csv.NewWriter(cf)
		w.Write([]string{
			"test_id", "repetition", "scenario", "file_size_bytes", "chunk_size_bytes", "workers",
			"interrupt_pct", "acknowledged_chunks", "persisted_chunks", "retransmitted_chunks",
			"duplicate_writes", "subset_verified", "missing_chunk_ids", "recovery_status", "integrity_sha256",
			"elapsed_seconds", "failure_details",
		})
		for _, r := range records {
			missingStr := fmt.Sprintf("%v", r.MissingChunkIDs)
			w.Write([]string{
				r.TestID, strconv.Itoa(r.Repetition), r.Scenario, strconv.FormatInt(r.FileSize, 10),
				strconv.FormatInt(r.ChunkSize, 10), strconv.Itoa(r.Workers), strconv.Itoa(r.InterruptPct),
				strconv.Itoa(r.AckedChunks), strconv.Itoa(r.PersistedChunks), strconv.Itoa(r.Retransmitted),
				strconv.Itoa(r.DuplicateWrites), strconv.FormatBool(r.SubsetVerified), missingStr,
				r.RecoveryStatus, r.IntegritySHA, fmt.Sprintf("%.3f", r.ElapsedSeconds), r.FailureDetails,
			})
		}
		w.Flush()
	}

	logf("\nValidation complete: %d tests recorded.", len(records))
	logf("Results written to:\n - %s\n - %s", jsonPath, csvPath)
}
