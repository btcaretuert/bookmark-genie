// The few chrome.* members this extension calls, typed by hand instead of @types/chrome.
// https://developer.chrome.com/docs/extensions/reference/api/bookmarks
// https://developer.chrome.com/docs/extensions/reference/api/storage
// https://developer.chrome.com/docs/extensions/reference/api/tabs
// https://developer.chrome.com/docs/extensions/reference/api/permissions
// https://developer.chrome.com/docs/extensions/reference/api/action

declare namespace chrome.events {
  interface Event<T extends (...args: any[]) => void> {
    addListener(callback: T): void;
  }
}

declare namespace chrome.bookmarks {
  type FolderType = 'bookmarks-bar' | 'other' | 'mobile' | 'managed';

  interface BookmarkTreeNode {
    id: string;
    parentId?: string;
    index?: number;
    title: string;
    url?: string;
    dateAdded?: number;
    dateGroupModified?: number;
    dateLastUsed?: number;
    folderType?: FolderType;
    syncing: boolean;
    unmodifiable?: 'managed';
    children?: BookmarkTreeNode[];
  }

  function getTree(): Promise<BookmarkTreeNode[]>;
  function get(idOrIdList: string | [string, ...string[]]): Promise<BookmarkTreeNode[]>;
  function getChildren(id: string): Promise<BookmarkTreeNode[]>;
  function move(id: string, destination: { parentId?: string; index?: number }): Promise<BookmarkTreeNode>;
  function create(bookmark: { parentId?: string; index?: number; title?: string; url?: string }): Promise<BookmarkTreeNode>;
  function remove(id: string): Promise<void>;

  const onMoved: chrome.events.Event<(id: string, moveInfo: { parentId: string; index: number; oldParentId: string; oldIndex: number }) => void>;
  const onRemoved: chrome.events.Event<(id: string, removeInfo: { parentId: string; index: number }) => void>;
  const onCreated: chrome.events.Event<(id: string, bookmark: BookmarkTreeNode) => void>;
  const onImportBegan: chrome.events.Event<() => void>;
  const onImportEnded: chrome.events.Event<() => void>;
}

declare namespace chrome.storage {
  interface StorageArea {
    get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
    setAccessLevel(details: { accessLevel: 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }): Promise<void>;
  }

  const local: StorageArea;
  const onChanged: chrome.events.Event<(changes: Record<string, unknown>, areaName: string) => void>;
}

declare namespace chrome.tabs {
  interface Tab {
    id?: number;
    url?: string;
    pendingUrl?: string;
  }

  function query(queryInfo: { active?: boolean; lastFocusedWindow?: boolean }): Promise<Tab[]>;
}

declare namespace chrome.permissions {
  interface Permissions {
    permissions?: string[];
    origins?: string[];
  }

  function contains(permissions: Permissions): Promise<boolean>;
  function request(permissions: Permissions): Promise<boolean>;
  function remove(permissions: Permissions): Promise<boolean>;
}

declare namespace chrome.action {
  function setBadgeText(details: { text: string }): Promise<void>;
  function setBadgeBackgroundColor(details: { color: string }): Promise<void>;
}

// https://developer.chrome.com/docs/extensions/reference/api/runtime
declare namespace chrome.runtime {
  function openOptionsPage(): Promise<void>;
  const onInstalled: chrome.events.Event<(details: { reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update'; previousVersion?: string }) => void>;
  const onStartup: chrome.events.Event<() => void>;
  const id: string;
  function sendMessage(message: unknown): Promise<any>;
  const onMessage: chrome.events.Event<(message: any, sender: { id?: string }, sendResponse: (response?: unknown) => void) => boolean | void>;
}
