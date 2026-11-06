# Discovery (finding PCs on the Wi-Fi)

How the phone's "Available on Wi-Fi" list is kept live, and how it behaves on busy networks.
This is a fully peer-to-peer system: there is no server, every PC announces itself and every phone listens.

## Channels

Three channels run together because each is blocked on some networks. A PC found through several is
listed once (identity = server id; an address-only sighting such as mDNS is merged into the same entry).

| Channel | Direction | Notes |
|---|---|---|
| UDP announcements, port **8089** | PC -> broadcast (`255.255.255.255`, each subnet broadcast, `224.0.0.167`) | primary, instant |
| mDNS `_p2plink._tcp` | PC advertises, phone browses (Android `NsdManager`) | standard, often filtered by routers |
| HTTP `GET /discover` | phone -> PC (unicast) | saved address, /24 sweep, verification and liveness probe |

## UDP presence protocol

One JSON datagram per message, all carrying `boot` and `seq`:

```
{"type":"announce","boot":1730900000123,"seq":42,"name":"My PC","id":"<server id>","port":8080,"scheme":"http","ips":[...]}
{"type":"bye","boot":1730900000123,"seq":43,"id":"<server id>","name":"My PC","port":8080}
```

* **announce**: immediately at start (three times within about a second), then every **1-2 s** (1.5 s with +/-0.5 s random jitter,
  so PCs that started together do not transmit in lock-step).
* **bye**: sent twice on a clean exit (Ctrl+C, `exit`, tray Exit, SIGTERM). mDNS sends its own goodbye.
  It is a **fast path only**. UDP can drop it, and a crash, a closed lid or a killed process never sends one,
  so the receiver's timeout below is what actually guarantees a vanished PC disappears.
* **boot** is when the PC process started (unix ms); **seq** increases with every datagram within a boot.
  Receivers use them to
  * drop **duplicates** (the same announce arrives once per broadcast address),
  * ignore **reordered** packets (an older `seq` proves nothing about now and does not refresh the PC),
  * refuse an announce that was **sent before a goodbye** but arrived after it (`bye` carries a higher `seq`
    than every announce before it, and is remembered for 30 s),
  * let a **restarted** PC (larger `boot`) supersede its previous run, and ignore a late goodbye from that previous run.
* A phone may also send `P2P_DISCOVER_REQ`; the PC answers that sender with a unicast `DiscoveryInfo`
  (at most one reply per source per second). Phones only do this as a short burst (4 x every 2 s) right
  after discovery starts, to find PCs that announced before they were listening.

## What the phone does

All list rules live in one pure, unit-tested module (`apps/mobile/src/lib/discoveryRegistry.ts`).

* **Appear immediately, confirm later.** The first sighting is shown at once as `appearing` (the card shows
  "Checking..." and Connect is disabled). An HTTP `GET /discover` then confirms it (trying the PC's other addresses
  if the source address is unreachable, for example a virtual adapter) and the card becomes `confirmed`. If the
  probe fails the card is dropped silently and that PC is ignored for 5 s, 10 s, 20 s ... (capped at 60 s) while it keeps failing.
  HTTPS PCs cannot be probed from a page (self-signed certificate) and are trusted as announced; pairing authenticates them.
* **Disappear within about 5 s.** A PC not heard from for 5 s (three missed announces) is removed. The native layer
  forwards liveness as **one batched event every 500 ms** listing the keys heard from, so the bridge cost does not
  grow with the number of PCs. A goodbye removes the PC instantly. PCs that go quiet on UDP/mDNS for 3 s are
  re-checked over HTTP (at most 8 per 1.5 s), which keeps them listed where broadcast is filtered; a single missed probe never removes one.
* **No false removal.** The sweep re-reads each PC right before removing it, so an announce processed at the same
  moment wins. After the app returns from the background nothing is judged stale until it has had 5 s to be heard again.
* **Flapping is cheap.** A PC verified in the last 30 s that disappears and comes back is shown as confirmed
  without a new probe, so many PCs flapping at once do not cause a probe storm.
* **Same PC, new address** (DHCP, Wi-Fi switch): the entry follows it and is re-verified at the new address; the
  answer of a probe started for the old address is ignored.

### Tapping Connect on a PC that just went offline

If connecting fails because the PC cannot be reached, the app does **not** show a raw network/timeout error. It

1. removes that PC from the list immediately (and keeps it out for a growing backoff, so announces that were
   already in flight cannot bring it straight back),
2. shows *"This device just went offline — tap to retry"*, and
3. makes **one** automatic re-check (`/discover`) after a short pause. If the PC answers it is re-added as
   confirmed and the message becomes *"<name> is back online — tap to connect"*.

Failures that are real answers from the PC (pairing refused, not paired) keep their normal messages.
Repeated taps or a flapping PC share a single re-check at a time.

## Lifecycle and cleanup

* **Background / foreground:** the Android plugin releases the UDP socket, its threads, the mDNS listener and the
  multicast lock when the app is paused (`handleOnPause`) and restarts them on resume if the app still wants
  discovery. The JS side also gives the list a fresh grace period when the page becomes visible.
* **Network change** (`online`): sockets are rebound (multicast membership is tied to the interface) and the /24 sweep re-runs (at most once per 15 s).
* **Teardown:** leaving the discovery screen or connecting removes all listeners, timers and the registry; nothing
  is emitted afterwards, even for probes still in flight. `onDestroy` also releases everything.
* **PC shutdown:** `bye` is broadcast and the mDNS record is withdrawn before the socket closes; if the network
  or display name changes while running, the mDNS record is re-registered.

## Scale on a busy network

* Announcements cost N packets per interval for N PCs (about 270 packets/s, roughly 70 KB/s, for 400 PCs on one
  segment). Request/response polling would cost N x phones and is deliberately not used in steady state.
* The native layer drops duplicate copies and unchanged repeats before they reach JavaScript, and React state
  changes only when a PC appears, changes or leaves.
* Hard bounds: at most 200 PCs tracked (unverified ones are evicted first; fresh verified ones are never evicted
  for a newcomer), at most 4 verification probes in flight and 64 queued (the rest are shed and seen again
  at the next announce), at most 512 entries in each memory map (failures, verified, goodbyes).
  The list shows 50 at a time, sorted by name, scrolling inside its card, with a note to scan the QR code for the rest.
* Many enterprise and campus networks isolate clients or rate-limit broadcast/multicast. Discovery then
  shows nothing (or only some PCs); scanning the PC's QR code always works and is the supported fallback.
* Discovery only lists a PC. Connecting still requires pairing (QR secret or approval at the PC), so
  seeing a PC in the list grants no access.
