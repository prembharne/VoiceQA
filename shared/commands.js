export function classifyCommand(text) {
  const normalized = String(text).toLowerCase().replace(/[.!?]/g, '').replace(/\s+/g, ' ').trim();
  if (/^(please )?(cancel|stop)( test| tests| run)?$/.test(normalized)) return 'cancel';
  if (
    ['run these tests', 'run the tests', 'start tests', 'confirm', 'run tests'].includes(normalized)
  )
    return 'start';
  if (normalized === 'resume') return 'resume';
  if (['status', 'test status'].includes(normalized)) return 'status';
  if (normalized === 'repeat') return 'repeat';
  if (normalized === 'run again') return 'rerun';
  return 'request';
}
