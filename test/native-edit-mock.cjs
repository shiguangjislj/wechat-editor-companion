function installNativeEditMock(window, options = {}) {
  const commands = [];
  const doc = window.document;
  doc.execCommand = (command, _showUi, value) => {
    commands.push(command);
    if (options.reject) return false;
    const selection = doc.getSelection();
    if (!selection?.rangeCount) return false;
    const range = selection.getRangeAt(0);
    if (command === 'insertHTML') {
      const fragment = range.createContextualFragment(value);
      range.deleteContents();
      range.insertNode(fragment);
      const editor = doc.querySelector('[contenteditable="true"]');
      editor?.dispatchEvent(new window.Event('input', { bubbles: true }));
      options.afterInsert?.(editor);
      return true;
    }
    if (command.startsWith('justify')) {
      const node = range.commonAncestorContainer.nodeType === 1 ?
        range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
      const block = node?.closest('p,h1,h2,h3,h4,h5,h6,div,section');
      if (block) block.style.textAlign = command.replace('justify', '').toLowerCase();
      return true;
    }
    return false;
  };
  return commands;
}
module.exports = { installNativeEditMock };
