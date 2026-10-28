"""Read vector table cells. Spans come from PDF grid geometry, never forward-fill."""
import json
import sys
import pdfplumber


def read_tables(filename):
    pages, warnings = [], []
    with pdfplumber.open(filename) as document:
        if len(document.pages) > 100:
            raise ValueError("PDF exceeds 100 physical pages")
        for number, page in enumerate(document.pages, 1):
            tables = []
            for index, table in enumerate(page.find_tables(), 1):
                if len(table.cells) > 3000:
                    raise ValueError("A table exceeds 3000 physical cells")
                cells = []
                for cell_index, bbox in enumerate(table.cells, 1):
                    cells.append({"id": f"C{cell_index}", "bbox": [round(x, 3) for x in bbox],
                                  "text": page.crop(bbox).extract_text(x_tolerance=1, y_tolerance=3) or ""})
                xs = sorted({round(c[0], 3) for c in table.cells} | {round(c[2], 3) for c in table.cells})
                ys = sorted({round(c[1], 3) for c in table.cells} | {round(c[3], 3) for c in table.cells})
                if (len(xs) - 1) * (len(ys) - 1) > 12000:
                    raise ValueError("A table grid exceeds 12000 intersections")
                rows = []
                for top, bottom in zip(ys, ys[1:]):
                    cy, refs, values = (top + bottom) / 2, [], []
                    for left, right in zip(xs, xs[1:]):
                        cx = (left + right) / 2
                        covering = [c for c in cells if c["bbox"][0] <= cx < c["bbox"][2] and c["bbox"][1] <= cy < c["bbox"][3]]
                        if len(covering) != 1:
                            refs.append(None); values.append(None)
                            warnings.append(f"page {number} table {index}: ambiguous grid position")
                        else:
                            refs.append(covering[0]["id"]); values.append(covering[0]["text"])
                    rows.append({"y": [top, bottom], "cellRefs": refs, "values": values,
                                 "singleSpanningCell": len(set(refs)) == 1})
                tables.append({"index": index, "bbox": table.bbox, "xBoundaries": xs, "cells": cells, "expandedRows": rows})
            pages.append({"page": number, "tables": tables})
    return {"engine": "pdfplumber", "version": pdfplumber.__version__, "pages": pages,
            "warnings": sorted(set(warnings)),
            "note": "Cells and repeated span values follow vector grid rectangles, not neighboring values. Empty cells stay empty. PDF text may contain clipped/invisible characters; verify with rendered pages. Image-only tables need visual reading."}


if __name__ == "__main__":
    print(json.dumps(read_tables(sys.argv[1]), ensure_ascii=False, separators=(",", ":")))
