import { useState } from "react";
import type { Section } from "../api";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";

/** A channel's group, picked from the app's own menu rather than the browser's native list (which ignores the theme). */
export function SectionSelect({ id, value, sections, onChange }: { id: string; value: string | null; sections: Section[]; onChange: (sectionId: string | null) => void }) {
  // In the new-channel dialog (a modal <dialog>) the menu has to open inside it.
  const [dialog, setDialog] = useState<HTMLElement | null>(null);
  return <Select value={value ?? "none"} onValueChange={next => onChange(next === "none" ? null : next)}>
    <SelectTrigger id={id} ref={element => setDialog(element?.closest("dialog") ?? null)} className="jv-select jv-section-select"><SelectValue/></SelectTrigger>
    <SelectContent className="jv-select-menu" position="popper" sideOffset={4} container={dialog}>
      <SelectItem value="none">无</SelectItem>
      {sections.map(section => <SelectItem key={section.id} value={section.id}>{section.name}</SelectItem>)}
    </SelectContent>
  </Select>;
}
