/**
 * Mobile Header Component
 * 
 * Top bar for mobile devices with hamburger menu, title, and action buttons.
 */

import { Component, Show } from 'solid-js';
import { impactLight } from '../../lib/haptics';

interface MobileHeaderProps {
  title: string;
  subtitle?: string;
  onMenuClick: () => void;
  onSearchClick?: () => void;
  onSyncClick?: () => void;
  onNotificationsClick?: () => void;
  syncStatus?: 'off' | 'idle' | 'syncing' | 'error';
  unreadNotifications?: number;
  isDirty?: boolean;
  onMoreClick?: () => void;
}

const MobileHeader: Component<MobileHeaderProps> = (props) => {
  return (
    <header class="mobile-header">
      <button 
        class="mobile-header-btn menu-btn"
        onClick={() => {
          impactLight();
          props.onMenuClick();
        }}
        aria-label="Open menu"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="3" y1="12" x2="21" y2="12"></line>
          <line x1="3" y1="6" x2="21" y2="6"></line>
          <line x1="3" y1="18" x2="21" y2="18"></line>
        </svg>
      </button>

      <div class="mobile-header-title">
        <span class="mobile-header-title-text">
          {props.isDirty ? '● ' : ''}{props.title}
        </span>
        <Show when={props.subtitle}>
          <span class="mobile-header-subtitle">{props.subtitle}</span>
        </Show>
      </div>

      <div class="mobile-header-actions">
        <Show when={props.onNotificationsClick}>
          <button 
            class="mobile-header-btn notification-btn"
            onClick={() => {
              impactLight();
              props.onNotificationsClick?.();
            }}
            aria-label="Notifications"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
            </svg>
            <Show when={props.unreadNotifications && props.unreadNotifications > 0}>
              <span class="notification-badge">{props.unreadNotifications}</span>
            </Show>
          </button>
        </Show>

        <Show when={props.onSyncClick && props.syncStatus !== 'off'}>
          <button 
            class={`mobile-header-btn sync-btn ${props.syncStatus}`}
            onClick={() => {
              impactLight();
              props.onSyncClick?.();
            }}
            aria-label="Sync"
          >
            <svg 
              width="22" 
              height="22" 
              viewBox="0 0 24 24" 
              fill="none" 
              stroke="currentColor" 
              stroke-width="2"
              class={props.syncStatus === 'syncing' ? 'spinning' : ''}
            >
              <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path>
              <path d="M3 3v5h5"></path>
              <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"></path>
              <path d="M16 16h5v5"></path>
            </svg>
          </button>
        </Show>

        {/* More menu - access to panels (Outline, Backlinks, Graph, Properties) */}
        <Show when={props.onMoreClick}>
          <button
            class="mobile-header-btn"
            onClick={() => {
              impactLight();
              props.onMoreClick?.();
            }}
            aria-label="More options"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="1"></circle>
              <circle cx="12" cy="5" r="1"></circle>
              <circle cx="12" cy="19" r="1"></circle>
            </svg>
          </button>
        </Show>
      </div>
    </header>
  );
};

export default MobileHeader;
