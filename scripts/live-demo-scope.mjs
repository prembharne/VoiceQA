export function allowedDemoAPI(raw, origin, kind) {
  try {
    if (!['workspace', 'security', 'parcel'].includes(kind)) return false;
    const url = new URL(raw);
    if (kind === 'parcel')
      return (
        url.origin === origin &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        /^\/api\/(?:me|orders(?:\/(?:OA1001|OB2002|PC[a-f0-9]{8}|\$\{[a-z][a-z0-9_-]{0,31}\})(?:\/approve)?)?)$/.test(
          decodeURIComponent(url.pathname),
        )
      );
    return (
      url.origin === origin &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith(`/${kind}/api/`)
    );
  } catch {
    return false;
  }
}
