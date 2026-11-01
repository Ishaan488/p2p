package main

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type common struct {
	sut, out, work *string
	port           *int
}

func addCommon(fs *flag.FlagSet) common {
	return common{
		sut:  fs.String("sut", `E:\personal\p2p\p2p.exe`, "system-under-test binary (the shipping p2p.exe)"),
		out:  fs.String("out", filepath.Join("..", "..", "benchmark_results"), "results directory"),
		work: fs.String("work", `E:\p2pbench_work`, "scratch directory for payloads and server homes"),
		port: fs.Int("port", 18080, "base TCP port for managed servers"),
	}
}

func parseSize(s string) int64 {
	s = strings.TrimSpace(s)
	units := []struct {
		suf string
		m   int64
	}{{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10}, {"B", 1}}
	for _, u := range units {
		if strings.HasSuffix(s, u.suf) {
			n, err := strconv.ParseFloat(strings.TrimSuffix(s, u.suf), 64)
			if err != nil {
				break
			}
			return int64(n * float64(u.m))
		}
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		fatalf("bad size %q (use e.g. 100MiB, 1GiB)", s)
	}
	return n
}

func fmtSize(n int64) string {
	switch {
	case n >= 1<<30 && n%(1<<30) == 0:
		return fmt.Sprintf("%dGiB", n>>30)
	case n >= 1<<20 && n%(1<<20) == 0:
		return fmt.Sprintf("%dMiB", n>>20)
	case n >= 1<<10 && n%(1<<10) == 0:
		return fmt.Sprintf("%dKiB", n>>10)
	}
	return fmt.Sprintf("%dB", n)
}

func fatalf(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "FATAL: "+f+"\n", a...)
	os.Exit(1)
}

func logf(f string, a ...any) { fmt.Printf(time.Now().Format("15:04:05 ")+f+"\n", a...) }

func ptr[T any](v T) *T { return &v }

func verifyReceived(srv *Server, final string, size int64, wantSHA string) string {
	p := srv.ReceivedPath(final)
	st, err := os.Stat(p)
	if err != nil {
		return "MISSING: " + err.Error()
	}
	if st.Size() != size {
		return fmt.Sprintf("MISMATCH (size %d != %d)", st.Size(), size)
	}
	got, err := hashFile(p)
	if err != nil {
		return "UNREADABLE: " + err.Error()
	}
	if got != wantSHA {
		return "MISMATCH (sha256)"
	}
	return "sha256-match"
}

func finish(run *Run, out string) {
	p, err := run.Save(out)
	if err != nil {
		fatalf("save: %v", err)
	}
	logf("saved %s", p)
}

// ---------------------------------------------------------------------------
// idle
// ---------------------------------------------------------------------------

func cmdIdle(args []string) {
	fs := flag.NewFlagSet("idle", flag.ExitOnError)
	g := addCommon(fs)
	secs := fs.Int("secs", 300, "idle observation window in seconds")
	settle := fs.Int("settle", 15, "settle time after startup before the window")
	fs.Parse(args)
	env := captureEnv(*g.sut)
	run := newRun("idle", "Measured: desktop server process, idle (no clients, no transfers)", map[string]any{"window_s": *secs, "settle_s": *settle, "sample_interval_s": 1, "flags": "-no-tray -no-clipboard"}, env)
	home := filepath.Join(*g.work, "home_idle_"+run.RunID)
	srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{newDevSeed("idle-dev", true)})
	if err != nil {
		fatalf("%v", err)
	}
	smp, err := StartSampler(srv.PID, time.Second)
	if err != nil {
		fatalf("%v", err)
	}
	tStart := time.Now()
	time.Sleep(2 * time.Second)
	atStart := smp.Between(tStart, time.Now())
	logf("startup (first 2 s): WS=%.1f MiB priv=%.1f MiB", atStart.WSAvgMiB, atStart.PrivAvgMiB)
	time.Sleep(time.Duration(*settle) * time.Second)
	w0 := time.Now()
	logf("observing idle for %ds ...", *secs)
	time.Sleep(time.Duration(*secs) * time.Second)
	w1 := time.Now()
	idle := smp.Between(w0, w1)
	peak := smp.LifetimePeakWS()
	smp.Stop()
	srv.Kill()
	os.RemoveAll(home)
	tr := Trial{Index: 1, Success: true, Seconds: idle.WallSeconds, Integrity: "n/a", Group: "idle", Mem: &idle,
		Extra: map[string]any{"startup_first_2s": atStart, "lifetime_peak_working_set_MiB": peak, "ready_ms": ms(srv.ReadyIn)}}
	run.Trials = append(run.Trials, tr)
	run.Notes = append(run.Notes, "Working Set and Private Bytes are Win32 GetProcessMemoryInfo values for the p2p.exe process only. CPU% is cumulative process CPU time / wall time (of one core and of all logical cores).")
	finish(run, *g.out)
	logf("IDLE: WS avg=%.1f MiB max=%.1f | Private avg=%.1f MiB | CPU=%.3f%% of one core (%.4f%% of host)", idle.WSAvgMiB, idle.WSMaxMiB, idle.PrivAvgMiB, idle.CPUPctOfCore, idle.CPUPctOfHost)
}

// ---------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------

func cmdStartup(args []string) {
	fs := flag.NewFlagSet("startup", flag.ExitOnError)
	g := addCommon(fs)
	n := fs.Int("n", 10, "number of starts")
	fs.Parse(args)
	env := captureEnv(*g.sut)
	run := newRun("startup", "Measured: process launch -> HTTP endpoints answer (server readiness). Not UI render time.", map[string]any{"n": *n, "start_kind": "new process, OS file cache warm"}, env)
	dev := []*DevSeed{newDevSeed("startup-dev", true)}
	for i := 0; i < *n; i++ {
		home := filepath.Join(*g.work, fmt.Sprintf("home_startup_%s_%d", run.RunID, i))
		srv, err := StartServer(*g.sut, home, *g.port, dev)
		tr := Trial{Index: i + 1, Warmup: i == 0, Group: "startup", Integrity: "n/a"}
		if err != nil {
			tr.Error = err.Error()
		} else {
			tr.Success = true
			tr.Seconds = srv.ReadyIn.Seconds()
			tr.Extra = map[string]any{"discover_ready_ms": ms(srv.ReadyIn), "web_ui_200_ms": ms(srv.WebIn)}
			srv.Kill()
		}
		os.RemoveAll(home)
		run.Trials = append(run.Trials, tr)
		logf("start %d: discover ready %.0f ms, GET / 200 at %.0f ms", i+1, ms(srv.ReadyIn), ms(srv.WebIn))
		time.Sleep(500 * time.Millisecond)
	}
	run.Notes = append(run.Notes, "Trial 1 is marked warmup (first execution after build may include AV scan / disk cache effects) and is excluded from statistics.")
	finish(run, *g.out)
}

// ---------------------------------------------------------------------------
// single
// ---------------------------------------------------------------------------

func cmdSingle(args []string) {
	fs := flag.NewFlagSet("single", flag.ExitOnError)
	g := addCommon(fs)
	sizes := fs.String("sizes", "1MiB,100MiB,1GiB", "comma list of file sizes")
	trials := fs.Int("trials", 5, "measured trials per size")
	warm := fs.Int("warmup", 1, "warm-up trials per size (recorded, excluded from stats)")
	workers := fs.Int("workers", 4, "parallel chunk uploads")
	chunk := fs.String("chunk", "1MiB", "chunk size")
	dedup := fs.Bool("dedup", false, "app-faithful pre-flight: hash whole file + /upload_check_hash inside the timer")
	fs.Parse(args)
	env := captureEnv(*g.sut)
	cs := parseSize(*chunk)
	label := "Measured: protocol end-to-end, Go reference client -> real p2p.exe over LOOPBACK TCP (server stack + AES-GCM + disk; NOT Wi-Fi throughput)"
	run := newRun("single_upload_loopback", label, map[string]any{"sizes": *sizes, "trials": *trials, "warmup": *warm, "workers": *workers, "chunk": *chunk, "dedup_preflight": *dedup}, env)
	run.Notes = append(run.Notes,
		"Timer: starts before /upload_init, stops when /upload_complete returns (file moved into received/). Received file is SHA-256 verified OUTSIDE the timer by the harness.",
		"Files are written to the OS page cache; no fsync is issued by the server, so 'complete' != durable on disk.",
		"Source file is read from disk by the client (page cache warm for sizes that fit in free RAM).",
		"After completion the server hashes the received file in a background goroutine; the harness waits 2 s between trials.")
	for _, ss := range strings.Split(*sizes, ",") {
		size := parseSize(ss)
		src, sha, err := ensureSource(filepath.Join(*g.work, "src"), size)
		if err != nil {
			fatalf("source: %v", err)
		}
		home := filepath.Join(*g.work, "home_single_"+run.RunID+"_"+fmtSize(size))
		dev := newDevSeed("bench-client", true)
		srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
		if err != nil {
			fatalf("%v", err)
		}
		smp, _ := StartSampler(srv.PID, 200*time.Millisecond)
		cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
		hm, err := cl.Hello()
		if err != nil {
			fatalf("hello: %v", err)
		}
		time.Sleep(2 * time.Second)
		idle := smp.Between(time.Now().Add(-2*time.Second), time.Now())
		group := fmt.Sprintf("size=%s,chunk=%s,workers=%d,dedup=%v", fmtSize(size), *chunk, *workers, *dedup)
		for i := 0; i < *warm+*trials; i++ {
			tid := randHex(16)
			name := fmt.Sprintf("bench_%s_%d.bin", fmtSize(size), i)
			t0 := time.Now()
			smp.Poke()
			res := cl.UploadFile(UpOpts{Path: src, Size: size, Name: name, TID: tid, Chunk: cs, Workers: *workers, MaxNewChunks: -1, Dedup: *dedup})
			smp.Poke()
			t1 := time.Now()
			tr := Trial{Index: i + 1, Warmup: i < *warm, Group: group, Bytes: size, Files: 1, Seconds: res.TotalMs / 1000}
			if res.Err == "" {
				tr.Success = true
				tr.Integrity = verifyReceived(srv, res.FinalName, size, sha)
				if tr.Integrity != "sha256-match" {
					tr.Success = false
					tr.Error = "integrity: " + tr.Integrity
				}
				os.Remove(srv.ReceivedPath(res.FinalName))
			} else {
				tr.Error = res.Err
				tr.Integrity = "not-checked"
			}
			if tr.Seconds > 0 {
				tr.MiBps = float64(size) / MiB / tr.Seconds
			}
			m := smp.Between(t0, t1)
			tr.Mem = &m
			tr.Extra = map[string]any{"upload": res, "hello_ms": ms(hm), "idle_before_WS_MiB": idle.WSAvgMiB, "idle_before_priv_MiB": idle.PrivAvgMiB}
			run.Trials = append(run.Trials, tr)
			logf("[%s] trial %d warm=%v ok=%v %.2fs %.1f MiB/s WSmax=%.0f MiB privmax=%.0f MiB %s", fmtSize(size), i+1, tr.Warmup, tr.Success, tr.Seconds, tr.MiBps, m.WSMaxMiB, m.PrivMaxMiB, tr.Error)
			time.Sleep(2 * time.Second)
		}
		post := smp.Between(time.Now().Add(-2*time.Second), time.Now())
		peak := smp.LifetimePeakWS()
		run.Notes = append(run.Notes, fmt.Sprintf("size=%s: server idle before=%.1f MiB WS / %.1f MiB private; post-transfer (2 s after last trial)=%.1f MiB WS / %.1f MiB private; lifetime PeakWorkingSet=%.1f MiB", fmtSize(size), idle.WSAvgMiB, idle.PrivAvgMiB, post.WSAvgMiB, post.PrivAvgMiB, peak))
		smp.Stop()
		srv.Kill()
		os.RemoveAll(home)
	}
	finish(run, *g.out)
}

// ---------------------------------------------------------------------------
// small files
// ---------------------------------------------------------------------------

var mixedSizes = []int64{4 << 10, 64 << 10, 256 << 10, 1 << 20, 4 << 20}

type fileSpec struct {
	Path string
	Size int64
	SHA  string
	Name string
}

func genSmallSet(dir string, n int, fsize int64, mixed bool, tag string) ([]fileSpec, int64, error) {
	os.RemoveAll(dir)
	os.MkdirAll(dir, 0755)
	specs := make([]fileSpec, n)
	var total int64
	for i := 0; i < n; i++ {
		sz := fsize
		if mixed {
			sz = mixedSizes[i%len(mixedSizes)]
		}
		p := filepath.Join(dir, fmt.Sprintf("f_%05d.bin", i))
		h, err := writeRandomFile(p, sz, uint64(i)+1000003)
		if err != nil {
			return nil, 0, err
		}
		specs[i] = fileSpec{p, sz, h, fmt.Sprintf("%s_%05d.bin", tag, i)}
		total += sz
	}
	return specs, total, nil
}

func cmdSmall(args []string) {
	fs := flag.NewFlagSet("small", flag.ExitOnError)
	g := addCommon(fs)
	n := fs.Int("n", 1000, "number of files")
	fsize := fs.String("fsize", "100KiB", "file size (ignored with -mixed)")
	mixed := fs.Bool("mixed", false, "mixed sizes 4KiB..4MiB")
	fconc := fs.Int("fconc", 4, "files uploaded concurrently")
	trials := fs.Int("trials", 3, "measured trials")
	warm := fs.Int("warmup", 1, "warm-up trials")
	dedup := fs.Bool("dedup", true, "app-faithful pre-flight (SHA-256 + /upload_check_hash per file) inside timer")
	fs.Parse(args)
	env := captureEnv(*g.sut)
	run := newRun("small_files_loopback", "Measured: protocol end-to-end, Go reference client -> real p2p.exe over LOOPBACK TCP, many files", map[string]any{"files": *n, "file_size": *fsize, "mixed": *mixed, "file_concurrency": *fconc, "trials": *trials, "warmup": *warm, "dedup_preflight": *dedup}, env)
	run.Notes = append(run.Notes, "Timer: first request of first file -> last /upload_complete (or dedup reply) returned. File enumeration/generation is OUTSIDE the timer (the app enumerates File handles instantly). Per-file latency = that file's own init->complete (+dedup pre-flight) duration. Every received file is SHA-256 verified OUTSIDE the timer. Fresh server + empty receive dir per trial.")
	for i := 0; i < *warm+*trials; i++ {
		setDir := filepath.Join(*g.work, "smallset")
		specs, total, err := genSmallSet(setDir, *n, parseSize(*fsize), *mixed, fmt.Sprintf("t%d", i))
		if err != nil {
			fatalf("gen: %v", err)
		}
		home := filepath.Join(*g.work, fmt.Sprintf("home_small_%s_%d", run.RunID, i))
		dev := newDevSeed("bench-client", true)
		srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
		if err != nil {
			fatalf("%v", err)
		}
		smp, _ := StartSampler(srv.PID, 200*time.Millisecond)
		cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
		if _, err := cl.Hello(); err != nil {
			fatalf("hello: %v", err)
		}
		results := make([]UpRes, len(specs))
		jobs := make(chan int, len(specs))
		for k := range specs {
			jobs <- k
		}
		close(jobs)
		smp.Poke()
		t0 := time.Now()
		var wg sync.WaitGroup
		for w := 0; w < *fconc; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for k := range jobs {
					sp := specs[k]
					results[k] = cl.UploadFile(UpOpts{Path: sp.Path, Size: sp.Size, Name: sp.Name, TID: randHex(16), Chunk: MiB, Workers: 1, MaxNewChunks: -1, Dedup: *dedup})
				}
			}()
		}
		wg.Wait()
		smp.Poke()
		t1 := time.Now()
		elapsed := t1.Sub(t0).Seconds()
		time.Sleep(1 * time.Second)
		m := smp.Between(t0, t1)
		// verify
		ok, bad, failed := 0, 0, 0
		var lat []float64
		var dedupMs, initMs, completeMs []float64
		for k, r := range results {
			if r.Err != "" {
				failed++
				continue
			}
			lat = append(lat, r.TotalMs)
			if r.DedupMs > 0 {
				dedupMs = append(dedupMs, r.DedupMs)
			}
			initMs = append(initMs, r.InitMs)
			completeMs = append(completeMs, r.CompleteMs)
			if verifyReceived(srv, r.FinalName, specs[k].Size, specs[k].SHA) == "sha256-match" {
				ok++
			} else {
				bad++
			}
		}
		tr := Trial{Index: i + 1, Warmup: i < *warm, Bytes: total, Files: *n, Seconds: elapsed,
			Group: fmt.Sprintf("files=%d,size=%s,fconc=%d,dedup=%v", *n, map[bool]string{true: "mixed", false: *fsize}[*mixed], *fconc, *dedup)}
		tr.MiBps = float64(total) / MiB / elapsed
		tr.FilesPS = float64(*n) / elapsed
		tr.Success = failed == 0 && bad == 0
		tr.Integrity = fmt.Sprintf("%d/%d sha256-match, %d mismatch, %d failed", ok, *n, bad, failed)
		if !tr.Success {
			tr.Error = tr.Integrity
		}
		tr.Mem = &m
		tr.Extra = map[string]any{"per_file_total_latency_ms": computeStats(lat), "per_file_dedup_preflight_ms": computeStats(dedupMs), "per_file_init_ms": computeStats(initMs), "per_file_complete_ms": computeStats(completeMs), "avg_file_bytes": total / int64(*n)}
		run.Trials = append(run.Trials, tr)
		logf("small trial %d warm=%v: %d files %.1f MiB in %.2fs = %.1f files/s %.1f MiB/s | p50=%.0fms p95=%.0fms | %s", i+1, tr.Warmup, *n, float64(total)/MiB, elapsed, tr.FilesPS, tr.MiBps, computeStats(lat).Median, computeStats(lat).P95, tr.Integrity)
		smp.Stop()
		srv.Kill()
		os.RemoveAll(home)
		os.RemoveAll(setDir)
	}
	finish(run, *g.out)
}

// ---------------------------------------------------------------------------
// concurrent
// ---------------------------------------------------------------------------

func cmdConcurrent(args []string) {
	fs := flag.NewFlagSet("concurrent", flag.ExitOnError)
	g := addCommon(fs)
	ns := fs.String("n", "1,2,5,10", "concurrent transfer counts")
	size := fs.String("size", "256MiB", "size of each transfer")
	trials := fs.Int("trials", 3, "measured trials")
	warm := fs.Int("warmup", 1, "warm-up trials")
	workers := fs.Int("workers", 2, "parallel chunk uploads per transfer")
	chunk := fs.String("chunk", "1MiB", "chunk size")
	fs.Parse(args)
	env := captureEnv(*g.sut)
	sz := parseSize(*size)
	run := newRun("concurrent_loopback", "Measured: N simultaneous uploads, Go client -> real p2p.exe over LOOPBACK TCP", map[string]any{"counts": *ns, "size_each": *size, "trials": *trials, "workers_per_transfer": *workers, "chunk": *chunk}, env)
	run.Notes = append(run.Notes, "Aggregate = N*size / wall time from first request to last completion. Per-transfer = size / that transfer's own elapsed. These are different numbers and must not be conflated.")
	src, sha, err := ensureSource(filepath.Join(*g.work, "src"), sz)
	if err != nil {
		fatalf("%v", err)
	}
	for _, ncs := range strings.Split(*ns, ",") {
		cnt, _ := strconv.Atoi(ncs)
		home := filepath.Join(*g.work, fmt.Sprintf("home_conc_%s_%d", run.RunID, cnt))
		dev := newDevSeed("bench-client", true)
		srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
		if err != nil {
			fatalf("%v", err)
		}
		smp, _ := StartSampler(srv.PID, 200*time.Millisecond)
		cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
		cl.Hello()
		for i := 0; i < *warm+*trials; i++ {
			results := make([]UpRes, cnt)
			var wg sync.WaitGroup
			t0 := time.Now()
			smp.Poke()
			for k := 0; k < cnt; k++ {
				wg.Add(1)
				go func(k int) {
					defer wg.Done()
					results[k] = cl.UploadFile(UpOpts{Path: src, Size: sz, Name: fmt.Sprintf("c%d_%d_%d.bin", cnt, i, k), TID: randHex(16), Chunk: parseSize(*chunk), Workers: *workers, MaxNewChunks: -1})
				}(k)
			}
			wg.Wait()
			smp.Poke()
			t1 := time.Now()
			wall := t1.Sub(t0).Seconds()
			var per []float64
			failed, bad := 0, 0
			for _, r := range results {
				if r.Err != "" {
					failed++
					continue
				}
				per = append(per, float64(sz)/MiB/(r.TotalMs/1000))
				if verifyReceived(srv, r.FinalName, sz, sha) != "sha256-match" {
					bad++
				}
				os.Remove(srv.ReceivedPath(r.FinalName))
			}
			m := smp.Between(t0, t1)
			tr := Trial{Index: i + 1, Warmup: i < *warm, Group: fmt.Sprintf("transfers=%d,size=%s,workers=%d", cnt, *size, *workers), Bytes: sz * int64(cnt), Files: cnt, Seconds: wall, Mem: &m,
				Success: failed == 0 && bad == 0, Integrity: fmt.Sprintf("%d/%d verified, %d failed, %d mismatch", cnt-failed-bad, cnt, failed, bad)}
			tr.MiBps = float64(sz*int64(cnt)) / MiB / wall
			tr.Extra = map[string]any{"aggregate_MiB_per_s": tr.MiBps, "per_transfer_MiB_per_s": computeStats(per)}
			if !tr.Success {
				tr.Error = tr.Integrity
			}
			run.Trials = append(run.Trials, tr)
			logf("conc=%d trial %d: aggregate %.1f MiB/s, per-transfer median %.1f MiB/s, WSmax %.0f MiB, CPU %.0f%% core | %s", cnt, i+1, tr.MiBps, computeStats(per).Median, m.WSMaxMiB, m.CPUPctOfCore, tr.Integrity)
			time.Sleep(2 * time.Second)
		}
		run.Notes = append(run.Notes, fmt.Sprintf("transfers=%d: lifetime PeakWorkingSet=%.1f MiB", cnt, smp.LifetimePeakWS()))
		smp.Stop()
		srv.Kill()
		os.RemoveAll(home)
	}
	finish(run, *g.out)
}

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

func cmdResume(args []string) {
	fs := flag.NewFlagSet("resume", flag.ExitOnError)
	g := addCommon(fs)
	size := fs.String("size", "256MiB", "file size")
	pcts := fs.String("pcts", "10,25,50,75,90", "interruption points (percent)")
	trials := fs.Int("trials", 3, "trials per mode per point")
	modes := fs.String("modes", "abort,kill", "abort = client drops; kill = hard-kill server process then restart")
	fs.Parse(args)
	env := captureEnv(*g.sut)
	sz := parseSize(*size)
	run := newRun("resume_loopback", "Measured: interrupted-transfer recovery against the real p2p.exe (loopback)", map[string]any{"size": *size, "points_pct": *pcts, "trials": *trials, "modes": *modes, "chunk": "1MiB", "workers": 4}, env)
	run.Notes = append(run.Notes,
		"abort: client stops after k acknowledged chunks, opens a NEW session and resumes the same transfer id.",
		"kill: p2p.exe is terminated with TerminateProcess mid-transfer (not a graceful exit, not a power loss: OS page cache survives), restarted on a different port with the same -home, client re-handshakes and resumes.",
		"This does not test Wi-Fi drop/reconnect or Android process death; those need the phone and are in BENCHMARK_TEST_PLAN.md.")
	src, sha, err := ensureSource(filepath.Join(*g.work, "src"), sz)
	if err != nil {
		fatalf("%v", err)
	}
	total := int((sz + MiB - 1) / MiB)
	for _, mode := range strings.Split(*modes, ",") {
		for _, ps := range strings.Split(*pcts, ",") {
			pct, _ := strconv.Atoi(ps)
			k := total * pct / 100
			for t := 0; t < *trials; t++ {
				home := filepath.Join(*g.work, fmt.Sprintf("home_resume_%s_%s_%d_%d", run.RunID, mode, pct, t))
				dev := newDevSeed("bench-client", true)
				srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
				if err != nil {
					fatalf("%v", err)
				}
				cl := NewClient(srv.Base(), dev.ID, dev.Key, nil)
				cl.Hello()
				tid := randHex(16)
				name := fmt.Sprintf("resume_%s_%d_%d.bin", mode, pct, t)
				base := UpOpts{Path: src, Size: sz, Name: name, TID: tid, Chunk: MiB, Workers: 4, MaxNewChunks: -1}
				o1 := base
				o1.NoComplete = true
				if mode == "abort" {
					o1.AbortAfter = func(n int) bool { return n >= k }
				} else {
					var once sync.Once
					o1.AbortAfter = func(n int) bool {
						if n >= k {
							once.Do(func() { go srv.Kill() })
						}
						return false
					}
				}
				r1 := cl.UploadFile(o1)
				tr := Trial{Index: t + 1, Bytes: sz, Files: 1, Group: fmt.Sprintf("mode=%s,interrupt_at=%d%%,size=%s", mode, pct, *size)}
				srv2 := srv
				tReconnect := time.Now()
				var restartMs float64
				if mode == "kill" {
					srv.Kill()
					srv2, err = StartServer(*g.sut, home, *g.port+100, nil)
					if err != nil {
						tr.Error = "restart failed: " + err.Error()
						run.Trials = append(run.Trials, tr)
						os.RemoveAll(home)
						continue
					}
					restartMs = ms(srv2.ReadyIn)
				}
				cl2 := NewClient(srv2.Base(), dev.ID, dev.Key, nil)
				hm, herr := cl2.Hello()
				if herr != nil {
					tr.Error = "re-hello: " + herr.Error()
				} else {
					r2 := cl2.UploadFile(base)
					after := time.Since(tReconnect)
					tr.Seconds = after.Seconds()
					tr.Integrity = "not-checked"
					if r2.Err != "" {
						tr.Error = r2.Err
					} else {
						tr.Integrity = verifyReceived(srv2, r2.FinalName, sz, sha)
						tr.Success = tr.Integrity == "sha256-match"
						if !tr.Success {
							tr.Error = tr.Integrity
						}
					}
					tr.Extra = map[string]any{
						"interrupt_after_chunks_target": k, "total_chunks": total,
						"phase1_acked_chunks": r1.SentNow, "phase1_error": r1.Err,
						"server_had_chunks_at_resume": r2.AlreadyHad, "phase2_sent_chunks": r2.SentNow,
						"acked_chunks_lost_by_server": max(0, r1.SentNow-r2.AlreadyHad),
						"chunks_sent_total":           r1.SentNow + r2.SentNow,
						"redundant_chunks_resent":     r1.SentNow + r2.SentNow - total,
						"redundant_bytes_resent":      r1.PlainBytesNow + r2.PlainBytesNow - sz,
						"restart_to_ready_ms":         restartMs, "rehandshake_ms": ms(hm),
						"resume_init_ms": r2.InitMs, "time_reconnect_to_complete_ms": ms(after),
					}
					logf("resume %s@%d%% t%d: phase1 acked %d, server had %d, resent %d, redundant %d, after %.2fs, %s", mode, pct, t+1, r1.SentNow, r2.AlreadyHad, r2.SentNow, r1.SentNow+r2.SentNow-total, after.Seconds(), tr.Integrity)
				}
				run.Trials = append(run.Trials, tr)
				srv2.Kill()
				if srv2 != srv {
					srv.Kill()
				}
				os.RemoveAll(home)
			}
		}
	}
	finish(run, *g.out)
}

// ---------------------------------------------------------------------------
// security
// ---------------------------------------------------------------------------

func cmdSecurity(args []string) {
	fs := flag.NewFlagSet("security", flag.ExitOnError)
	g := addCommon(fs)
	fs.Parse(args)
	env := captureEnv(*g.sut)
	run := newRun("security", "Measured: black-box security checks against the real p2p.exe. Absence of a failure is NOT proof of security.", map[string]any{}, env)
	home := filepath.Join(*g.work, "home_sec_"+run.RunID)
	devA, devB := newDevSeed("sec-A", true), newDevSeed("sec-B", true)
	srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{devA, devB})
	if err != nil {
		fatalf("%v", err)
	}
	defer srv.Kill()
	idx := 0
	rec := func(name, expect, got string, pass bool) {
		idx++
		run.Trials = append(run.Trials, Trial{Index: idx, Success: pass, Group: name, Integrity: "n/a", Extra: map[string]any{"expected": expect, "observed": got}})
		mark := "PASS"
		if !pass {
			mark = "FAIL/FINDING"
		}
		logf("%-12s %-42s expected=%s observed=%s", mark, name, expect, got)
	}
	code := func(err error) int {
		if err == nil {
			return 200
		}
		if he, ok := err.(*HTTPErr); ok {
			return he.Status
		}
		return -1
	}
	hc := newHTTP()
	hc.Timeout = 10 * time.Second
	base := srv.Base()

	// slow-header connection runs in the background
	slow := make(chan string, 1)
	go func() {
		c, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", srv.Port))
		if err != nil {
			slow <- "dial error"
			return
		}
		defer c.Close()
		c.Write([]byte("GET / HTTP/1.1\r\nHost: localhost\r\nX-Slow: a"))
		start := time.Now()
		for time.Since(start) < 35*time.Second {
			c.SetReadDeadline(time.Now().Add(5 * time.Second))
			buf := make([]byte, 16)
			if _, err := c.Read(buf); err != nil {
				if ne, ok := err.(net.Error); ok && ne.Timeout() {
					c.Write([]byte("b"))
					continue
				}
				slow <- fmt.Sprintf("server closed connection after %.0fs", time.Since(start).Seconds())
				return
			}
		}
		slow <- "connection with incomplete headers still open after 35s"
	}()

	// a. unauthenticated access
	paths := []string{"/upload_init", "/upload", "/upload_complete", "/upload_cancel", "/download", "/download_full", "/device_alias", "/settings", "/unpair", "/upload_check_hash"}
	bad := []string{}
	for _, p := range paths {
		for _, m := range []string{"GET", "POST"} {
			req, _ := http.NewRequest(m, base+p, bytes.NewReader([]byte("x")))
			r, err := hc.Do(req)
			if err != nil {
				bad = append(bad, p+" err")
				continue
			}
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
			if r.StatusCode != 401 {
				bad = append(bad, fmt.Sprintf("%s %s=%d", m, p, r.StatusCode))
			}
		}
	}
	rec("unauthenticated requests rejected", "401 on all 20 (10 endpoints x GET/POST)", fmt.Sprintf("violations: %v", bad), len(bad) == 0)

	cl := NewClient(base, devA.ID, devA.Key, hc)
	if _, err := cl.Hello(); err != nil {
		fatalf("hello: %v", err)
	}
	clB := NewClient(base, devB.ID, devB.Key, hc)
	clB.Hello()

	post := func(c *Client, path string, params map[string]string, body []byte) (int, string) {
		u := c.SignedURL("POST", path, params, "")
		r, err := c.HC.Post(u, "application/octet-stream", bytes.NewReader(body))
		if err != nil {
			return -1, err.Error()
		}
		defer r.Body.Close()
		d, _ := io.ReadAll(io.LimitReader(r.Body, 512))
		return r.StatusCode, strings.TrimSpace(string(d))
	}
	// b. bad sid / bad mac
	r1, err1 := hc.Post(base+"/upload_init?sid=deadbeef&n=1&mac=00", "application/octet-stream", bytes.NewReader([]byte("x")))
	s1 := -1
	if err1 == nil {
		s1 = r1.StatusCode
		r1.Body.Close()
	}
	rec("unknown session id", "401", strconv.Itoa(s1), s1 == 401)
	u := cl.SignedURL("POST", "/upload_init", nil, "")
	u = strings.Replace(u, "mac=", "mac=00", 1)
	r2, err2 := hc.Post(u, "application/octet-stream", bytes.NewReader([]byte("x")))
	s2 := -1
	if err2 == nil {
		s2 = r2.StatusCode
		r2.Body.Close()
	}
	rec("tampered request MAC", "401", strconv.Itoa(s2), s2 == 401)

	// c. replay of a captured, valid request
	tid0 := randHex(16)
	u = cl.SignedURL("POST", "/upload_init", nil, "")
	n0 := nonceOf(u)
	pt, _ := json_(uploadInit{tid0, "replay.bin", 10, 65536, 1})
	body := cl.sealInto(make([]byte, 12, len(pt)+28), pt, "req\n/upload_init\n"+n0)
	sendRaw := func() int {
		r, err := hc.Post(u, "application/octet-stream", bytes.NewReader(body))
		if err != nil {
			return -1
		}
		r.Body.Close()
		return r.StatusCode
	}
	a, b := sendRaw(), sendRaw()
	rec("replayed identical request (same nonce)", "first 200, replay 401", fmt.Sprintf("first %d, replay %d", a, b), a == 200 && b == 401)

	// d. modified sealed metadata
	u = cl.SignedURL("POST", "/upload_init", nil, "")
	n1 := nonceOf(u)
	pt, _ = json_(uploadInit{randHex(16), "x.bin", 10, 65536, 1})
	body = cl.sealInto(make([]byte, 12, len(pt)+28), pt, "req\n/upload_init\n"+n1)
	body[20] ^= 0x01
	st, _ := post2(hc, u, body)
	rec("bit-flipped sealed metadata", "400", strconv.Itoa(st), st == 400)
	u = cl.SignedURL("POST", "/upload_init", nil, "")
	n2 := nonceOf(u)
	body = cl.sealInto(make([]byte, 12, len(pt)+28), pt, "req\n/upload_complete\n"+n2) // wrong path context
	st, _ = post2(hc, u, body)
	rec("sealed for a different path (context binding)", "400", strconv.Itoa(st), st == 400)

	// e. chunk integrity checks on a real transfer
	tid := randHex(16)
	var stt uploadStatus
	cl.JSONCall("/upload_init", uploadInit{tid, "integ.bin", 100, 65536, 1}, &stt)
	plain := bytes.Repeat([]byte{7}, 100)
	sealedOK := cl.sealInto(make([]byte, 12, 200), plain, "chunk\n"+tid+"\n0")
	flip := append([]byte{}, sealedOK...)
	flip[30] ^= 1
	st, _ = post(cl, "/upload", map[string]string{"transferId": tid, "chunkIndex": "0"}, flip)
	rec("bit-flipped chunk ciphertext", "400", strconv.Itoa(st), st == 400)
	wrongIdx := cl.sealInto(make([]byte, 12, 200), plain, "chunk\n"+tid+"\n1")
	st, _ = post(cl, "/upload", map[string]string{"transferId": tid, "chunkIndex": "0"}, wrongIdx)
	rec("chunk sealed for another index", "400", strconv.Itoa(st), st == 400)
	short := cl.sealInto(make([]byte, 12, 200), plain[:50], "chunk\n"+tid+"\n0")
	st, _ = post(cl, "/upload", map[string]string{"transferId": tid, "chunkIndex": "0"}, short)
	rec("authentic chunk with wrong length", "400", strconv.Itoa(st), st == 400)
	st, _ = post(cl, "/upload", map[string]string{"transferId": tid, "chunkIndex": "0"}, make([]byte, 2*MiB))
	rec("oversized chunk body (2 MiB for a 100 B chunk)", "400", strconv.Itoa(st), st == 400)
	st, _ = post(cl, "/upload", map[string]string{"transferId": tid, "chunkIndex": "99"}, sealedOK)
	rec("chunk index out of range", "400", strconv.Itoa(st), st == 400)
	err = cl.JSONCall("/upload_complete", map[string]string{"transferId": tid}, nil)
	rec("complete with missing chunks", "409", strconv.Itoa(code(err)), code(err) == 409)
	st, _ = post(cl, "/upload", map[string]string{"transferId": randHex(16), "chunkIndex": "0"}, sealedOK)
	rec("chunk for unknown transfer id", "404", strconv.Itoa(st), st == 404)

	// f. layout validation
	layouts := []struct {
		name string
		req  uploadInit
	}{
		{"chunkSize below minimum", uploadInit{randHex(16), "l.bin", 100, 1, 100}},
		{"chunkSize above maximum", uploadInit{randHex(16), "l.bin", 100, 64 << 20, 1}},
		{"totalSize above 5 TiB cap", uploadInit{randHex(16), "l.bin", 6 << 40, 8 << 20, 786432}},
		{"negative totalSize", uploadInit{randHex(16), "l.bin", -5, 65536, 0}},
		{"totalChunks inconsistent with size", uploadInit{randHex(16), "l.bin", 1000, 65536, 5}},
		{"empty transfer id", uploadInit{"", "l.bin", 10, 65536, 1}},
	}
	for _, l := range layouts {
		err := cl.JSONCall("/upload_init", l.req, nil)
		rec("invalid layout: "+l.name, "400", strconv.Itoa(code(err)), code(err) == 400)
	}
	// oversized JSON body
	big := make([]byte, 100<<10)
	st, _ = post(cl, "/upload_init", nil, big)
	rec("oversized (100 KiB) request body", "400", strconv.Itoa(st), st == 400)

	// g. filename handling
	evil := []string{`../../evil.txt`, `..\..\evil.txt`, `C:\Windows\Temp\evil.txt`, `/etc/passwd`, `con`, `aux.txt`, `..`, `.`, `a/b/c.txt`, `evil.txt:ads`, `   `, strings.Repeat("A", 1000), "nul\x00byte.txt", `\\server\share\evil.txt`}
	parent := filepath.Dir(home)
	escapeTargets := []string{filepath.Join(home, "evil.txt"), filepath.Join(parent, "evil.txt"), `C:\Windows\Temp\evil.txt`, `C:\evil.txt`, filepath.Join(home, "temp", "evil.txt")}
	var escapes []string
	var finals []string
	for _, nm := range evil {
		t := randHex(16)
		var s2 uploadStatus
		e := cl.JSONCall("/upload_init", uploadInit{t, nm, 10, 65536, 1}, &s2)
		if e != nil {
			finals = append(finals, fmt.Sprintf("%q->init %d", nm, code(e)))
			continue
		}
		sealed := cl.sealInto(make([]byte, 12, 100), []byte("0123456789"), "chunk\n"+t+"\n0")
		post(cl, "/upload", map[string]string{"transferId": t, "chunkIndex": "0"}, sealed)
		var done struct {
			Filename string `json:"filename"`
		}
		e = cl.JSONCall("/upload_complete", map[string]string{"transferId": t}, &done)
		if e == nil {
			finals = append(finals, fmt.Sprintf("%q->%q", nm, done.Filename))
			if _, err := os.Stat(srv.ReceivedPath(done.Filename)); err != nil {
				escapes = append(escapes, "final file not inside received/: "+done.Filename)
			}
		} else {
			finals = append(finals, fmt.Sprintf("%q->complete %d", nm, code(e)))
		}
	}
	for _, t := range escapeTargets {
		if _, err := os.Stat(t); err == nil {
			escapes = append(escapes, "exists: "+t)
		}
	}
	filepath.Walk(home, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() {
			rel, _ := filepath.Rel(home, p)
			if !strings.HasPrefix(rel, "received") && !strings.HasPrefix(rel, "temp") && rel != "state.json" && !strings.HasPrefix(rel, "history") && !strings.HasSuffix(rel, ".json") && !strings.HasSuffix(rel, ".tmp") {
				escapes = append(escapes, "unexpected file: "+rel)
			}
		}
		return nil
	})
	rec("malicious filenames stay inside received/", "no file written outside received/", fmt.Sprintf("escapes=%v; mapped=%v", escapes, finals), len(escapes) == 0)

	// h. cross-device isolation
	tidA := randHex(16)
	cl.JSONCall("/upload_init", uploadInit{tidA, "owner.bin", 100, 65536, 1}, &stt)
	cA := cl.sealInto(make([]byte, 12, 200), plain, "chunk\n"+tidA+"\n0")
	stB, _ := post(clB, "/upload", map[string]string{"transferId": tidA, "chunkIndex": "0"}, clB.sealInto(make([]byte, 12, 200), plain, "chunk\n"+tidA+"\n0"))
	errC := clB.JSONCall("/upload_complete", map[string]string{"transferId": tidA}, nil)
	errX := clB.JSONCall("/upload_cancel", map[string]string{"transferId": tidA}, nil)
	_ = cA
	_ = errX
	rec("device B cannot write to device A's transfer", "404", fmt.Sprintf("chunk %d, complete %d", stB, code(errC)), stB == 404 && code(errC) == 404)
	// B 'cancel' returns ok but must not delete A's transfer:
	stA, _ := post(cl, "/upload", map[string]string{"transferId": tidA, "chunkIndex": "0"}, cA)
	rec("device B cancel does not destroy A's transfer", "A can still upload chunk (200)", strconv.Itoa(stA), stA == 200)

	// i. malformed pairing / hello
	for _, tc := range []struct{ name, path, body string }{
		{"/pair malformed JSON", "/pair", "{not json"},
		{"/pair invalid device id", "/pair", `{"deviceId":"x","name":"n","mac":"00"}`},
		{"/hello short nonce", "/hello", `{"deviceId":"` + devA.ID + `","clientNonce":"00"}`},
		{"/hello unpaired device", "/hello", `{"deviceId":"unpaired_device_01","clientNonce":"` + randHex(16) + `"}`},
	} {
		r, err := hc.Post(base+tc.path, "application/json", strings.NewReader(tc.body))
		sc := -1
		if err == nil {
			sc = r.StatusCode
			r.Body.Close()
		}
		exp := 400
		if strings.Contains(tc.name, "unpaired") {
			exp = 401
		}
		rec(tc.name, strconv.Itoa(exp), strconv.Itoa(sc), sc == exp)
	}
	// local IPC without token
	r, err := hc.Post(base+"/local/send", "application/json", strings.NewReader(`{"path":"C:\\Windows\\win.ini"}`))
	sc := -1
	if err == nil {
		sc = r.StatusCode
		r.Body.Close()
	}
	rec("/local/send without token", "401 or 403", strconv.Itoa(sc), sc == 401 || sc == 403)

	// j. revocation
	clR := NewClient(base, devB.ID, devB.Key, hc)
	clR.Hello()
	e := clR.JSONCall("/unpair", map[string]string{}, nil)
	stOld, _ := post(clR, "/upload_init", nil, []byte("x"))
	_, eh := NewClient(base, devB.ID, devB.Key, hc).Hello()
	rec("revoked device: unpair accepted", "200", strconv.Itoa(code(e)), code(e) == 200)
	rec("revoked device: old session rejected", "401", strconv.Itoa(stOld), stOld == 401)
	rec("revoked device: new /hello rejected", "401", strconv.Itoa(code(eh)), code(eh) == 401)

	// k. brute force pairing lockout
	locked := 0
	for i := 1; i <= 40; i++ {
		body := fmt.Sprintf(`{"deviceId":"bruteforce_%02d_dev","name":"x","mac":"%s"}`, i, randHex(32))
		r, err := hc.Post(base+"/pair", "application/json", strings.NewReader(body))
		if err != nil {
			continue
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode == 429 {
			locked = i
			break
		}
	}
	rec("pairing brute-force lockout", "HTTP 429 within <= 10 bad attempts", fmt.Sprintf("429 at attempt %d (0 = never)", locked), locked > 0 && locked <= 10)

	// l. secrets in logs and at rest
	logs := srv.Out.String()
	leaks := []string{}
	for _, d := range []*DevSeed{devA, devB} {
		for _, form := range []string{hex.EncodeToString(d.Key), base64.StdEncoding.EncodeToString(d.Key)} {
			if strings.Contains(logs, form) {
				leaks = append(leaks, "device key of "+d.Name)
			}
		}
	}
	for _, k := range []*Client{cl, clB} {
		if k.Key != nil && strings.Contains(logs, hex.EncodeToString(k.Key)) {
			leaks = append(leaks, "session key")
		}
	}
	rec("device/session keys absent from process output", "none found", fmt.Sprintf("leaks=%v (stdout/stderr %d bytes inspected)", leaks, len(logs)), len(leaks) == 0)
	stateRaw, _ := os.ReadFile(filepath.Join(home, "state.json"))
	plainKey := strings.Contains(string(stateRaw), base64.StdEncoding.EncodeToString(devA.Key))
	acl := psOut(fmt.Sprintf(`(Get-Acl '%s').AccessToString -replace "\r?\n"," | "`, filepath.Join(home, "state.json")))
	rec("device keys encrypted at rest (DPAPI / OS keystore)", "keys not recoverable from state.json", fmt.Sprintf("plaintext (base64) key present in state.json=%v; ACL: %s", plainKey, acl), !plainKey)

	// m. TLS mode
	home2 := filepath.Join(*g.work, "home_sec_tls_"+run.RunID)
	srvT, err := StartServer(*g.sut, home2, *g.port+1, nil, "-tls")
	if err != nil {
		rec("TLS server start", "starts", err.Error(), false)
	} else {
		type tc struct {
			name     string
			min, max uint16
		}
		var obs []string
		okLegacyRejected := true
		for _, c := range []tc{{"TLS1.0", tls.VersionTLS10, tls.VersionTLS10}, {"TLS1.1", tls.VersionTLS11, tls.VersionTLS11}, {"TLS1.2", tls.VersionTLS12, tls.VersionTLS12}, {"TLS1.3", tls.VersionTLS13, tls.VersionTLS13}} {
			conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 3 * time.Second}, "tcp", fmt.Sprintf("127.0.0.1:%d", srvT.Port), &tls.Config{InsecureSkipVerify: true, MinVersion: c.min, MaxVersion: c.max})
			if err == nil {
				obs = append(obs, c.name+"=accepted")
				if c.min < tls.VersionTLS12 {
					okLegacyRejected = false
				}
				conn.Close()
			} else {
				obs = append(obs, c.name+"=rejected")
			}
		}
		rec("TLS mode (-tls, off by default): legacy versions rejected", "TLS1.0/1.1 rejected", strings.Join(obs, ", "), okLegacyRejected)
		srvT.Kill()
		os.RemoveAll(home2)
	}
	rec("default transport", "documented", "plain HTTP + application-layer AES-256-GCM (TLS only with -tls flag)", true)

	rec("slow-header (slowloris) connection is closed by server", "server closes within 30 s", <-slow, false)
	// the line above is overwritten below if the server did close
	last := &run.Trials[len(run.Trials)-1]
	if strings.Contains(last.Extra["observed"].(string), "server closed") {
		last.Success = true
	}

	pass, fail := 0, 0
	for _, t := range run.Trials {
		if t.Success {
			pass++
		} else {
			fail++
		}
	}
	run.Notes = append(run.Notes, fmt.Sprintf("%d checks passed, %d failed/findings. A passing result only means the specific probe was handled correctly.", pass, fail))
	finish(run, *g.out)
	os.RemoveAll(home)
}

func json_(v any) ([]byte, error) { return json.Marshal(v) }

func post2(hc *http.Client, u string, body []byte) (int, string) {
	r, err := hc.Post(u, "application/octet-stream", bytes.NewReader(body))
	if err != nil {
		return -1, err.Error()
	}
	defer r.Body.Close()
	d, _ := io.ReadAll(io.LimitReader(r.Body, 256))
	return r.StatusCode, string(d)
}

// ---------------------------------------------------------------------------
// phone-side client (cross-compiled to linux/arm64 and run via adb)
// ---------------------------------------------------------------------------

type phoneFile struct {
	Name  string  `json:"name"`
	Final string  `json:"final,omitempty"`
	SHA   string  `json:"sha256"`
	Size  int64   `json:"size"`
	Ms    float64 `json:"ms"`
	Err   string  `json:"error,omitempty"`
}

type phoneTrial struct {
	Trial    int         `json:"trial"`
	Warmup   bool        `json:"warmup"`
	Mode     string      `json:"mode"`
	ElapsedS float64     `json:"elapsed_s"`
	Bytes    int64       `json:"bytes"`
	SrcSHA   string      `json:"src_sha256,omitempty"`
	HelloMs  float64     `json:"hello_ms"`
	Up       *UpRes      `json:"up,omitempty"`
	Files    []phoneFile `json:"files,omitempty"`
	Err      string      `json:"error,omitempty"`
}

func cmdClient(args []string) {
	fs := flag.NewFlagSet("client", flag.ExitOnError)
	addr := fs.String("addr", "", "host:port of p2p server")
	id := fs.String("id", "", "device id")
	keyHex := fs.String("key", "", "device key hex")
	mode := fs.String("mode", "single", "single|small")
	size := fs.String("size", "100MiB", "")
	n := fs.Int("n", 1000, "")
	fsize := fs.String("fsize", "100KiB", "")
	mixed := fs.Bool("mixed", false, "")
	fconc := fs.Int("fconc", 4, "")
	trials := fs.Int("trials", 3, "")
	warm := fs.Int("warmup", 1, "")
	workers := fs.Int("workers", 4, "")
	chunk := fs.String("chunk", "1MiB", "")
	dedup := fs.Bool("dedup", false, "")
	srcdir := fs.String("srcdir", "/data/local/tmp/p2psrc", "")
	fs.Parse(args)
	key, _ := hex.DecodeString(*keyHex)
	cl := NewClient("http://"+*addr, *id, key, nil)
	enc := json.NewEncoder(os.Stdout)
	for i := 0; i < *warm+*trials; i++ {
		pt := phoneTrial{Trial: i + 1, Warmup: i < *warm, Mode: *mode}
		hm, err := cl.Hello()
		if err != nil {
			pt.Err = err.Error()
			enc.Encode(pt)
			continue
		}
		pt.HelloMs = ms(hm)
		if *mode == "single" {
			sz := parseSize(*size)
			src, sha, err := ensureSource(*srcdir, sz)
			if err != nil {
				pt.Err = err.Error()
				enc.Encode(pt)
				continue
			}
			pt.SrcSHA, pt.Bytes = sha, sz
			t0 := time.Now()
			res := cl.UploadFile(UpOpts{Path: src, Size: sz, Name: fmt.Sprintf("phone_%s_%d.bin", fmtSize(sz), i), TID: randHex(16), Chunk: parseSize(*chunk), Workers: *workers, MaxNewChunks: -1, Dedup: *dedup})
			pt.ElapsedS = time.Since(t0).Seconds()
			pt.Up = &res
		} else {
			dir := filepath.Join(*srcdir, "small")
			specs, total, err := genSmallSet(dir, *n, parseSize(*fsize), *mixed, fmt.Sprintf("ph%d", i))
			if err != nil {
				pt.Err = err.Error()
				enc.Encode(pt)
				continue
			}
			pt.Bytes = total
			files := make([]phoneFile, len(specs))
			jobs := make(chan int, len(specs))
			for k := range specs {
				jobs <- k
			}
			close(jobs)
			var wg sync.WaitGroup
			t0 := time.Now()
			for w := 0; w < *fconc; w++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					for k := range jobs {
						sp := specs[k]
						r := cl.UploadFile(UpOpts{Path: sp.Path, Size: sp.Size, Name: sp.Name, TID: randHex(16), Chunk: MiB, Workers: 1, MaxNewChunks: -1, Dedup: *dedup})
						files[k] = phoneFile{Name: sp.Name, Final: r.FinalName, SHA: sp.SHA, Size: sp.Size, Ms: r.TotalMs, Err: r.Err}
					}
				}()
			}
			wg.Wait()
			pt.ElapsedS = time.Since(t0).Seconds()
			pt.Files = files
			os.RemoveAll(dir)
		}
		enc.Encode(pt)
	}
}

// ---------------------------------------------------------------------------
// wifi orchestration (PC server, phone client over real Wi-Fi)
// ---------------------------------------------------------------------------

func adbCmd(adb string, args ...string) (string, error) {
	out, err := exec.Command(adb, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func cmdWifi(args []string) {
	fs := flag.NewFlagSet("wifi", flag.ExitOnError)
	g := addCommon(fs)
	adb := fs.String("adb", `E:\Android\Sdk\platform-tools\adb.exe`, "adb path")
	pcip := fs.String("pcip", "", "PC LAN IP reachable from phone")
	mode := fs.String("mode", "single", "single|small")
	sizes := fs.String("sizes", "100MiB", "sizes (single mode)")
	n := fs.Int("n", 1000, "")
	fsize := fs.String("fsize", "100KiB", "")
	mixed := fs.Bool("mixed", false, "")
	fconc := fs.Int("fconc", 4, "")
	trials := fs.Int("trials", 3, "")
	warm := fs.Int("warmup", 1, "")
	workers := fs.Int("workers", 4, "")
	chunk := fs.String("chunk", "1MiB", "")
	dedup := fs.Bool("dedup", false, "")
	nobuild := fs.Bool("nobuild", false, "")
	fs.Parse(args)
	if *pcip == "" {
		fatalf("-pcip required")
	}
	env := captureEnv(*g.sut)
	if phone, err := adbCmd(*adb, "shell", "getprop ro.product.model; getprop ro.build.version.release; getprop ro.product.manufacturer"); err == nil {
		env.Network["phone_props(model;android;manufacturer)"] = strings.ReplaceAll(phone, "\r\n", ";")
	}
	if w, err := adbCmd(*adb, "shell", "dumpsys wifi | grep -m1 -E 'mWifiInfo|Wi-Fi is'"); err == nil {
		env.Network["phone_wifi_info"] = w
	}
	bin := filepath.Join(*g.work, "p2pbench_arm64")
	if !*nobuild {
		c := exec.Command("go", "build", "-o", bin, "./bench")
		c.Env = append(os.Environ(), "GOOS=linux", "GOARCH=arm64", "CGO_ENABLED=0")
		if out, err := c.CombinedOutput(); err != nil {
			fatalf("build arm64: %v\n%s", err, out)
		}
	}
	if out, err := adbCmd(*adb, "push", bin, "/data/local/tmp/p2pbench"); err != nil {
		fatalf("push: %v %s", err, out)
	}
	adbCmd(*adb, "shell", "chmod 755 /data/local/tmp/p2pbench")
	run := newRun("wifi_"+*mode, "Measured: protocol end-to-end over REAL Wi-Fi, Go reference client on the PHONE (linux/arm64 binary via adb) -> real p2p.exe on PC. Android->Windows direction only. This is NOT the Android app.", map[string]any{"mode": *mode, "sizes": *sizes, "n": *n, "fsize": *fsize, "mixed": *mixed, "fconc": *fconc, "trials": *trials, "warmup": *warm, "workers": *workers, "chunk": *chunk, "dedup_preflight": *dedup, "pc_ip": *pcip}, env)
	run.Notes = append(run.Notes,
		"The phone-side client is the Go harness client, not the Capacitor/WebView app: JS crypto, WebView file access and the app's whole-file pre-hash are NOT exercised.",
		"Phone: client runs from /data/local/tmp (shell uid), screen state/battery saver as recorded in the Android probe, not controlled here.",
		"Timer runs on the phone: first request -> last /upload_complete reply. Hash verification of the received files is done on the PC after the run.")
	runOne := func(label string, extra []string, size int64, files int) {
		home := filepath.Join(*g.work, "home_wifi_"+run.RunID+"_"+label)
		dev := newDevSeed("phone-bench", true)
		srv, err := StartServer(*g.sut, home, *g.port, []*DevSeed{dev})
		if err != nil {
			fatalf("%v", err)
		}
		smp, _ := StartSampler(srv.PID, 250*time.Millisecond)
		cmdline := fmt.Sprintf("/data/local/tmp/p2pbench client -addr %s:%d -id %s -key %s -trials %d -warmup %d -workers %d -chunk %s -dedup=%v %s",
			*pcip, srv.Port, dev.ID, hex.EncodeToString(dev.Key), *trials, *warm, *workers, *chunk, *dedup, strings.Join(extra, " "))
		logf("phone: %s", strings.ReplaceAll(cmdline, hex.EncodeToString(dev.Key), "<key>"))
		t0 := time.Now()
		out, err := exec.Command(*adb, "exec-out", cmdline).Output()
		if err != nil {
			logf("adb run error: %v", err)
		}
		sc := bufio.NewScanner(bytes.NewReader(out))
		sc.Buffer(make([]byte, 1<<20), 64<<20)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if !strings.HasPrefix(line, "{") {
				continue
			}
			var pt phoneTrial
			if json.Unmarshal([]byte(line), &pt) != nil {
				continue
			}
			tr := Trial{Index: pt.Trial, Warmup: pt.Warmup, Seconds: pt.ElapsedS, Bytes: pt.Bytes, Extra: map[string]any{"hello_ms": pt.HelloMs}}
			if pt.Mode == "single" {
				tr.Group = fmt.Sprintf("size=%s,chunk=%s,workers=%d,dedup=%v", fmtSize(size), *chunk, *workers, *dedup)
				tr.Files = 1
				if pt.Err != "" || pt.Up == nil || pt.Up.Err != "" {
					tr.Error = pt.Err
					if pt.Up != nil {
						tr.Error += pt.Up.Err
					}
					tr.Integrity = "not-checked"
				} else {
					tr.Integrity = verifyReceived(srv, pt.Up.FinalName, size, pt.SrcSHA)
					tr.Success = tr.Integrity == "sha256-match"
					tr.Extra["upload"] = pt.Up
					os.Remove(srv.ReceivedPath(pt.Up.FinalName))
				}
				if pt.ElapsedS > 0 {
					tr.MiBps = float64(size) / MiB / pt.ElapsedS
				}
			} else {
				tr.Group = fmt.Sprintf("files=%d,size=%s,fconc=%d,dedup=%v", files, map[bool]string{true: "mixed", false: *fsize}[*mixed], *fconc, *dedup)
				tr.Files = files
				ok, bad, failed := 0, 0, 0
				var lat []float64
				for _, f := range pt.Files {
					if f.Err != "" || f.Final == "" {
						failed++
						continue
					}
					lat = append(lat, f.Ms)
					if verifyReceived(srv, f.Final, f.Size, f.SHA) == "sha256-match" {
						ok++
					} else {
						bad++
					}
					os.Remove(srv.ReceivedPath(f.Final))
				}
				tr.Success = failed == 0 && bad == 0 && len(pt.Files) == files
				tr.Integrity = fmt.Sprintf("%d/%d sha256-match, %d mismatch, %d failed", ok, files, bad, failed)
				if !tr.Success {
					tr.Error = tr.Integrity + " " + pt.Err
				}
				if pt.ElapsedS > 0 {
					tr.MiBps = float64(pt.Bytes) / MiB / pt.ElapsedS
					tr.FilesPS = float64(files) / pt.ElapsedS
				}
				tr.Extra["per_file_latency_ms"] = computeStats(lat)
			}
			run.Trials = append(run.Trials, tr)
			logf("wifi %s trial %d warm=%v ok=%v %.2fs %.2f MiB/s %.1f files/s | %s %s", label, tr.Index, tr.Warmup, tr.Success, tr.Seconds, tr.MiBps, tr.FilesPS, tr.Integrity, tr.Error)
		}
		m := smp.Between(t0, time.Now())
		run.Notes = append(run.Notes, fmt.Sprintf("%s: server process during phone run: WS max=%.1f MiB, private max=%.1f MiB, CPU=%.1f%% of one core (avg over whole run incl. phone-side generation gaps)", label, m.WSMaxMiB, m.PrivMaxMiB, m.CPUPctOfCore))
		smp.Stop()
		srv.Kill()
		os.RemoveAll(home)
	}
	if *mode == "single" {
		for _, s := range strings.Split(*sizes, ",") {
			sz := parseSize(s)
			runOne(fmtSize(sz), []string{"-mode", "single", "-size", s}, sz, 1)
		}
	} else {
		extra := []string{"-mode", "small", "-n", strconv.Itoa(*n), "-fsize", *fsize, "-fconc", strconv.Itoa(*fconc)}
		if *mixed {
			extra = append(extra, "-mixed")
		}
		runOne("small", extra, 0, *n)
	}
	finish(run, *g.out)
}

// ---------------------------------------------------------------------------
// raw TCP/HTTP baseline between PC and phone (iperf3 substitute; iperf3 is not installed)
// ---------------------------------------------------------------------------

func cmdTCPBase(args []string) {
	fs := flag.NewFlagSet("tcpbase", flag.ExitOnError)
	g := addCommon(fs)
	adb := fs.String("adb", `E:\Android\Sdk\platform-tools\adb.exe`, "adb path")
	pcip := fs.String("pcip", "", "PC LAN IP reachable from phone")
	mb := fs.Int("mb", 100, "payload MiB per trial")
	trials := fs.Int("trials", 5, "trials per direction")
	fs.Parse(args)
	if *pcip == "" {
		fatalf("-pcip required")
	}
	env := captureEnv("")
	run := newRun("tcp_baseline_wifi", "Measured: raw HTTP/TCP goodput PC<->phone over the real Wi-Fi link (curl on phone, Go server on PC). iperf3 is not installed; this is the baseline that app throughput must be compared against.", map[string]any{"payload_MiB": *mb, "trials": *trials, "pc_ip": *pcip}, env)
	var upMu sync.Mutex
	var upSecs []float64
	mux := http.NewServeMux()
	mux.HandleFunc("/down", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(*mb*MiB))
		buf := make([]byte, 64<<10)
		rand.Read(buf)
		for i := 0; i < *mb*MiB/len(buf); i++ {
			if _, err := w.Write(buf); err != nil {
				return
			}
		}
	})
	mux.HandleFunc("/up", func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 64<<10)
		var got int64
		var first time.Time
		for {
			n, err := r.Body.Read(buf)
			if n > 0 && first.IsZero() {
				first = time.Now()
			}
			got += int64(n)
			if err != nil {
				break
			}
		}
		upMu.Lock()
		if !first.IsZero() {
			upSecs = append(upSecs, time.Since(first).Seconds())
		}
		upMu.Unlock()
		w.WriteHeader(200)
	})
	ln, err := net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", *g.port+50))
	if err != nil {
		fatalf("%v", err)
	}
	go http.Serve(ln, mux)
	port := *g.port + 50
	adbCmd(*adb, "shell", fmt.Sprintf("dd if=/dev/urandom of=/data/local/tmp/upload.bin bs=1048576 count=%d 2>/dev/null", *mb))
	idx := 0
	for i := 0; i < *trials; i++ {
		for _, dir := range []string{"down", "up"} {
			var cmd string
			if dir == "down" {
				cmd = fmt.Sprintf("curl -s -o /dev/null -w '%%{size_download} %%{time_total}' http://%s:%d/down", *pcip, port)
			} else {
				cmd = fmt.Sprintf("curl -s -o /dev/null -w '%%{size_upload} %%{time_total}' --data-binary @/data/local/tmp/upload.bin -H 'Content-Type: application/octet-stream' http://%s:%d/up", *pcip, port)
			}
			out, err := adbCmd(*adb, "shell", cmd)
			idx++
			tr := Trial{Index: idx, Group: "direction=" + map[string]string{"down": "PC->phone", "up": "phone->PC"}[dir], Integrity: "n/a"}
			var bytesN, secs float64
			if _, e := fmt.Sscanf(out, "%f %f", &bytesN, &secs); e == nil && secs > 0 && int64(bytesN) == int64(*mb)*MiB {
				tr.Success = true
				tr.Bytes = int64(bytesN)
				tr.Seconds = secs
				tr.MiBps = bytesN / MiB / secs
			} else {
				tr.Error = fmt.Sprintf("bad curl output %q err=%v", out, err)
			}
			run.Trials = append(run.Trials, tr)
			logf("tcpbase %s trial %d: %.2f MiB/s (%.2fs) %s", dir, i+1, tr.MiBps, tr.Seconds, tr.Error)
			time.Sleep(time.Second)
		}
	}
	adbCmd(*adb, "shell", "rm -f /data/local/tmp/upload.bin")
	run.Notes = append(run.Notes, "curl time_total includes TCP connect + request + transfer for the whole payload; upload uses --data-binary from a file on the phone.")
	finish(run, *g.out)
}

// ---------------------------------------------------------------------------
// loopback ceiling (no app): raw HTTP over loopback, same machine
// ---------------------------------------------------------------------------

func cmdSummarize(args []string) {
	fs := flag.NewFlagSet("summarize", flag.ExitOnError)
	out := fs.String("out", filepath.Join("..", "..", "benchmark_results"), "results directory")
	fs.Parse(args)
	files, _ := filepath.Glob(filepath.Join(*out, "raw", "*.json"))
	sort.Strings(files)
	type row struct {
		Scenario   string  `json:"scenario"`
		Label      string  `json:"measurement_class"`
		Group      string  `json:"group"`
		RunID      string  `json:"run_id"`
		Runs       int     `json:"measured_trials"`
		Warmups    int     `json:"warmup_trials_excluded"`
		Success    int     `json:"successes"`
		SuccLo     float64 `json:"success_rate_wilson95_lo"`
		SuccHi     float64 `json:"success_rate_wilson95_hi"`
		MiBps      Stat    `json:"throughput_MiB_per_s"`
		Seconds    Stat    `json:"elapsed_seconds"`
		FilesPS    Stat    `json:"files_per_s"`
		WSMax      Stat    `json:"server_working_set_max_MiB_per_trial"`
		PrivMax    Stat    `json:"server_private_max_MiB_per_trial"`
		CPUCore    Stat    `json:"server_cpu_pct_of_one_core"`
		IntegrityF int     `json:"integrity_failures"`
	}
	var rows []row
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var r Run
		if json.Unmarshal(b, &r) != nil {
			continue
		}
		groups := map[string][]Trial{}
		var order []string
		for _, t := range r.Trials {
			if _, ok := groups[t.Group]; !ok {
				order = append(order, t.Group)
			}
			groups[t.Group] = append(groups[t.Group], t)
		}
		for _, gk := range order {
			var rw row
			rw.Scenario, rw.Label, rw.Group, rw.RunID = r.Scenario, r.Label, gk, r.RunID
			var mi, se, fp, wm, pm, cp []float64
			for _, t := range groups[gk] {
				if t.Warmup {
					rw.Warmups++
					continue
				}
				rw.Runs++
				if t.Success {
					rw.Success++
				}
				if strings.HasPrefix(t.Integrity, "MISMATCH") || strings.Contains(t.Integrity, " mismatch") && !strings.Contains(t.Integrity, " 0 mismatch") {
					rw.IntegrityF++
				}
				if t.Success && t.MiBps > 0 {
					mi = append(mi, t.MiBps)
				}
				if t.Success && t.Seconds > 0 {
					se = append(se, t.Seconds)
				}
				if t.Success && t.FilesPS > 0 {
					fp = append(fp, t.FilesPS)
				}
				if t.Mem != nil && t.Mem.Samples > 0 {
					wm = append(wm, t.Mem.WSMaxMiB)
					pm = append(pm, t.Mem.PrivMaxMiB)
					cp = append(cp, t.Mem.CPUPctOfCore)
				}
			}
			rw.SuccLo, rw.SuccHi = wilson(rw.Success, rw.Runs)
			rw.MiBps, rw.Seconds, rw.FilesPS = computeStats(mi), computeStats(se), computeStats(fp)
			rw.WSMax, rw.PrivMax, rw.CPUCore = computeStats(wm), computeStats(pm), computeStats(cp)
			rows = append(rows, rw)
		}
	}
	jb, _ := json.MarshalIndent(map[string]any{"generated_utc": time.Now().UTC().Format(time.RFC3339), "source_files": len(files), "rows": rows, "note": "Statistics exclude warm-up trials. Throughput stats use successful trials only; success rate uses all measured trials. Each row is one (scenario, parameter group) within ONE run."}, "", "  ")
	os.WriteFile(filepath.Join(*out, "summary.json"), jb, 0644)
	var sb strings.Builder
	sb.WriteString("scenario,run_id,group,measured_trials,warmups_excluded,successes,success_wilson95_lo,success_wilson95_hi,MiBps_median,MiBps_mean,MiBps_min,MiBps_max,MiBps_stdev,MiBps_cov_pct,MiBps_p95,seconds_median,files_per_s_median,server_WS_max_MiB_max,server_private_max_MiB_max,server_cpu_pct_core_median,integrity_failures\n")
	for _, r := range rows {
		fmt.Fprintf(&sb, "%s,%s,\"%s\",%d,%d,%d,%.3f,%.3f,%.2f,%.2f,%.2f,%.2f,%.2f,%.1f,%.2f,%.3f,%.1f,%.1f,%.1f,%.1f,%d\n",
			r.Scenario, r.RunID, r.Group, r.Runs, r.Warmups, r.Success, r.SuccLo, r.SuccHi, r.MiBps.Median, r.MiBps.Mean, r.MiBps.Min, r.MiBps.Max, r.MiBps.Std, r.MiBps.CoV, r.MiBps.P95, r.Seconds.Median, r.FilesPS.Median, r.WSMax.Max, r.PrivMax.Max, r.CPUCore.Median, r.IntegrityF)
	}
	os.WriteFile(filepath.Join(*out, "summary.csv"), []byte(sb.String()), 0644)
	logf("summarised %d raw files into %d rows", len(files), len(rows))
}

func main() {
	if len(os.Args) < 2 {
		fmt.Println("usage: bench <idle|startup|single|small|concurrent|resume|failure|security|client|wifi|tcpbase|summarize> [flags]")
		os.Exit(2)
	}
	_ = runtime.NumCPU
	cmds := map[string]func([]string){
		"idle": cmdIdle, "startup": cmdStartup, "single": cmdSingle, "small": cmdSmall,
		"concurrent": cmdConcurrent, "resume": cmdResume, "failure": cmdFailure, "security": cmdSecurity,
		"client": cmdClient, "wifi": cmdWifi, "tcpbase": cmdTCPBase, "summarize": cmdSummarize,
	}
	f, ok := cmds[os.Args[1]]
	if !ok {
		fatalf("unknown command %q", os.Args[1])
	}
	f(os.Args[2:])
}
