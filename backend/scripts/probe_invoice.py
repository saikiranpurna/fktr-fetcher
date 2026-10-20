"""Dev-only: download ONE order's invoices through the app's own flipkart.fetch_invoice and report
what came back, to check the invoice endpoint still works (or debug an account) without the UI.

The order-detail page advertises the download as an action (verified 2026-10-20):
nonWidgetizeRedirection {type INVOICE_DOWNLOAD, method GET, url "1/self-serve/invoice/download",
replacableParameter [orderId]} -> GET https://www.flipkart.com/api/1/self-serve/invoice/download/<orderId>,
a ZIP of the order's invoice PDFs; orderData.actionEligibilityResponses.DOWNLOAD_INVOICE says
whether the order has one (not until a unit is dispatched, when Flipkart answers HTTP 500 JSON).

Usage (from backend/):
    python -m scripts.probe_invoice --cookie ../docs/cookies/<export>.txt [--order OD...]

Without --order it picks the first delivered order from backend/.samples/<cookie stem>/orders.json
(run capture_samples first). Prints only sizes, file counts and magic bytes; with --save the file is
written to the gitignored backend/.samples/ (it's a real invoice: customer data).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from app import flipkart, parser, service, store
from app.errors import AppError

SAMPLES = Path(__file__).resolve().parent.parent / ".samples"


def _delivered_order(orders: list) -> str:
    for order in orders:
        units = parser.get(order, "units")
        for unit in (units.values() if isinstance(units, dict) else []):
            heading = str(parser.get(unit, "metaData.moRedesignHeading") or "")
            if not parser.is_addon(unit) and parser.map_status(heading) == "DELIVERED":
                return str(parser.get(order, "orderMetaData.orderId"))
    raise SystemExit("no delivered order in the capture")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cookie", required=True)
    ap.add_argument("--order", help="order id (default: first delivered order in the capture)")
    ap.add_argument("--save", action="store_true", help="write the file to backend/.samples/<stem>/")
    args = ap.parse_args()

    out = SAMPLES / Path(args.cookie).stem
    cookies = store.to_cookie_dict(store.normalize_cookie_input(Path(args.cookie).read_text(encoding="utf-8")))
    order_id = args.order or _delivered_order(json.loads((out / "orders.json").read_text(encoding="utf-8")))
    try:
        raw = flipkart.fetch_invoice(cookies, order_id)
        files = service._invoice_files(raw)
    except AppError as err:
        print(f"{err.code} ({err.status}): {err.message}")
        return 1
    pdfs = sum(1 for _, data in files if data[:5] == b"%PDF-")
    print(f"OK: {len(raw)} bytes, magic {raw[:4]!r}, {len(files)} file(s), {pdfs} PDF(s)")
    if args.save:
        out.mkdir(parents=True, exist_ok=True)
        dest = out / ("invoice-probe.zip" if raw[:2] == b"PK" else "invoice-probe.pdf")
        dest.write_bytes(raw)
        print(f"saved {dest.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
