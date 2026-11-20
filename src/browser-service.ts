const backend = document.querySelector<HTMLMetaElement>('meta[name="app-origin"]')?.content ?? '';
export const hostedOnPages = Boolean(backend);
const sessionKey = 'koi-vgc-results:session';

export const loginPage = hostedOnPages ? './' : '/';
export const panelPage = hostedOnPages ? './panel.html' : '/panel';

export function setSession(token?: string) {
  if (!hostedOnPages) return;
  if (token) sessionStorage.setItem(sessionKey, token);
  else sessionStorage.removeItem(sessionKey);
}

export function serviceUrl(path: string) {
  return path && backend ? backend + path : path;
}

export function serviceFetch(path: string, options: RequestInit = {}) {
  if (!hostedOnPages) return fetch(path, options);
  const headers = new Headers(options.headers);
  const session = path.startsWith('/api/') && sessionStorage.getItem(sessionKey);
  if (session) headers.set('Authorization', `Bearer ${session}`);
  return fetch(serviceUrl(path), { ...options, headers, credentials: 'omit' });
}

export function previewPage(kind: 'sprite-preview' | 'live-view', query?: URLSearchParams) {
  const target = hostedOnPages ? './overlay.html' : `/api/panel/${kind}`;
  if (!hostedOnPages) return query ? `${target}?${query}` : target;
  const params = new URLSearchParams(query);
  params.set('view', kind);
  return `${target}?${params}`;
}

type MediaElement = HTMLImageElement | HTMLMediaElement;
const pending = new WeakMap<MediaElement, AbortController>();
const blobs = new Map<MediaElement, string>();
let observer: MutationObserver | undefined;

export function clearAsset(media: MediaElement) {
  pending.get(media)?.abort();
  pending.delete(media);
  const previous = blobs.get(media);
  if (previous) URL.revokeObjectURL(previous);
  blobs.delete(media);
  media.removeAttribute('src');
}

export function setAsset(media: MediaElement, path: string) {
  clearAsset(media);
  if (!hostedOnPages || !path.startsWith('/api/')) {
    media.src = serviceUrl(path);
    return;
  }
  const request = new AbortController();
  pending.set(media, request);
  void serviceFetch(path, { signal: request.signal }).then(async response => {
    if (!response.ok) throw new Error('No se pudo cargar el archivo.');
    const content = await response.blob();
    if (request.signal.aborted || !media.isConnected) return;
    const url = URL.createObjectURL(content);
    blobs.set(media, url);
    media.src = url;
    observer ??= new MutationObserver(() => {
      for (const element of blobs.keys()) if (!element.isConnected) clearAsset(element);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }).catch(() => {
    if (!request.signal.aborted && media.isConnected) media.dispatchEvent(new Event('error'));
  }).finally(() => {
    if (pending.get(media) === request) pending.delete(media);
  });
}
