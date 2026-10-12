import * as React from "react"
import { Select as SelectPrimitive } from "radix-ui"
import { CheckIcon, ChevronDownIcon } from "lucide-react"
import { cn } from "cn"

const Select = SelectPrimitive.Root
const SelectValue = SelectPrimitive.Value
const SelectGroup = SelectPrimitive.Group
function SelectTrigger({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return <SelectPrimitive.Trigger data-slot="select-trigger" className={cn("flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50", className)} {...props}>
    {children}<SelectPrimitive.Icon asChild><ChevronDownIcon className="size-4 opacity-50"/></SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
}
/** `container`: where the menu is portalled; inside a modal <dialog> it must be the dialog, or the menu is inert. */
function SelectContent({ className, children, container, ...props }: React.ComponentProps<typeof SelectPrimitive.Content> & { container?: HTMLElement | null }) {
  return <SelectPrimitive.Portal container={container ?? undefined}><SelectPrimitive.Content data-slot="select-content" position="popper" sideOffset={5} className={cn("z-[100] max-h-[min(300px,70dvh)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border bg-popover bg-background p-1 text-foreground shadow-md", className)} {...props}>
    <SelectPrimitive.Viewport>{children}</SelectPrimitive.Viewport>
  </SelectPrimitive.Content></SelectPrimitive.Portal>
}
function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return <SelectPrimitive.Item data-slot="select-item" className={cn("relative flex cursor-default items-center rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:opacity-50", className)} {...props}>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    <SelectPrimitive.ItemIndicator data-slot="select-indicator" className="absolute right-2"><CheckIcon className="size-4"/></SelectPrimitive.ItemIndicator>
  </SelectPrimitive.Item>
}
function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) { return <SelectPrimitive.Label className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)} {...props}/> }
function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) { return <SelectPrimitive.Separator className={cn("my-1 h-px bg-border", className)} {...props}/> }
export { Select, SelectValue, SelectGroup, SelectTrigger, SelectContent, SelectItem, SelectLabel, SelectSeparator }
