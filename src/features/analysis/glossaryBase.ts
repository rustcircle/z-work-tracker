// Glossary entry type and builder, shared by the glossary files. Every figure on the screen has an
// entry with its plain definition, its formula and whether it uses Exact or Billable time.
export type GlossaryBasis = 'Exact' | 'Billable' | 'Follows the Basis switch' | 'Neither';

export interface GlossaryEntry {
  id: string;
  name: string;
  family: string;
  basis: GlossaryBasis;
  definition: string;
  formula: string;
}

export const g = (id: string, name: string, family: string, basis: GlossaryBasis, definition: string, formula: string): GlossaryEntry => ({ id, name, family, basis, definition, formula });
