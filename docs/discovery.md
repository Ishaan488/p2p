# Discovery (finding PCs on the Wi-Fi)

How the phone's "Available on Wi-Fi" list is kept live, and how it behaves on busy networks.

## Channels

Three channels run together because each is blocked on some networks. A PC found through
several is listed once (identity = server id).

| Channel | Direction | Notes |
|---|---|---|
| UDP announcements, port **8089** | PC -> broadcast (`255.255.255.255`, each subnet broadcast, `224.0.0.167`) | primary, instant |
| mDNS `_p2plink._tcp` | PC advertises, phone browses (Android `NsdManager`) | standard, often filtered by routers |
| HTTP `GET /discover` | phone -> PC (unicast) | used for the saved address, the /24 sweep and as a liveness probe |

## UDP presence protocol

One JSON datagram per message:

```
{"type":"announce","name":"My PC","id":"<server id>","port":8080,"scheme":"http","ips":["192.168.1.15"],...}
{"type":"bye","id":"<server id>","name":"My PC","port":8080}
```

* **announce** is sent immediately at start (three times within about a second, in case one is lost),
  then every ~4 s with +/-0.5 s of random jitter so PCs that started together do not transmit in lock-step.
* **bye** is sent twice on a clean exit (Ctrl+C, `exit`, tray Exit). mDNS sends its own goodbye.
* A phone may also send `P2P_DISCOVER_REQ`; the PC answers that sender with a unicast `DiscoveryInfo`
  (at most one reply per source per second). Phones only do this as a short burst (4 x every 2 s) right
  after discovery starts, to find PCs that announced before they were listening.

## What the phone does

The phone keeps a registry of PCs keyed by server id:

* **Appear:** the first sighting from UDP/mDNS is verified once with `GET /discover` (trying the PC's other
  addresses if the source address is unreachable, for example a virtual adapter). HTTPS PCs cannot be probed
  from a page and are trusted as announced; pairing authenticates them.
* **Heartbeats** only refresh a timestamp. React state changes only when a PC appears, changes or leaves,
  so a network with hundreds of PCs does not re-render the UI. The native layer also drops duplicate
  heartbeats before they cross the WebView bridge (at most one per PC every 3 s).
* **Disappear:** instantly on `bye` / mDNS goodbye; otherwise when nothing was heard for 15 s
  (crash, power loss, Wi-Fi drop). PCs that go quiet on UDP are probed over HTTP every 5 s, which keeps
  them listed on networks that filter broadcast and multicast.
* **Network or app lifecycle:** when the app returns to the foreground or the network comes back
  (`visibilitychange`, `online`) the native sockets are rebound, known PCs are re-probed and the /24
  sweep re-runs (at most once per 15 s).
* **DHCP / Wi-Fi switch:** the same server id appearing at a new address replaces the old entry.

On the PC, if the LAN addresses or the display name change while running, the mDNS record is
re-registered automatically.

## Scale

* Announcements cost N packets per interval for N PCs (about 100 packets/s for 400 PCs, roughly 25 KB/s).
  Request/response polling would cost N x phones and is deliberately not used in steady state.
* The phone tracks at most 200 PCs and lists 50 at a time (sorted by name, scrolling inside the card),
  with a note to scan the QR code to reach a specific PC.
* Many enterprise and campus networks isolate clients or rate-limit broadcast/multicast. Discovery then
  shows nothing (or only some PCs); scanning the PC's QR code always works and is the supported fallback.
* Discovery only lists a PC. Connecting still requires pairing (QR secret or approval at the PC), so
  seeing a PC in the list grants no access.
