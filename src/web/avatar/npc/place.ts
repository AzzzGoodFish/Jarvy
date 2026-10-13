/** Puts the NPC dialogue beside the cat: on the side with room (left first, as the cat starts top right), else below or
 * above it. It stays inside the chat area, above the composer (`bottom`), clear of the cat's drag row (`clear`, a strip
 * at the top) and under `keepOff` (the toolbar) when it would cross it — all relative to the area.
 *
 * A collapsed dialogue (`data-fit`, set by NpcLayer) takes the room on its side and keeps it, so the text growing never
 * moves it; a panel keeps its own width. The side is kept while it has room (or the other side has more than `slack`
 * more), so a box that grows across the threshold does not flip back and forth. The tail always points at the cat. */
export function placeBeside(panel: HTMLElement, cat: HTMLElement, width: number, bottom: number,
  keepOff: { left: number; right: number; bottom: number } | null, clear = 0) {
  const gap = 10, margin = 8, size = cat.offsetWidth, left = cat.offsetLeft, top = cat.offsetTop, slack = 40;
  panel.style.maxHeight = "";
  const roomLeft = left - gap - margin, roomRight = width - (left + size) - gap - margin;
  // A collapsed dialogue has no width of its own (`fit` in NpcLayer): it takes the room on its side and keeps it, so
  // nothing moves while the text grows. A panel keeps its width and only takes a side.
  const loose = panel.hasAttribute("data-fit");
  const w = loose ? Math.max(160, panel.dataset.side === "left" ? roomLeft : panel.dataset.side === "right" ? roomRight : Math.min(320, width - 2 * margin)) : panel.offsetWidth;
  const was = panel.dataset.side;
  const fits = (side: string) => side === "left" ? w <= roomLeft : side === "right" ? w <= roomRight : w <= width - 2 * margin;
  // Too narrow on both sides (a phone): below the cat in the upper half of the area, above it in the lower half.
  const natural = w <= roomLeft ? "left" : w <= roomRight ? "right" : top + size / 2 < bottom / 2 ? "below" : "above";
  // Keep the side already taken while it still has room (or the other one has more than `slack` more).
  const room = (side: string) => side === "left" ? roomLeft : side === "right" ? roomRight : width - 2 * margin;
  const keep = was && fits(was) && (was === natural || room(was) + slack >= room(natural));
  const side = keep ? was! : natural;
  if (loose) { const taken = side === "left" ? roomLeft : side === "right" ? roomRight : Math.min(320, width - 2 * margin); panel.style.width = `${Math.min(300, Math.max(160, taken))}px`; }
  const x = side === "left" ? left - gap - w : side === "right" ? left + size + gap : Math.min(Math.max(margin, left + size - w), Math.max(margin, width - w - margin));
  // The minimum top: under the strip the cat is dragged in, under the toolbar when the box crosses it, and never so low
  // that the box would reach the composer (`clear` is the strip's height, and it is the floor only while it leaves room).
  const strip = Math.min(clear + margin, Math.max(margin, bottom - 200));
  const floor = Math.min(Math.max(strip, keepOff && x < keepOff.right && x + w > keepOff.left ? keepOff.bottom + 6 : 0), Math.max(margin, bottom - 140));
  let y: number;
  // Below the cat, but never past the composer (a short box then sits further up, still clear of the cat).
  if (side === "below") { y = Math.min(top + size + gap, bottom - margin - Math.min(panel.offsetHeight, Math.max(120, bottom - top - size - gap - margin))); panel.style.maxHeight = `${Math.max(120, bottom - y - margin)}px`; }
  else if (side === "above") { panel.style.maxHeight = `${Math.max(120, top - gap - floor)}px`; y = Math.max(floor, top - gap - panel.offsetHeight); }
  else { panel.style.maxHeight = `${Math.max(120, bottom - floor - margin)}px`; y = Math.min(Math.max(floor, top + 6), Math.max(floor, bottom - panel.offsetHeight - margin)); }
  panel.style.left = `${x}px`; panel.style.top = `${y}px`; panel.dataset.side = side;
  // The tail points at the cat's middle, wherever the box ended up.
  const across = side === "below" || side === "above";
  panel.style.setProperty("--npc-tail", across ? `${Math.min(w - 18, Math.max(18, left + size / 2 - x))}px` : `${Math.min(panel.offsetHeight - 18, Math.max(18, top + size / 2 - y))}px`);
}
