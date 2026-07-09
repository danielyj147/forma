#!/usr/bin/env bash
# Downloads the demo corpus (public regulatory PDFs) listed in data/manifest.json.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data/pdfs

fetch() { # url dest
  if [ -f "$2" ]; then echo "✓ $2 (cached)"; else
    echo "↓ $2"; curl -sfL -o "$2" "$1"
  fi
}

fetch "https://flofr.gov/docs/default-source/documents/forms/ofr-560-01---application-to-register-as-a-money-services-business.pdf?sfvrsn=516d69be_1" data/pdfs/fl-msb-registration.pdf
fetch "https://abnk.assembly.ca.gov/sites/abnk.assembly.ca.gov/files/50%20State%20Survey%20-%20MTL%20Licensing%20Requirements(72986803_4).pdf" data/pdfs/mtl-50-state-survey.pdf
fetch "https://www.commerce.alaska.gov/web/Portals/3/pub/Money%20Transmitter%20Application%20Checklist%20Rev%20-%2020250505.pdf" data/pdfs/ak-mt-checklist.pdf
fetch "https://dfi.wa.gov/documents/money-transmitters/summary-mt-regulation.pdf" data/pdfs/wa-mt-summary.pdf
fetch "https://www.taxformfinder.org/forms/2025/2025-federal-form-1023.pdf" data/pdfs/irs-f1023.pdf
fetch "https://irstore.blob.core.windows.net/materials/c76e42b9-9319-45a0-923a-b10dc054357a.pdf" data/pdfs/ny-bitlicense-checklist.pdf
fetch "https://www.cms.gov/medicare/cms-forms/cms-forms/downloads/cms855a.pdf" data/pdfs/cms-855a.pdf

echo "done — ingest with e.g.:"
echo "  python scripts/ingest.py --file data/pdfs/fl-msb-registration.pdf --title 'Florida OFR-560-01 — Application to Register as a Money Services Business' --doc-id fl-msb-registration --state FL --license-type money-services-business --filing-date 2023-02-01"
