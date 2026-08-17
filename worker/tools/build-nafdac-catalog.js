#!/usr/bin/env node
// Builds worker/migrations/0002_nafdac_catalog.sql from the NAFDAC Greenbook
// JSON export.
//
//   node tools/build-nafdac-catalog.js path/to/greenbook.json
//
// WHY A MIGRATION AND NOT A SEED:
// The catalog is REFERENCE DATA, not demo data. Seeds are optional and are
// deliberately skipped on real client deployments (see DEPLOY-NEW-REPO-CLOUDFLARE-WINDOWS.md
// step 8); this catalog must exist on EVERY deployment, so it ships as schema.
//
// WHAT THIS IS AND IS NOT:
//  - IS:  a read-only lookup of NAFDAC-registered products so a pharmacy can
//         PICK a drug instead of typing it, and so the app can surface
//         therapeutic alternatives sharing the same active ingredient.
//  - NOT: the pharmacy's inventory. Selecting a catalog row COPIES fields into
//         a normal `products` row that the client then owns and can edit. A
//         product that is not in the catalog is still added manually — that is
//         a first-class supported path, not a fallback.
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
if (!SRC) {
  console.error('usage: node tools/build-nafdac-catalog.js <greenbook.json>');
  process.exit(1);
}

const OUT = path.join(__dirname, '..', 'migrations', '0002_nafdac_catalog.sql');

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

// The Greenbook export is a working editorial database, and its product_name
// field carries the reviewers' own internal markers. Measured across the 9,022
// source rows:
//
//   "AG Spironolactone##"                        4,188  reviewer "checked" flag
//   "Zinnat 250 mg Tablets**"                    2,646  second-pass flag
//   "*Aspee Surgicare IV Cannula"                  896  leading flag (medical devices)
//   "Zef One Injection# (check pack size)"         418  flag + reviewer note
//   "Diapride 2 Tablets (duplicate, ...)"          299  bare reviewer note
//   "Surgibond Tissue Adhesive 0.5 g/mL*#"          21  combined markers
//   "Mororate Cream_ (check strength)"              13  underscore + note
//   "Teka Artemether## $"                                stray trailing symbol
//
// None of this is part of the registered product name. A pharmacist searching
// for "Zinnat" must not be shown "Zinnat 250 mg Tablets**", so every marker is
// stripped. Order matters: notes are removed before the symbols that introduce
// them, and leading flags last so a name never starts with punctuation.
// Rather than chase an ever-growing keyword list ("duplicate", "check pack
// size", "incomplete SMPC", "no applicant name", "incorrect Mfr country?"...),
// the rule is structural: a marker glyph (*, #, _) immediately followed by a
// trailing parenthetical IS a reviewer note, whatever it says. That is a
// property of the export's format, not of any particular wording, so it does
// not silently rot when NAFDAC's reviewers invent a new phrase.
//
// A bare trailing "(duplicate ...)" with no marker glyph is also caught, but
// only for that closed vocabulary — an unguarded rule there would eat
// legitimate names like "Zedex Cold (Sugar Free)".
const MARKED_NOTE = /[*#_]+\s*\([^)]*\)?\s*$/;      // glyph + note (possibly unclosed)
const BARE_NOTE = /\s*\((?:duplicate|check|updates?\s+needed|pending|incomplete|incorrect)\b[^)]*\)\s*$/i;

function cleanName(raw) {
  let s = decodeEntities(String(raw || ''));

  // Applied repeatedly: a few rows stack two notes.
  let prev;
  do {
    prev = s;
    s = s.replace(MARKED_NOTE, '');
    s = s.replace(BARE_NOTE, '');
    s = s.replace(/##[\s\S]*$/, '');   // "## free-text note" with no parentheses
    s = s.replace(/[\s*#_$]+$/, '');   // trailing marker glyphs / stray symbols
  } while (s !== prev);

  // Leading marker glyphs (896 rows, almost all medical devices).
  s = s.replace(/^[\s*#_]+/, '');

  return collapse(s);
}

// pack_size is full of HTML entities from the source CMS (4,775 rows):
//   "1 x 500&#039;s (in a jar)" -> "1 x 500's (in a jar)"
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Clinical classification
// ---------------------------------------------------------------------------

// Controlled substances under Nigeria's NDLEA/PCN control regime. Matched on
// the ACTIVE INGREDIENT, never the brand name, so both "Emzolyn with Codeine"
// and a generic "Codeine Linctus" are caught.
//
// This drives the POS's controlled-drug register (buyer-ID capture and the
// tamper-evident hash chain), so a false negative here is a regulatory
// failure, not a cosmetic one.
const CONTROLLED = [
  'codeine', 'tramadol', 'morphine', 'pentazocine', 'pethidine', 'fentanyl',
  'methadone', 'oxycodone', 'hydrocodone', 'buprenorphine', 'dihydrocodeine',
  'diazepam', 'nitrazepam', 'flunitrazepam', 'alprazolam', 'lorazepam',
  'midazolam', 'clonazepam', 'bromazepam', 'chlordiazepoxide', 'temazepam',
  'phenobarb', 'barbital', 'amobarbital', 'secobarbital',
  'amphetamine', 'methylphenidate', 'ephedrine', 'pseudoephedrine',
  'ketamine', 'nalbuphine', 'tapentadol', 'zolpidem', 'carisoprodol',
];

// Prescription-only signals. Deliberately broad: over-classifying as POM is a
// SAFE failure (the cashier is prompted for prescriber details), while
// under-classifying is a compliance breach.
const POM_INGREDIENTS = [
  'cillin', 'cycline', 'floxacin', 'mycin', 'cephalexin', 'cefu', 'ceftri',
  'cefix', 'cefpod', 'ceftaz', 'cefaclor', 'meropenem', 'imipenem', 'vancomycin',
  'linezolid', 'clindamycin', 'metronidazole', 'nitrofurantoin', 'rifampicin',
  'isoniazid', 'ethambutol', 'pyrazinamide', 'dapsone', 'chloramphenicol',
  'sulfamethoxazole', 'trimethoprim', 'gentamicin', 'amikacin', 'streptomycin',
  'lamivudine', 'zidovudine', 'tenofovir', 'efavirenz', 'nevirapine',
  'dolutegravir', 'ritonavir', 'atazanavir', 'lopinavir', 'abacavir',
  'aciclovir', 'acyclovir', 'oseltamivir', 'artesunate',
  'amlodipine', 'lisinopril', 'enalapril', 'ramipril', 'perindopril',
  'losartan', 'valsartan', 'telmisartan', 'candesartan', 'irbesartan',
  'atenolol', 'bisoprolol', 'propranolol', 'carvedilol', 'labetalol',
  'nifedipine', 'verapamil', 'diltiazem', 'hydrochlorothiazide', 'furosemide',
  'spironolactone', 'bendroflu', 'methyldopa', 'clonidine', 'digoxin',
  'warfarin', 'clopidogrel', 'heparin', 'enoxaparin', 'rivaroxaban',
  'atorvastatin', 'simvastatin', 'rosuvastatin', 'pravastatin',
  'insulin', 'metformin', 'glimepiride', 'gliclazide', 'glibenclamide',
  'sitagliptin', 'linagliptin', 'pioglitazone', 'levothyroxine', 'carbimazole',
  'amitriptyline', 'fluoxetine', 'sertraline', 'escitalopram', 'citalopram',
  'paroxetine', 'venlafaxine', 'olanzapine', 'risperidone', 'quetiapine',
  'haloperidol', 'chlorpromazine', 'clozapine', 'trifluoperazine', 'lithium',
  'carbamazepine', 'valproate', 'valproic', 'phenytoin', 'levetiracetam',
  'lamotrigine', 'gabapentin', 'pregabalin',
  'prednisolone', 'prednisone', 'dexamethasone', 'hydrocortisone',
  'betamethasone', 'methylprednisolone', 'triamcinolone', 'fluticasone',
  'tamoxifen', 'anastrozole', 'methotrexate', 'cyclophosphamide',
  'cisplatin', 'doxorubicin', 'paclitaxel', 'docetaxel', 'cabazitaxel',
  'ethinylestradiol', 'levonorgestrel', 'medroxyprogesterone',
  'salbutamol', 'ipratropium', 'montelukast', 'theophylline',
  'omeprazole', 'esomeprazole', 'pantoprazole', 'rabeprazole',
  'sildenafil', 'tadalafil', 'finasteride', 'tamsulosin',
  'propofol', 'lidocaine', 'bupivacaine', 'atropine', 'adrenaline',
  'epinephrine', 'noradrenaline', 'oxytocin', 'misoprostol',
];

// Forms that are inherently prescription-only regardless of ingredient — no
// pharmacy hands out an IV infusion over the counter.
const POM_FORMS = [
  'injection', 'infusion', 'implant', 'inhaler', 'inhalation', 'intravenous',
];

const isControlled = (ing) => CONTROLLED.some((k) => ing.includes(k));

function isPom(ingredient, form, category) {
  if (isControlled(ingredient)) return true;
  const f = form.toLowerCase();
  if (POM_FORMS.some((k) => f.includes(k))) return true;
  if (POM_INGREDIENTS.some((k) => ingredient.includes(k))) return true;
  if (/vaccin|biolog/i.test(category)) return true;
  return false;
}

// Maps a NAFDAC dosage form to the unit a pharmacy actually counts stock in,
// pre-filling products.base_unit so the client rarely has to think about it.
function baseUnitFor(form, description) {
  const f = `${form} ${description}`.toLowerCase();
  if (/tablet|caplet|soflet/.test(f)) return 'tablet';
  if (/capsule/.test(f)) return 'capsule';
  if (/inject|vial|ampoule/.test(f)) return 'vial';
  if (/suppositor|pessar/.test(f)) return 'suppository';
  if (/inhaler|aerosol/.test(f)) return 'inhaler';
  if (/patch/.test(f)) return 'patch';
  if (/cream|ointment|gel|lotion|balm|paste/.test(f)) return 'tube';
  if (/sachet|granule|powder/.test(f)) return 'sachet';
  if (/syrup|suspension|solution|liquid|elixir|linctus|emulsion|drop|infusion/.test(f)) return 'bottle';
  return 'unit';
}

// Human-facing therapeutic group. The first letter of a WHO ATC code is the
// anatomical main group, which is a far better shelf category than the
// Greenbook's own four-way split.
const ATC_GROUP = {
  A: 'Alimentary & Metabolism', B: 'Blood & Blood Forming',
  C: 'Cardiovascular', D: 'Dermatological',
  G: 'Genito-urinary & Sex Hormones', H: 'Systemic Hormones',
  J: 'Anti-infectives (Systemic)', L: 'Antineoplastic & Immunomodulating',
  M: 'Musculoskeletal', N: 'Nervous System',
  P: 'Antiparasitic', R: 'Respiratory',
  S: 'Sensory Organs', V: 'Various',
};

function therapeuticCategory(atc, category) {
  if (atc && ATC_GROUP[String(atc)[0].toUpperCase()]) return ATC_GROUP[String(atc)[0].toUpperCase()];
  if (/medical device/i.test(category)) return 'Medical Device';
  if (/vaccin|biolog/i.test(category)) return 'Vaccines & Biologics';
  if (/herbal|nutraceutical/i.test(category)) return 'Herbal & Nutraceutical';
  if (/veterinary/i.test(category)) return 'Veterinary';
  return 'Other';
}

const q = (v) => (v === null || v === undefined || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const raw = JSON.parse(fs.readFileSync(SRC, 'utf8'));
console.log(`[catalog] read ${raw.length} source records`);

const seen = new Set();
const rows = [];
const stats = { skippedInactive: 0, skippedDup: 0, skippedNoName: 0, controlled: 0, pom: 0, otc: 0 };

for (const r of raw) {
  // Only currently-registered products. An expired or withdrawn registration
  // must never be offered to a pharmacist as though it were dispensable.
  if (r.status !== 'Active') { stats.skippedInactive++; continue; }

  const name = cleanName(r.product_name);
  if (!name) { stats.skippedNoName++; continue; }

  const ingredient = collapse(decodeEntities(r.ingredient_name));
  const strength = collapse(decodeEntities(r.strength));
  const form = collapse(r.form_name === 'NA' ? '' : r.form_name);
  const nafdac = collapse(r.NAFDAC);

  // De-duplicate on the identity a pharmacist would call "the same product".
  // NAFDAC numbers legitimately repeat across pack sizes (258 dupes in the
  // source), so the key includes name + strength + form.
  const key = `${name.toLowerCase()}|${strength.toLowerCase()}|${form.toLowerCase()}|${nafdac}`;
  if (seen.has(key)) { stats.skippedDup++; continue; }
  seen.add(key);

  const ingLower = ingredient.toLowerCase();
  const controlled = isControlled(ingLower);
  const pom = isPom(ingLower, form, r.category_name || '');
  if (controlled) stats.controlled++;
  if (pom) stats.pom++; else stats.otc++;

  rows.push({
    nafdac_reg_no: nafdac || null,
    product_name: name,
    ingredient_name: ingredient || null,
    // Normalised ingredient key — powers "other brands with the same active
    // ingredient". Raw-string matching fails on "Amoxicillin/Clavulanic acid"
    // vs "Amoxicillin + Clavulanic Acid"; this collapses both to one key.
    ingredient_key: ingLower.replace(/[^a-z0-9]+/g, ' ').trim() || null,
    strength: strength || null,
    dosage_form: form || null,
    manufacturer: collapse(decodeEntities(r.applicant_name)) || null,
    route: collapse(r.route_name) || null,
    pack_size: collapse(decodeEntities(r.pack_size)) || null,
    atc_code: collapse(r.atc) || null,
    category: therapeuticCategory(r.atc, r.category_name || ''),
    source_category: collapse(r.category_name) || null,
    base_unit: baseUnitFor(form, r.product_description || ''),
    is_controlled: controlled ? 1 : 0,
    dispensing_type: pom ? 'POM' : 'OTC',
    approval_date: r.approval_date || null,
    registration_expiry: r.expiry_date || null,
    // Lowercase haystack so ONE index serves brand-name, generic-name,
    // manufacturer and NAFDAC-number autocomplete.
    search_blob: [name, ingredient, strength, form, nafdac, collapse(r.applicant_name)]
      .filter(Boolean).join(' ').toLowerCase(),
  });
}

console.log('[catalog] kept', rows.length, JSON.stringify(stats));

const COLS = [
  'nafdac_reg_no', 'product_name', 'ingredient_name', 'ingredient_key', 'strength',
  'dosage_form', 'manufacturer', 'route', 'pack_size', 'atc_code', 'category',
  'source_category', 'base_unit', 'is_controlled', 'dispensing_type',
  'approval_date', 'registration_expiry', 'search_blob',
];

const header = `-- =====================================================================
-- MIGRATION 0002 - NAFDAC APPROVED PRODUCT CATALOG (reference data)
-- =====================================================================
--
-- GENERATED FILE - do not edit by hand. Regenerate with:
--     node tools/build-nafdac-catalog.js greenbook.json
--
-- Source: ${raw.length} NAFDAC Greenbook records.
-- Kept:   ${rows.length} currently-ACTIVE, de-duplicated products.
-- Skipped: ${stats.skippedInactive} inactive, ${stats.skippedDup} duplicates, ${stats.skippedNoName} unnamed.
--
-- WHAT THIS TABLE IS
--   A read-only lookup so a pharmacy can SELECT a drug instead of typing it.
--   Picking a row COPIES its fields into a normal \`products\` row, which the
--   client then owns and may edit freely. Nothing here is inventory and
--   nothing here is client data, so it is safe to ship identically to every
--   deployment and to replace wholesale when NAFDAC publishes an update.
--
-- WHY A MIGRATION AND NOT A SEED
--   Seeds are demo data and are deliberately skipped on real client
--   deployments. This catalog must exist everywhere, so it ships as schema.
--
-- CLASSIFICATION
--   is_controlled and dispensing_type are derived from the ACTIVE INGREDIENT
--   (never the brand name), so both "Emzolyn with Codeine" and a generic
--   "Codeine Linctus" are flagged. These PRE-FILL the product form; a manager
--   can always override per product.
--     controlled: ${stats.controlled}   POM: ${stats.pom}   OTC: ${stats.otc}
-- =====================================================================

CREATE TABLE nafdac_catalog (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    nafdac_reg_no       TEXT,
    product_name        TEXT NOT NULL,
    ingredient_name     TEXT,
    ingredient_key      TEXT,           -- normalised; powers same-ingredient lookup
    strength            TEXT,
    dosage_form         TEXT,
    manufacturer        TEXT,
    route               TEXT,
    pack_size           TEXT,
    atc_code            TEXT,
    category            TEXT,           -- therapeutic group derived from ATC
    source_category     TEXT,           -- Greenbook's own category
    base_unit           TEXT NOT NULL DEFAULT 'unit',
    is_controlled       INTEGER NOT NULL DEFAULT 0,
    dispensing_type     TEXT NOT NULL CHECK (dispensing_type IN ('OTC','POM')) DEFAULT 'OTC',
    approval_date       TEXT,
    registration_expiry TEXT,
    search_blob         TEXT            -- lowercase haystack for autocomplete
);

CREATE INDEX idx_nafdac_catalog_search     ON nafdac_catalog(search_blob);
CREATE INDEX idx_nafdac_catalog_ingredient ON nafdac_catalog(ingredient_key);
CREATE INDEX idx_nafdac_catalog_name       ON nafdac_catalog(product_name);
CREATE INDEX idx_nafdac_catalog_nafdac     ON nafdac_catalog(nafdac_reg_no);
CREATE INDEX idx_nafdac_catalog_category   ON nafdac_catalog(category);

-- Links a client's own product back to the catalog entry it came from.
-- Nullable ON PURPOSE: a manually-added product (anything not in the catalog)
-- simply leaves this NULL, which is a fully supported first-class case.
ALTER TABLE products ADD COLUMN nafdac_catalog_id INTEGER REFERENCES nafdac_catalog(id);
CREATE INDEX idx_products_catalog ON products(nafdac_catalog_id);
`;

const out = [header];

// Chunked multi-row INSERTs, emitted as literals rather than bound parameters
// (D1 caps bound parameters per statement). `wrangler d1 migrations apply`
// streams the file statement by statement.
const CHUNK = 100;
for (let i = 0; i < rows.length; i += CHUNK) {
  const slice = rows.slice(i, i + CHUNK);
  const values = slice.map((r) => `(${COLS.map((c) => q(r[c])).join(',')})`).join(',\n  ');
  out.push(`INSERT INTO nafdac_catalog (${COLS.join(', ')}) VALUES\n  ${values};`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n') + '\n');
console.log(`[catalog] wrote ${OUT} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(2)} MB)`);
