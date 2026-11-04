// Base URL for pi-web API calls made by the copied rendering components
// (lazy thinking loading, read-aloud speak chunks). Set once at plugin
// startup from the settings' baseUrl; apiUrl() rebases pi-web's relative
// `/api/...` URLs onto the configured pi-web site.

let base = "";

export function setApiBase(url: string): void {
  base = url.replace(/\/+$/, "");
}

export function apiUrl(path: string): string {
  return `${base}${path}`;
}
