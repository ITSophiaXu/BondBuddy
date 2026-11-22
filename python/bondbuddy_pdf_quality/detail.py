"""Bounded pixel-detail evidence, not OCR or a guarantee of document accuracy.

Only candidate low-DPI pages are composited. This includes high-resolution text
masks above low-resolution MRC backgrounds instead of judging the background.
Three fixed interior crops limit work; two independent crops must contain enough
both extremely small and blurred glyph-like components to justify a blocking result. Sparse covers,
stamps and uncertain image content retain a DPI advisory, not a readability claim.
"""
import math
import time
import numpy as np

MAX_PAGE_PIXELS = 4_000_000
MAX_RUNS = 20_000
MIN_COMPONENTS = 20
# Deliberately conservative heuristics, not an OCR accuracy certificate.
# Sub-six-pixel components AND very weak gradients must agree in two crops.
MIN_GLYPH_PIXELS = 6
MIN_EDGE_STEP = 35
CROPS = ((0.5, 0.2), (0.7, 0.5), (0.5, 0.8))


def neutral_gray(image):
    rgb = np.asarray(image.convert('RGB'))
    gray = rgb.min(axis=2)
    chromatic = rgb.max(axis=2).astype(np.int16)-gray.astype(np.int16)
    gray = gray.copy()
    gray[chromatic > 45] = 255  # Colored stamps cannot supply the text evidence.
    if np.median(gray) < 100:
        gray = 255-gray
    return gray


def edge_strength(gray):
    # Both orientations keep quarter-turned tables equivalent.
    edges = np.concatenate((np.abs(np.diff(gray.astype(np.int16), axis=1)).ravel(),
                            np.abs(np.diff(gray.astype(np.int16), axis=0)).ravel()))
    edges = edges[edges > 15]
    return float(np.percentile(edges, 75)) if len(edges) else 0


def crop_detail(image, deadline):
    if time.monotonic() > deadline:
        raise TimeoutError('Detail budget')
    gray = neutral_gray(image)
    edge_step = edge_strength(gray)
    if time.monotonic() > deadline:
        raise TimeoutError('Detail budget')
    # The rejection requires BOTH weak edges and tiny components. Most readable
    # scans fail the first condition, so do not scan their connected components.
    if edge_step >= MIN_EDGE_STEP:
        return {'components': 0, 'glyph_pixels': 0, 'edge_step': edge_step}
    ink = gray < 160
    parents, bounds, previous = [], [], []

    def find(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for y, row in enumerate(ink):
        if y % 32 == 0 and time.monotonic() > deadline:
            raise TimeoutError('Detail budget')
        edges = np.diff(np.r_[False, row, False].astype(np.int8))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        current, j = [], 0
        for left, right in zip(starts.tolist(), ends.tolist()):
            if right-left > max(40, image.width*0.12):
                continue  # Table rules must not become giant character components.
            i = len(parents)
            if i >= MAX_RUNS:
                raise ValueError('Detail component budget')
            parents.append(i)
            bounds.append([left, y, right, y+1, right-left])
            current.append((left, right, i))
            while j < len(previous) and previous[j][1] < left:
                j += 1
            k = j
            while k < len(previous) and previous[k][0] <= right:
                a, b = find(i), find(previous[k][2])
                if a != b:
                    parents[b] = a
                k += 1
        previous = current
    merged = {}
    for i, box in enumerate(bounds):
        root = find(i)
        if root not in merged:
            merged[root] = box.copy()
        else:
            m = merged[root]
            m[0], m[1] = min(m[0], box[0]), min(m[1], box[1])
            m[2], m[3] = max(m[2], box[2]), max(m[3], box[3])
            m[4] += box[4]
    dimensions = []
    for left, top, right, bottom, pixels in merged.values():
        width, height = right-left, bottom-top
        short, long = min(width, height), max(width, height)
        if 2 <= short and 4 <= long <= 70 and long <= 4*short and 0.06 <= pixels/(width*height) <= 0.9:
            dimensions.append(long)  # Quarter-turned financial tables use the same rule.
    return {
        'components': len(dimensions),
        'glyph_pixels': float(np.median(dimensions)) if dimensions else 0,
        'edge_step': edge_step,
    }


def insufficient_detail(page, dpi, deadline):
    if time.monotonic() > deadline:
        raise TimeoutError('Detail budget')
    width, height = page.get_size()
    # Never enlarge a flat scan and then count interpolated pixels as source detail.
    scale = dpi/72
    if math.ceil(width*scale)*math.ceil(height*scale) > MAX_PAGE_PIXELS:
        raise ValueError('Detail pixel budget')
    bitmap = page.render(scale=scale)
    try:
        image = bitmap.to_pil()
        cw, ch = min(480, image.width), min(240, image.height)
        seen, poor = [], []
        for x, y in CROPS:
            left, top = int((image.width-cw)*x), int((image.height-ch)*y)
            box = (left, top, left+cw, top+ch)
            # Overlapping crops are one observation, not independent evidence.
            if any(max(0,min(box[2],b[2])-max(box[0],b[0])) * max(0,min(box[3],b[3])-max(box[1],b[1])) > cw*ch*0.2 for b in seen):
                continue
            seen.append(box)
            detail = crop_detail(image.crop(box), deadline)
            if detail['components'] >= MIN_COMPONENTS and (detail['glyph_pixels'] < MIN_GLYPH_PIXELS and detail['edge_step'] < MIN_EDGE_STEP):
                poor.append(box)
        if time.monotonic() > deadline:
            raise TimeoutError('Detail budget')
        if len(poor) < 2:
            return False
        # A low-DPI background must not erase a sharp high-resolution text mask.
        # Re-render only the suspect crops at 300 DPI. Sharp composed detail vetoes
        # the rejection; an empty/transparent high-DPI object alone cannot do so.
        for left, top, right, bottom in poor:
            crop = (left/scale, max(0,height-bottom/scale), max(0,width-right/scale), top/scale)
            if (right-left)*(bottom-top)*(300/dpi)**2 > MAX_PAGE_PIXELS:
                raise ValueError('Detail verification pixel budget')
            high = page.render(scale=300/72, crop=crop)
            try:
                sharp = edge_strength(neutral_gray(high.to_pil())) >= 70
            finally:
                high.close()
            if time.monotonic() > deadline:
                raise TimeoutError('Detail budget')
            if sharp:
                return False
        return True
    finally:
        bitmap.close()
