"""Bounded representative-page inspection of large raster content, without layout extraction/OCR; candidate pages receive a bounded detail probe.

DPI is derived from image pixels and actual placement, including Form transforms.
Small logos, signatures and stamps cannot trigger a page warning by themselves.
The parent process enforces the hard deadline; an incomplete probe is never a pass.
"""
import json
import math
import sys
import time
import pypdfium2 as pdfium
import pypdfium2.raw as raw
from .detail import insufficient_detail

VERSION = "pdf-raster-quality-4"
DPI_THRESHOLD = 200
# PDFium returns float32 placement matrices; this tolerance covers their quantization.
DPI_EPSILON = 0.0001
MIN_COVERAGE = 0.5
SAMPLE_LIMIT = 8
IDENTITY = (1, 0, 0, 1, 0, 0)


def compose(m, c):
    return (m[0]*c[0]+m[1]*c[2], m[0]*c[1]+m[1]*c[3],
            m[2]*c[0]+m[3]*c[2], m[2]*c[1]+m[3]*c[3],
            m[4]*c[0]+m[5]*c[2]+c[4], m[4]*c[1]+m[5]*c[3]+c[5])


def union_area(rectangles):
    xs = sorted({x for a, _, b, _ in rectangles for x in (a, b)})
    area = 0.0
    for left, right in zip(xs, xs[1:]):
        spans = sorted((y0, y1) for x0, y0, x1, y1 in rectangles if x0 < right and x1 > left)
        top = -math.inf
        height = 0.0
        for y0, y1 in spans:
            if y1 > top:
                height += y1 - max(top, y0)
                top = y1
        area += (right-left)*height
    return area


def page_resolution(page, deadline):
    width, height = page.get_size()
    if width <= 0 or height <= 0:
        raise ValueError("Invalid page dimensions")
    low = []
    visited = 0

    def walk(form=None, parent=IDENTITY, depth=0):
        nonlocal visited
        if depth > 12:
            raise ValueError("Form nesting limit")
        for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE, raw.FPDF_PAGEOBJ_FORM], max_depth=1, form=form):
            visited += 1
            if time.monotonic() > deadline or visited > 10000:
                raise TimeoutError("Probe budget")
            m = obj.get_matrix()
            matrix = compose((m.a, m.b, m.c, m.d, m.e, m.f), parent)
            if obj.type == raw.FPDF_PAGEOBJ_FORM:
                walk(obj, matrix, depth+1)
                continue
            a, b, c, d, e, f = matrix
            # Only axis-aligned / quarter-turned raster pages have an unambiguous
            # rectangular coverage here. Other transforms remain unassessed.
            if not ((abs(b) < 1e-5 and abs(c) < 1e-5) or (abs(a) < 1e-5 and abs(d) < 1e-5)):
                continue
            pixels_x, pixels_y = obj.get_px_size()
            xlen, ylen = math.hypot(a, b), math.hypot(c, d)
            if not xlen or not ylen:
                continue
            dpi = min(pixels_x*72/xlen, pixels_y*72/ylen)
            if not math.isfinite(dpi) or dpi >= DPI_THRESHOLD-DPI_EPSILON:
                continue
            corners = [(e, f), (a+e, b+f), (c+e, d+f), (a+c+e, b+d+f)]
            rect = (max(0, min(p[0] for p in corners)), max(0, min(p[1] for p in corners)),
                    min(width, max(p[0] for p in corners)), min(height, max(p[1] for p in corners)))
            if rect[2] > rect[0] and rect[3] > rect[1]:
                low.append((rect, dpi))
                if len(low) > 1024:
                    raise ValueError("Image budget")
    walk()
    # Union prevents duplicated/overlapping logos from manufacturing page coverage.
    if union_area([r for r, _ in low]) < width*height*MIN_COVERAGE:
        return None
    # Report the best resolution of the large low-resolution content conservatively.
    return max(1, min(199, int(round(max(dpi for _, dpi in low)))))


def sample_pages(count):
    # Mirrors the public pdfQualitySamplePages policy; cross-language tests verify it.
    if count <= SAMPLE_LIMIT:
        return list(range(1, count+1))
    return list(dict.fromkeys([5, 8, min(12, count), 1,
                              (count+3)//4, (count+1)//2, (count*3+3)//4, count]))


def inspect(path, emit, seconds=3):
    deadline = time.monotonic()+seconds
    with pdfium.PdfDocument(path) as document:
        count = len(document)
        if count < 1:
            raise ValueError("Empty PDF")
        emit({"page_count": count})
        for number in sample_pages(count):
            if time.monotonic() > deadline:
                return
            page = document[number-1]
            try:
                dpi = page_resolution(page, deadline)
                blocking = False
                if dpi is not None:
                    blocking = insufficient_detail(page, dpi, deadline)
            finally:
                page.close()
            emit({"page": number, "dpi": dpi, "blocking": blocking})
            if blocking:
                # DPI alone is only advisory; pixel-detail evidence justifies stopping.
                emit({"complete": True})
                return
        emit({"complete": True})


def main():
    def emit(value):
        print(json.dumps(value, separators=(",", ":")), flush=True)
    try:
        inspect(sys.argv[1], emit)
    except Exception:
        # Do not expose private paths, encrypted document details or customer text.
        emit({"unavailable": True})


if __name__ == "__main__":
    main()
