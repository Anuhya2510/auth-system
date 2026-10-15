const isTrashView = window.location.pathname.endsWith('/recently-deleted.html');
const query = new URLSearchParams(window.location.search);
let category = ['all', 'photos', 'videos', 'documents', 'folders'].includes(query.get('category'))
  ? query.get('category')
  : 'all';
const selected = new Map();
const PAGE_SIZE = 50;
let selectionMode = false;
let selectionPurpose = null;
let items = [];
let folders = [];
let totalItems = 0;
let currentFolderId = 0;
let pendingRestore = null;
let pendingRename = null;
let searchTimer;
let isUploading = false;
let noticeTimer;

const itemGrid = document.getElementById('itemGrid');
const loadingIndicator = document.getElementById('loadingIndicator');
const emptyState = document.getElementById('emptyState');
const selectionBar = document.getElementById('selectionBar');
const selectionActions = document.getElementById('selectionActions');
const galleryNotice = document.getElementById('galleryNotice');

function itemKey(item) {
  return `${item.kind}:${item.id}`;
}

function showNotice(message, type = 'success', duration = 0) {
  clearTimeout(noticeTimer);
  galleryNotice.textContent = message;
  galleryNotice.className = `gallery-notice ${type}`;
  galleryNotice.hidden = false;
  if (duration > 0) noticeTimer = setTimeout(hideNotice, duration);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  galleryNotice.hidden = true;
  galleryNotice.textContent = '';
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = { success: false, message: 'Unexpected server response.' };
  }
  if (response.status === 401) {
    window.location.replace('/login.html');
    throw new Error('Your session has expired. Please log in again.');
  }
  if (!response.ok || !data.success) {
    const error = new Error(data.message || 'The request could not be completed.');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

async function loadCurrentUser() {
  try {
    const response = await fetch('/api/me', { credentials: 'include' });
    if (!response.ok) {
      window.location.replace('/login.html');
      return;
    }
    const { user } = await response.json();
    if (!user) {
      window.location.replace('/login.html');
      return;
    }
    document.getElementById('galleryUser').textContent = `Hi, ${user.username}`;
  } catch {
    window.location.replace('/login.html');
  }
}

function updateSelectionBar() {
  itemGrid.classList.toggle('selection-mode', selectionMode);
  itemGrid.classList.toggle('favorite-selection-mode', selectionPurpose === 'favorite');
  const visibleKeys = items.map(itemKey);
  const visibleSelected = visibleKeys.filter((key) => selected.has(key)).length;
  selectionBar.hidden = selected.size === 0;
  document.getElementById('selectionCount').textContent =
    `${selected.size} selected`;
  document.getElementById('clearSelection').hidden = selected.size === 0;
  const selectAll = document.getElementById('selectAll');
  if (selectAll) {
    selectAll.checked = items.length > 0 && visibleSelected === items.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < items.length;
  }
  selectionActions.replaceChildren();

  if (selected.size === 0) return;
  if (isTrashView) {
    addActionButton('Restore selected', 'secondary', restoreSelected);
    addActionButton('Delete permanently', 'danger', permanentlyDeleteSelected);
  } else if (selectionPurpose === 'favorite') {
    addActionButton('Add to Favorites', 'secondary', () => updateSelectedFavorites(true));
  } else {
    addActionButton('Move to Recently Deleted', 'danger', trashSelected);
  }
}

function addActionButton(label, style, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `gallery-button ${style === 'danger' ? 'danger-button' : 'secondary'}`;
  button.textContent = label;
  button.addEventListener('click', action);
  selectionActions.append(button);
}

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(bytes);
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function remainingTime(value) {
  const remainingMs = new Date(value).getTime() - Date.now();
  if (remainingMs <= 0) return 'Expiring now';
  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  if (remainingDays >= 2) return `${remainingDays} days left`;
  const remainingHours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
  return `${remainingHours} ${remainingHours === 1 ? 'hour' : 'hours'} left`;
}

function iconFor(item) {
  if (item.kind === 'folder') return '📁';
  if ((item.mime_type || '').startsWith('image/')) return '▧';
  if ((item.mime_type || '').startsWith('video/')) return '▶';
  if (item.mime_type === 'application/pdf') return 'PDF';
  return 'FILE';
}

function createButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function closeItemMenus(except = null) {
  document.querySelectorAll('.item-menu[open]').forEach((menu) => {
    if (menu !== except) {
      menu.open = false;
      menu.closest('.gallery-item')?.classList.remove('menu-open');
      menu.querySelector('.item-menu-toggle')?.setAttribute('aria-expanded', 'false');
    }
  });
}

function createItemElement(item) {
  const card = document.createElement('article');
  card.className = `gallery-item ${item.kind === 'folder' ? 'folder-item' : ''}`;
  const key = itemKey(item);

  const selectLabel = document.createElement(selectionPurpose === 'favorite' ? 'div' : 'label');
  selectLabel.className = 'item-select';
  if (selectionPurpose === 'favorite') {
    const star = createButton(
      selected.has(key) ? '★' : '☆',
      'item-favorite-select',
      () => {
        if (selected.has(key)) selected.delete(key);
        else selected.set(key, item);
        selectionMode = selected.size > 0;
        if (!selectionMode) selectionPurpose = null;
        renderItems();
      }
    );
    star.setAttribute('aria-label', `${selected.has(key) ? 'Deselect' : 'Select'} ${item.name} for Favorites`);
    star.setAttribute('aria-pressed', String(selected.has(key)));
    selectLabel.append(star);
  } else {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(key);
    checkbox.setAttribute('aria-label', `Select ${item.name}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.set(key, item);
      else selected.delete(key);
      selectionMode = selected.size > 0;
      if (!selectionMode) selectionPurpose = null;
      updateSelectionBar();
    });
    selectLabel.append(checkbox);
  }
  card.append(selectLabel);

  const preview = document.createElement('div');
  preview.className = 'item-preview';
  if (item.kind === 'file' && (item.mime_type || '').startsWith('image/')) {
    const image = document.createElement('img');
    image.src = `/api/gallery/files/${item.id}/content?inline=1${isTrashView ? '&deleted=1' : ''}`;
    image.alt = '';
    image.loading = 'lazy';
    image.addEventListener('error', () => {
      image.remove();
      preview.textContent = iconFor(item);
    }, { once: true });
    preview.append(image);
  } else {
    preview.textContent = iconFor(item);
    preview.classList.add('file-icon-preview');
  }
  card.append(preview);

  const content = document.createElement('div');
  content.className = 'item-content';
  const name = document.createElement('div');
  name.className = 'item-name';
  name.title = item.name;
  name.textContent = item.name;
  content.append(name);

  const metadata = document.createElement('div');
  metadata.className = 'item-metadata';
  if (isTrashView) {
    const deleted = document.createElement('span');
    deleted.textContent = `Deleted ${formatDate(item.deleted_at)}`;
    const expiry = document.createElement('span');
    expiry.className = 'item-expiry';
    expiry.textContent = remainingTime(item.delete_expires_at);
    metadata.append(deleted, expiry);
  } else {
    const type = document.createElement('span');
    type.textContent = item.kind === 'folder' ? 'Folder' : (item.mime_type || 'File');
    const details = document.createElement('span');
    details.textContent = `${formatSize(item.size)} · ${formatDate(item.created_at)}`;
    metadata.append(type, details);
  }
  content.append(metadata);

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const menu = document.createElement('details');
  menu.className = 'item-menu';
  const menuToggle = document.createElement('summary');
  menuToggle.className = 'item-menu-toggle';
  menuToggle.textContent = '⋮';
  menuToggle.setAttribute('aria-label', `More actions for ${item.name}`);
  menuToggle.setAttribute('aria-haspopup', 'menu');
  menuToggle.setAttribute('aria-expanded', 'false');
  menuToggle.addEventListener('click', (event) => {
    event.preventDefault();
    const willOpen = !menu.open;
    closeItemMenus(menu);
    menu.open = willOpen;
    card.classList.toggle('menu-open', willOpen);
    menuToggle.setAttribute('aria-expanded', String(willOpen));
  });
  const menuOptions = document.createElement('div');
  menuOptions.className = 'item-menu-options';
  menuOptions.setAttribute('role', 'menu');
  const addMenuOption = (label, action, isDanger = false) => {
    const option = createButton(label, `item-menu-option${isDanger ? ' danger-text' : ''}`, () => {
      menu.open = false;
      card.classList.remove('menu-open');
      menuToggle.setAttribute('aria-expanded', 'false');
      action();
    });
    option.setAttribute('role', 'menuitem');
    menuOptions.append(option);
  };

  if (isTrashView) {
    if (item.kind === 'file') {
      addMenuOption('Preview', () => openPreview(item));
    }
    addMenuOption('Restore', () => restoreItems([item]));
    addMenuOption('Delete permanently', () => beginDeleteSelection(item), true);
  } else {
    if (item.kind === 'folder') {
      addMenuOption('Open', () => {
        currentFolderId = Number(item.id);
        selected.clear();
        loadItems();
      });
    } else {
      addMenuOption('Preview', () => openPreview(item));
      addMenuOption('Download', () => downloadFile(item));
    }
    addMenuOption('Rename', () => renameItem(item));
    const isFavorite = Number(item.is_favorite) === 1;
    addMenuOption(
      isFavorite ? 'Unfavorite' : 'Favorites',
      () => isFavorite ? updateSelectedFavorites(false, [item]) : beginFavoriteSelection(item)
    );
    addMenuOption('Delete', () => trashItems([item]), true);
  }
  menu.append(menuToggle, menuOptions);
  actions.append(menu);
  content.append(actions);
  card.append(content);
  return card;
}

function folderPath(folderId) {
  const path = [];
  let currentId = Number(folderId);
  while (currentId !== 0) {
    const folder = folders.find((entry) => Number(entry.id) === currentId);
    if (!folder) break;
    path.unshift(folder);
    currentId = Number(folder.parent_id);
  }
  return path;
}

function renderBreadcrumbs() {
  const container = document.getElementById('breadcrumbs');
  if (!container) return;
  container.replaceChildren();
  const root = createButton('Gallery', 'breadcrumb-button', () => {
    currentFolderId = 0;
    loadItems();
  });
  container.append(root);
  for (const folder of folderPath(currentFolderId)) {
    const separator = document.createElement('span');
    separator.textContent = '/';
    separator.setAttribute('aria-hidden', 'true');
    const crumb = createButton(folder.name, 'breadcrumb-button', () => {
      currentFolderId = Number(folder.id);
      loadItems();
    });
    container.append(separator, crumb);
  }
}

function renderItems() {
  itemGrid.replaceChildren(...items.map(createItemElement));
  document.getElementById('itemCount').textContent =
    `${totalItems} ${totalItems === 1 ? 'item' : 'items'}`;
  emptyState.hidden = totalItems > 0;
  itemGrid.hidden = totalItems === 0;
  if (isTrashView) {
    document.getElementById('emptyTrashButton').hidden = totalItems === 0;
    document.getElementById('restoreAllButton').disabled = totalItems === 0;
  } else {
    renderBreadcrumbs();
  }
  updateSelectionBar();
}

async function loadFolders() {
  const result = await api('/api/gallery/folders');
  folders = result.folders;
}

async function loadItems() {
  totalItems = 0;
  items = [];
  await loadPage(false);
}

async function loadPage(append) {
  const offset = append ? items.length : 0;
  loadingIndicator.hidden = false;
  if (!append) itemGrid.hidden = true;
  emptyState.hidden = true;
  hideNotice();
  try {
    const search = document.getElementById('searchInput').value.trim();
    const sort = document.getElementById('sortSelect').value;
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
      search,
      sort,
    });
    const result = isTrashView
      ? await api(`/api/gallery/trash?${params}&category=${document.getElementById('trashCategory').value}`)
      : await api(
        `/api/gallery/items?${params}&folderId=${currentFolderId}&category=${category}`
      );
    totalItems = result.total;
    if (append) {
      items.push(...result.items);
    } else {
      items = result.items;
      selected.clear();
      selectionMode = false;
      selectionPurpose = null;
    }
    renderItems();
  } catch (err) {
    showNotice(err.message, 'error');
  } finally {
    loadingIndicator.hidden = true;
    if (totalItems > 0) itemGrid.hidden = false;
    const pagination = document.getElementById('paginationControls');
    pagination.hidden = items.length >= totalItems || totalItems === 0;
    document.getElementById('paginationStatus').textContent =
      `Showing ${items.length} of ${totalItems}`;
  }
}

function renameItem(item) {
  const dialog = document.getElementById('renameDialog');
  const input = document.getElementById('renameInput');
  if (!dialog || !input) return;
  pendingRename = item;
  input.value = item.name;
  input.setCustomValidity('');
  dialog.showModal();
  input.focus();
  input.select();
}

async function submitRename(event) {
  event.preventDefault();
  const item = pendingRename;
  const input = document.getElementById('renameInput');
  const name = input.value.trim();
  if (!item) return;
  if (!name) {
    input.setCustomValidity('Enter a name.');
    input.reportValidity();
    return;
  }
  input.setCustomValidity('');
  if (name === item.name) {
    document.getElementById('renameDialog').close();
    pendingRename = null;
    return;
  }
  try {
    await api(`/api/gallery/${item.kind === 'folder' ? 'folders' : 'files'}/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
    document.getElementById('renameDialog').close();
    pendingRename = null;
    await loadFolders();
    await loadItems();
    showNotice(`${item.kind === 'folder' ? 'Folder' : 'File'} renamed.`, 'success', 5000);
  } catch (err) {
    document.getElementById('renameDialog').close();
    pendingRename = null;
    showNotice(err.message, 'error');
  }
}

async function uploadFiles(fileList) {
  if (isUploading) return;
  const files = [...fileList];
  if (!files.length) return;
  const chunks = [];
  let chunk = [];
  let chunkSize = 0;
  for (const file of files) {
    if (file.size > 25 * 1024 * 1024) {
      showNotice(`${file.name} is larger than the 25 MB per-file limit.`, 'error');
      return;
    }
    if (chunk.length === 10 || chunkSize + file.size > 50 * 1024 * 1024) {
      chunks.push(chunk);
      chunk = [];
      chunkSize = 0;
    }
    chunk.push(file);
    chunkSize += file.size;
  }
  if (chunk.length) chunks.push(chunk);

  loadingIndicator.hidden = false;
  itemGrid.hidden = true;
  isUploading = true;
  document.getElementById('uploadButton').disabled = true;
  document.getElementById('folderUploadButton').disabled = true;
  let uploaded = 0;
  try {
    for (const batch of chunks) {
      const formData = new FormData();
      formData.append('folderId', String(currentFolderId));
      for (const file of batch) {
        formData.append('files', file, file.webkitRelativePath || file.name);
      }
      const result = await api('/api/gallery/upload', { method: 'POST', body: formData });
      uploaded += result.items.length;
    }
    await loadFolders();
    await loadItems();
    showNotice(`${uploaded} ${uploaded === 1 ? 'file' : 'files'} uploaded.`, 'success', 5000);
  } catch (err) {
    showNotice(err.message, 'error');
  } finally {
    isUploading = false;
    document.getElementById('uploadButton').disabled = false;
    document.getElementById('folderUploadButton').disabled = false;
    loadingIndicator.hidden = true;
  }
}

function currentSelectedItems() {
  return [...selected.values()];
}

async function trashItems(chosenItems) {
  const files = chosenItems.filter((item) => item.kind === 'file');
  const folders = chosenItems.filter((item) => item.kind === 'folder');
  const count = chosenItems.length;
  try {
    const result = await api('/api/gallery/trash', {
      method: 'POST',
      body: JSON.stringify({
        fileIds: files.map((item) => item.id),
        folderIds: folders.map((item) => item.id),
      }),
    });
    selected.clear();
    await loadFolders();
    await loadItems();
    showNotice(`${result.count} ${result.count === 1 ? 'item' : 'items'} moved to Recently Deleted.`, 'success', 5000);
  } catch (err) {
    showNotice(err.message, 'error');
  }
}

function trashSelected() {
  trashItems(currentSelectedItems());
}

function beginDeleteSelection(item) {
  selected.set(itemKey(item), item);
  selectionMode = true;
  selectionPurpose = 'delete';
  renderItems();
  selectionBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('selectAll').focus({ preventScroll: true });
}

function beginFavoriteSelection(item) {
  selected.set(itemKey(item), item);
  selectionMode = true;
  selectionPurpose = 'favorite';
  renderItems();
  selectionBar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const firstStar = itemGrid.querySelector('.item-favorite-select[aria-pressed="true"]');
  firstStar?.focus({ preventScroll: true });
}

async function updateSelectedFavorites(isFavorite, chosenItems = currentSelectedItems()) {
  const fileIds = chosenItems.filter((item) => item.kind === 'file').map((item) => item.id);
  const folderIds = chosenItems.filter((item) => item.kind === 'folder').map((item) => item.id);
  try {
    const result = await api('/api/gallery/favorites', {
      method: 'POST',
      body: JSON.stringify({ fileIds, folderIds, isFavorite }),
    });
    selected.clear();
    selectionMode = false;
    selectionPurpose = null;
    await loadItems();
    showNotice(result.message, 'success', 5000);
  } catch (err) {
    showNotice(err.message, 'error');
  }
}

function buildFolderLabel(folder) {
  const labels = folderPath(Number(folder.id)).map((entry) => entry.name);
  return labels.join(' / ');
}

function showDestinationDialog(chosenItems, all = false) {
  pendingRestore = { items: chosenItems, all };
  const select = document.getElementById('destinationSelect');
  select.replaceChildren();
  const rootOption = document.createElement('option');
  rootOption.value = '0';
  rootOption.textContent = 'Gallery root';
  select.append(rootOption);
  for (const folder of folders) {
    const option = document.createElement('option');
    option.value = String(folder.id);
    option.textContent = buildFolderLabel(folder);
    select.append(option);
  }
  document.getElementById('destinationDialog').showModal();
}

async function restoreItems(chosenItems, targetFolderId, all = false) {
  if (!chosenItems.length && !all) return;
  try {
    const result = await api('/api/gallery/restore', {
      method: 'POST',
      body: JSON.stringify({
        ...(all ? { all: true } : {
          fileIds: chosenItems.filter((item) => item.kind === 'file').map((item) => item.id),
          folderIds: chosenItems.filter((item) => item.kind === 'folder').map((item) => item.id),
        }),
        ...(targetFolderId === undefined ? {} : { targetFolderId }),
      }),
    });
    selected.clear();
    await loadFolders();
    await loadItems();
    showNotice(result.message, 'success', 5000);
  } catch (err) {
    if (err.code === 'RESTORE_DESTINATION_REQUIRED') {
      if (!folders.length) await loadFolders();
      showDestinationDialog(chosenItems, all);
      return;
    }
    showNotice(err.message, 'error');
  }
}

function restoreSelected() {
  restoreItems(currentSelectedItems());
}

async function restoreAll() {
  if (totalItems === 0) return;
  await restoreItems([], undefined, true);
}

async function permanentlyDelete(chosenItems) {
  const files = chosenItems.filter((item) => item.kind === 'file');
  const folders = chosenItems.filter((item) => item.kind === 'folder');
  const count = chosenItems.length;
  try {
    const result = await api('/api/gallery/permanent', {
      method: 'DELETE',
      body: JSON.stringify({
        fileIds: files.map((item) => item.id),
        folderIds: folders.map((item) => item.id),
      }),
    });
    selected.clear();
    await loadItems();
    showNotice(`${result.count} ${result.count === 1 ? 'item' : 'items'} permanently deleted.`);
  } catch (err) {
    showNotice(err.message, 'error');
  }
}

function permanentlyDeleteSelected() {
  permanentlyDelete(currentSelectedItems());
}

async function emptyTrash() {
  try {
    await api('/api/gallery/permanent', {
      method: 'DELETE',
      body: JSON.stringify({ all: true }),
    });
    selected.clear();
    await loadItems();
    showNotice('Recently Deleted has been emptied.');
  } catch (err) {
    showNotice(err.message, 'error');
  }
}

function downloadFile(item) {
  window.location.href = `/api/gallery/files/${item.id}/content`;
}

async function openPreview(item) {
  const dialog = document.getElementById('previewDialog');
  const content = document.getElementById('previewContent');
  const mimeType = item.mime_type || '';
  const source = `/api/gallery/files/${item.id}/content?inline=1${isTrashView ? '&deleted=1' : ''}`;
  content.replaceChildren();
  document.getElementById('previewTitle').textContent = item.name;
  dialog.showModal();
  const showFallback = (message) => {
    const notice = document.createElement('p');
    notice.textContent = message;
    const link = document.createElement('a');
    link.href = `/api/gallery/files/${item.id}/content${isTrashView ? '?deleted=1' : ''}`;
    link.textContent = 'Download file';
    content.replaceChildren(notice, link);
  };
  if (['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(mimeType)) {
    const image = document.createElement('img');
    image.alt = item.name;
    image.addEventListener('error', () => showFallback('Could not load this image preview.'));
    content.append(image);
    image.src = source;
  } else if (['video/mp4', 'video/webm', 'video/ogg'].includes(mimeType)) {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.addEventListener('error', () => showFallback('Could not load this video preview.'));
    content.append(video);
    video.src = source;
  } else if (mimeType === 'application/pdf') {
    const frame = document.createElement('iframe');
    frame.src = source;
    frame.title = `Preview of ${item.name}`;
    frame.referrerPolicy = 'no-referrer';
    content.append(frame);
    const openLink = document.createElement('a');
    openLink.href = source;
    openLink.target = '_blank';
    openLink.rel = 'noopener';
    openLink.textContent = 'Open PDF in a new tab';
    content.append(openLink);
  } else if (
    mimeType.startsWith('text/')
    || ['application/json', 'application/xml', 'application/javascript', 'application/x-ndjson'].includes(mimeType)
  ) {
    const text = document.createElement('pre');
    text.textContent = 'Loading preview…';
    content.append(text);
    try {
      const response = await fetch(source, { credentials: 'include' });
      if (!response.ok) throw new Error('Could not load file preview.');
      text.textContent = await response.text();
    } catch (err) {
      showFallback(err.message);
    }
    return;
  } else {
    const message = document.createElement('p');
    message.textContent = 'Preview is not available for this file type.';
    const link = document.createElement('a');
    link.href = `/api/gallery/files/${item.id}/content${isTrashView ? '?deleted=1' : ''}`;
    link.textContent = 'Download file';
    content.append(message, link);
  }
}

function configurePage() {
  const categoryNav = document.getElementById('categoryNav');
  const uploadActions = document.getElementById('uploadActions');
  const toolbar = document.querySelector('.gallery-toolbar');
  if (isTrashView) {
    categoryNav?.remove();
    document.getElementById('emptyTitle').textContent = 'Recently Deleted is empty';
    document.getElementById('emptyDescription').textContent = 'Items you delete will be kept here for 30 days.';
    document.getElementById('sortSelect').value = 'date';
    document.getElementById('restoreAllButton').addEventListener('click', restoreAll);
  } else {
    document.getElementById('emptyTrashButton')?.remove();
    document.getElementById('galleryCategory').value = category;
    categoryNav?.querySelectorAll('a').forEach((link) => {
      link.classList.toggle('active', link.dataset.category === category);
    });
    document.getElementById('folderUploadButton').addEventListener('click', () => {
      document.getElementById('folderInput').click();
    });
    document.getElementById('uploadButton').addEventListener('click', () => {
      document.getElementById('fileInput').click();
    });
    document.getElementById('folderInput').addEventListener('change', (event) => {
      uploadFiles(event.target.files);
      event.target.value = '';
    });
    document.getElementById('fileInput').addEventListener('change', (event) => {
      uploadFiles(event.target.files);
      event.target.value = '';
    });
    document.getElementById('pageTitle').textContent =
      category === 'photos' ? 'Photos' :
        category === 'videos' ? 'Videos' :
          category === 'documents' ? 'Documents' :
            category === 'folders' ? 'Folders' : 'Gallery';
    if (toolbar) toolbar.classList.add('active-gallery-toolbar');
    configureDropUpload();
  }

  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });
  document.getElementById('sortSelect').addEventListener('change', loadItems);
  document.getElementById('galleryCategory')?.addEventListener('change', (event) => {
    category = event.target.value;
    categoryNav?.querySelectorAll('a').forEach((link) => {
      link.classList.toggle('active', link.dataset.category === category);
    });
    document.getElementById('pageTitle').textContent =
      category === 'photos' ? 'Photos' :
        category === 'videos' ? 'Videos' :
          category === 'documents' ? 'Documents' :
            category === 'folders' ? 'Folders' : 'Gallery';
    const nextUrl = new URL(window.location.href);
    if (category === 'all') nextUrl.searchParams.delete('category');
    else nextUrl.searchParams.set('category', category);
    window.history.replaceState(null, '', nextUrl);
    loadItems();
  });
  document.getElementById('searchInput').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadItems, 250);
  });
  document.getElementById('clearSelection').addEventListener('click', () => {
    selected.clear();
    selectionMode = false;
    selectionPurpose = null;
    renderItems();
  });
  document.getElementById('selectAll').addEventListener('change', (event) => {
    if (event.target.checked) {
      for (const item of items) selected.set(itemKey(item), item);
    } else {
      for (const item of items) selected.delete(itemKey(item));
    }
    selectionMode = selected.size > 0;
    if (!selectionMode) selectionPurpose = null;
    renderItems();
  });
  document.getElementById('loadMoreButton').addEventListener('click', () => loadPage(true));
  document.getElementById('trashCategory')?.addEventListener('change', loadItems);
  document.getElementById('emptyTrashButton')?.addEventListener('click', emptyTrash);
  document.getElementById('destinationForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pendingRestore) return;
    const destination = Number(document.getElementById('destinationSelect').value);
    document.getElementById('destinationDialog').close();
    restoreItems(pendingRestore.items, destination, pendingRestore.all);
    pendingRestore = null;
  });
  document.getElementById('renameForm')?.addEventListener('submit', submitRename);
  document.getElementById('renameDialog')?.addEventListener('close', () => {
    pendingRename = null;
  });
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      document.getElementById(button.dataset.close).close();
    });
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.item-menu')) closeItemMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeItemMenus();
  });
}

function setView(view) {
  if (!['grid', 'list'].includes(view)) return;
  localStorage.setItem('gallery-view', view);
  itemGrid.classList.toggle('list-view', view === 'list');
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function configureDropUpload() {
  const main = document.querySelector('.gallery-main');
  const overlay = document.getElementById('dropOverlay');
  let dragDepth = 0;
  main.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    dragDepth++;
    overlay.hidden = false;
  });
  main.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  });
  main.addEventListener('dragleave', (event) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });
  main.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    uploadFiles(event.dataTransfer.files);
  });
}

async function initialize() {
  configurePage();
  if (!isTrashView) setView(localStorage.getItem('gallery-view') || 'grid');
  await loadCurrentUser();
  try {
    if (!isTrashView) await loadFolders();
    await loadItems();
  } catch (err) {
    showNotice(err.message, 'error');
  }
}

initialize();
