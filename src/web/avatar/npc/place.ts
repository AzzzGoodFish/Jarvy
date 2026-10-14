type Side = "left" | "right" | "below" | "above";

/** Puts the NPC dialogue next to the cat: on the side the cat faces when it fits there (`facing`: +1 the cat turns
 * right, −1 left, 0 straight at you — then the roomier side), else on the other side, else below or above the cat,
 * whichever has more room (a phone). It stays inside the chat area, above the composer (`bottom`) and under `keepOff`
 * (the demo toolbar) when it would cross it — all relative to the area.
 *
 * A collapsed dialogue (`data-fit`, set by NpcLayer) is as wide as its text, up to the room on its side and to `cap`
 * (40% of the chat, at least 300 px; fish m800). It hangs from the edge next to the cat, so a short line sits by the cat
 * and longer text grows away from it; that edge, and the side, stay put while the text streams. A panel keeps its own
 * width. The side taken is kept while it fits and the other one is not `slack` roomier, so the box does not flip back
 * and forth while the cat sits near the middle. The tail points at the cat. */
export function placeBeside(panel: HTMLElement, cat: HTMLElement, width: number, bottom: number,
  keepOff: { left: number; right: number; bottom: number } | null, facing = 0) {
  const gap = 10, margin = 8, slack = 40, size = cat.offsetWidth, left = cat.offsetLeft, top = cat.offsetTop;
  const cap = Math.max(300, Math.round(width * 0.4));
  panel.style.maxHeight = "";
  const loose = panel.hasAttribute("data-fit"), height = panel.offsetHeight;
  const beside = (side: Side) => side === "left" || side === "right";
  const room = (side: Side) => side === "left" ? left - gap - margin : side === "right" ? width - left - size - gap - margin
    : side === "below" ? bottom - top - size - gap - margin : top - gap - margin;
  // Below or above the cat, a collapsed box hangs from the cat's edge nearer the side of the chat it is on.
  const outward = left + size / 2 > width / 2;
  // How wide a box may get on a side: a collapsed one up to the cap within the room there, a panel its own width.
  const wide = (side: Side) => !loose ? panel.offsetWidth : beside(side) ? Math.min(cap, Math.max(160, room(side)))
    : Math.min(cap, outward ? left + size - margin : width - left - margin);
  const fits = (side: Side) => beside(side) ? wide(side) <= room(side) : Math.min(120, height) <= room(side);
  const wanted: Side | null = facing > 0.05 ? "right" : facing < -0.05 ? "left" : null;
  const order: Side[] = wanted === "left" || (wanted === null && room("left") >= room("right")) ? ["left", "right"] : ["right", "left"];
  const natural = order.find(fits) ?? (room("below") >= room("above") ? "below" : "above");
  const was = panel.dataset.side as Side | undefined;
  const keep = was !== undefined && was !== natural && beside(was) === beside(natural) && fits(was) && room(was) + slack >= room(natural);
  const side = keep ? was : natural;
  // A collapsed box hangs from the edge next to the cat (its right edge when it is on the cat's left); a panel is placed
  // by its left edge, inside the chat.
  const fromRight = loose && (side === "left" || (!beside(side) && outward));
  const anchor = side === "left" ? left - gap : side === "right" ? left + size + gap : outward ? left + size : left;
  // Hung before it is measured: how wide a collapsed box comes out depends on where it hangs.
  panel.style.width = ""; panel.style.maxWidth = loose ? `${wide(side)}px` : "";
  if (fromRight) { panel.style.left = ""; panel.style.right = `${width - anchor}px`; } else { panel.style.right = ""; if (loose) panel.style.left = `${anchor}px`; }
  const w = panel.offsetWidth;
  const x = loose ? (fromRight ? anchor - w : anchor) : side === "left" ? left - gap - w : side === "right" ? left + size + gap
    : Math.min(Math.max(margin, left + size - w), Math.max(margin, width - w - margin));
  // The highest the box goes: under the toolbar when it would cross it, but never so low that it reaches the composer.
  const under = keepOff && x < keepOff.right && x + w > keepOff.left ? keepOff.bottom + 6 : 0;
  const floor = Math.min(Math.max(margin, under), Math.max(margin, bottom - 140));
  let y: number;
  // Below the cat; on a screen too short for that, up against the composer.
  if (side === "below") { y = Math.max(margin, Math.min(top + size + gap, bottom - margin - Math.min(height, 120))); panel.style.maxHeight = `${Math.max(40, bottom - y - margin)}px`; }
  else if (side === "above") { panel.style.maxHeight = `${Math.max(40, top - gap - floor)}px`; y = Math.max(floor, top - gap - panel.offsetHeight); }
  // Beside the cat, level with its head, moved up only as far as the composer needs.
  else { panel.style.maxHeight = `${Math.max(120, bottom - floor - margin)}px`; y = Math.min(Math.max(floor, top + 6), Math.max(floor, bottom - panel.offsetHeight - margin)); }
  if (!loose) panel.style.left = `${x}px`;
  panel.style.top = `${y}px`; panel.dataset.side = side;
  // The tail points at the cat's middle, wherever the box ended up.
  panel.style.setProperty("--npc-tail", beside(side) ? `${Math.min(panel.offsetHeight - 18, Math.max(18, top + size / 2 - y))}px` : `${Math.min(w - 18, Math.max(18, left + size / 2 - x))}px`);
}
