import { useState } from "react";
import { Popover } from "radix-ui";
import { TriangleAlertIcon } from "lucide-react";
import { t } from "../i18n";

/** The warning beside Bot info's context figure after a failed request was dropped (fish m1270, m1287): the
 * explanation opens on hover, and on a tap where there is no hover. `title=""` keeps the row's own hint from showing on top. */
export function ContextStale() {
  const [open, setOpen] = useState(false);
  const hover = (on: boolean) => (event: React.PointerEvent) => { if (event.pointerType === "mouse") setOpen(on); };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="jv-context-stale" title="" aria-label={t("bot.contextStale")} onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
      <TriangleAlertIcon aria-hidden="true"/>
    </Popover.Trigger>
    <Popover.Portal><Popover.Content className="jv-context-tip jv-ui" side="top" align="end" sideOffset={6} collisionPadding={12}
      onOpenAutoFocus={event => event.preventDefault()}>{t("bot.contextStale")}</Popover.Content></Popover.Portal>
  </Popover.Root>;
}
