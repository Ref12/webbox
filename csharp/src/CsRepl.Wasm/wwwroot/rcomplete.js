// Completion inside #r "..." : `nuget: `, package names and versions from nuget.org, and framework assembly names.
// Pure (no Monaco): rContext() says where the cursor is, completeR() returns items; the services (fetch) are injected so tests use a fake NuGet API.

export const NUGET_AUTOCOMPLETE = 'https://azuresearch-usnc.nuget.org/autocomplete';      // CORS: Access-Control-Allow-Origin: *
export const NUGET_FLAT = 'https://api.nuget.org/v3-flatcontainer/';                         // CORS open too; has every version of a package

/**
 * Where is the cursor? null = not inside the quotes of a `#r "...` line. Otherwise
 *   { kind: 'prefix'|'package'|'version', partial, start }   start = offset where the text to replace begins (it ends at the cursor)
 *   and for 'version' also id.
 */
export function rContext(text, offset) {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  const m = /^[ \t]*#r[ \t]+"([^"]*)$/.exec(before);
  if (!m) return null;
  const inner = m[1], innerStart = offset - inner.length;
  const n = /^(nuget:[ \t]*)(.*)$/i.exec(inner);
  if (!n) return { kind: 'prefix', partial: inner, start: innerStart };
  const rest = n[2], restStart = innerStart + n[1].length, comma = rest.indexOf(',');
  if (comma < 0) return { kind: 'package', partial: rest, start: restStart };
  const afterComma = rest.slice(comma + 1), partial = afterComma.trimStart();
  return { kind: 'version', id: rest.slice(0, comma).trim(), partial, start: offset - partial.length };
}

/** nuget.org lookups with a small cache; every failure is an empty list (completion must never throw). */
export function createNuGetClient(fetchImpl = (...a) => fetch(...a)) {
  const cache = new Map();
  const once = (key, f) => { if (!cache.has(key)) cache.set(key, f().catch(() => { cache.delete(key); return []; })); return cache.get(key); };
  const getJson = async (url) => { const r = await fetchImpl(url); if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  return {
    searchPackages: (q) => once('s:' + q.toLowerCase(), async () => (await getJson(NUGET_AUTOCOMPLETE + '?q=' + encodeURIComponent(q) + '&take=30&prerelease=false&semVerLevel=2.0.0')).data ?? []),
    versions: (id) => once('v:' + id.toLowerCase(), async () => ((await getJson(NUGET_FLAT + encodeURIComponent(id.toLowerCase()) + '/index.json')).versions ?? [])),
  };
}

/** Newest first; pre-releases only when asked for (the typed text contains '-') or when there is nothing else. */
export function orderVersions(all, partial) {
  const stable = all.filter((v) => !v.includes('-'));
  const pool = partial.includes('-') || stable.length === 0 ? all : stable;
  return [...pool].reverse().filter((v) => v.toLowerCase().startsWith(partial.toLowerCase()));
}

/**
 * items: [{ label, insertText, start, kind: 'nuget'|'package'|'version'|'assembly', detail?, sortText }], the text between start and the cursor is replaced.
 * services: { nuget: createNuGetClient(), assemblies: () => ['System.Net.Http', ...] }.
 */
export async function completeR(text, offset, services) {
  const ctx = rContext(text, offset);
  if (!ctx) return null;
  const items = [];
  if (ctx.kind === 'prefix') {
    const p = ctx.partial.toLowerCase();
    if ('nuget: '.startsWith(p) || p.startsWith('nuget')) items.push({ label: 'nuget: ', insertText: 'nuget: ', start: ctx.start, kind: 'nuget', detail: 'a NuGet package from nuget.org', sortText: '0' });
    for (const a of services.assemblies?.() ?? []) if (a.toLowerCase().startsWith(p)) items.push({ label: a, insertText: a, start: ctx.start, kind: 'assembly', detail: 'framework assembly', sortText: '1' + a });
  } else if (ctx.kind === 'package') {
    const ids = await services.nuget.searchPackages(ctx.partial);
    ids.forEach((id, i) => items.push({ label: id, insertText: id + ', ', start: ctx.start, kind: 'package', detail: 'NuGet package', sortText: String(i).padStart(3, '0') }));
  } else {
    const vs = orderVersions(await services.nuget.versions(ctx.id), ctx.partial).slice(0, 60);
    vs.forEach((v, i) => items.push({ label: v, insertText: v, start: ctx.start, kind: 'version', detail: ctx.id + (i === 0 ? ' (latest)' : ''), sortText: String(i).padStart(3, '0') }));
  }
  return { context: ctx, items };
}
