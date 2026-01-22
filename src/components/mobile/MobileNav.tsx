/**
 * Mobile Navigation Component
 * 
 * Bottom navigation bar for mobile devices with 4-5 main navigation icons.
 */

import { Component, Show } from 'solid-js';
import { selectionChanged } from '../../lib/haptics';

export type MobileNavTab = 'files' | 'search' | 'bookmarks' | 'notifications' | 'settings';

interface MobileNavProps {
  activeTab: MobileNavTab;
  onTabChange: (tab: MobileNavTab) => void;
  unreadNotifications?: number;
}

const MobileNav: Component<MobileNavProps> = (props) => {
  const handleTabChange = (tab: MobileNavTab) => {
    selectionChanged();
    props.onTabChange(tab);
  };

  return (
    <nav class="mobile-nav">
      <button 
        class={`mobile-nav-item ${props.activeTab === 'files' ? 'active' : ''}`}
        onClick={() => handleTabChange('files')}
        aria-label="Files"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <span class="mobile-nav-label">Files</span>
      </button>

      <button 
        class={`mobile-nav-item ${props.activeTab === 'search' ? 'active' : ''}`}
        onClick={() => handleTabChange('search')}
        aria-label="Search"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.35-4.35"></path>
        </svg>
        <span class="mobile-nav-label">Search</span>
      </button>

      <button 
        class={`mobile-nav-item ${props.activeTab === 'bookmarks' ? 'active' : ''}`}
        onClick={() => handleTabChange('bookmarks')}
        aria-label="Bookmarks"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>
        </svg>
        <span class="mobile-nav-label">Bookmarks</span>
      </button>

      <button 
        class={`mobile-nav-item ${props.activeTab === 'notifications' ? 'active' : ''}`}
        onClick={() => handleTabChange('notifications')}
        aria-label="Notifications"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
        </svg>
        <span class="mobile-nav-label">Inbox</span>
        <Show when={props.unreadNotifications && props.unreadNotifications > 0}>
          <span class="mobile-nav-badge">{props.unreadNotifications}</span>
        </Show>
      </button>

      <button 
        class={`mobile-nav-item ${props.activeTab === 'settings' ? 'active' : ''}`}
        onClick={() => handleTabChange('settings')}
        aria-label="Settings"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"></circle>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
        <span class="mobile-nav-label">Settings</span>
      </button>
    </nav>
  );
};

export default MobileNav;
