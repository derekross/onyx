# NIP-XX: Encrypted File Sync

`draft` `optional`

This NIP defines a protocol for syncing encrypted files (such as notes, documents, and their attachments) across devices using Nostr relays. It enables local-first applications to provide end-to-end encrypted, decentralized sync without requiring centralized servers.

## Motivation

Users increasingly want to own their data while still having it accessible across devices. Existing solutions either require trusting a central server or lack encryption. This NIP provides:

- **End-to-end encryption**: Relays store encrypted blobs they cannot read
- **Local-first**: Works offline, syncs when connected
- **Decentralized**: No single point of failure, user chooses relays
- **Interoperable**: Any client implementing this NIP can sync the same data

## Overview

The protocol uses two event kinds:

| Kind | Description |
|------|-------------|
| `30800` | Encrypted file content |
| `30801` | Encrypted vault/collection index |

All sensitive data (file contents, paths, names, structure) is encrypted using NIP-44 encryption to the user's own public key (self-encryption).

## Event Kinds

### Kind 30800: Encrypted File

A parameterized replaceable event containing an encrypted file.

```json
{
  "kind": 30800,
  "pubkey": "<user-pubkey>",
  "created_at": <unix-timestamp>,
  "tags": [
    ["d", "<random-uuid>"],
    ["encrypted", "nip44"]
  ],
  "content": "<NIP-44 encrypted payload>",
  "sig": "<signature>"
}
```

#### Tags

- `d` (REQUIRED): A random UUID (v4) that uniquely identifies this file. Using a random identifier prevents correlation attacks that could reveal file paths or structure.
- `encrypted` (REQUIRED): The encryption scheme used. Currently only `nip44` is defined.

#### Encrypted Content Structure

After decrypting the `content` field using NIP-44, the plaintext is a JSON object:

```json
{
  "path": "<relative-file-path>",
  "content": "<file-content>",
  "checksum": "<sha256-hex>",
  "version": <integer>,
  "modified": <unix-timestamp>,
  "previousEventId": "<event-id-or-null>",
  "contentType": "<mime-type>",
  "metadata": {
    <application-specific-metadata>
  },
  "attachments": [
    {
      "name": "<filename>",
      "blossom": "<sha256-hash>",
      "key": "<encryption-key-hex>",
      "size": <bytes>,
      "contentType": "<mime-type>"
    }
  ]
}
```

##### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | Yes | Relative path within the vault (e.g., `/folder/note.md`) |
| `content` | string | Yes | The file content (typically UTF-8 text) |
| `checksum` | string | Yes | SHA-256 hash of `content` (hex-encoded) for conflict detection |
| `version` | integer | Yes | Monotonically increasing version number, starting at 1 |
| `modified` | integer | Yes | Unix timestamp of last modification |
| `previousEventId` | string | No | Event ID of the previous version (for version history) |
| `contentType` | string | No | MIME type (default: `text/markdown`) |
| `metadata` | object | No | Application-specific metadata (e.g., YAML frontmatter) |
| `attachments` | array | No | Referenced binary attachments stored on Blossom servers |

##### Attachments

Binary files (images, PDFs, etc.) are stored separately on Blossom-compatible servers. Each attachment entry contains:

- `name`: Original filename
- `blossom`: SHA-256 hash of the **encrypted** blob (used as Blossom identifier)
- `key`: Symmetric encryption key (hex) used to encrypt the blob
- `size`: Size in bytes of the original (unencrypted) file
- `contentType`: MIME type of the original file

Clients MUST encrypt attachments client-side before uploading to Blossom servers.

### Kind 30801: Encrypted Vault Index

A parameterized replaceable event containing the index of a vault (collection of files).

```json
{
  "kind": 30801,
  "pubkey": "<user-pubkey>",
  "created_at": <unix-timestamp>,
  "tags": [
    ["d", "<random-uuid>"],
    ["encrypted", "nip44"]
  ],
  "content": "<NIP-44 encrypted payload>",
  "sig": "<signature>"
}
```

#### Tags

- `d` (REQUIRED): A random UUID (v4) that uniquely identifies this vault.
- `encrypted` (REQUIRED): The encryption scheme used.

#### Encrypted Content Structure

```json
{
  "name": "<vault-name>",
  "description": "<optional-description>",
  "created": <unix-timestamp>,
  "files": [
    {
      "eventId": "<kind-30800-event-id>",
      "d": "<d-tag-of-file-event>",
      "path": "<relative-path>",
      "checksum": "<sha256-hex>",
      "version": <integer>,
      "modified": <unix-timestamp>
    }
  ],
  "deleted": [
    {
      "path": "<relative-path>",
      "deletedAt": <unix-timestamp>,
      "lastEventId": "<event-id>"
    }
  ],
  "settings": {
    <vault-specific-settings>
  }
}
```

##### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Human-readable vault name |
| `description` | string | No | Optional vault description |
| `created` | integer | Yes | Unix timestamp of vault creation |
| `files` | array | Yes | Array of file entries in this vault |
| `deleted` | array | No | Array of deleted file entries (tombstones) |
| `settings` | object | No | Vault-specific settings |

##### File Entry Fields

| Field | Type | Description |
|-------|------|-------------|
| `eventId` | string | Event ID of the kind 30800 event |
| `d` | string | The `d` tag value of the file event |
| `path` | string | Relative path for quick lookup |
| `checksum` | string | SHA-256 of content for conflict detection |
| `version` | integer | Current version number |
| `modified` | integer | Last modification timestamp |

##### Deleted Entry Fields

| Field | Type | Description |
|-------|------|-------------|
| `path` | string | Path of the deleted file |
| `deletedAt` | integer | Unix timestamp of deletion |
| `lastEventId` | string | Event ID of the last version before deletion |

## Encryption

### Self-Encryption

All content is encrypted using NIP-44 to the user's own public key:

```
conversation_key = nip44_get_conversation_key(private_key, public_key)
encrypted = nip44_encrypt(plaintext, conversation_key)
decrypted = nip44_decrypt(encrypted, conversation_key)
```

This ensures:
- Only the key holder can decrypt the content
- Relays cannot read file contents, names, or structure
- No need to manage recipient keys

### What Remains Visible

Even with encryption, the following metadata is visible to relays:

- User's public key (author)
- Event timestamps
- Event kinds (30800, 30801)
- Number of events
- Event sizes

This is unavoidable given Nostr's architecture but reveals minimal information about the actual content.

## Sync Protocol

### Initial Sync (New Device)

1. **Fetch vault indices**: Query all kind 30801 events for the user's pubkey
2. **Decrypt indices**: Decrypt each vault index to discover available vaults
3. **User selection**: Present vaults to user, let them choose which to sync
4. **Fetch files**: For selected vault(s), fetch kind 30800 events by event ID
5. **Decrypt and write**: Decrypt each file and write to local storage

```
REQ: {"kinds": [30801], "authors": ["<pubkey>"]}
→ Receive vault index events
→ Decrypt each, present to user

REQ: {"ids": ["<event-id-1>", "<event-id-2>", ...]}
→ Receive file events
→ Decrypt each, write to disk
```

### Ongoing Sync

1. **Subscribe**: Open subscription for kinds 30800, 30801 from user's pubkey
2. **Process updates**: On new events, decrypt and apply changes
3. **Publish changes**: On local edits, encrypt and publish

```
REQ: {"kinds": [30800, 30801], "authors": ["<pubkey>"], "since": <last-sync>}
```

### Publishing Changes

When a file is created or modified:

1. Encrypt the file content using NIP-44
2. Publish kind 30800 event (new `d` tag for new files, same `d` tag for updates)
3. Update the vault index (kind 30801) with new file entry
4. Publish updated vault index

When a file is deleted:

1. Add entry to `deleted` array in vault index
2. Remove from `files` array
3. Publish updated vault index
4. Optionally publish empty kind 30800 to "delete" the event (relay-dependent)

### Conflict Resolution

Conflicts occur when both local and remote have changes to the same file.

**Detection:**
```
local.checksum ≠ remote.checksum AND
local.version ≠ remote.version - 1
```

**Resolution strategies:**

1. **Last-write-wins**: Use event with latest `created_at`
2. **Manual merge**: Present conflict UI to user
3. **Keep both**: Rename conflicting file (e.g., `note (conflict).md`)

Clients SHOULD implement at least one strategy and MAY let users configure their preference.

### Version History

The `previousEventId` field enables version history:

```
v3 (current) → v2 → v1 → null
     │           │      │
  event-c    event-b  event-a
```

Clients MAY implement version history viewing and restoration by following this chain.

## Relay Considerations

### Recommended Relay Features

- Support for parameterized replaceable events (NIP-33)
- Reasonable event size limits (files can be large)
- Event retention (don't delete old events too aggressively)

### Multi-Relay Strategy

Clients SHOULD publish to multiple relays for redundancy:

1. Publish to all configured relays
2. Consider an event "confirmed" when received by at least 2 relays
3. On fetch, query multiple relays and deduplicate by event ID

## Blossom Integration

Binary attachments use [Blossom](https://github.com/hzrd149/blossom) servers:

### Upload Flow

1. Generate random symmetric key
2. Encrypt file with symmetric key (e.g., AES-256-GCM)
3. Compute SHA-256 of encrypted blob
4. Upload to Blossom server(s)
5. Store hash and key in file's `attachments` array

### Download Flow

1. Read `blossom` hash and `key` from attachment entry
2. Fetch encrypted blob from Blossom server
3. Decrypt using stored key
4. Verify decrypted content

### Blossom Authentication

Use NIP-98 HTTP Auth for authenticated uploads:

```
Authorization: Nostr <base64-encoded-kind-27235-event>
```

## Privacy Considerations

### Metadata Leakage

This NIP minimizes metadata leakage by:

- Using random `d` tags (no path correlation)
- Encrypting vault names and file paths
- Encrypting file structure and relationships
- Not using cleartext tags for filtering

### Remaining Risks

- **Timing analysis**: Event timestamps may reveal activity patterns
- **Size analysis**: File sizes might be fingerprinted
- **Relay logging**: Relays see IP addresses and request patterns

Users requiring stronger privacy should consider:

- Using Tor for relay connections
- Padding files to uniform sizes
- Adding random delays to sync operations

## Implementation Notes

### Recommended Libraries

- **nostr-tools**: Event creation, signing, NIP-44 encryption
- **@noble/hashes**: SHA-256, cryptographic primitives
- **@noble/ciphers**: AES-GCM for attachment encryption

### Event ID Stability

When updating a file, reuse the same `d` tag to ensure the event is replaceable. Generate a new `d` tag only for new files.

### Checksum Calculation

```javascript
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

function calculateChecksum(content: string): string {
  const bytes = new TextEncoder().encode(content);
  return bytesToHex(sha256(bytes));
}
```

### Example: Creating a File Event

```javascript
import { finalizeEvent, nip44 } from 'nostr-tools';
import { v4 as uuidv4 } from 'uuid';

async function createFileEvent(
  privateKey: Uint8Array,
  publicKey: string,
  path: string,
  content: string,
  version: number,
  previousEventId?: string
) {
  const conversationKey = nip44.v2.utils.getConversationKey(privateKey, publicKey);

  const payload = JSON.stringify({
    path,
    content,
    checksum: calculateChecksum(content),
    version,
    modified: Math.floor(Date.now() / 1000),
    previousEventId: previousEventId || null,
    contentType: 'text/markdown'
  });

  const encrypted = nip44.v2.encrypt(payload, conversationKey);

  const event = finalizeEvent({
    kind: 30800,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', uuidv4()],
      ['encrypted', 'nip44']
    ],
    content: encrypted
  }, privateKey);

  return event;
}
```

## Test Vectors

### File Event

Private key (hex): `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`

Input:
```json
{
  "path": "/notes/hello.md",
  "content": "# Hello World\n\nThis is a test note.",
  "version": 1
}
```

Expected checksum: `a3c25e6e5d1a8b3f...` (SHA-256 of content)

### Vault Index Event

Input:
```json
{
  "name": "My Notes",
  "files": [
    {
      "eventId": "abc123...",
      "d": "550e8400-e29b-41d4-a716-446655440000",
      "path": "/notes/hello.md",
      "checksum": "a3c25e6e5d1a8b3f...",
      "version": 1,
      "modified": 1705234567
    }
  ]
}
```

## References

- [NIP-01: Basic Protocol](https://github.com/nostr-protocol/nips/blob/master/01.md)
- [NIP-33: Parameterized Replaceable Events](https://github.com/nostr-protocol/nips/blob/master/33.md)
- [NIP-44: Encrypted Payloads](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [NIP-98: HTTP Auth](https://github.com/nostr-protocol/nips/blob/master/98.md)
- [Blossom: Blobs Stored Simply on Mediaservers](https://github.com/hzrd149/blossom)
