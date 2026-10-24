import { BookOpenText, Code2, Compass, Lightbulb, Rocket, type LucideIcon } from 'lucide-react';
import type { Section } from '../lib/docs';

/** One icon per docs section, used in the sidebar, the cards and the page header. */
export const SECTION_ICON: Record<Section, LucideIcon> = {
  'getting-started': Rocket,
  guides: Compass,
  'staff-guide': BookOpenText,
  concepts: Lightbulb,
  'channel-api': Code2,
};
