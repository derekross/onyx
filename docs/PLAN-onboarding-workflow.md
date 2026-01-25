# Onboarding Workflow - Implementation Plan

## Overview

Create a welcoming, 8-step onboarding wizard for new Onyx users. The wizard guides users through vault setup, Nostr identity, cloud sync, AI assistant (OpenCode), and productivity skills. Mobile users skip steps 6-7 (OpenCode/Skills). Minimal animations, simple SVG illustrations with Onyx branding.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/components/Onboarding.tsx` | Main wizard component with all 8 steps |
| `src/styles/onboarding.css` | Dedicated onboarding styles |
| `src/assets/onboarding/welcome.svg` | Welcome screen illustration |
| `src/assets/onboarding/vault.svg` | Vault/folder illustration |
| `src/assets/onboarding/features.svg` | Editor/workspace illustration |
| `src/assets/onboarding/nostr.svg` | Identity/connection illustration |
| `src/assets/onboarding/sync.svg` | Cloud/devices illustration |
| `src/assets/onboarding/ai.svg` | AI assistant illustration |
| `src/assets/onboarding/skills.svg` | Tools/productivity illustration |
| `src/assets/onboarding/complete.svg` | Celebration/success illustration |

## Files to Modify

| File | Changes |
|------|---------|
| `src/App.tsx` | Add onboarding state, first-run detection, render `<Onboarding>` |
| `src/components/Settings.tsx` | Add "Show Welcome Tour" button to General tab |

---

## Step-by-Step Details

### Step 1: Welcome
- **Illustration:** Onyx logo with subtle glow/orb effect
- **Headline:** "Welcome to Onyx"
- **Subhead:** "Your private, AI-powered notes — owned by you, forever."
- **Benefits:** 3 bullet points about writing, privacy, AI
- **Action:** "Get Started" → Step 2

### Step 2: Vault Setup (Required)
- **Illustration:** Stylized folder with documents
- **Headline:** "Choose your vault"
- **Subhead:** "A vault is simply a folder where your notes live."
- **Desktop:** Two buttons - "Create New Vault" / "Choose Folder"
- **Mobile:** Single button - "Create My Vault" (auto-creates in app folder)
- **No skip option** - vault is required

### Step 3: Feature Tour
- **Illustration:** Editor/workspace mockup
- **Headline:** "Your new creative space"
- **Subhead:** "Everything you need to capture ideas and organize your thoughts"
- **Features:** 4 cards (Beautiful Writing, Stay Organized, Make It Yours, Always Private)
- **Action:** "Continue" → Step 4

### Step 4: Nostr Identity
- **Illustration:** Connected nodes with key icon
- **Headline:** "Own your identity"
- **Subhead:** "Connect with Nostr to unlock powerful features"
- **Benefits:** 4 bullet points (publish, backup, share, one identity)
- **Explanation:** Brief non-technical Nostr intro
- **Options:**
  - "Create new identity" → Generates keys, shows npub AND nsec with backup warning
  - "I already have one" → Reveals nsec input field
- **Skip:** Subtle link "Set up later in Settings"

### Step 5: Cloud Sync
- **Illustration:** Cloud with multiple devices
- **Headline:** "Access your notes everywhere"
- **Subhead:** "Sync keeps your notes safe and available on all your devices"
- **Benefits:** 3 bullet points (everywhere, backups, encrypted)
- **Conditional:**
  - If Nostr skipped: Message explaining sync requires identity, "Go Back" option
  - If Nostr set up: Toggle to enable sync
- **Skip:** Subtle link "Set up later in Settings"

### Step 6: AI Assistant (Desktop Only)
- **Illustration:** Friendly AI chat bubble
- **Headline:** "Meet your AI writing partner"
- **Subhead:** "Get help with research, writing, and editing"
- **Benefits:** 4 bullet points (questions, writing help, research, ideas)
- **States:**
  1. Checking: Spinner "Checking for AI assistant..."
  2. Not installed: "Install AI Assistant" button with progress
  3. Error: Error message with "Retry" button, skip warning
  4. Installed: Checkmark "AI Assistant is ready!"
- **Skip:** Subtle link "Set up later in Settings" with warning about limited features

### Step 7: Productivity Skills (Desktop Only)
- **Illustration:** Toolbox/puzzle pieces
- **Headline:** "Supercharge your workflow"
- **Subhead:** "Skills teach your AI assistant new tricks"
- **Pre-selected skills (from manifest):**
  - docx - "Create professional Word documents"
  - xlsx - "Build and edit spreadsheets"
  - pptx - "Design beautiful presentations"
  - executive-assistant - "Meeting notes and task management"
  - content-research-writer - "Write blog posts and articles"
  - planning-with-files - "Structured planning workflow"
  - strategic-planning - "Plan projects and campaigns"
  - nostr-devrel - "Nostr developer relations toolkit"
- **Action:** "Install Selected Skills" → installs checked
- **Skip:** Subtle link "Browse skills later in Settings"

### Step 8: Completion
- **Illustration:** Checkmark with confetti particles
- **Headline:** "You're all set!"
- **Subhead:** "Your workspace is ready. Let's create something amazing."
- **Summary:** Checkmarks for completed items, arrows for skipped
- **Actions:**
  - Primary: "Create Your First Note" → closes wizard, creates note
  - Secondary: "Explore Onyx" → closes wizard only

---

## Technical Details

### Component Interface

```tsx
interface OnboardingProps {
  isMobile: boolean;
  onComplete: (result: OnboardingResult) => void;
}

interface OnboardingResult {
  vaultPath: string;
  nostrSetup: 'created' | 'imported' | 'skipped';
  nostrNpub?: string;
  syncEnabled: boolean;
  openCodeInstalled: boolean;
  installedSkills: string[];
  createFirstNote: boolean;
}

type OnboardingStep = 'welcome' | 'vault' | 'features' | 'nostr' | 'sync' | 'opencode' | 'skills' | 'complete';
```

### First-Run Detection

```tsx
// In App.tsx onMount
const shouldShowOnboarding = localStorage.getItem('onboarding_completed') !== 'true';
```

### Settings Integration

Add to General settings section:
```tsx
<div class="setting-item">
  <div class="setting-info">
    <span class="setting-name">Welcome Tour</span>
    <span class="setting-description">Show the welcome tour again</span>
  </div>
  <button class="setting-button secondary" onClick={handleShowOnboarding}>
    Show Welcome Tour
  </button>
</div>
```

### Platform-Aware Steps

```tsx
const getSteps = (isMobile: boolean): OnboardingStep[] => {
  if (isMobile) {
    return ['welcome', 'vault', 'features', 'nostr', 'sync', 'complete'];
  }
  return ['welcome', 'vault', 'features', 'nostr', 'sync', 'opencode', 'skills', 'complete'];
};
```

---

## SVG Illustrations Style Guide

- **Viewbox:** 200x150
- **Style:** Simple, geometric, modern, minimal detail
- **Colors:** Use CSS variables for theming
  - Primary accent: `var(--accent)` or `#8b5cf6` (purple)
  - Secondary: `var(--text-muted)` or `#6b7280`
  - Background elements: `var(--bg-tertiary)` or subtle grays
- **Onyx branding:** Include stylized "O" logo element where appropriate

---

## CSS Structure

```css
/* Main overlay */
.onboarding-overlay { ... }

/* Modal card */
.onboarding-modal { ... }

/* Progress indicator */
.onboarding-progress { ... }
.onboarding-progress-dot { ... }
.onboarding-progress-dot.active { ... }
.onboarding-progress-dot.completed { ... }

/* Step content */
.onboarding-illustration { ... }
.onboarding-headline { ... }
.onboarding-subhead { ... }
.onboarding-benefits { ... }
.onboarding-benefit-item { ... }

/* Actions */
.onboarding-actions { ... }
.onboarding-button { ... }
.onboarding-button.primary { ... }
.onboarding-button.secondary { ... }
.onboarding-skip-link { ... }

/* Step-specific */
.onboarding-vault-options { ... }
.onboarding-feature-cards { ... }
.onboarding-nostr-form { ... }
.onboarding-key-display { ... }
.onboarding-key-warning { ... }
.onboarding-skills-list { ... }
.onboarding-skill-item { ... }
.onboarding-summary { ... }
```

---

## Error Handling

### Vault Creation Failure
- Show inline error with retry button
- Cannot skip - vault is required

### OpenCode Installation Failure
- Show error message with "Retry" button
- Allow skip with warning: "Some AI features won't be available. You can install later in Settings."

### Skill Installation Failure
- Show which skills failed
- Continue with successfully installed skills
- Message: "Some skills couldn't be installed. You can retry in Settings."

---

## Design Decisions

1. **8 steps total** - Welcome, Vault, Features, Nostr, Sync, OpenCode (desktop), Skills (desktop), Complete
2. **Simple SVG illustrations** with Onyx branding/logo where appropriate
3. **Subtle skip links** with "Set up later in Settings" messaging
4. **Mobile skips OpenCode/Skills** since not supported on mobile
5. **Pre-select recommended skills** from the manifest
6. **Show nsec with backup warning** when creating new Nostr identity
7. **Minimal animations** - fade transitions only
8. **Settings re-trigger** - "Show Welcome Tour" button in General settings
9. **Retry on OpenCode failure** with option to skip with warning
