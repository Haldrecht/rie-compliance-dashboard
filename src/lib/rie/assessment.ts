// Turns the RI&E wizard payload into Risk rows that match the database enums.

export type DbRiskCategory =
  | 'PHYSICAL_WORKSPACE'
  | 'CHEMICAL_BIOLOGICAL'
  | 'PSYCHOSOCIAL'
  | 'PHYSICAL_STRAIN'
  | 'SAFETY_RISKS'
  | 'ENVIRONMENTAL';

export type DbRiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

const DB_CATEGORIES: readonly DbRiskCategory[] = [
  'PHYSICAL_WORKSPACE',
  'CHEMICAL_BIOLOGICAL',
  'PSYCHOSOCIAL',
  'PHYSICAL_STRAIN',
  'SAFETY_RISKS',
  'ENVIRONMENTAL',
];

// Wizard categories (src/app/rie/new/page.tsx RISK_CATEGORIES) -> database enum. This is the inverse
// of the wizard's own template mapping, so a template round-trips to its original category.
const WIZARD_TO_DB: Record<string, DbRiskCategory> = {
  PHYSICAL: 'PHYSICAL_WORKSPACE',
  CHEMICAL: 'CHEMICAL_BIOLOGICAL',
  BIOLOGICAL: 'CHEMICAL_BIOLOGICAL',
  ERGONOMIC: 'PHYSICAL_STRAIN',
  PSYCHOSOCIAL: 'PSYCHOSOCIAL',
  ORGANIZATIONAL: 'ENVIRONMENTAL',
};

export function toDbCategory(category: string | undefined | null): DbRiskCategory {
  if (!category) return 'PHYSICAL_WORKSPACE';
  if ((DB_CATEGORIES as readonly string[]).includes(category)) return category as DbRiskCategory;
  return WIZARD_TO_DB[category] ?? 'PHYSICAL_WORKSPACE';
}

function scale(value: unknown): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 1;
}

/** Score = probability x severity on 1..5 scales (max 25). */
export function riskLevelFor(score: number): DbRiskLevel {
  if (score >= 16) return 'CRITICAL';
  if (score >= 10) return 'HIGH';
  if (score >= 5) return 'MEDIUM';
  return 'LOW';
}

interface WizardRisk {
  category?: string;
  title?: string;
  description?: string;
  location?: string;
  probability?: number;
  severity?: number;
  currentMeasures?: unknown;
}

interface WizardPayload {
  company?: { companyName?: string };
  goalAndScope?: { goals?: string[] };
  workAreas?: Array<{ name?: string; risks?: WizardRisk[] }>;
}

export interface RiskRow {
  category: DbRiskCategory;
  title: string;
  description: string;
  location: string;
  probability: number;
  impact: number;
  riskLevel: DbRiskLevel;
  currentMeasures: unknown;
}

export const MAX_RISKS_PER_ASSESSMENT = 500;

export function validateWizardPayload(rieData: unknown): string | null {
  const data = rieData as WizardPayload | null;
  if (!data || typeof data !== 'object') return 'rieData ontbreekt';
  if (!data.company?.companyName) return 'Bedrijfsnaam ontbreekt in de RI&E';
  if (!data.goalAndScope) return 'Doel en reikwijdte ontbreken';
  if (!Array.isArray(data.workAreas)) return 'Werkplekken ontbreken';
  const count = data.workAreas.reduce((n, area) => n + (Array.isArray(area?.risks) ? area.risks.length : 0), 0);
  if (count > MAX_RISKS_PER_ASSESSMENT) return `Maximaal ${MAX_RISKS_PER_ASSESSMENT} risico's per RI&E`;
  return null;
}

export function riskRowsFromWizard(rieData: WizardPayload): RiskRow[] {
  const rows: RiskRow[] = [];
  for (const area of rieData.workAreas ?? []) {
    for (const risk of area.risks ?? []) {
      const probability = scale(risk.probability);
      const impact = scale(risk.severity);
      rows.push({
        category: toDbCategory(risk.category),
        title: (risk.title || risk.description || 'Onbekend risico').slice(0, 300),
        description: risk.description || '',
        location: risk.location || area.name || '',
        probability,
        impact,
        // Recomputed server-side: a client-supplied score is not trusted.
        riskLevel: riskLevelFor(probability * impact),
        currentMeasures: risk.currentMeasures ?? null,
      });
    }
  }
  return rows;
}
