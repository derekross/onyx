# Onyx Workflow Integration Specification

## Overview

This document specifies the implementation of GitHub and GitLab OAuth integration for Onyx, enabling users to pull issues, PRs/MRs, and todos directly into their vault as markdown files.

**Target Users:** Project managers, marketing teams, DevRel professionals, and developers who want a unified view of their workflow without using CLI tools.

**Design Principle:** One-click setup with zero configuration required.

---

## 1. User Experience Flow

### 1.1 Initial Setup

1. User opens **Settings > Productivity**
2. User sees two OAuth buttons:
   - "Connect with GitHub" (GitHub logo)
   - "Connect with GitLab" (GitLab logo)
3. User clicks a button
4. Browser opens to GitHub/GitLab authorization page
5. User approves the Onyx app
6. Browser redirects to localhost callback
7. Onyx captures the token and shows "Connected" status
8. User can now add repos to track

### 1.2 Adding Repos to Track

1. User clicks "Add Repository"
2. A dropdown/search shows:
   - Recently active repos (from API)
   - Option to paste a repo URL
3. User selects repos to track
4. Repos appear in the tracked list with remove option

### 1.3 Syncing Workflow Data

1. User clicks "Sync Now" or enables auto-sync
2. Onyx fetches data from GitHub/GitLab APIs
3. Markdown files are generated in `{vault}/.onyx/workflows/`
4. Files appear in sidebar (if folder is expanded)
5. Status shows "Last synced: X minutes ago"

---

## 2. OAuth Implementation

### 2.1 OAuth Flow (Local HTTP Server)

```
┌─────────┐     ┌─────────────┐     ┌──────────────┐     ┌─────────┐
│  User   │────>│    Onyx     │────>│   Browser    │────>│ GitHub/ │
│         │     │  (Tauri)    │     │              │     │ GitLab  │
└─────────┘     └─────────────┘     └──────────────┘     └─────────┘
                      │                    │                   │
                      │ 1. Start local     │                   │
                      │    HTTP server     │                   │
                      │    on random port  │                   │
                      │                    │                   │
                      │ 2. Open browser    │                   │
                      │─────────────────────>                  │
                      │                    │ 3. Redirect to    │
                      │                    │    OAuth page     │
                      │                    │──────────────────>│
                      │                    │                   │
                      │                    │ 4. User approves  │
                      │                    │<──────────────────│
                      │                    │                   │
                      │ 5. Callback to     │                   │
                      │    localhost:PORT  │                   │
                      │<───────────────────│                   │
                      │                    │                   │
                      │ 6. Exchange code   │                   │
                      │    for token       │──────────────────>│
                      │                    │                   │
                      │ 7. Store token     │                   │
                      │    in keyring      │                   │
                      │                    │                   │
                      │ 8. Show success    │                   │
                      │    in UI           │                   │
```

### 2.2 GitHub OAuth Configuration

**OAuth App Settings:**
- **App Name:** Onyx Notes
- **Homepage URL:** https://github.com/derekross/onyx
- **Authorization callback URL:** `http://127.0.0.1:{PORT}/oauth/github`
- **Scopes Required:**
  - `repo` - Full control of private repositories (or `public_repo` for public only)
  - `read:user` - Read user profile
  - `notifications` - Access notifications (optional)

**OAuth Endpoints:**
- Authorization: `https://github.com/login/oauth/authorize`
- Token Exchange: `https://github.com/login/oauth/access_token`

**Bundled Credentials (to be created):**
```
GITHUB_CLIENT_ID=<your-client-id>
GITHUB_CLIENT_SECRET=<your-client-secret>
```

### 2.3 GitLab OAuth Configuration

**OAuth App Settings:**
- **Name:** Onyx Notes
- **Redirect URI:** `http://127.0.0.1:{PORT}/oauth/gitlab`
- **Confidential:** Yes
- **Scopes Required:**
  - `read_user` - Read user profile
  - `read_api` - Read API access
  - `read_repository` - Read repository access

**OAuth Endpoints:**
- Authorization: `https://gitlab.com/oauth/authorize`
- Token Exchange: `https://gitlab.com/oauth/token`

**Bundled Credentials (to be created):**
```
GITLAB_CLIENT_ID=<your-application-id>
GITLAB_CLIENT_SECRET=<your-application-secret>
```

### 2.4 Token Storage

Tokens are stored in the OS keyring (same as Nostr keys):
- **Service:** `onyx`
- **Keys:**
  - `github_oauth_token`
  - `gitlab_oauth_token`
  - `github_oauth_refresh_token` (if applicable)
  - `gitlab_oauth_refresh_token`

---

## 3. API Integration

### 3.1 GitHub API Endpoints

**Base URL:** `https://api.github.com`

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /user` | Get authenticated user | User profile |
| `GET /user/repos` | List user's repos | Repo list for picker |
| `GET /repos/{owner}/{repo}/issues` | Get issues (includes PRs) | Issue list |
| `GET /repos/{owner}/{repo}/pulls` | Get pull requests | PR list |
| `GET /issues` | Get issues assigned to user across all repos | Issue list |
| `GET /user/issues` | Issues created by, assigned to, or mentioning user | Issue list |
| `GET /notifications` | Get notifications | Notification list |

**Rate Limits:**
- Authenticated: 5,000 requests/hour
- Should be plenty for typical usage

**Headers:**
```
Authorization: Bearer {token}
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
```

### 3.2 GitLab API Endpoints

**Base URL:** `https://gitlab.com/api/v4`

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /user` | Get authenticated user | User profile |
| `GET /projects?membership=true` | List user's projects | Project list for picker |
| `GET /projects/{id}/issues` | Get project issues | Issue list |
| `GET /projects/{id}/merge_requests` | Get project MRs | MR list |
| `GET /issues?assignee_id={id}` | Get issues assigned to user | Issue list |
| `GET /merge_requests?reviewer_id={id}` | Get MRs for review | MR list |
| `GET /merge_requests?author_id={id}` | Get MRs authored by user | MR list |
| `GET /todos` | Get pending todos | Todo list |

**Rate Limits:**
- Authenticated: 2,000 requests/minute
- Plenty for typical usage

**Headers:**
```
Authorization: Bearer {token}
```

### 3.3 Data Models

```typescript
// Unified workflow item (abstraction over GitHub/GitLab)
interface WorkflowItem {
  id: string;                    // Unique ID: "github:issue:123" or "gitlab:mr:456"
  provider: 'github' | 'gitlab';
  type: 'issue' | 'pr' | 'mr' | 'todo' | 'notification';
  repo: string;                  // "owner/repo" format
  number: number;                // Issue/PR/MR number
  title: string;
  url: string;                   // Web URL
  state: 'open' | 'closed' | 'merged' | 'draft';
  author: string;                // Username
  assignees: string[];           // Usernames
  reviewers?: string[];          // For PRs/MRs
  labels: string[];
  milestone?: string;
  createdAt: string;             // ISO date
  updatedAt: string;             // ISO date
  dueDate?: string;              // ISO date
  
  // PR/MR specific
  isDraft?: boolean;
  mergeable?: boolean;
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required';
  
  // Derived/computed
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  category?: 'review_requested' | 'assigned' | 'authored' | 'mentioned';
}

// Tracked repository
interface TrackedRepo {
  provider: 'github' | 'gitlab';
  fullName: string;              // "owner/repo" or "namespace/project"
  name: string;                  // Display name
  url: string;                   // Web URL
  defaultBranch?: string;
}

// Connection status
interface OAuthConnection {
  provider: 'github' | 'gitlab';
  connected: boolean;
  username?: string;
  avatarUrl?: string;
  connectedAt?: string;
}
```

---

## 4. Rust/Tauri Commands

### 4.1 OAuth Commands

```rust
// Start OAuth flow - returns URL to open in browser
#[tauri::command]
async fn oauth_start(provider: String) -> Result<OAuthStartResponse, String>;

struct OAuthStartResponse {
    auth_url: String,
    state: String,  // For CSRF protection
}

// Handle OAuth callback - called when localhost server receives callback
#[tauri::command]
async fn oauth_callback(
    provider: String,
    code: String,
    state: String
) -> Result<OAuthConnection, String>;

// Check connection status
#[tauri::command]
async fn oauth_status(provider: String) -> Result<Option<OAuthConnection>, String>;

// Disconnect (remove token)
#[tauri::command]
async fn oauth_disconnect(provider: String) -> Result<(), String>;

// Get access token (for API calls from frontend)
#[tauri::command]
async fn oauth_get_token(provider: String) -> Result<Option<String>, String>;
```

### 4.2 Workflow Sync Commands

```rust
// Sync workflow data from connected providers
#[tauri::command]
async fn workflow_sync(
    vault_path: String,
    repos: Vec<TrackedRepo>
) -> Result<WorkflowSyncResult, String>;

struct WorkflowSyncResult {
    items_synced: u32,
    files_written: Vec<String>,
    errors: Vec<String>,
}

// Get user's repos for picker
#[tauri::command]
async fn workflow_list_repos(provider: String) -> Result<Vec<TrackedRepo>, String>;

// Save tracked repos to config
#[tauri::command]
async fn workflow_save_config(config: WorkflowConfig) -> Result<(), String>;

// Load tracked repos from config
#[tauri::command]
async fn workflow_load_config() -> Result<WorkflowConfig, String>;

struct WorkflowConfig {
    tracked_repos: Vec<TrackedRepo>,
    auto_sync: bool,
    sync_frequency_minutes: u32,
    last_synced: Option<String>,
}
```

### 4.3 Local HTTP Server for OAuth Callback

The Rust backend will:
1. Spawn a temporary HTTP server on a random available port (e.g., 49152-65535)
2. Listen for the OAuth callback at `http://127.0.0.1:{port}/oauth/{provider}`
3. Extract the `code` and `state` parameters
4. Exchange the code for an access token
5. Store the token in the keyring
6. Return success HTML page to browser
7. Shut down the server
8. Emit event to frontend with connection status

```rust
// Internal function to handle OAuth callback server
async fn start_oauth_callback_server(
    provider: String,
    expected_state: String
) -> Result<OAuthCallbackResult, String>;
```

---

## 5. Frontend Components

### 5.1 Settings UI Updates

**File:** `src/components/Settings.tsx`

Add to Productivity section:

```tsx
// New state signals
const [githubConnection, setGithubConnection] = createSignal<OAuthConnection | null>(null);
const [gitlabConnection, setGitlabConnection] = createSignal<OAuthConnection | null>(null);
const [trackedRepos, setTrackedRepos] = createSignal<TrackedRepo[]>([]);
const [workflowSyncStatus, setWorkflowSyncStatus] = createSignal<SyncStatus>({
  status: 'idle',
  lastSynced: null,
  message: null
});
const [showRepoPickerFor, setShowRepoPickerFor] = createSignal<'github' | 'gitlab' | null>(null);
```

**UI Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│  PRODUCTIVITY                                                │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Workflow Integrations                                       │
│  ──────────────────────                                      │
│  Connect your code repositories to track issues and PRs.     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  [GitHub Logo]  GitHub                               │    │
│  │                                                      │    │
│  │  [  Connect with GitHub  ]                          │    │
│  │                  - or -                              │    │
│  │  ✓ Connected as @derekross         [Disconnect]     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  [GitLab Logo]  GitLab                               │    │
│  │                                                      │    │
│  │  ✓ Connected as @derekross         [Disconnect]     │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Tracked Repositories                                        │
│  ────────────────────                                        │
│  Issues and PRs from these repos will sync to your vault.   │
│                                                              │
│  [+] Add Repository                                          │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  [GitLab] soapbox-pub/shakespeare              [×]  │    │
│  │  [GitLab] soapbox-pub/mkstack                  [×]  │    │
│  │  [GitLab] soapbox-pub/nostrhub                 [×]  │    │
│  │  [GitHub] derekross/onyx                       [×]  │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Sync Settings                                               │
│  ─────────────                                               │
│                                                              │
│  Auto-sync                              [Toggle: OFF]        │
│  Automatically sync every 15 minutes                         │
│                                                              │
│  ┌──────────────────────────────────────────────┐           │
│  │  [  Sync Now  ]    Last synced: 5 minutes ago │           │
│  └──────────────────────────────────────────────┘           │
│                                                              │
│  Output: .onyx/workflows/daily-tasks.md                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 5.2 Repository Picker Modal

When user clicks "Add Repository":

```
┌─────────────────────────────────────────────────────────────┐
│  Add Repository                                        [×]  │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  [Search repos...]                                          │
│                                                              │
│  GitHub                                                      │
│  ─────────                                                   │
│  ○ derekross/onyx                                           │
│  ○ derekross/derek-claude-skills                            │
│                                                              │
│  GitLab                                                      │
│  ─────────                                                   │
│  ○ soapbox-pub/shakespeare                                  │
│  ○ soapbox-pub/mkstack                                      │
│  ○ soapbox-pub/ditto                                        │
│  ○ soapbox-pub/nostrhub                                     │
│  ○ soapbox-pub/pathos                                       │
│  ○ soapbox-pub/soapbox-signer                               │
│                                                              │
│  ─────────────────────────────────────────────────────────  │
│  Or paste a repository URL:                                  │
│  [https://github.com/owner/repo                    ] [Add]  │
│                                                              │
│                                    [Cancel]  [Add Selected]  │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 New TypeScript Files

```
src/lib/workflows/
├── index.ts          # Main exports
├── types.ts          # TypeScript interfaces
├── github.ts         # GitHub API client
├── gitlab.ts         # GitLab API client
├── sync.ts           # Sync orchestration
└── markdown.ts       # Markdown generation
```

---

## 6. Markdown Output Format

### 6.1 File Structure

```
{vault}/
└── .onyx/
    └── workflows/
        ├── daily-tasks.md       # Unified daily view (main file)
        ├── github-issues.md     # GitHub issues detail
        ├── github-prs.md        # GitHub PRs detail
        ├── gitlab-issues.md     # GitLab issues detail
        ├── gitlab-mrs.md        # GitLab MRs detail
        └── gitlab-todos.md      # GitLab todos
```

### 6.2 Daily Tasks Format

```markdown
# Daily Workflow Tasks

**Generated:** Tuesday, January 20, 2026 at 9:15 AM
**Accounts:** GitHub (@derekross), GitLab (@derekross)

---

## Needs Your Review (3)

These PRs/MRs are waiting for your review:

- [ ] [!142 Add NIP-46 support](https://gitlab.com/soapbox-pub/shakespeare/-/merge_requests/142) `shakespeare` `2h ago`
- [ ] [!89 Fix relay connection](https://gitlab.com/soapbox-pub/mkstack/-/merge_requests/89) `mkstack` `1d ago`
- [ ] [#45 Update README](https://github.com/derekross/onyx/pull/45) `onyx` `3h ago`

## Your Open PRs/MRs (2)

PRs/MRs you authored that are still open:

- [ ] [!138 Update documentation](https://gitlab.com/soapbox-pub/mkstack/-/merge_requests/138) `mkstack` `waiting for review`
- [ ] [#42 Add workflow sync](https://github.com/derekross/onyx/pull/42) `onyx` `draft`

## Assigned Issues (5)

Issues assigned to you:

- [ ] [#156 Implement OAuth flow](https://gitlab.com/soapbox-pub/shakespeare/-/issues/156) `shakespeare` `due: Jan 25`
- [ ] [#89 Add dark mode toggle](https://gitlab.com/soapbox-pub/nostrhub/-/issues/89) `nostrhub` `high priority`
- [ ] [#42 Fix sync bug](https://github.com/derekross/onyx/issues/42) `onyx` `no due date`
- [ ] [#15 Update dependencies](https://gitlab.com/soapbox-pub/pathos/-/issues/15) `pathos`
- [ ] [#8 Add tests](https://gitlab.com/soapbox-pub/soapbox-signer/-/issues/8) `soapbox-signer`

## GitLab Todos (2)

Notifications and mentions from GitLab:

- [ ] [Mentioned in !140](https://gitlab.com/soapbox-pub/nostrhub/-/merge_requests/140) `nostrhub` - "Can you take a look at this?"
- [ ] [Assigned #50](https://gitlab.com/soapbox-pub/pathos/-/issues/50) `pathos`

---

**Summary:** 3 reviews pending | 2 open PRs | 5 assigned issues | 2 todos

_Last synced: 9:15 AM_
```

### 6.3 Individual File Formats

**github-issues.md:**
```markdown
# GitHub Issues

_Last updated: January 20, 2026 at 9:15 AM_

## derekross/onyx

### Open Issues (3)

| # | Title | Labels | Assignees | Created | Updated |
|---|-------|--------|-----------|---------|---------|
| [#42](url) | Fix sync bug | `bug` | @derekross | Jan 15 | Jan 19 |
| [#38](url) | Add search | `enhancement` | @derekross | Jan 10 | Jan 18 |
| [#35](url) | Update docs | `documentation` | - | Jan 8 | Jan 8 |

### Recently Closed (5)
...
```

---

## 7. Configuration Storage

### 7.1 localStorage Keys

```javascript
// OAuth connection metadata (non-sensitive)
localStorage.getItem('workflow_github_connected')  // "true" | "false"
localStorage.getItem('workflow_github_username')   // "derekross"
localStorage.getItem('workflow_gitlab_connected')
localStorage.getItem('workflow_gitlab_username')

// Tracked repos
localStorage.getItem('workflow_tracked_repos')     // JSON array

// Sync settings
localStorage.getItem('workflow_auto_sync')         // "true" | "false"
localStorage.getItem('workflow_sync_frequency')    // "15" (minutes)
localStorage.getItem('workflow_last_synced')       // ISO date string
```

### 7.2 Keyring Storage (Sensitive)

```
Service: onyx
Keys:
  - github_oauth_token
  - gitlab_oauth_token
```

---

## 8. Error Handling

### 8.1 OAuth Errors

| Error | User Message | Recovery |
|-------|--------------|----------|
| User denies access | "Authorization was denied. Please try again." | Show Connect button |
| Token exchange fails | "Failed to complete connection. Please try again." | Show Connect button |
| Token expired | "Your GitHub/GitLab session expired. Please reconnect." | Show Connect button |
| Network error | "Network error. Please check your connection." | Retry button |

### 8.2 Sync Errors

| Error | User Message | Recovery |
|-------|--------------|----------|
| Rate limited | "API rate limit reached. Please wait X minutes." | Auto-retry after cooldown |
| Auth error (401) | "Authentication failed. Please reconnect." | Show Connect button |
| Repo not found | "Repository 'x/y' not found or no access." | Remove from tracked list |
| Network error | "Sync failed: network error. Retrying..." | Auto-retry with backoff |

---

## 9. Security Considerations

1. **Token Storage:** OAuth tokens stored in OS keyring (encrypted at rest)
2. **Token Scope:** Request minimum necessary scopes
3. **HTTPS Only:** All API calls over HTTPS
4. **State Parameter:** Use cryptographically random state for CSRF protection
5. **No Token Logging:** Never log tokens to console or files
6. **Secure Callback:** Only accept callbacks on localhost

---

## 10. Implementation Phases

### Phase 1: OAuth Foundation (Week 1)
- [ ] Create GitHub OAuth app
- [ ] Create GitLab OAuth app
- [ ] Implement Rust OAuth commands
- [ ] Implement local HTTP callback server
- [ ] Add keyring token storage
- [ ] Basic Settings UI for connect/disconnect

### Phase 2: API Integration (Week 2)
- [ ] GitHub API client (TypeScript)
- [ ] GitLab API client (TypeScript)
- [ ] Repository picker modal
- [ ] Tracked repos configuration

### Phase 3: Sync Engine (Week 3)
- [ ] Sync orchestration logic
- [ ] Markdown file generation
- [ ] Auto-sync with timer
- [ ] Error handling and retry logic

### Phase 4: Polish & Skill Update (Week 4)
- [ ] UI polish and loading states
- [ ] Update executive-assistant skill
- [ ] Testing across platforms
- [ ] Documentation

---

## 11. Future Enhancements

1. **Notifications:** Show badge count for pending reviews
2. **Quick Actions:** Mark issues done, approve PRs from Onyx
3. **Filtering:** Filter by label, milestone, assignee
4. **Custom Views:** User-defined groupings and filters
5. **Webhooks:** Real-time updates instead of polling
6. **More Providers:** Bitbucket, Gitea, etc.

---

## Appendix A: OAuth App Creation

### GitHub OAuth App

1. Go to https://github.com/settings/developers
2. Click "New OAuth App"
3. Fill in:
   - Application name: `Onyx Notes`
   - Homepage URL: `https://github.com/derekross/onyx`
   - Authorization callback URL: `http://127.0.0.1:0/oauth/github`
4. Click "Register application"
5. Copy Client ID
6. Generate and copy Client Secret

### GitLab OAuth App

1. Go to https://gitlab.com/-/profile/applications
2. Fill in:
   - Name: `Onyx Notes`
   - Redirect URI: `http://127.0.0.1:0/oauth/gitlab`
   - Confidential: Yes
   - Scopes: `read_user`, `read_api`, `read_repository`
3. Click "Save application"
4. Copy Application ID and Secret

---

## Appendix B: API Response Examples

### GitHub Issue Response

```json
{
  "id": 123456,
  "number": 42,
  "title": "Fix sync bug",
  "state": "open",
  "html_url": "https://github.com/owner/repo/issues/42",
  "user": {
    "login": "username",
    "avatar_url": "https://..."
  },
  "labels": [
    {"name": "bug", "color": "d73a4a"}
  ],
  "assignees": [
    {"login": "derekross"}
  ],
  "milestone": {
    "title": "v1.0"
  },
  "created_at": "2026-01-15T10:00:00Z",
  "updated_at": "2026-01-19T15:30:00Z"
}
```

### GitLab MR Response

```json
{
  "id": 789,
  "iid": 142,
  "title": "Add NIP-46 support",
  "state": "opened",
  "web_url": "https://gitlab.com/soapbox-pub/shakespeare/-/merge_requests/142",
  "author": {
    "username": "derekross",
    "avatar_url": "https://..."
  },
  "labels": ["enhancement"],
  "assignees": [],
  "reviewers": [
    {"username": "reviewer1"}
  ],
  "draft": false,
  "merge_status": "can_be_merged",
  "created_at": "2026-01-18T14:00:00Z",
  "updated_at": "2026-01-20T07:15:00Z"
}
```
