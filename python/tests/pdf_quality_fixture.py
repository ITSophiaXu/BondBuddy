"""Synthetic financial-like typography; contains no customer text or images."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from functools import lru_cache

@lru_cache(maxsize=2)
def number_scan(degraded=False):
    image = Image.new('RGB', (1200, 1600), 'white')
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=16)
    for y in range(32, 1560, 32):
        for x in range(24, 1100, 160):
            draw.text((x, y), '123,456.78', font=font, fill='black')
    return image.filter(ImageFilter.GaussianBlur(1.5)) if degraded else image

if __name__ == '__main__':
    import sys
    sys.stdout.buffer.write(number_scan('--degraded' in sys.argv).convert('L').tobytes())
