# Functional Requirements (FR) — P2P

## A. Device Discovery and Connectivity
1. The application shall automatically discover compatible devices connected to the same local network.
2. The application shall support QR-code-based device pairing.
3. The application shall support manual device connection using an IP address and port.
4. The application shall allow users to assign custom names or aliases to connected devices.
5. The application shall maintain a list of previously paired and trusted devices.
6. The application shall automatically reconnect to previously trusted devices when they become available.
7. The application shall detect network changes and initiate device rediscovery.
8. The application shall support connections through Wi-Fi and mobile hotspots.
9. The application shall provide connection diagnostics when devices cannot discover or connect to each other.
10. The application shall allow users to revoke previously trusted devices.

## B. File Transfer
11. The application shall support file transfers between desktop and Android devices.
12. The application shall support sending multiple files simultaneously.
13. The application shall support folder transfers while preserving directory structure.
14. The application shall support large-file transfers without loading entire files into memory.
15. The application shall provide real-time transfer progress, speed, and estimated completion time.
16. The application shall allow users to pause, resume, and cancel transfers.
17. The application shall support automatic retry of failed transfers.
18. The application shall resume interrupted transfers from the last successfully verified chunk rather than restarting from zero.
19. The application shall recover pending transfers after application restarts.
20. The application shall support multiple concurrent transfers.
21. The application shall provide a transfer queue with prioritization.
22. The application shall detect duplicate files using content hashing.
23. The application shall verify file integrity after transfer using cryptographic hashes.
24. The application shall allow users to configure default download locations.
25. The application shall preserve relevant file metadata where supported.
26. The application shall allow users to select files and folders using filters or file-type categories.

## C. Background Transfers and Notifications
27. The Android application shall support background file transfers using appropriate Android background execution mechanisms.
28. The application shall display transfer progress through system notifications.
29. The application shall notify users when transfers complete or fail.
30. The application shall attempt to recover interrupted transfers when the application becomes active again.
31. The application shall allow users to configure automatic acceptance of transfers from trusted devices.

## D. Clipboard and Text Synchronization
32. The application shall support clipboard synchronization between connected devices.
33. The application shall allow users to send text snippets between devices.
34. The application shall allow users to copy received text directly to the clipboard.
35. The application shall support configurable clipboard synchronization.
36. The application shall provide options to prevent synchronization of sensitive clipboard content.

## E. Messaging and Device Interaction
37. The application shall allow users to send messages between connected devices.
38. The application shall maintain messaging history.
39. The application shall support sending links between connected devices.
40. The application shall allow users to access shared links on the receiving device.
41. The application shall support communication with multiple paired devices.

## F. Operating System Integration
42. The Windows application shall provide an Explorer context-menu option to send files directly through P2P.
43. The Android application shall integrate with the Android Share Sheet.
44. The desktop application shall support drag-and-drop file transfers.
45. The desktop application shall provide a system-tray interface.
46. The application shall allow users to send files without manually opening the main application.
47. The application shall support configurable startup behavior.
48. The application shall provide quick-send options for frequently used devices.

## G. Transfer Management and History
49. The application shall maintain a history of completed, failed, and cancelled transfers.
50. The application shall allow users to view transfer details.
51. The application shall allow users to retry failed transfers.
52. The application shall allow users to clear transfer history.
53. The application shall allow users to configure transfer preferences.
54. The application shall support bandwidth limits and transfer concurrency settings.

## H. Security and Privacy Operations
55. The application shall require device authentication before accepting connections.
56. The application shall require user approval for transfers from unknown devices.
57. The application shall support secure device pairing and key exchange.
58. The application shall encrypt communication between paired devices.
59. The application shall allow users to manage trusted devices and revoke access.
60. The application shall operate without requiring mandatory cloud storage or user accounts.