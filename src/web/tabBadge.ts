import { useEffect } from "react";

/** The tab shows how many messages were delivered to you and are unread (A41), like mail and chat apps:
 * a red count on the icon and "(N)" before the title. Only the interrupt kind counts; hints do not. */
const TITLE = "Jarvy";
let original: string | null = null;
let icon: HTMLImageElement | null = null, svg: HTMLLinkElement | null = null;

function iconLink(): HTMLLinkElement | null { return document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/png"]'); }
function draw(count: number): string | null {
  if (!icon?.complete || !icon.naturalWidth) return null;
  const size = 64, canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(icon, 0, 0, size, size);
  const label = count > 9 ? "9+" : String(count), radius = label.length > 1 ? 21 : 18;
  context.fillStyle = "#e5484d";
  context.beginPath(); context.arc(size - radius, radius, radius, 0, Math.PI * 2); context.fill();
  context.fillStyle = "#fff"; context.font = `bold ${label.length > 1 ? 26 : 30}px system-ui, sans-serif`;
  context.textAlign = "center"; context.textBaseline = "middle";
  context.fillText(label, size - radius, radius + 2);
  return canvas.toDataURL("image/png");
}
function apply(count: number): void {
  document.title = count > 0 ? `(${count > 99 ? "99+" : count}) ${TITLE}` : TITLE;
  const link = iconLink();
  if (!link) return;
  original ??= link.href;
  // Browsers prefer the SVG icon, so it steps aside while the badged PNG is shown.
  svg ??= document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (count <= 0) { link.href = original; if (svg && !svg.isConnected) document.head.prepend(svg); return; }
  const badged = draw(count);
  if (!badged) return;
  link.href = badged;
  svg?.remove();
}
export function useTabBadge(count: number): void {
  useEffect(() => {
    if (!icon) {
      icon = new Image();
      icon.src = "/favicon.svg"; // drawn from the vector icon, so the badged one stays sharp
    }
    if (icon.complete) apply(count);
    else icon.onload = () => apply(count);
  }, [count]);
}
