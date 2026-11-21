export function createDomReader() {
  const deepQuery = (root, selector) => {
    const matches = [...root.querySelectorAll(selector)];
    if (root.shadowRoot) matches.push(...deepQuery(root.shadowRoot,selector));
    for (const host of root.querySelectorAll('*')) {
      if (host.shadowRoot) matches.push(...deepQuery(host.shadowRoot, selector));
    }
    return matches;
  };
  const composedClosest = (element, selector) => {
    for (let current = element; current; current = current.getRootNode().host) {
      const match = current.closest(selector);
      if (match) return match;
    }
    return null;
  };
  const composedParent = e => e.parentElement || e.getRootNode().host || null;
  const composedContains = (parent, child) => {
    for (let node=child; node; node=node.getRootNode().host) if (parent.contains(node)) return true;
    return false;
  };
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const editable = e => visible(e) && !composedClosest(e, '[aria-hidden="true"],[inert]') && !e.disabled && !e.readOnly;
  return { deepQuery, composedClosest, composedParent, composedContains, visible, editable };
}
