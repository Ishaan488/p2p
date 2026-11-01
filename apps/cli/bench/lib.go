package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
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

const (
	KiB = 1 << 10
	MiB = 1 << 20
	GiB = 1 << 30
)

// ---------------------------------------------------------------------------
// Protocol client (independent re-implementation of the wire protocol from
// apps/cli/auth.go + apps/mobile/src/lib/crypto.ts).
// ---------------------------------------------------------------------------

func hmacSHA256(key []byte, parts ...[]byte) []byte {
	m := hmac.New(sha256.New, key)
	for _, p := range parts {
		m.Write(p)
	}
	return m.Sum(nil)
}

func hkdf32(secret, salt []byte, info string) []byte {
	prk := hmacSHA256(salt, secret)
	return hmacSHA256(prk, []byte(info), []byte{1})
}

func randHex(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

type HTTPErr struct {
	Status int
	Body   string
}

func (e *HTTPErr) Error() string { return fmt.Sprintf("HTTP %d: %s", e.Status, e.Body) }

type Client struct {
	Base   string
	DevID  string
	DevKey []byte
	SID    string
	Key    []byte
	aead   cipher.AEAD
	HC     *http.Client
}

func newHTTP() *http.Client {
	tr := &http.Transport{
		MaxIdleConns: 256, MaxIdleConnsPerHost: 256,
		DisableCompression: true, IdleConnTimeout: 60 * time.Second,
	}
	return &http.Client{Transport: tr, Timeout: 180 * time.Second}
}

func NewClient(base, devID string, devKey []byte, hc *http.Client) *Client {
	if hc == nil {
		hc = newHTTP()
	}
	return &Client{Base: base, DevID: devID, DevKey: devKey, HC: hc}
}

// Hello opens a session. Returns the handshake duration.
func (c *Client) Hello() (time.Duration, error) {
	t0 := time.Now()
	cn := make([]byte, 16)
	rand.Read(cn)
	body, _ := json.Marshal(map[string]string{"deviceId": c.DevID, "clientNonce": hex.EncodeToString(cn)})
	resp, err := c.HC.Post(c.Base+"/hello", "application/json", bytes.NewReader(body))
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode != 200 {
		return 0, &HTTPErr{resp.StatusCode, strings.TrimSpace(string(data))}
	}
	var r struct {
		SessionID   string `json:"sessionId"`
		ServerNonce string `json:"serverNonce"`
		Proof       string `json:"proof"`
	}
	if err := json.Unmarshal(data, &r); err != nil {
		return 0, err
	}
	sn, _ := hex.DecodeString(r.ServerNonce)
	salt := append(append([]byte{}, cn...), sn...)
	c.Key = hkdf32(c.DevKey, salt, "p2p-link session v1")
	want := hmacSHA256(c.Key, []byte("server"))
	got, _ := hex.DecodeString(r.Proof)
	if !hmac.Equal(want, got) {
		return 0, errors.New("server proof invalid")
	}
	block, _ := aes.NewCipher(hkdf32(c.Key, nil, "p2p-link encryption v1"))
	c.aead, _ = cipher.NewGCM(block)
	c.SID = r.SessionID
	return time.Since(t0), nil
}

func (c *Client) sealInto(dst []byte, plain []byte, aad string) []byte {
	dst = dst[:12]
	rand.Read(dst)
	return c.aead.Seal(dst, dst[:12], plain, []byte(aad))
}

func (c *Client) open(sealed []byte, aad string) ([]byte, error) {
	if len(sealed) < 28 {
		return nil, errors.New("short sealed body")
	}
	return c.aead.Open(nil, sealed[:12], sealed[12:], []byte(aad))
}

// SignedURL builds a request URL carrying sid, a fresh nonce and the HMAC.
func (c *Client) SignedURL(method, path string, params map[string]string, nonce string) string {
	if nonce == "" {
		nonce = randHex(8)
	}
	all := map[string]string{"sid": c.SID, "n": nonce}
	for k, v := range params {
		all[k] = v
	}
	names := make([]string, 0, len(all))
	for k := range all {
		names = append(names, k)
	}
	sort.Strings(names)
	pairs := make([]string, len(names))
	for i, k := range names {
		pairs[i] = k + "=" + all[k]
	}
	mac := hex.EncodeToString(hmacSHA256(c.Key, []byte(method+"\n"+path+"\n"+strings.Join(pairs, "&"))))
	q := url.Values{}
	for k, v := range all {
		q.Set(k, v)
	}
	q.Set("mac", mac)
	return c.Base + path + "?" + q.Encode()
}

func nonceOf(u string) string {
	p, _ := url.Parse(u)
	return p.Query().Get("n")
}

// JSONCall sends a sealed JSON request and opens the sealed JSON reply.
func (c *Client) JSONCall(path string, req, resp any) error {
	u := c.SignedURL("POST", path, nil, "")
	n := nonceOf(u)
	pt, _ := json.Marshal(req)
	body := c.sealInto(make([]byte, 12, len(pt)+28), pt, "req\n"+path+"\n"+n)
	r, err := c.HC.Post(u, "application/octet-stream", bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer r.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if r.StatusCode != 200 {
		return &HTTPErr{r.StatusCode, strings.TrimSpace(string(data))}
	}
	if resp != nil {
		pt, err := c.open(data, "res\n"+path+"\n"+n)
		if err != nil {
			return err
		}
		return json.Unmarshal(pt, resp)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Upload engine
// ---------------------------------------------------------------------------

type uploadInit struct {
	TransferID  string `json:"transferId"`
	Filename    string `json:"filename"`
	TotalSize   int64  `json:"totalSize"`
	ChunkSize   int64  `json:"chunkSize"`
	TotalChunks int    `json:"totalChunks"`
}
type uploadStatus struct {
	TransferID  string   `json:"transferId"`
	ChunkSize   int64    `json:"chunkSize"`
	TotalChunks int      `json:"totalChunks"`
	Received    [][2]int `json:"received"`
}

type UpOpts struct {
	Path         string
	Size         int64
	Name         string
	TID          string
	Chunk        int64
	Workers      int
	MaxNewChunks int  // <0: unlimited. Stop feeding new chunks after this many (abort simulation)
	NoComplete   bool // skip /upload_complete
	Dedup        bool // app-faithful pre-flight: SHA-256 the whole file + /upload_check_hash
	AbortAfter   func(acked int) bool
}

type UpRes struct {
	TotalChunks   int     `json:"total_chunks"`
	AlreadyHad    int     `json:"chunks_already_on_server"`
	SentNow       int     `json:"chunks_sent_now"`
	PlainBytesNow int64   `json:"plain_bytes_sent_now"`
	WireBytesNow  int64   `json:"wire_bytes_sent_now"`
	FinalName     string  `json:"final_name,omitempty"`
	DedupHit      bool    `json:"dedup_hit,omitempty"`
	DedupMs       float64 `json:"dedup_preflight_ms,omitempty"`
	InitMs        float64 `json:"init_ms"`
	ChunksMs      float64 `json:"chunks_ms"`
	CompleteMs    float64 `json:"complete_ms"`
	TotalMs       float64 `json:"total_ms"`
	Err           string  `json:"error,omitempty"`
	AckedChunks   []int   `json:"acked_chunks,omitempty"`
	AlreadyHadChunks []int `json:"already_had_chunks,omitempty"`
}

func hashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, MiB)
	if _, err := io.CopyBuffer(h, f, buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (c *Client) UploadFile(o UpOpts) UpRes {
	var res UpRes
	t0 := time.Now()
	fail := func(err error) UpRes {
		res.Err = err.Error()
		res.TotalMs = ms(time.Since(t0))
		return res
	}
	if o.Chunk == 0 {
		o.Chunk = MiB
	}
	if o.Workers < 1 {
		o.Workers = 1
	}
	if o.MaxNewChunks == 0 {
		o.MaxNewChunks = -1
	}
	if o.Dedup {
		td := time.Now()
		h, err := hashFile(o.Path)
		if err != nil {
			return fail(err)
		}
		var chk struct {
			Exists   bool   `json:"exists"`
			Filename string `json:"filename"`
		}
		if err := c.JSONCall("/upload_check_hash", map[string]any{"hash": h, "filename": o.Name, "totalSize": o.Size}, &chk); err != nil {
			return fail(err)
		}
		res.DedupMs = ms(time.Since(td))
		if chk.Exists {
			res.DedupHit = true
			res.FinalName = chk.Filename
			res.TotalMs = ms(time.Since(t0))
			return res
		}
	}
	var total int
	if o.Size > 0 {
		total = int((o.Size + o.Chunk - 1) / o.Chunk)
	}
	res.TotalChunks = total

	ti := time.Now()
	var st uploadStatus
	if err := c.JSONCall("/upload_init", uploadInit{o.TID, o.Name, o.Size, o.Chunk, total}, &st); err != nil {
		return fail(err)
	}
	res.InitMs = ms(time.Since(ti))
	have := make([]bool, total)
	for _, r := range st.Received {
		for i := r[0]; i <= r[1] && i < total; i++ {
			have[i] = true
			res.AlreadyHad++
			res.AlreadyHadChunks = append(res.AlreadyHadChunks, i)
		}
	}
	var pending []int
	for i := 0; i < total; i++ {
		if !have[i] {
			pending = append(pending, i)
		}
	}
	if o.MaxNewChunks >= 0 && len(pending) > o.MaxNewChunks {
		pending = pending[:o.MaxNewChunks]
	}

	var f *os.File
	if total > 0 {
		var err error
		if f, err = os.Open(o.Path); err != nil {
			return fail(err)
		}
		defer f.Close()
	}
	tc := time.Now()
	jobs := make(chan int, len(pending))
	for _, i := range pending {
		jobs <- i
	}
	close(jobs)
	var mu sync.Mutex
	var firstErr error
	var wg sync.WaitGroup
	for w := 0; w < o.Workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			plain := make([]byte, o.Chunk)
			sealed := make([]byte, 12, o.Chunk+28)
			for idx := range jobs {
				mu.Lock()
				bad := firstErr != nil
				mu.Unlock()
				if bad {
					return
				}
				off := int64(idx) * o.Chunk
				n := o.Chunk
				if o.Size-off < n {
					n = o.Size - off
				}
				if _, err := f.ReadAt(plain[:n], off); err != nil && err != io.EOF {
					mu.Lock()
					firstErr = err
					mu.Unlock()
					return
				}
				body := c.sealInto(sealed, plain[:n], fmt.Sprintf("chunk\n%s\n%d", o.TID, idx))
				u := c.SignedURL("POST", "/upload", map[string]string{"transferId": o.TID, "chunkIndex": strconv.Itoa(idx)}, "")
				r, err := c.HC.Post(u, "application/octet-stream", bytes.NewReader(body))
				if err == nil {
					io.Copy(io.Discard, r.Body)
					r.Body.Close()
					if r.StatusCode != 200 {
						err = &HTTPErr{r.StatusCode, "chunk " + strconv.Itoa(idx)}
					}
				}
				mu.Lock()
				if err != nil && firstErr == nil {
					firstErr = err
				}
				if err == nil {
					res.SentNow++
					res.AckedChunks = append(res.AckedChunks, idx)
					res.PlainBytesNow += n
					res.WireBytesNow += int64(len(body))
					if o.AbortAfter != nil && o.AbortAfter(res.SentNow) && firstErr == nil {
						firstErr = errors.New("aborted by harness")
					}
				}
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	res.ChunksMs = ms(time.Since(tc))
	if firstErr != nil {
		return fail(firstErr)
	}
	if o.NoComplete {
		res.TotalMs = ms(time.Since(t0))
		return res
	}
	tcp := time.Now()
	var done struct {
		Filename string `json:"filename"`
	}
	if err := c.JSONCall("/upload_complete", map[string]string{"transferId": o.TID}, &done); err != nil {
		return fail(err)
	}
	res.CompleteMs = ms(time.Since(tcp))
	res.FinalName = done.Filename
	res.TotalMs = ms(time.Since(t0))
	return res
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000.0 }

// ---------------------------------------------------------------------------
// Deterministic source data
// ---------------------------------------------------------------------------

type ctrRNG struct{ s cipher.Stream }

// chachaFor returns a deterministic, fast pseudo-random byte stream (AES-CTR keystream; not for security).
func chachaFor(seed uint64) *ctrRNG {
	key := make([]byte, 32)
	for i := 0; i < 8; i++ {
		key[i] = byte(seed >> (8 * i))
	}
	copy(key[8:], "p2p-bench-seed-v1")
	block, _ := aes.NewCipher(key)
	return &ctrRNG{cipher.NewCTR(block, make([]byte, 16))}
}

func (r *ctrRNG) Read(p []byte) {
	for i := range p {
		p[i] = 0
	}
	r.s.XORKeyStream(p, p)
}

// writeRandomFile writes `size` pseudo-random bytes and returns their SHA-256.
func writeRandomFile(path string, size int64, seed uint64) (string, error) {
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	rng := chachaFor(seed)
	h := sha256.New()
	buf := make([]byte, 4*MiB)
	var left = size
	for left > 0 {
		n := int64(len(buf))
		if left < n {
			n = left
		}
		rng.Read(buf[:n])
		h.Write(buf[:n])
		if _, err := f.Write(buf[:n]); err != nil {
			f.Close()
			return "", err
		}
		left -= n
	}
	if err := f.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func ensureSource(dir string, size int64) (string, string, error) {
	os.MkdirAll(dir, 0755)
	p := filepath.Join(dir, fmt.Sprintf("src_%d.bin", size))
	if st, err := os.Stat(p); err == nil && st.Size() == size {
		if b, err := os.ReadFile(p + ".sha256"); err == nil {
			return p, strings.TrimSpace(string(b)), nil
		}
	}
	h, err := writeRandomFile(p, size, uint64(size))
	if err != nil {
		return "", "", err
	}
	os.WriteFile(p+".sha256", []byte(h), 0644)
	return p, h, nil
}

// ---------------------------------------------------------------------------
// Managed server process (the real shipping binary)
// ---------------------------------------------------------------------------

type DevSeed struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Key     []byte `json:"key"`
	Paired  int64  `json:"pairedAt"`
	Seen    int64  `json:"lastSeen"`
	Trusted bool   `json:"trusted"`
}

func newDevSeed(name string, trusted bool) *DevSeed {
	k := make([]byte, 32)
	rand.Read(k)
	now := time.Now().Unix()
	return &DevSeed{ID: "bench" + randHex(8), Name: name, Key: k, Paired: now, Seen: now, Trusted: trusted}
}

type limitBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (l *limitBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.buf.Len() < l.max {
		l.buf.Write(p)
	}
	return len(p), nil
}
func (l *limitBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buf.String()
}

type Server struct {
	Cmd     *exec.Cmd
	Stdin   io.WriteCloser
	Port    int
	Home    string
	PID     int
	Out     *limitBuf
	ReadyIn time.Duration // process start -> /discover answers 200
	WebIn   time.Duration // process start -> GET / answers 200
	exited  chan struct{}
}

func (s *Server) Base() string { return fmt.Sprintf("http://127.0.0.1:%d", s.Port) }

func seedState(home string, devs []*DevSeed) error {
	st := map[string]any{"serverId": randHex(16), "devices": devs}
	b, _ := json.MarshalIndent(st, "", "  ")
	return os.WriteFile(filepath.Join(home, "state.json"), b, 0600)
}

func StartServer(sut, home string, port int, devs []*DevSeed, extra ...string) (*Server, error) {
	if err := os.MkdirAll(home, 0755); err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(home, "state.json")); err != nil && devs != nil {
		if err := seedState(home, devs); err != nil {
			return nil, err
		}
	}
	args := append([]string{"-home", home, "-port", strconv.Itoa(port), "-no-tray", "-no-clipboard"}, extra...)
	cmd := exec.Command(sut, args...)
	stdin, _ := cmd.StdinPipe()
	out := &limitBuf{max: 8 << 20}
	cmd.Stdout, cmd.Stderr = out, out
	t0 := time.Now()
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	s := &Server{Cmd: cmd, Stdin: stdin, Port: port, Home: home, PID: cmd.Process.Pid, Out: out, exited: make(chan struct{})}
	go func() { cmd.Wait(); close(s.exited) }()
	scheme := "http"
	for _, a := range extra {
		if a == "-tls" {
			scheme = "https"
		}
	}
	_ = scheme
	hc := &http.Client{Timeout: time.Second}
	ready := false
	for time.Since(t0) < 20*time.Second {
		select {
		case <-s.exited:
			return nil, fmt.Errorf("server exited early: %s", out.String())
		default:
		}
		if r, err := hc.Get(s.Base() + "/discover"); err == nil {
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
			if r.StatusCode == 200 {
				s.ReadyIn = time.Since(t0)
				ready = true
				break
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !ready {
		s.Kill()
		return nil, errors.New("server did not become ready within 20s")
	}
	if r, err := hc.Get(s.Base() + "/"); err == nil {
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		if r.StatusCode == 200 {
			s.WebIn = time.Since(t0)
		}
	}
	return s, nil
}

func (s *Server) Kill() {
	if s.Cmd.Process != nil {
		s.Cmd.Process.Kill()
	}
	<-s.exited
}

func (s *Server) ReceivedPath(name string) string { return filepath.Join(s.Home, "received", name) }

// ---------------------------------------------------------------------------
// Process sampler
// ---------------------------------------------------------------------------

type Sample struct {
	T    time.Time
	WS   uint64
	Priv uint64
	CPU  float64
}

type Sampler struct {
	take    func()
	h       procHandle
	mu      sync.Mutex
	samples []Sample
	stop    chan struct{}
	done    chan struct{}
}

func StartSampler(pid int, every time.Duration) (*Sampler, error) {
	h, err := openProc(pid)
	if err != nil {
		return nil, err
	}
	s := &Sampler{h: h, stop: make(chan struct{}), done: make(chan struct{})}
	take := func() {
		ws, _, priv, e1 := h.mem()
		cpu, e2 := h.cpuSeconds()
		if e1 == nil && e2 == nil {
			s.mu.Lock()
			s.samples = append(s.samples, Sample{time.Now(), ws, priv, cpu})
			s.mu.Unlock()
		}
	}
	s.take = take
	take()
	go func() {
		defer close(s.done)
		tk := time.NewTicker(every)
		defer tk.Stop()
		for {
			select {
			case <-s.stop:
				take()
				return
			case <-tk.C:
				take()
			}
		}
	}()
	return s, nil
}

// Poke forces an immediate sample so short windows still contain data.
func (s *Sampler) Poke() { s.take() }

func (s *Sampler) Stop() {
	close(s.stop)
	<-s.done
	s.h.close()
}

// LifetimePeakWS reads the process lifetime peak working set (call before Stop).
func (s *Sampler) LifetimePeakWS() float64 {
	_, p, _, err := s.h.mem()
	if err != nil {
		return 0
	}
	return float64(p) / MiB
}

type MemStats struct {
	Samples      int     `json:"samples"`
	WSAvgMiB     float64 `json:"working_set_avg_MiB"`
	WSMedianMiB  float64 `json:"working_set_median_MiB"`
	WSMaxMiB     float64 `json:"working_set_max_sampled_MiB"`
	PrivAvgMiB   float64 `json:"private_bytes_avg_MiB"`
	PrivMaxMiB   float64 `json:"private_bytes_max_sampled_MiB"`
	CPUSeconds   float64 `json:"cpu_seconds"`
	WallSeconds  float64 `json:"wall_seconds"`
	CPUPctOfHost float64 `json:"cpu_pct_of_all_cores"`
	CPUPctOfCore float64 `json:"cpu_pct_of_one_core"`
}

// Between summarises samples taken in [t0,t1].
func (s *Sampler) Between(t0, t1 time.Time) MemStats {
	s.mu.Lock()
	defer s.mu.Unlock()
	var ws, pv []float64
	var first, last *Sample
	for i := range s.samples {
		sm := &s.samples[i]
		if sm.T.Before(t0) || sm.T.After(t1) {
			continue
		}
		if first == nil {
			first = sm
		}
		last = sm
		ws = append(ws, float64(sm.WS)/MiB)
		pv = append(pv, float64(sm.Priv)/MiB)
	}
	var m MemStats
	m.Samples = len(ws)
	if m.Samples == 0 {
		return m
	}
	st := computeStats(ws)
	m.WSAvgMiB, m.WSMedianMiB, m.WSMaxMiB = st.Mean, st.Median, st.Max
	sp := computeStats(pv)
	m.PrivAvgMiB, m.PrivMaxMiB = sp.Mean, sp.Max
	m.CPUSeconds = last.CPU - first.CPU
	m.WallSeconds = last.T.Sub(first.T).Seconds()
	if m.WallSeconds > 0 {
		m.CPUPctOfCore = m.CPUSeconds / m.WallSeconds * 100
		m.CPUPctOfHost = m.CPUPctOfCore / float64(runtime.NumCPU())
	}
	return m
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

type Stat struct {
	N      int     `json:"n"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	Mean   float64 `json:"mean"`
	Median float64 `json:"median"`
	Std    float64 `json:"stdev_sample"`
	CoV    float64 `json:"cov_pct"`
	P95    float64 `json:"p95"`
	CILo   float64 `json:"ci95_mean_lo"`
	CIHi   float64 `json:"ci95_mean_hi"`
}

var tCrit95 = []float64{0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
	2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
	2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042}

func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return math.NaN()
	}
	if len(sorted) == 1 {
		return sorted[0]
	}
	pos := p / 100 * float64(len(sorted)-1)
	lo := int(math.Floor(pos))
	hi := int(math.Ceil(pos))
	return sorted[lo] + (sorted[hi]-sorted[lo])*(pos-float64(lo))
}

func computeStats(xs []float64) Stat {
	var s Stat
	s.N = len(xs)
	if s.N == 0 {
		return s
	}
	c := append([]float64{}, xs...)
	sort.Float64s(c)
	s.Min, s.Max = c[0], c[len(c)-1]
	var sum float64
	for _, v := range c {
		sum += v
	}
	s.Mean = sum / float64(s.N)
	s.Median = percentile(c, 50)
	s.P95 = percentile(c, 95)
	if s.N > 1 {
		var ss float64
		for _, v := range c {
			ss += (v - s.Mean) * (v - s.Mean)
		}
		s.Std = math.Sqrt(ss / float64(s.N-1))
		t := 1.96
		if s.N-1 < len(tCrit95) {
			t = tCrit95[s.N-1]
		}
		h := t * s.Std / math.Sqrt(float64(s.N))
		s.CILo, s.CIHi = s.Mean-h, s.Mean+h
		if s.Mean != 0 {
			s.CoV = s.Std / s.Mean * 100
		}
	}
	return s
}

// wilson returns the 95% Wilson score interval for k successes in n trials.
func wilson(k, n int) (lo, hi float64) {
	if n == 0 {
		return 0, 1
	}
	z := 1.96
	p := float64(k) / float64(n)
	den := 1 + z*z/float64(n)
	c := p + z*z/(2*float64(n))
	d := z * math.Sqrt(p*(1-p)/float64(n)+z*z/(4*float64(n)*float64(n)))
	return (c - d) / den, (c + d) / den
}

// ---------------------------------------------------------------------------
// Run records
// ---------------------------------------------------------------------------

type Env struct {
	Host      string            `json:"host"`
	OS        string            `json:"os"`
	CPU       string            `json:"cpu"`
	LogicalCP int               `json:"logical_cpus"`
	RAMBytes  string            `json:"ram_bytes"`
	Model     string            `json:"model"`
	Disk      string            `json:"disk"`
	GoVersion string            `json:"go_version"`
	SUT       string            `json:"sut_path"`
	SUTSHA256 string            `json:"sut_sha256"`
	SUTMTime  string            `json:"sut_mtime"`
	GitCommit string            `json:"git_commit"`
	GitDirty  string            `json:"git_dirty_files"`
	Network   map[string]string `json:"network,omitempty"`
}

type Trial struct {
	Index     int            `json:"index"`
	Group     string         `json:"group"`
	Warmup    bool           `json:"warmup"`
	Success   bool           `json:"success"`
	Error     string         `json:"error,omitempty"`
	Bytes     int64          `json:"bytes"`
	Files     int            `json:"files"`
	Seconds   float64        `json:"elapsed_seconds"`
	MiBps     float64        `json:"throughput_MiB_per_s"`
	FilesPS   float64        `json:"files_per_s,omitempty"`
	Integrity string         `json:"integrity"` // "sha256-match", "MISMATCH", "not-checked"
	Mem       *MemStats      `json:"server_process,omitempty"`
	Extra     map[string]any `json:"extra,omitempty"`
}

type Run struct {
	RunID     string         `json:"run_id"`
	Timestamp string         `json:"timestamp_utc"`
	Scenario  string         `json:"scenario"`
	Label     string         `json:"label"` // measurement class
	Params    map[string]any `json:"params"`
	Env       *Env           `json:"environment"`
	Trials    []Trial        `json:"trials"`
	Notes     []string       `json:"notes,omitempty"`
}

func psOut(cmd string) string {
	out, err := exec.Command("powershell", "-NoProfile", "-Command", cmd).Output()
	if err != nil {
		return "unavailable: " + err.Error()
	}
	return strings.TrimSpace(string(out))
}

func sha256Hex(path string) string {
	h, err := hashFile(path)
	if err != nil {
		return "unavailable"
	}
	return h
}

func captureEnv(sut string) *Env {
	e := &Env{GoVersion: runtime.Version(), LogicalCP: runtime.NumCPU(), SUT: sut}
	e.Host, _ = os.Hostname()
	e.OS = psOut("(Get-CimInstance Win32_OperatingSystem | % { $_.Caption + ' ' + $_.Version })")
	e.CPU = psOut("(Get-CimInstance Win32_Processor | Select -First 1).Name")
	e.RAMBytes = psOut("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory")
	e.Model = psOut("(Get-CimInstance Win32_ComputerSystem | % { $_.Manufacturer + ' ' + $_.Model })")
	e.Disk = psOut("(Get-PhysicalDisk | Select -First 1 | % { $_.FriendlyName + ' / ' + $_.MediaType })")
	if sut != "" {
		e.SUTSHA256 = sha256Hex(sut)
		if st, err := os.Stat(sut); err == nil {
			e.SUTMTime = st.ModTime().Format(time.RFC3339)
		}
	}
	if o, err := exec.Command("git", "rev-parse", "HEAD").Output(); err == nil {
		e.GitCommit = strings.TrimSpace(string(o))
	}
	if o, err := exec.Command("git", "status", "--porcelain").Output(); err == nil {
		e.GitDirty = strings.ReplaceAll(strings.TrimSpace(string(o)), "\n", "; ")
	}
	e.Network = map[string]string{}
	for _, line := range strings.Split(psOut("netsh wlan show interfaces"), "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok {
			k = strings.TrimSpace(k)
			switch k {
			case "SSID", "Radio type", "Band", "Channel", "Signal", "Receive rate (Mbps)", "Transmit rate (Mbps)", "Authentication":
				e.Network[k] = strings.TrimSpace(v)
			}
		}
	}
	return e
}

func newRun(scenario, label string, params map[string]any, env *Env) *Run {
	return &Run{
		RunID:     time.Now().UTC().Format("20060102T150405Z") + "-" + randHex(3),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Scenario:  scenario, Label: label, Params: params, Env: env,
	}
}

// Save writes raw results; never overwrites an existing file.
func (r *Run) Save(outDir string) (string, error) {
	dir := filepath.Join(outDir, "raw")
	os.MkdirAll(dir, 0755)
	p := filepath.Join(dir, r.Scenario+"_"+r.RunID+".json")
	b, _ := json.MarshalIndent(r, "", "  ")
	f, err := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return "", err
	}
	defer f.Close()
	_, err = f.Write(b)
	return p, err
}
