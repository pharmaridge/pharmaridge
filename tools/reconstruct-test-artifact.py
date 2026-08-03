#!/usr/bin/env python3
"""Rebuild recovered worker/test sources from the concatenated test artifact.

Usage:
  python3 tools/reconstruct-test-artifact.py /path/to/test.txt /new/project/root

Only artifact-derived files are emitted. The current repository's test README,
core-live runner, package scripts, and test adjustments are deliberate
integration additions and are not overwritten by this extractor.
"""
from pathlib import Path
import argparse
import shutil

parser = argparse.ArgumentParser()
parser.add_argument('artifact', type=Path)
parser.add_argument('project_root', type=Path)
args = parser.parse_args()
source = args.artifact.expanduser().resolve()
root = args.project_root.expanduser().resolve()
if not source.is_file():
    raise SystemExit(f'Artifact not found: {source}')
if not root.is_dir():
    raise SystemExit(f'Project root not found: {root}')
lines = source.read_text(encoding='utf-8').splitlines()

# One-based, inclusive ranges. Boundaries are explicit IIFE/module ends,
# top-level declarations, and Markdown headings; never guessed by line count.
files = {
    'worker/test/tools/build-icons.js': (1, 468),
    'worker/test/tools/build-manual.js': (469, 2046),
    'worker/test/lib-fefo.js': (2047, 2102),
    'worker/test/audit.wht.js': (2103, 2441),
    'worker/test/tools/probe-admin-adversarial.js': (2442, 2662),
    'worker/test/tools/probe-admin-ui.js': (2663, 2918),
    'worker/test/audit.vendorseat.js': (2919, 3244),
    'worker/test/audit.attendance.js': (3245, 3424),
    'worker/test/tools/probe-is-active.js': (3425, 3577),
    'worker/test/audit.branchlifecycle.js': (3578, 3756),
    'worker/test/tools/probe-branding.js': (3757, 3907),
    'worker/test/audit.money.js': (3908, 4138),
    'worker/test/tools/probe-cashfloor.js': (4139, 4238),
    'worker/test/tools/probe-change-owed.js': (4239, 4503),
    'worker/test/tools/probe-cors.js': (4504, 4623),
    'worker/test/audit.customers.js': (4624, 4798),
    'worker/test/tools/probe-cron.js': (4799, 4970),
    'worker/test/tools/probe-crossdomain.js': (4971, 5252),
    'worker/test/tools/probe-flowchain.js': (5253, 5457),
    'worker/test/tools/probe-formbaseline.js': (5458, 5593),
    'worker/test/tools/probe-icon.js': (5594, 5854),
    'worker/test/audit.inventory.js': (5855, 6165),
    'worker/test/audit.rolelifecycle.js': (6166, 6471),
    'worker/test/tools/probe-bounds.js': (6472, 6641),
    'worker/test/audit.manager.js': (6642, 7047),
    'worker/test/tools/probe-manual.js': (7048, 7341),
    'worker/test/tools/probe-offline-durability.js': (7342, 7571),
    'worker/test/tools/probe-overlap.js': (7572, 7873),
    'worker/test/audit.owner.js': (7874, 8227),
    'worker/test/audit.workflows.js': (8228, 8491),
    'worker/test/tools/probe-quantity.js': (8492, 8714),
    'worker/test/tools/probe-reachability.js': (8715, 8911),
    'worker/test/tools/probe-receipt.js': (8912, 9064),
    'worker/test/tools/probe-receiving.js': (9065, 9290),
    'worker/test/audit.responsive.js': (9291, 9545),
    'worker/test/tools/probe-payment-retry.js': (9546, 9757),
    'worker/test/tools/probe-reversals.js': (9758, 9947),
    'worker/test/tools/probe-role-triggers.js': (9948, 10157),
    'worker/test/tools/probe-safe.js': (10158, 10378),
    'worker/test/tools/probe-safe-till.js': (10379, 10595),
    'worker/test/tools/probe-soak.js': (10596, 10803),
    'worker/test/tools/probe-split-cash.js': (10804, 11085),
    'worker/test/audit.staff.js': (11086, 11505),
    'worker/test/tools/probe-stale-replay.js': (11506, 11641),
    'worker/test/audit.sync.js': (11642, 11834),
    'worker/test/tools/probe-sync-gaps.js': (11835, 12257),
    'worker/test/audit.pwa.js': (12258, 12903),
    'worker/test/tools/probe-topbar.js': (12904, 13077),
    'worker/test/tools/probe-transfer-ui.js': (13078, 13344),
    'worker/test/audit.transfer.js': (13345, 13726),
    'worker/test/tools/probe-transient.js': (13727, 13871),
    'worker/test/tools/probe-unit-alignment.js': (13872, 14047),
    'worker/test/tools/probe-ux-sweep.js': (14048, 14244),
    'worker/test/tools/probe-wht-sale.js': (14245, 14356),
    'worker/test/TESTING-PLAYBOOK.md': (14357, 15262),
    'worker/test/tools/seed-scenarios.js': (15263, 15685),
    'worker/test/tools/shots-artefacts.js': (15686, 16001),
    'worker/test/tools/shots-matrix.js': (16002, 16293),
    'worker/test/tools/shots-manual.js': (16294, 16596),
    'worker/test/tools/shots-theme.js': (16597, 16662),
}
for relative, (start, end) in files.items():
    if not 1 <= start <= end <= len(lines):
        raise RuntimeError(f'Invalid range for {relative}: {start}-{end}')
    destination = root / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text('\n'.join(lines[start - 1:end]) + '\n', encoding='utf-8')

provenance = root / 'provenance'
provenance.mkdir(exist_ok=True)
shutil.copyfile(source, provenance / 'TEST-ARTIFACT.txt')
print(f'Extracted {len(files)} artifact-derived test files.')
