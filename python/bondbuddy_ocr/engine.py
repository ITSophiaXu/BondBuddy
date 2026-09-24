from __future__ import annotations

import base64
import csv
import hashlib
import io
import os
from pathlib import Path
import re
import subprocess
import tempfile
from decimal import Decimal

import numpy as np
from PIL import Image, ImageOps
import pypdfium2 as pdfium
from pypdf import PdfReader

VERSION = 'bondbuddy-ocr-1.0.0'
MAX_PIXELS = 20_000_000
MAX_OUTPUT = 48 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


class Failure(Exception):
    pass


def numeric_value(raw):
    """Preserve blank/dash/zero, sign and explicit unit; never infer a column's unit."""
    text = raw.strip().replace('（', '(').replace('）', ')').replace('−', '-')
    if not text:
        return {'kind': 'blank', 'decimal': None, 'unit': None}
    if text in {'-', '—', '–', '－'}:
        return {'kind': 'dash', 'decimal': None, 'unit': None}
    match = re.fullmatch(r'(\(?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?)(亿元|万元|元|%)?', text)
    if not match or (text.startswith('(') != (')' in text)):
        return {'kind': 'unparsed', 'decimal': None, 'unit': None}
    number, unit = match.groups()
    if number.startswith('(') and number[1:2] in {'+', '-'}:
        return {'kind': 'unparsed', 'decimal': None, 'unit': unit}
    if number.startswith('('):
        number = '-' + number[1:-1]
    try:
        value = format(Decimal(number.replace(',', '')), 'f')
    except Exception:
        return {'kind': 'unparsed', 'decimal': None, 'unit': unit}
    return {'kind': 'number', 'decimal': value, 'unit': unit}


def _run(args, timeout=35):
    try:
        return subprocess.run(args, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise Failure('OCR_ENGINE_TIMEOUT')
    except OSError:
        raise Failure('OCR_ENGINE_UNAVAILABLE')


def _tsv(image, language, directory, index, psm='3'):
    path = Path(directory) / f'page-{index}.png'
    image.save(path)
    output = Path(directory) / f'page-{index}'
    result = _run(['tesseract', str(path), str(output), '-l', language, '--psm', psm, '-c', 'tessedit_create_tsv=1'])
    if result.returncode:
        raise Failure('OCR_ENGINE_FAILED')
    tsv = output.with_suffix('.tsv')
    if tsv.stat().st_size > 8 * 1024 * 1024:
        raise Failure('OCR_OUTPUT_LIMIT')
    words = []
    for row in csv.DictReader(io.StringIO(tsv.read_text()), delimiter='\t'):
        text = (row.get('text') or '').strip()
        if row.get('level') != '5' or not text:
            continue
        x, y, w, h = (int(row[key]) for key in ['left', 'top', 'width', 'height'])
        confidence = float(row['conf'])
        if w < 1 or h < 1 or x < 0 or y < 0 or x+w > image.width or y+h > image.height or not 0 <= confidence <= 100:
            raise Failure('OCR_INVALID_GEOMETRY')
        words.append({'text': text, 'bbox': [x, y, x+w, y+h], 'confidence': round(confidence/100, 6),
                      'line': (row['block_num'], row['par_num'], row['line_num'])})
    if len(words) > 10000:
        raise Failure('OCR_OUTPUT_LIMIT')
    return words


def _orientation(image, directory):
    path = Path(directory) / 'orientation.png'
    image.save(path)
    result = _run(['tesseract', str(path), 'stdout', '--psm', '0', '-l', 'osd'], 15)
    text = result.stdout.decode('utf-8', errors='replace')
    angle = re.search(r'Rotate: (0|90|180|270)\b', text)
    confidence = re.search(r'Orientation confidence: ([0-9.]+)', text)
    if result.returncode or not angle or not confidence or float(confidence[1]) < 8:
        return image, 0, ['orientation_unverified']
    rotation = int(angle[1])
    return image.rotate(-rotation, expand=True), rotation, []


def _tables(image):
    """Recover rectangular cells from intersecting long ruled lines, including merged cells."""
    ink = np.asarray(image.convert('L')) < 140
    def segments(mask, minimum):
        changes = np.diff(np.pad(mask.astype(np.int8), ((0,0),(1,1))), axis=1)
        rows, starts = np.where(changes == 1)
        _, ends = np.where(changes == -1)
        keep = ends-starts >= minimum
        lines = []
        for row, left, right in zip(rows[keep].tolist(), starts[keep].tolist(), ends[keep].tolist()):
            # Collapse the adjacent scan lines making up a thick ruled edge.
            for i in range(len(lines)-1, max(-1,len(lines)-20), -1):
                pos, begin, finish = lines[i]
                if row-pos <= 8 and abs(left-begin) <= 8 and abs(right-finish) <= 8:
                    lines[i] = [(pos+row)/2, min(left,begin), max(right,finish)]
                    break
            else: lines.append([row,left,right])
        return lines
    horizontal = segments(ink, max(40,image.width//30))
    vertical = segments(ink.T, max(40,image.height//30))
    if len(horizontal)+len(vertical)>1500: raise Failure('OCR_TABLE_LIMIT')
    edges=horizontal+vertical
    parent=list(range(len(edges)))
    def root(i):
        while parent[i]!=i:
            parent[i]=parent[parent[i]];i=parent[i]
        return i
    for i,(y,left,right) in enumerate(horizontal):
        for j,(x,top,bottom) in enumerate(vertical):
            if left-8<=x<=right+8 and top-8<=y<=bottom+8:
                parent[root(i)]=root(len(horizontal)+j)
    groups={}
    for i in range(len(edges)):groups.setdefault(root(i),[]).append(i)
    def clustered(values):
        result=[]
        for value in sorted(values):
            if not result or value-result[-1]>8:result.append(value)
        return result
    result=[]
    for members in groups.values():
        hs=[edges[i] for i in members if i<len(horizontal)]
        vs=[edges[i] for i in members if i>=len(horizontal)]
        xs=clustered([v[0] for v in vs]);ys=clustered([h[0] for h in hs])
        if len(xs)<2 or len(ys)<2:continue
        columns,rows=len(xs)-1,len(ys)-1
        if rows*columns>2000:raise Failure('OCR_TABLE_LIMIT')
        def boundary(lines,axis,mid):return any(abs(pos-axis)<=8 and begin-8<=mid<=end+8 for pos,begin,end in lines)
        # A table must have a closed outer frame. Partial grids remain unstructured text.
        if any(not boundary(vs,x,(ys[r]+ys[r+1])/2) for x in [xs[0],xs[-1]] for r in range(rows)):continue
        if any(not boundary(hs,y,(xs[c]+xs[c+1])/2) for y in [ys[0],ys[-1]] for c in range(columns)):continue
        cell_parent=list(range(rows*columns))
        def cell_root(i):
            while cell_parent[i]!=i:
                cell_parent[i]=cell_parent[cell_parent[i]];i=cell_parent[i]
            return i
        for r in range(rows):
            for c in range(columns):
                current=r*columns+c
                if c+1<columns and not boundary(vs,xs[c+1],(ys[r]+ys[r+1])/2):cell_parent[cell_root(current)]=cell_root(current+1)
                if r+1<rows and not boundary(hs,ys[r+1],(xs[c]+xs[c+1])/2):cell_parent[cell_root(current)]=cell_root(current+columns)
        merged={}
        for i in range(rows*columns):merged.setdefault(cell_root(i),[]).append(divmod(i,columns))
        cells=[]
        for locations in merged.values():
            top=min(r for r,c in locations);bottom=max(r for r,c in locations)+1
            left=min(c for r,c in locations);right=max(c for r,c in locations)+1
            if len(locations)!=(bottom-top)*(right-left):continue
            cells.append({'bbox':[round(xs[left]),round(ys[top]),round(xs[right]),round(ys[bottom])],
                'row':top+1,'column':left+1,'row_span':bottom-top,'column_span':right-left,'table_id':f'table-{len(result)+1}'})
        if len(cells)>1:result.append(sorted(cells,key=lambda c:(c['row'],c['column'])))
    return result


def extract_page(image, language, directory, page_number):
    image, rotation, warnings = _orientation(image, directory)
    words = _tsv(image, language, directory, page_number)
    tables = _tables(image)
    records, used = [], set()
    def record(text, bbox, confidence, cell=None, extra=None, unreadable=False):
        numeric = {'kind':'unparsed','decimal':None,'unit':None} if unreadable else numeric_value(text)
        uncertain = ['ocr_requires_review', *(extra or [])]
        if confidence is None or confidence < .90:
            uncertain.append('low_confidence')
        if any(c.isdigit() for c in text) or numeric['kind'] in {'blank', 'dash'}:
            uncertain.append('critical_value_requires_confirmation')
        if cell:
            uncertain.append('table_structure_requires_confirmation')
        records.append({'record_id': f'p{page_number}-r{len(records)+1}', 'page': page_number,
            'bbox': bbox, 'text': text, 'confidence': confidence, 'numeric': numeric,
            'cell': cell, 'uncertainty': uncertain, 'eligible_for_manuscript': False})
    for cells in tables:
        for cell in cells:
            selected = []
            x0, y0, x1, y1 = cell['bbox']
            for i, word in enumerate(words):
                x, y, right, bottom = word['bbox']
                if i not in used and x0 <= (x+right)/2 <= x1 and y0 <= (y+bottom)/2 <= y1:
                    selected.append(word); used.add(i)
            # Page segmentation often drops short headers/zeros beside grid lines.
            # Recognize each ruled cell without its border; preserve the page pixels for review.
            inset=6
            crop=image.crop((x0+inset,y0+inset,x1-inset,y1-inset))
            if crop.width<1 or crop.height<1:raise Failure('OCR_INVALID_GEOMETRY')
            ink = np.asarray(crop.convert('L')) < 140
            has_ink = bool(np.any(ink))
            ys, xs = np.where(ink)
            dash = has_ink and int(xs.max()-xs.min()+1)>max(10,4*int(ys.max()-ys.min()+1)) and float(ink.sum())/((xs.max()-xs.min()+1)*(ys.max()-ys.min()+1))>.75
            if has_ink:
                crop=ImageOps.expand(crop,border=16,fill='white')
                selected=_tsv(crop,language,directory,f'{page_number}-cell-{len(records)}','6')
            else:selected=[]
            text = ' '.join(w['text'] for w in selected)
            extra=[]
            if not text and dash:
                text='—';extra=['dash_shape_inferred']
            unreadable=has_ink and not text
            if unreadable:extra.append('unreadable_cell')
            record(text, cell['bbox'], min((w['confidence'] for w in selected), default=None), {k:v for k,v in cell.items() if k != 'bbox'}, extra, unreadable)
    lines = {}
    for i, word in enumerate(words):
        if i not in used:
            lines.setdefault(word['line'], []).append(word)
    for line in lines.values():
        bbox = [min(w['bbox'][0] for w in line), min(w['bbox'][1] for w in line), max(w['bbox'][2] for w in line), max(w['bbox'][3] for w in line)]
        record(' '.join(w['text'] for w in line), bbox, min(w['confidence'] for w in line))
    if not records:
        warnings.append('page_without_recognized_text')
    warnings.extend(['layout_requires_review', 'cross_page_tables_not_joined'])
    buffer = io.BytesIO(); image.save(buffer, format='PNG')
    png = buffer.getvalue()
    page = {'page': page_number, 'width': image.width, 'height': image.height, 'rotation_clockwise': rotation,
            'coordinate_system': 'rendered_pixels_top_left', 'image_sha256': hashlib.sha256(png).hexdigest(),
            'image_base64': base64.b64encode(png).decode(), 'warnings': warnings}
    return page, records


def process(request):
    material = request.get('material') if isinstance(request, dict) else None
    result = {'schema_version':'ocr-response-v1', 'request_id':request.get('request_id') if isinstance(request,dict) else None,
        'processor_version':VERSION, 'engine_version':'unknown', 'language':'unknown', 'language_data_sha256':{}, 'purpose':None,
        'status':'failed', 'material':{k:material.get(k) for k in ['material_id','material_version','media_type','sha256']} if isinstance(material,dict) else None,
        'page_count':0, 'coverage':'none', 'pages':[], 'records':[], 'warnings':[], 'error':None, 'eligible_for_manuscript':False}
    document = None
    try:
        if request.get('schema_version') != 'ocr-request-v1' or not isinstance(material,dict):
            raise Failure('INVALID_OCR_REQUEST')
        options = request.get('options', {})
        purpose = options.get('purpose'); language = options.get('language', 'chi_sim+eng')
        if purpose not in {'source_preflight','full_ocr'} or language not in {'chi_sim+eng','eng'}:
            raise Failure('INVALID_OCR_REQUEST')
        result.update(purpose=purpose, language=language)
        if purpose == 'full_ocr' and options.get('execution_authorized') is not True:
            raise Failure('OCR_EXECUTION_REQUIRED')
        limit = options.get('max_pages', 3 if purpose == 'source_preflight' else 50)
        if type(limit) is not int or not 1 <= limit <= (5 if purpose == 'source_preflight' else 50):
            raise Failure('INVALID_OCR_BUDGET')
        path = Path(material['authorized_local_path'])
        if not path.is_absolute() or path.stat().st_size > 100*1024*1024:
            raise Failure('OCR_INPUT_LIMIT')
        if hashlib.sha256(path.read_bytes()).hexdigest() != material['sha256']:
            raise Failure('OCR_SOURCE_HASH_MISMATCH')
        version = _run(['tesseract', '--version'], 5)
        if version.returncode: raise Failure('OCR_ENGINE_UNAVAILABLE')
        result['engine_version'] = version.stdout.decode().splitlines()[0][:100]
        listing = _run(['tesseract','--list-langs'],5).stdout.decode()
        available = listing.splitlines()
        if any(lang not in available for lang in language.split('+')):
            raise Failure('OCR_LANGUAGE_UNAVAILABLE')
        data_path = re.search(r'in "([^"]+)"', listing)
        if not data_path: raise Failure('OCR_LANGUAGE_VERSION_UNAVAILABLE')
        result['language_data_sha256'] = {lang: hashlib.sha256((Path(data_path[1]) / (lang+'.traineddata')).read_bytes()).hexdigest() for lang in [*language.split('+'), *(['osd'] if 'osd' in available else [])]}
        media = material['media_type']
        images = []
        if media == 'application/pdf':
            reader = PdfReader(path)
            if reader.is_encrypted: raise Failure('MATERIAL_ENCRYPTED')
            count = len(reader.pages)
            if count > 1500: raise Failure('OCR_INPUT_LIMIT')
            document = pdfium.PdfDocument(path)
        elif media in {'image/png','image/jpeg'}:
            with Image.open(path) as original:
                if original.format != ('PNG' if media=='image/png' else 'JPEG'): raise Failure('MATERIAL_CONTENT_MISMATCH')
                if getattr(original,'n_frames',1) != 1: raise Failure('OCR_MULTIFRAME_UNSUPPORTED')
                if original.width*original.height > MAX_PIXELS: raise Failure('OCR_PIXEL_LIMIT')
                image = ImageOps.exif_transpose(original).convert('RGB'); images.append(image)
            count=1
        else: raise Failure('MATERIAL_FORMAT_UNSUPPORTED')
        result['page_count'] = count
        if not count: raise Failure('MATERIAL_UNREADABLE')
        if purpose=='full_ocr' and count>limit: raise Failure('OCR_FULL_DOCUMENT_BUDGET_EXCEEDED')
        with tempfile.TemporaryDirectory(prefix='bb-ocr-') as directory:
            for i in range(min(count,limit)):
                if document is not None:
                    page=document[i]; w,h=page.get_size()
                    if w <= 0 or h <= 0 or w*h*(250/72)**2 > MAX_PIXELS: raise Failure('OCR_PIXEL_LIMIT')
                    bitmap=page.render(scale=250/72); image=bitmap.to_pil().convert('RGB'); bitmap.close(); page.close()
                else: image=images[i]
                page_result, records=extract_page(image,language,directory,i+1)
                result['pages'].append(page_result);result['records'].extend(records)
                if sum(len(p['image_base64']) for p in result['pages']) > MAX_OUTPUT: raise Failure('OCR_OUTPUT_LIMIT')
        result['coverage']='complete' if count<=limit else 'partial'
        result['warnings']=['ocr_not_audited','table_headers_period_units_require_review']
        if result['coverage']=='partial':result['warnings'].append('preflight_budget_exhausted')
        result['status']='needs_confirmation'
    except Failure as error:
        result.update(status='failed', error=str(error), pages=[], records=[], coverage='none')
    except Exception:
        result.update(status='failed', error='MATERIAL_UNREADABLE', pages=[], records=[], coverage='none')
    finally:
        if document is not None:document.close()
    return result
