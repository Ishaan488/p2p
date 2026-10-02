# Application Protocol

## Overview
The application protocol defines the structure of messages exchanged between the Android client and the Windows client. It is versioned and designed to work across different transport layers.

## Base Message Format
All control and text messages are sent as JSON strings over the WebSocket connection.

```json
{
  "version": 1,
  "type": "<message_type>",
  "id": "unique-message-id",
  "timestamp": 1234567890,
  "payload": {}
}
```

## Message Types

### 1. Control Messages
- `hello`: Initial handshake.
- `welcome`: Response to handshake.
- `ping`: Keep-alive request.
- `pong`: Keep-alive response.
- `ack`: Acknowledgment of a message or chunk.
- `error`: Error notification.
- `device_info`: Exchange device capabilities and names.
- `pair_request`: Request to pair devices securely.
- `pair_response`: Response to a pairing request.

### 2. Text Messages
- `text`: A standard text message.
  ```json
  {
    "text": "hello"
  }
  ```

### 3. File Transfer Control
- `file_start`: Initiates a file transfer.
  ```json
  {
    "transferId": "transfer-123",
    "filename": "photo.jpg",
    "mimeType": "image/jpeg",
    "totalSize": 1048576,
    "chunkSize": 65536,
    "totalChunks": 16
  }
  ```
- `file_complete`: Notifies that all chunks have been sent and the checksum matches.
  ```json
  {
    "transferId": "transfer-123",
    "checksum": "sha256-hash-value"
  }
  ```
- `file_cancel`: Cancels an ongoing transfer.
