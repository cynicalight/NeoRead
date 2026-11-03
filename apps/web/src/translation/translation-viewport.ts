/** Document blocks are in vertical reading order. Avoid measuring every prior block per scroll. */
export function translationBlockAt(nodes: readonly HTMLElement[], y: number) {
  let low = 0,
    high = nodes.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (nodes[middle].getBoundingClientRect().bottom > y) high = middle;
    else low = middle + 1;
  }
  return nodes[low];
}
