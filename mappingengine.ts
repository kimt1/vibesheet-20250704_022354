// --- Type Definitions for context ---
type Selector = string;
type ColumnName = string;
type Mapping = Record<Selector, ColumnName>;
type RowData = Record<ColumnName, string>;
type SelectorValueMap = Record<Selector, string>;

// A richer object for more effective auto-mapping
interface FieldInfo {
	selector: string;
	label?: string; // The human-readable label for the field
	name?: string; // The name attribute
}

const MEMORY_STORE: { [key: string]: string } = {};

/**
 * Try to obtain storage object (browser or fallback to in-memory).
 */
function getSyncStorage() {
	// Chrome / MV3
	if (typeof chrome !== 'undefined' && chrome.storage?.local) {
		// Use the native promise-based API for chrome.storage.local
		return {
			get: async (k: string): Promise<string | undefined> => {
				const res = await chrome.storage.local.get(k);
				return res[k];
			},
			set: (k: string, v: string): Promise<void> => {
				return chrome.storage.local.set({ [k]: v });
			},
		};
	}

	// LocalStorage (browser / JSDOM)
	if (typeof localStorage !== 'undefined') {
		return {
			get: async (k: string) => localStorage.getItem(k) ?? undefined,
			set: async (k: string, v: string) => localStorage.setItem(k, v),
		};
	}

	// Fallback: in-memory
	return {
		get: async (k: string) => MEMORY_STORE[k],
		set: async (k: string, v: string) => {
			MEMORY_STORE[k] = v;
		},
	};
}

const storage = getSyncStorage();

//--------------------------------------------------------------
// Core
//--------------------------------------------------------------

export function generateMapping(fields: FieldInfo[], columns: ColumnName[]): Mapping {
    if (fields.length !== columns.length) {
        throw new Error(
          `generateMapping: Mismatched lengths between fields (${fields.length}) and columns (${columns.length}).`
        );
    }
	const mapping: Mapping = {};
	for (let i = 0; i < fields.length; i++) {
		mapping[fields[i].selector] = columns[i];
	}
	return mapping;
}

export function validateMapping(mapping: Mapping): boolean {
	if (!mapping || typeof mapping !== 'object') return false;
	const selectors = Object.keys(mapping);
	const columns = Object.values(mapping);
	if (selectors.length === 0) return true; // Empty mapping is valid
	if (selectors.some((s) => typeof s !== 'string' || !s.trim())) return false;
	if (columns.some((c) => typeof c !== 'string' || !c.trim())) return false;
	// Ensure selectors are unique, but columns can be duplicated
	return new Set(selectors).size === selectors.length;
}

// Type guard for safer parsing from storage.
function isMapping(obj: unknown): obj is Mapping {
	return (
		obj !== null &&
		typeof obj === 'object' &&
		!Array.isArray(obj) &&
		Object.entries(obj).every(
			([k, v]) => typeof k === 'string' && typeof v === 'string'
		)
	);
}

export async function saveMapping(id: string, mapping: Mapping): Promise<void> {
	if (!validateMapping(mapping)) {
		throw new Error('Invalid mapping; save aborted.');
	}
	const serialized = JSON.stringify(mapping);
	await storage.set(`mapping:${id}`, serialized);
}

export async function loadMapping(id: string): Promise<Mapping | null> {
	const raw = await storage.get(`mapping:${id}`);
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		// Use the type guard for a safe cast.
		if (isMapping(parsed)) return parsed;
	} catch {
		/* swallow json parse errors */
	}
	return null;
}

export function applyMapping(mapping: Mapping, rowData: RowData): SelectorValueMap {
	const result: SelectorValueMap = {};
	for (const [selector, column] of Object.entries(mapping)) {
		if (Object.prototype.hasOwnProperty.call(rowData, column)) {
			result[selector] = rowData[column];
		}
	}
	return result;
}

//--------------------------------------------------------------
// Auto-mapping heuristics
//--------------------------------------------------------------

function tokenize(str: string): string[] {
	return str
		.replace(/[^a-z0-9\s-]/gi, '') // Allow hyphens
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean);
}

function jaccard(a: Set<string>, b: Set<string>): number {
	const union = new Set([...a, ...b]);
    if (union.size === 0) return 0;
	const intersection = new Set([...a].filter((x) => b.has(x)));
	return intersection.size / union.size;
}

/**
 * Attempt to infer mapping between form fields and sheet headers.
 */
export function autoMap(fields: FieldInfo[], headers: ColumnName[]): Mapping {
	const mapping: Mapping = {};
	const usedHeaders = new Set<string>();
	const headerTokens = headers.map((h) => new Set(tokenize(h)));

	for (const field of fields) {
		let bestIdx = -1;
		let bestScore = 0;
		// Create a meaningful set of tokens from the field's label or name.
		const fieldText = field.label || field.name || '';
		if (!fieldText) continue;
		const fieldTokens = new Set(tokenize(fieldText));

		for (let i = 0; i < headers.length; i++) {
			if (usedHeaders.has(headers[i])) continue;

			const score = jaccard(fieldTokens, headerTokens[i]);
			if (score > bestScore) {
				bestScore = score;
				bestIdx = i;
			}
		}

		// Use a threshold to avoid weak matches
		if (bestIdx !== -1 && bestScore >= 0.2) {
			mapping[field.selector] = headers[bestIdx];
			usedHeaders.add(headers[bestIdx]);
		}
	}

	return mapping;
}