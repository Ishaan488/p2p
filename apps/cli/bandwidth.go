package main

import (
	"sync"
	"sync/atomic"
	"time"
)

var (
	bandwidthLimitBps int64 // atomic: bytes per second (0 = unlimited)
	bucketMu          sync.Mutex
	bucketTokens      float64
	bucketLastRefill  time.Time
)

func setBandwidthLimitBps(bps int64) {
	if bps < 0 {
		bps = 0
	}
	atomic.StoreInt64(&bandwidthLimitBps, bps)
	bucketMu.Lock()
	bucketTokens = float64(bps)
	bucketLastRefill = time.Now()
	bucketMu.Unlock()
}

func getBandwidthLimitBps() int64 {
	return atomic.LoadInt64(&bandwidthLimitBps)
}

// waitForBandwidth blocks until the requested number of bytes is permitted by the rate limiter.
// When bandwidthLimitBps == 0 (Unlimited), it returns immediately with zero lock contention.
func waitForBandwidth(n int64) {
	limit := atomic.LoadInt64(&bandwidthLimitBps)
	if limit <= 0 || n <= 0 {
		return
	}

	// Slice large chunks into 64 KB sub-permits so pacing is smooth
	const maxStep = 64 * 1024
	remaining := n
	for remaining > 0 {
		limit = atomic.LoadInt64(&bandwidthLimitBps)
		if limit <= 0 {
			return
		}
		step := remaining
		if step > maxStep {
			step = maxStep
		}

		bucketMu.Lock()
		now := time.Now()
		if bucketLastRefill.IsZero() {
			bucketLastRefill = now
			bucketTokens = float64(limit)
		} else {
			elapsed := now.Sub(bucketLastRefill).Seconds()
			if elapsed > 0 {
				bucketTokens += elapsed * float64(limit)
				maxBurst := float64(limit) * 1.5
				if bucketTokens > maxBurst {
					bucketTokens = maxBurst
				}
				bucketLastRefill = now
			}
		}

		needed := float64(step)
		if bucketTokens >= needed {
			bucketTokens -= needed
			bucketMu.Unlock()
			remaining -= step
			continue
		}

		deficit := needed - bucketTokens
		bucketTokens = 0
		bucketLastRefill = now
		waitDur := time.Duration((deficit / float64(limit)) * float64(time.Second))
		bucketMu.Unlock()

		if waitDur > 0 {
			if waitDur > 2*time.Second {
				waitDur = 2 * time.Second
			}
			time.Sleep(waitDur)
		}
		remaining -= step
	}
}
