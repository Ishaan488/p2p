# Multiple devices (one phone, several PCs)

The phone can be paired with several PCs, connected to up to **5 at once**, and can send to any
combination of them. There is still no server: each PC is an independent peer.

## What the user sees

* **One paired PC:** nothing new on screen. The header shows the PC's name (it is now also a button),
  and "Add another device" lives in that button's sheet and in the overflow menu.
* **Header:** `Office PC +1 ▾` when more than one is connected. Tapping it opens the **Devices** sheet.
* **Devices sheet:** every paired PC with its state (connected / reconnecting / offline / needs pairing),
  a **Send to** switch on each connected one, and, behind the row's chevron, "Accept files automatically",
  Disconnect and Remove. PCs seen on the Wi-Fi but not paired appear under **Nearby** with an **Add** button.
* **Sending to:** the chip above the action buttons names the recipients ("Sending to **2 devices** ▾") and
  opens the same sheet. By default every connected PC is a recipient; switching one off is remembered.
* **Transfer list:** when more than one PC is paired, each card carries a small `to X` / `from X` tag, and a
  device filter appears next to All / Received / Sent. Text sent to several PCs is one card naming all of them;
  a file sent to several PCs is one card per PC, because each has its own progress and can fail or resume separately.
* **Nothing connected:** with one paired PC the familiar card; with several, a **Your devices** list where
  each has its own Connect button.
* **Sharing from another app (Android):** with one connected device it is sent straight away. With several,
  a "Send … to…" sheet asks first, because a share must never reach a device by surprise. If nothing is
  connected yet the share waits (a bar says so, with a Discard button) and goes out once a device connects.
  After an app restart the share waits a few seconds for the other devices to finish connecting before deciding.

## How it works

| Piece | Responsibility |
|---|---|
| `lib/peers.ts` | Persistent list of paired PCs, migration from the single-PC versions, who is excluded from sending, unique display names. |
| `lib/peerConnection.ts` | One PC's session, WebSocket and reconnect loop (`idle`, `connecting`, `reconnecting`, `connected`, `offline`, `unpaired`). |
| `lib/reconnect.ts` | Backoff with jitter: 1 s first retry, then 2 s growing to 30 s, so several dropped PCs do not retry in lock-step. |
| `lib/peerManager.ts` | Owns all connections; the 5-connected / 12-paired limits; targets; which PC settings apply to; builds the immutable snapshot the UI renders (`useSyncExternalStore`). |
| `lib/sendPlan.ts` | Per-recipient transfer ids, post-send summaries, share routing, the post-restart settle delay. |
| `lib/sharedUriRefs.ts` | Reference counts for Android `content://` URIs so the first finished upload does not delete a file the others still read. |
| `components/DevicesSheet.tsx`, `PeerRow.tsx` | The switcher UI. |

Every transfer carries the id of the PC it belongs to. Uploads and downloads use that PC's own API session;
a message from PC A can never be answered through PC B.

## Rules that are easy to get wrong

* **Targets = connected AND not switched off.** A PC that is reconnecting is not a target until it is back.
* **Disconnect is the user's choice and sticks:** a manually disconnected PC is not brought back by network
  changes, app resume or a restart, until the user connects it again.
* **A connected PC's address is never rewritten by discovery.** A PC with several network adapters announces
  from each; following them would churn a healthy link. Discovery only repairs the address of a PC that is
  *not* connected (DHCP change, Wi-Fi switch).
* **Pairing again with a PC replaces its record** (new key) instead of listing it twice, keeping its settings.
* **A PC that says it no longer knows this phone** (`not_paired`) stops retrying and shows "Needs pairing again".
* **Removing a PC** tells it (best effort), closes the link, cancels its uploads, interrupts its downloads
  (resumable by pairing again), and drops its queued text. History stays, tagged with the name it had.
* **Limits** (5 connected, 12 paired) produce a plain message, not an error; a PC added over the connection
  limit stays in the list with a Connect button.
* **Clipboard:** a clipboard push on returning to the app goes to the focused PC only, never to all of them.
  Incoming clipboard text from any connected PC is applied as before.
* **Same name, different PCs:** names are made unique with the address ("LAPTOP (192.168.1.10)") in chips and
  tags; the Devices rows show the plain name with the address underneath.

## Data and migration

* New storage: `p2p_peers_v2` (the list), `p2p_send_excluded`, `p2p_focused_peer`.
* The first launch after updating converts the old `p2p_pairing` (+ address, auto-connect and auto-accept
  flags) into one peer and removes the old key. Old history is attributed to that PC when it is the only one.
* Pending uploads remember their PC and share one stored copy of the file; the copy is deleted when the last
  upload that needs it finishes.
* Stored history is capped at the most recent 500 items.

## Testing

* `npm --prefix apps/mobile test` (vitest): connection state machine, manager rules (limits, targets, focus,
  re-pairing, removal, address changes), migration, naming, reconnect pacing, send planning, share routing,
  shared-URI reference counting.
* The flows were also run end to end against real PCs: up to six `p2p.exe` instances and the real web UI in
  a phone-sized browser (pairing, sending to one/many, switching a PC off, files to several PCs, a PC
  restarting and being reconnected automatically, reload restore, the 5-device cap, removal).
  The Android share sheet and native discovery need a device and were not exercised there.
