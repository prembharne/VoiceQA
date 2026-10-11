export function allowedDemoAPI(raw, origin, kind) {
  try {
    if (!['workspace', 'security'].includes(kind)) return false;
    const url = new URL(raw);
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
