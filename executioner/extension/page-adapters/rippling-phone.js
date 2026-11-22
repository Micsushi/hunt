export function revealRipplingPhoneSelection(input, list) {
  if (location.hostname !== 'ats.rippling.com' || list.getAttribute('data-testid') !== 'menuList' ||
      list.getAttribute('data-search-state') !== 'settled' || list.getAttribute('data-search-query') !== '') return;
  const active = input.getAttribute('aria-activedescendant');
  const prefix = list.id + '-option-';
  if (!active?.startsWith(prefix) || list.getAttribute('aria-activedescendant') !== active ||
      input.getRootNode().getElementById(active)) return;
  const index = active.slice(prefix.length);
  const item = list.querySelector('[data-item-index][data-known-size]');
  const size = Number(item?.getAttribute('data-known-size'));
  const scrollers = list.querySelectorAll('[data-virtuoso-scroller]');
  if (!/^\d+$/.test(index) || Number(index) >= Number(list.getAttribute('data-count')) ||
      size <= 0 || scrollers.length !== 1 || !scrollers[0].contains(item)) return;
  // Reveal the referenced virtual row so its selected state can be read. Scrolling never proves selection.
  const scroller = scrollers[0], before = scroller.scrollTop;
  scroller.scrollTop = Number(index) * size;
  const reached = scroller.scrollTop;
  return () => {
    if (scroller.isConnected && scroller.scrollTop === reached) scroller.scrollTop = before;
  };
}
