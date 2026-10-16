// Serialized into the page's MAIN world. This closed adapter accepts data only;
// neither model text nor page text is evaluated as JavaScript.
export function editorModelBridge(context, operation, text = '') {
  if (
    !context ||
    location.href !== context.url ||
    !/^[a-f0-9-]{36}$/.test(context.marker) ||
    !['read', 'replace'].includes(operation) ||
    typeof text !== 'string' ||
    text.length > 4000
  )
    return { unavailable: true, reason: 'Editor context changed or arguments are invalid' };
  const target = document.querySelector(`[data-voiceqa-editor="${context.marker}"]`);
  if (!target || !target.isConnected)
    return { unavailable: true, reason: 'Editor target detached' };
  const root = target.closest('.monaco-editor');
  if (!root)
    return { unavailable: true, reason: 'A full model adapter is unavailable for this editor' };
  if (
    !context.privateSelectors ||
    target.closest(context.privateSelectors) ||
    root.closest(context.privateSelectors) ||
    root.querySelector(context.privateSelectors)
  )
    return { unavailable: true, reason: 'Private editor content is unavailable' };
  if (context.binding && root.getAttribute('data-uri') !== context.binding)
    return { unavailable: true, reason: 'The editor changed its active model' };
  const editors = globalThis.monaco?.editor?.getEditors?.() || [];
  const matching = editors.filter(
    (editor) => editor.getDomNode?.() === root && editor.getModel?.(),
  );
  if (matching.length !== 1)
    return { unavailable: true, reason: 'No unique editor model is bound to this control' };
  const editor = matching[0],
    model = editor.getModel();
  if (operation === 'replace') {
    if (editor.getOption?.(globalThis.monaco.editor.EditorOption?.readOnly) === true)
      return { unavailable: true, reason: 'Editor is read-only' };
    // executeEdits retains the model's existing EOL (CRLF on Windows). Bind
    // its EOL to the supplied source before comparing an exact full readback.
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    if (
      text.replaceAll('\r\n', '\n').includes('\r') ||
      (eol === '\r\n' && text.replaceAll('\r\n', '').includes('\n'))
    )
      return {
        unavailable: true,
        reason: 'Mixed source line endings cannot be preserved by this editor',
      };
    if (model.getEOL() !== eol && typeof model.pushEOL !== 'function')
      return {
        unavailable: true,
        reason: 'Editor cannot preserve the supplied source line endings',
      };
    editor.pushUndoStop();
    if (model.getEOL() !== eol) model.pushEOL(eol === '\r\n' ? 1 : 0);
    editor.executeEdits('voiceqa', [
      { range: model.getFullModelRange(), text, forceMoveMarkers: true },
    ]);
    editor.pushUndoStop();
  }
  const length = model.getValueLength();
  if (length > 4000)
    return {
      complete: false,
      source: 'monaco-model',
      length,
      reason: 'Editor content exceeds the 4000-character public value allowance',
    };
  if (context.binding && root.getAttribute('data-uri') !== context.binding)
    return { unavailable: true, reason: 'The editor changed its active model' };
  const value = model.getValue();
  if (editor.getModel() !== model)
    return { unavailable: true, reason: 'The editor model changed during access' };
  return {
    value,
    complete: true,
    source: 'monaco-model',
    length: value.length,
    version: model.getVersionId(),
    editorURI: String(model.uri || '').slice(0, 400),
    ...(operation === 'replace' ? { verified: value === text } : {}),
  };
}
