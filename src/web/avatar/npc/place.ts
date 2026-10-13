/** Puts the NPC dialogue beside the cat: on the side with room (left first, as the cat starts top right), else below or
 * above it. It stays inside the chat area, above the composer (`bottom`) and under `keepOff` (the toolbar) when it would
 * cross it — both relative to the area — and says which side it took so the tail can point at the cat. */
export function placeBeside(panel: HTMLElement, cat: HTMLElement, width: number, bottom: number, keepOff: { left: number; right: number; bottom: number } | null) {
  const gap = 10, margin = 8, size = cat.offsetWidth, left = cat.offsetLeft, top = cat.offsetTop;
  panel.style.maxHeight = "";
  const w = panel.offsetWidth, roomLeft = left - gap - margin, roomRight = width - (left + size) - gap - margin;
  // Too narrow on both sides (a phone): below the cat in the upper half of the area, above it in the lower half.
  const side = w <= roomLeft ? "left" : w <= roomRight ? "right" : top + size / 2 < bottom / 2 ? "below" : "above";
  const x = side === "left" ? left - gap - w : side === "right" ? left + size + gap : Math.min(Math.max(margin, left + size - w), Math.max(margin, width - w - margin));
  const floor = keepOff && x < keepOff.right && x + w > keepOff.left ? keepOff.bottom + 6 : margin;
  let y: number;
  if (side === "below") { y = top + size + gap; panel.style.maxHeight = `${Math.max(120, bottom - y - margin)}px`; }
  else if (side === "above") { panel.style.maxHeight = `${Math.max(120, top - gap - floor)}px`; y = Math.max(floor, top - gap - panel.offsetHeight); }
  else { panel.style.maxHeight = `${Math.max(120, bottom - floor - margin)}px`; y = Math.min(Math.max(floor, top + 6), Math.max(floor, bottom - panel.offsetHeight - margin)); }
  panel.style.left = `${x}px`; panel.style.top = `${y}px`; panel.dataset.side = side;
  // The tail points at the cat's middle, wherever the box ended up.
  const across = side === "below" || side === "above";
  panel.style.setProperty("--npc-tail", across ? `${Math.min(w - 18, Math.max(18, left + size / 2 - x))}px` : `${Math.min(panel.offsetHeight - 18, Math.max(18, top + size / 2 - y))}px`);
}
