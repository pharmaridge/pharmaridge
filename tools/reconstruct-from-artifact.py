from pathlib import Path
import argparse
import shutil

parser = argparse.ArgumentParser(description='Rebuild the PharmaRidge source tree from the preserved concatenated artifact.')
parser.add_argument('artifact', type=Path, help='Path to the original 7.txt-style concatenated artifact')
parser.add_argument('output', type=Path, help='New output directory; it must not already exist')
args = parser.parse_args()
SRC = args.artifact.expanduser().resolve()
OUT = args.output.expanduser().resolve()
if not SRC.is_file():
    raise SystemExit(f'Artifact not found: {SRC}')
lines = SRC.read_text(encoding='utf-8').splitlines()
if OUT.exists():
    raise SystemExit(f'Refusing to overwrite existing {OUT}')

# Ranges are 1-based inclusive and were identified from explicit SQL headers,
# CommonJS exports, Hono route declarations, IIFE endings, and document markers.
files = {
    'worker/migrations/0001_initial_schema.sql': (1, 2168),
    'worker/migrations/0002_nafdac_catalog.sql': (2169, 9102),
    '.gitignore': (37253, 37426),
    'worker/wrangler.jsonc': (9276, 9328),
    'worker/package.json': (9329, 9362),
    'worker/package-lock.json': (9363, 12171),
    'worker/generate-seed.js': (12172, 12288),
    # The artifact contains early, unheaded copies of these tools. The later
    # copies include their complete headers and are the selected source.
    'worker/tools/build-nafdac-catalog.js': (25934, 26301),
    'worker/tools/route-reachability.js': (26302, 26412),
    'worker/src/lib/auth.js': (12768, 13118),
    'worker/src/lib/branding.js': (13119, 13194),
    'worker/src/lib/business.js': (13195, 13432),
    'worker/src/lib/cashSources.js': (13433, 13585),
    'worker/src/lib/crypto.js': (13586, 13736),
    'worker/src/lib/d1Limits.js': (13737, 13843),
    'worker/src/lib/d1Retry.js': (13844, 13946),
    'worker/src/lib/db.js': (13947, 13984),
    'worker/src/lib/http.js': (13985, 14122),
    'worker/src/lib/idempotency.js': (14123, 14226),
    'worker/src/lib/loginThrottle.js': (14227, 14419),
    'worker/src/lib/planLimits.js': (14420, 14738),
    'worker/src/lib/receiving.js': (14739, 14917),
    'worker/src/lib/retention.js': (14918, 14983),
    'worker/src/lib/stockEntry.js': (14984, 15100),
    'worker/src/lib/storageHealth.js': (15101, 15340),
    'worker/src/lib/wht.js': (15341, 15504),
    'worker/src/routes/adjustments.js': (15505, 15660),
    'worker/src/routes/admin.js': (15661, 15790),
    'worker/src/routes/attendance.js': (15791, 16002),
    'worker/src/routes/auth.js': (16003, 16058),
    'worker/src/routes/branches.js': (16059, 16380),
    'worker/src/routes/branding.js': (16381, 16428),
    'worker/src/routes/catalog.js': (16429, 16636),
    'worker/src/routes/changeOwed.js': (16637, 16790),
    'worker/src/routes/controlledRegister.js': (16791, 16896),
    'worker/src/routes/creditors.js': (16897, 17127),
    'worker/src/routes/customers.js': (17128, 17405),
    'worker/src/routes/dashboard.js': (17406, 17626),
    'worker/src/routes/expenses.js': (17627, 17888),
    'worker/src/routes/gl.js': (17889, 17980),
    'worker/src/routes/products.js': (17981, 18138),
    'worker/src/routes/purchaseOrders.js': (18139, 18830),
    'worker/src/routes/safe.js': (18831, 19003),
    'worker/src/routes/sales.js': (19004, 19236),
    'worker/src/routes/settings.js': (19237, 19419),
    'worker/src/routes/stock.js': (19420, 19486),
    'worker/src/routes/stocktakes.js': (19487, 19680),
    'worker/src/routes/suppliers.js': (19681, 19759),
    'worker/src/routes/sync.js': (19760, 19895),
    'worker/src/routes/till.js': (19896, 20058),
    'worker/src/routes/transfers.js': (20059, 20373),
    'worker/src/routes/users.js': (20374, 21141),
    'worker/src/routes/wht.js': (21142, 21435),
    'worker/src/services/attendanceService.js': (21436, 21763),
    'worker/src/services/branchSafeService.js': (21764, 21905),
    'worker/src/services/changeOwedService.js': (21906, 22096),
    'worker/src/services/glService.js': (22097, 22853),
    # sha256Hex is deliberately after module.exports in the artifact; it is
    # function-hoisted and used earlier in this same source file.
    'worker/src/services/salesService.js': (22854, 23989),
    'worker/src/services/stocktakeService.js': (23990, 24373),
    'worker/src/services/syncService.js': (24374, 24767),
    'worker/src/services/tillService.js': (24768, 25040),
    'worker/src/services/userTransferService.js': (25041, 25563),
    'worker/src/index.js': (25564, 25933),
    'public/css/style.css': (26413, 27516),
    'public/js/ui.js': (27517, 27691),
    'public/js/theme.js': (27692, 27883),
    'public/js/state.js': (27884, 28028),
    'public/js/router.js': (28029, 28388),
    'public/js/receipt.js': (28389, 28598),
    'public/js/offline.js': (28599, 29013),
    'public/js/export.js': (29014, 29422),
    'public/js/deviceId.js': (29423, 29456),
    'public/js/branding.js': (29457, 29614),
    'public/js/app.js': (29615, 30210),
    'public/js/api.js': (30211, 30472),
    'public/js/views/users.js': (30473, 31203),
    'public/js/views/transfers.js': (31204, 31340),
    'public/js/views/till.js': (31341, 31679),
    'public/js/views/sync.js': (31680, 31828),
    'public/js/views/suppliers.js': (31829, 32057),
    'public/js/views/stocktake.js': (32058, 32336),
    'public/js/views/stock.js': (32337, 32655),
    'public/js/views/sales.js': (32656, 32767),
    'public/js/views/purchaseOrders.js': (32768, 33276),
    'public/js/views/products.js': (33277, 33907),
    'public/js/views/pos.js': (33908, 34470),
    'public/js/views/plan.js': (34471, 34919),
    'public/js/views/login.js': (34920, 34975),
    'public/js/views/expenses.js': (34976, 35212),
    'public/js/views/dashboard.js': (35213, 35461),
    'public/js/views/customers.js': (35462, 35929),
    'public/js/views/controlledRegister.js': (35930, 36066),
    'public/js/views/attendance.js': (36067, 36431),
    'public/js/views/admin.js': (36432, 36691),
    'public/js/views/accounting.js': (36692, 37253),
    'public/_headers': (37427, 37441),
    'public/_redirects': (37442, 37450),
    'public/index.html': (37451, 37615),
    'public/manifest.json': (37616, 37660),
    'public/sw.js': (37661, 37759),
    'PROJECT-SETUP-STATUS.md': (37760, 37909),
    'README.md': (37910, 38326),
    'AUDIT-REPORT.md': (38327, 38605),
}

for rel, (start, end) in files.items():
    if start < 1 or end > len(lines) or end < start:
        raise RuntimeError(f'Bad range for {rel}: {start}-{end}')
    dest = OUT / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text('\n'.join(lines[start-1:end]) + '\n', encoding='utf-8')

# The original blob has no binary icon payload. These explicitly safe text
# configuration files are added during reconstruction, not extracted.
# This safe template is an explicit recovery addition, not extracted content.
(OUT / 'worker/.dev.vars.example').write_text(
    '# Local development only. Never use this value in production.\n'
    'JWT_SECRET=replace-with-a-long-random-local-development-secret\n', encoding='utf-8'
)

# Preserve an immutable in-project copy for chain-of-custody. Teams that do
# not want a multi-megabyte artifact in their repository may add provenance/ to
# .gitignore after independently archiving this exact source file.
provenance = OUT / 'provenance'
provenance.mkdir()
shutil.copyfile(SRC, provenance / 'SOURCE-ARTIFACT-7.txt')

print(f'Reconstructed {len(files)} text files into {OUT}')
print('Note: generated PNG icons and recovery documentation are not emitted by this extractor; add them using the recovery playbook.')
